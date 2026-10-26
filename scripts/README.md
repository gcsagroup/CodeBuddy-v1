# CodeBuddy 脚本入口

在仓库根目录执行，使用已有依赖；完整准备步骤见 [README](../README.md)。

| 用途 | 命令 |
| --- | --- |
| Windows 源码预览 | `.\start-preview.ps1` |
| Windows Inno 安装包 | `node scripts/build-harness-windows.cjs --installer=inno` |
| macOS 构建 | 按 [Mac 说明](../docs/macos.zh-CN.md)执行 `scripts/build-harness-macos.cjs` |
| 启动器回归 | `node --test scripts/start-harness-preview.test.cjs scripts/root-pnpm-launcher.test.cjs` |
| 文档渲染兼容回归 | `node --test ui/desktop/scripts/dsh-document-preview-assets.test.mjs` |
| Office 环境准备 | [Office 构建器](office-builder/README.md) |

`stage-harness-distribution.cjs` 与 `verify-harness-stage.mjs` 由打包入口调用。`accept-*`、`inspect-*` 和 `preview-*` 是验收辅助脚本，使用前检查目标、profile 和副作用。旧 CLI 基准、下载和发布脚本已移除；历史内容可从 Git 恢复。

预览启动前会复用运行时工具校验；失败时不启动后端或 Electron，并在终端和 `logs/preview/launch.json` 提示文件及准备方式。Git 不同步工具二进制；处理步骤见根目录 README。检查不会自动下载或替换文件。Mac 保留现有原生工具准备顺序，随后检查。

前端修改可热更新；Electron 主进程或主进程导入的模块修改后，`target built src/main.ts` 只代表编译完成。当前 Forge 插件不会自动重启主进程；通过本仓库启动器运行时，请停止预览，再通过同一入口和同一 profile 重新启动。验收新增 IPC 功能前必须完成此步骤，不能用页面刷新代替。

## 繁體中文

從倉庫根目錄使用既有依賴執行上述命令。Windows 以 `start-preview.ps1` 啟動，安裝包由 Harness 建構入口產生；macOS 參閱[平台說明](../docs/macos.zh-TW.md)。Office 準備涉及下載，詳見其說明。驗收輔助腳本須先確認目標、隔離 profile 與副作用。舊 CLI 基準、下載及發布腳本保留於 Git 歷史。

預覽會在服務啟動前核對工具；失敗時顯示檔案及準備方式，不自動下載或替換。Mac 在既有原生工具準備完成後核對。

## English

Run the commands above from the repository root with existing dependencies. Windows preview starts through `start-preview.ps1`; packaging uses the Harness build entry points. Follow the [macOS guide](../docs/macos.en.md) on a Mac. Office preparation downloads dependencies; consult its guide first. Review targets, isolated profiles and side effects before running acceptance helpers. Retired CLI benchmark, download and release scripts remain available in Git history.

Preview validates tool artifacts before starting services. Failures name the files and preparation steps without downloading or replacing anything. On Mac, validation follows the existing native tool preparation.
