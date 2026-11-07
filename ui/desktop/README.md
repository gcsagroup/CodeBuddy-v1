# CodeBuddy Desktop

简体中文：CodeBuddy 桌面由 Electron、React 和 TypeScript 构建。主进程启动包内运行服务，通过 ACP 连接界面。源码启动、依赖准备和 Windows 安装包构建请使用[仓库说明](../../README.md)。

繁體中文：CodeBuddy 桌面由 Electron、React 與 TypeScript 建構。主程序啟動包內執行服務，透過 ACP 連接介面。原始碼啟動、依賴準備與 Windows 安裝包建構請參閱[倉庫說明](../../documentation/codebuddy/GITHUB_OVERVIEW_ZH_TW.md)。

English: CodeBuddy Desktop uses Electron, React and TypeScript. The main process starts the bundled runtime and connects the interface through ACP. See the [repository guide](../../documentation/codebuddy/GITHUB_OVERVIEW_EN.md) for source launch, dependencies and Windows packaging.

简体中文：Windows 双击 `start-preview.cmd` 启动新版任务界面，它调用 `start-preview.ps1`；重复的聊天启动入口、旧时钟首页、Code / CodePro 切换及 `-OrdinaryChat` 回退参数已移除。旧页面链接自动跳转，历史会话数据保留。

繁體中文：Windows 按兩下 `start-preview.cmd` 啟動新版任務介面，它呼叫 `start-preview.ps1`；重複的聊天啟動入口、舊時鐘首頁、Code / CodePro 切換及 `-OrdinaryChat` 回退參數已移除。舊頁面連結自動跳轉，歷史對話資料保留。

English: On Windows, double-click `start-preview.cmd` to open the unified task interface; it invokes `start-preview.ps1`. The duplicate chat launcher, old clock home, Code / CodePro switcher, and `-OrdinaryChat` rollback option have been removed. Legacy page links redirect automatically; existing conversation data is retained.

Component checks, from `ui/desktop`:

```powershell
corepack pnpm run typecheck
corepack pnpm run test:run
corepack pnpm run lint:check
```

macOS：[简体中文](../../docs/macos.zh-CN.md) · [繁體中文](../../docs/macos.zh-TW.md) · [English](../../docs/macos.en.md)。Use the native Harness packaging entry described there. The retired Rust Agent is not a build input. Native build and product acceptance remain pending.
