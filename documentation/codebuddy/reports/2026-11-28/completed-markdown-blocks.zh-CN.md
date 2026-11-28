# 完成块缓存：实现与验收

2026-11-28。用户批准按DSH完成块缓存改善流式展示，评估WBD合帧是否必要；要求独立子Agent审查、真实窗口复测，先不推送。

目录 `C:/Users/admin/Documents/ChatGPT/codebuddy-v1`，分支 `codex/fix-streaming-navigation-20261128`，HEAD `bcc6ab77731cc6f1c67985a83f71f1ecb0e41d15` 加既有dirty。保留已有导航、插话、滚动、DOCX/tab改动；未切分支或复制worktree。每次性能采样另核源码SHA，HEAD不足以表示dirty身份。

## 机制与边界

[前置调查](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/.local/thinking-segments-20261128/调查报告.md)区分了接收空窗、宿主日志反压和前端长度相关成本。本轮只改变展示重复工作；Harness/Compat仍负责执行、权限、队列、原始历史与持久化，UI store仍即时接收原始文本。不加入等速打字缓冲或修改日志确认顺序。

复用已有 `StreamingMarkdownParser/Blocks` 的稳定前缀与两块活动尾部、现有ReactMarkdown和插件。新增局部 `MarkdownBlocks.tsx`：普通流式路径只对变化块执行原插件；完整引用/脚注由ReactMarkdown全文转换一次，再以source-offset投影到同一块owner，每块只克隆自己的HAST后交回原URL/raw安全边界。KaTeX转换前保留源owner，转换后剥去临时包装，不进入DOM。

思考、正文、settled不换顶层owner；思考仍无逐词动画，本轮最终版本取消聊天正文的逐词opacity淡入，直接显示收到的增量。正文真实streaming状态与代码高亮Context仍独立保留，通用MarkdownContent的动画API和显式reveal路径保留。静态历史直接一次完整编译。文件回执、locale、components和URL策略的真实变化正常失效，不把revision作为列表key强制重挂载。

完成块缓存保存的是实际ReactElement，不只使用memo包装组件。缓存以本组件React state管理：旧Map只读，新Map仅保留当前keys；source、fullDocument模式和renderer配置发生变化才条件式更新，下一次render收敛。桥接仅传单个不透明JSX节点，避免开发版props诊断逐项枚举整篇block数组。已有增量缓存的文档结束时仍检查最新source；不需要全局引用时保留完成块。AnswerFiles的Context消费者留在块内，真实回执变化仍能唤醒已缓存元素。

未直接导入DSH公共MarkdownText：它与现有自定义组件/插件有API及依赖差异，跨冻结边界引用和流中文件词汇也有语义差异。采用其完成块策略，不降级CBD既有即时引用和回执语义，也不实现第二套解析器或脚注编号。

来源：[固定DSH MarkdownText](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-primitives/src/markdown/MarkdownText.tsx)、[ReactMarkdown10.1.0插件与架构](https://raw.githubusercontent.com/remarkjs/react-markdown/10.1.0/readme.md)、[unified parser](https://github.com/unifiedjs/unified#processorparser)、[React memo/Context](https://react.dev/reference/react/memo#updating-a-memoized-component-using-a-context)。实际React19.2.4、ReactMarkdown10.1.0、unified11.0.5；无新依赖。

## 已执行回归与审查

新增 `MarkdownContent.streaming.test.tsx`。改前4个核心用例exit1，抓到思考完成前缀重复变换4次、正文晚引用后第二块焦点丢失；改后均通过。补测双公式/晚引用/settled/重写、全局脚注编号/backref、回执新增→basename歧义→撤销，并复用既有HTML/URL、媒体、路径、未闭合语法与reveal回归。

在 `ui/desktop` 使用此前已明确允许的现有依赖直接入口，无安装/重整：

```powershell
node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/MarkdownContent.streaming.test.tsx src/components/MarkdownContent.test.tsx src/components/streamingMarkdown.test.ts src/components/AnswerFilesProvider.test.tsx src/components/ProgressiveMessageList.process.test.tsx
node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/GooseMessage.stream.test.tsx src/components/GooseMessage.test.ts src/components/GooseMessage.handoff.test.tsx
node ../node_modules/typescript/bin/tsc --noEmit
```

第一批139项/5文件exit0；Goose批69项/3文件exit0，共208项/8文件。最后仅收紧空文档断言，再运行MarkdownContent.streaming的11项，exit0。最终类型检查exit0；git diff --check exit0。只格式化新增两个TSX文件，未全库format或跑Rust。

核心回归包括：完成前缀不再重复转换；晚到全局引用后的第二块焦点/Selection；双KaTeX owner、脚注编号/backref；回执新增→歧义→撤销；Strict模式A→B→A回退、重写/空文本、最后一包新定义；session处理器替换；正文流中零逐词span及settled保持段落；代码从流中plain切换settled高亮。Strict回退不等于真正并发Suspense中断测试，任意Range在所有Markdown重排中的保持也未作为已证明结果。当前聊天正文已经没有逐词span；仍保留的generic animateIncoming API与聊天正文须分别理解。

独立审查抓到KaTeX丢position造成key冲突的新P2，已以源owner保留和双公式回归关闭；采样器漏pin新核心也已关闭。最终静态复审无剩余Required，不等同产品E2E。

中间失败：receipt夹具最初用了CommonMark无效的空格URL，已改合法angle destination；TS发现Doctype不能为Element子节点，按原JSX忽略Doctype语义收窄；原AnswerFiles回归抓到普通空树桥接仍执行整篇VFile插件，本轮直接去掉无效执行，未降低旧断言。

## 性能对照

数据在 `.local/thinking-segments-20261128/candidate-acceptance/`。A仅在隔离Vite接缝替换两份已核旧Markdown模块，B是真实当前源码；其余store/Goose/Scroll/Provider/样式与596条/7998ms输入同源。A是明确反事实，不是旧产物验收。新核心纳入B实际加载和前后SHA门禁。

第一矩阵exit1：思考A/B完成，render P95约42.6→21.2ms，frame P95约33.5→33.3ms；正文B触发20秒有界超时且1秒partial读取未返回，正文A尚未执行。整轮不能判通过，也不能先将正文超时归为新回归。已保留失败和两个思考raw，停止重试；后续先补此前未运行的正文A反事实。

补齐此前未运行的正文A后，`body-reference-only-results.json` exit0：同产品/fixture/trace身份、同20秒期限，596输入与终态完整，最终layout约在producerStart+8211.7ms，render P95约30.2ms。这使“候选B未结算而A正常结算”成为有对照的回归证据；B没有返回部分记录，仍不能断言具体卡在流式还是finalize。已停止交付，先对B做一次有界CPU诊断，不直接堆合帧或扩大预算。

随后的同字节CPU诊断约10秒内返回，未复现20秒失败。原始profile有一项-22µs间隔，严格加权门禁exit1；保留原值，只分析未加权样本数，不截零或谎称捕获hang。因此第一次失败只能称一次有界失败，不能提升为稳定阻塞根因。采样仍看到JSX构造/开发/观测开销，终态约107ms；思考候选第一版终态单次156ms，对照56ms，说明收尾尚需改进。

第二版真正缓存ReactElement：不可变Map由React本组件state管理，输入/配置/mode guard更新后收敛；旧Map只读，新Map仅当前keys。依据[React允许本组件条件式render更新](https://react.dev/reference/react/useState#storing-information-from-previous-renders)，避免另加render期可变ref Map。桥接只携带一个不透明ReactElement，不再让组件props差异记录逐项枚举raw block数组。已增量的文档结束时仍检查最新source，无全局引用则继续复用块。新增Strict回退、最终包新定义、空/替换、session handler与settled前缀回归，110项相关测试/tsc/diffcheck均exit0。Strict回退不等价真实并发中断测试。

第二版完整矩阵 `matrix-v2-results.json` exit0；33个源码/trace无漂移，四组输入/发布/终态/实际DOM hash及加载见证全通过。思考A→B render P95 27.5→6.0ms，frame17.0→16.9ms，最终单次47.6→2.6ms；正文A→B render17.3→12.0ms，frame均33.5ms。但正文final单次B153.1ms/A40.8ms，terminal→layout210.9/86.1ms，是仍需解决的收尾风险，不能称全阶段无回归。

第二版regular样本publication未呈现年龄P95：思考B0ms，正文B3ms；无持续订阅积压证据，不机械增加WBD合帧。随后复用现有无逐词动画路径，取消聊天正文逐词淡入，保留真实streaming和generic动画API。A补原GooseMessage为第三份已核参考，保证仍代表旧词动画；该可见差异与缓存收益分别说明，不能宣称初始DOM/词节点数同样。

### 最终版本：匹配对照与原始突发输入

完整分析：[V3_REPORT.md](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/.local/thinking-segments-20261128/candidate-acceptance/V3_REPORT.md)。固定596条delta、7998ms、600段历史前缀，最终27978个UTF16单位；35项源码/输入身份前后无漂移。四组regular匹配对照、两组original候选均exit0，输入/发布/终态/实际DOM文本hash及源码加载见证通过。所有headless、Worker及临时Vite进程随后关闭，再开始真实窗口复测。

| 本轮匹配条件 | 思考A→B | 正文A→B |
| --- | ---: | ---: |
| render actualDuration P95 | 40.0→9.3ms | 25.3→6.5ms |
| 独立Worker发送→主线程收到P95 | 37.3→14.7ms | 43.7→3.1ms |
| rAF timeline间隔P95 | 41.7→14.2ms | 48.9→7.4ms |
| 最后一次render，n=1 | 68.1→2.7ms | 47.2→2.1ms |
| terminal→layout，n=1 | 71.9→4.6ms | 106.6→4.2ms |

正文是缓存与取消逐词淡入的联合收益，不能全部归因于缓存。正文初始词span为A13800/B0，元素数A14405/B605，是明确的显示实现变化；最终均640个元素、零词span，A/B实际文本相同。render P95下降不代表总工作同比下降；正文active render累计仅2771.1→2660.4ms，同时观测到更多更新。

本轮rAF基准中位约7ms，与前轮不同；只比较本轮匹配样本，不宣称固定60Hz、跨轮刷新率提升或屏幕paintFPS。render不等于commit/layout，rAF也不等于paint。final均单次，不能写成稳定分位或已根除早期未知超时。

保留原始gap/burst的两组候选：思考/正文render P95为10.2/7.8ms；已发布未提交最老等待P95均0，max1.1/5.7ms；已发送未提交最老等待max22.2/14.8ms。存在短暂突发，但本trace未见持续展示积压。因此本轮**不加WBD式合帧、不加人为等速播放缓冲**。原始节奏组没有匹配A，不由它计算因果收益，也不外推到无限吞吐和任意历史长度。

独立子Agent最终重算regular/original的源码身份、596次输入/发布、动画差异、终态、实际DOM hash和等待前沿；与记录一致，无新增Required。性能测量是headless真实组件链，不覆盖完整消息列表、宿主日志同步或真实屏幕绘制。

## 真实窗口与交付

实际使用Computer Use操作源码Electron窗口，1280×720；使用已有预览入口启动的隔离QA profile `.local/steering-desktop-20261127`，前端127.0.0.1:5173、兼容服务127.0.0.1:58240。前端Ctrl+R刷新后核验4个Vite sourcemap包含当前源码，运行前后4个文件SHA与最终v3相同。没有使用安装版、其他checkout或旧产物证明本次改动，也没有重建后端或并行跑基准争抢CPU。

同一聊天“乱序机器人创作科幻短篇”，session `43f338e5-06d3-4914-ab9c-c46b9ce59830`，GLM5.3真实模型。前3轮使用极致思考，后7轮通过真实UI改低档以覆盖更多轮次；不是同档位的速度对照，不拿总耗时比较前端收益。第3轮UI显示自动恢复一次输出长度受限，最终仍为正常完成。

| 轮次 | 请求/实际输出形态 | 持久化正文/思考UTF16单位 | Harness turn耗时 |
| --- | --- | ---: | ---: |
| 1 | 三千字短篇请求 | 1909 /7645 | 28.4s |
| 2 | 八千字十章扩写请求 | 7066 /26546 | 76.7s |
| 3 | 时间线检查与结局请求，含一次输出长度恢复 | 3147 /53413 | 314.5s |
| 4 | 番外段落 | 886 /373 | 17.3s |
| 5 | 人物/时间线表格、分组列表 | 2426 /144 | 14.2s |
| 6 | Python代码与输出示例 | 3027 /169 | 24.9s |
| 7 | TypeScript代码及比较表格 | 3682 /85 | 10.7s |
| 8 | 20条列表 | 1844 /68 | 15.0s |
| 9 | 番外扩写长正文 | 1976 /115 | 19.6s |
| 10 | 标题、人物表格与编号注释 | 1482 /145 | 12.7s |

长度为原始持久化UTF16单位，不代表请求字数全部满足；耗时包含模型、传输与执行，不是render耗时。累计生成正文27445、思考88703个UTF16单位。第10轮模型给的是Unicode编号注释，不把该轮当成CommonMark脚注链接/backref的真实窗口验收；后者由上述自动回归覆盖。

已实际观察与操作：

- 前两轮完整显示并恢复输入；长思考展开、滚动阅读和标题遮挡可操作。
- 第3轮展开实时思考并回到末尾；手动上翻后，约70→99秒的状态变化期间阅读位置未被新内容抢走；再点回底可回到继续增长的思考末尾。最终可见“全文完”、输入麦克风恢复、停止与回到最新按钮均消失。
- 第5轮上翻能看到正常表格；第6轮结束后上翻可见Python语法高亮，流中观察为plain代码；第7轮代码/表格结束后可定位末尾。
- 第7轮生成中用坐标点击动态位置的回底按钮，是否真正触发无法确认，因此不把该次当作持续跟随通过或产品缺陷证据。随后用AX语义按钮可正常到末尾。第8、9轮则从已确认底部发送，无中途输入，结束时自然位于最后一条列表/正文，回到底部按钮不存在，是独立的自然跟随证据。
- 第10轮后再次Ctrl+R重载；同一聊天恢复、AX十轮导航齐全、最后一轮表格/编号注释可见，输入空闲，无多余停止/回到底部按钮。

持久化与日志核对：10个Harness turn/end均为completed，每轮一个唯一assistant message ID；前端有10次prompt_submitted、10次user_message_accepted、10次prompt_finished，finished均accepted/first_output_received为真。本次没有观察到空白块、重复显示、崩溃或无法继续发送。原生窗口没有逐字符hash比较或屏幕paint/FPS采样，不能把这些观察写成所有字符和每一帧均已证明正确。

本地证据（不提交）：[源码见证](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/.local/completed-blocks-window-20261128/served-sources.json)、[十轮审计](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/.local/completed-blocks-window-20261128/audit.json)、[native观察记录](C:/Users/admin/Documents/ChatGPT/codebuddy-v1/.local/completed-blocks-window-20261128/observations.md)。审计命令 `node .local/completed-blocks-window-20261128/audit.mjs` exit0；sourceIdentityUnchanged与uniqueAssistantMessageIds均true。源码窗口保持打开，QA聊天当前GLM5.3低档，供用户另行视觉验收。

十轮后再次独立只读审查：无新增Required。新cache限定组件state/ref，没有新增全局cache、逐轮订阅或计时器；新Map只保留当前文档keys。ResizeObserver观察实际DOM尺寸，与完成ReactElement对象是否复用无关。挂载的长历史正常保留source/AST/JSX；本次不是retained heap或长时浸泡测试，不能据此排除泄漏。用户主观“是否够丝滑”的验收仍留给用户；受控数据、窗口行为和产品视觉接受分开报告。

本轮实际产品文件：`MarkdownBlocks.tsx`（新）、`MarkdownContent.tsx`（统一块owner）、`streamingMarkdown.ts`（暴露既有parser模式/初始化事实）、`GooseMessage.tsx`（取消聊天正文逐词淡入）。新增/扩充`MarkdownContent.streaming.test.tsx`和`GooseMessage.stream.test.tsx`；ADR-005补后续授权，本报告记录实施与验证。其他dirty属于前批，未清理或吸收入本轮提交。

本轮未commit/push；夹具、profile、参考源码和缓存不提交。单个巨大未闭合块及全局引用仍可能昂贵；任意Range、真实并发Suspense中断、后台恢复和更大吞吐未专项穷举。接收空窗不能由缓存生成未知文字，真实模型输出节奏仍会反映到屏幕上。未改Harness执行、日志同步或插话后端；WBD合帧留作有新积压证据时的独立评估。

## 追加：最终审查与本地提交

上文“未commit”是该阶段快照。2026-11-28用户授权审查全部剩余前端/导航、测试通过后本地提交，仍不推送。完成块与稳定文件Context已提交`f4a4f1b9`；滚动owner切片`829247c4`，可见耗时更新及已接受用时文案断言`15fd99c3`，标签CSS`ace75ebb`。

最终17目标Vitest一次384/384通过、TypeScript noEmit exit0；日志在`.local/final-review-20261128/frontend.log`、`tsc.log`。独立只读审查重新核对19个前端文件、v3的35项source identity及十轮native journal/React日志；4核心hash未变，因此前述受控测量/十轮窗口证据可按其原范围复用。没有重新声称paint、heap、完整用户视觉验收或根除所有停顿。合并注意及完整本地提交状态见[追加交接](../2026-11-27/follow-up-steering-handoff.zh-CN.md)。
