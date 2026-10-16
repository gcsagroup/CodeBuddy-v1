# Harness Office payload builder

简体：`upstream/prepare.ts`、`prune-python-tests.ts`、`smoke.py`、`lock.json` 原样来自 DeepSeek Harness `d743267388641bc76f17c45ce8b4c231aed1d32c` 的 `scripts/primary-runtime/`，许可见 `upstream/LICENSE`。不维护第二套下载、解包、Office 编辑或校验实现。新增库版本与官方脚本对应，构建期依赖由本目录 package-lock 锁定。

繁體：上游四個檔案原樣保留，採用同一鎖定清單與驗證；不另造 Office 引擎。此目錄只提供建置依賴，產品使用獨立 Python 載荷，系統 Python 不變。

English: Four unmodified upstream files from the pinned Harness revision prepare and validate the official relocatable payload. This directory supplies build-only dependencies. The adapter at `../prepare-harness-office.mjs` selects the existing pinned Harness API and explicit output paths; it does not replace upstream download, extraction, authoring or smoke logic.

With approved downloads and existing Node 24+, from the repository root:

```powershell
npm ci --prefix scripts/office-builder --ignore-scripts --no-audit --no-fund
node scripts/prepare-harness-office.mjs
```

The official `pythonOnly` mode avoids adding a second Node/pnpm runtime. The builder first writes `runtime/office-assets`, then the adapter relocates the unchanged Python payload to `runtime/py` and skills to `runtime/office`. These short, Git-ignored paths prevent the reproduced Squirrel 260-character extraction failure. Archive cache is `target/harness-office-downloads`; every reused archive is checked against upstream hashes. A populated output is preserved instead of silently overwritten. The normal installer build never initiates downloads and checks runtime install-path lengths for the build host before invoking Squirrel.

简体：载荷完成官方验证后，原样移至 `runtime/py` 和 `runtime/office`，避免安装路径过长；打包前检查当前主机安装路径，系统 Python 不变。

繁體：載荷通過官方驗證後，原樣移至 `runtime/py` 與 `runtime/office`，避免安裝路徑過長；打包前檢查目前主機的安裝路徑。

Source: https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/scripts/primary-runtime
