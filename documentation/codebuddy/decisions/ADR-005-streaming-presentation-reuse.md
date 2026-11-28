# ADR-005：优先恢复现有流式缓存，再替换跟随运动；分开评估渲染器迁移

状态：**2026-11-28 用户批准按方案开始实施**，要求新分支。实现位于 `codex/fix-streaming-navigation-20261128`，基于 `bcc6ab77731cc6f1c67985a83f71f1ecb0e41d15` 并保留原 dirty。A、B 原生跟随候选及 N 为本批范围；C 仍限独立试点评估，不代表批准引入新 renderer 或依赖。下文记录选型时的证据和边界，不可把原型数据视为本批产品验收；实际验证另记实施报告。

## 需求、约束与完成条件

后续授权（2026-11-28）：完成接收/日志/渲染分段测量后，用户进一步批准按DSH完成块缓存方向实施C，评估WBD合帧，独立审查并真实窗口复测，先不推送。继续复用现有ReactMarkdown/插件/frontier，不安装新依赖、不改变执行和持久化所有权。上文C保留状态按此前阶段理解，当前进展见[完成块实施记录](../reports/2026-11-28/completed-markdown-blocks.zh-CN.md)。

用户希望改善“正文起初流畅、越往后越卡”“展开思考顿挫”和“已生成内容却追不上视野”，要求多轮研究、优先复用成熟实现与现有机制。另有代码导航默认不应反复审批、执行常失败的问题。

不能以减少模型输出、主动延迟接纳消息、破坏原始历史或静默丢弃更新换取流畅。保持 Harness/Compat 的执行、权限、消息消费与持久化所有权；前端只处理展示。文字选择、焦点、文件回执撤销、链接与媒体、脚注/引用、折叠锚点、用户主动上滚都必须继续正确。不得安装依赖、重整 node_modules、改用户权限或生产 profile 来完成本次研究。

实施阶段授权补充：用户于 2026-11-28 明确允许固定 `typescript@5.9.3` 与 `typescript-language-server@5.1.3` 两个官方归档的下载、SHA-512 校验与仓库本地解包；不运行 npm install、安装脚本，不修改 PATH 或全局环境。此授权不扩大为安装其他依赖或更换前端 renderer。

首批改善的完成条件：

1. 同一正文追加、文件词汇不变时，已有完成块不会因等价 Context 新引用失效；真实文件新增/撤销仍立即更新。
2. 自动跟随的高速布局增长不再持续积累底距；用户上滚、选择或折叠阅读时不抢回底部。
3. 使用同输入、同源码和同消费路径复测；性能数据、自动回归和 Electron 实际验收分别报告。
4. 尚未解决的长尾 Markdown、单条巨大消息及完整列表/store 成本明确保留，不宣称已根治。

前一轮症状与测量见 [调查报告](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/documentation/codebuddy/research/2026-11-27-streaming-and-navigation-investigation.zh-CN.md)。

## 四轮研究如何改变选择

| 轮次 | 做了什么 | 得到的约束或决策 |
| --- | --- | --- |
| 1：固定症状 | 真实 Markdown/Thinking/ScrollArea 长度对照及逆序；轻量内容增长探针 | 长文帧劣化与滚动速度瓶颈是独立机制，不能只调动画或怪模型 |
| 2：核实可复用接口 | 固定 DSH 包/API、Streamdown 固定正式版、use-stick-to-bottom 官方实现与版本、WorkBuddy 已安装 bundle 对照 | “存在源码”不等于“可直接公共导入”；直接换库仍有依赖、语义与 DOM 身份成本 |
| 3：反证现有缓存 | 从真实 Provider→Context→memo 调用链构造单变量夹具，正序/逆序比较同一真实正文组件 | 有一处现成块缓存被上层等价新数组绕过，应先恢复它，而不是先加另一套 renderer |
| 4：独立对抗审查 | 分别检查候选的运行证据、引用/焦点失效、滚动控制权、隐式安装及生命周期 | 以审查后的切片与退出条件实施，不把库的宣传或单次跑分当兼容性证明 |

## 新增运行证据：现有正文缓存为何可能失效

[ProgressiveMessageList](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/ProgressiveMessageList.tsx:2114) 为 AnswerFiles.Provider 传入 `conversationChanges.find(...)?.files ?? []`。无文件时 fallback 每次是新数组；有文件时 [collectConversationChanges](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/codepro/conversationChanges.ts:162) 也会创建新文件数组。

[StreamingBlock](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/MarkdownContent.tsx:681) 虽然 memo，却直接订阅 AnswerFiles。React 按 Object.is 比较 Context value，Context 更新可绕过 memo；这是 [React 官方语义](https://react.dev/reference/react/useContext#caveats)，不是 React 缓存随机失效。

隔离夹具调用**当前真实正文路径** `MarkdownContent animateIncoming streaming`，600 个中文初始段落、80 个请求 32ms 的 Worker delta，Provider 唯一变量为共享空数组或每次 App render 新建空数组。两路最终均为 23832 个源字符、15131 个 DOM 元素、14520 个逐词 span；正文 text SHA256 一致，8 个产品文件 hash 跨运行一致。

元素数量与 innerText hash 相同不证明 Node 身份、焦点或 Selection 保持；这些不是本夹具已通过的项目。

| 顺序 | Provider | 活跃帧间隔 P95 | React render actualDuration P95 | ≥50ms longtask |
| --- | --- | ---: | ---: | ---: |
| 正序先测 | stable | 50.0ms | 20.2ms | 1 个，239ms |
| 正序后测 | fresh | 516.6ms | 372.6ms | 8 个，累计 2937ms |
| 反序先测 | fresh | 516.6ms | 371.6ms | 8 个，累计 2951ms |
| 反序后测 | stable | 33.5ms | 17.4ms | 0 |

首组 stable 的离群任务完整保留，没有删除数据。反序 fresh 实际 Worker 发送间隔 P95 约 35.3ms，主线程接收延迟 P95 却约 456.5ms；stable 分别约 43.7ms、32.0ms。更严重的停顿不能用 fresh 的输入源更抖动解释。

这是两种顺序、开发版 Profiler、headless Edge 的有界机制验证，不是随机化统计、生产收益承诺或完整 ProgressiveMessageList E2E。未测非空回执、真正撤销和完整工具行；这些是修复时必须补的合同验收。稳定 Context 后仍有 33–50ms 帧间隔，不能声称消除了所有卡顿。此前不包 Provider 的基线不能覆盖这条真实调用边界。

## 拟议决定 A：先让已有缓存真正生效

**首选现有 ReactMarkdown、插件、StreamingBlock 与文件回执投影，不引入新 renderer 或全局缓存。**

1. 文件回执 owner 仍是现有真实工具回执与 collectConversationChanges；不扫描模型自然语言补证明。
2. 为 AnswerFiles 稳定其消费者实际读取的词汇快照。现有 [remarkDeliveredFileLinks](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/ui/desktop/src/components/remarkDeliveredFileLinks.ts:8) 读取 key/path；相同会话、轮次及相同词汇保持引用稳定，不因无关文本 delta 重建消费者的值。
3. 保留顺序、重复与歧义语义；不能仅比较数组长度，不能只修空数组 fallback，不能把非空文件列表永久冻结。新增、撤销、路径/key 变化、历史替换和切会话必须失效。
4. 不给整个 Provider/children 做“相同文件就不更新”的比较器，否则会拦住正文 delta。稳定的是 Context value，正文仍正常推进。

这遵循 React 的已有 Context/memo 规则，也与 DSH 的稳定快照和完成块缓存方向一致。代价是维护一处局部展示投影/失效规则；它不成为第二份文件事实或持久化账本。

## 拟议决定 B：保留滚动 owner，比较原生跟随与成熟 hook

### 候选比较

| 候选 | 可复用内容 | 代价/限制 | 本次选择 |
| --- | --- | --- | --- |
| DSH ScrollFollow | 原生 scrollTo/scrollTop、follow 意图与手势/尺寸变化的职责划分 | 本机固定包未公开导出该控制器，不能从公共入口直接拿 hook；不应拆私有 bundle 或复制整个聊天状态 | 采用职责与浏览器原语，不能声称直接复用了公共组件 |
| 当前 ScrollArea + 浏览器原生定位 | 现有 follow/read、programmatic、阅读/折叠锚点、ResizeObserver、ref API | 常规增长直接定位能避免速度帽积压，但逐行定位可能视觉台阶；尚无候选原型/Electron 验证 | 作为零新依赖的第一试点；只替换运动部分，不宣布已选定最终视觉效果 |
| use-stick-to-bottom | 公开 hook 与 refs、ResizeObserver、取消与速度弹簧；AI Elements 已有消费路径 | 当前未安装；需要验证 public API 能成为唯一运动 owner，并兼容现有折叠/阅读锚点、选择与尺寸收缩 | 作为独立候选保留；不因“多一个依赖”否定它，也不在研究中自行安装 |
| React Virtuoso | 历史消息虚拟化、列表滚动工具；WorkBuddy 的 bundle 有实际接线 | 会改变窗口化、搜索、折叠、动态高度和锚点；单条巨大 Markdown 内部仍可能有大量 DOM | 不作为首批修复；先测清历史列表是不是主要成本 |

第一试点只在 `.local` 中复用现有 ScrollArea 入口验证“布局读取/写入每帧合并、跟随意图与运动分开”，不复制 DSH 的整个私有控制器。常规增长与显式跳底分开处理，先保留显式跳底当前 instant 行为，不顺手改 smooth。减少动画遵守系统偏好。

若原生试点虽消除积压却仍显著台阶，则不把它合入产品并自称丝滑，应在明确批准新增依赖后，对 use-stick-to-bottom 做相同 trace 的替换试点。外部 hook 若接管运动，必须移除旧积分器，由现有 ScrollArea 统一适配其取消/跟随信号；禁止两个控制器同时写 scrollTop。折叠/阅读锚点优先时停止跟随运动，解除后也不能擅自夺回读者位置。

## 拟议决定 C：展开思考分阶段评估，不强行整库替换

| 路径 | 优点 | 已核实的不兼容或待验边界 | 决定 |
| --- | --- | --- | --- |
| 直接 DSH MarkdownText 0.2.1-alpha.2 | 完成块解析与 React 元素冻结；现成成熟实现 | 公共 props 无 remark/rehype/components；流中跨冻结边界引用/脚注可暂作字面量，文件/本地图片能力在 settled 才启用；本机缺 Shiki/simple-icons/anser 等外部依赖 | 当前不能直接接入；不是永久拒绝 DSH，也不先改包/补一堆依赖 |
| 复用当前 AnimatedMarkdown 给思考关闭逐词动画 | 复用现成块与现有插件，范围表面较小 | 当前 blocks() 在引用出现后回退为一个全文块，可能卸载后段旧块；先前焦点回归不能重来 | 不能直接当安全补丁；必须先在 `.local` 验证引用/脚注/焦点/选择 |
| Streamdown 2.8.1，固定 commit `9e8fb5118adb3f009243babff5c6ec6d8e7083d9` | 支持熟悉的 components 与 remark/rehype，提供块 memo、未闭合 Markdown 和高亮路径 | 新依赖与 CSS；outer memo 对动态插件选项需专项检查；late reference/footnote 回退全文可改变块拓扑；不得流结束切 static 后声称 DOM 必然不重挂载 | 作为之后可申请的有限替换试点，不能称现成无损 drop-in |
| 保持思考当前完整文档渲染，先修上下游 | 保留当前引用与焦点语义；不重建 renderer | 单条很长思考的整树处理成本仍在 | 首批的明确保留项；不能把上下游改善写成思考渲染已根治 |

不新写一套 Markdown 解析器、语言识别器、引用依赖图、打字机或“流式缓存管理器”。也不把思考临时改纯文本、结束时再重排 Markdown 当作无行为变化的性能修复。

## 事件发布与列表：先测再动

目前 adapter 对未变化消息已有结构共享，session snapshot 会同步发布；列表也已有窗口化和渐进加载。没有证据支持删掉这些机制重新用全套状态框架。

若首批修复后仍有跨层高频开销，再在真实 store→列表链分别测历史条数、活跃正文长度和工具数。DSH 的三层 rAF 与 WorkBuddy 的单 rAF 提供比较思路，不能直接照抄常数。展示通知可合并，真实事件、ACK、权限、Stop、错误、队列消费和持久化不能延迟或合并丢失；最后一个 delta、后台页面、卸载与切会话须有明确结算。

`useSyncExternalStore`/selector 是订阅合同，不是性能开关：快照本身也必须稳定，见 [React 官方说明](https://react.dev/reference/react/useSyncExternalStore)。不为采用新 hook 而先改公共状态所有权。

## 代码导航作为独立修复切片

不把连接复用与默认审批强绑在一批。先使用 Serena 的现有语言选择与配置/依赖提供器边界，确认**所有拟启动语言服务**均有宿主控制、已存在的载荷；缺少则明确“未准备”，不静默 npm/uvx 安装。不是仅检查本次文件或只准备 Python：当前 Serena 初始化可并行启动项目语言列表。

官方已有 ls_path/ls_base_cmd/ls_args 可以绕过相应 provider 的 managed 安装，不需要自造语言后缀映射或另一套 LSP 管理器，见 [固定版本配置文档](https://github.com/oraios/serena/blob/74c38a65f03fc0764d7ee4b3016ef6a07572ed64/docs/02-usage/050_configuration.md#customizing-the-language-server-launch-command)。但项目受信配置可以覆盖全局，trust 还涉及 activation_command，因此不能只写全局命令便宣称无隐式安装；应核实合并后的有效配置与真正启动边界，宿主控制执行命令。可比较在专用隔离配置中保持项目不受信、采用宿主命令的最小路径，不修改用户生产 trust；若必须保留项目 trust，则同样在有效启动边界约束命令。新模板 trust 默认空列表与旧配置兼容默认不同，不猜当前用户已信任哪些项目。

在上述前置门槛满足后，再仅给固定、可信宿主工厂补齐既有只读 annotations，让现有 driver/Compat 决策默认放行。显式 ask/deny/safety、定义身份与 scope 失效、工作区 realpath 边界继续优先。任意远端 MCP 的同名或只读声明不能自动获权。

此部分没有改变既有权限设置，尚未批准任何依赖下载；完整导航实现应单独审查、提交和验收。

## 最小实施与验收顺序

| 切片 | 先做的验证 | 合入条件 | 回退/停止条件 |
| --- | --- | --- | --- |
| A：文件展示 Context 稳定 | 固定文本追加、空/非空等价回执、真实新增/撤销、两同 basename、session/turn 切换、重复/回放；比较完成块执行与渲染成本 | 内容/链接正确，真正回执变化仍生效；无关已存在节点保持身份，activeElement 与 Selection 端点不变；现有 Markdown 合同回归与 Electron 验收 | 任一回执撤销仍残留链接、焦点/选择变化、正文被挡住则停止交付，不通过忽略更新救跑分 |
| B：追尾运动试点 | 同 250/900px/s trace、一次性高度跃迁、正文→工具→图片、主动上滚/键盘/选择/折叠、减少动画、切会话/后台恢复 | 底距不持续积累、读者不被抢回，CU/用户确认视觉；旧积分器不与候选双写 | 原生定位有明显台阶则保留为未通过，转成熟 hook 试点；不反复加速度特例 |
| C：思考 renderer 试点 | 多段/巨段、未闭合代码/数学、引用定义迟到/脚注、Windows 路径、文件/媒体、receipt 变化、streaming→settled 的 DOM/焦点/选择 | 同义渲染、无不必要卸载和权限/安全变化，性能确有收益；不加永久双 renderer 猜测路由 | 兼容成本变成维护第二套 Markdown 则不采用；不降低现有语义来宣称完成 |
| N：导航 | 真实 TS/Python、缺载荷时不调用安装器、项目 override、默认/显式 ask/deny/safety、定义替换、取消与无重复执行 | 默认只读请求不再重复问，执行载荷与结果核实；缺服务明确失败 | 未知有效启动命令、隐式安装仍可触达或取消未知，则不默认放行 |

先 A，再 B 的有界试点；C 独立比较，不阻塞已确认的 A/B 改善，也不把 C 的已知成本隐瞒。N 独立于前端。每个实际实现切片完成后独立子 Agent 对抗审查，再在包含该改动的当前 worktree 验证，不用其他版本证明。

## 参考来源、诊断产物与本轮操作

- [React Context](https://react.dev/reference/react/useContext#caveats)、[React memo](https://react.dev/reference/react/memo#updating-a-memoized-component-using-a-context)：缓存与 Context 的正式合同。
- [DSH 固定 MarkdownText](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-primitives/src/markdown/MarkdownText.tsx)、[DSH 固定滚动源码](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-chat/src/client/chat/use-scroll-follow.ts)：源码参考，不替代本机 npm 导出/API 核对。
- [Streamdown 固定 commit](https://github.com/vercel/streamdown/blob/9e8fb5118adb3f009243babff5c6ec6d8e7083d9/packages/streamdown/index.tsx)：不是沿用旧版 2.7.0；outer comparator 与流式/静态分支均已读。
- [use-stick-to-bottom 对应 1.1.6 的固定源码](https://github.com/stackblitz-labs/use-stick-to-bottom/blob/8d6a19a0ca6ab632830588073e6a29312a06a088/src/useStickToBottom.ts)、[AI Elements 固定消费源码](https://github.com/vercel/ai-elements/blob/ca8be600bfd01b3131f9bf6134b51602a71f4374/packages/elements/src/conversation.tsx)：官方 npm 当前版本与该 Git package.json 均为 1.1.6，但未找到同名 Git tag，也未证明 npm tarball 字节相同；没有安装运行该 hook。
- [Serena 固定依赖提供器](https://github.com/oraios/serena/blob/74c38a65f03fc0764d7ee4b3016ef6a07572ed64/src/solidlsp/dependency_provider.py)：相应命令覆盖在 managed 安装之前处理，不是所有语言都有同一覆盖合同。
- WorkBuddy 5.9.2 沿用前轮指定 bundle 的只读结果；没有新启动、读取聊天或声称掌握私有原始源码。

本轮诊断夹具在 `.local/streaming-options-20261128/`，不提交：prototype 下 `availability.mjs`（直接 DSH 依赖检查）、`context-probe.mjs`（正序/`--reverse`，均 exit 0）、`context-results.json`、`results-reverse.json`。缺 DSH 外部依赖后停止直接组件实验，没有拆 bundle、改 Vite 产品配置或安装依赖。两个 Context 顺序均使用实际当前组件及已有依赖。

选型阶段只增加/更新方案文档与隔离夹具，没有产品构建、CU、真实模型或产品验收。随后用户批准进入本文件顶部所列修复分支；实际改动、分批验证及剩余限制见 [实施记录](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/documentation/codebuddy/reports/2026-11-28/streaming-navigation-fix.zh-CN.md)。选型原型不能被下游当作修复后的产品验收。

独立审查：Markdown/兼容性、滚动/导航边界、性能原始数据三个方向均未发现剩余 Required；已采纳固定来源与节点身份验收的澄清。此结论仅评价 Proposed 方案，不是候选代码或产品验收通过。
