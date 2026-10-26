# 工作区面板交付说明

日期：2026-09-30。基于 `main` 的 `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`，在当前含修改的工作目录验收。

## 本次修改

右侧改为「工作区文件／新建终端／浏览器」入口，支持多标签、调整宽度、展开和收起。文件支持目录树、文件名搜索、Markdown／图片／文本预览、编辑保存，外部修改发生时保留草稿并拒绝覆盖。关闭草稿和终端复用原有确认弹窗。

终端采用 MIT 开源组件 `@xterm/xterm@6.0.0`、`@xterm/addon-fit@0.11.0`、`node-pty@1.1.0`，在当前会话工作目录启动 PowerShell。浏览器采用 Electron WebContentsView，支持地址、前进、后退、刷新，网页没有 Node 和应用 preload 权限。

复用现有 ACP 会话 snapshot、Markdown 组件、国际化和确认弹窗。面板保存草稿和标签，主进程按窗口／会话管理系统资源。切换会话保留资源，关闭窗口或重载 renderer 清理资源。

## 合并位置

- `ui/desktop/src/workspace-panel/`：面板及文件、终端、浏览器实现和测试。
- `AppLayout.tsx`、`main.ts`、`preload.ts`：现有入口集成。
- desktop `package.json`、`ui/pnpm-lock.yaml`：三个已授权依赖。
- `forge.config.ts`：使用 Windows Node-API 预编译包及原生模块解包，避免不必要的 C++ 编译。
- `src/i18n/messages/`：简体、繁体、英文文案。

当前工作目录还存在之前的 Git MCP 修改，提交时请按功能拆分。

## 测试与实际验收

在 `ui/desktop` 执行 `pnpm exec vitest run src/workspace-panel src/components/Layout/AppLayout.test.ts --maxWorkers=1`：23 项通过、退出码 0。`pnpm exec tsc --noEmit` 和新增面板及入口的 ESLint 均通过。

通过正式 `start-gui-debug` 启动，在会话 `20260930_31` 实际验证了：中文文件编辑保存；真实 PowerShell 的目录和中文文件输出；Ctrl+C 后继续运行；终端确认关闭；跨会话资源隔离；浏览器本地网页链接、前进、后退、刷新；切换会话返回后的草稿和终端输出保留。网页内 `require`、`window.electron` 实测均为 undefined。

本地证据在 `D:\CodeBuddy\.cargo\workspace-panel`，包含 `tests.log`、`file-ui-result.json`、`terminal-evidence.json` 和 `switch-evidence.json`，不提交仓库。

## 使用边界

此次验收为开发版，安装包尚未重建验证。草稿和标签支持会话间切换保留，程序重启恢复尚未实现；关闭或重载前请保存草稿或关闭文件标签。文本编辑上限 2 MiB，搜索跳过依赖／构建目录并限制结果数量。手动终端与 Agent 的 shell 权限分别管理。

`i18n:check` 存在原有英文目录差异：5 个 `currentPlan.*` 多余键和 5 个 `toolAction.*Summary` 值差异；新增 `workspacePanel.*` 与提取内容一致。该原有检查尚未通过。

完整说明以[繁体版本](WORKSPACE_PANEL_ZH_TW.md)为准。参考：[xterm.js](https://github.com/xtermjs/xterm.js/)、[node-pty](https://github.com/microsoft/node-pty)、[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)。

## 2026-10-08 界面优化

参考用户提供的 DeepSeek Hermes 截图，统一文件、终端、浏览器的标签栏、工具栏、留白和细滚动条。文件预览默认收起目录树，可随时展开；复用已有 react-syntax-highlighter 添加代码高亮、行号和换行。超过 100,000 字符时保留完整纯文本，避免高亮阻塞界面。终端跟随应用主题，增加工作目录、运行状态、清屏按钮和最低文字对比度；清屏不向 shell 发送命令。浏览器优化地址栏、空白页和加载状态，空白页时隐藏原生空白视图，避免遮住说明。

修改集中在 src/workspace-panel 的界面组件、CSS、组件测试及三语文案，未增加依赖。既有文件保存版本校验、终端进程和浏览器权限策略保持原有实现。

在 ui/desktop 运行 pnpm exec vitest run src/workspace-panel --maxWorkers=1，5 个测试文件、30 项通过；pnpm exec tsc --noEmit、修改组件的 ESLint、pnpm run i18n:compile 均退出 0。当前 main / 00a6656df 含未提交改动的真实 Electron 开发版已验证代码高亮、行号、目录折叠和换行；真实终端执行 Write-Output 与 Get-Location；真实地址栏导航至公开示例网页并取得实际网页内容、标题和可见状态。开发热更新期间的重载不计作验收成功，稳定后重新执行。

本地截图和结果在 D:/CodeBuddy/.cargo/panel-*-refresh.png、panel-browser-content.png、panel-refresh-acceptance.json，不提交仓库。本次未重新生成安装包，未提交或推送 GitHub；深色主题支持已实现，未单独执行深色主题的真实交互验收。

## 2026-10-26 文件操作与文档阅读

本节说明当前实现，前面的构建身份与验收记录仅适用于各自日期。

- 本地文件链接左键在右侧打开；Ctrl/Cmd+左键调用主进程的外部打开。代码文件（包括 Python、JavaScript 和 TypeScript）使用 VS Code 的文件 URI，避免操作系统把脚本当程序执行。Markdown、普通文本和 CSV 保留用户的默认应用。文档、图片和视频使用相应系统应用；可执行程序与快捷方式不因此获得打开权限。
- 图片本身左键进入放大弹层，保留图片专用右键操作；文件链接和网页链接使用各自菜单。弹层没有实色底板，显示实际百分比及一个适配按钮。尺寸观察在弹层节点挂载后建立，首次打开、缩放和窗口变化使用同一尺寸来源。
- PDF、DOCX、PPTX 在侧栏阅读、选择文字和缩放；XLSX 使用上游只读表格，支持工作表切换和单元格查看。Office 文件不在这里编辑或保存。Markdown 继续使用已有预览、编辑、版本校验和保存流程。
- 主进程负责会话范围、真实路径和版本化限量读取。`runtime/document-preview.mjs` 使用官方 OfficeToPdf 服务负责转换、排队、缓存与取消。Renderer 仅消费返回的字节；关闭或刷新会取消相应请求。原文件不被转换器覆盖。

渲染适配在 `ui/desktop/scripts/dsh-document-preview-assets.mjs`，锁定上游 `0.2.1-alpha.2`；不匹配时要求审查，而不是静默套用旧适配。原始 PDF.js 和表格渲染逻辑保持上游实现。PDF.js 6.3.289 使用的 `Math.sumPrecise` 在 Electron 41 中缺失，会在内嵌字体解析时产生错误回退。适配器在 PDF 主线程和 worker 中按需安装标准兼容实现；算法来自 MIT 许可的 core-js，许可保留在两个构建输出中。不要改成普通 `reduce`，也不要降低字体安全限制。将来升级运行时时，先验证主线程与 worker 都原生支持该 API，并重跑字体、精度与渲染回归，再考虑移除兼容实现。

相关验证：仓库根目录运行 `node --test ui/desktop/scripts/dsh-document-preview-assets.test.mjs`；桌面目录使用现有 `test:run`、`typecheck` 和 `i18n:check`。隔离渲染可以检验实际引擎和组件，不能代替当前 CodeBuddy 窗口的完整产品验收。修改主进程或 Vite 适配插件后，使用标准预览入口重启再验收，不只依据热更新或编译完成判定新功能已加载。
