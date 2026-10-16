# CodeBuddy Desktop

简体中文：CodeBuddy 桌面由 Electron、React 和 TypeScript 构建。主进程启动包内运行服务，通过 ACP 连接界面。源码启动、依赖准备和 Windows 安装包构建请使用[仓库说明](../../README.md)。

繁體中文：CodeBuddy 桌面由 Electron、React 與 TypeScript 建構。主程序啟動包內執行服務，透過 ACP 連接介面。原始碼啟動、依賴準備與 Windows 安裝包建構請參閱[倉庫說明](../../documentation/codebuddy/GITHUB_OVERVIEW_ZH_TW.md)。

English: CodeBuddy Desktop uses Electron, React and TypeScript. The main process starts the bundled runtime and connects the interface through ACP. See the [repository guide](../../documentation/codebuddy/GITHUB_OVERVIEW_EN.md) for source launch, dependencies and Windows packaging.

Component checks, from `ui/desktop`:

```powershell
corepack pnpm run typecheck
corepack pnpm run test:run
corepack pnpm run lint:check
```

For macOS packaging, run `pnpm run bundle:mac` on a native Mac; inspect `scripts/README.md` for platform prerequisites. Windows checks do not establish macOS acceptance.
