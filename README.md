# NL2SQL for Visual Studio Code

A VS Code extension that generates, edits, and executes SQL from natural-language questions. It combines a database explorer with selectable language-model providers and an optional DAIL-SQL prompt/validation backend.

This is the **frontend extension repository**. The DAIL-SQL FastAPI server is a separate project and is needed for DAIL-SQL prompt generation and server-side rule validation. Direct model generation can be used without that backend.

**Companion backend repository:** `ADD_CURRENT_BACKEND_REPOSITORY_URL` (replace with the new repository URL; the previous repository reference has been removed).

## Features

| Area | Current implementation |
| --- | --- |
| Databases | SQLite, MySQL, and PostgreSQL selection and schema inspection |
| Database explorer | Searchable database selection, table/column information, and sample rows displayed in the main panel |
| Model providers | GitHub Copilot through the VS Code language model API, or Kimi through the Moonshot API |
| Kimi settings | Available-model lookup, custom model ID, API key, base URL, request timeout, retry count, output-token limit, and model-specific reasoning options |
| Prompting | Optional DAIL-SQL prompt construction, general few-shot examples, and saved history examples |
| SQL checking | Optional rule-based validation and corrective retry via the backend |
| Output | Editable generated SQL, manual execution, and tabular results |
| Experiments | Spider batch timing, stop/resume-related results, prompt logs, and per-model/per-mode outputs |

The current interface has an integrated **Selected Database / Database Details** panel. The former separate `Database Detail` view/button described by the old README is no longer the current layout.

## Requirements

You need Visual Studio Code with an extension host compatible with `vscode` `^1.90.0`, Node.js and npm, plus access to at least one supported model provider. GitHub Copilot requires the relevant VS Code extension and an authenticated account with access to a compatible model. Kimi requires a Moonshot API key.

SQLite databases can be opened locally. MySQL and PostgreSQL require reachable database instances and valid connection settings. For DAIL-SQL prompting or rule validation, start the separate backend on its configured URL (default `http://localhost:8000`). The Spider 1.0 dataset is needed only for Spider batch experiments, not for ordinary single-question SQL generation.

## Build and run

Clone or open **this frontend repository**, then run from its root:

```bash
npm ci
npm run compile
```

The TypeScript source files are `src/extension.ts`, `src/nl2sqlPanel.ts`, and `src/types.ts`. Compilation generates JavaScript under `out/`, with `out/extension.js` as the entry point defined in `package.json`.

Open the project folder in VS Code and press `F5` to launch the Extension Development Host. From the Command Palette, select **Open NL2SQL Panel**. The extension also contributes commands for converting selected natural language, replacing selected text with SQL, testing the DAIL-SQL API connection, and uploading a SQLite database.

If you change the TypeScript source, run `npm run compile` again, or run `npm run watch` during development.

## Configure databases and models

In the panel, select the database engine and choose or configure a database. SQLite supports workspace database discovery and a file-selection/upload flow. MySQL and PostgreSQL use the **MySQL Config** and **Postgres Config** controls. The database details area then shows tables, columns, and sample rows where available.

Choose **GitHub Copilot** or **Kimi API** under **Model Selection**. With Copilot, select an available model. With Kimi, configure the API key, then refresh the list of available models or enter a custom model ID. The current implementation defaults to `https://api.moonshot.cn/v1` for Kimi and stores the API key using VS Code's SecretStorage API rather than in source code.

Kimi-specific request settings depend on the selected model. The panel exposes K2.6 thinking mode (`default`, `disabled`, or `enabled`) and K3 reasoning effort (`default`, `low`, `high`, or `max`) in the relevant model-specific controls. Selecting `default` omits the corresponding explicit setting from the request; the API decides its effective behavior. Advanced controls include maximum completion tokens, HTTP timeout/retries, and some model-specific cache/stop options. Not every setting applies to every model.

## Generation and validation modes

Two independent checkboxes control **DAIL Prompt + Few-shot** and **Rule-based Validation & Retry**. The supported combinations are:

| DAIL prompt | Rule validation | Experiment mode | Behavior |
| --- | --- | --- | --- |
| On | On | `full` / DAIL + Rules | DAIL prompt followed by model generation and optional validation/correction |
| On | Off | `dail_only` | DAIL prompt, without the rule-based correction loop |
| Off | On | `rule_only` | Direct prompt with backend rule validation/correction; the implemented rule-only path is limited to SQLite |
| Off | Off | `direct` / Baseline | Direct model prompting without the DAIL prompt or backend validation |

When DAIL prompting is enabled, **History Few-shots** defaults to 1 and **General Few-shots** defaults to 3. Both controls accept 0 to 10. **Save Few-shot** stores a question/SQL example for subsequent history-based retrieval.

DAIL-enabled or validation-enabled modes require a reachable backend. The backend performs prompt preparation and rule validation; the frontend requests SQL from the selected Copilot or Kimi model. For MySQL/PostgreSQL, the implementation can perform an additional model call to adapt canonical SQLite SQL into the target dialect. Generated queries should still be inspected before execution.

## Generate and execute SQL

Type a natural-language request in **Input** (the current UI limits input to 200 characters), then select **Generate SQL**. Review or edit the SQL in **Output**, and select **Run SQL** to execute it against the selected database. Results and errors appear in **Execution Results**.

SQLite execution opens the local database in read-only mode. MySQL and PostgreSQL execution uses the configured database connection; the source does not enforce a universal read-only SQL policy for those engines. Use a database account with appropriately restricted permissions, especially when testing model-generated queries.

## Spider batch experiments

The **Spider Batch Timing** feature runs a set of natural-language questions from the **Spider 1.0 development dataset**. The dataset is **not installed by `npm ci`** and is **not required for normal single-query SQL generation**. If the relevant Spider files are already present in a repository you have opened in VS Code, you do not need to download them again.

### Download Spider 1.0

Download the **Spider 1.0** dataset from the [official Yale Spider website](https://yale-lily.github.io/spider) (the **Spider Dataset** link under *Getting Started*). **Do not substitute Spider 2.0**: this extension's batch reader expects the Spider 1.0 `dev.json` format and SQLite database layout.

The batch runner requires `dev.json` and the matching `database/` directory. Each database must be stored at `database/<db_id>/<db_id>.sqlite`, where `<db_id>` is the value in each development-set question. The accompanying `tables.json` is also recommended, particularly when using the DAIL-SQL backend, which may require schema metadata and other training or retrieval assets. Those backend dependencies are managed by the separate backend project.

### Put the dataset in the opened VS Code workspace

The extension resolves Spider paths **dynamically from the folders open in VS Code**. It does not require you to edit a machine-specific path in the TypeScript code. A recommended layout is:

```text
NL2SQL_paper/                     # Open this parent folder in VS Code, or add the backend as a workspace folder
├── NL2SQL-plugin/                # Frontend extension
│   ├── package.json
│   └── src/
└── DAIL-SQL_server/              # Backend repository
    └── dataset/
        └── spider/
            ├── dev.json         # Required for batch questions
            ├── tables.json      # Recommended schema metadata
            └── database/        # Required for per-question SQLite databases
                ├── concert_singer/
                │   └── concert_singer.sqlite
                └── ...
```

Place the contents of the downloaded Spider archive under `DAIL-SQL_server/dataset/spider/` without adding another nested `spider/` level. The extension first checks `dataset/spider/dev.json` at the root of each open workspace folder, then searches inside the opened workspace. It also verifies that a sibling `database/` directory exists.

If you opened **only the frontend repository** in VS Code and the Spider files live in a separate backend repository outside that workspace, the batch runner **will not find them**. Open the parent directory containing both projects, or use **File > Add Folder to Workspace...** to include the backend. When testing in the **Extension Development Host** launched with `F5`, make sure that the required folder is open in that host window too.

### Verify files before running

From the backend repository root, use PowerShell to check the expected files:

```powershell
Test-Path .\dataset\spider\dev.json
Test-Path .\dataset\spider\database
Test-Path .\dataset\spider\tables.json
```

The first two checks should return `True` for the batch reader. `tables.json` should also be present when required by your backend configuration. Simply cloning the frontend repository does not guarantee that these files are available.

### Run a small batch

Install and compile the extension as described above, launch it with `F5`, and open the **NL2SQL Panel**. Select and configure a supported model provider (GitHub Copilot or Kimi). Start the DAIL-SQL backend if **DAIL Prompt + Few-shot** or **Rule-based Validation & Retry** is enabled. Click **Spider Batch Timing** and enter **5** as the number of questions for an initial test. Entering **0** selects all questions from `dev.json`.

The runner reads the questions from `dev.json`, looks up each `db_id` in the matching SQLite database folder, and records generation timing, model outputs, prompts, and available usage metadata. **Stop Batch** requests that processing stop after the current question is saved. Batch results are written under the repository containing the Spider dataset, using mode- and provider-specific result folders such as `Results/` or `result_DAIL/`. Preserve existing outputs if you intend to resume an experiment.

**Evaluation limitation:** Spider Batch Timing is a batch-generation and instrumentation workflow. It does not, by itself, report an official Spider exact-match or execution-accuracy score against the reference SQL queries; such evaluation requires a separate assessment step.

## Backend configuration

Open VS Code Settings and configure `nl2sql.dailsql.apiUrl` (default `http://localhost:8000`). Start the separate DAIL-SQL server when either DAIL prompting or rule validation is enabled. The extension sends requests to its `/api/v1/tokenize`, `/api/v1/generate-prompt`, `/api/v1/validate-sql`, and related endpoints as needed.

The backend itself is not a substitute for a Copilot login or Kimi API key. Conversely, configuring the model provider does not install the DAIL-SQL Python dependencies or create its masked embeddings cache.

## Project status and limitations

This is a research prototype. The previous source snapshot and portable-path patch passed static inspection and TypeScript compilation, but an end-to-end verification against all supported database engines and model providers has not been completed. Results depend on the selected model, prompt configuration, database schema, training data, and backend availability. No unverified Spider accuracy claim is made here.

## Attribution

DAIL-SQL prompt construction is based on the [DAIL-SQL research implementation](https://github.com/BeachWang/DAIL-SQL). Check the separate backend repository for its source and license information.
