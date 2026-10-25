# CodeBuddy 脚本入口

在仓库根目录执行，使用已有依赖；完整准备步骤见 [README](../README.md)。

| 用途 | 命令 |
| --- | --- |
| Windows 源码预览 | `.\start-preview.ps1` |
| Windows Inno 安装包 | `node scripts/build-harness-windows.cjs --installer=inno` |
| macOS 构建 | 按 [Mac 说明](../docs/macos.zh-CN.md)执行 `scripts/build-harness-macos.cjs` |
| 启动器回归 | `node --test scripts/start-harness-preview.test.cjs scripts/root-pnpm-launcher.test.cjs` |
| Office 环境准备 | [Office 构建器](office-builder/README.md) |

`stage-harness-distribution.cjs` 与 `verify-harness-stage.mjs` 由打包入口调用。`accept-*`、`inspect-*` 和 `preview-*` 是验收辅助脚本，使用前检查目标、profile 和副作用。旧 CLI 基准、下载和发布脚本已移除；历史内容可从 Git 恢复。

## 繁體中文

從倉庫根目錄使用既有依賴執行上述命令。Windows 以 `start-preview.ps1` 啟動，安裝包由 Harness 建構入口產生；macOS 參閱[平台說明](../docs/macos.zh-TW.md)。Office 準備涉及下載，詳見其說明。驗收輔助腳本須先確認目標、隔離 profile 與副作用。舊 CLI 基準、下載及發布腳本保留於 Git 歷史。

## English

Run the commands above from the repository root with existing dependencies. Windows preview starts through `start-preview.ps1`; packaging uses the Harness build entry points. Follow the [macOS guide](../docs/macos.en.md) on a Mac. Office preparation downloads dependencies; consult its guide first. Review targets, isolated profiles and side effects before running acceptance helpers. Retired CLI benchmark, download and release scripts remain available in Git history.
