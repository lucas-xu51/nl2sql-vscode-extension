"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readPostgresTableRows = exports.readPostgresSchema = exports.getPostgresDatabases = exports.getPostgresConfig = exports.readMySQLTableRows = exports.uploadSQLiteToDailSQL = exports.convertSQLToNaturalLanguage = exports.convertNaturalLanguageToSQL = exports.getMySQLConfig = exports.readMySQLSchema = exports.getMySQLDatabases = exports.readSQLiteSchema = exports.findSQLiteFiles = exports.deactivate = exports.activate = exports.buildDailSchemaFromTables = exports.buildCvLinkFromLocalSQLite = exports.executeSQL = exports.quoteIdentifier = void 0;
const nl2sqlPanel_1 = require("./nl2sqlPanel");
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const axios_1 = require("axios");
function mapToDailColumnType(rawType) {
    const t = (rawType || '').toLowerCase();
    if (t.includes('int') || t.includes('real') || t.includes('num') || t.includes('float') || t.includes('double') || t.includes('decimal')) {
        return 'number';
    }
    if (t.includes('bool')) {
        return 'boolean';
    }
    if (t.includes('date') || t.includes('time')) {
        return 'time';
    }
    return 'text';
}
function tokenizeQuestion(q) {
    const tokens = (q || '')
        .toLowerCase()
        .replace(/[`"'\\/\(\)\[\]{}<>,\.;:?\!\|]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    console.log('🧩 [tokenizeQuestion] frontend tokens', { question: q, tokens });
    return tokens;
}
function isNumericToken(tok) {
    if (!tok)
        return false;
    return !isNaN(Number(tok));
}
function quoteIdentifier(id) {
    return '"' + id.replace(/"/g, '""') + '"';
}
exports.quoteIdentifier = quoteIdentifier;
function executeSQL(dbPath, sql) {
    return new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                reject(err);
                return;
            }
        });
        // 处理多条语句或注释等
        const cleanSql = sql
            .trim()
            .replace(/--.*$/gm, '') // 移除单行注释
            .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
            .trim();
        if (!cleanSql) {
            db.close();
            resolve([]);
            return;
        }
        db.all(cleanSql, [], (err, rows) => {
            db.close();
            if (err) {
                console.warn('⚠️ SQL execution error:', err);
                reject(err);
            }
            else {
                // 如果是INSERT, UPDATE, DELETE等修改操作，返回空数组表示成功
                resolve(rows || []);
            }
        });
    });
}
exports.executeSQL = executeSQL;
function rowExists(dbPath, sql, params = []) {
    return new Promise((resolve, reject) => {
        const sqlite3 = require('sqlite3').verbose();
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                reject(err);
                return;
            }
        });
        db.get(sql, params, (err, row) => {
            db.close();
            if (err) {
                reject(err);
            }
            else {
                resolve(!!row);
            }
        });
    });
}
async function hasPartialCellValueMatch(dbPath, tableName, columnName, token) {
    if (!token)
        return false;
    const qTable = quoteIdentifier(tableName);
    const qCol = quoteIdentifier(columnName);
    const sql = `SELECT 1 FROM ${qTable} WHERE ${qCol} LIKE ? OR ${qCol} LIKE ? OR ${qCol} LIKE ? OR ${qCol} LIKE ? LIMIT 1`;
    const params = [
        `${token} %`,
        `% ${token}`,
        `% ${token} %`,
        `${token}`
    ];
    try {
        return await rowExists(dbPath, sql, params);
    }
    catch (error) {
        return false;
    }
}
async function hasExactCellValueMatch(dbPath, tableName, columnName, phrase) {
    if (!phrase)
        return false;
    const qTable = quoteIdentifier(tableName);
    const qCol = quoteIdentifier(columnName);
    const sql = `SELECT 1 FROM ${qTable} WHERE ${qCol} LIKE ? OR ${qCol} LIKE ? OR ${qCol} LIKE ? OR ${qCol} LIKE ? LIMIT 1`;
    const params = [
        `${phrase}`,
        ` ${phrase}`,
        `${phrase} `,
        ` ${phrase} `
    ];
    try {
        return await rowExists(dbPath, sql, params);
    }
    catch (error) {
        return false;
    }
}
async function buildCvLinkFromLocalSQLite(question, dbPath, schema, tables, backendTokens) {
    const tokens = backendTokens && backendTokens.length > 0 ? backendTokens : tokenizeQuestion(question);
    console.log('🔧 [buildCvLinkFromLocalSQLite] using tokens', { question, backendTokens, tokens });
    const num_date_match = {};
    const cell_match = {};
    const tableMap = {};
    tables.forEach((t) => {
        tableMap[t.name] = t;
    });
    for (let colId = 1; colId < schema.column_names.length; colId++) {
        const [tableIdx, colName] = schema.column_names[colId];
        const colType = schema.column_types[colId] || 'text';
        const tableName = schema.table_names_original[tableIdx];
        const table = tableMap[tableName];
        if (!table)
            continue;
        const colEntry = table.columns.find(c => c.name.toLowerCase() === colName.toLowerCase() || c.name === schema.column_names_original[colId][1]);
        if (!colEntry)
            continue;
        const tokenMatched = [];
        for (let qId = 0; qId < tokens.length; qId++) {
            const token = tokens[qId];
            if (!token)
                continue;
            if (isNumericToken(token)) {
                if (colType === 'number' || colType === 'time') {
                    num_date_match[`${qId},${colId}`] = colType.toUpperCase();
                }
                continue;
            }
            const isPartial = await hasPartialCellValueMatch(dbPath, tableName, colEntry.name, token);
            if (isPartial) {
                tokenMatched.push(qId);
            }
        }
        // Compose contiguous token spans to detect exact phrase and partial phrase
        let start = 0;
        while (start < tokenMatched.length) {
            let end = start;
            while (end + 1 < tokenMatched.length && tokenMatched[end + 1] === tokenMatched[end] + 1) {
                end++;
            }
            const phrase = tokens.slice(tokenMatched[start], tokenMatched[end] + 1).join(' ');
            const exact = await hasExactCellValueMatch(dbPath, tableName, colEntry.name, phrase);
            const matchType = exact ? 'EXACTMATCH' : 'PARTIALMATCH';
            for (let idx = tokenMatched[start]; idx <= tokenMatched[end]; idx++) {
                cell_match[`${idx},${colId}`] = matchType;
            }
            start = end + 1;
        }
    }
    const cvLink = {
        num_date_match,
        cell_match
    };
    console.log('🔍 [cv_link] buildCvLinkFromLocalSQLite result', {
        num_date_match_count: Object.keys(num_date_match).length,
        cell_match_count: Object.keys(cell_match).length,
        cvLink: JSON.stringify(cvLink, null, 2)
    });
    return cvLink;
}
exports.buildCvLinkFromLocalSQLite = buildCvLinkFromLocalSQLite;
function buildDailSchemaFromTables(databaseId, tables) {
    const tableNames = tables.map(t => t.name);
    const columnNames = [[-1, '*']];
    const columnNamesOriginal = [[-1, '*']];
    const columnTypes = ['text'];
    const primaryKeys = [];
    const foreignKeys = [];
    const columnIndexByKey = new Map();
    let columnIndex = 1;
    tables.forEach((table, tableIndex) => {
        table.columns.forEach(col => {
            columnIndexByKey.set(`${table.name.toLowerCase()}.${col.name.toLowerCase()}`, columnIndex);
            columnNames.push([tableIndex, col.name.toLowerCase()]);
            columnNamesOriginal.push([tableIndex, col.name]);
            columnTypes.push(mapToDailColumnType(col.type));
            if (col.pk) {
                primaryKeys.push(columnIndex);
            }
            columnIndex += 1;
        });
    });
    tables.forEach((table) => {
        (table.foreignKeys || []).forEach((fk) => {
            const sourceIndex = columnIndexByKey.get(`${table.name.toLowerCase()}.${fk.column.toLowerCase()}`);
            const targetIndex = columnIndexByKey.get(`${fk.refTable.toLowerCase()}.${fk.refColumn.toLowerCase()}`);
            if (typeof sourceIndex === 'number' && typeof targetIndex === 'number') {
                foreignKeys.push([sourceIndex, targetIndex]);
            }
        });
    });
    return {
        db_id: databaseId,
        table_names: tableNames,
        table_names_original: tableNames,
        column_names: columnNames,
        column_names_original: columnNamesOriginal,
        column_types: columnTypes,
        primary_keys: primaryKeys,
        foreign_keys: foreignKeys,
    };
}
exports.buildDailSchemaFromTables = buildDailSchemaFromTables;
// This method is called when the extension is activated
// The extension is activated the very first time the command is executed
function activate(context) {
    console.log('NL2SQL extension is now active!');
    // Register command: Convert Natural Language to SQL (display in new document)
    let convertCommand = vscode.commands.registerCommand('nl2sql.convertQuery', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
            if (selectedText) {
                // Call NL2SQL conversion function, default to car_1 database
                const sqlQuery = await convertNaturalLanguageToSQL(selectedText, 'car_1');
                // Display result in new document
                const doc = await vscode.workspace.openTextDocument({
                    content: sqlQuery,
                    language: 'sql'
                });
                await vscode.window.showTextDocument(doc);
            }
            else {
                vscode.window.showErrorMessage('Please select natural language text to convert');
            }
        }
    });
    // Register command: Replace directly with SQL
    let replaceCommand = vscode.commands.registerCommand('nl2sql.replaceWithSQL', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
            if (selectedText) {
                // Call NL2SQL conversion function, default to car_1 database
                const sqlQuery = await convertNaturalLanguageToSQL(selectedText, 'car_1');
                // Replace selected text directly
                await editor.edit(editBuilder => {
                    editBuilder.replace(selection, sqlQuery);
                });
                vscode.window.showInformationMessage('Natural language converted to SQL and replaced');
            }
            else {
                vscode.window.showErrorMessage('Please select natural language text to convert');
            }
        }
    });
    // Register command: Open NL2SQL panel
    let panelCommand = vscode.commands.registerCommand('nl2sql.openPanel', () => {
        nl2sqlPanel_1.NL2SQLPanel.createOrShow(context.extensionUri, context);
    });
    // Register command: Test DAIL-SQL API connection
    let testApiCommand = vscode.commands.registerCommand('nl2sql.testDailSqlApi', async () => {
        try {
            await testDailSqlApiConnection();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`DAIL-SQL API test failed: ${message}`);
        }
    });
    // Register command: Upload SQLite database to DAIL-SQL
    let uploadDbCommand = vscode.commands.registerCommand('nl2sql.uploadDatabase', async () => {
        try {
            await uploadSQLiteDatabase();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Database upload failed: ${message}`);
        }
    });
    // Register command: Configure MySQL connection
    let mysqlConfigCommand = vscode.commands.registerCommand('nl2sql.configureMysql', async () => {
        const host = await vscode.window.showInputBox({
            prompt: 'Enter MySQL host',
            value: 'localhost'
        });
        if (!host)
            return;
        const port = await vscode.window.showInputBox({
            prompt: 'Enter MySQL port',
            value: '3306'
        });
        if (!port)
            return;
        const username = await vscode.window.showInputBox({
            prompt: 'Enter MySQL username',
            value: 'root'
        });
        if (!username)
            return;
        const password = await vscode.window.showInputBox({
            prompt: 'Enter MySQL password',
            password: true
        });
        if (password === undefined)
            return;
        // Test connection
        const config = {
            host,
            port: parseInt(port),
            user: username,
            password
        };
        console.log('Testing MySQL connection with config:', { host, port, user: username });
        const result = await testMySQLConnection(config);
        if (!result.success) {
            vscode.window.showErrorMessage('Failed to connect to MySQL: ' + (result.error || 'Unknown error'));
            return;
        }
        // Store configuration (securely)
        await context.secrets.store('mysql-host', host);
        await context.secrets.store('mysql-port', port);
        await context.secrets.store('mysql-username', username);
        await context.secrets.store('mysql-password', password);
        vscode.window.showInformationMessage('MySQL connection configured successfully!');
        // Auto refresh database list if panel is open
        if (nl2sqlPanel_1.NL2SQLPanel.currentPanel) {
            console.log('Auto-refreshing database list after MySQL configuration');
            try {
                const databases = await getMySQLDatabases(config);
                nl2sqlPanel_1.NL2SQLPanel.currentPanel._panel.webview.postMessage({
                    command: 'databases',
                    databases: databases.map(name => ({ name, path: name }))
                });
            }
            catch (error) {
                console.error('Error auto-refreshing databases:', error);
            }
        }
    });
    // Register command: Configure PostgreSQL connection
    let pgConfigCommand = vscode.commands.registerCommand('nl2sql.configurePostgres', async () => {
        const host = await vscode.window.showInputBox({ prompt: 'Enter PostgreSQL host', value: 'localhost' });
        if (!host)
            return;
        const port = await vscode.window.showInputBox({ prompt: 'Enter PostgreSQL port', value: '5432' });
        if (!port)
            return;
        const username = await vscode.window.showInputBox({ prompt: 'Enter PostgreSQL username', value: 'postgres' });
        if (!username)
            return;
        const password = await vscode.window.showInputBox({ prompt: 'Enter PostgreSQL password', password: true });
        if (password === undefined)
            return;
        const config = { host, port: parseInt(port), user: username, password };
        // Test connection
        console.log('Testing Postgres connection with config:', { host, port, user: username });
        const result = await testPostgresConnection(config);
        if (!result.success) {
            vscode.window.showErrorMessage('Failed to connect to PostgreSQL: ' + (result.error || 'Unknown error'));
            return;
        }
        // Store configuration securely
        await context.secrets.store('pg-host', host);
        await context.secrets.store('pg-port', port);
        await context.secrets.store('pg-username', username);
        await context.secrets.store('pg-password', password);
        vscode.window.showInformationMessage('PostgreSQL connection configured successfully!');
        if (nl2sqlPanel_1.NL2SQLPanel.currentPanel) {
            try {
                const databases = await getPostgresDatabases(config);
                nl2sqlPanel_1.NL2SQLPanel.currentPanel._panel.webview.postMessage({ command: 'databases', databases: databases.map(name => ({ name, path: name })) });
            }
            catch (error) {
                console.error('Error auto-refreshing Postgres databases:', error);
            }
        }
    });
    context.subscriptions.push(convertCommand);
    context.subscriptions.push(replaceCommand);
    context.subscriptions.push(panelCommand);
    context.subscriptions.push(mysqlConfigCommand);
    context.subscriptions.push(pgConfigCommand);
    context.subscriptions.push(testApiCommand);
    context.subscriptions.push(uploadDbCommand);
}
exports.activate = activate;
// This method is called when your extension is deactivated
function deactivate() { }
exports.deactivate = deactivate;
// SQLite helper functions
async function findSQLiteFiles() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }
    const sqliteFiles = [];
    for (const folder of workspaceFolders) {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.{db,sqlite,sqlite3}'), null
        // No file limit - will find all SQLite files
        );
        sqliteFiles.push(...files.map(file => file.fsPath));
    }
    return sqliteFiles;
}
exports.findSQLiteFiles = findSQLiteFiles;
async function readSQLiteSchema(dbPath) {
    return new Promise((resolve, reject) => {
        try {
            const sqlite3 = require('sqlite3').verbose();
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
            });
            // Get all table names
            db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], (err, tables) => {
                if (err) {
                    db.close();
                    reject(err);
                    return;
                }
                const tablePromises = tables.map((table) => {
                    return new Promise((resolveTable, rejectTable) => {
                        // Get columns for each table
                        db.all(`PRAGMA table_info(${table.name})`, [], (err, columns) => {
                            if (err) {
                                rejectTable(err);
                                return;
                            }
                            const sqliteColumns = columns.map(col => ({
                                name: col.name,
                                type: col.type,
                                notnull: col.notnull === 1,
                                pk: col.pk === 1,
                                values: []
                            }));
                            // Fetch sample values for each column to support cv_link generation
                            const valuePromises = sqliteColumns.map((col) => {
                                return new Promise((resolveCol, rejectCol) => {
                                    const safeColName = `"${col.name.replace(/"/g, '')}"`;
                                    db.all(`SELECT DISTINCT ${safeColName} AS val FROM \"${table.name.replace(/\"/g, '')}\" WHERE ${safeColName} IS NOT NULL LIMIT 200`, [], (valErr, valRows) => {
                                        if (valErr) {
                                            col.values = [];
                                            return resolveCol();
                                        }
                                        col.values = valRows
                                            .map((r) => (r.val === null || r.val === undefined ? '' : String(r.val).trim()))
                                            .filter((v) => v.length > 0)
                                            .slice(0, 200);
                                        resolveCol();
                                    });
                                });
                            });
                            db.all(`PRAGMA foreign_key_list(${table.name})`, [], (fkErr, fkRows) => {
                                const foreignKeys = (fkRows || []).map((fk) => ({
                                    column: fk.from,
                                    refTable: fk.table,
                                    refColumn: fk.to
                                }));
                                Promise.all(valuePromises)
                                    .then(() => {
                                    resolveTable({
                                        name: table.name,
                                        columns: sqliteColumns,
                                        foreignKeys
                                    });
                                })
                                    .catch((e) => {
                                    console.error('Error fetching sample values for table', table.name, e);
                                    resolveTable({
                                        name: table.name,
                                        columns: sqliteColumns,
                                        foreignKeys
                                    });
                                });
                            });
                        });
                    });
                });
                Promise.all(tablePromises)
                    .then(result => {
                    db.close();
                    resolve(result);
                })
                    .catch(err => {
                    db.close();
                    reject(err);
                });
            });
        }
        catch (error) {
            reject(error);
        }
    });
}
exports.readSQLiteSchema = readSQLiteSchema;
// MySQL helper functions
async function getMySQLDatabases(config) {
    return new Promise((resolve, reject) => {
        try {
            console.log('Getting MySQL databases for:', config.host);
            const mysql = require('mysql2');
            const connection = mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.user,
                password: config.password,
                connectTimeout: 5000
            });
            connection.connect((err) => {
                if (err) {
                    console.error('Connection error in getMySQLDatabases:', err);
                    reject(new Error('Connection failed: ' + (err.message || err.code)));
                    return;
                }
                console.log('Connected, fetching databases...');
            });
            connection.query('SHOW DATABASES', (err, results) => {
                connection.end();
                if (err) {
                    console.error('Query error in getMySQLDatabases:', err);
                    reject(new Error('Query failed: ' + (err.message || err.code)));
                    return;
                }
                console.log('Raw database results:', results);
                const databases = results
                    .map((row) => row.Database)
                    .filter((db) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(db));
                console.log('Filtered databases:', databases);
                resolve(databases);
            });
        }
        catch (error) {
            console.error('Exception in getMySQLDatabases:', error);
            reject(error);
        }
    });
}
exports.getMySQLDatabases = getMySQLDatabases;
async function readMySQLSchema(config) {
    return new Promise((resolve, reject) => {
        try {
            const mysql = require('mysql2');
            const connection = mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.user,
                password: config.password,
                database: config.database
            });
            connection.connect((err) => {
                if (err) {
                    reject(err);
                    return;
                }
            });
            // Get all table names
            connection.query('SHOW TABLES', (err, tables) => {
                if (err) {
                    connection.end();
                    reject(err);
                    return;
                }
                const tableKey = `Tables_in_${config.database}`;
                const tablePromises = tables.map((tableRow) => {
                    const tableName = tableRow[tableKey];
                    return new Promise((resolveTable, rejectTable) => {
                        // Get columns for each table
                        connection.query(`DESCRIBE ${tableName}`, (err, columns) => {
                            if (err) {
                                rejectTable(err);
                                return;
                            }
                            const mysqlColumns = columns.map(col => ({
                                name: col.Field,
                                type: col.Type,
                                notnull: col.Null === 'NO',
                                pk: col.Key === 'PRI',
                                values: []
                            }));
                            connection.query(`SELECT kcu.COLUMN_NAME AS column_name, kcu.REFERENCED_TABLE_NAME AS ref_table, kcu.REFERENCED_COLUMN_NAME AS ref_column
                                 FROM information_schema.KEY_COLUMN_USAGE kcu
                                 INNER JOIN information_schema.TABLE_CONSTRAINTS tc
                                    ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                                   AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
                                 WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
                                   AND tc.TABLE_SCHEMA = ?
                                   AND tc.TABLE_NAME = ?`, [config.database, tableName], (fkErr, fkRows) => {
                                const foreignKeys = (fkRows || [])
                                    .filter((fk) => fk.column_name && fk.ref_table && fk.ref_column)
                                    .map((fk) => ({
                                    column: fk.column_name,
                                    refTable: fk.ref_table,
                                    refColumn: fk.ref_column
                                }));
                                // For each column, fetch a small set of distinct sample values (limit 200)
                                const valuePromises = mysqlColumns.map((col) => {
                                    return new Promise((resolveCol) => {
                                        const safeCol = `\`${col.name.replace(/`/g, '')}\``;
                                        const safeTable = `\`${tableName.replace(/`/g, '')}\``;
                                        const sampleSql = `SELECT DISTINCT ${safeCol} AS val FROM ${safeTable} WHERE ${safeCol} IS NOT NULL LIMIT 200`;
                                        connection.query(sampleSql, (valErr, valRows) => {
                                            if (valErr) {
                                                col.values = [];
                                                return resolveCol();
                                            }
                                            try {
                                                col.values = (valRows || [])
                                                    .map((r) => (r.val === null || r.val === undefined ? '' : String(r.val).trim()))
                                                    .filter((v) => v.length > 0)
                                                    .slice(0, 200);
                                            }
                                            catch (ex) {
                                                col.values = [];
                                            }
                                            resolveCol();
                                        });
                                    });
                                });
                                Promise.all(valuePromises)
                                    .then(() => {
                                    resolveTable({
                                        name: tableName,
                                        columns: mysqlColumns,
                                        foreignKeys
                                    });
                                })
                                    .catch(() => {
                                    resolveTable({
                                        name: tableName,
                                        columns: mysqlColumns,
                                        foreignKeys
                                    });
                                });
                            });
                        });
                    });
                });
                Promise.all(tablePromises)
                    .then(result => {
                    connection.end();
                    resolve(result);
                })
                    .catch(err => {
                    connection.end();
                    reject(err);
                });
            });
        }
        catch (error) {
            reject(error);
        }
    });
}
exports.readMySQLSchema = readMySQLSchema;
async function testMySQLConnection(config) {
    return new Promise((resolve) => {
        try {
            console.log('Testing MySQL connection to:', config.host, ':', config.port);
            const mysql = require('mysql2');
            const connection = mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.user,
                password: config.password,
                connectTimeout: 5000,
                acquireTimeout: 5000,
                timeout: 5000
            });
            connection.connect((err) => {
                if (err) {
                    console.error('MySQL connection error:', err.code, err.message);
                    connection.destroy();
                    let errorMessage = 'Connection failed: ';
                    switch (err.code) {
                        case 'ECONNREFUSED':
                            errorMessage += 'Connection refused. Make sure MySQL server is running on ' + config.host + ':' + config.port;
                            break;
                        case 'ER_ACCESS_DENIED_ERROR':
                            errorMessage += 'Access denied. Check username and password.';
                            break;
                        case 'ENOTFOUND':
                            errorMessage += 'Host not found. Check hostname: ' + config.host;
                            break;
                        case 'ETIMEDOUT':
                            errorMessage += 'Connection timeout. Check if MySQL server is accessible.';
                            break;
                        default:
                            errorMessage += err.message || err.code;
                    }
                    resolve({ success: false, error: errorMessage });
                    return;
                }
                console.log('MySQL connection successful');
                connection.end();
                resolve({ success: true });
            });
        }
        catch (error) {
            console.error('MySQL test connection exception:', error);
            resolve({ success: false, error: 'Exception: ' + error.message });
        }
    });
}
// Get stored MySQL configuration
async function getMySQLConfig(context) {
    try {
        const host = await context.secrets.get('mysql-host');
        const port = await context.secrets.get('mysql-port');
        const user = await context.secrets.get('mysql-username');
        const password = await context.secrets.get('mysql-password');
        if (!host || !port || !user || password === undefined) {
            return null;
        }
        return {
            host,
            port: parseInt(port),
            user,
            password
        };
    }
    catch (error) {
        return null;
    }
}
exports.getMySQLConfig = getMySQLConfig;
// Get DAIL-SQL API configuration from VS Code settings
async function getDailSQLConfig(context) {
    const config = vscode.workspace.getConfiguration('nl2sql');
    return {
        apiUrl: config.get('dailsql.apiUrl') || 'http://localhost:8000',
        timeout: config.get('dailsql.timeout') || 300000
    };
}
// DAIL-SQL API client function
async function convertNaturalLanguageToSQL(naturalLanguage, database = 'mysql', schema) {
    try {
        // Get DAIL-SQL configuration from VS Code settings
        const config = vscode.workspace.getConfiguration('nl2sql');
        const apiUrl = config.get('dailsql.apiUrl') || 'http://localhost:8000';
        const timeout = config.get('dailsql.timeout') || 300000;
        // Check if DAIL-SQL service is available
        try {
            await axios_1.default.get(`${apiUrl}/api/v1/health`, { timeout: 5000 });
        }
        catch (error) {
            console.warn('DAIL-SQL service not available, falling back to template matching');
            return await fallbackConvertNaturalLanguageToSQL(naturalLanguage, database, schema);
        }
        // 测试数据库列表获取
        try {
            const dbListResponse = await axios_1.default.get(`${apiUrl}/api/v1/databases`, { timeout: 5000 });
            console.log('🔍 Available databases from DAIL-SQL server:', dbListResponse.data);
            // 检查请求的数据库是否存在
            const availableDbs = dbListResponse.data || [];
            const requestedDb = database || 'car_1';
            const dbExists = availableDbs.some((db) => db.database_id === requestedDb);
            if (!dbExists) {
                const availableIds = availableDbs.map((db) => db.database_id).join(', ');
                console.error(`❌ Database '${requestedDb}' not found in server configuration`);
                console.error('📋 Available databases on server:', availableDbs.map((db) => ({ id: db.database_id, tables: db.tables?.length || 0, description: db.description })));
                vscode.window.showWarningMessage(`Database '${requestedDb}' not available on DAIL-SQL server.\n` +
                    `Available databases: ${availableIds || 'None'}\n` +
                    `请检查DAIL-SQL服务器的数据库配置。\n` +
                    `使用模板匹配作为后备方案。`, { modal: false } // Changed to non-modal to avoid blocking
                );
                return await fallbackConvertNaturalLanguageToSQL(naturalLanguage, database, schema);
            }
            else {
                const dbInfo = availableDbs.find((db) => db.database_id === requestedDb);
                console.log(`✅ Database '${requestedDb}' confirmed available with ${dbInfo?.tables?.length || 0} tables`);
            }
        }
        catch (error) {
            console.warn('⚠️ Could not fetch database list, proceeding with request:', error);
        }
        // Prepare request data with configurable parameters
        const requestData = {
            question: naturalLanguage,
            database_id: database || 'car_1'
        };
        // 添加可选参数（从VS Code设置中获取，如果没有则不添加）
        const model = config.get('dailsql.model');
        const temperature = config.get('dailsql.temperature');
        const maxRetries = config.get('dailsql.maxRetries');
        const kShot = config.get('dailsql.kShot');
        const useSelfConsistency = config.get('dailsql.useSelfConsistency');
        const nCandidates = config.get('dailsql.nCandidates');
        if (model)
            requestData.model = model;
        if (temperature !== undefined)
            requestData.temperature = temperature;
        if (maxRetries !== undefined)
            requestData.max_retries = maxRetries;
        if (kShot !== undefined)
            requestData.k_shot = kShot;
        if (useSelfConsistency !== undefined)
            requestData.use_self_consistency = useSelfConsistency;
        if (nCandidates !== undefined)
            requestData.n_candidates = nCandidates;
        // Debug: Log the request being sent
        console.log('DAIL-SQL API Request Details:');
        console.log('  URL:', `${apiUrl}/api/v1/text-to-sql`);
        console.log('  Question:', naturalLanguage);
        console.log('  Database parameter (input):', database);
        console.log('  Database_id (final):', requestData.database_id);
        console.log('  Request headers:', {
            'Content-Type': 'application/json',
            'User-Agent': 'VSCode-NL2SQL-Extension'
        });
        console.log('  Full request data:', JSON.stringify(requestData, null, 2));
        console.log('  Request data size:', JSON.stringify(requestData).length, 'bytes');
        // 验证请求数据
        if (!requestData.question || requestData.question.trim() === '') {
            throw new Error('Question cannot be empty');
        }
        if (!requestData.database_id || requestData.database_id.trim() === '') {
            throw new Error('Database ID cannot be empty');
        }
        // Call DAIL-SQL API with detailed configuration
        const axiosConfig = {
            timeout: timeout,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'VSCode-NL2SQL-Extension/0.0.1'
            },
            // 确保请求体被正确序列化
            transformRequest: [(data) => {
                    const serialized = JSON.stringify(data);
                    console.log('Final serialized request:', serialized);
                    return serialized;
                }],
            // 响应拦截器
            transformResponse: [(data) => {
                    console.log('Raw response received:', typeof data, data);
                    try {
                        return typeof data === 'string' ? JSON.parse(data) : data;
                    }
                    catch (e) {
                        console.error('Failed to parse response as JSON:', e);
                        return data;
                    }
                }]
        };
        console.log('Making request with config:', axiosConfig);
        const response = await axios_1.default.post(`${apiUrl}/api/v1/text-to-sql`, requestData, axiosConfig);
        // Debug: Log the actual response
        console.log('DAIL-SQL API Response Details:');
        console.log('  Status:', response.status);
        console.log('  Success:', response.data?.success);
        console.log('  Processing steps count:', response.data?.processing_steps?.length || 0);
        console.log('  Processing steps:', response.data?.processing_steps || []);
        console.log('  SQL result:', response.data?.best_sql || 'None');
        console.log('  Error:', response.data?.error || 'None');
        console.log('  Attempts:', response.data?.attempts || 0);
        console.log('  Execution time:', response.data?.execution_time || 0);
        console.log('  Full response:', JSON.stringify(response.data, null, 2));
        // 详细分析失败原因
        if (!response.data?.success) {
            console.error('DAIL-SQL API 失败分析:');
            console.error('  - 数据库验证:', response.data?.processing_steps?.includes('✅ 验证数据库') ? '成功' : '失败');
            console.error('  - 处理步骤数量:', response.data?.processing_steps?.length || 0);
            console.error('  - 错误信息:', response.data?.error || '无错误信息');
            console.error('  - 尝试次数:', response.data?.attempts || 0);
            if (response.data?.processing_steps?.length === 1) {
                console.error('  -> 可能原因: LLM配置问题（API密钥、模型配置等）');
            }
        }
        if (response.data && response.data.success && response.data.best_sql) {
            // 直接返回干净的SQL，不添加任何注释
            return response.data.best_sql;
        }
        else {
            console.error('DAIL-SQL API Error Response:', response.data);
            throw new Error('Invalid response from DAIL-SQL API: ' + (response.data?.error || JSON.stringify(response.data)));
        }
    }
    catch (error) {
        console.error('Error calling DAIL-SQL API:', error);
        // Fallback to template matching if API fails
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showWarningMessage(`DAIL-SQL API failed (${errorMessage}), using template matching instead`);
        return await fallbackConvertNaturalLanguageToSQL(naturalLanguage, database, schema);
    }
}
exports.convertNaturalLanguageToSQL = convertNaturalLanguageToSQL;
// Fallback template-based conversion function (original logic)
async function fallbackConvertNaturalLanguageToSQL(naturalLanguage, database = 'mysql', schema) {
    const input = naturalLanguage.toLowerCase();
    let sql = '';
    // Generate different SQL syntax based on database type
    const dbSyntax = {
        mysql: {
            limit: 'LIMIT',
            quote: '`',
            autoIncrement: 'AUTO_INCREMENT',
            now: 'NOW()'
        },
        postgresql: {
            limit: 'LIMIT',
            quote: '"',
            autoIncrement: 'SERIAL',
            now: 'CURRENT_TIMESTAMP'
        },
        sqlite: {
            limit: 'LIMIT',
            quote: '"',
            autoIncrement: 'AUTOINCREMENT',
            now: "datetime('now')"
        },
        sqlserver: {
            limit: 'TOP',
            quote: '[',
            autoIncrement: 'IDENTITY',
            now: 'GETDATE()'
        },
        oracle: {
            limit: 'ROWNUM <=',
            quote: '"',
            autoIncrement: 'AUTO_INCREMENT',
            now: 'SYSDATE'
        },
        mongodb: {
            limit: 'limit()',
            quote: '',
            autoIncrement: '_id',
            now: 'new Date()'
        }
    };
    const syntax = dbSyntax[database] || dbSyntax.mysql;
    // Smart table and column matching using schema
    let targetTable = '';
    let availableColumns = [];
    if (schema && schema.length > 0) {
        // Try to find matching table based on natural language
        const input = naturalLanguage.toLowerCase();
        for (const table of schema) {
            const tableName = table.name.toLowerCase();
            if (input.includes(tableName) ||
                input.includes(tableName.replace(/s$/, '')) || // singular form
                input.includes(tableName + 's')) { // plural form
                targetTable = table.name;
                availableColumns = table.columns.map(col => col.name);
                break;
            }
        }
        // If no specific table found, use the first table as default
        if (!targetTable && schema.length > 0) {
            targetTable = schema[0].name;
            availableColumns = schema[0].columns.map(col => col.name);
        }
    }
    // Query related keywords
    if (input.includes('query') || input.includes('get') || input.includes('find') || input.includes('select') ||
        input.includes('fetch') || input.includes('retrieve')) {
        if (input.includes('user') || input.includes('users') || input.includes('customer') || input.includes('customers')) {
            if (input.includes('name') && input.includes('email')) {
                sql = database === 'mongodb'
                    ? `// ${naturalLanguage}\ndb.users.find({}, {name: 1, email: 1});`
                    : `-- ${naturalLanguage}\nSELECT ${syntax.quote}name${syntax.quote === '[' ? ']' : syntax.quote}, ${syntax.quote}email${syntax.quote === '[' ? ']' : syntax.quote}\nFROM ${syntax.quote}users${syntax.quote === '[' ? ']' : syntax.quote};`;
            }
            else {
                sql = database === 'mongodb'
                    ? `// ${naturalLanguage}\ndb.users.find({});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}users${syntax.quote === '[' ? ']' : syntax.quote};`;
            }
        }
        else if (input.includes('order') || input.includes('orders') || input.includes('purchase')) {
            if (input.includes('recent') || input.includes('30 days') || input.includes('week') || input.includes('last')) {
                sql = database === 'mongodb'
                    ? `// ${naturalLanguage}\ndb.orders.find({created_at: {$gte: new Date(Date.now() - 30*24*60*60*1000)}});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}orders${syntax.quote === '[' ? ']' : syntax.quote}\nWHERE ${syntax.quote}created_at${syntax.quote === '[' ? ']' : syntax.quote} >= DATE_SUB(${syntax.now}, INTERVAL 30 DAY);`;
            }
            else {
                sql = database === 'mongodb'
                    ? `// ${naturalLanguage}\ndb.orders.find({});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}orders${syntax.quote === '[' ? ']' : syntax.quote};`;
            }
        }
        else if (input.includes('product') || input.includes('products') || input.includes('item')) {
            if (input.includes('price') && (input.includes('greater') || input.includes('more than') || input.includes('above'))) {
                sql = database === 'mongodb'
                    ? `// ${naturalLanguage}\ndb.products.find({price: {$gt: 100}});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}products${syntax.quote === '[' ? ']' : syntax.quote}\nWHERE ${syntax.quote}price${syntax.quote === '[' ? ']' : syntax.quote} > 100;`;
            }
            else {
                sql = database === 'mongodb'
                    ? `// ${naturalLanguage}\ndb.products.find({});`
                    : `-- ${naturalLanguage}\nSELECT *\nFROM ${syntax.quote}products${syntax.quote === '[' ? ']' : syntax.quote};`;
            }
        }
    }
    // Statistics related keywords
    if (input.includes('count') || input.includes('statistics') || input.includes('total') || input.includes('sum')) {
        if (input.includes('category') || input.includes('department') || input.includes('group') || input.includes('type')) {
            sql = database === 'mongodb'
                ? `// ${naturalLanguage}\ndb.products.aggregate([{$group: {_id: "$category", count: {$sum: 1}}}]);`
                : `-- ${naturalLanguage}\nSELECT ${syntax.quote}category${syntax.quote === '[' ? ']' : syntax.quote}, COUNT(*) as count\nFROM ${syntax.quote}products${syntax.quote === '[' ? ']' : syntax.quote}\nGROUP BY ${syntax.quote}category${syntax.quote === '[' ? ']' : syntax.quote};`;
        }
    }
    // Insert related keywords
    if (input.includes('insert') || input.includes('add') || input.includes('create') || input.includes('new')) {
        if (input.includes('用户') || input.includes('user')) {
            sql = database === 'mongodb'
                ? `// ${naturalLanguage}\ndb.users.insertOne({name: "New User", email: "user@example.com", created_at: new Date()});`
                : `-- ${naturalLanguage}\nINSERT INTO ${syntax.quote}users${syntax.quote === '[' ? ']' : syntax.quote} (${syntax.quote}name${syntax.quote === '[' ? ']' : syntax.quote}, ${syntax.quote}email${syntax.quote === '[' ? ']' : syntax.quote}, ${syntax.quote}created_at${syntax.quote === '[' ? ']' : syntax.quote})\nVALUES ('New User', 'user@example.com', ${syntax.now});`;
        }
        else {
            sql = database === 'mongodb'
                ? `// ${naturalLanguage}\ndb.collection.insertOne({field1: "value1", field2: "value2"});`
                : `-- ${naturalLanguage}\nINSERT INTO ${syntax.quote}table_name${syntax.quote === '[' ? ']' : syntax.quote} (${syntax.quote}column1${syntax.quote === '[' ? ']' : syntax.quote}, ${syntax.quote}column2${syntax.quote === '[' ? ']' : syntax.quote})\nVALUES ('value1', 'value2');`;
        }
    }
    // Update related keywords
    if (input.includes('update') || input.includes('modify') || input.includes('change') || input.includes('edit')) {
        if (input.includes('email') || input.includes('mail') || input.includes('address')) {
            sql = database === 'mongodb'
                ? `// ${naturalLanguage}\ndb.users.updateOne({_id: ObjectId("user_id")}, {$set: {email: "new@example.com"}});`
                : `-- ${naturalLanguage}\nUPDATE ${syntax.quote}users${syntax.quote === '[' ? ']' : syntax.quote}\nSET ${syntax.quote}email${syntax.quote === '[' ? ']' : syntax.quote} = 'new@example.com'\nWHERE ${syntax.quote}id${syntax.quote === '[' ? ']' : syntax.quote} = 1;`;
        }
        else {
            sql = database === 'mongodb'
                ? `// ${naturalLanguage}\ndb.collection.updateOne({condition}, {$set: {field: "new_value"}});`
                : `-- ${naturalLanguage}\nUPDATE ${syntax.quote}table_name${syntax.quote === '[' ? ']' : syntax.quote}\nSET ${syntax.quote}column1${syntax.quote === '[' ? ']' : syntax.quote} = 'new_value'\nWHERE condition;`;
        }
    }
    // Delete related keywords
    if (input.includes('delete') || input.includes('remove') || input.includes('drop')) {
        if (input.includes('expired') || input.includes('cancelled') || input.includes('inactive') || input.includes('deleted')) {
            sql = database === 'mongodb'
                ? `// ${naturalLanguage}\ndb.orders.deleteMany({status: "cancelled"});`
                : `-- ${naturalLanguage}\nDELETE FROM ${syntax.quote}orders${syntax.quote === '[' ? ']' : syntax.quote}\nWHERE ${syntax.quote}status${syntax.quote === '[' ? ']' : syntax.quote} = 'cancelled';`;
        }
        else {
            sql = database === 'mongodb'
                ? `// ${naturalLanguage}\ndb.collection.deleteOne({condition});`
                : `-- ${naturalLanguage}\nDELETE FROM ${syntax.quote}table_name${syntax.quote === '[' ? ']' : syntax.quote}\nWHERE condition;`;
        }
    }
    // If no patterns matched
    if (!sql) {
        sql = database === 'mongodb'
            ? `// ${naturalLanguage}\n// Sorry, unable to recognize this query. Please provide more specific description.\ndb.collection.find({});`
            : `-- ${naturalLanguage}\n-- Sorry, unable to recognize this query. Please provide more specific description.\nSELECT * FROM ${syntax.quote}table_name${syntax.quote === '[' ? ']' : syntax.quote};`;
    }
    return sql;
}
// SQL to Natural Language conversion function
async function convertSQLToNaturalLanguage(sql, database = 'mysql') {
    const sqlLower = sql.toLowerCase().trim();
    // Remove comments and extra whitespace
    const cleanSQL = sqlLower.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    // SELECT query parsing
    if (cleanSQL.includes('select')) {
        let description = 'Query';
        // Parse table name
        const fromMatch = cleanSQL.match(/from\s+[`"']?(\w+)[`"']?/);
        const tableName = fromMatch ? fromMatch[1] : 'table';
        // Parse fields
        const selectMatch = cleanSQL.match(/select\s+(.*?)\s+from/);
        const fields = selectMatch ? selectMatch[1].trim() : '*';
        if (fields === '*') {
            description += ` all information from ${tableName} table`;
        }
        else if (fields.includes('count')) {
            description += ` count of records from ${tableName} table`;
        }
        else {
            const fieldList = fields.split(',').map(f => f.trim().replace(/[`"'\[\]]/g, ''));
            description += ` ${fieldList.join(', ')} fields from ${tableName} table`;
        }
        // Parse WHERE conditions
        if (cleanSQL.includes('where')) {
            const whereMatch = cleanSQL.match(/where\s+(.*?)(?:\s+group|\s+order|\s+limit|$)/);
            if (whereMatch) {
                const condition = whereMatch[1].trim();
                if (condition.includes('>') && condition.includes('price')) {
                    const priceMatch = condition.match(/price\s*>\s*(\d+)/);
                    if (priceMatch) {
                        description += `, where price is greater than ${priceMatch[1]}`;
                    }
                }
                else if (condition.includes('age')) {
                    description += ', filtered by age condition';
                }
                else if (condition.includes('status')) {
                    if (condition.includes('cancelled') || condition.includes('canceled')) {
                        description += ', where status is cancelled';
                    }
                    else {
                        description += ', filtered by status condition';
                    }
                }
                else if (condition.includes('created_at') || condition.includes('date')) {
                    description += ', filtered by date condition';
                }
                else {
                    description += ', with specific conditions';
                }
            }
        }
        // Parse GROUP BY
        if (cleanSQL.includes('group by')) {
            const groupMatch = cleanSQL.match(/group\s+by\s+[`"']?(\w+)[`"']?/);
            if (groupMatch) {
                description += `, grouped by ${groupMatch[1]}`;
            }
        }
        // Parse ORDER BY
        if (cleanSQL.includes('order by')) {
            if (cleanSQL.includes('desc')) {
                description += ', ordered in descending order';
            }
            else {
                description += ', ordered in ascending order';
            }
        }
        // Parse LIMIT
        if (cleanSQL.includes('limit')) {
            const limitMatch = cleanSQL.match(/limit\s+(\d+)/);
            if (limitMatch) {
                description += `, limited to ${limitMatch[1]} records`;
            }
        }
        return description;
    }
    // INSERT parsing
    if (cleanSQL.includes('insert')) {
        const tableMatch = cleanSQL.match(/insert\s+into\s+[`"']?(\w+)[`"']?/);
        const tableName = tableMatch ? tableMatch[1] : 'table';
        if (tableName === 'users' || tableName.includes('user')) {
            return `Insert new user record into users table`;
        }
        else if (tableName === 'orders' || tableName.includes('order')) {
            return `Add new order information to orders table`;
        }
        else if (tableName === 'products' || tableName.includes('product')) {
            return `Add new product information to products table`;
        }
        else {
            return `Insert new data record into ${tableName} table`;
        }
    }
    // UPDATE parsing
    if (cleanSQL.includes('update')) {
        const tableMatch = cleanSQL.match(/update\s+[`"']?(\w+)[`"']?/);
        const tableName = tableMatch ? tableMatch[1] : 'table';
        let description = `Update data in ${tableName} table`;
        // Check SET fields
        if (cleanSQL.includes('email')) {
            description += ', modify email address';
        }
        else if (cleanSQL.includes('password')) {
            description += ', modify password';
        }
        else if (cleanSQL.includes('status')) {
            description += ', modify status';
        }
        else if (cleanSQL.includes('name')) {
            description += ', modify name information';
        }
        // Check WHERE conditions
        if (cleanSQL.includes('where')) {
            description += ', for records that meet the condition';
        }
        return description;
    }
    // DELETE parsing
    if (cleanSQL.includes('delete')) {
        const fromMatch = cleanSQL.match(/from\s+[`"']?(\w+)[`"']?/);
        const tableName = fromMatch ? fromMatch[1] : 'table';
        let description = `Delete data from ${tableName} table`;
        if (cleanSQL.includes('where')) {
            if (cleanSQL.includes('status') && (cleanSQL.includes('cancelled') || cleanSQL.includes('canceled'))) {
                description += ', delete cancelled records';
            }
            else if (cleanSQL.includes('expired')) {
                description += ', delete expired records';
            }
            else {
                description += ', delete records that meet the condition';
            }
        }
        else {
            description += ', clear all records';
        }
        return description;
    }
    // CREATE TABLE parsing
    if (cleanSQL.includes('create table')) {
        const tableMatch = cleanSQL.match(/create\s+table\s+[`"']?(\w+)[`"']?/);
        const tableName = tableMatch ? tableMatch[1] : 'table';
        return `Create new data table named ${tableName}`;
    }
    // DROP TABLE parsing
    if (cleanSQL.includes('drop table')) {
        const tableMatch = cleanSQL.match(/drop\s+table\s+[`"']?(\w+)[`"']?/);
        const tableName = tableMatch ? tableMatch[1] : 'table';
        return `Delete data table named ${tableName}`;
    }
    // MongoDB query parsing
    if (database === 'mongodb') {
        if (cleanSQL.includes('.find(')) {
            if (cleanSQL.includes('users')) {
                return 'Query documents from users collection';
            }
            else if (cleanSQL.includes('orders')) {
                return 'Query documents from orders collection';
            }
            else {
                return 'Query documents from collection';
            }
        }
        if (cleanSQL.includes('.insertone(')) {
            return 'Insert single document into collection';
        }
        if (cleanSQL.includes('.updateone(')) {
            return 'Update single document in collection';
        }
        if (cleanSQL.includes('.deleteone(') || cleanSQL.includes('.deletemany(')) {
            return 'Delete documents from collection';
        }
        if (cleanSQL.includes('.aggregate(')) {
            return 'Execute aggregation query on collection';
        }
    }
    // Default return
    return `Execute database operation: ${sql.substring(0, 50)}${sql.length > 50 ? '...' : ''}`;
}
exports.convertSQLToNaturalLanguage = convertSQLToNaturalLanguage;
// NL2SQL Panel class
// Test DAIL-SQL API connection function
async function testDailSqlApiConnection() {
    const config = vscode.workspace.getConfiguration('nl2sql');
    const apiUrl = config.get('dailsql.apiUrl') || 'http://localhost:8000';
    try {
        vscode.window.showInformationMessage('🔍 Testing DAIL-SQL API connection...');
        // Test health endpoint
        console.log('Testing DAIL-SQL health endpoint...');
        const healthResponse = await axios_1.default.get(`${apiUrl}/api/v1/health`, { timeout: 10000 });
        console.log('Health check response:', healthResponse.data);
        // Test database list endpoint
        console.log('Testing DAIL-SQL database list endpoint...');
        const dbResponse = await axios_1.default.get(`${apiUrl}/api/v1/databases`, { timeout: 10000 });
        console.log('Database list response:', dbResponse.data);
        const availableDbs = dbResponse.data || [];
        const dbList = availableDbs.map((db) => ({
            id: db.database_id,
            tables: db.tables?.length || 0,
            description: db.description || 'No description'
        }));
        // Check for car_1 database specifically
        const car1Db = availableDbs.find((db) => db.database_id === 'car_1');
        // Test a simple query if car_1 is available
        let queryResult = null;
        if (car1Db) {
            console.log('Testing DAIL-SQL text-to-sql endpoint with car_1...');
            const testQuery = {
                question: "How many tables are in this database?",
                database_id: "car_1"
            };
            try {
                const queryResponse = await axios_1.default.post(`${apiUrl}/api/v1/text-to-sql`, testQuery, {
                    timeout: 300000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                });
                console.log('Test query response:', JSON.stringify(queryResponse.data, null, 2));
                queryResult = queryResponse.data;
            }
            catch (queryError) {
                console.error('Query test failed:', queryError);
                queryResult = { success: false, error: 'Query test failed' };
            }
        }
        // Create comprehensive status report
        const statusReport = [
            '🔗 DAIL-SQL API Connection Status',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `📡 Server: ${apiUrl}`,
            `✅ Health Check: ${healthResponse.status === 200 ? 'OK' : 'FAILED'}`,
            `📊 Databases Available: ${availableDbs.length}`,
            ''
        ];
        if (availableDbs.length > 0) {
            statusReport.push('📋 Database List:');
            dbList.forEach((db) => {
                statusReport.push(`  • ${db.id} (${db.tables} tables) - ${db.description}`);
            });
            statusReport.push('');
        }
        else {
            statusReport.push('⚠️ No databases found in server configuration!');
            statusReport.push('');
        }
        // Car_1 specific status
        if (car1Db) {
            statusReport.push('🚗 car_1 Database Status:');
            statusReport.push(`  • Found: YES`);
            statusReport.push(`  • Tables: ${car1Db.tables?.length || 0}`);
            statusReport.push(`  • Table Names: ${car1Db.tables?.join(', ') || 'Unknown'}`);
            if (queryResult) {
                statusReport.push(`  • Query Test: ${queryResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
                if (queryResult.success) {
                    statusReport.push(`  • Generated SQL: ${queryResult.best_sql || 'None'}`);
                    statusReport.push(`  • Processing Steps: ${queryResult.processing_steps?.length || 0}`);
                }
                else {
                    statusReport.push(`  • Error: ${queryResult.error || 'Unknown error'}`);
                    if (queryResult.processing_steps) {
                        statusReport.push(`  • Steps Completed: ${queryResult.processing_steps.length}`);
                        queryResult.processing_steps.forEach((step, i) => {
                            statusReport.push(`    ${i + 1}. ${step}`);
                        });
                    }
                }
            }
        }
        else {
            statusReport.push('🚗 car_1 Database Status:');
            statusReport.push('  • Found: ❌ NO');
            statusReport.push('  • Possible issues:');
            statusReport.push('    - Database not configured in DAIL-SQL server');
            statusReport.push('    - Incorrect database path in server config');
            statusReport.push('    - Database file permissions issue');
            statusReport.push('');
            statusReport.push('💡 To fix this:');
            statusReport.push('  1. Check DAIL-SQL server configuration');
            statusReport.push('  2. Verify database file exists at:');
            statusReport.push('     C:\\Users\\grizz\\OneDrive\\Desktop\\COSC448\\ideas\\model\\DAIL-SQL\\dataset\\spider\\database\\car_1\\car_1.sqlite');
            statusReport.push('  3. Ensure server has read permissions to the file');
            statusReport.push('  4. Restart DAIL-SQL server after configuration changes');
        }
        // Show comprehensive report
        vscode.window.showInformationMessage(statusReport.join('\\n'), { modal: true });
    }
    catch (error) {
        console.error('DAIL-SQL API test failed:', error);
        let errorMsg = '❌ DAIL-SQL API Connection Failed\\n\\n';
        if (axios_1.default.isAxiosError(error)) {
            if (error.code === 'ECONNREFUSED') {
                errorMsg += `Cannot connect to DAIL-SQL server at ${apiUrl}\\n`;
                errorMsg += 'Please check if the DAIL-SQL server is running.\\n\\n';
                errorMsg += '💡 To start DAIL-SQL server:\\n';
                errorMsg += '  1. Navigate to your DAIL-SQL directory\\n';
                errorMsg += '  2. Run: python app.py (or similar)\\n';
                errorMsg += '  3. Check server logs for any errors';
            }
            else if (error.response) {
                errorMsg += `Server responded with ${error.response.status}: ${error.response.statusText}\\n`;
                errorMsg += `Response: ${JSON.stringify(error.response.data)}`;
            }
            else if (error.request) {
                errorMsg += `Network error: ${error.message}\\n`;
                errorMsg += 'Check your network connection and server URL.';
            }
            else {
                errorMsg += `Request error: ${error.message}`;
            }
        }
        else {
            errorMsg += `Unknown error: ${error}`;
        }
        vscode.window.showErrorMessage(errorMsg, { modal: true });
        throw error;
    }
}
// Helper function: Upload SQLite file to DAIL-SQL server programmatically
async function uploadSQLiteToDailSQL(filePath, databaseId) {
    try {
        const config = vscode.workspace.getConfiguration('nl2sql');
        const apiUrl = config.get('dailsql.apiUrl') || 'http://localhost:8000';
        console.log(`📤 Checking/Uploading ${filePath} as ${databaseId} to DAIL-SQL server...`);
        // Check if DAIL-SQL service is available
        try {
            await axios_1.default.get(`${apiUrl}/api/v1/health`, { timeout: 5000 });
        }
        catch (error) {
            throw new Error('DAIL-SQL server is not available. Please start the server first.');
        }
        // Validate database ID
        if (!databaseId || !/^[a-zA-Z0-9_]+$/.test(databaseId)) {
            throw new Error('Invalid database ID. Must contain only letters, numbers, and underscores.');
        }
        // 方案1：使用现有数据库（推荐） - 首先检查数据库是否已经存在
        console.log(`  - Checking if database '${databaseId}' already exists...`);
        try {
            const dbListResponse = await axios_1.default.get(`${apiUrl}/api/v1/databases`, { timeout: 10000 });
            if (dbListResponse.data && Array.isArray(dbListResponse.data)) {
                const existingDb = dbListResponse.data.find((db) => db.database_id === databaseId);
                if (existingDb) {
                    const tables = existingDb.tables || [];
                    console.log(`✅ Database '${databaseId}' already exists with tables: ${tables.join(', ')}`);
                    console.log(`  - Reusing existing database instead of uploading new one`);
                    return databaseId;
                }
            }
            console.log(`  - Database '${databaseId}' not found, proceeding with upload...`);
        }
        catch (dbCheckError) {
            console.warn('❌ Failed to check existing databases, proceeding with upload:', dbCheckError);
            // Continue with upload even if database check fails
        }
        // Read file as buffer
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }
        const fileBuffer = fs.readFileSync(filePath);
        console.log(`  - File size: ${fileBuffer.length} bytes`);
        // Create form data for file upload
        const FormData = require('form-data');
        const formData = new FormData();
        formData.append('file', fileBuffer, {
            filename: path.basename(filePath),
            contentType: 'application/octet-stream'
        });
        formData.append('database_id', databaseId);
        // Upload to DAIL-SQL server
        console.log(`  - Sending request to ${apiUrl}/api/v1/upload-database`);
        const response = await axios_1.default.post(`${apiUrl}/api/v1/upload-database`, formData, {
            headers: {
                ...formData.getHeaders(),
                'Content-Length': formData.getLengthSync()
            },
            timeout: 60000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        console.log(`  - Server response:`, response.data);
        if (response.data?.success) {
            const tables = response.data.tables || [];
            console.log(`✅ Upload successful! Database ID: ${response.data.database_id}, Tables: ${tables.join(', ')}`);
            return response.data.database_id;
        }
        else {
            throw new Error(response.data?.message || 'Upload failed');
        }
    }
    catch (error) {
        console.error('❌ Upload failed:', error);
        if (axios_1.default.isAxiosError(error)) {
            if (error.response) {
                // 检查是否是数据库已存在的错误（作为备用方案）
                const errorMessage = JSON.stringify(error.response.data);
                if (errorMessage.includes('already exists') || errorMessage.includes('duplicate') || errorMessage.includes('Database ID already exists')) {
                    console.log(`⚠️ Database '${databaseId}' already exists, reusing existing database`);
                    return databaseId;
                }
                throw new Error(`Server error: ${error.response.status} - ${errorMessage}`);
            }
            else if (error.request) {
                throw new Error(`Network error: ${error.message}`);
            }
        }
        throw error;
    }
}
exports.uploadSQLiteToDailSQL = uploadSQLiteToDailSQL;
// Upload SQLite database to DAIL-SQL server
async function uploadSQLiteDatabase() {
    try {
        // Get DAIL-SQL configuration
        const config = vscode.workspace.getConfiguration('nl2sql');
        const apiUrl = config.get('dailsql.apiUrl') || 'http://localhost:8000';
        // Check if DAIL-SQL service is available
        try {
            await axios_1.default.get(`${apiUrl}/api/v1/health`, { timeout: 5000 });
        }
        catch (error) {
            throw new Error('DAIL-SQL server is not available. Please start the server first.');
        }
        // Show file picker for SQLite files
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'SQLite Database': ['sqlite', 'sqlite3', 'db']
            },
            title: 'Select SQLite Database File'
        });
        if (!fileUri || fileUri.length === 0) {
            return; // User cancelled
        }
        const filePath = fileUri[0].fsPath;
        const fileName = path.basename(filePath, path.extname(filePath));
        // Ask user for database ID
        const databaseId = await vscode.window.showInputBox({
            prompt: 'Enter a unique database ID (letters, numbers, and underscores only)',
            value: fileName,
            validateInput: (value) => {
                if (!value || value.trim() === '') {
                    return 'Database ID cannot be empty';
                }
                if (!/^[a-zA-Z0-9_]+$/.test(value)) {
                    return 'Database ID can only contain letters, numbers, and underscores';
                }
                return undefined;
            }
        });
        if (!databaseId) {
            return; // User cancelled
        }
        // Show progress
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Uploading SQLite Database",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "Reading file..." });
            // Read file as buffer
            const fileBuffer = fs.readFileSync(filePath);
            progress.report({ increment: 30, message: "Preparing upload..." });
            // Create form data for file upload
            const FormData = require('form-data');
            const formData = new FormData();
            formData.append('file', fileBuffer, {
                filename: path.basename(filePath),
                contentType: 'application/octet-stream'
            });
            formData.append('database_id', databaseId);
            progress.report({ increment: 60, message: "Uploading to server..." });
            // Upload to DAIL-SQL server
            const response = await axios_1.default.post(`${apiUrl}/api/v1/upload-database`, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Content-Length': formData.getLengthSync()
                },
                timeout: 60000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            progress.report({ increment: 100, message: "Upload complete!" });
            if (response.data?.success) {
                const tables = response.data.tables || [];
                vscode.window.showInformationMessage(`✅ Database "${databaseId}" uploaded successfully!\\n` +
                    `📊 Found ${tables.length} tables: ${tables.join(', ')}`);
                // Refresh database list in panel if open
                if (nl2sqlPanel_1.NL2SQLPanel.currentPanel) {
                    nl2sqlPanel_1.NL2SQLPanel.currentPanel._panel.webview.postMessage({
                        command: 'refreshDatabases'
                    });
                }
            }
            else {
                throw new Error(response.data?.message || 'Upload failed');
            }
        });
    }
    catch (error) {
        console.error('Database upload error:', error);
        let errorMsg = 'Failed to upload database: ';
        if (axios_1.default.isAxiosError(error)) {
            if (error.response?.data?.message) {
                errorMsg += error.response.data.message;
            }
            else if (error.code === 'ECONNREFUSED') {
                errorMsg += 'Cannot connect to DAIL-SQL server. Please check if the server is running.';
            }
            else {
                errorMsg += error.message;
            }
        }
        else {
            errorMsg += error.message;
        }
        vscode.window.showErrorMessage(errorMsg);
        throw error;
    }
}
// Read up to 100 rows from a MySQL table for previewing in the panel
async function readMySQLTableRows(config, tableName) {
    return new Promise((resolve, reject) => {
        try {
            const mysql = require('mysql2');
            const connection = mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.user,
                password: config.password,
                database: config.database,
                connectTimeout: 5000
            });
            connection.connect((err) => {
                if (err) {
                    connection.end();
                    reject(err);
                    return;
                }
            });
            const safeTable = `\`${tableName.replace(/`/g, '')}\``;
            const sql = `SELECT * FROM ${safeTable} LIMIT 100`;
            connection.query(sql, (err, results) => {
                connection.end();
                if (err) {
                    reject(err);
                    return;
                }
                // Ensure results are plain objects
                resolve(results || []);
            });
        }
        catch (error) {
            reject(error);
        }
    });
}
exports.readMySQLTableRows = readMySQLTableRows;
// Get stored Postgres configuration
async function getPostgresConfig(context) {
    try {
        const host = await context.secrets.get('pg-host');
        const port = await context.secrets.get('pg-port');
        const user = await context.secrets.get('pg-username');
        const password = await context.secrets.get('pg-password');
        if (!host || !port || !user || password === undefined) {
            return null;
        }
        return {
            host,
            port: parseInt(port),
            user,
            password
        };
    }
    catch (error) {
        return null;
    }
}
exports.getPostgresConfig = getPostgresConfig;
// Postgres helper functions
async function getPostgresDatabases(config) {
    return new Promise((resolve, reject) => {
        try {
            const { Client } = require('pg');
            const client = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: 'postgres' });
            client.connect((err) => {
                if (err) {
                    client.end();
                    reject(err);
                    return;
                }
            });
            client.query("SELECT datname FROM pg_database WHERE datistemplate = false;", (err, res) => {
                client.end();
                if (err) {
                    reject(err);
                    return;
                }
                const dbs = (res.rows || []).map((r) => r.datname).filter((n) => n && n.length > 0);
                resolve(dbs);
            });
        }
        catch (error) {
            reject(error);
        }
    });
}
exports.getPostgresDatabases = getPostgresDatabases;
async function readPostgresSchema(config) {
    return new Promise((resolve, reject) => {
        try {
            const { Client } = require('pg');
            const client = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
            client.connect((err) => {
                if (err) {
                    client.end();
                    reject(err);
                    return;
                }
            });
            // Get tables
            client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type='BASE TABLE';", async (err, res) => {
                if (err) {
                    client.end();
                    reject(err);
                    return;
                }
                const tables = res.rows.map((r) => r.table_name || r.table_name);
                const tablePromises = tables.map((tableName) => {
                    return new Promise((resolveTable, rejectTable) => {
                        client.query(`SELECT column_name, data_type, is_nullable, ordinal_position FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position;`, [tableName], (colErr, colRes) => {
                            if (colErr) {
                                return resolveTable({ name: tableName, columns: [] });
                            }
                            client.query(`SELECT kcu.column_name
                                 FROM information_schema.table_constraints tc
                                 JOIN information_schema.key_column_usage kcu
                                   ON tc.constraint_name = kcu.constraint_name
                                  AND tc.table_schema = kcu.table_schema
                                 WHERE tc.constraint_type = 'PRIMARY KEY'
                                   AND tc.table_schema = 'public'
                                   AND tc.table_name = $1
                                 ORDER BY kcu.ordinal_position;`, [tableName], (pkErr, pkRes) => {
                                if (pkErr) {
                                    return resolveTable({ name: tableName, columns: [] });
                                }
                                const pkSet = new Set((pkRes.rows || []).map((r) => String(r.column_name).toLowerCase()));
                                const cols = (colRes.rows || []).map((c) => ({
                                    name: c.column_name,
                                    type: c.data_type,
                                    notnull: c.is_nullable === 'NO',
                                    pk: pkSet.has(String(c.column_name).toLowerCase()),
                                    values: []
                                }));
                                client.query(`SELECT kcu.column_name AS column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
                                         FROM information_schema.table_constraints tc
                                         JOIN information_schema.key_column_usage kcu
                                           ON tc.constraint_name = kcu.constraint_name
                                          AND tc.table_schema = kcu.table_schema
                                         JOIN information_schema.constraint_column_usage ccu
                                           ON ccu.constraint_name = tc.constraint_name
                                          AND ccu.table_schema = tc.table_schema
                                         WHERE tc.constraint_type = 'FOREIGN KEY'
                                           AND tc.table_schema = 'public'
                                           AND tc.table_name = $1;`, [tableName], (_fkErr, fkRes) => {
                                    const foreignKeys = (fkRes?.rows || [])
                                        .filter((fk) => fk.column_name && fk.ref_table && fk.ref_column)
                                        .map((fk) => ({
                                        column: fk.column_name,
                                        refTable: fk.ref_table,
                                        refColumn: fk.ref_column
                                    }));
                                    // fetch sample values for each column
                                    const valuePromises = cols.map((col) => {
                                        return new Promise((resolveCol) => {
                                            const safeCol = `"${col.name.replace(/"/g, '""')}"`;
                                            const safeTable = `"${tableName.replace(/"/g, '""')}"`;
                                            client.query(`SELECT DISTINCT ${safeCol} AS val FROM ${safeTable} WHERE ${safeCol} IS NOT NULL LIMIT 200`, (valErr, valRes) => {
                                                if (valErr) {
                                                    col.values = [];
                                                    return resolveCol();
                                                }
                                                col.values = (valRes.rows || []).map((r) => (r.val === null || r.val === undefined ? '' : String(r.val).trim())).filter((v) => v.length > 0).slice(0, 200);
                                                resolveCol();
                                            });
                                        });
                                    });
                                    Promise.all(valuePromises).then(() => {
                                        resolveTable({ name: tableName, columns: cols, foreignKeys });
                                    }).catch(() => resolveTable({ name: tableName, columns: cols, foreignKeys }));
                                });
                            });
                        });
                    });
                });
                Promise.all(tablePromises).then((result) => {
                    client.end();
                    resolve(result);
                }).catch((e) => {
                    client.end();
                    reject(e);
                });
            });
        }
        catch (error) {
            reject(error);
        }
    });
}
exports.readPostgresSchema = readPostgresSchema;
async function readPostgresTableRows(config, tableName) {
    return new Promise((resolve, reject) => {
        try {
            const { Client } = require('pg');
            const client = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
            client.connect((err) => {
                if (err) {
                    client.end();
                    reject(err);
                    return;
                }
            });
            client.query(`SELECT * FROM ${tableName} LIMIT 100`, (err, res) => {
                client.end();
                if (err)
                    return reject(err);
                resolve(res.rows || []);
            });
        }
        catch (error) {
            reject(error);
        }
    });
}
exports.readPostgresTableRows = readPostgresTableRows;
async function testPostgresConnection(config) {
    try {
        const { Client } = require('pg');
        const client = new Client({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database || 'postgres', connectionTimeoutMillis: 5000 });
        await client.connect();
        await client.end();
        return { success: true };
    }
    catch (error) {
        return { success: false, error: error.message || String(error) };
    }
}
//# sourceMappingURL=extension.js.map