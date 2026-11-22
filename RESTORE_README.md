# NL2SQL 插件可运行精简版（含原始驱动）

此版本从用户上传的 `vscode_NL_to_SQL.zip` 直接挑选文件。所有保留文件均未修改，包含：

- `src/extension.ts`、`src/nl2sqlPanel.ts`、`src/types.ts`（与原 ZIP 完全一致）
- 原版 `out/extension.js`、`out/nl2sqlPanel.js`、`out/types.js` 及 Source Maps
- 原版完整 `node_modules/`，包括 `sqlite3`（Windows native .node）、`mysql2`、`pg`
- `package.json`、`package-lock.json`、`tsconfig.json`、VS Code 调试配置

从安装目录中排除了 `.git/`、`result/`、`Results/`、`result_DAIL/`、`statistics*/`、独立测试脚本、旧版未引用的源码和过期编译文件。

## 使用

1. 将压缩包解压到一个**新目录**。
2. 在 VS Code 中打开包含 `package.json` 的 `vscode_NL_to_SQL` 文件夹（而不是上层目录）。
3. 直接按 `F5` 启动插件。原版 JS 和原版 Node 依赖已经包含，原则上无需首先运行 `npm ci`。
4. 如果需要修改 TypeScript，则运行 `npm run compile`，再按 `F5`。

在 Windows VS Code Extension Host 下测试最有意义。此包保留的是**原包自带的 Windows 原生 sqlite3 驱动**，不保证适合其他操作系统或不同 Electron/Node ABI。

MySQL/PostgreSQL 的连接配置保存在 VS Code SecretStorage，而不是项目源码中。换用不同 VS Code Profile 或 Extension Host 环境时，可能需要重新配置账号。

## 验证范围与限制

所有保留文件与原始 ZIP 的 SHA-256 相同，并通过包完整性检查。原包本身是否完全正常，仍以用户本地运行结果为准。本环境无法运行 Windows Electron 的原生 sqlite3 驱动，因此无法声称完成了 VS Code 中的真实连接测试。

`FILE_HASHES.json` 是核验清单，不参与插件运行。
