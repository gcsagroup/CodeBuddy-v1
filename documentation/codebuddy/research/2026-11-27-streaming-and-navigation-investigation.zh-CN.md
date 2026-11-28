# 流式显示、追尾滚动与代码导航调查

调查日期：2026-11-27，2026-11-28 收尾。状态：调查与方案，尚未实施本轮产品修复。

## 结论与边界

用户反馈“正文起初流畅，越往后越不顺；思考经常顿挫；后面已经生成了正文或工具内容，视野还没跟上”。本轮已经取得两类独立的运行证据：长文追加的帧间隔变差，以及渲染很轻时滚动仍能持续落后。它们不能合并成一个“模型出字慢”的问题。

1. 当前真实 Markdown/Thinking 组件在长前缀下都出现帧劣化；思考的 React render 成本更高，但不能据单次帧指标宣称两路始终谁更卡。思考没有逐词动画，故不能把两路全归因于动画。
2. 展开思考只缓存了增量解析，后续完整 AST 复制、转换和 React 元素构造仍随累计内容增长。局部处理探针已验证：解析尾部大小近似相同，后续处理耗时仍明显随全文长度增加。完整产品各阶段占比尚未取得。
3. 当前追尾算法限制最高约 480 px/s。真实 ScrollArea 加轻量内容、实际增长约 895 px/s 时，帧仍平稳，但停流时落后约 1418px，继续约 3 秒才追到底。这是独立于 Markdown 卡顿的可复现问题。
4. 代码导航反复询问有确定的宿主事实缺口：可信工具工厂没有提供既有机制识别的只读 annotations。查询失败另有输入目标、符号歧义、拒绝及取消诊断问题；不能只改权限就声称全部修好。
5. 本轮未改产品、权限设置、依赖、模型配置或用户项目。没有把 headless 组件诊断当作真实 Electron 产品验收，没有承诺“根除所有卡顿”。

## 源码身份与已交付内容

- 工作区：`C:\Users\admin\Documents\ChatGPT\codebuddy-v1`。
- 当前分支：`codex/research-streaming-navigation-20261127`。
- HEAD：`bcc6ab77731cc6f1c67985a83f71f1ecb0e41d15`。
- 进入新分支时已有 Markdown/Thinking/ScrollArea 及导航未提交切片；全部保留。本报告评价当前工作树，不能等同于纯 HEAD 或安装版。
- 相关夹具记录采样前后源码 SHA256；基线 11 个文件、局部处理探针 5 个文件均未变化。未使用此前有 DOM 身份/焦点问题而被拒绝的 candidate-v2 补丁。
- 已验收插话功能的 `520e6a87`、文案 `990c1562` 与交接 `bcc6ab77` 已推送到 `origin/codex/steering-mode-20261127`；没有推送 main。本研究分支尚未推送。
- 已推送交接：[给组长的 TXT](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/documentation/codebuddy/reports/2026-11-27/给组长-插话改动交接.txt)、[给组长 Codex 的详细 MD](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/documentation/codebuddy/reports/2026-11-27/follow-up-steering-handoff.zh-CN.md)。本报告不扩大此前插话验收范围。

## 调查方法与责任链

```mermaid
flowchart LR
  A[模型/工具事件] --> B[Harness与Compat保留真实状态]
  B --> C[ACP adapter更新当前消息]
  C --> D[session store发布快照]
  D --> E[消息列表与Markdown渲染]
  E --> F[DOM高度变化]
  F --> G[ScrollArea决定是否跟随与如何追尾]
```

模型和传输负责事件什么时候到；adapter/store 负责接纳并保存累计内容；React/Markdown 负责何时把已收到内容变成 DOM；ScrollArea 负责读者是否在跟随、视野如何移动。文字未显示、文字成组出现、视野落后和用户主动上滚是四种不同事实，需要分别测量。

本轮采用固定输入的真实组件夹具、同步 Markdown 阶段探针、轻量几何增长探针，以及真实 Harness/Compat 权限和实际 Serena 查询。子 Agent 分别做测量、成熟实现对照和导航诊断；根 Agent 重读相关源码、原始结果并作局部处理测量。独立审查已纠正 Profiler 指标命名，未把第三参 actualDuration 当作 DOM commit 阶段耗时。

## 一、长文帧劣化：已观察到，完整产品占比仍未知

### 有效基线

使用当前真实 `MarkdownContent`、`ThinkingContent`、`ScrollArea` 和样式。先放入不同长度前缀，再追加相同 80 个 delta；每个 delta 为“继续检查显示位置和实际回执。”，每 8 个加空行。Worker 请求 32ms 定时，但实际发送 P95 约 41–46ms，不能称作精确恒定源。sent/received/React 提交时间戳/rAF 均使用共同 epoch。

| 初始段落数 | 思考活跃帧间隔 P95 | 正文活跃帧间隔 P95 | 思考 render actualDuration P95 | 正文 render actualDuration P95 |
| --- | ---: | ---: | ---: | ---: |
| 20 | 16.9ms | 16.9ms | 3.9ms | 3.8ms |
| 300 | 16.9ms | 16.8ms | 14.5ms | 10.2ms |
| 600 | 49.9ms | 33.5ms | 25.9ms | 17.5ms |

这里的 Profiler `actualDuration` 是 React render 耗时，`commitTime` 是提交时间戳；两者都不是 DOM layout/paint 的直接耗时。定义见 [React Profiler](https://react.dev/reference/react/Profiler)。

随后逆序复测 600 段正文、600 段思考、20 段正文、20 段思考：短文两路仍约 17ms；长文正文活跃 P95 为 50.0ms，思考 49.9ms；render actualDuration P95 分别约 19.2ms、27.0ms。长度相关现象跨顺序仍存在，但不能把一次正文 33.5ms、思考 49.9ms 当作稳定的两路帧率优劣。

所有输入均完整收到，最终字符数与预期一致。600 段组相邻 Profiler 提交时间之间最多收到 2 条 delta，但当前计数来自接收回调 ref，没有按每次渲染 content 长度核对，不能据此断言同一 DOM 批次包含几条。50ms 帧间隔不代表存在一个 50ms 的 JS task；本轮没有捕获到 ≥50ms 的单个 longtask。

这是开发版 React Profiler、headless Edge 158.0.4370.45、760×520 滚动区的组件测量；存在测量读布局的开销，且不是独占机器。没有完整 ACP store、历史消息列表、真实网络和真实模型。预置 600 段不能等同于用户当次实际长度，也不是同一聊天从零增长的全程追踪。

### 思考为何更吃力

源码已确认：

- [ThinkingContent](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/ThinkingContent.tsx:182) 的展开体调用 MarkdownContent，传 streaming，不开启逐词动画。
- [StreamingMarkdownParser.parse](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/streamingMarkdown.ts:84) 对完整累计 AST 做 structuredClone，以防后续插件污染原始缓存。
- [MarkdownDocument](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/MarkdownContent.tsx:640) 仍将完整树交给 remark、rehype 和 ReactMarkdown；缓存解析不等于缓存后续变换及渲染。
- 折叠摘要另外按“最近完成段落的首行”推进；摘要按段跳动可以是现有策略，而非网络或动画丢帧。它与展开思考帧劣化必须分开。

根 Agent 的局部处理探针直接调用当前 parser 与已安装 ReactMarkdown，同样累计 80 次追加，以 600/20/20/600 的顺序测量。使用真实 Windows/code-file 插件、GFM、Math、Breaks、KaTeX；排除 delivered-file 上下文插件、自定义组件、技术证据分段、React reconciliation、DOM/CSS 和调度。

| 初始段落 | 每步实际解析字符数中位 | 原始语法解析中位 | 含完整树复制的 parser 边界中位 | 同步处理整体中位 |
| --- | ---: | ---: | ---: | ---: |
| 20，两次 | 186 | 0.16–0.24ms | 0.32–0.43ms | 0.74–0.92ms |
| 600，两次 | 186 | 0.24–0.29ms | 3.47–3.57ms | 12.00–13.19ms |

同大小的尾部语法解析已很小，整体处理仍随全文长度增加，说明继续只优化 parser 不足以解决这条路径。此表不是浏览器 CPU 占比，也不能从差值精确拆出每个插件。探针另有 incomingWords=true 的单变量对照，但那是完整树处理路径，不能把它的耗时当作实际分块正文的耗时。

### 正文的独立负担

[AnimatedMarkdown](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/MarkdownContent.tsx:715) 已有稳定块 memo，不是所有正文每次都从头生成 React 元素。[rehypeIncomingText](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/rehypeIncomingText.ts:24) 把文本按词拆为 span；600 段样本最终有 15131 个元素、14520 个 incoming-word 节点，思考样本只有 622 个元素且没有逐词节点。正文累计样式计算约 563ms，思考约 128ms。

这支持正文存在 DOM/样式负担，尚未通过同一真实分块路径仅切换动画的浏览器对照确定贡献比例。禁止用 animateIncoming=false 的整体路由切换，冒充“只关闭 CSS 动画”的单变量实验。

## 二、追尾持续落后：已在轻量布局中独立复现

[当前 ScrollArea](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/ui/scroll-area.tsx:126) 用自有 rAF 积分追尾：目标速度 `min(480, distance*8)`、加速度 1800 px/s²、单帧 dt 最大 32ms。正常动效模式下，即便主线程没有重活，持续内容增长超过速度上限也会越追越远。

独立探针只用真实 ScrollArea 与轻量几何增长，不运行 Markdown。两组均增长约 3.2 秒，保留同样采样方法。

| 实际高度增速 | 帧间隔 P95 | 活跃底距 P95 | 停流底距 | 停流后到 ≤2px |
| --- | ---: | ---: | ---: | ---: |
| 248.7 px/s | 17.0ms | 36px | 33px | 269.5ms |
| 895.4 px/s | 17.0ms | 1346px | 1418px | 3030.6ms |

高速组最大帧间隔约 20.1ms、无 longtask，且 following=true。因此“已经生成，但视野还在后面”不必以渲染线程卡住为前提。真实正文换行、工具卡、图片解码后的高度变化是否达到该 trace，需要整条产品链取证；不能把几何 trace 说成当次会话的实际吞吐。

探针随后真实 wheel 上滚约 320px，再增加 256px 内容：两组 scrollTop 都不变，following=false，未抢回读者位置。后续修复必须保留这点，还需覆盖选择文字、折叠锚点、键盘导航、恢复/切会话、减少动画、尺寸变化与图片迟到布局。

## 三、成熟实现的实际差别

| 机制 | 本机固定 DSH 0.2.1-alpha.2 | CBD 当前工作树 | 本机 WorkBuddy 5.9.2 |
| --- | --- | --- | --- |
| 流更新发布 | Conversation 的 assistant/live-chunk 显式选 animation-frame；最多一个待发布任务，经三层 rAF flush；控制事件可立即发布 | 实时 store 每次通知 hook，React 自身可能合并；历史 replay 已抑制中间显示，不能说完全没有优化 | 可读 bundle 的控制器包装订阅按单 rAF 合并，hidden 时切定时；实际 Provider 有接线 |
| 更新范围 | dirty key 对应节点 source 发布，memo seat + selector 订阅 | adapter 仅替换变更消息；WeakMap 复用不变消息副本，但仍发布 session snapshot | 有 ACP 累积器；完整业务投影与全部开关未追出 |
| Markdown | 冻结解析块与已完成 React 元素，尾块继续更新 | 思考仅增量解析；正文已有块 memo，但逐词 DOM 较大 | 已见 ReactMarkdown；不能宣称采用相同增量 AST |
| 跟随滚动 | 原生 scrollTo/scrollTop + 独立 follow 意图和读者手势 | 自有速度限制追尾 + 既有阅读/折叠锚点 | Virtuoso 与 useMessageScroll 实际接线；部分 grow-stick 开关的运行值未知 |

DSH 的基础 snapshot store 默认同步，只有显式 `flush:'raf'` 才帧合并；不能概括成“所有 DSH store 默认 rAF”。Conversation 的三层 rAF 也不是必须照抄的数值，存在显示延迟权衡。WorkBuddy 的 renderer 原始 TS、source map、库精确版本及完整运行开关未知；本轮只静态读取本机 ASAR 指定 JS，没有访问其聊天或配置。

官方 DSH [MarkdownText 固定源码](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-primitives/src/markdown/MarkdownText.tsx) 确有 frozenElements；[滚动固定源码](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-chat/src/client/chat/use-scroll-follow.ts) 确有原生跟随意图。npm 与该官方提交只确认版本匹配，没有声称逐字节相同，实际实现优先核对本机包。

其他成熟路径如 [Vercel Streamdown 发布记录](https://github.com/vercel/streamdown/releases) 也在处理块缓存、高亮增量与动画成本，可借鉴机制；本轮没有安装新 renderer。`useDeferredValue` 只改变调度优先级，连续更新可能重启后台渲染，不能用它掩盖追尾陈旧问题，参见 [React 官方说明](https://react.dev/reference/react/useDeferredValue)。

## 四、代码导航：审批与执行分别归因

### 默认审批的直接原因

[developmentTools](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/runtime/development-tools.mjs:30) 的固定工厂描述“Read-only”，却没有结构化 annotations。[driver](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/runtime/harness/driver.mjs:1531) 仅把可信宿主定义同时声明 readOnlyHint=true、destructiveHint=false 的工具登记为只读；不从名称或描述猜权限。这是合理边界，缺口在工厂。

真实 Harness 注册、permissionCall 和 Compat.toolPolicy 的受控探针结果：

| 输入 | 真实策略输出 | 两次调用询问数 |
| --- | --- | ---: |
| 当前工厂，未设置工具权限 | 非只读，沙箱外工具 ask | 2 |
| 仅在诊断内存补可信工厂既有只读标记 | readOnly=true，默认 allow | 0 |
| 标记 + 显式 ask_before | ask | 2 |
| 标记 + 显式 never_allow | deny | 0 |
| 标记 + 额外 safety 复审 | ask | 2 |

探针未写持久权限；allow 后主动阻断执行。真实 native 查询另有明确同意读取自己的夹具，并非绕过审批执行。补充输入后的额外复审也会把目前未标只读的导航再视为需审操作，这是重复询问的另一条已核实链路。

最小修复方向是补齐这份固定、已审查宿主定义的只读事实，复用原策略；不是给工具名写全局 allow，更不能信任任意远端 MCP 的 readOnlyHint 自动授权。显式 ask/deny、安全复审、scope 失效、工作区 realpath 边界和固定操作枚举继续保留。

只读查询也不等于授权隐式安装语言服务。当前 helper 已把 Python 服务指向自带 Pyright，避免默认 uvx 下载；但 [TypeScript 默认依赖提供器](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/runtime/assets/serena/solidlsp/language_servers/typescript_language_server.py:278) 在可执行文件不存在时会调用 deps.install，生成安装 typescript 与 typescript-language-server 的 npm 命令。这条条件安装路径已通过源码确认，不是本轮实际执行或新发现的用户失败回执；其他语言尚未穷尽。

当前 assertCodeNavigationRuntime 只检查 Python/Serena/Pyright，不能据它通过就认定所有语言已就绪。正式默认放行前，应确认目标语言只使用已有 payload，缺少时明确报“未准备”，不得因只读标记而静默下载/安装。就绪事实由实际语言服务配置/依赖提供器给出，不另造按文件后缀猜语言的表。本轮没有触发此类安装。

### 失败样本不能混算

只读审计当前隔离 preview 的两个相关会话，共 12 次导航调用：6 份 isError=false 回执；2 次用户拒绝；3 次目标/符号问题；1 次不透明错误，3ms 后记录同轮 user-aborted turn/end，不是已知的 Stop 命令发送时刻。6 份非错误回执不等于用户整体任务成功，原始异常未保留也不能断言是 LSP 崩溃。10 次调用的会话实际问 4 次，另一会话问 2 次；不是每次都问。

- package.json 不能作符号源码、目录代替文件：门面明确具体源码文件合同、检查 realpath 和常规文件；语言能否分析仍交给 Serena/LSP，不新增扩展名猜测表。dirty 已有常规文件 guard，不能归功于本轮。
- queued 有多个候选：保留候选和完整 name_path，用 overview 定位后查询，不擅自挑第一个。
- `[object Object]`：优先补保留原始 code/cause/stage 的诊断；未知取消不能改成成功或盲重试。具体异常丢失层仍未知。
- 默认询问和以上错误不以 MCP 连接复用为前提；应分开提交/验收，不为一个权限缺口强行合入整套 Job/连接生命周期改动。

当前 Python 隔离项目的真实 overview、definition、references 已核对符号与位置。一次性 helper overview 22.764s；复用路径 overview 7.319s、definition 98ms、references 2.111s；冷/热条件不同，不计算正式提速比例。native 三次仍询问三次，说明连接复用本身没补只读事实。此结果不代替 TypeScript 用户项目、多语言和干净安装的产品验收。

## 五、建议实施顺序与迁移边界（尚未实施）

| 顺序 | 方案 | 采用理由 | 必须守住的边界与验收 |
| --- | --- | --- | --- |
| 1 | 单独调整跟随控制，借鉴 DSH 原生 follow 意图；消除持续增长时的固定速度瓶颈 | 已有轻量独立复现，不必先动模型/传输/队列 | 同增长 trace 底距不持续积累；用户上滚/选择/折叠锚点不被抢回；流结束/迟到图片追尾可靠；不得靠减少输出解决 |
| 2 | 将展开思考的优化推进到已完成块的变换/渲染缓存；审查正文的逐词节点预算 | 局部处理测量显示尾部解析已小，继续只改 parser 收益有限 | 不在流中切换 renderer 类型导致 DOM 重挂载；保留选择/焦点、链接/交付文件、表格/数学/未闭合代码；引用和脚注保持当前全文语义；结束后与完整渲染一致 |
| 3 | 再测完整 ACP store/列表；仅有证据后缩小订阅或合并展示通知 | 当前最小夹具没测这些层，不能先动公共 store | 事件接纳/持久化/控制状态仍立即处理；仅展示可合并；Stop/审批/错误/末尾 flush 不漏；后台页 rAF 暂停、卸载/切会话无旧回调污染 |
| 并行独立切片 | 固定导航工厂的只读事实与输入/错误合同 | 已通过真实权限 counterfactual；范围小 | 默认无询问但显式 ask/deny/safety 不变；同名替换/失效定义不继承权限；先封住语言服务缺失时隐式安装，再做真实 TS 查询与默认权限产品验收 |

不建议现在整体换前端、复制 DSH 的整套业务状态、安装 Streamdown、固定 50ms throttle、强制 deferred 渲染或提高追尾速度常数。仅调快速度帽仍会留下上限与长帧欠补偿；直接换 DSH Markdown 又会改变当前链接、文件、引用、脚注与媒体语义。正式实施先固定上述行为矩阵，独立审查，再分切片验证。

## 实际命令、证据与未完成项

以下均在当前工作区使用已有工具和依赖。执行退出码与性能结论分开：

| 命令 | 实际结果 |
| --- | --- |
| `node .local/streaming-investigation-20261127/perf-agent/probe.mjs` | exit 0，六组遥测、输入完整和源码稳定；不是性能 PASS |
| `node .local/streaming-investigation-20261127/perf-agent/analyze.mjs` | exit 0，派生活跃窗口指标 |
| `node .local/streaming-investigation-20261127/perf-agent/probe.mjs --reverse-check` | exit 0，指定四组逆序复测，源码及输入检查通过 |
| `node .local/streaming-investigation-20261127/perf-agent/analyze.mjs --repeat` | exit 0，逆序数据派生；Profiler 字段按 render 阶段命名 |
| `node .local/streaming-investigation-20261127/perf-agent/growth-probe.mjs` | exit 0，两组轻量增长及真实 wheel 阅读保持检查 |
| `node .local/streaming-investigation-20261127/perf-agent/verify-symptom.mjs` | exit 1，预期 diagnostic red；不是工具崩溃。两次匹配运行的长文占 2–3 个刷新槽，高速组五个连续窗口底距递增；invalid=[] |
| `node .local/streaming-investigation-20261127/markdown-stage-probe.mjs` | exit 0，八组同步处理测量，源码 hash 不变；启动有 Node TS module-type 提示，未改 package.json |
| `node .local/streaming-investigation-20261127/navigation-agent/audit-preview.mjs` | exit 0，有限脱敏字段审计 |
| `node .local/streaming-investigation-20261127/navigation-agent/probe-approval.mjs` | exit 0，真实策略 counterfactual，无持久权限修改 |
| `node .local/streaming-investigation-20261127/navigation-agent/probe-execution.mjs` | exit 0，有界真实 Python 查询 |

原始数据位于 `.local/streaming-investigation-20261127/`：`perf-agent/baseline.json`、`analysis.json`、`baseline-reverse-check.json`、`analysis-repeat.json`、`growth-baseline.json`、`diagnostic-result.json`，根目录 `markdown-stage-results.json`，`navigation-agent/*-probe.json` 和 `comparison-agent/comparison.md`。这些是本机诊断夹具，不纳入产品提交。

诊断脚本使用实测约 16.7ms 的刷新槽对照短/长文，要求两种执行顺序均出现短文一槽、长文至少两槽；跟随信号要求初始 500ms 后五个连续窗口的高速底距均增加、低速底距不持续增加，且高速帧仍一槽、following=true。源码变化、缺数据和顺序不一致给 inconclusive，不能调阈值强行做红。该信号用于固定当前症状，尚不是经过批准的产品 SLO。高速组实际跟随斜率约 479.98px/s，与源码速度帽相符。

仍缺：真实 Electron 完整列表/store 的相同输入追踪、实际用户会话的字节到达节奏/布局高度 trace、真实前台 compositor/思考图标动画取证、不同 Markdown 结构的最小回归、真实 TypeScript 路径及干净安装验收。当前研究没有运行产品构建、CU 或新一轮模型 E2E；也没有把前批自动测试当本轮性能验收。

独立审查：渲染/成熟实现审查与导航/权限边界审查均未发现剩余 Required；已采纳 Profiler 命名、接收计数边界、逆序对照、隐式安装前置门槛及取消日志时间措辞的修正。这是对调查报告的审查，不是对尚未实施修复的产品验收。

## 2026-11-28 后续多轮方案调查

后续从真实 Provider→Context→memo 边界复现了更强的正文失效机制：AnswerFiles 在词汇相同却引用改变时可使完成块重渲染。同一路径正反序隔离测量中，fresh 数组的 render actualDuration P95 约 372ms，stable 数组约 17–20ms；最终源文本、渲染文字 hash 与 DOM 数量相同，不代表 DOM 身份/选择已验收。这是新增跨层证据，不抹去本报告原最小组件的限制；也不能将倍数作为发布版收益承诺。

已进一步比较公共接口、依赖与引用/焦点语义：DSH 不能在当前依赖状态直接公共接入，Streamdown 2.8.1 也需晚到引用与动态插件更新验证，现有分块不能无条件搬给思考。推荐先恢复现有缓存，再做保持单一 owner 的滚动窄试点；完整选择与退出条件见 [ADR-005（Proposed）](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/documentation/codebuddy/decisions/ADR-005-streaming-presentation-reuse.md)。本轮仍未落产品修复或推送。
