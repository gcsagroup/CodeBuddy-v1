# Rust 独立工具与 Harness 上游复用调查

调查日期：2026-10-16。当前目录 `D:\CodeBuddy-v1`，`main / 01610d03764570282eee439cd2bfb49fcd373e98` 加既有未提交改动。本轮只调查和记录，不修改产品执行链，不删除工具、不升级或安装依赖、不提交或推送。

## 结论

优先复用上游合理，但现有 16 个 Rust MCP 工具尚未找到可整体、直接、无损替换的一组上游工具。最值得先做的是接入上游 Office 技能流程与公网网页读取；保留其余已具备功能的 MCP 服务，仍由 Harness 调用。用模型临时生成脚本可以完成部分同类任务，但不等于现有工具合同已经被替代；不为消除 Rust 新造文档、图表或天气后端。

## 核对范围与证据

- 本机实际锁定 `@deepseek-ai/dsh` 与 session-controller 为 `0.2.1-alpha.2`，以 `runtime/harness/package.json` 为准。
- 同时读取官方 GitHub 完整树：`86a402200d95fecef4529d969836f1fe13c6cb0d`，18673 项、`truncated=false`。本次读到的上游电脑控制插件 manifest 为 `0.2.1-alpha.4`；最新源码与本机依赖不可混为一谈。
- 使用当前 `createHarnessDriver` 和 `builtinMcp`，在临时隔离目录连接三个真实 MCP 进程，取得工具目录：3 个时间天气、5 个文档网页缓存、8 个可视化，合计 16。脚本退出 0，无模型请求、无桌面动作、无用户文件修改。
- 本地证据：`.preview-evidence/rust-tool-reuse-inventory.json`、`harness-tool-audit-upstream-tree.json`、`audit-upstream-*`。这些本机调查文件不纳入提交。
- 源码交叉核对：`runtime/builtin-extensions.mjs`、`runtime/tools/provenance.json`、`crates/goose-mcp/src/bin/codebuddy-tools.rs`、`computercontroller/mod.rs`、`common_queries.rs`、`runtime/harness/profile.mjs`。

## 功能映射

| 当前能力 | 上游对应 | 判断与保留条件 |
| --- | --- | --- |
| 文件读写、编辑、glob/grep、PowerShell、任务/子 Agent、技能注册 | `dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-pwsh` 等 | 已经使用上游，不在这 16 个剩余 Rust 工具中。不要再建替代执行器。 |
| `docx_tool`：读取、创建、追加、替换、标题/样式、图片 | `dsh-skill-office` 的 Word 技能；使用 python-docx | 有成熟上游工作流可复用，不是同名确定性 API。需要官方依赖载荷和现有文件交付适配；样式、图片、已有段落及未修改内容须逐项验收后才退役旧工具。 |
| `xlsx_tool`：工作表、列、区域、搜索、单元格读写、公式信息及保存 | Office Excel 技能，openpyxl/pandas，LibreOffice Kit 重算 | 有上游工作流可复用。要核对公式、样式、多表和保存语义；DataFrame 导出不能代替保留原工作簿。不要自行再写一套表格引擎。 |
| `pdf_tool`：提取文字、提取嵌入图片 | `dsh-office-to-pdf`；文件 `read` / `read_image` | 前者是 Office 转 PDF，后两者分别读文本/图像，未找到等价 PDF 提取工具；暂保留。PDF 预览或页面截图不等于提取嵌入图片。 |
| `web_scrape`：text/json/binary 下载并缓存为资源 | `dsh-web` + `dsh-web-fetch-http` + `dsh-tool-web` 的 `web_fetch` | 公网文本读取可直接复用其实现，完整旧合同只部分覆盖：上游拒绝非公网目的地和二进制，输出文本而非旧缓存资源。保留下载、内网、资源回放场景；不要绕过上游固定限制来伪装兼容。 |
| `cache`：list/view/delete/clear 及资源生命周期 | Harness FS、MCP resources、附件/交付机制 | 底层可复用，旧缓存不是同一种存储。需已有缓存路径与历史资源兼容适配，非直接替换；不新增第二套缓存服务。 |
| `time_now`：调用时读取主机/IANA 时区时间 | `dsh-time-context`、已有 pwsh | 上游支持定期步骤时间上下文（默认间隔 10 分钟），不是任意时区查询工具；脚本能读时间也不等于现有结构化合同。保留查询，按需评估时间上下文，避免每步增加重复提示。 |
| `location_resolve`、`weather_get`：地点候选、配置默认城市、联网开关、单位/日期、缓存/限流 | 上游 web search/fetch | 本次官方工具包目录未发现等价地点/天气提供者。搜索结果不能替代这些设置与错误语义，暂保留现有 MCP。 |
| `render_chord`、`render_donut`、`render_map`、`render_mermaid`、`render_radar`、`render_sankey`、`render_treemap`、`show_chart` | `dsh-tool-present`、通用 FS/Shell | `present` 交付文件，不生成图表，也不提供现有 MCP App 嵌入式图表合同。八项暂保留，不用新写 HTML 模板库替换已有 Chart.js/D3/Leaflet/Mermaid 模板。 |

当前 Office 插件、web 插件及 LibreOffice Kit 在本地依赖中可见，但当前 `profile.mjs` 没有挂载这些 Office/web/present 条目，实际工具目录也没有它们。包存在并不等于产品已经启用。`load_workspace_dependencies` 还需要产品自己的 `runtime.json` 和匹配平台的解释器/库载荷；不借用 Codex 应用的私有运行目录作为用户安装包依赖。

## 电脑控制与源码残留

电脑控制目前来自独立 `qwen-computer-use.exe`，它不属于这 16 项 `codebuddy-tools` 的文档/查询/图表目录。上游有 `dsh-experimental-computer-use-cua-driver-mcp` 与 `...-native`，是可评估的独立替换项目，尚未在 CodeBuddy 接入验收。它们复用 Cua Driver 的目录和执行，native 包依赖 `@trycua/cua-driver@0.28.0`，不是 Harness 自己实现的全新桌面引擎，也不意味着消除原生/Rust 依赖。

重要兼容点：上游要求图像能力以接收截图；本项目要求“主 Agent 优先，无图像能力时辅助视觉降级”。直接换插件不足以保证降级链、前台焦点、输入、取消、跨会话串行与 Win/macOS 权限都保持。应复用现有视觉路由，只做必要接缝，另行真实验收。

`goose-mcp` 源码还含旧 MemoryServer、平台自动化等定义；当前工具入口只接受三个服务，真实目录没有旧 `computer_control`、`automation_script` 或 Rust memory 工具。删除未接入源码属于单独清理，不等于获得上游替代实现；本轮未删除。

## 建议迁移顺序与门槛

1. 先启用上游 Word/Excel 技能和公网 `web_fetch`，接入现有按需发现，避免把完整技能/工具描述每轮注入。复用已锁版本；如需要新版功能，单独评估版本升级和打包兼容，不混用 alpha.2/alpha.4。
2. Office 使用官方技能、库及打包载荷；CodeBuddy 仅负责路径、设置和交付展示。首次载荷准备/新增依赖不在本轮执行。检查安装包体积、解释器/LibreOffice 平台文件与第三方许可证，替换 41.5 MB 工具程序并不保证安装包更小。
3. 对照现有操作矩阵验收：DOCX 文本/图片/样式保留，XLSX 多表/公式/区域修改/保存，网页 text/json/binary/内网/超时/缓存回放。先组件自动化，再实际安装版的模型任务和用户入口。
4. 每类验收完整通过才停用相应旧工具。Office 等路径替换完成也不能删除 `codebuddy-tools.exe`，因为天气、PDF 和图表仍在使用。
5. 对暂缺等价上游能力的工具继续通过官方 MCP 接入；将来评估成熟、维护中的外部提供者时，同样检查功能、许可证和平台合同，不重写一套来达成“零 Rust”。

本轮结论是源码/合同调查与真实目录核验，不是上游替代功能的 E2E 通过。未生成新安装包，Harness14 保持当前状态。

## 官方依据

- [上游 Office 技能](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/skill/skill-office/README.md)
- [官方依赖载荷查询](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/skill/tool-workspace-dependencies/README.md)
- [公网 HTTP fetch](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/web/web-fetch-http/README.md)
- [Office 转 PDF](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/document/office-to-pdf/README.md)
- [文件交付 present](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/deliverables/tool-present/README.md)
- [时间上下文](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/context/time-context/README.md)
- [Cua Driver 原生插件](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/experimental/computer-use-cua-driver-native/README.md)

其他语言：[繁體中文](2026-10-16-rust-tool-reuse-audit.zh-TW.md) · [English](2026-10-16-rust-tool-reuse-audit.en.md)。
