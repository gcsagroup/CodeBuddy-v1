# 工具箱验收报告（2026-10-16）

> [后续：已批准的 Office 合并实施与最新验收](2026-10-16-office-consolidation.zh-CN.md)。
对应源码：`main` / `e9540aa8b35f5ed63a136455a52e72137fd73918`。验收目录：`D:\CodeBuddy-v1`。真实桌面使用该批次 H15 本地应用 `ui/desktop/out/CodeBuddy Harness-win32-x64/CodeBuddy.exe`，隔离测试配置和工作区。本报告不代表新安装包验收，也不代表任意模型、任意文档均已通过。

## 结论

- 25 个内置 MCP 工具均有实际调用记录：24 个通过本轮代表性场景；旧 `docx_tool` 存在已复现的数据丢失缺陷，不列为通过。这个数字是工具级覆盖，不是全部参数组合的覆盖率。
- 电脑控制 9 个工具覆盖主 Agent 视觉和辅助视觉降级，真实模型完成专用窗口操作。8 个图表工具完成真实模型调用及桌面渲染检查。
- 上游 Office 技能、新增技能、原生文件/命令工具可用；具体证据层级见下表。Git、记忆等本轮为集成测试，并非重新逐个点击桌面入口。
- Exa 两项实调通过；Tavily 搜索和提取通过，另外三项缺少 API Key；GitHub 官方 MCP 缺少 Token。
- 用户已要求本轮暂不测外部安全 MCP“1”。仅保留此前连接、工具发现、健康与缓存查询，其他动作不执行。
- 本轮未删除工具、修改产品源码、安装依赖或生成安装包。报告和脱敏清单尚未提交/推送。测试脚本及原始回执保留在忽略目录，避免上传凭据或会话数据。

## 按能力分类

| 能力 | 实际覆盖与结果 | 判定 / 建议 |
|---|---|---|
| 文件与命令 | `read/write/edit/working_directory/glob/grep/read_image/pwsh/web_fetch` 实调；验证文件内容、图片读取和命令结果 | 保留；不等于所有命令都已测试 |
| 按需发现和依赖 | `search_mcp_tools`、`load_workspace_dependencies`、三个 Office `skill` 加载实调 | 保留 Harness 路径 |
| 时间/地点/天气（3） | `time_now/location_resolve/weather_get`；地点查询后用确定坐标获取当前天气和两日预报 | 通过；模糊地点返回 `needs_location` 是正常行为 |
| 电脑控制（9） | `click/drag/get_app_state/list_apps/perform_secondary_action/press_key/scroll/set_value/type_text`；进入页面、输入、快捷键、开关、取消对话框、拖动、滚动、保存并完成 | 场景通过；模型参数稳定性有保留意见，见下文 |
| 图表（8） | `render_chord/render_donut/render_map/render_mermaid/render_radar/render_sankey/render_treemap/show_chart`；实调、资源读取、8 个图表 guest frame 的 SVG/Canvas/文本及桌面截图 | 通过基础渲染；未覆盖全部图表交互及导出 |
| 旧 DOCX（1） | 创建、格式、加图、提取及替换均调用；替换文字后图片从 1 张变成 0 张，工具仍报成功 | **有缺陷，优先迁移/淘汰旧实现** |
| 旧 XLSX（1） | 工作表列表、列、范围、找文字、单元格、更新、保存；独立读取确认 B2=7、公式 C2=`=B2*2`、另一表内容不变 | 本例通过；与上游 Office 重叠，可待兼容迁移后精简 |
| PDF（1） | 测试 PDF 文字提取和内嵌图片提取，回执包含 1 张 2×2 图片 | 基础通过；未测试扫描件 OCR、复杂版式和全部 PDF 变体 |
| 网页抓取（1） | 隔离本地 HTTP 夹具的 text/json/binary 三种模式 | 通过；非任意网站兼容性保证 |
| 缓存（1） | `list/view/delete/clear`，只操作隔离验收缓存；独立确认清空 | 通过；未操作用户缓存 |
| 上游 DOCX/XLSX 技能 | 本轮上游工具回归通过；同 revision 上一批真实模型保留图片/粗体、公式/其他工作表及原件的证据复用 | 保留；区分本轮回归与复用的真实对话证据 |
| 上游 PPTX 技能 | Kimi 创建两页，修改第一页指定文本，独立读取确认原件、第二页保持不变 | 内容编辑通过；未验视觉排版。Gemma 同场景未完成 |
| 新增自定义技能 | 预览、应用、列表、执行 A、更新 B、禁用/启用、重启后再次执行与保留对话事实 | 通过隔离场景；首次模型从工作区读取技能定义，不据此声称每次都进入会话摘要目录 |
| Git / 项目记忆 / 目标 / 后台任务 / 子 Agent | 六个相关测试文件合计 49 个测试通过，含本地 Git 写入与权限、记忆作用域/分页、技能库、上游工具和目标能力 | 自动化覆盖；并非每个底层工具的独立真实模型 E2E |
| 兼容入口 | `tom/code_execution/summarize/todo/apps` 等托管入口 | 名称存在不等于重复引擎；应按 Harness 映射保留，未证实为无用代码 |
| Exa | `web_search_exa`、网页抓取工具实调返回内容 | 两项通过，保留 |
| Tavily | `tavily_search/tavily_extract` 实调通过；`tavily_crawl/tavily_map/tavily_research` 返回 API Key 要求 | 后三项为缺配置；当前停用状态未变。若不需要备用搜索，可移除用户配置，不宜据此删除实现 |
| GitHub 官方 MCP | 缺少 `CODEBUDDY_GITHUB_MCP_TOKEN`，未调用仓库操作 | 待配置；不能归为无用工具 |
| 外部安全 MCP“1” | 发现 150 项；只调用 `server_health/get_cache_stats`。服务器自报 124 个依赖中 74 可用、50 缺失 | 按用户要求排除本轮后续验收；依赖数量不是 150 个工具的通过率 |

逐项状态见 [CSV 清单](2026-10-16-toolbox-audit.csv)。`NOT_INDIVIDUALLY_TESTED` 表示只清点或有模块级覆盖，不冒充单工具通过；`EXCLUDED_BY_USER` 表示本轮主动排除。

## 已定位的问题及删除建议

1. **旧 DOCX 替换操作丢图片（实证）**：`crates/goose-mcp/src/computercontroller/docx_tool.rs` 的 `do_replace` 新建 `Docx`，只重建段落中的文字 run，再覆盖原文件。图片未复制；表格等其他节点也未见保留逻辑，但本轮独立复现的是图片损失。优先用已有上游 `office-docx` 迁移调用；保留历史兼容边界后再删除旧工具，避免删掉整个 `computercontroller` 时连 PDF/缓存/网页抓取也丢失。用户配置中旧 computercontroller 当前已停用，本轮没有更改开关。
2. **模型参数兼容（实证）**：Gemma 的 PPTX 场景反复省略 `pwsh.description`，触发 `INVALID_ARGS`，达到测试 20 轮上限仍无产物。它是未完成验收，并非 Office 库失效。Kimi 同任务完成且产物独立校验通过。电脑拖动首次模型把数值坐标发成字符串；明确要求 JSON 数字后重测通过，原始尝试的不稳定性仍保留记录，未靠模型自述判断桥接层故障。
3. **配置缺口**：Tavily 三项结果虽然 `isError:false`，正文明确要求 Key，按缺配置处理。GitHub 缺 Token。外部服务缺依赖不等于本项目源码缺陷。
4. **精简次序**：旧 DOCX 是首要替换候选；旧 XLSX/网页抓取存在功能重叠，可完成协议及行为对照后精简。保留 PDF、缓存、电脑控制、图表、原生开发、Git、记忆和技能入口。本轮没有证据支持整组删除工具箱能力。

## 验证与证据

原始证据均在本机 `.preview-evidence/`（不提交）。不发布原始会话、MCP URL 或配置。

| 入口 / 命令 | 结果 | 证据 |
|---|---|---|
| `node .preview-evidence/toolbox-execute.mjs` | 初次 52 条调用，48 PASS / 4 FAIL；4 项来自测试夹具缺少视觉能力/查询 metadata，修正夹具后复测 | `toolbox-20261016/execution.json`、`retest.json`、`followup.json` |
| `node .preview-evidence/toolbox-followup.mjs` | 天气复测通过；独立 DOCX 前后校验确认图片损失 | `toolbox-20261016/docx-image-regression.json` |
| `node .preview-evidence/toolbox-cache.mjs` | 退出 0；缓存生命周期通过 | `toolbox-20261016/cache.json` |
| `node .preview-evidence/toolbox-computer-numeric.mjs` | 退出 0；主视觉可见状态核验通过，12 次拖动移动、滚动 100 | `real-computer-main-Insa79/receipt.json` |
| `node .preview-evidence/toolbox-computer-entry.mjs auxiliary` | 退出 0；辅助视觉 7 次观察，进入/输入/保存/完成及滚动通过 | `real-computer-auxiliary-Z87J3T/receipt.json` |
| `node .preview-evidence/toolbox-custom-skill.mjs` | 退出 0；自定义技能生命周期通过 | `real-skills-6sDNmz/receipt.json` |
| `node .preview-evidence/toolbox-pptx-kimi.mjs` + 独立 Python 读取 | 退出 0；两页编辑及原件保留通过 | `toolbox-20261016/pptx-kimi/independent.json` |
| `node .preview-evidence/toolbox-charts-ui.mjs` | 退出 0；27.3 秒完成，记录 8 个真实渲染 guest frame | `toolbox-20261016/charts-ui.json`、`charts-frames.json`、`charts-ui.png` |
| `node .preview-evidence/toolbox-chart-capture.mjs` | 后续补截图退出 1：当前页面未发现目标 frame；补取证未完成，不覆盖前一次渲染证据 | `toolbox-chart-capture.log` |
| `node .preview-evidence/toolbox-external-call.mjs` / `toolbox-tavily-call.mjs` | 退出 0；逐项结果仍按内容判定，非一律 PASS | `toolbox-20261016/external-calls.json`、`tavily-calls.json` |
| 六文件 Node 回归（见下） | 退出 0；49 PASS / 0 FAIL / 0 SKIP | `toolbox-contract-tests.log` |
| `node .preview-evidence/h15-preservation.mjs` | 退出 0；661 个原有会话保留，providers/preferences 哈希未变 | `h15-user-preservation-after.json` |

```powershell
node --test runtime/tests/git-write-acp.test.mjs runtime/tests/memory.test.mjs runtime/tests/library.test.mjs runtime/harness/test/upstream-tools.test.mjs runtime/harness/test/capabilities.test.mjs runtime/harness/test/goals.test.mjs
```

Node 使用本机现有 Codex Node 24；Python 使用项目 `runtime/py/dependencies/python/python.exe`。Tavily 仅通过 `npx --offline` 使用已缓存载荷。没有为本轮测试更改系统 Python 或下载依赖。

本轮只做工具箱审计，未重新执行 macOS、安装包、长任务多次压缩、全部前端入口验收。已发现的旧 DOCX 缺陷和模型参数问题均未在本轮修复；报告保留其风险，不宣称第一版全部功能已通过。
