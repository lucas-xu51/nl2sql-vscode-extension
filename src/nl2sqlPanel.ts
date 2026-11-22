import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { performance } from 'perf_hooks';
import { createHash } from 'crypto';

import { CvLink, DailSchemaDict, SQLiteTable, UserFewShotRecord } from './types';
import {
    buildCvLinkFromLocalSQLite, buildDailSchemaFromTables, convertNaturalLanguageToSQL, convertSQLToNaturalLanguage, executeSQL, findSQLiteFiles, getMySQLConfig, getMySQLDatabases, getPostgresConfig, getPostgresDatabases, quoteIdentifier, readMySQLSchema, readMySQLTableRows, readPostgresSchema, readPostgresTableRows, readSQLiteSchema, uploadSQLiteToDailSQL
} from './extension';


// Generic CV Link helper for remote databases (MySQL / PostgreSQL).
// It uses the sample values already attached to each schema column by
// readMySQLSchema() / readPostgresSchema(), so database connection logic
// remains unchanged. SQLite keeps using buildCvLinkFromLocalSQLite().
function tokenizeQuestionForCvLink(question: string): string[] {
    return (question || '')
        .toLowerCase()
        .replace(/[`"'\\/\(\)\[\]{}<>,\.;:\?\!\|]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function normalizeCvValue(value: string): string {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sampleValueContainsToken(value: string, token: string): boolean {
    const normalizedValue = normalizeCvValue(value);
    const normalizedToken = normalizeCvValue(token);
    if (!normalizedValue || !normalizedToken) return false;

    return normalizedValue === normalizedToken
        || normalizedValue.startsWith(normalizedToken + ' ')
        || normalizedValue.endsWith(' ' + normalizedToken)
        || normalizedValue.includes(' ' + normalizedToken + ' ');
}

function buildCvLinkFromSchemaValues(
    question: string,
    schema: DailSchemaDict,
    tables: SQLiteTable[],
    backendTokens?: string[]
): CvLink {
    const tokens = backendTokens && backendTokens.length > 0
        ? backendTokens
        : tokenizeQuestionForCvLink(question);

    console.log('🔧 [buildCvLinkFromSchemaValues] using tokens', {
        question,
        backendTokens,
        tokens
    });

    const num_date_match: Record<string, string> = {};
    const cell_match: Record<string, string> = {};
    const tableMap = new Map<string, SQLiteTable>();

    tables.forEach((table: SQLiteTable) => {
        tableMap.set(table.name.toLowerCase(), table);
    });

    for (let colId = 1; colId < schema.column_names.length; colId++) {
        const [tableIdx, colName] = schema.column_names[colId];
        const originalColumnName = schema.column_names_original[colId]?.[1] || colName;
        const colType = schema.column_types[colId] || 'text';
        const tableName = schema.table_names_original[tableIdx];
        if (!tableName) continue;

        const table = tableMap.get(tableName.toLowerCase());
        if (!table) continue;

        const colEntry = table.columns.find((column) =>
            column.name.toLowerCase() === String(colName).toLowerCase()
            || column.name.toLowerCase() === String(originalColumnName).toLowerCase()
        );
        if (!colEntry) continue;

        const sampleValues = Array.isArray(colEntry.values) ? colEntry.values : [];
        const tokenMatched: number[] = [];

        for (let qId = 0; qId < tokens.length; qId++) {
            const token = String(tokens[qId] || '').trim();
            if (!token) continue;

            const numeric = !Number.isNaN(Number(token));
            if (numeric) {
                if (colType === 'number' || colType === 'time') {
                    num_date_match[`${qId},${colId}`] = colType.toUpperCase();
                }
                continue;
            }

            if (sampleValues.some((value: string) => sampleValueContainsToken(value, token))) {
                tokenMatched.push(qId);
            }
        }

        let start = 0;
        while (start < tokenMatched.length) {
            let end = start;
            while (end + 1 < tokenMatched.length && tokenMatched[end + 1] === tokenMatched[end] + 1) {
                end++;
            }

            const firstTokenId = tokenMatched[start];
            const lastTokenId = tokenMatched[end];
            const phrase = tokens.slice(firstTokenId, lastTokenId + 1).join(' ');
            const normalizedPhrase = normalizeCvValue(phrase);
            const exact = sampleValues.some((value: string) => normalizeCvValue(value) === normalizedPhrase);
            const matchType = exact ? 'EXACTMATCH' : 'PARTIALMATCH';

            for (let tokenId = firstTokenId; tokenId <= lastTokenId; tokenId++) {
                cell_match[`${tokenId},${colId}`] = matchType;
            }

            start = end + 1;
        }
    }

    const cvLink: CvLink = { num_date_match, cell_match };
    console.log('🔍 [cv_link] buildCvLinkFromSchemaValues result', {
        database_sample_tables: tables.length,
        sampled_value_count: tables.reduce(
            (total: number, table: SQLiteTable) => total + table.columns.reduce(
                (columnTotal: number, column) => columnTotal + (Array.isArray(column.values) ? column.values.length : 0),
                0
            ),
            0
        ),
        num_date_match_count: Object.keys(num_date_match).length,
        cell_match_count: Object.keys(cell_match).length,
        cvLink: JSON.stringify(cvLink, null, 2)
    });

    return cvLink;
}


interface CopilotPromptRecord {
    stage: 'direct' | 'generation' | 'correction' | 'dialect_conversion';
    attempt: number;
    model_id: string;
    prompt: string;
}

interface GenerationTiming {
    // copilot_ms is retained for compatibility with earlier CSV/analysis scripts.
    copilot_ms: number;
    attempts: number;
    model_id: string;
    prompts?: CopilotPromptRecord[];
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
    cached_tokens?: number | null;
    actual_model_id?: string;
    api_request_attempts?: number;
    initial_sql?: string;
    validation_calls?: number;
    correction_requests?: number;
    validation_passed?: boolean | null;
}

export class NL2SQLPanel {
    public static currentPanel: NL2SQLPanel | undefined;
    public static readonly viewType = 'nl2sql';

    public readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];
    private _batchRunning = false;
    private _stopBatchRequested = false;
    private _generationRunning = false;

    public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists, show it
        if (NL2SQLPanel.currentPanel) {
            NL2SQLPanel.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create new panel
        const panel = vscode.window.createWebviewPanel(
            NL2SQLPanel.viewType,
            'NL2SQL Converter',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        NL2SQLPanel.currentPanel = new NL2SQLPanel(panel, extensionUri, context);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;

        // Set webview HTML content
        this._update();

        // Listen for panel disposal events
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'runSpiderBatch':
                        if (this._batchRunning || this._generationRunning) {
                            vscode.window.showInformationMessage('A generation is already running.');
                            return;
                        }
                        this._batchRunning = true;
                        this._stopBatchRequested = false;
                        try {
                            await this._runSpiderBatch(message);
                        } catch (error) {
                            vscode.window.showErrorMessage('Spider timing: ' + (error instanceof Error ? error.message : String(error)));
                        } finally {
                            this._batchRunning = false;
                        }
                        return;
                    case 'stopSpiderBatch':
                        this._stopBatchRequested = true;
                        vscode.window.showInformationMessage('The batch will stop after the current question is saved.');
                        return;
                    case 'convert':
                        if (this._batchRunning || this._generationRunning) {
                            vscode.window.showInformationMessage('A generation is already running.');
                            return;
                        }
                        this._generationRunning = true;
                        const singleTiming: GenerationTiming = { copilot_ms: 0, attempts: 0, model_id: '', prompts: [] };
                        const singleStartedAt = new Date().toISOString();
                        try {
                            const sql = await this._generateSql(message, singleTiming);
                            this._panel.webview.postMessage({ command: 'result', sql: sql || '-- No SQL was generated' });
                        } catch (error) {
                            console.error('Convert error:', error);
                            this._panel.webview.postMessage({
                                command: 'result',
                                sql: '-- Error during conversion\n-- ' + (error instanceof Error ? error.message : String(error)),
                                results: undefined
                            });
                        } finally {
                            const singleFinishedAt = new Date().toISOString();
                            try {
                                if (singleTiming.prompts?.length) {
                                    const useServer = message.useServer !== false;
                                    const useRules = message.useRuleValidation !== false;
                                    const mode = this._getAblationMode(useServer, useRules);
                                    const directory = this._getResultDirectory(
                                        useServer, message.aiProvider, useRules,
                                        message.aiProvider === 'kimi' ? String(message.kimiModelId || singleTiming.model_id || '') : undefined
                                    );
                                    await fs.promises.mkdir(directory, { recursive: true });
                                    await fs.promises.appendFile(path.join(directory, 'single_prompts.txt'), this._formatPromptLog({
                                        db_id: message.selectedDb || message.database,
                                        question: message.text, generation_mode: mode,
                                        started_at: singleStartedAt, finished_at: singleFinishedAt
                                    }, singleTiming.prompts), 'utf8');
                                }
                            } catch (error) {
                                vscode.window.showWarningMessage('Could not save the Copilot prompt: ' + String(error));
                            } finally {
                                this._generationRunning = false;
                            }
                        }
                        return;
                    case 'executeSQL':
                        try {
                            const dbType = String(message.type || '').toLowerCase();
                            const sqlToExecute = String(message.sql || '').trim();
                            const selectedDatabase = String(message.database || '').trim();

                            if (!sqlToExecute) {
                                this._panel.webview.postMessage({
                                    command: 'result',
                                    sql: message.sql || '-- No SQL was provided',
                                    results: undefined,
                                    error: 'No SQL was provided for execution.'
                                });
                                return;
                            }

                            let executionResults: any[] = [];

                            // SQLite
                            if (dbType === 'sqlite') {
                                if (!selectedDatabase) {
                                    throw new Error('No SQLite database file is selected.');
                                }
                                executionResults = await executeSQL(selectedDatabase, sqlToExecute);

                            // MySQL / MariaDB
                            } else if (dbType === 'mysql' || dbType === 'mariadb') {
                                const mysqlConfig = await getMySQLConfig(this._context);
                                if (!mysqlConfig) {
                                    throw new Error('MySQL is not configured. Please run "Configure MySQL" first.');
                                }
                                if (!selectedDatabase) {
                                    throw new Error('No MySQL database is selected.');
                                }

                                const mysql = require('mysql2');
                                const connection = mysql.createConnection({
                                    host: mysqlConfig.host,
                                    port: mysqlConfig.port,
                                    user: mysqlConfig.user,
                                    password: mysqlConfig.password,
                                    database: selectedDatabase,
                                    connectTimeout: 5000
                                });

                                const mysqlResult: any = await new Promise<any>((resolve, reject) => {
                                    connection.connect((connectErr: any) => {
                                        if (connectErr) {
                                            connection.destroy();
                                            return reject(connectErr);
                                        }

                                        connection.query(sqlToExecute, (queryErr: any, results: any) => {
                                            connection.end();
                                            if (queryErr) return reject(queryErr);
                                            resolve(results);
                                        });
                                    });
                                });

                                // SELECT returns an array of row objects.
                                // INSERT/UPDATE/DELETE returns a ResultSetHeader object, normalize it
                                // to a one-row table so the existing result renderer can display it.
                                if (Array.isArray(mysqlResult)) {
                                    executionResults = mysqlResult;
                                } else if (mysqlResult && typeof mysqlResult === 'object') {
                                    executionResults = [{
                                        affectedRows: mysqlResult.affectedRows ?? 0,
                                        insertId: mysqlResult.insertId ?? null,
                                        changedRows: mysqlResult.changedRows ?? 0,
                                        warningStatus: mysqlResult.warningStatus ?? 0
                                    }];
                                } else {
                                    executionResults = [];
                                }

                            // PostgreSQL
                            } else if (dbType === 'postgresql' || dbType === 'pg' || dbType === 'postgres') {
                                const pgConfig = await getPostgresConfig(this._context);
                                if (!pgConfig) {
                                    throw new Error('PostgreSQL is not configured. Please run "Configure Postgres" first.');
                                }
                                if (!selectedDatabase) {
                                    throw new Error('No PostgreSQL database is selected.');
                                }

                                const { Client } = require('pg');
                                const client = new Client({
                                    host: pgConfig.host,
                                    port: pgConfig.port,
                                    user: pgConfig.user,
                                    password: pgConfig.password,
                                    database: selectedDatabase,
                                    statement_timeout: 5000,
                                    connectionTimeoutMillis: 5000
                                });

                                await client.connect();
                                try {
                                    // Keep the default object row mode so renderResultsTable()
                                    // receives { columnName: value } objects, just like SQLite/MySQL.
                                    const pgResult = await client.query(sqlToExecute);
                                    if (Array.isArray(pgResult.rows) && pgResult.rows.length > 0) {
                                        executionResults = pgResult.rows;
                                    } else if (pgResult.command && pgResult.command !== 'SELECT') {
                                        executionResults = [{
                                            command: pgResult.command,
                                            rowCount: pgResult.rowCount ?? 0
                                        }];
                                    } else {
                                        executionResults = [];
                                    }
                                } finally {
                                    await client.end();
                                }

                            } else {
                                throw new Error(`Unsupported database type: ${dbType || 'unknown'}`);
                            }

                            this._panel.webview.postMessage({
                                command: 'result',
                                sql: sqlToExecute,
                                results: executionResults
                            });

                        } catch (error: any) {
                            const errMsg = error?.message || String(error);
                            console.error('❌ executeSQL error:', error);
                            this._panel.webview.postMessage({
                                command: 'result',
                                sql: message.sql || '-- No SQL was provided',
                                results: undefined,
                                error: errMsg
                            });
                        }
                        return;
                    case 'loadFewShot':
                        try {
                            const storagePath = this._context.globalStorageUri.fsPath;
                            const poolFile = path.join(storagePath, 'fewshot_pool.json');
                            let pool: any[] = [];
                            if (fs.existsSync(poolFile)) {
                                const content = fs.readFileSync(poolFile, 'utf8');
                                pool = content ? JSON.parse(content) : [];
                                if (!Array.isArray(pool)) pool = [];
                            }
                            this._panel.webview.postMessage({ command: 'fewShotLoaded', pool});
                        } catch (err) {
                            console.error('Error loading few shot pool:', err);
                            this._panel.webview.postMessage({ command: 'fewShotLoaded', pool: [], error: (err as Error).message || 'Read failed' });
                        }
                        return;
                    case 'saveFewShot':
                        let poolFile = '';
                        try {
                            const record = message.record || {};
                            const nlqText = String(record.nlq || '');
                            const sqlText = String(record.sql || '');
                            const dbId = String(record.db_id || record.database || 'unknown');

                            // Try to generate embedding at backend and attach
                            const dalConfig = vscode.workspace.getConfiguration('nl2sql');
                            const dalApiUrl = dalConfig.get<string>('dailsql.apiUrl') || 'http://localhost:8000';
                            let embedding: number[] | undefined;

                            try {
                                const embedResp = await axios.post(
                                    `${dalApiUrl}/api/v1/encode`,
                                    { texts: [nlqText] },
                                    { timeout: 30000 }
                                );

                                if (embedResp.data?.success && Array.isArray(embedResp.data.embeddings) && embedResp.data.embeddings[0]) {
                                    embedding = embedResp.data.embeddings[0];
                                } else {
                                    console.warn('Failed to fetch embedding for few-shot', embedResp.data);
                                }
                            } catch (embedErr) {
                                console.warn('Error calling backend embedding endpoint:', embedErr);
                            }

                            const storagePath = this._context.globalStorageUri.fsPath;
                            if (!fs.existsSync(storagePath)) {
                                fs.mkdirSync(storagePath, { recursive: true });
                            }

                            const poolFilePath = path.join(storagePath, 'fewshot_pool.json');
                            let pool: any[] = [];
                            if (fs.existsSync(poolFilePath)) {
                                try {
                                    const content = fs.readFileSync(poolFilePath, 'utf8');
                                    pool = content ? JSON.parse(content) : [];
                                    if (!Array.isArray(pool)) pool = [];
                                } catch (innerErr) {
                                    console.warn('Failed to parse existing fewshot pool, overwriting', innerErr);
                                    pool = [];
                                }
                            }

                            const nextIndex = pool.length > 0 ? Math.max(...pool.map((item: any) => Number(item.index) || 0)) + 1 : 1;
                            const dataEntry: any = {
                                index: nextIndex,
                                nlq: nlqText,
                                sql: sqlText,
                                db_id: dbId,
                                created_at: new Date().toISOString(),
                                call_count: 0
                            };
                            if (embedding) {
                                dataEntry.embedding = embedding;
                            }

                            pool.push(dataEntry);

                            const MAX_FEWSHOT_POOL_SIZE = 100;
                            if (pool.length > MAX_FEWSHOT_POOL_SIZE) {
                                pool.sort((a: any, b: any) => {
                                    const aCount = Math.max(0, Number(a?.call_count) || 0);
                                    const bCount = Math.max(0, Number(b?.call_count) || 0);
                                    if (aCount !== bCount) return aCount - bCount;

                                    const aTime = Date.parse(String(a?.created_at || '')) || 0;
                                    const bTime = Date.parse(String(b?.created_at || '')) || 0;
                                    return aTime - bTime;
                                });

                                const removeCount = pool.length - MAX_FEWSHOT_POOL_SIZE;
                                const removed = pool.splice(0, removeCount);
                                console.log('🧹 Few-shot pool pruned to 100 records', {
                                    removed: removed.length,
                                    removed_summary: removed.map((r: any) => ({ index: r?.index, call_count: r?.call_count }))
                                });
                            }

                            fs.writeFileSync(poolFilePath, JSON.stringify(pool, null, 2), 'utf8');

                            this._panel.webview.postMessage({ command: 'fewShotSaved', success: true, index: nextIndex, entry: dataEntry, path: poolFilePath });
                        } catch (err) {
                            console.error('Error saving few shot pool:', err);
                            this._panel.webview.postMessage({ command: 'fewShotSaved', success: false, path: poolFile, error: (err as Error).message || 'Write failed' });
                        }
                        return;
                    case 'getKimiSettings':
                        this._panel.webview.postMessage({
                            command: 'kimiSettings',
                            modelId: this._context.globalState.get<string>('kimi-model-id', 'kimi-k2.6'),
                            baseUrl: this._context.globalState.get<string>('kimi-base-url', 'https://api.moonshot.cn/v1'),
                            thinking: this._context.globalState.get<string>('kimi-k26-thinking',
                                this._context.globalState.get<string>('kimi-thinking', 'disabled')),
                            reasoningEffort: this._context.globalState.get<string>('kimi-k3-effort',
                                this._context.globalState.get<string>('kimi-thinking', 'disabled') === 'disabled' ? 'low' : 'default'),
                            maxCompletionTokens: this._context.globalState.get<string>('kimi-max-completion-tokens', ''),
                            timeoutMs: this._context.globalState.get<number>('kimi-timeout-ms', 180000),
                            retryCount: this._context.globalState.get<number>('kimi-retry-count', 0),
                            cacheTtl: this._context.globalState.get<string>('kimi-cache-ttl', 'default'),
                            stopSequences: this._context.globalState.get<string>('kimi-stop-sequences', ''),
                            hasKey: !!(await this._context.secrets.get('kimi-api-key'))
                        });
                        return;
                    case 'saveKimiSettings': {
                        const modelId = String(message.modelId || '').trim();
                        const baseUrl = String(message.baseUrl || '').trim();
                        const thinking = String(message.thinking || 'disabled');
                        const reasoningEffort = String(message.kimiReasoningEffort || 'default');
                        if (!modelId || !baseUrl || !['default', 'disabled', 'enabled'].includes(thinking)
                            || !['default', 'low', 'high', 'max'].includes(reasoningEffort)) return;
                        try {
                            this._validatedKimiUrl(baseUrl);
                            this._getKimiRequestOptions({ ...message, kimiModelId: modelId, kimiThinking: thinking }, modelId);
                        } catch (error) {
                            vscode.window.showErrorMessage('Invalid Kimi settings: ' + (error instanceof Error ? error.message : String(error)));
                            return;
                        }
                        await this._context.globalState.update('kimi-model-id', modelId);
                        await this._context.globalState.update('kimi-base-url', baseUrl.replace(/\/$/, ''));
                        await this._context.globalState.update('kimi-thinking', thinking); // legacy compatibility
                        await this._context.globalState.update('kimi-k26-thinking', thinking);
                        await this._context.globalState.update('kimi-k3-effort', reasoningEffort);
                        await this._context.globalState.update('kimi-max-completion-tokens', String(message.kimiMaxCompletionTokens ?? ''));
                        await this._context.globalState.update('kimi-timeout-ms', Number(message.kimiTimeoutMs ?? 180000));
                        await this._context.globalState.update('kimi-retry-count', Number(message.kimiRetryCount ?? 0));
                        await this._context.globalState.update('kimi-cache-ttl', String(message.kimiCacheTtl ?? 'default'));
                        await this._context.globalState.update('kimi-stop-sequences', String(message.kimiStopSequences ?? ''));
                        return;
                    }
                    case 'listKimiModels': {
                        const requestId = Number(message.requestId) || 0;
                        try {
                            // Fetch models from the selected Kimi API account, not a hardcoded catalog.
                            const key = await this._context.secrets.get('kimi-api-key');
                            if (!key) throw new Error('Configure the Kimi API key first.');
                            const baseUrl = this._validatedKimiUrl(String(message.kimiBaseUrl
                                || this._context.globalState.get<string>('kimi-base-url', 'https://api.moonshot.cn/v1')));
                            const response = await axios.get(baseUrl + '/models', {
                                timeout: 20000,
                                headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }
                            });
                            if (!Array.isArray(response.data?.data)) {
                                throw new Error('Unexpected model-list response: data must be an array.');
                            }
                            const models = response.data.data
                                .filter((m: any) => m && typeof m.id === 'string' && m.id.trim())
                                .map((m: any) => ({
                                    id: String(m.id).trim(),
                                    contextLength: typeof m.context_length === 'number' ? m.context_length : null,
                                    supportsReasoning: m.supports_reasoning === true
                                }));
                            this._panel.webview.postMessage({
                                command: 'kimiModels', requestId, baseUrl, models
                            });
                        } catch (error: any) {
                            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
                            const detail = axios.isAxiosError(error)
                                ? String(error.response?.data?.error?.message || error.response?.data?.message || error.message)
                                : (error instanceof Error ? error.message : String(error));
                            // Do not expose the key, Authorization header, or the raw axios error.
                            this._panel.webview.postMessage({
                                command: 'kimiModels', requestId, models: [],
                                error: (status ? 'HTTP ' + status + ': ' : '') + detail.slice(0, 250)
                            });
                        }
                        return;
                    }
                    case 'configureKimiApi': {
                        const key = await vscode.window.showInputBox({
                            title: 'Kimi API key',
                            prompt: 'Paste the key from the Kimi API Platform (stored in VS Code SecretStorage).',
                            password: true,
                            ignoreFocusOut: true
                        });
                        if (key !== undefined && key.trim()) {
                            await this._context.secrets.store('kimi-api-key', key.trim());
                            this._panel.webview.postMessage({ command: 'kimiKeyStatus', hasKey: true });
                            vscode.window.showInformationMessage('Kimi API key saved securely.');
                        }
                        return;
                    }
                    case 'testKimiApi': {
                        if (this._batchRunning || this._generationRunning) {
                            vscode.window.showInformationMessage('A generation is already running.');
                            return;
                        }
                        try {
                            const response = await this._requestKimi('Reply with OK only.', {
                                aiProvider: 'kimi', kimiModelId: message.kimiModelId,
                                ...message
                            });
                            vscode.window.showInformationMessage('Kimi API connected. Model: ' + (response.modelId || 'unknown'));
                            this._panel.webview.postMessage({ command: 'kimiTestResult', success: true });
                        } catch (error) {
                            const errorText = error instanceof Error ? error.message : String(error);
                            vscode.window.showErrorMessage('Kimi API test failed: ' + errorText);
                            this._panel.webview.postMessage({ command: 'kimiTestResult', success: false, error: errorText });
                        }
                        return;
                    }
                    case 'getModels':
                        try {
                            const availableModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
                            // Internal utility/dictation aliases can share a public model's display name.
                            const modelList = availableModels
                                .filter(m => !this._isInternalCopilotModelId(m.id))
                                .map(m => ({ id: m.id, name: m.name || m.id }));
                            console.log('📋 Available Copilot models:', modelList);
                            this._panel.webview.postMessage({ command: 'copilotModels', models: modelList });
                        } catch (e) {
                            console.error('Failed to fetch Copilot models:', e);
                            this._panel.webview.postMessage({ command: 'copilotModels', models: [] });
                        }
                        return;
                    case 'reverse':
                        const nlResult = await convertSQLToNaturalLanguage(message.sql, message.database || 'sqlite');
                        this._panel.webview.postMessage({ command: 'nlResult', text: nlResult });
                        return;
                    case 'getDatabases':
                        if (message.type === 'sqlite') {
                            try {
                                const sqliteFiles = await findSQLiteFiles();
                                const databases = sqliteFiles.map(filePath => {
                                    const fileName = path.basename(filePath);
                                    // Remove extension for display name but keep full path for value
                                    const displayName = fileName.replace(/\.(db|sqlite|sqlite3)$/i, '');
                                    return {
                                        name: displayName,
                                        path: filePath
                                    };
                                });
                                this._panel.webview.postMessage({ command: 'databases', databases });
                            } catch (error) {
                                console.error('Error finding SQLite files:', error);
                                this._panel.webview.postMessage({ command: 'databases', databases: [] });
                            }
                        } else if (message.type === 'mysql') {
                            try {
                                console.log('Getting MySQL databases...');
                                const mysqlConfig = await getMySQLConfig(this._context);
                                console.log('MySQL config:', mysqlConfig ? 'found' : 'not found');
                                if (mysqlConfig) {
                                    const databases = await getMySQLDatabases(mysqlConfig);
                                    console.log('MySQL databases:', databases);
                                    this._panel.webview.postMessage({ command: 'databases', databases: databases.map(name => ({ name, path: name })) });
                                } else {
                                    console.log('MySQL not configured, sending error message');
                                    this._panel.webview.postMessage({ command: 'databases', databases: [], error: 'MySQL not configured. Please configure MySQL connection first.' });
                                }
                            } catch (error) {
                                console.error('Error getting MySQL databases:', error);
                                this._panel.webview.postMessage({ command: 'databases', databases: [], error: 'Error connecting to MySQL: ' + (error as Error).message });
                            }
                        } else if (message.type === 'postgresql') {
                            try {
                                console.log('Getting Postgres databases...');
                                const pgConfig = await getPostgresConfig(this._context);
                                console.log('Postgres config:', pgConfig ? 'found' : 'not found');
                                if (pgConfig) {
                                    const databases = await getPostgresDatabases(pgConfig);
                                    console.log('Postgres databases:', databases);
                                    this._panel.webview.postMessage({ command: 'databases', databases: databases.map(name => ({ name, path: name })) });
                                } else {
                                    console.log('Postgres not configured, sending error message');
                                    this._panel.webview.postMessage({ command: 'databases', databases: [], error: 'Postgres not configured. Please configure Postgres connection first.' });
                                }
                            } catch (error) {
                                console.error('Error getting Postgres databases:', error);
                                this._panel.webview.postMessage({ command: 'databases', databases: [], error: 'Error connecting to Postgres: ' + (error as Error).message });
                            }
                        }
                        return;
                    case 'getSchema':
                        try {
                            if (message.type === 'sqlite' && message.database && 
                                (message.database.endsWith('.db') || 
                                 message.database.endsWith('.sqlite') || 
                                 message.database.endsWith('.sqlite3'))) {
                                const schema = await readSQLiteSchema(message.database);
                                this._panel.webview.postMessage({ command: 'schema', schema });
                            } else if (message.type === 'mysql' && message.database) {
                                const mysqlConfig = await getMySQLConfig(this._context);
                                if (mysqlConfig) {
                                    mysqlConfig.database = message.database;
                                    const schema = await readMySQLSchema(mysqlConfig);
                                    this._panel.webview.postMessage({ command: 'schema', schema });
                                } else {
                                    this._panel.webview.postMessage({ command: 'schema', schema: [], error: 'MySQL not configured' });
                                }
                            } else if (message.type === 'postgresql' && message.database) {
                                const pgConfig = await getPostgresConfig(this._context);
                                if (pgConfig) {
                                    pgConfig.database = message.database;
                                    const schema = await readPostgresSchema(pgConfig);
                                    this._panel.webview.postMessage({ command: 'schema', schema });
                                } else {
                                    this._panel.webview.postMessage({ command: 'schema', schema: [], error: 'Postgres not configured' });
                                }
                            } else {
                                this._panel.webview.postMessage({ command: 'schema', schema: [], error: 'Invalid database path for schema' });
                            }
                        } catch (error) {
                            console.error('Error reading schema:', error);
                            this._panel.webview.postMessage({ command: 'schema', schema: [], error: 'Error reading schema: ' + (error as Error).message });
                        }
                        return;
                    case 'getTableData':
                        try {
                            let rows = [];
                            if (message.type === 'sqlite' && message.database) {
                                const table = message.table;
                                const safeName = quoteIdentifier(table);
                                const sql = `SELECT * FROM ${safeName} LIMIT 100`;
                                rows = await executeSQL(message.database, sql);
                            } else if (message.type === 'mysql' && message.database) {
                                try {
                                    const mysqlConfig = await getMySQLConfig(this._context);
                                    if (mysqlConfig) {
                                        mysqlConfig.database = message.database;
                                        rows = await readMySQLTableRows(mysqlConfig, message.table);
                                    } else {
                                        console.warn('MySQL not configured, cannot load table data');
                                        rows = [];
                                    }
                                } catch (e) {
                                    console.error('Error reading MySQL table data:', e);
                                    rows = [];
                                }
                            } else if (message.type === 'postgresql' && message.database) {
                                try {
                                    const pgConfig = await getPostgresConfig(this._context);
                                    if (pgConfig) {
                                        pgConfig.database = message.database;
                                        rows = await readPostgresTableRows(pgConfig, message.table);
                                    } else {
                                        console.warn('Postgres not configured, cannot load table data');
                                        rows = [];
                                    }
                                } catch (e) {
                                    console.error('Error reading Postgres table data:', e);
                                    rows = [];
                                }
                            } else {
                                // Unsupported type
                                rows = [];
                            }
                            this._panel.webview.postMessage({ command: 'tableData', table: message.table, rows });
                        } catch (error) {
                            console.error('Error loading table data:', error);
                            this._panel.webview.postMessage({ command: 'tableData', table: message.table, rows: [] });
                        }
                        return;
                    case 'configureMySQL':
                        vscode.commands.executeCommand('nl2sql.configureMysql');
                        return;
                    case 'configurePostgres':
                        vscode.commands.executeCommand('nl2sql.configurePostgres');
                        return;
                    case 'uploadDatabase':
                        vscode.commands.executeCommand('nl2sql.uploadDatabase');
                        return;
                    case 'convertWithCustomDB':
                        try {
                            const result = await convertNaturalLanguageToSQL(message.question, message.database_id);
                            this._panel.webview.postMessage({ 
                                command: 'conversionResult', 
                                result: result,
                                question: message.question,
                                database: message.database_id
                            });
                        } catch (error) {
                            this._panel.webview.postMessage({ 
                                command: 'conversionError', 
                                error: (error as Error).message 
                            });
                        }
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private _getAblationMode(useDail: boolean, useRules: boolean): string {
        return useDail ? (useRules ? 'full' : 'dail_only') : (useRules ? 'rule_only' : 'direct');
    }

    private _getResultDirectory(
        useServer: boolean,
        provider: string = 'copilot',
        useRules: boolean = true,
        selectedModelId?: string
    ): string {
        const outputRoot = String.raw`C:\Users\grizz\OneDrive\Desktop\COSC 449\vscode_NL_to_SQL`;
        const mode = this._getAblationMode(useServer, useRules);

        if (provider === 'kimi') {
            // Keep each model and each ablation condition in its own directory.
            // Use the requested model ID, rather than the API response's alias.
            const modelId = String(selectedModelId ||
                this._context.globalState.get<string>('kimi-model-id', 'kimi-k2.6')).trim();
            if (!modelId) throw new Error('A Kimi model ID is required to save results.');

            // Prevent custom model IDs containing /, :, or Windows reserved names
            // from escaping the intended results folder or colliding after cleanup.
            const safeName = modelId.replace(/[^a-zA-Z0-9._-]/g, '_')
                .replace(/^[._]+|[._]+$/g, '').slice(0, 70) || 'model';
            const reservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName);
            // Windows folders are case-insensitive; preserve distinct case-sensitive IDs.
            const folderName = safeName === modelId && !reservedName && modelId === modelId.toLowerCase()
                ? safeName
                : safeName + '__' + createHash('sha256').update(modelId).digest('hex').slice(0, 8);
            const modeFolder = mode === 'full' ? 'DAIL_Rules'
                : mode === 'dail_only' ? 'DAIL_Only'
                : mode === 'rule_only' ? 'Rules_Only' : 'Baseline';
            return path.join(outputRoot, 'Results', folderName, modeFolder);
        }

        // Preserve all existing GitHub Copilot paths and historical data.
        if (mode === 'full') return path.join(outputRoot, 'result_DAIL');
        if (mode === 'direct') return path.join(outputRoot, 'result_without_DAIL');
        return path.join(outputRoot, mode === 'dail_only' ? 'result_DAIL_Only' : 'result_Rule_Only');
    }

    private _formatPromptLog(record: any, requests: CopilotPromptRecord[]): string {
        const lines = [
            '', '================ LLM PROMPTS ================',
            'Index: ' + (record.index ?? 'single'), 'Database: ' + record.db_id,
            'Mode: ' + record.generation_mode, 'Question: ' + record.question,
            'Started at: ' + record.started_at, 'Finished at: ' + record.finished_at
        ];
        if (record.status) lines.push('Status: ' + record.status);
        if (record.error) lines.push('Error: ' + record.error);
        if (!requests.length) lines.push('(No LLM request was made.)');
        for (const request of requests) {
            lines.push('', 'Stage: ' + request.stage + ', attempt: ' + request.attempt,
                'Model: ' + request.model_id, '--- BEGIN PROMPT ---', request.prompt, '--- END PROMPT ---');
        }
        return lines.join('\n') + '\n';
    }

    private _isInternalCopilotModelId(id: string): boolean {
        return /^copilot-(?:utility(?:-|$)|dictation(?:-|$))/i.test(id);
    }

    private _validatedKimiUrl(raw: string): string {
        const value = raw.trim().replace(/\/+$/, '');
        let url: URL;
        try { url = new URL(value); }
        catch { throw new Error('Invalid Kimi API base URL. Example: https://api.moonshot.cn/v1'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
            throw new Error('Kimi API base URL must be an HTTPS URL without credentials or query parameters.');
        }
        if (!url.pathname.endsWith('/v1')) {
            throw new Error('Kimi API base URL must end in /v1 (not /chat/completions).');
        }
        return value;
    }

    /** Build only model-supported request parameters; never include a key or prompt in logs. */
    private _getKimiRequestOptions(message: any, modelId: string): {
        bodyOptions: Record<string, any>; timeoutMs: number; retryCount: number;
        thinking: string; reasoningEffort: string;
    } {
        const isK3 = /^kimi-k3(?:\.|$)/i.test(modelId);
        const isK26 = modelId === 'kimi-k2.6';
        const thinking = String(message.kimiThinking ?? this._context.globalState.get<string>('kimi-k26-thinking',
            this._context.globalState.get<string>('kimi-thinking', 'disabled')));
        const legacy = this._context.globalState.get<string>('kimi-thinking', 'disabled');
        const reasoningEffort = String(message.kimiReasoningEffort ?? this._context.globalState.get<string>(
            'kimi-k3-effort', legacy === 'disabled' ? 'low' : 'default'));
        if (!['default', 'enabled', 'disabled'].includes(thinking)) throw new Error('Invalid K2.6 thinking setting.');
        if (!['default', 'low', 'high', 'max'].includes(reasoningEffort)) throw new Error('Invalid K3 reasoning effort.');

        const bodyOptions: Record<string, any> = {};
        if (isK26 && thinking !== 'default') bodyOptions.thinking = { type: thinking };
        if (isK3 && reasoningEffort !== 'default') bodyOptions.reasoning_effort = reasoningEffort;

        const tokenText = String(message.kimiMaxCompletionTokens ?? this._context.globalState.get<string>(
            'kimi-max-completion-tokens', '')).trim();
        if (tokenText) {
            const limit = Number(tokenText);
            const ceiling = isK3 ? 1048576 : 262144;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) {
                throw new Error('Output token limit must be a whole number from 1 to ' + ceiling + '.');
            }
            // K3 documents max_completion_tokens; K2.6 uses legacy max_tokens.
            bodyOptions[isK3 ? 'max_completion_tokens' : 'max_tokens'] = limit;
        }
        const cacheTtl = String(message.kimiCacheTtl ?? this._context.globalState.get<string>('kimi-cache-ttl', 'default'));
        if (!['default', '5m', '1h'].includes(cacheTtl)) throw new Error('Invalid cache TTL.');
        if (isK3 && cacheTtl !== 'default') bodyOptions.prompt_cache_options = { ttl: cacheTtl };

        const stopText = String(message.kimiStopSequences ?? this._context.globalState.get<string>('kimi-stop-sequences', ''));
        const stop = stopText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        if (stop.length > 5 || stop.some(value => new TextEncoder().encode(value).length > 32)) {
            throw new Error('Use up to five stop strings, each 32 UTF-8 bytes or fewer.');
        }
        if (stop.length) bodyOptions.stop = stop;

        const timeoutMs = Number(message.kimiTimeoutMs ?? this._context.globalState.get<number>('kimi-timeout-ms', 180000));
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 900000) {
            throw new Error('Kimi timeout must be between 10000 and 900000 milliseconds.');
        }
        const retryCount = Number(message.kimiRetryCount ?? this._context.globalState.get<number>('kimi-retry-count', 0));
        if (!Number.isSafeInteger(retryCount) || retryCount < 0 || retryCount > 3) {
            throw new Error('Kimi retry count must be between 0 and 3.');
        }
        return { bodyOptions, timeoutMs, retryCount, thinking, reasoningEffort };
    }

    private async _requestKimi(prompt: string, message: any, onAttempt?: () => void): Promise<{
        text: string; modelId: string; promptTokens: number | null;
        completionTokens: number | null; totalTokens: number | null; cachedTokens: number | null;
    }> {
        const apiKey = await this._context.secrets.get('kimi-api-key');
        if (!apiKey) throw new Error('Kimi API key is missing. Click Configure API Key first.');
        const modelId = String(message.kimiModelId || this._context.globalState.get<string>('kimi-model-id', 'kimi-k2.6')).trim();
        if (!modelId) throw new Error('Enter a Kimi model ID.');
        const baseUrl = this._validatedKimiUrl(String(message.kimiBaseUrl
            || this._context.globalState.get<string>('kimi-base-url', 'https://api.moonshot.cn/v1')));
        const options = this._getKimiRequestOptions(message, modelId);
        const body: any = {
            model: modelId, messages: [{ role: 'user', content: prompt }], stream: false,
            ...options.bodyOptions
        };
        for (let attempt = 0; attempt <= options.retryCount; attempt++) {
            onAttempt?.();
            try {
                const resp = await axios.post(baseUrl + '/chat/completions', body, {
                    timeout: options.timeoutMs,
                    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
                });
                const choice = resp.data?.choices?.[0];
                const content = choice?.message?.content;
                const output = typeof content === 'string' ? content
                    : Array.isArray(content) ? content.filter((v: any) => v?.type === 'text').map((v: any) => v.text || '').join('') : '';
                if (choice?.finish_reason === 'length') {
                    throw new Error('Kimi reached the output token limit before completing the response. Increase Max output tokens.');
                }
                if (!output.trim()) {
                    throw new Error('Kimi returned no final content (finish_reason=' + String(choice?.finish_reason || 'unknown') + ').');
                }
                const usage = resp.data?.usage || {};
                const numeric = (value: any): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
                return {
                    text: output, modelId: String(resp.data?.model || modelId),
                    promptTokens: numeric(usage.prompt_tokens),
                    completionTokens: numeric(usage.completion_tokens),
                    totalTokens: numeric(usage.total_tokens),
                    cachedTokens: numeric(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens)
                };
            } catch (error: any) {
                if (!axios.isAxiosError(error)) throw error;
                const status = error.response?.status;
                const detail = String(error.response?.data?.error?.message || error.response?.data?.message || error.message);
                // Only retry transient failures, never authentication, quota or malformed requests.
                const transient = [429, 500, 502, 503, 504].includes(Number(status))
                    || (!status && /timeout|ECONNRESET|ETIMEDOUT|ECONNABORTED/i.test(detail));
                if (transient && attempt < options.retryCount) {
                    const retryAfter = Number(error.response?.headers?.['retry-after']);
                    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 0;
                    const waitMs = Math.min(30000, Math.max(800 * Math.pow(2, attempt), retryAfterMs));
                    await new Promise<void>(resolve => setTimeout(resolve, waitMs));
                    continue;
                }
                // Never include headers, request body or API key in error messages.
                throw new Error('Kimi API ' + (status || 'network') + ': ' + detail.slice(0, 350));
            }
        }
        throw new Error('Kimi API exhausted all retries.');
    }

    private async _askModel(prompt: string, message: any, timing?: GenerationTiming): Promise<string> {
        const provider = message.aiProvider === 'kimi' ? 'kimi' : 'copilot';
        const started = performance.now();
        try {
            if (provider === 'kimi') {
                const result = await this._requestKimi(prompt, message, () => {
                    if (timing) timing.api_request_attempts = (timing.api_request_attempts || 0) + 1;
                });
                if (timing) {
                    timing.actual_model_id = result.modelId;
                    if (result.promptTokens !== null) timing.prompt_tokens = (timing.prompt_tokens || 0) + result.promptTokens;
                    if (result.completionTokens !== null) timing.completion_tokens = (timing.completion_tokens || 0) + result.completionTokens;
                    if (result.totalTokens !== null) timing.total_tokens = (timing.total_tokens || 0) + result.totalTokens;
                    if (result.cachedTokens !== null) timing.cached_tokens = (timing.cached_tokens || 0) + result.cachedTokens;
                }
                return result.text;
            }
            const requestedId = String(message.copilotModelId || '');
            const models: vscode.LanguageModelChat[] = message._resolvedCopilotModel
                ? [message._resolvedCopilotModel]
                : message._batchModel ? [message._batchModel]
                    : await this._selectCopilotModels(requestedId);
            if (!models.length) throw new Error('No Copilot model is available.');
            const model = models[0];
            message._resolvedCopilotModel = model;
            if (timing) timing.model_id = model.id;
            const cts = new vscode.CancellationTokenSource();
            let result = '';
            try {
                const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, cts.token);
                for await (const chunk of response.stream) {
                    if (chunk instanceof vscode.LanguageModelTextPart) result += chunk.value;
                }
            } finally { cts.dispose(); }
            return result;
        } finally {
            if (timing) timing.copilot_ms += performance.now() - started;
        }
    }

    private async _selectCopilotModels(requestedModelId: string): Promise<vscode.LanguageModelChat[]> {
        if (this._isInternalCopilotModelId(requestedModelId)) {
            throw new Error('The selected ID is an internal Copilot utility/dictation alias: '
                + requestedModelId + '. Refresh the model list and select a public model ID, such as gpt-5.6-luna.');
        }
        const models = await vscode.lm.selectChatModels(requestedModelId
            ? { vendor: 'copilot', id: requestedModelId } : { vendor: 'copilot' });
        const selectableModels = models.filter(m => !this._isInternalCopilotModelId(m.id)
            && (!requestedModelId || m.id === requestedModelId));
        if (requestedModelId && !selectableModels.length) {
            throw new Error('The selected Copilot model is currently unavailable: ' + requestedModelId
                + '. Refresh the model list. No fallback model was used.');
        }
        return selectableModels;
    }

    // The direct prompt is byte-for-byte shared by the Direct and Rule-only modes.
    // This prevents prompt changes from confounding the effect of rule-based correction.
    private _buildDirectPrompt(message: any): string {
        const tables = Array.isArray(message.schema) ? (message.schema as SQLiteTable[]) : [];
        if (!tables.length) throw new Error('Direct mode requires a loaded database schema.');
        const question = String(message.text || '').trim();
        if (!question) throw new Error('Enter a natural language question.');
        const databaseType = String(message.database || 'sqlite').toLowerCase();
        const dialect = databaseType === 'mysql' ? 'MySQL' : databaseType === 'postgresql' ? 'PostgreSQL' : 'SQLite';
        const schemaLines = tables.map(table =>
            `# ${table.name}(${table.columns.map(column => column.name).join(', ')})`
        );
        return [
            `### Complete ${dialect.toLowerCase()} SQL query only and with no explanation`,
            `### ${dialect} SQL tables, with their properties:`,
            '#', ...schemaLines, '#', `### ${question}`, 'SELECT'
        ].join('\n');
    }

    private async _generateSqlDirect(message: any, timing?: GenerationTiming): Promise<string> {
        const prompt = this._buildDirectPrompt(message);
        const provider = message.aiProvider === 'kimi' ? 'kimi' : 'copilot';
        const requestedModelId = provider === 'kimi' ? String(message.kimiModelId || 'kimi-k2.6')
            : String(message.copilotModelId || '');
        if (provider === 'copilot') {
            const models = message._batchModel ? [message._batchModel] : await this._selectCopilotModels(requestedModelId);
            if (!models.length) throw new Error('No Copilot model is available.');
            message._resolvedCopilotModel = models[0];
        }
        const actualSelectedModelId = provider === 'copilot' ? message._resolvedCopilotModel.id : requestedModelId;
        if (timing) timing.model_id = actualSelectedModelId;
        this._panel.webview.postMessage({ command: 'status', message: `Direct: schema + question -> ${provider} (${actualSelectedModelId})` });
        timing?.prompts?.push({ stage: 'direct', attempt: 1, model_id: actualSelectedModelId, prompt });
        if (timing) timing.attempts++;
        let sql = await this._askModel(prompt, message, timing);
        sql = sql.replace(/^```(?:sql|sqlite|mysql|postgresql|postgres|pgsql)?\s*/i, '').replace(/```\s*$/, '').trim();
        if (!sql) throw new Error('LLM returned empty SQL.');
        if (timing) timing.initial_sql = sql;
        return sql;
    }

    // Rule-only: direct first LLM prompt + ORIGINAL server validator.
    // The server requires a session_id. To obtain one, create a zero-shot session;
    // NEVER send the generated DAIL prompt to the model. See README for the
    // remaining possible dependence of next_prompt on the backend's session template.
    private async _generateSqlRuleOnly(message: any, timing?: GenerationTiming): Promise<string> {
        if (String(message.database || 'sqlite').toLowerCase() !== 'sqlite') {
            throw new Error('Rule-only ablation currently supports SQLite, as used by Spider.');
        }
        const tables = Array.isArray(message.schema) ? (message.schema as SQLiteTable[]) : [];
        if (!tables.length) throw new Error('Rule-only requires a loaded SQLite schema.');
        const databaseId = path.basename(String(message.selectedDb || 'spider'),
            path.extname(String(message.selectedDb || 'spider')));
        const schemaDict = buildDailSchemaFromTables(databaseId, tables);
        const dalApiUrl = vscode.workspace.getConfiguration('nl2sql').get<string>('dailsql.apiUrl') || 'http://localhost:8000';
        let backendTokens: string[] | undefined;
        try {
            const tokenResponse = await axios.post(`${dalApiUrl}/api/v1/tokenize`,
                { question: message.text, database_id: databaseId, schema: schemaDict }, { timeout: 60000 });
            if (tokenResponse.data?.success && Array.isArray(tokenResponse.data?.question_for_copying)) {
                backendTokens = tokenResponse.data.question_for_copying;
            }
        } catch (error) {
            console.warn('Rule-only tokenization failed; using local tokenization:', error);
        }
        const dbPath = String(message.selectedDb || '');
        const cvLink = dbPath && fs.existsSync(dbPath)
            ? await buildCvLinkFromLocalSQLite(message.text, dbPath, schemaDict, tables, backendTokens)
            : buildCvLinkFromSchemaValues(message.text, schemaDict, tables, backendTokens);
        const sessionResp = await axios.post(`${dalApiUrl}/api/v1/generate-prompt`, {
            question: message.text,
            database_id: databaseId,
            schema: schemaDict,
            cv_link: cvLink,
            k_shot: 0,
            user_fewshots: [],
            user_fewshot_count: 0,
            ...(backendTokens?.length ? { question_for_copying: backendTokens } : {})
        }, { timeout: 120000 });
        if (!sessionResp.data?.success || !sessionResp.data?.session_id) {
            throw new Error('Cannot initialize zero-shot validation session (no session_id): '
                + String(sessionResp.data?.error || 'invalid server response'));
        }
        const directPrompt = this._buildDirectPrompt(message);
        const provider = message.aiProvider === 'kimi' ? 'kimi' : 'copilot';
        const requestedModelId = provider === 'kimi' ? String(message.kimiModelId || 'kimi-k2.6')
            : String(message.copilotModelId || '');
        if (provider === 'copilot') {
            const models = message._batchModel ? [message._batchModel] : await this._selectCopilotModels(requestedModelId);
            if (!models.length) throw new Error('No Copilot model is available.');
            message._resolvedCopilotModel = models[0];
        }
        const actualModel = provider === 'copilot' ? message._resolvedCopilotModel.id : requestedModelId;
        if (timing) timing.model_id = actualModel;
        let prompt = directPrompt;
        let finalSql = '';
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            timing?.prompts?.push({
                stage: attempt === 1 ? 'direct' : 'correction', attempt, model_id: actualModel, prompt
            });
            if (timing) timing.attempts++;
            this._panel.webview.postMessage({ command: 'status',
                message: `Rule-only: ${provider} attempt ${attempt}/${maxAttempts}` });
            const response = await this._askModel(prompt, message, timing);
            const rawSql = response.replace(/^```(?:sql|sqlite|mysql|postgresql|postgres|pgsql)?\s*/i, '')
                .replace(/```\s*$/, '').trim();
            if (!rawSql) throw new Error('LLM returned empty SQL.');
            if (attempt === 1 && timing) timing.initial_sql = rawSql;
            if (timing) timing.validation_calls = (timing.validation_calls || 0) + 1;
            const validationResp = await axios.post(`${dalApiUrl}/api/v1/validate-sql`, {
                session_id: sessionResp.data.session_id,
                sql: rawSql,
                attempt,
                max_attempts: maxAttempts,
                schema: schemaDict,
                cv_link: cvLink,
                ...(backendTokens?.length ? { question_for_copying: backendTokens } : {})
            }, { timeout: 30000 });
            if (validationResp.data?.valid) {
                if (timing) timing.validation_passed = true;
                finalSql = String(validationResp.data.sql || rawSql);
                break;
            }
            if (timing) timing.validation_passed = false;
            if (validationResp.data?.next_prompt && attempt < maxAttempts) {
                // Backend-generated corrective prompts are preserved to test the
                // ORIGINAL rule-based module. Inspect .prompts.txt for any DAIL contamination.
                prompt = String(validationResp.data.next_prompt);
                if (timing) timing.correction_requests = (timing.correction_requests || 0) + 1;
            } else {
                finalSql = rawSql;
                break;
            }
        }
        return finalSql;
    }

    private async _generateSql(message: any, timing?: GenerationTiming): Promise<string> {
        const useDail = message.useServer !== false;
        const useRules = message.useRuleValidation !== false;
        if (!useDail) {
            return useRules ? this._generateSqlRuleOnly(message, timing)
                : this._generateSqlDirect(message, timing);
        }
        // Get the selected database identifier
        let databaseId = message.selectedDb || message.database || 'car_1';
        const providedSchema = Array.isArray(message.schema) ? (message.schema as SQLiteTable[]) : [];

        console.log('🔍 NL2SQL Panel Convert Request:');
        console.log('  - Selected DB (message.selectedDb):', message.selectedDb);
        console.log('  - Fallback DB (message.database):', message.database);
        console.log('  - Initial Database ID:', databaseId);
        console.log('  - Input text:', message.text);
        console.log('  - Schema tables count:', providedSchema.length);

        // 检测是否是文件路径（包含路径分隔符或.sqlite扩展名）
        const isFilePath = databaseId.includes('\\') || databaseId.includes('/') || 
                         databaseId.endsWith('.sqlite') || databaseId.endsWith('.db') || 
                         databaseId.endsWith('.sqlite3');

        // Prefer schema-only flow: build schema locally and avoid uploading sqlite to server.
        if (isFilePath) {
            databaseId = path.basename(databaseId, path.extname(databaseId));
        }

        let schemaDict: DailSchemaDict | null = null;
        let cvLink: CvLink | null = null;
        let backendTokens: string[] | undefined = undefined;
        if (providedSchema.length > 0) {
            schemaDict = buildDailSchemaFromTables(databaseId, providedSchema);
            this._panel.webview.postMessage({
                command: 'status',
                message: `✅ 使用本地提取 schema（${providedSchema.length} 张表）`
            });

            try {
                this._panel.webview.postMessage({
                    command: 'status',
                    message: '🔍 生成 CV Link 数据...'
                });

                // 1) Ask the backend for the exact token sequence used by DAIL-SQL.
                // This is now done for SQLite, MySQL, and PostgreSQL.
                try {
                    const dalConfig = vscode.workspace.getConfiguration('nl2sql');
                    const dalApiUrl = dalConfig.get<string>('dailsql.apiUrl') || 'http://localhost:8000';
                    const tokenizeResp = await axios.post(
                        `${dalApiUrl}/api/v1/tokenize`,
                        {
                            question: message.text,
                            database_id: databaseId,
                            schema: schemaDict
                        },
                        { timeout: 60000 }
                    );

                    if (tokenizeResp.data?.success && Array.isArray(tokenizeResp.data.question_for_copying)) {
                        backendTokens = tokenizeResp.data.question_for_copying;
                        console.log('✅ [tokenize] backend tokens obtained', backendTokens);
                    } else {
                        console.warn('⚠️ [tokenize] no backend tokens returned, fallback to frontend tokenize', tokenizeResp.data);
                    }
                } catch (tokenizeErr) {
                    console.warn('⚠️ [tokenize] failed to fetch backend tokens', tokenizeErr);
                }

                // 2) Preserve the original SQLite CV Link behavior.
                // For MySQL/PostgreSQL, use the sample values already loaded into
                // providedSchema[].columns[].values by the existing schema readers.
                let generatedCvLink: CvLink;
                if (isFilePath && message.selectedDb && fs.existsSync(message.selectedDb)) {
                    generatedCvLink = await buildCvLinkFromLocalSQLite(
                        message.text,
                        message.selectedDb,
                        schemaDict,
                        providedSchema,
                        backendTokens
                    );
                    console.log('✅ [cv_link] source: local SQLite lookup');
                } else {
                    generatedCvLink = buildCvLinkFromSchemaValues(
                        message.text,
                        schemaDict,
                        providedSchema,
                        backendTokens
                    );
                    console.log('✅ [cv_link] source: schema sample values', {
                        database_type: message.database,
                        database_id: databaseId
                    });
                }

                cvLink = generatedCvLink;
                this._panel.webview.postMessage({
                    command: 'status',
                    message: `✅ 已生成 cv_link：cell ${Object.keys(generatedCvLink.cell_match).length}，number/date ${Object.keys(generatedCvLink.num_date_match).length}`
                });
            } catch (err) {
                console.warn('Failed to build cv_link:', err);
                cvLink = null;
            }
        }

        // Legacy fallback: only upload sqlite if no schema is available.
        if (!schemaDict && isFilePath && message.selectedDb && fs.existsSync(message.selectedDb)) {
            console.log('🔍 Detected SQLite file path, uploading to DAIL-SQL server...');
            this._panel.webview.postMessage({ 
                command: 'status', 
                message: '正在上传数据库文件...' 
            });

            try {
                // Extract a clean database ID from the filename
                const fileName = path.basename(message.selectedDb, path.extname(message.selectedDb));
                console.log('  - Extracted filename:', fileName);

                // Upload the database file (or reuse existing one)
                const uploadedDbId = await uploadSQLiteToDailSQL(message.selectedDb, fileName);
                console.log('✅ Database ready. Database ID:', uploadedDbId);

                // Use the returned database ID instead of the file path
                databaseId = uploadedDbId;

                this._panel.webview.postMessage({ 
                    command: 'status', 
                    message: `数据库已就绪: ${uploadedDbId}` 
                });
            } catch (uploadError) {
                console.error('❌ Failed to prepare database:', uploadError);
                throw uploadError;
            }
        }

        console.log('  - Final Database ID for API:', databaseId);

        // ── NEW: Copilot-based pipeline ──────────────────────────────────
        // 1. Ask server to build the DAIL-SQL prompt
        const dalConfig = vscode.workspace.getConfiguration('nl2sql');
        const dalApiUrl = dalConfig.get<string>('dailsql.apiUrl') || 'http://localhost:8000';

        this._panel.webview.postMessage({ command: 'status', message: '🔄 Generating prompt from server...' });

        // Get few-shot counts from webview message (source of truth)
        const rawHistoryCount = Number(message.historyFewShotCount);
        const rawGeneralCount = Number(message.generalFewShotCount);
        const history_count = Number.isFinite(rawHistoryCount) ? Math.max(0, Math.min(10, rawHistoryCount)) : 1;
        const general_count = Number.isFinite(rawGeneralCount) ? Math.max(0, Math.min(10, rawGeneralCount)) : 3;
        console.log('🎯 [DEBUG] Few-shot counts from message:', {
            history_count,
            general_count,
            rawHistoryCount: message.historyFewShotCount,
            rawGeneralCount: message.generalFewShotCount
        });

        const generatePromptPayload: any = {
            question: message.text,
            database_id: databaseId,
            k_shot: general_count
        };

        const userFewShotPool = message._batchFewShotPool || this._loadUserFewShotPool();
        console.log('🎯 [DEBUG] User few-shot pool status:', { 
            pool_size: userFewShotPool.length,
            history_count,
            general_count
        });

        // IMPORTANT: Always send user_fewshot_count even if pool is empty
        // Backend needs this to know user's preference
        if (history_count > 0 || userFewShotPool.length > 0) {
            generatePromptPayload.user_fewshots = userFewShotPool;
            generatePromptPayload.user_fewshot_count = history_count;
            console.log('📚 Include user few-shot in request', {
                total_pool: userFewShotPool.length,
                requested_count: history_count,
                general_count,
                database_id: databaseId
            });
        } else {
            console.log('⊘ User few-shot count is 0, skipping user fewshots');
        }
        if (schemaDict) {
            generatePromptPayload.schema = schemaDict;
        }

        if (cvLink) {
            generatePromptPayload.cv_link = cvLink;
            console.log('🔍 [cv_link] sending to server', {
                num_date_match_count: Object.keys(cvLink.num_date_match).length,
                cell_match_count: Object.keys(cvLink.cell_match).length,
                cvLink,
                generatePromptPayload
            });
        } else {
            console.warn('⚠️ [cv_link] missing from frontend, cvLink = null');
        }

        if (backendTokens && backendTokens.length > 0) {
            generatePromptPayload.question_for_copying = backendTokens;
            console.log('🔧 [tokenization] include question_for_copying in generate-prompt payload', backendTokens);
        }

        const promptResp = await axios.post(
            `${dalApiUrl}/api/v1/generate-prompt`,
            generatePromptPayload,
            { timeout: 120000 }
        );

        if (!promptResp.data?.success) {
            throw new Error(promptResp.data?.error || 'Server failed to generate prompt');
        }

        const selectedExamples = Array.isArray(promptResp.data?.debug_info?.selected_examples)
            ? promptResp.data.debug_info.selected_examples
            : [];
        if (!message._batchTiming) {
            await this._incrementFewShotCallCounts(selectedExamples);
        }

        const dalSessionId: string = promptResp.data.session_id;
        let copilotPrompt: string = promptResp.data.prompt;

        // 2. The prompt-generation pipeline is provider independent.
        const provider = message.aiProvider === 'kimi' ? 'kimi' : 'copilot';
        const selectedModelId = provider === 'kimi' ? String(message.kimiModelId || 'kimi-k2.6')
            : String(message.copilotModelId || '');
        if (provider === 'copilot') {
            const models = message._batchModel ? [message._batchModel] : await this._selectCopilotModels(selectedModelId);
            if (!models.length) throw new Error('No Copilot model is available.');
            message._resolvedCopilotModel = models[0];
        }
        const actualSelectedModelId = provider === 'copilot' ? message._resolvedCopilotModel.id : selectedModelId;
        if (timing) timing.model_id = actualSelectedModelId;

        // 3. Generation + validation loop
        const maxAttempts = 3;
        let finalSql = '';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            this._panel.webview.postMessage({
                command: 'status',
                message: `Asking ${provider} (${actualSelectedModelId}) - attempt ${attempt}/${maxAttempts}...`
            });

            let rawSql = '';

            // Full prompt log for the actual Copilot generation request.
            // On retry attempts this also shows the corrective prompt returned by the server,
            // because copilotPrompt is replaced with validateResp.data.next_prompt below.
            console.log(`\n========== LLM GENERATION PROMPT [attempt ${attempt}/${maxAttempts}] ==========`);
            console.log(`Provider: ${provider}; Model: ${actualSelectedModelId}`);
            console.log(`Prompt length: ${copilotPrompt.length} characters`);
            console.log(copilotPrompt);
            console.log('========== END LLM GENERATION PROMPT ==========\n');

            timing?.prompts?.push({
                stage: attempt === 1 ? 'generation' : 'correction', attempt, model_id: actualSelectedModelId, prompt: copilotPrompt
            });
            if (timing) timing.attempts++;
            rawSql = await this._askModel(copilotPrompt, message, timing);

            console.log(`Raw LLM response (attempt ${attempt}):`, rawSql.substring(0, 200));

            // Strip markdown code fences that Copilot often adds (e.g. ```sql ... ```)
            rawSql = rawSql.replace(/^```(?:sql)?\s*/i, '').replace(/```\s*$/, '').trim();
            if (!rawSql) throw new Error('LLM returned empty SQL.');
            if (attempt === 1 && timing) timing.initial_sql = rawSql;
            // DAIL-only ablation uses exactly one generation with NO validation call.
            if (!useRules) {
                finalSql = rawSql;
                break;
            }

            // 4. Send SQL to server for validation
            this._panel.webview.postMessage({
                command: 'status',
                message: `🔍 Validating SQL (attempt ${attempt}/${maxAttempts})...`
            });

            if (timing) timing.validation_calls = (timing.validation_calls || 0) + 1;
            const validateResp = await axios.post(
                `${dalApiUrl}/api/v1/validate-sql`,
                {
                    session_id: dalSessionId,
                    sql: rawSql,
                    attempt: attempt,
                    max_attempts: maxAttempts,
                    ...(schemaDict ? { schema: schemaDict } : {}),
                    ...(cvLink ? { cv_link: cvLink } : {}),
                    ...(backendTokens && backendTokens.length > 0 ? { question_for_copying: backendTokens } : {})
                },
                { timeout: 30000 }
            );

            if (validateResp.data?.valid) {
                if (timing) timing.validation_passed = true;
                finalSql = validateResp.data.sql || rawSql;
                console.log('✅ SQL validation passed on attempt', attempt);
                break;
            } else if (validateResp.data?.next_prompt && attempt < maxAttempts) {
                if (timing) {
                    timing.validation_passed = false;
                    timing.correction_requests = (timing.correction_requests || 0) + 1;
                }
                // Server returned a corrective prompt – use it for the next LLM call
                copilotPrompt = validateResp.data.next_prompt;
                this._panel.webview.postMessage({
                    command: 'status',
                    message: `SQL invalid, sending correction prompt to ${provider}...`
                });
            } else {
                if (timing) timing.validation_passed = false;
                // No more retries or no next_prompt – use best-effort result
                finalSql = rawSql;
                console.warn('⚠️ SQL validation failed, using best-effort result');
                break;
            }
        }

        // 5. DAIL-SQL / validation produces canonical SQLite SQL.
        //    For MySQL/PostgreSQL, make one additional Copilot call that only
        //    converts SQL dialect. This second call is intentionally NOT sent
        //    back to the server validation/correction loop.
        let outputSql = finalSql;
        const targetDbType = String(message.database || '').toLowerCase();

        if (finalSql && (targetDbType === 'mysql' || targetDbType === 'postgresql')) {
            const targetDialectName = targetDbType === 'mysql' ? 'MySQL' : 'PostgreSQL';

            this._panel.webview.postMessage({
                command: 'status',
                message: `🔄 Converting final SQLite SQL to ${targetDialectName} dialect...`
            });

            const identifierQuotingRules =
                targetDbType === 'postgresql'
                    ? [
                        '- Treat every table name, column name, and alias in the input SQL as a case-sensitive database identifier.',
                        '- Preserve the exact spelling and capitalization of every identifier.',
                        '- Quote every table name, column name, and alias using PostgreSQL double quotes (").',
                        '- Do not quote SQL keywords, SQL operators, built-in SQL functions, numeric values, or string literals.',
                        "- Escape a single quote inside a string literal using two single quotes ('').",
                    ]
                    : [
                        '- Treat every table name, column name, and alias in the input SQL as a database identifier.',
                        '- Preserve the exact spelling and capitalization of every identifier.',
                        '- Quote every table name, column name, and alias using MySQL backticks (`).',
                        '- Do not quote SQL keywords, SQL operators, built-in SQL functions, numeric values, or string literals.',
                        "- Escape single quotes inside string literals according to valid MySQL SQL syntax.",
                    ];

            const dialectPrompt = [
                `Convert the following SQLite SQL query to valid ${targetDialectName} SQL.`,
                '',
                'Requirements:',
                '- Preserve the exact query semantics.',
                ...identifierQuotingRules,
                `- Convert SQLite-specific syntax and functions to valid ${targetDialectName} equivalents.`,
                '- Do not invent, rename, add, or remove tables or columns.',
                '- Do not change joins, filters, grouping, ordering, limits, or business logic.',
                '- Return SQL only.',
                '- Do not use Markdown code fences.',
                '- Do not explain the conversion.',
                '',
                'SQLite SQL:',
                finalSql
            ].join('\n');

            let convertedSql = '';

            // Full prompt log for the second Copilot call that performs dialect conversion.
            console.log(`\n========== LLM DIALECT PROMPT [SQLite -> ${targetDialectName}] ==========`);
            console.log(`Provider: ${provider}; Model: ${actualSelectedModelId}`);
            console.log(`Prompt length: ${dialectPrompt.length} characters`);
            console.log(dialectPrompt);
            console.log('========== END LLM DIALECT PROMPT ==========\n');

            timing?.prompts?.push({ stage: 'dialect_conversion', attempt: 1, model_id: actualSelectedModelId, prompt: dialectPrompt });
            convertedSql = await this._askModel(dialectPrompt, message, timing);

            // Copilot may still wrap SQL in a Markdown fence despite the prompt.
            convertedSql = convertedSql
                .replace(/^```(?:sql|mysql|postgresql|postgres|pgsql)?\s*/i, '')
                .replace(/```\s*$/, '')
                .trim();

            if (!convertedSql) {
                throw new Error(`Copilot returned an empty ${targetDialectName} dialect conversion.`);
            }

            outputSql = convertedSql;
            console.log(`✅ Dialect conversion completed: SQLite -> ${targetDialectName}`);
            console.log('📝 Canonical SQLite SQL:', finalSql);
            console.log(`📝 ${targetDialectName} SQL:`, outputSql);
        }

        return outputSql;
    }

    private async _runSpiderBatch(message: any): Promise<void> {
        const questionFile = String.raw`C:\Users\grizz\OneDrive\Desktop\COSC448\ideas\model\DAIL-SQL\dataset\spider\dev.json`;
        const databaseRoot = String.raw`C:\Users\grizz\OneDrive\Desktop\COSC448\ideas\model\DAIL-SQL\dataset\spider\database`;
        const datasetBytes = await fs.promises.readFile(questionFile);
        const raw: any = JSON.parse(datasetBytes.toString('utf8'));
        if (!Array.isArray(raw) || raw.length === 0) throw new Error('Expected a non-empty Spider JSON array.');
        const questions = raw.map((item: any, index: number) => {
            if (!item || typeof item.question !== 'string' || !item.question.trim()
                || typeof item.db_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(item.db_id)) {
                throw new Error('Invalid question or db_id at index ' + index);
            }
            return { question: item.question, db_id: item.db_id };
        });
        const countInput = await vscode.window.showInputBox({
            title: 'Spider batch timing', prompt: 'Number of questions from the start (0 = all)', value: '0',
            validateInput: value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
                ? null : 'Enter a non-negative integer.'
        });
        if (countInput === undefined) return;
        const count = Number(countInput) === 0 ? questions.length : Math.min(Number(countInput), questions.length);
        const aiProvider = message.aiProvider === 'kimi' ? 'kimi' : 'copilot';
        const requestedId = aiProvider === 'kimi' ? String(message.kimiModelId || '').trim()
            : String(message.copilotModelId || '');
        if (aiProvider === 'kimi' && !(await this._context.secrets.get('kimi-api-key'))) {
            throw new Error('Configure the Kimi API key before starting a batch.');
        }
        if (aiProvider === 'kimi' && !requestedId) throw new Error('Enter a Kimi model ID.');
        const models = aiProvider === 'kimi' ? [] : await this._selectCopilotModels(requestedId);
        if (aiProvider === 'copilot' && !models.length) throw new Error('No Copilot model is available.');
        const model: vscode.LanguageModelChat | undefined = models[0];
        const modelId = aiProvider === 'kimi' ? requestedId : model!.id;
        const kimiBaseUrl = aiProvider === 'kimi' ? this._validatedKimiUrl(String(message.kimiBaseUrl || 'https://api.moonshot.cn/v1')) : null;
        const kimiRequestOptions = aiProvider === 'kimi' ? this._getKimiRequestOptions(message, modelId) : null;
        const kimiThinking = aiProvider === 'kimi' && modelId === 'kimi-k2.6' ? kimiRequestOptions!.thinking : null;
        const kimiReasoningEffort = aiProvider === 'kimi' && /^kimi-k3(?:\.|$)/i.test(modelId)
            ? kimiRequestOptions!.reasoningEffort : null;
        const clampShots = (value: any, fallback: number) => Number.isFinite(Number(value))
            ? Math.max(0, Math.min(10, Math.trunc(Number(value)))) : fallback;
        const useServer = message.useServer !== false;
        const useRuleValidation = message.useRuleValidation !== false;
        const generationMode = this._getAblationMode(useServer, useRuleValidation);
        const historyCount = useServer ? clampShots(message.historyFewShotCount, 1) : 0;
        const generalCount = useServer ? clampShots(message.generalFewShotCount, 3) : 0;
        const userFewShotPool = useServer ? this._loadUserFewShotPool() : [];
        const config = {
            format_version: 6,
            prompt_log_format: 1,
            use_server: useServer,
            use_dail_prompt: useServer,
            use_rule_validation: useRuleValidation,
            generation_mode: generationMode,
            direct_prompt_version: useServer ? null : 2,
            dataset_sha256: createHash('sha256').update(datasetBytes).digest('hex'),
            database_root: databaseRoot,
            ai_provider: aiProvider,
            model_id: modelId,
            kimi_base_url: kimiBaseUrl,
            kimi_thinking: kimiThinking,
            kimi_reasoning_effort: kimiReasoningEffort,
            kimi_request_options: kimiRequestOptions?.bodyOptions ?? null,
            kimi_timeout_ms: kimiRequestOptions?.timeoutMs ?? null,
            kimi_http_retries: kimiRequestOptions?.retryCount ?? null,
            history_few_shots: historyCount,
            general_few_shots: generalCount,
            few_shot_pool_sha256: useServer ? createHash('sha256').update(JSON.stringify(userFewShotPool)).digest('hex') : null,
            backend_url: (useServer || useRuleValidation)
                ? (vscode.workspace.getConfiguration('nl2sql').get<string>('dailsql.apiUrl') || 'http://localhost:8000') : null,
            max_attempts: useRuleValidation ? 3 : 1,
            ablation_notes: generationMode === 'rule_only'
                ? 'DAIL prompt not sent to LLM; zero-shot backend session is initialized solely for validation. Its next_prompt may contain backend prompt structure.'
                : null,
            timing_scope: 'schema loading through final SQL; includes rule validation and retries iff enabled; excludes file writes'
        };
        const outputDirectory = this._getResultDirectory(useServer, aiProvider, useRuleValidation, modelId);
        const outputBase = generationMode === 'full' ? 'spider_timing'
            : generationMode === 'direct' ? 'spider_timing_direct' : 'spider_timing_' + generationMode;
        let resultFile = path.join(outputDirectory, outputBase + '.jsonl');
        // Keep prior results when a different model/dataset/prompt configuration is used.
        if (fs.existsSync(resultFile)) {
            let sameConfig = false;
            try {
                const savedConfig = JSON.parse(await fs.promises.readFile(resultFile + '.config.json', 'utf8'));
                sameConfig = JSON.stringify(savedConfig) === JSON.stringify(config);
            } catch { /* Preserve an existing file with missing or unreadable configuration. */ }
            if (!sameConfig) {
                const configurationId = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12);
                resultFile = path.join(outputDirectory, outputBase + '_' + configurationId + '.jsonl');
            }
        }
        const configFile = resultFile + '.config.json';
        const csvFile = resultFile.replace(/\.jsonl$/i, '') + '.csv';
        const promptFile = resultFile.replace(/\.jsonl$/i, '') + '.prompts.txt';
        if ([questionFile, configFile, csvFile].some(file => path.resolve(file) === path.resolve(resultFile))
            || [configFile, csvFile].some(file => path.resolve(file) === path.resolve(questionFile))) {
            throw new Error('Choose an output file different from the input and sidecar files.');
        }
        await fs.promises.mkdir(path.dirname(resultFile), { recursive: true });
        const rows: any[] = [];
        const completed = new Set<number>();
        if (fs.existsSync(resultFile)) {
            if (!fs.existsSync(configFile)) throw new Error('Existing output has no configuration. Choose a new filename.');
            const previousConfig = JSON.parse(await fs.promises.readFile(configFile, 'utf8'));
            if (JSON.stringify(previousConfig) !== JSON.stringify(config)) {
                throw new Error('Dataset, model or settings changed. Choose a new output filename.');
            }
            const saved = await fs.promises.readFile(resultFile, 'utf8');
            const lines = saved.split('\n');
            // Recover only an interrupted final write. Never silently discard interior corruption.
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                if (!lines[lineIndex].trim()) continue;
                let row: any;
                try { row = JSON.parse(lines[lineIndex]); }
                catch (error) {
                    if (lineIndex === lines.length - 1 && !saved.endsWith('\n')) {
                        await fs.promises.writeFile(resultFile, lines.slice(0, lineIndex).join('\n') + (lineIndex > 0 ? '\n' : ''));
                        break;
                    }
                    throw new Error('Invalid timing JSONL at line ' + (lineIndex + 1));
                }
                const item = questions[row.index];
                if (!Number.isInteger(row.index) || !item || row.question !== item.question || row.db_id !== item.db_id
                    || !['completed', 'error'].includes(row.status) || completed.has(row.index)
                    || !Number.isFinite(row.total_ms) || row.total_ms < 0) {
                    throw new Error('Invalid timing record at line ' + (lineIndex + 1));
                }
                rows.push(row);
                completed.add(row.index);
            }
            if (saved.trim() && !saved.endsWith('\n') && rows.length === lines.filter(line => line.trim()).length) {
                await fs.promises.appendFile(resultFile, '\n');
            }
        } else {
            await fs.promises.writeFile(configFile, JSON.stringify(config, null, 2), { flag: 'wx' });
            await fs.promises.writeFile(resultFile, '', { flag: 'wx' });
        }
        // For Kimi, errors are retryable on the next run without erasing successful rows.
        // The old prompt log is retained for investigating failed requests.
        if (aiProvider === 'kimi' && rows.some(row => row.status === 'error')) {
            const successful = rows.filter(row => row.status === 'completed');
            rows.splice(0, rows.length, ...successful);
            completed.clear();
            for (const row of rows) completed.add(row.index);
            await fs.promises.writeFile(resultFile,
                rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
        }
        const columns = ['index', 'db_id', 'question', 'status', 'use_server', 'generation_mode', 'started_at', 'finished_at',
            'total_ms', 'schema_ms', 'copilot_ms', 'llm_ms', 'attempts', 'api_request_attempts', 'model_id', 'ai_provider',
            'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'actual_model_id',
            'use_rule_validation', 'initial_sql', 'validation_calls', 'correction_requests', 'validation_passed', 'sql', 'error'];
        const saveCsv = async () => {
            const escape = (value: any) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
            const text = '\uFEFF' + columns.join(',') + '\r\n' + rows.map(row =>
                columns.map(key => escape(row[key])).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
            await fs.promises.writeFile(csvFile, text, 'utf8');
        };
        await saveCsv();
        // Append actual requests before committing the matching timing row.
        // If interrupted between writes, the log retains the attempted requests.
        await fs.promises.appendFile(promptFile, '', 'utf8');
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification, title: 'Spider batch timing (' + generationMode + ')', cancellable: true
        }, async (progress, cancellation) => {
            const stopListener = cancellation.onCancellationRequested(() => { this._stopBatchRequested = true; });
            try {
                for (let index = 0; index < count; index++) {
                    if (this._stopBatchRequested || cancellation.isCancellationRequested) break;
                    if (completed.has(index)) continue;
                    const item = questions[index];
                    progress.report({ message: String(index + 1) + '/' + count + ' (' + item.db_id + ')' });
                    const timing: GenerationTiming = { copilot_ms: 0, attempts: 0, model_id: modelId, prompts: [] };
                    const startedAt = new Date().toISOString();
                    const started = performance.now();
                    let schemaMs = 0;
                    let sql = '';
                    let errorMessage = '';
                    let status = 'completed';
                    try {
                        const dbFile = path.join(databaseRoot, item.db_id, item.db_id + '.sqlite');
                        await fs.promises.access(dbFile, fs.constants.R_OK);
                        const schemaStarted = performance.now();
                        let schema: SQLiteTable[];
                        try { schema = await readSQLiteSchema(dbFile); }
                        finally { schemaMs = performance.now() - schemaStarted; }
                        if (!schema.length) throw new Error('Database schema is empty: ' + dbFile);
                        sql = await this._generateSql({
                            text: item.question, database: 'sqlite', selectedDb: dbFile, schema,
                            aiProvider, copilotModelId: modelId, kimiModelId: modelId, kimiBaseUrl,
                            kimiThinking: kimiRequestOptions?.thinking,
                            kimiReasoningEffort: kimiRequestOptions?.reasoningEffort,
                            kimiMaxCompletionTokens: message.kimiMaxCompletionTokens,
                            kimiTimeoutMs: kimiRequestOptions?.timeoutMs,
                            kimiRetryCount: kimiRequestOptions?.retryCount,
                            kimiCacheTtl: message.kimiCacheTtl,
                            kimiStopSequences: message.kimiStopSequences,
                            useServer, useRuleValidation,
                            historyFewShotCount: historyCount, generalFewShotCount: generalCount,
                            _batchTiming: true, _batchModel: model, _batchFewShotPool: userFewShotPool
                        }, timing);
                        if (!sql.trim()) throw new Error('No SQL returned.');
                    } catch (error) {
                        status = 'error';
                        errorMessage = error instanceof Error ? error.message : String(error);
                    }
                    const round = (value: number) => Math.round(value * 1000) / 1000;
                    const row = {
                        index, db_id: item.db_id, question: item.question, status,
                        use_server: useServer, use_rule_validation: useRuleValidation, generation_mode: generationMode,
                        started_at: startedAt, finished_at: new Date().toISOString(),
                        total_ms: round(performance.now() - started), schema_ms: round(schemaMs),
                        copilot_ms: round(timing.copilot_ms), llm_ms: round(timing.copilot_ms), attempts: timing.attempts,
                        api_request_attempts: timing.api_request_attempts || 0,
                        model_id: timing.model_id, ai_provider: aiProvider,
                        prompt_tokens: timing.prompt_tokens ?? null,
                        completion_tokens: timing.completion_tokens ?? null,
                        total_tokens: timing.total_tokens ?? null,
                        cached_tokens: timing.cached_tokens ?? null,
                        actual_model_id: timing.actual_model_id || '',
                        initial_sql: timing.initial_sql || '',
                        validation_calls: timing.validation_calls || 0,
                        correction_requests: timing.correction_requests || 0,
                        validation_passed: timing.validation_passed ?? null,
                        sql, error: errorMessage
                    };
                    await fs.promises.appendFile(promptFile, this._formatPromptLog(row, timing.prompts || []), 'utf8');
                    await fs.promises.appendFile(resultFile, JSON.stringify(row) + '\n', 'utf8');
                    rows.push(row);
                    completed.add(index);
                    await saveCsv();
                    progress.report({ increment: 100 / count,
                        message: String(index + 1) + '/' + count + ', ' + (row.total_ms / 1000).toFixed(2) + ' s' });
                    this._panel.webview.postMessage({ command: 'result',
                        sql: sql || '-- Runtime error: ' + errorMessage });
                    if (aiProvider === 'kimi' && /Kimi API (401|402|403|429)|key is missing/i.test(errorMessage)) {
                        vscode.window.showWarningMessage('Kimi batch stopped after an API authentication, quota, or rate-limit error: ' + errorMessage);
                        this._stopBatchRequested = true;
                        break;
                    }
                }
            } finally { stopListener.dispose(); }
        });
        const finished = rows.filter(row => row.index < count).length;
        const suffix = this._stopBatchRequested ? 'Stopped after saving the current question.' : 'Batch finished.';
        vscode.window.showInformationMessage(suffix + ' Saved ' + finished + '/' + count + ' records to ' + resultFile);
    }

    private _loadUserFewShotPool(): UserFewShotRecord[] {
        try {
            const storagePath = this._context.globalStorageUri.fsPath;
            const poolFile = path.join(storagePath, 'fewshot_pool.json');
            if (!fs.existsSync(poolFile)) {
                return [];
            }

            const content = fs.readFileSync(poolFile, 'utf8');
            const raw = content ? JSON.parse(content) : [];
            if (!Array.isArray(raw)) {
                return [];
            }

            return raw
                .filter((item: any) => item && typeof item === 'object')
                .map((item: any) => ({
                    index: Number(item.index) || undefined,
                    nlq: String(item.nlq || ''),
                    sql: String(item.sql || ''),
                    db_id: String(item.db_id || item.database_id || item.database || ''),
                    created_at: item.created_at ? String(item.created_at) : undefined,
                    embedding: Array.isArray(item.embedding) ? item.embedding : undefined,
                    call_count: Math.max(0, Number(item.call_count) || 0),
                }))
                .filter((item: UserFewShotRecord) => item.nlq.trim().length > 0 && item.sql.trim().length > 0 && item.db_id.trim().length > 0);
        } catch (error) {
            console.warn('Failed to load user few-shot pool from global storage:', error);
            return [];
        }
    }

    private async _incrementFewShotCallCounts(selectedExamples: any[]): Promise<void> {
        try {
            if (!Array.isArray(selectedExamples) || selectedExamples.length === 0) {
                return;
            }

            const selectedUserExamples = selectedExamples.filter((example: any) => example?.source === 'user_memory');
            if (selectedUserExamples.length === 0) {
                return;
            }

            const storagePath = this._context.globalStorageUri.fsPath;
            const poolFile = path.join(storagePath, 'fewshot_pool.json');
            if (!fs.existsSync(poolFile)) {
                return;
            }

            const content = fs.readFileSync(poolFile, 'utf8');
            const pool: any[] = content ? JSON.parse(content) : [];
            if (!Array.isArray(pool) || pool.length === 0) {
                return;
            }

            let updatedCount = 0;
            for (const selected of selectedUserExamples) {
                const selectedIndex = Number(selected?.user_index);
                const selectedNlq = String(selected?.question || '').trim();
                const selectedSql = String(selected?.query || '').trim();

                const matched = pool.find((item: any) => {
                    if (Number.isFinite(selectedIndex) && selectedIndex > 0 && Number(item?.index) === selectedIndex) {
                        return true;
                    }
                    return String(item?.nlq || '').trim() === selectedNlq && String(item?.sql || '').trim() === selectedSql;
                });

                if (matched) {
                    matched.call_count = Math.max(0, Number(matched.call_count) || 0) + 1;
                    updatedCount += 1;
                }
            }

            if (updatedCount > 0) {
                fs.writeFileSync(poolFile, JSON.stringify(pool, null, 2), 'utf8');
                console.log('📈 Updated few-shot call counts', { updatedCount });
            }
        } catch (error) {
            console.warn('Failed to update few-shot call counts:', error);
        }
    }

    public dispose() {
        this._stopBatchRequested = true;
        NL2SQLPanel.currentPanel = undefined;

        // Clean up resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NL2SQL Converter</title>
    <style>
        /* Preserve VS Code theme colors and keep both panels scrollable. */
        :root {
            --nl-bg: var(--vscode-editor-background, #1e1e1e);
            --nl-card: var(--vscode-sideBar-background, #252526);
            --nl-inner: var(--vscode-input-background, #1e1e1e);
            --nl-fg: var(--vscode-foreground, #e7e7e7);
            --nl-muted: var(--vscode-descriptionForeground, #a9a9a9);
            --nl-line: var(--vscode-panel-border, #454545);
            --nl-primary: var(--vscode-button-background, #0e639c);
            --nl-primary-fg: var(--vscode-button-foreground, #fff);
            --nl-hover: var(--vscode-list-hoverBackground, #33363a);
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; height: 100%; }
        body {
            font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
            background: var(--nl-bg); color: var(--nl-fg);
            overflow: hidden; padding: 14px;
            font-size: 13px;
        }
        button, input, select, textarea { font: inherit; }
        button { cursor: pointer; }
        .workspace-layout {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: 14px; height: 100%; min-height: 0;
        }
        .left-panel, .right-panel {
            display: flex; flex-direction: column; gap: 12px;
            min-width: 0; min-height: 0; overflow-y: auto;
            scrollbar-width: thin;
        }
        .card, .model-card-container, .output-card {
            border: 1px solid var(--nl-line); border-radius: 10px;
            background: var(--nl-card); padding: 14px;
            min-width: 0;
        }
        h3, h4, p { margin: 0; }
        .card h3, .model-card-container h3, .output-card h3 {
            font-size: 15px; line-height: 1.3; font-weight: 650;
        }
        .card h4, .model-card-container h4 { font-size: 13px; font-weight: 600; }
        .card-heading { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
        .help-text { color: var(--nl-muted); font-size: 12px; line-height: 1.45; }
        .section-title { margin-bottom: 12px; }
        .section-title .help-text { margin-top: 4px; }
        label { display: block; color: var(--nl-fg); font-size: 12px; }
        select, input[type="text"], input[type="number"], textarea {
            border: 1px solid var(--vscode-input-border, var(--nl-line));
            background: var(--nl-inner); color: var(--nl-fg);
            border-radius: 6px; outline: none;
        }
        select, input[type="text"] { width: 100%; min-height: 35px; padding: 7px 10px; }
        select:focus, input:focus, textarea:focus { border-color: var(--vscode-focusBorder, #007fd4); }
        select:disabled, button:disabled { cursor: not-allowed; opacity: .55; }
        input[type="checkbox"] { accent-color: var(--nl-primary); }
        .db-row-container { display: grid; grid-template-columns: minmax(0, .6fr) minmax(0, 1.4fr); gap: 12px; }
        .db-engine-card, .db-select-card { min-width: 0; }
        .db-row-container h3 { margin-bottom: 7px; }
        .db-row-container .help-text { margin-bottom: 10px; }
        /* Keep the database field and its two everyday actions on a single row. */
        .db-selection-row {
            display: flex; align-items: stretch; gap: 8px;
            min-width: 0;
        }
        .database-search { position: relative; flex: 1 1 auto; min-width: 0; }
        .db-selection-row .database-search input { height: 35px; min-height: 35px; }
        .db-selection-row .db-actions .db-btn { height: 35px; min-height: 35px; white-space: nowrap; }
        /* All database actions, including engine-specific Config, live beside the search field. */
        .db-select-card { container-type: inline-size; }
        @container (max-width: 370px) {
            .db-selection-row { flex-wrap: wrap; }
            .db-selection-row .database-search { flex-basis: 100%; }
        }
        .database-dropdown {
            position: absolute; display: none; z-index: 100;
            top: calc(100% + 3px); left: 0; right: 0;
            max-height: 220px; overflow-y: auto;
            background: var(--vscode-dropdown-background, #252526);
            border: 1px solid var(--nl-line); border-radius: 7px;
            box-shadow: 0 8px 20px #0004;
        }
        .database-option { padding: 9px 11px; cursor: pointer; overflow-wrap: anywhere; }
        .database-option:hover, .database-option.selected { background: var(--nl-hover); }
        .db-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: stretch; gap: 6px; margin: 0; }
        .db-actions .db-btn { padding-inline: 10px; }
        .db-btn, .clear-btn, .convert-btn {
            display: inline-flex; justify-content: center; align-items: center;
            border-radius: 6px; padding: 8px 10px;
            border: 1px solid var(--vscode-button-border, var(--nl-line));
            color: var(--nl-fg); background: var(--vscode-button-secondaryBackground, #353535);
            min-height: 34px; font-weight: 500;
        }
        .db-btn:hover, .clear-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #454545); }
        .db-btn.primary, .convert-btn { background: var(--nl-primary); color: var(--nl-primary-fg); border-color: transparent; }
        .db-btn.primary:hover, .convert-btn:hover { background: var(--vscode-button-hoverBackground, #1177ba); }
        .model-config-row { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1fr) minmax(0, 1.12fr); gap: 10px; }
        .model-card, .fewshot-setting-card {
            background: var(--nl-inner); border: 1px solid var(--nl-line);
            border-radius: 8px; padding: 12px; min-width: 0;
        }
        .model-card h4, .fewshot-setting-card h4 { margin-bottom: 12px; }
        .model-card label:not(.checkbox-line) { margin: 8px 0 6px; }
        .model-card label:first-child { margin-top: 0; }
        .model-card select { width: 100%; }
        .model-card input[type="text"] { width: 100% !important; }
        .model-card p, .fewshot-setting-card p { color: var(--nl-muted); line-height: 1.45; font-size: 12px; }
        .settings-accordion { border: 1px solid var(--nl-line); border-radius: 6px; margin-top: 10px; }
        .settings-accordion summary { padding: 10px; cursor: pointer; user-select: none; font-weight: 550; }
        .settings-accordion[open] summary { border-bottom: 1px solid var(--nl-line); }
        .settings-content { padding: 8px 10px 12px; }
        .settings-content > label { margin: 10px 0 6px !important; }
        .settings-content input, .settings-content textarea { max-width: 100%; }
        .settings-content textarea { min-height: 70px; }
        .settings-content pre { max-width: 100%; overflow: auto; }
        .setting-placeholder { line-height: 1.6; color: var(--nl-muted); font-size: 12px; }
        .checkbox-line {
            display: flex; align-items: flex-start; gap: 8px;
            padding: 8px 0; line-height: 1.35; cursor: pointer;
        }
        .checkbox-line input { margin: 2px 0 0; flex: none; }
        .checkbox-line + .checkbox-line { border-top: 1px solid var(--nl-line); }
        #serverModeDescription {
            margin: 10px 0 12px; padding: 9px;
            border-radius: 5px; background: var(--nl-card);
            font-size: 11px; color: var(--nl-muted); line-height: 1.5;
        }
        .fewshot-setting-card { padding: 10px; }
        #fewshotConfig { border-top: 1px solid var(--nl-line); padding-top: 10px; }
        .fewshot-controls { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
        .fewshot-control-group { display: flex; align-items: center; gap: 8px; }
        .fewshot-control-group label { flex: 1; min-width: 0; font-size: 12px; }
        .fewshot-control-group input[type="number"] { width: 54px; text-align: center; padding: 6px; }
        .fewshot-label { color: var(--nl-muted); font-size: 11px; }
        #dbDetailCard {
            display: flex; flex-direction: column; flex: 1 0 285px;
            min-height: 285px; overflow: hidden;
        }
        .db-detail-subtitle {
            display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
            gap: 10px; background: var(--nl-inner); border-radius: 6px;
            padding: 9px 11px; margin-bottom: 11px; font-size: 12px;
        }
        #selectedDbName { font-weight: 600; overflow-wrap: anywhere; }
        #dbEngineBadge { font-size: 11px; color: var(--nl-muted); }
        .db-detail-container { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
        .db-detail-tables {
            display: flex; flex-wrap: wrap; gap: 6px;
            border: 1px solid var(--nl-line); border-radius: 6px;
            padding: 8px; max-height: 105px; overflow: auto;
            background: var(--nl-inner); min-height: 41px;
        }
        .db-detail-table-item {
            cursor: pointer; padding: 7px 10px; border-radius: 5px;
            color: var(--nl-fg); border: 1px solid var(--nl-line);
            font-size: 12px; white-space: nowrap;
        }
        .db-detail-table-item:hover { background: var(--nl-hover); }
        .db-detail-table-item.selected {
            background: var(--vscode-list-activeSelectionBackground, #094771);
            color: var(--vscode-list-activeSelectionForeground, #fff);
        }
        .db-detail-info {
            display: flex; flex-direction: column; flex: 1; min-height: 0;
            padding: 10px; border: 1px solid var(--nl-line);
            background: var(--nl-inner); border-radius: 6px; overflow: hidden;
        }
        /* Database preview: show column metadata once, in the sticky table header. */
        .db-preview-table thead th { vertical-align: middle; }
        .db-preview-table thead th.db-preview-pk {
            /* color-mix produces an opaque background, so scrolling rows never show through. */
            background-color: color-mix(in srgb,
                var(--vscode-editorWidget-background, #252526) 89%,
                var(--vscode-charts-blue, #75beff) 11%);
        }
        .db-preview-meta { color: var(--nl-muted); font-size: 11px; font-weight: 400; }
        .db-preview-key {
            display: inline-block; padding: 1px 4px; border-radius: 3px;
            font-size: 10px; font-weight: 600; line-height: 1.35;
            color: var(--nl-fg); background: var(--vscode-badge-background, #3b5061);
        }
        .db-preview-key-fk {
            background: var(--vscode-sideBarSectionHeader-background, #313131);
        }
        .db-detail-rows { margin-top: 6px; flex: 1; min-height: 70px; overflow: auto; }
        .right-panel .card, .right-panel .output-card { flex-shrink: 0; }
        #inputCard { min-height: 160px; }
        .input-wrapper { position: relative; flex: 1; min-width: 0; }
        .editor-with-action { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 10px; align-items: stretch; min-height: 0; }
        .editor-with-action textarea {
            display: block; width: 100%; min-width: 0;
            resize: vertical; padding: 12px; border-radius: 6px;
            line-height: 1.5; color: var(--nl-fg); background: var(--nl-inner);
        }
        #leftInput { min-height: 105px; height: 105px; padding-bottom: 28px; }
        #rightOutput { min-height: 125px; height: 125px; font: 12px/1.6 var(--vscode-editor-font-family, Consolas, monospace); }
        .char-count { position: absolute; right: 11px; bottom: 9px; font-size: 11px; color: var(--nl-muted); pointer-events: none; }
        /* Grid stretching keeps both action buttons exactly as tall as their editor. */
        .editor-action { align-self: stretch; height: 100%; min-height: 0; width: 100%; padding: 9px; text-align: center; white-space: normal; }
        .output-card { min-height: 190px; }
        .output-card .card-heading { margin-bottom: 12px; }
        .results-card {
            display: flex; flex-direction: column;
            flex: 1 0 250px !important; min-height: 250px;
        }
        .results-output {
            flex: 1; min-height: 135px; padding: 12px; overflow: auto;
            background: var(--nl-inner); border: 1px solid var(--nl-line);
            border-radius: 6px; font-size: 12px;
        }
        /* Sticky backgrounds must live on the TH cells, not the THEAD group.
           With border-collapse: collapse, transparent-looking headers can overlap rows. */
        .results-table { width: 100%; border-collapse: separate; border-spacing: 0; font: 12px/1.45 var(--vscode-editor-font-family, Consolas, monospace); }
        .results-table th, .results-table td {
            padding: 8px 10px; text-align: left; white-space: nowrap;
            border-bottom: 1px solid var(--nl-line);
        }
        .results-table thead th {
            position: sticky; top: 0; z-index: 2;
            background-color: var(--vscode-editorWidget-background, #252526);
            color: var(--nl-fg); font-weight: 600;
            box-shadow: 0 1px 0 var(--nl-line);
        }
        .results-table tbody tr:hover { background: var(--nl-hover); }
        .results-info { font-size: 12px; padding: 9px; color: var(--nl-muted); }
        .results-error { font-size: 12px; padding: 9px; color: var(--vscode-errorForeground, #f48771); }
        .action-bar {
            display: flex; gap: 8px; align-items: center;
            flex-wrap: wrap; justify-content: flex-end; margin-top: 12px;
        }
        .action-bar button { flex: 1 1 auto; font-size: 12px; }
        .action-bar .save-btn { background: #b75b18; color: #fff; border-color: transparent; }
        .action-bar .save-btn:hover { background: #c76b24; }
        @media (max-width: 1120px) {
            .model-config-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .generation-settings-card { grid-column: 1 / -1; }
        }
        @media (min-width: 861px) and (max-width: 1100px) {
            .db-row-container { grid-template-columns: minmax(0, .5fr) minmax(0, 1.5fr); }
        }
        @media (max-width: 860px) {
            body { height: auto; min-height: 100%; overflow-y: auto; padding: 10px; }
            .workspace-layout { height: auto; display: flex; flex-direction: column; }
            .left-panel, .right-panel { overflow: visible; }
            #dbDetailCard, .results-card { flex: none !important; min-height: 310px; }
        }
        @media (max-width: 530px) {
            .db-row-container, .model-config-row { grid-template-columns: 1fr; }
            .db-selection-row { flex-wrap: wrap; }
            .database-search { flex-basis: 100%; }
            .db-actions { width: 100%; }
            .generation-settings-card { grid-column: auto; }
            .editor-with-action { grid-template-columns: 1fr; }
            /* In stacked mobile layout, avoid a full-height action button. */
            .editor-action { height: 40px; min-height: 40px; }
        }
    </style>
    <!-- Prism 代码高亮 -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs/themes/prism-tomorrow.css" />
    <script src="https://cdn.jsdelivr.net/npm/prismjs/prism.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/prismjs/components/prism-sql.min.js"></script>
</head>
<body>
    <div class="workspace-layout">
        <!-- LEFT: keep the original database selectors and actions -->
        <section class="left-panel" aria-label="Configuration and database details">
            <div class="db-row-container">
                <div class="card db-engine-card">
                    <h3>Database Engine*</h3>
                    <p class="help-text">Choose database type</p>
                    <select id="dbTypeSelect" onchange="onDatabaseTypeChange()">
                        <option value="mysql">MySQL</option>
                        <option value="postgresql">PostgreSQL</option>
                        <option value="sqlite">SQLite</option>
                    </select>
                </div>
                <div class="card db-select-card">
                    <h3>Database*</h3>
                    <p class="help-text">Select a database to use</p>
                    <div class="db-selection-row">
                        <div class="database-search" id="dbSearchContainer">
                            <input type="text" id="dbSearchInput" placeholder="Search database..." autocomplete="off" aria-label="Database search" />
                            <div class="database-dropdown" id="dbDropdown"></div>
                        </div>
                        <div class="db-actions">
                            <button class="db-btn" onclick="refreshDatabases()">Refresh</button>
                            <button class="db-btn primary" onclick="uploadDatabase()">Upload DB</button>
                            <button class="db-btn" id="mysqlConfigBtn" style="display: none;" onclick="configureMySQL()">MySQL Config</button>
                            <button class="db-btn" id="pgConfigBtn" style="display: none;" onclick="configurePostgres()">Postgres Config</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Three areas: model choice | compact Kimi controls | pipeline options -->
            <div class="model-card-container">
                <div class="section-title">
                    <h3>Model &amp; Generation Settings</h3>
                    <p class="help-text">Select the model and control prompt construction and validation.</p>
                </div>
                <div class="model-config-row">
                    <div class="model-card">
                        <h4>Model Selection</h4>
                        <label for="aiProviderSelect">AI Provider</label>
                        <select id="aiProviderSelect" onchange="updateAiProvider()">
                            <option value="copilot">GitHub Copilot</option>
                            <option value="kimi">Kimi API</option>
                        </select>
                        <div id="copilotModelConfig" style="margin-top: 12px;">
                            <label for="copilotModelSelect">Copilot Model</label>
                            <select id="copilotModelSelect" title="Select GitHub Copilot model">
                                <option value="">Loading models...</option>
                            </select>
                        </div>
                        <div id="kimiModelConfig" style="display: none; margin-top: 12px;">
                            <label for="kimiModelSelect">Kimi Model</label>
                            <select id="kimiModelSelect" onchange="onKimiModelChange()" title="Models returned for your Kimi API key">
                                <option value="__custom__">Custom model ID...</option>
                            </select>
                            <div id="kimiCustomModelRow" style="margin-top: 8px;">
                                <label for="kimiModelInput">Custom Model ID</label>
                                <input id="kimiModelInput" type="text" value="kimi-k2.6" placeholder="kimi-k2.6" onchange="saveKimiSettings()" />
                            </div>
                        </div>
                    </div>

                    <div class="model-card kimi-settings-card" id="kimiSettingsColumn">
                        <h4>Model Settings</h4>
                        <p class="setting-placeholder" id="kimiSettingsPlaceholder">Copilot uses the selected model. No additional API settings are required.</p>
                        <div id="kimiSettingsPanel" style="display:none;">
                            <details class="settings-accordion" id="kimiSettingsDetails">
                                <summary>Kimi API settings (expand)</summary>
                                <div class="settings-content">
                                    <div class="db-actions" style="margin-top:0;">
                                        <button class="db-btn" onclick="refreshKimiModels()">Refresh Models</button>
                                        <button class="db-btn" onclick="configureKimiApi()">Configure API Key</button>
                                        <button class="db-btn" onclick="testKimiApi()">Test API</button>
                                    </div>
                                    <p id="kimiKeyStatus" style="margin:8px 0 4px;">API key not configured</p>
                                    <p id="kimiModelsStatus" style="margin:4px 0 8px;">Configure an API key to load available models.</p>
                                    <label for="kimiBaseUrlInput">API Base URL</label>
                                    <input id="kimiBaseUrlInput" type="text" value="https://api.moonshot.cn/v1" onchange="onKimiBaseUrlChange()" />
                                    <div id="kimiK26ReasoningRow" style="margin-top:10px;">
                                        <label for="kimiThinkingSelect">K2.6 Thinking mode</label>
                                        <select id="kimiThinkingSelect" onchange="saveKimiSettings()">
                                            <option value="default">Model default (thinking enabled)</option>
                                            <option value="disabled">Disabled (instant)</option>
                                            <option value="enabled">Enabled</option>
                                        </select>
                                    </div>
                                    <div id="kimiK3ReasoningRow" style="display:none; margin-top:10px;">
                                        <label for="kimiReasoningEffortSelect">K3 Reasoning effort</label>
                                        <select id="kimiReasoningEffortSelect" onchange="saveKimiSettings()">
                                            <option value="default">Model default (Max)</option>
                                            <option value="low">Low</option>
                                            <option value="high">High</option>
                                            <option value="max">Max (explicit)</option>
                                        </select>
                                    </div>
                                    <p id="kimiParameterNotice" style="margin:8px 0;"></p>
                                    <pre id="kimiEffectiveParameters" style="white-space:pre-wrap; word-break:break-word; font-size:11px; padding:8px; background:var(--nl-card); border-radius:5px;"></pre>
                                    <details class="settings-accordion">
                                        <summary>Advanced request parameters</summary>
                                        <div class="settings-content">
                                            <label for="kimiMaxCompletionTokensInput">Max output tokens (blank = API default)</label>
                                            <input id="kimiMaxCompletionTokensInput" type="number" min="1" step="1" placeholder="API default" onchange="saveKimiSettings()" />
                                            <label for="kimiTimeoutMsInput">Request timeout (ms)</label>
                                            <input id="kimiTimeoutMsInput" type="number" min="10000" max="900000" step="1000" value="180000" onchange="saveKimiSettings()" />
                                            <label for="kimiRetryCountInput">Retries for transient HTTP errors (0-3)</label>
                                            <input id="kimiRetryCountInput" type="number" min="0" max="3" step="1" value="0" onchange="saveKimiSettings()" />
                                            <div id="kimiCacheTtlRow">
                                                <label for="kimiCacheTtlSelect">K3 prefix-cache TTL</label>
                                                <select id="kimiCacheTtlSelect" onchange="saveKimiSettings()">
                                                    <option value="default">API default (5m)</option>
                                                    <option value="5m">5 minutes (explicit)</option>
                                                    <option value="1h">1 hour</option>
                                                </select>
                                            </div>
                                            <label for="kimiStopSequencesInput">Stop sequences (optional, one per line; max 5)</label>
                                            <textarea id="kimiStopSequencesInput" rows="2" placeholder="Leave blank to keep default" onchange="saveKimiSettings()"></textarea>
                                            <p class="help-text" style="margin-top:10px;">K3 sampling parameters are model-fixed. Non-streaming SQL output; retries may increase latency and API costs.</p>
                                        </div>
                                    </details>
                                </div>
                            </details>
                        </div>
                    </div>

                    <div class="fewshot-setting-card generation-settings-card">
                        <h4>Generation &amp; Validation</h4>
                        <label class="checkbox-line" for="useServerInput">
                            <input type="checkbox" id="useServerInput" checked onchange="updateServerMode()">
                            <span>DAIL Prompt + Few-shot</span>
                        </label>
                        <label class="checkbox-line" for="useRuleValidationInput">
                            <input type="checkbox" id="useRuleValidationInput" checked onchange="updateServerMode()">
                            <span>Rule-based Validation &amp; Retry</span>
                        </label>
                        <p id="serverModeDescription">Full pipeline: DAIL prompt + rule-based validation and retries.</p>
                        <div id="fewshotConfig">
                            <h4>Few-shot Retrieval</h4>
                            <div class="fewshot-controls">
                                <div class="fewshot-control-group">
                                    <label for="historyShotsInput">History Few-shots</label>
                                    <input type="number" id="historyShotsInput" min="0" max="10" value="1" title="Number of user history few-shots (0-10)">
                                    <span class="fewshot-label">/ 10</span>
                                </div>
                                <div class="fewshot-control-group">
                                    <label for="generalShotsInput">General Few-shots</label>
                                    <input type="number" id="generalShotsInput" min="0" max="10" value="3" title="Number of general few-shots (0-10)">
                                    <span class="fewshot-label">/ 10</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Always-visible database preview, without the old switch-view button -->
            <div class="card" id="dbDetailCard">
                <div class="card-heading">
                    <h3>Selected Database / Database Details</h3>
                    <span class="help-text">Choose a table to inspect its columns and sample rows.</span>
                </div>
                <div class="db-detail-subtitle">
                    <span>Database: <span id="selectedDbName">Not selected</span></span>
                    <span id="dbEngineBadge">MySQL</span>
                </div>
                <div class="db-detail-container">
                    <div class="db-detail-tables" id="dbTablesContainer"><div class="results-info">Select a database to view its tables.</div></div>
                    <div class="db-detail-info" id="dbTableDetails"><div class="results-info">Table columns and sample rows will appear here.</div></div>
                </div>
            </div>
        </section>

        <!-- RIGHT: separate input, editable SQL output, execution results -->
        <section class="right-panel" aria-label="SQL generation and execution">
            <div class="card" id="inputCard">
                <div class="card-heading">
                    <h3>Input*</h3>
                    <span class="help-text">Enter a natural language request (up to 200 characters).</span>
                </div>
                <div class="editor-with-action">
                    <div class="input-wrapper">
                        <textarea id="leftInput" placeholder="Write a SQL that calculates the total sales for a specific product from the orders table..." maxlength="200" oninput="updateCharCount()"></textarea>
                        <div class="char-count" id="charCount">0 / 200</div>
                    </div>
                    <button class="convert-btn editor-action" onclick="performConvert()">Generate SQL</button>
                </div>
            </div>
            <div class="output-card">
                <div class="card-heading">
                    <h3>Output</h3>
                    <span class="help-text">Generated SQL can be edited before execution.</span>
                </div>
                <div class="editor-with-action">
                    <textarea id="rightOutput" class="sql-output" placeholder="-- SQL output will appear here and can be edited..."></textarea>
                    <button id="runSqlButton" class="db-btn editor-action" onclick="executeSqlFromOutput()">Run SQL</button>
                </div>
            </div>
            <div class="card results-card">
                <div class="card-heading">
                    <h3>Execution Results</h3>
                    <span class="help-text">Query results and validation messages</span>
                </div>
                <div id="resultsOutput" class="results-output">
                    <div class="results-info">Execute SQL to see results here.</div>
                </div>
                <div class="action-bar">
                    <button class="db-btn" onclick="runSpiderTiming()">Spider Batch Timing</button>
                    <button class="db-btn" onclick="stopSpiderTiming()">Stop Batch</button>
                    <button class="clear-btn" onclick="clearOutput()">Clear Output</button>
                    <button class="db-btn save-btn" onclick="saveFewShot()">Save Few-shot</button>
                </div>
            </div>
        </section>
    </div>

        <script>
        const vscode = acquireVsCodeApi();
        let currentSchema = null; // Store current database schema
        let allDatabases = []; // Store all available databases
        let selectedDatabase = null; // Store currently selected database
        let modelsLoaded = false; // 标记模型是否已加载
        let selectedDetailTable = null; // 当前选中详情表
        let kimiModels = [];
        let kimiModelsLoaded = false;
        let kimiHasKey = false;
        let kimiModelsRequestId = 0;

        // 初始化（修复Models加载逻辑）
        document.addEventListener('DOMContentLoaded', function() {
            document.getElementById('leftInput').focus();
            setupDatabaseSearch(); 
            onDatabaseTypeChange(); 
            updateCharCount();
            document.getElementById('rightOutput').addEventListener('input', updateRunSqlButtonState);
            updateRunSqlButtonState();
            setupFewShotControls(); // 初始化 few-shot 控制器
            
            // 立即请求模型列表 + 增加重试机制
            fetchCopilotModels();
            vscode.postMessage({ command: 'getKimiSettings' });
            updateAiProvider();
            
            // 监听扩展消息（提前绑定，避免丢失）
            window.addEventListener('message', handleExtensionMessages);
        });

        // 修复：独立的模型获取函数（增加重试）
        function fetchCopilotModels() {
            if (modelsLoaded) return;
            
            // 发送请求获取模型列表
            vscode.postMessage({ command: 'getModels' });
            
            // 重试机制：如果5秒内未加载成功，再次请求
            setTimeout(() => {
                if (!modelsLoaded) {
                    console.log('Retry fetching Copilot models...');
                    vscode.postMessage({ command: 'getModels' });
                }
            }, 5000);
        }

        // 修复：统一处理扩展消息
        function handleExtensionMessages(event) {
            const message = event.data;
            switch (message.command) {
                case 'result':
                    // 上部：显示SQL代码（可编辑）
                    const outputEl = document.getElementById('rightOutput');
                    const sqlText = message.sql ? message.sql : '-- No SQL generated';
                    if (outputEl && outputEl.tagName === 'TEXTAREA') {
                        outputEl.value = sqlText;
                    } else if (outputEl) {
                        outputEl.textContent = sqlText;
                    }
                    updateRunSqlButtonState();

                    // 下部：显示执行结果、错误或提示
                    const resultsEl = document.getElementById('resultsOutput');
                    if (message.error) {
                        if (resultsEl) resultsEl.innerHTML = '<div class="results-error">Error: ' + (message.error || 'Execution failed') + '</div>';
                    } else if (message.results !== undefined) {
                        if (Array.isArray(message.results) && message.results.length > 0) {
                            renderResultsTable(message.results);
                        } else if (Array.isArray(message.results)) {
                            if (resultsEl) resultsEl.innerHTML = '<div class="results-info">✅ Query executed successfully. No rows returned.</div>';
                        } else {
                            if (resultsEl) resultsEl.innerHTML = '<div class="results-info">📧 Ready to execute SQL. Click the convert button first.</div>';
                        }
                    } else {
                        if (resultsEl) resultsEl.innerHTML = '<div class="results-info">📧 Results will appear here after execution</div>';
                    }
                    break;
                case 'databases':
                    updateDatabaseList(message.databases, message.error);
                    break;
                case 'schema':
                    currentSchema = message.schema;
                    if (message.error) {
                        console.error('Schema error:', message.error);
                    }
                    // Keep the database detail visible below configuration.
                    renderDatabaseDetail();
                    if (selectedDatabase && Array.isArray(currentSchema) && currentSchema.length) {
                        const wanted = currentSchema.some(t => t.name === selectedDetailTable)
                            ? selectedDetailTable : currentSchema[0].name;
                        selectDetailTable(wanted);
                    }
                    break;
                case 'refreshDatabases':
                    refreshDatabases();
                    break;
                case 'kimiSettings':
                    document.getElementById('kimiModelInput').value = message.modelId || 'kimi-k2.6';
                    document.getElementById('kimiBaseUrlInput').value = message.baseUrl || 'https://api.moonshot.cn/v1';
                    document.getElementById('kimiThinkingSelect').value = message.thinking || 'disabled';
                    document.getElementById('kimiReasoningEffortSelect').value = message.reasoningEffort || 'default';
                    document.getElementById('kimiMaxCompletionTokensInput').value = message.maxCompletionTokens ?? '';
                    document.getElementById('kimiTimeoutMsInput').value = message.timeoutMs ?? 180000;
                    document.getElementById('kimiRetryCountInput').value = message.retryCount ?? 0;
                    document.getElementById('kimiCacheTtlSelect').value = message.cacheTtl || 'default';
                    document.getElementById('kimiStopSequencesInput').value = message.stopSequences ?? '';
                    updateKimiParameterControls();
                    kimiHasKey = !!message.hasKey;
                    document.getElementById('kimiKeyStatus').textContent = kimiHasKey ? 'API key saved securely' : 'API key not configured';
                    renderKimiModels();
                    if (kimiHasKey && document.getElementById('aiProviderSelect').value === 'kimi') refreshKimiModels();
                    break;
                case 'kimiKeyStatus':
                    kimiHasKey = !!message.hasKey;
                    document.getElementById('kimiKeyStatus').textContent = kimiHasKey ? 'API key saved securely' : 'API key not configured';
                    if (kimiHasKey) refreshKimiModels();
                    break;
                case 'kimiModels':
                    // Ignore stale responses when users change the API endpoint or refresh twice.
                    if (message.requestId !== kimiModelsRequestId) break;
                    if (message.error) {
                        kimiModelsLoaded = false;
                        kimiModels = [];
                        document.getElementById('kimiModelsStatus').textContent = 'Could not load models: ' + message.error + '. You can still enter a custom ID.';
                    } else {
                        kimiModels = Array.isArray(message.models) ? message.models : [];
                        kimiModelsLoaded = true;
                        document.getElementById('kimiModelsStatus').textContent = kimiModels.length
                            ? kimiModels.length + ' models available for this API key.'
                            : 'API returned no models. Enter a custom ID if necessary.';
                    }
                    renderKimiModels();
                    break;
                case 'kimiTestResult':
                    document.getElementById('kimiKeyStatus').textContent = message.success
                        ? 'API connection verified' : 'API connection failed: ' + (message.error || 'unknown');
                    break;
                case 'copilotModels':
                    // 标记模型已加载
                    modelsLoaded = true;
                    updateModelSelector(message.models);
                    break;
                case 'fewShotSaved':
                    if (message.success) {
                        document.getElementById('resultsOutput').innerHTML = '<div class="results-info">Saved few-shot entry #' + message.index + ' successfully. Path: ' + (message.path || 'unknown') + '</div>';
                    } else {
                        document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Save failed: ' + (message.error || 'Unknown error') + '. Path: ' + (message.path || 'unknown') + '</div>';
                    }
                    break;
                case 'fewShotLoaded':
                    if (message.error) {
                        console.error('fewShotLoaded error:', message.error);
                    } else {
                        console.log('fewShotLoaded pool', message.pool);
                    }
                    break;
                case 'tableData':
                    if (message.table && message.rows) {
                        showTableData(message.table, message.rows);
                    } else {
                        const dbTableRows = document.getElementById('dbTableRows');
                        if (dbTableRows) {
                            dbTableRows.innerHTML = '<div class="results-error">Failed to load table data.</div>';
                        }
                    }
                    break;
            }
        }

        // 修复：更新Model选择器（处理空数据）
        function updateModelSelector(models) {
            const sel = document.getElementById('copilotModelSelect');
            const previousModelId = sel.value;
            sel.innerHTML = '';
            
            // 处理无模型的情况
            if (!models || models.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = '⚠️ No Copilot models available';
                sel.appendChild(opt);
                sel.disabled = true;
                return;
            }
            
            // 正常加载模型列表
            sel.disabled = false;
            const selectedModelId = models.some(m => m.id === previousModelId)
                ? previousModelId : models[0].id;
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.name + ' (' + m.id + ')';
                opt.selected = m.id === selectedModelId;
                sel.appendChild(opt);
            });
        }

        // 初始化 Few-Shot 控制器
        function setupFewShotControls() {
            const historyInput = document.getElementById('historyShotsInput');
            const generalInput = document.getElementById('generalShotsInput');
            
            if (!historyInput || !generalInput) {
                console.warn('Few-shot input elements not found');
                return;
            }
            
            // 验证和约束输入值（0-10）
            function validateInput(input) {
                let val = parseInt(input.value || '0', 10);
                if (isNaN(val) || val < 0) val = 0;
                if (val > 10) val = 10;
                input.value = String(val);
                return val;
            }
            
            // 添加 change 事件处理器以验证范围
            historyInput.addEventListener('change', function() {
                validateInput(this);
                console.log('📊 History few-shots changed to:', this.value);
            });
            
            generalInput.addEventListener('change', function() {
                validateInput(this);
                console.log('📊 General few-shots changed to:', this.value);
            });
            
            // 添加 input 事件处理器以为输入提供实时反馈（可选）
            historyInput.addEventListener('input', function() {
                const val = parseInt(this.value || '0', 10);
                if (!isNaN(val) && val >= 0 && val <= 10) {
                    this.style.borderColor = '#4d4d4d';
                } else {
                    this.style.borderColor = '#ff6b6b';
                }
            });
            
            generalInput.addEventListener('input', function() {
                const val = parseInt(this.value || '0', 10);
                if (!isNaN(val) && val >= 0 && val <= 10) {
                    this.style.borderColor = '#4d4d4d';
                } else {
                    this.style.borderColor = '#ff6b6b';
                }
            });
            
            console.log('✅ Few-shot controls initialized');
        }

        // 数据库搜索逻辑
        function setupDatabaseSearch() {
            const searchInput = document.getElementById('dbSearchInput');
            const dropdown = document.getElementById('dbDropdown');
            
            searchInput.addEventListener('input', function() {
                const query = this.value.toLowerCase();
                filterDatabases(query);
                if (query && allDatabases.length > 0) {
                    dropdown.style.display = 'block';
                }
            });
            
            searchInput.addEventListener('focus', function() {
                if (allDatabases.length > 0) {
                    dropdown.style.display = 'block';
                    filterDatabases(this.value.toLowerCase());
                }
            });
            
            searchInput.addEventListener('blur', function() {
                setTimeout(() => {
                    dropdown.style.display = 'none';
                }, 150);
            });
        }

        // 过滤数据库列表
        function filterDatabases(query) {
            const dropdown = document.getElementById('dbDropdown');
            dropdown.innerHTML = '';
            
            if (!allDatabases || allDatabases.length === 0) {
                const option = document.createElement('div');
                option.className = 'database-option';
                option.textContent = 'No databases found';
                dropdown.appendChild(option);
                return;
            }
            
            const filteredDatabases = allDatabases.filter(db => 
                db.name.toLowerCase().includes(query)
            );
            
            if (filteredDatabases.length === 0) {
                const option = document.createElement('div');
                option.className = 'database-option';
                option.textContent = 'No matching databases';
                dropdown.appendChild(option);
                return;
            }
            
            filteredDatabases.forEach(db => {
                const option = document.createElement('div');
                option.className = 'database-option';
                option.textContent = db.name;
                if (selectedDatabase && selectedDatabase.name === db.name) {
                    option.classList.add('selected');
                }
                option.addEventListener('click', function() {
                    selectDatabase(db);
                });
                dropdown.appendChild(option);
            });
        }

        // 选择数据库
        function selectDatabase(db) {
            const searchInput = document.getElementById('dbSearchInput');
            const dropdown = document.getElementById('dbDropdown');
            
            searchInput.value = db.name;
            selectedDatabase = db;
            dropdown.style.display = 'none';

            // A new selection updates the always-visible database preview.
            currentSchema = null;
            selectedDetailTable = null;
            updateSelectedDatabaseSummary();
            renderDatabaseDetail();

            const dbType = document.getElementById('dbTypeSelect').value;
            vscode.postMessage({
                command: 'getSchema',
                database: db.path || db.name,
                type: dbType
            });
        }

        // 更新字符计数
        function updateCharCount() {
            const input = document.getElementById('leftInput').value;
            document.getElementById('charCount').textContent = input.length + ' / 200';
        }

        // 数据库类型切换
        function onDatabaseTypeChange() {
            const dbType = document.getElementById('dbTypeSelect').value;
            const mysqlConfigBtn = document.getElementById('mysqlConfigBtn');
            const pgConfigBtn = document.getElementById('pgConfigBtn');
            
            if (dbType === 'mysql') {
                mysqlConfigBtn.style.display = 'inline-block';
                if (pgConfigBtn) pgConfigBtn.style.display = 'none';
            } else {
                mysqlConfigBtn.style.display = 'none';
            }
            if (dbType === 'postgresql') {
                if (pgConfigBtn) pgConfigBtn.style.display = 'inline-block';
                if (mysqlConfigBtn) mysqlConfigBtn.style.display = 'none';
            } else {
                if (pgConfigBtn) pgConfigBtn.style.display = 'none';
            }
            
            document.getElementById('dbSearchInput').value = '';
            selectedDatabase = null;
            allDatabases = [];
            currentSchema = null;
            selectedDetailTable = null;
            updateSelectedDatabaseSummary();
            renderDatabaseDetail();

            refreshDatabases();
        }

        // 刷新数据库列表
        function refreshDatabases() {
            const dbType = document.getElementById('dbTypeSelect').value;
            const searchInput = document.getElementById('dbSearchInput');
            
            searchInput.placeholder = 'Loading...';
            allDatabases = [];
            selectedDatabase = null;
            currentSchema = null;
            selectedDetailTable = null;
            updateSelectedDatabaseSummary();
            renderDatabaseDetail();

            vscode.postMessage({
                command: 'getDatabases',
                type: dbType
            });
        }

        // 配置MySQL
        function configureMySQL() {
            vscode.postMessage({ command: 'configureMySQL' });
        }

        // 配置Postgres
        function configurePostgres() {
            vscode.postMessage({ command: 'configurePostgres' });
        }

        // 上传数据库
        function uploadDatabase() {
            vscode.postMessage({ command: 'uploadDatabase' });
        }

        function getSelectedKimiModelId() {
            const selection = document.getElementById('kimiModelSelect').value;
            return selection && selection !== '__custom__'
                ? selection : document.getElementById('kimiModelInput').value.trim();
        }

        function getAiSettings() {
            return {
                aiProvider: document.getElementById('aiProviderSelect').value,
                kimiModelId: getSelectedKimiModelId(),
                kimiBaseUrl: document.getElementById('kimiBaseUrlInput').value.trim(),
                kimiThinking: document.getElementById('kimiThinkingSelect').value,
                kimiReasoningEffort: document.getElementById('kimiReasoningEffortSelect').value,
                kimiMaxCompletionTokens: document.getElementById('kimiMaxCompletionTokensInput').value.trim(),
                kimiTimeoutMs: Number(document.getElementById('kimiTimeoutMsInput').value),
                kimiRetryCount: Number(document.getElementById('kimiRetryCountInput').value),
                kimiCacheTtl: document.getElementById('kimiCacheTtlSelect').value,
                kimiStopSequences: document.getElementById('kimiStopSequencesInput').value
            };
        }

        function updateKimiParameterControls() {
            const id = getSelectedKimiModelId().toLowerCase();
            const isK3 = id === 'kimi-k3' || id.startsWith('kimi-k3.');
            const isK26 = id === 'kimi-k2.6';
            document.getElementById('kimiK26ReasoningRow').style.display = isK26 ? 'block' : 'none';
            document.getElementById('kimiK3ReasoningRow').style.display = isK3 ? 'block' : 'none';
            document.getElementById('kimiCacheTtlRow').style.display = isK3 ? 'block' : 'none';
            document.getElementById('kimiParameterNotice').textContent = isK3
                ? 'K3 is always thinking. Select Low, High, or Max explicitly for reproducible experiments.'
                : isK26 ? 'K2.6 supports thinking on/off. Sampling values are model-fixed.'
                    : 'For other model IDs, model-specific reasoning controls are not sent.';
            const preview = { model: id, stream: false };
            if (isK3) {
                const effort = document.getElementById('kimiReasoningEffortSelect').value;
                if (effort !== 'default') preview.reasoning_effort = effort;
                else preview.reasoning_effort = '(omitted; API default: max)';
            } else if (isK26) {
                const thinking = document.getElementById('kimiThinkingSelect').value;
                if (thinking !== 'default') preview.thinking = { type: thinking };
            }
            const tokenLimit = document.getElementById('kimiMaxCompletionTokensInput').value.trim();
            if (tokenLimit) preview[isK3 ? 'max_completion_tokens' : 'max_tokens'] = Number(tokenLimit);
            const ttl = document.getElementById('kimiCacheTtlSelect').value;
            if (isK3 && ttl !== 'default') preview.prompt_cache_options = { ttl: ttl };
            const stop = document.getElementById('kimiStopSequencesInput').value.split(/\\r?\\n/).map(value => value.trim()).filter(Boolean);
            if (stop.length) preview.stop = stop;
            document.getElementById('kimiEffectiveParameters').textContent = 'Request preview (excluding prompt and API key):\\n' + JSON.stringify(preview, null, 2);
        }

        function renderKimiModels() {
            const dropdown = document.getElementById('kimiModelSelect');
            const customInput = document.getElementById('kimiModelInput');
            const preferred = getSelectedKimiModelId() || 'kimi-k2.6';
            dropdown.replaceChildren();
            const sorted = [...kimiModels].sort((a, b) => a.id.localeCompare(b.id));
            const ids = new Set();
            sorted.forEach(function(model) {
                if (!model || !model.id || ids.has(model.id)) return;
                ids.add(model.id);
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.id;
                dropdown.appendChild(option);
            });
            const custom = document.createElement('option');
            custom.value = '__custom__';
            custom.textContent = 'Custom model ID...';
            dropdown.appendChild(custom);
            // Do not silently switch to another model, especially during a benchmark.
            if (ids.has(preferred)) {
                dropdown.value = preferred;
                customInput.value = preferred;
            } else {
                dropdown.value = '__custom__';
                customInput.value = preferred;
                if (kimiModelsLoaded && ids.size) {
                    document.getElementById('kimiModelsStatus').textContent =
                        'Saved model (' + preferred + ') is not in the API list. Select a listed model or use Custom.';
                }
            }
            document.getElementById('kimiCustomModelRow').style.display =
                dropdown.value === '__custom__' ? 'block' : 'none';
            updateKimiParameterControls();
        }

        function onKimiModelChange() {
            const selection = document.getElementById('kimiModelSelect').value;
            if (selection !== '__custom__') {
                document.getElementById('kimiModelInput').value = selection;
            }
            document.getElementById('kimiCustomModelRow').style.display =
                selection === '__custom__' ? 'block' : 'none';
            updateKimiParameterControls();
            saveKimiSettings();
        }

        function refreshKimiModels() {
            if (!kimiHasKey) {
                document.getElementById('kimiModelsStatus').textContent = 'Configure an API key first.';
                return;
            }
            const requestId = ++kimiModelsRequestId;
            document.getElementById('kimiModelsStatus').textContent = 'Loading models from Kimi API...';
            vscode.postMessage({
                command: 'listKimiModels', requestId,
                kimiBaseUrl: document.getElementById('kimiBaseUrlInput').value.trim()
            });
        }

        function onKimiBaseUrlChange() {
            ++kimiModelsRequestId; // Invalidate any in-flight responses for the old host.
            kimiModels = [];
            kimiModelsLoaded = false;
            renderKimiModels();
            saveKimiSettings();
            if (kimiHasKey) refreshKimiModels();
        }

        function updateAiProvider() {
            const isKimi = document.getElementById('aiProviderSelect').value === 'kimi';
            document.getElementById('copilotModelConfig').style.display = isKimi ? 'none' : 'block';
            document.getElementById('kimiModelConfig').style.display = isKimi ? 'block' : 'none';
            // Keep advanced Kimi options in a collapsed panel, not in the model selector.
            document.getElementById('kimiSettingsPanel').style.display = isKimi ? 'block' : 'none';
            document.getElementById('kimiSettingsPlaceholder').style.display = isKimi ? 'none' : 'block';
            if (isKimi && kimiHasKey && !kimiModelsLoaded) refreshKimiModels();
            updateKimiParameterControls();
            updateServerMode();
        }

        function saveKimiSettings() {
            updateKimiParameterControls();
            vscode.postMessage({ command: 'saveKimiSettings', ...getAiSettings(),
                modelId: getSelectedKimiModelId(),
                baseUrl: document.getElementById('kimiBaseUrlInput').value.trim(),
                thinking: document.getElementById('kimiThinkingSelect').value
            });
        }

        function configureKimiApi() {
            vscode.postMessage({ command: 'configureKimiApi' });
        }

        function testKimiApi() {
            vscode.postMessage({ command: 'testKimiApi', ...getAiSettings() });
        }

        function updateServerMode() {
            const useDail = document.getElementById('useServerInput').checked;
            const useRules = document.getElementById('useRuleValidationInput').checked;
            document.getElementById('historyShotsInput').disabled = !useDail;
            document.getElementById('generalShotsInput').disabled = !useDail;
            document.getElementById('fewshotConfig').style.display = useDail ? 'block' : 'none';
            const description = useDail
                ? (useRules ? 'A / Full: DAIL prompt + rule-based validation and retries.'
                    : 'B / DAIL Only: DAIL prompt, exactly one LLM call, no validation.')
                : (useRules ? 'C / Rule Only: direct prompt + original backend validation and retries (uses a zero-shot session).'
                    : 'D / Direct: schema + question, one LLM call; no DAIL or validation.');
            document.getElementById('serverModeDescription').textContent = description;
        }

        function runSpiderTiming() {
            const model = document.getElementById('copilotModelSelect');
            const history = document.getElementById('historyShotsInput');
            const general = document.getElementById('generalShotsInput');
            vscode.postMessage({
                command: 'runSpiderBatch',
                useServer: document.getElementById('useServerInput').checked,
                useRuleValidation: document.getElementById('useRuleValidationInput').checked,
                copilotModelId: model ? model.value : '',
                ...getAiSettings(),
                historyFewShotCount: history ? Number(history.value) : 1,
                generalFewShotCount: general ? Number(general.value) : 3
            });
        }

        function stopSpiderTiming() {
            vscode.postMessage({ command: 'stopSpiderBatch' });
        }

        // Give Run SQL the same primary styling as Generate SQL when the Output editor has content.
        function updateRunSqlButtonState() {
            const outputEl = document.getElementById('rightOutput');
            const runButton = document.getElementById('runSqlButton');
            if (!outputEl || !runButton) return;
            runButton.classList.toggle('primary', !!outputEl.value.trim());
        }

        // 执行转换
        function performConvert() {
            const input = document.getElementById('leftInput').value;
            const dbType = document.getElementById('dbTypeSelect').value;
            
            if (!input.trim()) {
                document.getElementById('rightOutput').value = '-- Please enter natural language query first';
                updateRunSqlButtonState();
                return;
            }
            
            if (!selectedDatabase) {
                document.getElementById('rightOutput').value = '-- Please select a database first';
                updateRunSqlButtonState();
                return;
            }
            
            document.getElementById('rightOutput').value = '-- Converting... ⏳';
            updateRunSqlButtonState();
            
            const modelSel = document.getElementById('copilotModelSelect');
            const copilotModelId = modelSel ? modelSel.value : '';

            const historyInput = document.getElementById('historyShotsInput');
            const generalInput = document.getElementById('generalShotsInput');
            const rawHistoryCount = historyInput ? parseInt(historyInput.value || '1', 10) : 1;
            const rawGeneralCount = generalInput ? parseInt(generalInput.value || '3', 10) : 3;
            const historyFewShotCount = isNaN(rawHistoryCount) ? 1 : Math.max(0, Math.min(10, rawHistoryCount));
            const generalFewShotCount = isNaN(rawGeneralCount) ? 3 : Math.max(0, Math.min(10, rawGeneralCount));

            console.log('🎯 [WEBVIEW] convert with few-shot settings:', {
                historyFewShotCount,
                generalFewShotCount
            });

            vscode.postMessage({
                command: 'convert',
                useServer: document.getElementById('useServerInput').checked,
                useRuleValidation: document.getElementById('useRuleValidationInput').checked,
                text: input,
                database: dbType,
                selectedDb: selectedDatabase.path || selectedDatabase.name,
                schema: currentSchema,
                copilotModelId: copilotModelId,
                ...getAiSettings(),
                historyFewShotCount,
                generalFewShotCount
            });
        }

        function executeSqlFromOutput() {
            const sqlText = document.getElementById('rightOutput').value;
            const dbType = document.getElementById('dbTypeSelect').value;

            if (!sqlText.trim()) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please enter SQL to execute.</div>';
                return;
            }
            if (!selectedDatabase) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please select a database first.</div>';
                return;
            }

            document.getElementById('resultsOutput').innerHTML = '<div class="results-info">Executing SQL... ⏳</div>';

            vscode.postMessage({
                command: 'executeSQL',
                sql: sqlText,
                database: selectedDatabase.path || selectedDatabase.name,
                type: dbType
            });
        }

        function saveFewShot() {
            const nlq = document.getElementById('leftInput').value.trim();
            const sql = document.getElementById('rightOutput').value.trim();
            const dbId = selectedDatabase ? (selectedDatabase.path || selectedDatabase.name) : '';

            if (!dbId) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please select a database before saving few-shot.</div>';
                return;
            }
            if (!nlq) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please enter natural language query before saving few-shot.</div>';
                return;
            }
            if (!sql) {
                document.getElementById('resultsOutput').innerHTML = '<div class="results-error">Please generate or edit SQL before saving few-shot.</div>';
                return;
            }

            vscode.postMessage({
                command: 'saveFewShot',
                record: {
                    db_id: dbId,
                    nlq: nlq,
                    sql: sql
                }
            });
        }

        // The old Database Detail toggle is removed. The preview is always visible.
        function updateSelectedDatabaseSummary() {
            const label = document.getElementById('selectedDbName');
            const engine = document.getElementById('dbEngineBadge');
            if (label) label.textContent = selectedDatabase ? selectedDatabase.name : 'Not selected';
            if (engine) {
                const dbType = document.getElementById('dbTypeSelect').value;
                engine.textContent = dbType === 'postgresql' ? 'PostgreSQL' : dbType === 'sqlite' ? 'SQLite' : 'MySQL';
            }
        }

        function renderDatabaseDetail() {
            const dbTablesContainer = document.getElementById('dbTablesContainer');
            const dbTableDetails = document.getElementById('dbTableDetails');

            if (!currentSchema || currentSchema.length === 0) {
                dbTablesContainer.innerHTML = '<div class="results-info">No schema available.</div>';
                dbTableDetails.innerHTML = '';
                return;
            }

            dbTablesContainer.innerHTML = '';
            dbTableDetails.innerHTML = '<div class="results-info">Choose a table to view details</div>';

            // 列出表名
            currentSchema.forEach(table => {
                const tableItem = document.createElement('div');
                tableItem.className = 'db-detail-table-item' + (selectedDetailTable === table.name ? ' selected' : '');
                tableItem.textContent = table.name;
                tableItem.addEventListener('click', () => {
                    selectDetailTable(table.name);
                });
                dbTablesContainer.appendChild(tableItem);
            });
        }

        function selectDetailTable(tableName) {
            selectedDetailTable = tableName;
            const dbType = document.getElementById('dbTypeSelect').value;

            renderDatabaseDetail();

            const table = currentSchema.find(t => t.name === tableName);
            if (!table) {
                document.getElementById('dbTableDetails').innerHTML = '<div class="results-info">Table not found</div>';
                return;
            }

            // Column name/type/PK/FK are displayed in the table header, not duplicated above it.
            const html = '<div id="dbTableRows" class="db-detail-rows">Loading rows...</div>';
            document.getElementById('dbTableDetails').innerHTML = html;

            // 直接请求样本数据（默认前100行，自动加载）
            loadTableData(tableName);
        }

        function loadTableData(tableName) {
            if (!selectedDatabase) {
                document.getElementById('dbTableDetails').innerHTML = '<div class="results-error">Select database first.</div>';
                return;
            }

            const dbTableRows = document.getElementById('dbTableRows');
            if (dbTableRows) {
                dbTableRows.innerHTML = '<div class="results-info">Loading table rows...</div>';
            }

            const dbType = document.getElementById('dbTypeSelect').value;
            vscode.postMessage({
                command: 'getTableData',
                table: tableName,
                database: selectedDatabase.path || selectedDatabase.name,
                type: dbType
            });
        }

        function showTableData(tableName, rows) {
            const dbTableRows = document.getElementById('dbTableRows');
            if (!dbTableRows) return;

            if (!rows || rows.length === 0) {
                dbTableRows.innerHTML = '<div class="results-info">No rows found.</div>';
                return;
            }

            const columns = Object.keys(rows[0]);
            const table = Array.isArray(currentSchema)
                ? currentSchema.find(item => item.name === tableName) : null;
            const schemaColumns = table && Array.isArray(table.columns) ? table.columns : [];
            const foreignKeys = table && Array.isArray(table.foreignKeys) ? table.foreignKeys : [];
            let html = '<table class="results-table db-preview-table"><thead><tr>';
            columns.forEach(name => {
                const schemaColumn = schemaColumns.find(item =>
                    String(item.name).toLowerCase() === name.toLowerCase());
                const isPk = !!(schemaColumn && schemaColumn.pk);
                const fk = foreignKeys.find(item =>
                    String(item.column).toLowerCase() === name.toLowerCase());
                const type = schemaColumn ? String(schemaColumn.type || 'TEXT').trim() : '';
                const metadata = [];
                if (type) metadata.push(escapeHtml(type));
                if (isPk) metadata.push('<span class="db-preview-key">PK</span>');
                if (fk) metadata.push('<span class="db-preview-key db-preview-key-fk">FK</span>');
                const fkTitle = fk && fk.refTable && fk.refColumn
                    ? ' title="References ' + escapeHtml(fk.refTable + '.' + fk.refColumn) + '"' : '';
                html += '<th scope="col"' + (isPk ? ' class="db-preview-pk"' : '') + fkTitle + '>' +
                    escapeHtml(name) + (metadata.length
                        ? ' <span class="db-preview-meta">(' + metadata.join(', ') + ')</span>' : '') + '</th>';
            });
            html += '</tr></thead><tbody>';

            rows.forEach(row => {
                html += '<tr>';
                columns.forEach(col => {
                    html += '<td>' + escapeHtml(row[col] === null ? 'NULL' : String(row[col])) + '</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table>';
            dbTableRows.innerHTML = html;
        }

        // 清空输出
        function clearOutput() {
            const outputEl = document.getElementById('rightOutput');
            if (outputEl && outputEl.tagName === 'TEXTAREA') {
                outputEl.value = '';
            } else if (outputEl) {
                outputEl.textContent = '';
            }
            updateRunSqlButtonState();
            document.getElementById('resultsOutput').innerHTML = '<div class="results-info">-- Results cleared</div>';
        }

        // SQL语法高亮函数
        function highlightSQL(sql) {
            if (!sql) return '';
            
            // SQL关键字列表
            const keywords = [
                'SELECT', 'WHERE', 'FROM', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER',
                'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE',
                'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
                'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
                'CREATE', 'ALTER', 'DROP', 'TABLE', 'DATABASE', 'INDEX',
                'AS', 'DISTINCT', 'ALL', 'UNION', 'INTERSECT', 'EXCEPT',
                'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'RECURSIVE',
                'CAST', 'COALESCE', 'NULLIF'
            ];
            
            let highlighted = sql;
            
            // 高亮关键字（词边界匹配，不区分大小写）
            keywords.forEach(keyword => {
                try {
                    const pattern = '\\\\b' + keyword + '\\\\b';
                    const regex = new RegExp(pattern, 'gi');
                    const replacement = '<span class="sql-keyword">' + keyword.toUpperCase() + '</span>';
                    highlighted = highlighted.replace(regex, replacement);
                } catch(e) {}
            });
            
            // 高亮字符串（单引号和双引号）
            highlighted = highlighted.replace(/'[^']*'/g, function(match) { 
                return '<span class="sql-string">' + match + '</span>'; 
            });
            highlighted = highlighted.replace(/"[^"]*"/g, function(match) { 
                return '<span class="sql-string">' + match + '</span>'; 
            });
            
            // 高亮数字
            highlighted = highlighted.replace(/\\d+/g, function(match) { 
                return '<span class="sql-number">' + match + '</span>'; 
            });
            
            return highlighted;
        }

        // 渲染结果表格
        function renderResultsTable(rows) {
            if (!rows || rows.length === 0) {
                document.getElementById('resultsOutput').innerHTML = 
                    '<div class="results-info">✅ Query executed. No data rows returned.</div>';
                return;
            }
            
            // 获取列名
            const columns = Object.keys(rows[0]);
            
            // 构建HTML表格
            let html = '<table class="results-table"><thead><tr>';
            columns.forEach(col => {
                html += '<th>' + escapeHtml(col) + '</th>';
            });
            html += '</tr></thead><tbody>';
            
            // 添加数据行
            rows.forEach(row => {
                html += '<tr>';
                columns.forEach(col => {
                    const value = row[col];
                    html += '<td>' + escapeHtml(value === null ? 'NULL' : String(value)) + '</td>';
                });
                html += '</tr>';
            });
            
            html += '</tbody></table>';
            document.getElementById('resultsOutput').innerHTML = html;
        }

        // HTML转义函数
        function escapeHtml(text) {
            const map = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            };
            return String(text).replace(/[&<>"']/g, m => map[m]);
        }

        // 更新数据库列表
        function updateDatabaseList(databases, error) {
            const searchInput = document.getElementById('dbSearchInput');
            
            allDatabases = databases || [];
            
            // The database preview is permanently visible; no toggle button is needed.
            updateSelectedDatabaseSummary();

            if (error) {
                searchInput.placeholder = 'Error: ' + error;
                console.error('Database list error:', error);
                return;
            }
            
            if (!databases || databases.length === 0) {
                searchInput.placeholder = 'No databases found';
                return;
            }
            
            searchInput.placeholder = 'Search database... (' + databases.length + ' available)';
        }

        // 快捷键支持
        document.getElementById('leftInput').addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && event.ctrlKey) {
                performConvert();
            }
        });
    </script>
</body>
</html>`;
    }
}
