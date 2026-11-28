# 流式缓存、追尾与代码导航修复实施记录

日期：2026-11-28。状态：本批 A/B/N 实现、相关自动门禁、独立审查和部分真实 Electron/GLM 场景检查已完成；源码预览保持打开。未提交、未推送，未宣布用户整体验收通过。

## 源码身份与范围

- 工作区：`C:\Users\admin\Documents\ChatGPT\codebuddy-v1`。
- 用户批准后新建分支：`codex/fix-streaming-navigation-20261128`。
- 基于 HEAD：`bcc6ab77731cc6f1c67985a83f71f1ecb0e41d15`。
- 原有 16 个 tracked dirty 文件与原有 untracked 文件均保留。开工 tracked 差异与文件 hash 在 `.local/fix-streaming-navigation-20261128/before.patch`、`before.json`；本记录不把先前连接复用、parser 等改动冒称本轮新增。
- 依据：已获用户同意开始实施的 [ADR-005](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/documentation/codebuddy/decisions/ADR-005-streaming-presentation-reuse.md)。A、B 原生候选与 N 为当前切片；展开思考 renderer 的全面替换仍不在本批内，未添加 Streamdown/use-stick-to-bottom 等新前端依赖。

## A：恢复现有完成块缓存

- 新 `AnswerFilesProvider.tsx` 只稳定同 session/turn 的原始、有序 key/path 展示词汇；`ProgressiveMessageList.tsx` 接入。文件事实仍来自真实回执投影。
- `remarkDeliveredFileLinks.ts` 将 Context/插件输入收窄到实际读取的只读 key/path。不是冻结整份文件 ledger；新增、撤销、歧义、仅 key 变化、scope 切换都使缓存失效，children/正文继续更新。
- 不修改 renderer 类型、Markdown 语义、模型接纳或正式历史。JSON 投影仍有按文件词汇长度的成本，单条巨大 Markdown 的 DOM/整树成本并未消失。

回归先在 raw Provider 上确认等价空/非空事实会让完成块重算，测试 exit 1；修复后通过。另把修复依赖临时添回 raw files 引用，真实测试再次失败，逐字恢复原文件，变异记录 `answer-files-mutation.log`。首次 key-only 夹具误把无回执时的原始占位文本当链接；已更正，不计为产品缺陷证据。

同一当前 ScrollArea 下的 headless 对照：真实修复 Provider vs raw fresh Provider，React render actualDuration P95 为 22.8ms / 559.4ms，活跃帧 P95 为 50.2ms / 633ms。80 个输入、23832 字符、最终文字 hash/DOM 数量一致；真实 Provider 消费值只发布一个等价引用，正文正常推进。此数据不代表数组分配时间、发布版提速倍数或完整消息列表 E2E。

真实 `collectConversationChanges` 的结构化内存回执序列 9 状态检查通过：新增/撤销、歧义、scope，以及无关 Node 身份、焦点与 Selection。它没有执行真实用户文件写入或证明用户业务任务已完成。首轮一个普通链接夹具缺尖括号、被原语法解析为纯文本的失败产物保留，修正语法后重新检查，没有改产品绕过。

## B：用同一 owner 跟随真实布局

- `scroll-area.tsx` 移除 480px/s 速度帽、加速度和持续 rAF 积分，改为至多一个待执行帧读取当前 floor 后定位；内容/viewport ResizeObserver 与 React 更新共用该执行器，无 idle 动画循环。
- 现有 follow/read、programmatic、阅读/折叠锚点与显式 instant jump 保留；没有额外滚动控制器。新观察 viewport，覆盖仅容器高度变化。
- 新 `selectionchange` 保护本 viewport 的新增/变化非折叠选区；清空或外部选区不自动恢复跟随。显式跳底确认旧选区端点，后续同一旧事件不否决用户恢复，也不清全局 Selection。

正式几何回归在旧积分器下先红（1800px 高度增长后只移动到 501，期望最新 floor 2300）；新原生追尾及 viewport 缩小检查通过。选区回归也先红（已选中仍跟随），修复后覆盖旧选区显式恢复、变化再暂停、清空不恢复和外部选区无影响。

最终 Selection 版本以真实浏览器 Selection API 验证 11 个状态、7 次 UA 原生可信 selectionchange 事件，exit 0。仅 viewport 高度由 520 缩到 320 时，scrollTop 由 481 到 681，底距 0；阅读模式扩大 viewport 保持原 scrollTop，不恢复跟随。250/900px/s 两组增长实测约 248.7/895.3px/s，底距 P95 为 8/29px，停流后约 21.4/21.5ms 首次观察到距底 ≤2px；上滚后增加内容不抢回，活跃帧 P95 为 16.9/17.0ms、无 longtask。结果在 `perf/final-b-analysis.json`；这些是隔离组件测量，不代替 Electron/用户验收。

## N：补齐只读事实，查询不隐式安装

- 固定 `developmentTools` 工厂提供既有 readOnlyHint/non-destructive 事实，继续复用 driver/Compat 的定义身份、显式 ask/deny、安全复审，不按名称全局放行。
- `code-navigation.py` 一次性和原生 serve 共同调用新 `code_navigation_runtime.py`。Serena 继续拥有语言选择、三查询、MCP server 与生命周期；原 Windows Job、外层结果 writer 和取消 owner 不变。
- 使用受保护、非公共 Factory hook 传递同一已检查的内存 config/RegisteredProject，防配置重读重新引入 activation 或语言服务安装。固定 Serena 版本、mcp.py SHA 和签名，不匹配时明确未准备，未改 vendor 或复制 MCP 协议。
- 在任何服务启动前检查全部拟启动语言；Python 固定已有 Pyright，TypeScript 使用正式 pair 或同 host state 的完整固定缓存。其他语言、缺载荷或越界工作区明确未准备，不回落 managed installer。
- 专用实例仅在内存约束 trust，避免项目 activation/custom LS command 生效，不持久化用户 trust。TS 初始化指向已检查的 tsserver，禁用 ATA。
- `typescript-runtime.json` 固定官方两包的版本、许可、URL、SHA-512；`prepare-typescript-runtime.cjs` 仅为显式准备，不被导航或启动调用，不使用 npm install。生成目录已 gitignore。用户明确授权后已取得两个固定归档，校验并解包到正式目录。

20 项相关 Node 门禁通过，包含 7 个 Python bootstrap 合同、实际权限/同名替换、真实 Python 查询/索引刷新/双项目隔离和真实受控 TS 缓存三查询；0 skip。受控 TS 查询由实际 Compat 默认策略处理，0 次询问，没有调用模型。将 trust 故意改回后，Temp 项目 activation 确实写出 marker、回归 exit 1；源码逐字恢复并核 hash。

正式 TypeScript pair 准备命令 exit 0；全新 Temp workspace/profile、不复制旧缓存的实际 Harness/Serena/LSP 三查询成功（overview 6555ms、definition 103ms、references 204ms），0 次询问，fallback 缓存前后均不存在。实际 `copyRuntimeSources` 的隔离 staging 校验通过，server/tsserver/marker SHA 与原件一致；没有生成发行安装包。打包门禁复用无下载副作用的 pair/provenance 校验，存在但为 JSON null 的三种载荷 metadata 均不能跳过就绪检查。

## 验证账本与未完成项

| 检查 | 实际结果与边界 |
| --- | --- |
| A 三相关 Vitest 目标 | 99 tests pass，exit 0 |
| A+B（含选区）两目标 | 10 tests pass，exit 0 |
| 9 个相关前端目标综合 | 首次 221 pass、3 fail；3 处停止前缀旧断言在 HEAD 源码上同样失败，已逐字恢复工作树 |
| 同步旧断言后的 process 目标 | 29 tests pass，exit 0；其余 8 目标已在综合检查通过，不为凑整重复全套 |
| TypeScript noEmit | exit 0，使用已授权的本机现有 TypeScript 入口 |
| A 正反变异/真实当前组件遥测 | 变异能失败，源码恢复；headless 组件结果与产品验收分开 |
| 导航集中 Node 门禁 | 20 pass / 0 skip，exit 0；含 7 Python 合同，不重复算成 27 个 Node 测试 |
| 原生组件最终 B 验证 | Selection、仅 viewport、持续增长三项 exit 0，最终源 hash 一致 |
| 正式 TS 归档与全新无缓存查询 | 准备、三查询、隔离 staging 均 exit 0；不等同干净机器安装验收 |
| 最终准备/打包门禁 | 两个本地脚本目标 10/10，exit 0，包含三种 null metadata 拒绝；fetch=0 |
| Electron/真实模型/视觉 | 当前源码预览 + GLM 5.3，导航实际回执、展开思考、上滚阅读、回到最新及长正文跟随已检查；不是完整用户体验/所有场景 PASS |

正式入口仍是仓库根 `start-preview.ps1`。现有 preview 使用 `.local/steering-desktop-20261127` 隔离 profile；不改安装版或用户生产数据。重启回执中的 launcher/runtime/desktop PID 为 23644/24296/25660，runtime sourceHash 为 `1efaa0b4d4f1020c4ffb1e8875e8f5f257f09b5048fb8bed58250cf580bf26b3`，restartRequired=false；assets 的身份另见导航 verification.json，不能仅用 runtime 指纹推定 Python/TS 载荷身份。文档/说明、源 hash、headless 夹具、旧断言基线日志及失败产物均留在 `.local/fix-streaming-navigation-20261128/`，不提交本地 profile/夹具。

未解决或不能承诺：展开思考的完整树变换、单个巨段/未闭合巨大代码、全部历史 store/list CPU 成本，以及真实前台的主观丝滑程度。当前修复不强制模型机械回复，不改变插话后端或限制输出，未宣称根除所有卡顿。

## 当前源码 Electron / 真实 GLM 检查

使用 Computer Use skill 的真实 Windows 交互，未注入 DOM 或伪造后端工具事件。目标为上述新启动的源码预览；新工作区只关联本批 `.local/.../acceptance-project` 的两个自建源文件，不涉及用户业务项目或安装版数据。选择的模型为 `glm-5.3`、极致思考。

1. 会话 `7b01e727-b8f7-403c-86bd-7e293bced090` 输入“用代码导航找一下 main.ts 里 add 的定义和引用，再看看 sample.py 里 multiply 的定义。”真实工具 seq36–39 中 TS 定义与引用成功，分别约 6850/5269ms；Python seq40–46 两项失败。没有点击授权控件，会话中无 `approval/asked` 事件，UI 也没有导航授权卡。
2. 失败并非被隐藏：夹具生成的 Serena `project.yml` 只选 typescript。固定 vendor 的 `serena/config/serena_config.py` 非交互模式只选文件占比最高的一项，旧入口同样使用该规则；本批 bootstrap 没有剔除 Python。仅在自建夹具写原生 `project.local.yml` 的 `language_servers: [typescript, python]`，不改产品路由或用户项目，然后通过界面新建同工作区聊天。
3. 新会话 `832584d8-db72-4e6a-88a2-107c28d842ec` 的 seq31–36 真实回执确认三项均成功：TS 定义约 6307ms、引用 5272ms、Python 定义 457ms；无 `approval/asked`，未作权限点击。说明“已安装服务”不等同“项目已启用该服务”，README 已记录原生配置与新实例要求。不能据此宣称任意混合语言项目自动可用。
4. 首会话继续输入自然写作/翻译需求。持久历史记录本轮思考 62250 字符、中文正文 4009 字符，下一轮思考 31318 字符、英文正文 13312 字符，均有真实 `turn/end`；不是只测几行静态文本。
5. 展开实时思考后点击回到最新，当前尾部进入视野；流中上滚后，同一阅读段落在后续思考和正文继续生成期间保持，回到最新按钮可用；显式点击后视野返回末尾。下一轮未操作上滚时，观察到英文正文持续推进至末尾，结束后最后段和操作区可见，没有需等停流后才补滚到最新的现象。

这组 CU 检查确认特定真实场景的行为，没有高帧率录屏或完整 Electron 帧遥测；不能仅凭截图、自动化快照耗时或模型自述判断“已经与 WorkBuddy 一样丝滑”。用户的主观丝滑程度、跨平台、复杂项目全量工具/媒体仍未验收。已知超长思考完整文档处理保留，后续 renderer 迁移仍按 ADR 的独立试点边界推进。

完整原始会话在隔离 profile 的 `backend/harness/sessions/--C-Users-admin-Documents-ChatGPT-codebuddy-v1-.local-fix-streaming-navigation-20261128-acceptance-project--/<sessionId>/session.v4.jsonl`。本地精简证据为 `acceptance-<sessionId>.json`，保留事件类型计数、工具实际回执、字符数与源 hash，不复制提供商凭据。

## 本批实际文件与验证命令

| 文件 | 本批变化 |
| --- | --- |
| `ui/desktop/src/components/AnswerFilesProvider.tsx`、同名测试 | key/path 展示投影的同 scope 稳定引用，以及真实 Markdown 回归 |
| `ProgressiveMessageList.tsx`、`remarkDeliveredFileLinks.ts` | 接入稳定 Context；插件只消费实际所需的只读 key/path |
| `MarkdownContent.test.tsx`、`ProgressiveMessageList.process.test.tsx` | 类型夹具收窄；同步已存在的用时文案，不改产品停止状态 |
| `ui/desktop/src/components/ui/scroll-area.tsx`、同名测试 | 同一跟随 owner 单帧追尾、viewport 与选区边界 |
| `runtime/development-tools.mjs`、`runtime/assets/code-navigation.py`、新 `code_navigation_runtime.py` | 固定工具只读事实；共用受版本 guard 约束的无隐式安装 bootstrap |
| `runtime/tests/code-navigation.test.mjs`、新 `code_navigation_runtime_test.py` | 权限、语言载荷、安全配置与真实语言服务合同 |
| 新 `runtime/assets/typescript-runtime.json`、`scripts/prepare-typescript-runtime.cjs` 及其测试 | 固定官方二包及显式准备；本地归档、越界与目标保留回归 |
| `scripts/stage-harness-distribution.cjs`、`scripts/distribution-credentials.test.cjs` | staging 的完整 pair/provenance 门禁与 present-null 拒绝 |
| `.gitignore`、`README.md`、fact authority、`PROVENANCE.json`、ADR-005 与本记录 | 生成目录排除、准备/职责/固定上游合同与实际边界 |

`runtime/harness/driver.mjs`、`mcp-bridge.mjs`、`GooseMessage.tsx`、`LoadingGoose.tsx`、`MarkdownContent.tsx`、`ThinkingContent.tsx`、`streamingMarkdown.ts` 的当前字节 hash 与开工备份一致；这些文件已有 dirty 不能算作本批新增修改。

以下为本批实际使用的已有验证入口，均未安装前端依赖：

```powershell
# cwd: ui/desktop；已有授权允许使用现存 TypeScript/Vitest
node ../node_modules/typescript/bin/tsc --noEmit
node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/AnswerFilesProvider.test.tsx src/components/MarkdownContent.test.tsx src/components/streamingMarkdown.test.ts src/components/ui/scroll-area.test.tsx src/components/ProgressiveMessageList.test.tsx src/components/ProgressiveMessageList.files.test.tsx src/components/ProgressiveMessageList.process.test.tsx src/components/ThinkingContent.test.tsx src/components/WorkHistoryWindow.test.tsx
node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/ProgressiveMessageList.process.test.tsx
# cwd: 仓库根
node --test --test-concurrency=1 runtime/tests/code-navigation.test.mjs runtime/tests/development-tools.test.mjs runtime/tests/session-approval-contract.test.mjs scripts/prepare-typescript-runtime.test.cjs
node --test --test-concurrency=1 scripts/distribution-credentials.test.cjs scripts/prepare-typescript-runtime.test.cjs
node scripts/prepare-typescript-runtime.cjs
node .local/fix-streaming-navigation-20261128/navigation/verify-typescript-formal.mjs
git diff --check
```

结果以此前账本为准：前端综合首次并非全绿，后续只重跑受影响的 29 个用例；总计 9 目标的 224 个不同用例分别通过，不能写成一次全绿综合运行。`tsc`、最终打包门禁和 `git diff --check` exit 0。没有运行 Rust 全套、发行构建或安装包。独立审查先提出打包 present-null 的 P2，修复与回归后收尾审查确认已消除、无新的 Required。

## 追加：2026-11-28 最终独立审查与项目缓存隔离

前文是当时批次账本。本轮用户授权把剩余前端和导航一起审查、测试后本地提交，不推送；详细提交/合并交接追加在[插话交接第10节](../2026-11-27/follow-up-steering-handoff.zh-CN.md#10-2026-11-28-追加流式展示导航和权限修复的合并交接)。

独立审查发现本批可信只读导航必须关闭的新边界：固定Serena的SolidLSP初始化读取工作区`.serena/cache/<language>/{raw_document_symbols.pkl,document_symbols.pkl,document_symbols_cache_v23-06-25.pkl}`。pickle先反序列化再核版本，可以执行项目带来的代码；取消trust/activation不能阻止。上游`ProjectConfig.load()`还会补写不完整YAML，并可能顺着`.serena`目录链接改写工作区外文件。它们是上游/旧入口已有行为，本批新增默认allow后必须处理，不能把普通查询每次审批当作修复。

使用隔离Temp项目，构造只写无害marker的pickle，通过实际工具入口复现旧实现写出marker，新增回归exit1（`navigation-cache-red.log`）。修复后fallback一次性入口和Windows原生私有连接均查询成功、marker不存在；原项目YAML、旧全局profile及其注册的其他项目YAML逐字不变。目录junction指向工作区外时拒绝，外部目录没有新文件。不存在项目配置时不生成`.serena`文件；local-only项目配置依然生效。

复用方式与边界：

- `code-navigation.py`在Serena导入前使用标准库`TemporaryDirectory`建立全新工作区外的`SERENA_HOME`，每个服务进程一份；先创建私有派生项目目录，防上游fallback。不迁入旧项目pickle或原全局注册项目，静态LSP载荷仍使用原来经过检查的state。fallback Python同时使用`-I -B`。
- `code_navigation_runtime.py`复用上游纯YAML/default/local转换helper，缺base复用`autogenerate(save_to_disk=False)`，不用会回写的`load()`；不自行实现YAML解析或语言探测。配置路径必须在真实工作区内，项目prompt/mode不进入专用查询实例；实际查询仍是原MCP/Serena/LSP。
- 新增config模块SHA guard：`serena/config/serena_config.py`为`0149cbafedb537f769a00a8e1ee69f70cb7976657e419ffd1df9a736d16289e3`，与既有Serena版本、mcp模块SHA和工厂合同一起锁定；升级必须重审。
- 正常退出清理私有临时目录；Job强杀/进程崩溃不能保证Python执行finally，可能留下不再复用的临时目录。本轮不扫描或删除用户Temp，也不把清理当作关闭获证。

本轮实际验证（已有依赖，无新增下载）：

| 命令/证据 | 结果和范围 |
| --- | --- |
| 已有Vitest入口，17个相关目标 | 384 pass / 17 files，exit0；`frontend.log`。包括完成块/链接/回执、Goose、Thinking、ScrollArea、process、WorkspacePanel/Document和follow-up mode |
| `node ../node_modules/typescript/bin/tsc --noEmit`，cwd ui/desktop | exit0；`tsc.log`为空，退出码以执行回执为准 |
| `node --test --test-concurrency=1 runtime/tests/code-navigation.test.mjs runtime/tests/development-tools.test.mjs runtime/tests/session-approval-contract.test.mjs runtime/harness/test/code-navigation-connection.test.mjs scripts/prepare-typescript-runtime.test.cjs scripts/distribution-credentials.test.cjs` | 37 pass / 1 skip，exit0；含Python10合同（嵌套在1个Node目标，不重复计数）。skip为未设`CODEBUDDY_TEST_TS_LSP`的受控缓存目标；没有声称无skip |
| 最后两处错误信息/Temp范围检查后重跑code-navigation目标 | 11 pass / 同一受控缓存skip，exit0；`navigation-final.log`。补旧全局注册项目不回写断言后，仅重跑该pickle目标，exit0；不把重复运行加成新用例 |
| 已有正式TS验证脚本`node .local/fix-streaming-navigation-20261128/navigation/verify-typescript-formal.mjs` | 全新Temp项目/profile，无旧fallback缓存，实际三查询7362/99/199ms，0审批；隔离staging校验通过、sourceUnchanged=true，exit0。是当前正式pair，不把缺少的受控缓存夹具说成已测 |
| 内存副本变异私有目录范围条件 | Python10合同产生5个error、exit1，证明门禁能发现条件反转；产品源文件从未改写，避免热加载影响用户窗口。正常候选合同已包含在前述绿色门禁 |
| 官方DeepSeek Flash low真实三轮 | 19.024s / 6.985s / 7.476s，5次TS/Python三类导航全部成功、0审批，第三轮真实write说明.md成功，文件1621 UTF16且含调用关系；12次实际上游请求均断言`model=deepseek-flash, reasoning_effort=low`，sourceUnchanged=true，exit0 |

Flash测试第一次三轮后，本地验证脚本清理阶段误把同步`driver.cancel()`当Promise使用，exit1；原始日志保留`flash-helper-failure.log`，不计为完整通过。只修本地验证脚本后有界重跑，最终结果在`flash-result.json`；没有为此改产品或换模型/思考档。第三轮先read尚不存在的说明.md得到真实错误，再write成功，这是模型检查文件的正常路径，未伪称全部工具都无错误。

本轮原始证据均在`.local/final-review-20261128/`，不提交。独立Agent复核前端19个文件及最终源码hash，无Required；导航原Required修复后静态复审无新增Required，再核实际退出码。前端同4核心SHA的既有十轮Electron证据继续有效，Flash本轮为真实后端集成验证，**不是新增桌面CU或安装包验收**。已有预览未为本轮关闭/重启，不能断言其旧连接已加载新导航；接收方正式验收需按README重启并核身份。
