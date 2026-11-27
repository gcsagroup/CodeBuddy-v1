<!-- 2026-11-16 已批准：对话 sidebarPlacement 由 Compat 唯一写入，导航只消费；归属与 cwd 分离。目录切换沿用原有 Harness owner 和运行中拒绝规则。详见 docs/conversation-drag-drop.zh-CN.md。 -->
## 2026-11-27 已批准：最终回复按需语音播报

现有配置服务继续持有 `SPEECH_SERVICES`，合成字段为 `REMOTE_TTS_URL` / `REMOTE_TTS_MODEL`，ASR 与 TTS 设置独立保存并保留其他字段。`runtime/speech-playback.mjs` 持有接口校验、分段合成、请求取消和播放背压，新 `/speech-playback` 复用运行时 token 认证；前端 `speechPlayback.ts` 持有单一活动播报、PCM 调度及播放完成确认。消息操作栏仅消费已有最终回复正文，不重新判断 Agent 完成状态。仅用户点击播报或设置中的显式检测会请求合成，不自动合成新回复。停止、切换或卸载时立即释放本地播放，后端按服务地址排空已提交片段后才交接新播报，不再发送旧回复后续片段，避免远端单槽取消竞态。等待时显示可取消的加载图标。播报错误由已有右上角铃铛通知区消费播放状态展示，不再写入消息操作栏。播报正文过滤表情与装饰符号，不改变消息原文，不新增音频持久化或 Agent 工具权限。详见 [回复播报说明](../../docs/reply-speech.zh-CN.md)。

## 2026-11-27 已批准：独立语音通话改用 GemmaE2B 与 QwenTTS

本节覆盖下节早期 Haru 实现。用户要求原生音频输入 → 文本流 → TTS，并最新指定第一版多轮记忆采用滑动窗口，撤回逐轮摘要。智能体资料仍由原服务持有；电话页在开始时固定所选名称与人设。`VoiceCall` / `UtteranceCapture` 持有本地采音、能量停顿分段、手动结束、播放与设备生命周期；`runtime/voice-call.mjs` 持有逐轮 Gemma/TTS 请求、序号隔离、取消、流式转发及本次通话内存窗口。当前发言原生音频交给 Gemma 回复，音频合成完成后由同一 Gemma 转写原话，仅用于后续历史。最多保留前三轮用户转写和助手已生成文字，历史文字上限 1200 UTF-8 字节，超限淘汰最旧完整轮次，当前音频和人设不截断。不得把已生成文字当作用户已听见的事实。后台转写失败只记录日志并标记该轮用户内容未知，不弹错或挂断。挂断取消在途转写并清空窗口，不保存持久化音频、字幕或记忆。认证沿用运行时密钥，不进入 Harness Agent 执行，不新增工具权限。当前无压缩请求，不存在压缩失败的前台提示。详见 [当前电话页说明](../../docs/voice-call.zh-CN.md)。

## 2026-11-27 早期实现（已替换）：独立 Haru 语音通话

自定义智能体服务继续持有人设；通话页在开始时读取选中角色的名称与提示词作为本次快照。`runtime/voice-call.mjs` 持有远端 Haru 地址和会话信令，复用运行时 WebSocket 密钥认证；`HaruCall` 持有浏览器 WebRTC、麦克风与播放生命周期。音频不进入 Harness/ACP 执行消息，通话不拥有工具调用、权限、Agent 状态或完成事实，不新增持久化会话。关闭通话会取消远端 WebRTC 会话并释放本地设备。详见 [Haru 实时语音通话](../../docs/haru-voice-call.zh-CN.md)。

## 2026-11-26 已批准：多项目工作区与只读优先

目录成员、版本和真实目录身份由 `WorkspaceService` 持有；Compat 保存会话创建时的 `projectFoldersSnapshot`，已有会话不随项目编辑改变范围。文件与终端适配器消费同一验证结果；子任务沿 Harness 已验证父子关系继承根快照。仅参考目录禁止完全访问，审批不能扩大此边界。Windows 多目录 capability 随目录组合隔离，底层执行和取消继续由 Harness 持有。详见 [多项目工作区](../../docs/multi-project-workspaces.zh-CN.md)。

繁體：工作區服務擁有目錄設定，會話快照固定執行範圍；參考目錄限制完整存取。English: WorkspaceService owns membership; session snapshots fix execution scope and reference folders prohibit full access.

## 2026-11-22 已批准：启动模型清单与变更提示

## 2026-11-25 已批准：立即切换与待发送队列

本节覆盖下文旧“本地队列 / onSteerQueuedMessage / 立即发送不取消”描述。用户已明确批准整模块修复：普通输入排队；“立即切换”和“全部立即发送”持久化所选消息后取消当前执行，等待原轮次及子任务结算，再开始新轮次。

`runtime/input-queue.mjs` 是进入原生执行前的交付账本 owner，通过现有 Session store 保存版本、独立消息身份、选择批次和命令去重记录。它调用既有 Compat prompt/cancel，不拥有模型执行、工具权限、目标完成或原生 Inbox。Harness 原生 `user/message` 消费回执是已消费的唯一依据；ACK 仅确认队列操作。批量输入经原生 maintenance barrier 接入 next-step，同一次新调用保留每条消息身份、顺序与附件。

编辑、删除、清空、排序通过同一版本校验；切换中的选择冻结。Stop 暂停剩余草稿；冷启动不自动重放；不明交付先与原生消费/当前 Inbox 核对，确认未接入后才允许用户重新排队。前端只展示后台快照，旧 localStorage 仅作一次迁移和未确认命令恢复，不再独立调度。桌面 generation 沿用入队版本，显式立即发送才更新版本。

繁體：待發送交付帳本由 runtime 管理，普通訊息依序等待；立即切換先取消並等待舊輪結束，再按獨立身份交付所選訊息。原生消費回執決定是否移出佇列；停止及重啟保留草稿，不自動重播不明結果。

English: Runtime owns the pre-admission delivery ledger. Ordinary inputs wait in order; explicit switching cancels and settles the old execution before admitting the selected messages with separate identities. Native consumption receipts determine removal. Stop and restart preserve drafts; uncertain deliveries are never automatically replayed.


`runtime/model-inventory.mjs` 是启动及手动模型刷新、连接身份校验、成功基线和待确认变化的唯一 writer；`providers.mjs` 只提供服务发现和能力事实。可选 `providers[].inventoryState` 在成功刷新时建立，旧状态无需迁移。`runtime/status` 投影提示与修订，桌面翻译展示，不重新裁决下架、失败或能力变化。默认模型、会话模型和用户能力覆盖仍由既有设置 owner 写入；刷新不能代替用户换模型。在途请求必须校验连接身份，关闭后禁止提交，通知确认绑定版本。详见 `docs/model-inventory-refresh.zh-CN.md`。

繁體：執行階段統一持有模型清單、基線和提示；桌面僅展示，不自動切換模型。English: The runtime owns inventory, baselines and notices; the desktop only presents them and never changes model selection automatically.

## 2026-11-19 已批准：Mac 可选单字段聚焦写入

主模型选择当前已观察字段和值；Go 只校验并透传可选 `set_value.focus`，Swift 唯一持有聚焦、聚焦后窗口/控件/旧值/实际焦点/输入版本/租约复核与真实写入回执。聚焦触发的应用变化不得跳过重新校验。失败停止，无坐标猜测、键盘回退、整表批量或动作重放。旧调用不变，不新增持久化状态；宿主继续持有 Esc、断线停控及新输入恢复权威。见 [协议与迁移边界](../../docs/mac-focused-value.zh-CN.md)。

繁體：原生層在單欄聚焦後重新核對再寫入，主模型仍選欄位，宿主仍控制接管與恢復。English: The model selects one field; native code revalidates after focusing before writing. Host takeover and resume authority are unchanged.

## 2026-11-19 已批准：Mac 当前 PDF 只读落盘回执

Mac 原生观察器从已匹配窗口的 AXDocument 读取本地 PDF，用系统 PDFKit 返回磁盘字段快照；模型不能提供另一个路径。原生层持有文件身份、读前读后稳定性及读取失败事实，Go 只投影 `pdf_document`。界面控件值与磁盘值分别保留，主模型比较目标、保留字段和真实回执；不新增自动保存、提交或任务完成裁决。只读字段快照不证明远端同步成功。旧观察调用兼容，无新持久化状态。

繁體：原生層只讀目前視窗 AXDocument 指定的本機 PDF，分開回傳磁碟與介面值，不自動儲存或提交。English: The native observer owns read-only disk evidence for the local PDF identified by the matched window's AXDocument. Go projects it; the model compares values. No automatic save, submit, new persistence, or completion authority is introduced.

## 2026-11-19 已批准：Mac FORMS 英文评分标签投影

主模型持有字段含义、英文标签翻译与用户修改范围的判断；Go MCP 仅把可选 `form_labels` 绑定到当前窗口快照中的控件，Swift 在评分前核对窗口、所有带名称或值的节点及全部可编辑字段的身份、标签、值与几何。空白非编辑装饰节点不构成语义上下文；字段原生路径、旧值和附近文字仍须一致。原始中文标签、当前值和用户填写值不被投影改写。FluidUse/CUA-S1-FORMS 只持有本地推荐与概率，不持有输入、授权或完成事实。未映射字段不评分；过期或无效投影只降级推荐，仍返回新观察。既有无投影调用保留原行为，不新增持久状态或输入权限。详见 `docs/mac-form-label-projection.zh-CN.md`。

繁體：主模型翻譯評分標籤，宿主綁定觀察、原生層核對；FORMS 僅推薦，不改原值或權限。English: The main model owns semantic translation; Go binds the current observation and Swift validates it. Local FORMS owns recommendations only; original values, input permissions and completion ownership remain unchanged.

## 2026-11-17 已批准：提供商 API 路径开关

`runtime/providers.mjs` 统一解析模型发现、验证和执行的路径。提供商配置 `autoAppendApiVersion` 为 false 时忽略自定义 `basePath`，保留 API 地址自身路径，仅追加协议端点，不自动补 `/v1`；true 沿用自定义路径及版本补齐规则。UI 新建默认关闭，已有配置缺省字段按 true 读取，旧客户端更新保留已保存值，不批量迁移已有连接。完整 Chat Completions/Responses 地址不重复追加端点，Ollama 的原生模型发现仍使用 `/api/tags`。Google 官方兼容端点另通过适配器的 `supportsStore: false` 合同禁用不支持的字段；不按模型名称推断服务能力，不修改 Harness 内核。

## 2026-11-16 已批准：补充后的逐次工具确认与验收事实

Harness 原生用户输入事件持有补充已进入当前轮的事实；适配层仅在该事件或带队列来源的后续原生轮中启用逐次工具确认。非只读提案仍由 Harness 的执行前审批执行，Compat 复用现有审批卡展示精确参数与有界原生回执，只允许本次批准，不复用会话许可。已执行的操作不回滚；禁止审批、取消及未知答复均不授予执行。普通新轮恢复既有权限。此规则默认用于交互会话的补充输入，不重写历史或引入第二执行器。

Harness 的结束事实不等于项目验收。Compat 保留现有终态报告中的未验证分类，包括零工具轮；聊天保留模型回复原文，不额外显示未验收提醒，也不根据模型文字、成功进程或历史验证自动标记当前任务 PASS。没有新增验收模型、外部脚本门禁或自动宣告验收成功的接口。Windows 原生 PowerShell 执行器为 Python 管道缺省声明 UTF-8，保留显式编码覆盖；原始回执仍由 Harness 持有。

繁體：補充後的非唯讀提案逐次批准，原生結束不代表獨立驗收；後端保留未驗收記錄。聊天顯示模型原文，不另行提示或自動標記 PASS。English: Supplemental side effects require per-call approval. Native turn completion does not certify acceptance; the backend retains the unverified record. Chat displays the model’s reply without an extra reminder or an automatic PASS label. Python pipes default to explicit UTF-8.

## 项目附加文件夹

WorkspaceService 按主工作目录保存桌面用户选择的附加目录、目录身份、访问方式及配置版本。侧栏编辑项目和会话提示消费同一份配置。Harness 文件工具在每次写入时查询当前关联，允许修改的附加目录仍受会话只读模式限制。终端继续使用会话沙箱策略。解除关联只更新配置。

繁體：WorkspaceService 保存附加資料夾及其權限，Harness 檔案工具在寫入時核對。終端機沿用對話權限。English: WorkspaceService owns linked folders and their access modes. Harness file tools check current grants on mutation. Shell sessions retain their own sandbox policy.

## 2026-11-12 主对话进度与项目派发

进度查询只按目标会话聚合当前原生历史、工具回执和运行状态。项目启动和后续派发沿用主对话的目标审批和目标会话自身的 prompt 入口。按原生用户输入的 request ID 确认受理、识别重试，执行和完成仍由目标 Harness 负责。主对话工作区不承担项目运行。

启动后直接返回由审批卡中的范围、目标会话原生受理回执和当前输入共同决定。Harness 检查单个工具调用及待处理的新输入后结束主对话本轮；宿主投递受理文本，工作仍属于项目会话。混合请求继续执行。仅委派的主对话轮次保留协调职责，审批后新增的用户指令可改变范围。

繁體：目標對話的原生輸入事件確認受理，執行結果決定完成。English: The target chat's native input event confirms acceptance. Its run and receipts establish execution and completion.

## 2026-11-12 已批准：压缩的可选模型与固定 Flash 兜底

2026-11-13 运行快照缺陷修复：锁版兼容入口使 Session 的原生模型消息投影只保留最新完整 runtime-context 快照，TokenMeter 复用同一原生前缀解释器；原始日志、位置范围和格式不变。命令提醒只索引本轮未解决的原生进程回执，不裁决业务验收；摘要失败沿用现有抑制，并增加有界的配置/历史进展恢复条件。执行、权限、重试、范围与检查点权威仍归 Harness，详见 `docs/runtime-context-safety.zh-CN.md`。

Compat 解析现有连接中的原生压缩、用户指定可选兜底、固定 Qwen Flash 的有序路线；设置页仅保存可选模型，不判定成功或擅自切换聊天模型。Harness 的既有压缩引擎继续持有范围、配对、摘要校验、检查点提交、取消和失败事实；按本次已尝试路线去重，不轮回重试。手动压缩在原生维护锁内有界缩减，由当前聊天模型的原生请求投影和适配器计量验收。有效检查点仍需继续分段时保留当前压缩路线；所有层级失败时保留历史、文件和已完成回执，明确重试不重做工具。旧配置不迁移或覆盖，既有独立摘要配置继续作为第一级。配置与边界见 `docs/compaction-fallback.zh-CN.md`。

## 2026-11-11 已批准：主对话管理项目、对话与会话级权限

主对话的可信身份沿用 Compat 的内部标识。`inspect_workspace` 消费 WorkspaceService 的项目来源、会话索引、Harness 运行投影及当前原生历史。`manage_workspace` 仅在主对话根轮次注册，跨目标修改显示精确目标并按次批准。WorkspaceService 写项目资料与分配文件夹；Compat 复用会话创建、归档、重命名与逻辑删除入口。Store 在目标会话中保存可选的 `permissionOverride`；旧会话缺省继承原规则，显式继承恢复默认。运行中的轮次保留准入时的覆盖，Harness 持有实际权限。全局设置及现有 ACP 全局模式语义继续沿用。清空／分叉后的历史查询跟随产品身份解析的新原生 ID。概览只投影事实，不持有执行、授权或完成状态。

繁體：主對話管理工具按專案與對話 ID 操作，權限覆寫存於目標對話，生效範圍由 Harness 執行。English: Main-chat changes bind to project and conversation IDs. A per-chat override is stored on its target; Harness enforces permissions. See `docs/main-conversation-management.en.md`.

## 2026-11-11 已批准：对话的图片和视频生成服务

火山方舟与百炼的模型目录刷新只读取候选模型。用户勾选并保存后，服务才登记新模型。默认模型由设置页的默认选择器指定。对话中的进度卡使用会话 ID 与任务 ID 打开右侧预览，进度和产物沿用该任务的回执。

繁體：重新整理官方模型只讀取候選清單，勾選並儲存後才加入服務。預覽依會話與任務 ID 顯示回執。 English: Catalog refresh reads candidates. The service stores a new model when the user selects and saves it. Previews follow the receipt for the selected session and job.

生成设置由 runtime/media-services.mjs 保存。每项默认选择绑定服务、模型和能力，旧 ComfyUI 地址沿用为两个默认项。密钥由系统凭据机制保护；桌面只读取是否已配置。媒体工具在提交前检查能力和工作区参考文件，当前请求的语义选择继续由 Harness 解析。云适配器翻译厂商请求与回执，媒体工具仍持有本地任务状态和文件发布。切换默认项后，已有任务按回执中的原服务、模型与厂商任务 ID 查询；提交不明时禁止自动重发。移除连接可能中断后续鉴权。旧回执继续按 ComfyUI 处理。

繁體：生成設定保存獨立的圖片與影片預設模型。舊任務依原服務與任務 ID 查詢，產物由媒體工具發布。English: Media settings own the image and video defaults. Existing receipts retain their service and remote task ID. The media tools own publication and job state.

## 2026-11-10 已批准：界面连接与任务生命周期分离

Harness 继续唯一持有执行、取消及结束事实；WebSocket 关闭仅移除显示客户端并拒绝该连接的待答 RPC，不再取消已接纳任务。Compat 为活动请求提供会话级投递连接，session/load 完成原生回放后绑定新客户端并投影当前 activeRunId；前端恢复连接后加载原会话，不重发用户请求。原生日志负责持久化，连接适配器不另建执行器或持久运行状态。仅权限、问题及配方参数可在同一原生请求与截止时间内重新呈现；浏览器及桌面操作不自动重放。显式停止及服务关闭沿用原生取消。后端进程退出后的自动续跑不在本次范围；旧会话无需迁移。工具错误序列化仅展示有界的原生取消种类，不重判取消来源或结果。详见 `docs/session-reconnect.zh-CN.md`。

繁體：Harness 持有任務生命週期；斷線僅解除客戶端，重連載入原會話與真實執行狀態。人類決策沿用原請求與期限，不重播桌面操作。English: Harness owns task lifecycle. Disconnect detaches delivery only; reconnect reloads the same native session and live run. Human decisions retain native scope/deadlines; side-effecting desktop operations are never replayed by transport.

## 2026-11-10 已批准：会话异步删除

Store 唯一持有小型持久化删除标记及读取屏蔽；Compat 在既有会话锁和原生活动校验通过后提交标记，ACP 成功表示逻辑删除已生效。资源释放、关联调度停用、失败 transcript 日志清理与完整快照整理在后台执行，失败保留标记并重试，启动恢复。完整状态持久化及清理完成后才移除标记。前端消费受理结果，不自行裁决删除成功、不等待资源回收；项目文件保留。旧 profile 无需迁移；降级前需排空标记，边界见 `docs/async-session-delete.zh-CN.md`。

繁體：Store 持有持久刪除事實，Compat 保留活動任務檢查與背景回收；前端受理後關閉確認框，不刪工作區檔案。English: Store owns durable deletion visibility; Compat retains active-work admission and resumable cleanup. UI consumes committed logical deletion, preserving workspace files.

## 2026-11-10 已批准：移除交付复核与独立验收

用户要求移除两套完成检查。结束前不再请求当前或独立模型评分，也不再接纳外部验收脚本配置。旧 `CODEBUDDY_COMPLETION_REVIEW` 配置和旧消息验收元数据不再参与运行，不清除用户历史或凭据。Harness 原生执行、结束、重试、取消与压缩仍为 owner；保留命令真实回执、非零退出提示、权限与沙箱、模型协议与空响应校验。模型自行调用项目测试的能力不变；删除会话仍检查活动任务。

繁體：移除交付複核與獨立驗收入口及執行；原生 Harness、權限、工具錯誤與空回應校驗保留，舊設定不再生效，不刪歷史。English: Completion review and executable acceptance gates are removed. Harness retains execution and terminal authority; permissions, tool outcomes and empty-response validation remain. Legacy gate settings are inert; history is preserved.

## 2026-11-10 已授权：本轮运行提示与模型选择入口

用户要求按实际运行表现提示模型/服务适配问题。`commandEvidence` 保持进程失败事实 owner；driver 只透传显示元数据。`work-status` 在现有单轮闭包内投影请求计时、连续工具失败和响应重试，通过既有 `execution_activity` 发布可选字段；桌面 store 校验轮次，`useWorkStatus/RunAdviceCard` 只负责显示。提示不持有完成、授权、取消或模型评级权威，不追加模型调用，不迁移持久化状态。用户点击后由原有取消控制器停止，空闲后打开现有模型选择器，不自动重发。旧字段缺失则降级为原有状态显示。设计与参考见 `docs/run-advice.zh-CN.md`。

繁體：本輪計時與失敗次數僅作顯示，完成與取消仍由原生 owner 決定；使用者停止後才開啟模型選擇，不自動重送。English: Per-run observations are advisory only; native owners retain execution and terminal authority. Explicit user cancellation precedes the existing model picker, with no automatic replay or persistence migration.

## 2026-11-09 已批准：Windows 工作区标签权限修复

真实Aegis只读扩展验证后补齐显式Host装配：工具定义继续拥有`timeoutMs`声明，`dsh-tool-call-timeout-policy`在原生工具体执行阶段消费它，沿原有`exec.signal`发出协作取消并等待下游收束，自己的期限到达时保留原生`TOOL_TIMEOUT`结构。`glob/grep`及`web_fetch`已有30秒声明，不新增第二套计时器或按目录排除；调用者先取消仍由原有错误合同结算。未声明定义级期限的PowerShell仍由自己的逐调用预算和后台作业管理；预审批与排队仍由原owner处理。该插件已存在于一致的生产依赖闭包，分发按显式profile收集。没有修改Aegis、受限权限或公共协议。

2026-11-25 同批编码修复：CodeBuddy PowerShell 适配在原生 `confine` 期限内逐次只读探测实际主版本，原生 subprocess 仍持有启动、取消与退出事实。默认 Windows ACL carrier 仅初始化自己新建的隐藏 console，保留重定向句柄；PS Core 使用启动前双CP65001和公开无BOM getter，5.1保留输入兼容和明确的Unicode局限。自定义 runner 与完全权限不参与该适配。探针失败不派发用户命令，preload失败使用锁版原生runner错误合同，真实用户进程回执不重写。私有接缝锁定指纹，不引入长期版本缓存、命令重放、语言模式提升或新的执行 owner。详见 `decisions/ADR-003-windows-pwsh-byte-stream.md`。

2026-11-25 按本轮修复授权隔离同步准备：原生Harness继续持有权限模式、工具执行、取消与真实终止。CodeBuddy最多4个按工作区/模式认领的逻辑槽，每槽一代准备进程和父级FIFO；同步接收请求，取消活动请求不误伤另一会话未派发请求，保留原取消信号及单调期限。旧进程close后才换代，不重放已派发命令；根身份改变拒绝旧目标队列，新调用重新准备。默认120秒兜底覆盖队列及准备，原生工具更短期限/取消优先，派发和成功交接复检期限；Job提供最终进程树边界。

推送前真实反例推翻了增量标签缓存：基线后新建树外硬链接、通过别名修改安全描述符并解除链接，工作区目录通知无法感知；同一helper全查可恢复受限写。因此撤回基线、观察器、定点选择与变更IPC，每条workspace-write shell准备在原预算内完整检查，只读和文件读取工具不进入标签遍历。瞬时32/33锁冲突只返回partial并跳过，下一全查重试，不永久缓存跳过事实。原helper仍负责对象权限、无继承标签和临时DACL恢复；根身份在授权前及扫描后核验。目录锁按账户/卷号/文件ID，独立项目不互等，重叠目录保持串行。路径缓冲按实际长度分配，不改变权限规则。首次及后续大树准备仍可能超时，不能宣称冷启动成本已根治。见decisions/ADR-002-windows-sandbox-preparation.md。

会话TEMP由Host级稳定资源进程持有，使用官方capability/SID，跨准备进程回收复用。消费每一代原生subprocess owner的drain后才释放；失败/硬回收保留旧随机授权，新代不认领旧目录。普通回收沿用资源操作120秒看门狗，异常abandon仍2.5秒；桌面15秒外层退出兜底不变。私有SDK接缝核验源码指纹，不新增持久化状态或执行owner。

编码探针与默认tool-pwsh复用同一startup Promise及原生handle，确认受管范围退出才结算正常取消；清理无法确认返回明确错误，原始异常实例保留SANDBOX_UNAVAILABLE类型。UI仅在已提交的真实轮次显示正在停止，未发送pending气泡不认领状态。各事实owner保持不变。

本轮追加授权：受限执行前，为当前账户拥有且可写的工作区已有文件和目录补齐缺失的低完整性标签。`WorkspaceLabelAccess` 逐层固定原生句柄，不跟随重解析点，跳过硬链接、其他所有者、受保护 DACL、相关显式拒绝及已有完整性标签；不处理父目录或工作区外对象。必要的临时 `WRITE_OWNER` 仅用于当前对象标签写入，随后恢复原 DACL（包括继承状态），不永久授予完全控制。标签不带继承位，避免波及被跳过的子项。每次命令前重新检查，以覆盖宿主文件工具后来创建的文件；失败不切换到无沙箱运行。原生沙箱仍持有能力 SID 和执行权限。

繁體：追加授權僅補齊目前帳戶擁有且可寫之工作區既有項目的低完整性標籤；跳過連結、其他擁有者及受保護項目。原生句柄固定範圍，臨時標籤權限用後恢復原 DACL，不擴大至父目錄或工作區外。標籤可能使 Office 採用受保護檢視。

English: Additional authorization covers missing low-integrity labels on writable, current-user-owned existing workspace entries only. Pinned native handles exclude reparse points, hard links, foreign owners and protected policy. Temporary label access restores the original DACL and inheritance state; no permanent full-control grant or out-of-workspace mutation is allowed. Each command rechecks host-created files. Label changes can cause Office Protected View.

根目录原有修复保持不变：`runtime/harness/windows-sandbox.mjs` 在官方 `LocalSandboxProvider` 返回 `SetNamedSecurityInfoW / 5` 时，调用 `WorkspaceLabelAccess.cs` 核对目录句柄、当前账户所有权及现有写入权限。仅对符合条件的工作区根目录，给当前账户添加不继承的 `WRITE_OWNER`，随后由官方 Provider 再次建立受限执行。父目录、其他所有者目录、重解析点、卷根与相关显式拒绝均不扩大权限。原生句柄与账户级互斥负责对象身份和并发检查。模型和前端不决定该修复的授权范围。

繁體：已獲使用者授權，僅為目前帳戶擁有且可寫的工作區根目錄補上不繼承的 `WRITE_OWNER`；官方 Provider 繼續持有受限執行。目錄身分、所有權及有效權限由原生句柄核對。

English: The user authorized a non-inheritable `WRITE_OWNER` grant only on a writable workspace root owned by the current account. Native handles verify identity, ownership and effective access. The official sandbox provider retains restricted execution ownership and retries after the scoped repair.

## 按当前请求的张数交付图片

Harness 的媒体选择器按本轮用户原始消息及已接纳的引导解析图片总张数、交付图片后是否还有工作。媒体工具在服务调用前串行登记回执，已保存和待确认任务共同占用名额，确认失败或取消释放名额。修改创作参数不会重置张数。仅需图片的任务达到目标后沿用原生 `concludeTurn()`，另有后续工作的任务继续执行。历史回执仍可查询。

繁體：依已接納的使用者訊息判定圖片總數，送出前計入已儲存與待確認的工作，純圖片請求達標後結束。English: The interpreter reads the requested image count from admitted user messages. The media tool reserves capacity before submission and counts saved files and outstanding jobs. Image-only turns may conclude on verified delivery.

## 2026-11-07 已批准：单媒体产物直接交付

独立媒体请求解析器额外持有可选 `single_media_only` 语义范围：明确只需一个产物且没有后续任务才为真。宿主仅在当前请求 hash/ID 匹配、没有待接纳插话、可信媒体工具返回 completed 且确切一份已保存输出时调用原生 `concludeTurn()`。Harness 继续持有成功结果持久化、工具组及结束语义；媒体工具持有产物事实。旧记录缺失或字段无效继续普通执行，无迁移；失败、取消、后台等待、旧任务及维护调用不直接结束。UI 沿用媒体卡，无伪造助手正文。

繁體：解析器判定單產物且無後續工作；宿主校驗當前請求與真實完成回執，使用 Harness 原生結束接口。舊資料缺失時繼續一般流程，不遷移。

English: The isolated interpreter owns optional single-artifact-only scope. The host validates current admission identity and one saved completed output before invoking native concludeTurn. Harness retains result/group/turn lifecycle ownership. Missing legacy scope continues normally without migration.

## 2026-11-06 已批准：当前请求的媒体工作流选择

`runtime/harness/media-workflow-selection.mjs` 唯一持有已保存媒体工作流的语义选择。它通过原生会话日志读取当前已接纳请求及同轮插话，用当前 Provider 的独立短请求解析实时目录，不读取主模型的历史选择或工具参数中的名称。主 Agent 继续负责创作提示、模式与参考素材提案；`comfyui-tool` 只消费结构化选择，校验文件身份、依赖、模式和参考数量。旧 `workflow_name` 参数兼容接收但不覆盖解析结果；旧回执、status/cancel 与内部直接调用仍兼容。

选择绑定原生请求身份及目录哈希，无跨轮缓存；解析后目录变化、插话待接纳、已接纳请求变化、结果不完整或不兼容均在 GPU 提交前拒绝。可选 `workflow_selection` 回执仅记录来源，不代表生成完成、授权扩大或新的任务状态。选择器不授权创建替代图。无旧数据迁移，无新框架；每次新生成增加一次短模型调用。主模型和下游不各自重新裁决同一工作流选择。

`media-artifact-context.mjs` 从同一原生会话的真实媒体工具回执投影最近产物及输入图片关系，供主模型在压缩后继续识别素材版本。它不选择素材、不替换工具参数、不持有新的完成状态，也不迁移旧事件。繁體：最近產物與來源關係只由原生回執投影，素材語義仍由主模型理解。English: Recent artifacts and image lineage are projected from native receipts only; reference semantics remain owned by the main model, with no parameter rewriting or new completion state.

省略 `request_id` 的生成调用在当前已接纳请求内，按请求身份、实际工作流与创作参数派生自动幂等 ID；显示名称和旧工作流提示不参与。新请求、不同参数／seed 或明确不同的 ID 仍可生成独立结果，不从自由文本推断数量上限。繁體：相同請求與參數復用真實回執，新請求及明確變體維持獨立。English: Automatic IDs deduplicate identical proposals within one admitted request; new requests, changed parameters/seeds and explicit IDs remain distinct. No textual generation-count policy is inferred.

繁體：獨立解析器唯一持有當前已接納請求的已儲存工作流選擇，主 Agent 提供創作／素材提案，工具校驗並執行。請求或目錄變更使選擇失效；舊資料無需遷移，可選來源回執不是完成或授權事實。

English: The isolated interpreter solely owns saved media workflow selection from native admitted requests and the live catalog. The main Agent proposes creative content and references; execution validates and consumes the structured choice. Request/catalog changes invalidate selection before GPU submission. Existing receipts need no migration; optional provenance is not completion or authorization.

## 2026-11-06 已批准：首次回复与可选连接就绪分离

`mcp-bridge` 继续持有传输、就绪 Promise、诊断、动态注册及销毁，增加 connecting 状态；原生 scope 与 preset registry 继续持有选择投影和租约。`Compat` 的初始化事实为配置已应用，不再等价于全部扩展已连接；配置 revision、下一轮同步及每次调用的权限检查保持不变。工具发现只消费当前作用域的就绪事实，按结构化服务选择进行可取消等待，不授予执行权限。UI 只展示同一状态，并对卡片逐批挂载，不另建后端目录或权限缓存。迁移边界与日志解释见 `docs/toolbox-runtime.zh-CN.md`。

繁體：bridge 持有連線就緒事實，scope／registry 持有選擇與租約；設定已套用不等於全部連線完成。發現可取消地等待指定服務，不授予權限，下一輪同步及每次呼叫檢查不變。

English: The bridge owns connection readiness; native scopes/registry own selection and leases. Applied configuration does not imply all connections are ready. Discovery awaits selected services with cancellation but grants no execution authority; next-turn synchronization and per-call checks remain unchanged.

## 2026-11-06 已批准：工具箱与同一会话下一轮同步

本批补充：远端连接由原生 preset registry 按单服务完整配置租用，会话 scope 只投影所选工具、资源和说明；不再缓存整组连接。工具箱顶部及卡片读取同一后端会话状态，重试仅失效失败项。初始化结束重新核对全局配置及会话选择。显式 follow 不执行旧临时定义，保留原加密名单供切回 custom；全局删除和停用策略始终优先。迁移与适用边界见 `docs/toolbox-runtime.zh-CN.md`。

繁體：原生 registry 持有單服務連線租約，會話 scope 只投影選定能力。介面使用同一狀態，重試僅失效失敗項，初始化完成重查設定與選擇。follow 保留但不執行舊名單，切回 custom 可恢復，仍遵守全域停用／刪除。

English: Native registry leases own individual server connections; session scopes project selected capabilities. UI consumes one state snapshot and retry retires only failed entries. Initialization rechecks settings and selection before readiness. Follow retains but does not execute legacy definitions; switching back restores the custom list subject to global disable/removal policy.

普通新对话默认跟随当前全局启用配置；明确的工具名单、配方及角色范围保持自定义限制。旧会话没有选择来源证据时不扩大范围，工具箱提供显式“跟随工具箱”切换。`RuntimeSettings` 持有配置与删除标记，`session-extensions` 解析当前选择；全局删除的名称不得由历史定义或内联服务器副本恢复，显式重新添加才解除该标记。`Compat` 延用配置 revision、初始化失效与下一轮准入检查，正在执行的作用域不因新增而重建；工具调用继续检查当前启用策略与授权身份。技能沿用原生目录、内容版本及 Provider 失效机制，不建立第二份技能注册表。从对话进入的工具箱与技能编辑器以会话 cwd 为项目目录；使用技能返回原会话并追加草稿，不自动发送、不覆盖已有草稿。

`session/extensions/state` 是只读投影，不启动连接；`mode` 保存 follow/custom 选择，下轮应用；`retry` 只在可写、未归档会话空闲时显式重新准备。UI 将配置同步与实际 MCP 连接结果分开，历史成功次数不等于当前 ready。MCP 启动失败保留有界、脱敏诊断；相同连接配置的首次失败冷却 30 秒，配置变更和显式重试清除对应冷却，已建立连接的重连与调用不重放规则不变。凭据不进入新增状态接口。没有替换独立 Rust 工具或新增 Agent 循环。

繁體：一般新對話跟隨工具箱，既有明確限制不擴大；設定及刪除標記由 RuntimeSettings 持有，下輪准入套用目前設定。歷史擴充定義不得復活已刪除項目。介面分開顯示設定同步、連線及使用歷史；啟動診斷有界並遮蔽密鑰，相同失敗短暫冷卻，明確重試可解除。對話工具箱及技能編輯器使用該會話 cwd；使用技能會返回原對話並追加草稿，不自動傳送。

English: Ordinary new conversations follow enabled toolbox configuration. Explicit and ambiguous legacy selections retain their scope until changed by the user. RuntimeSettings owns configuration and retirement markers; session resolution cannot resurrect removed globals from historical definitions. Existing admission revision checks apply changes before the next idle turn. UI separates applied configuration, live connections and historical usage. Bounded startup diagnostics redact credentials; identical startup failures have a 30-second cooldown cleared by configuration changes or explicit retry. The conversation toolbox and skill editor use the owning session cwd. Using a skill returns to that conversation and appends a draft without sending it. Native execution, approvals, skills and independent Rust tools retain their owners.

## 2026-11-06 已批准：分组内置顶与发送时应用思考强度

简体：工作区先于任务显示；会话置顶仍使用原本机偏好，在所属分组内排序，不再单列。项目置顶使用独立的本机路径偏好，不改变会话归属或运行状态。文件夹归档先查齐当前项目会话并确认，再逐个调用既有归档服务；部分失败保留尚未归档的记录供重试，不修改项目文件。聊天思考强度先保留为按连接／模型区分的桌面内存草稿，只有显式发送时才通过既有 Provider 配置服务保存，随后提交任务；运行中重复发送被原请求门禁拒绝，自动续跑不消费草稿。模型列表刷新继续由现有 inventory refresh 服务负责，不改变当前选择；失败保留旧列表。无需迁移旧会话。

繁體：工作區先於任務，對話在原分組內置頂；專案置頂為本機路徑偏好。資料夾封存先確認完整清單，失敗可重試，不修改檔案。聊天思考強度為依連線／模型區分的記憶體草稿，明確傳送時才透過既有設定服務儲存；自動續跑不套用。重新整理模型沿用 inventory 服務，失敗保留清單，不改選擇。

English: Workspaces precede Tasks; pinned conversations stay in their owning group. Project pins are local path preferences. Folder archive confirms the complete matching list, uses the existing archive service, and retains failed items for retry without modifying files. Composer thinking changes remain connection/model-scoped in-memory drafts until explicit submission saves them through the existing Provider settings service; automatic continuation does not consume them. Model refresh uses the existing inventory service and preserves selection and cached lists on failure. Existing conversations need no migration.

## 2026-11-05 已批准：独立对话分支、置顶与压缩反馈

会话分支继续使用 Harness 原生 fork。兼容层 `conversation-editing.mjs` 校验原会话状态与 UI／原生请求映射，可按下一条用户消息的精确 ID 截取前缀；旧时间边界仍兼容。任务型会话也可创建 `user` 类型的独立分支，继承所选历史、模型、工具与角色配置，原任务不变。分支共用工作目录，不复制任务运行、子智能体或后台进程；历史中的文件操作不会撤销或重放。运行中、归档或只读来源仍须先满足既有准入条件。旧会话无需迁移。

置顶仅为桌面本机 `localStorage` 偏好，不成为运行时任务状态或跨设备同步事实。归档会话不显示在置顶列表，恢复后可继续使用原偏好。会话标题仍用于导航，“…”及右键共用操作菜单；回复下方分支按钮按该轮边界调用同一 fork。

Harness 继续唯一持有压缩内容、事务、取消与结果。宿主只在同一 Agent 已成功手动压缩且原生 surface 未变化时跳过重复摘要，保留原生 maintenance 准入与取消检查；缓存仅存内存，重启或新增上下文后重新按原规则处理。界面消费结构化压缩生命周期显示耗时和完成／失败／取消回执，不从文案推断结果、不显示虚构百分比，不承诺首次摘要速度或摘要绝对无损。

繁體：原生 Harness fork 持有分支歷史；相容層按精確使用者訊息邊界建立獨立對話，共用資料夾但不複製任務、子智能體或背景程序。模型、工具與角色設定沿用，來源不改寫；舊資料不遷移。置頂僅為本機介面偏好。壓縮結果由原生生命週期提供，僅略過同一 Agent 在上下文未變時的重複手動摘要，不改首輪摘要內容或預算。

English: Harness owns native fork history. The compatibility layer validates an exact user-message boundary and creates an independent conversation sharing the source directory and configuration, without copying task runs, subagents, or background processes. Existing source guards remain and old data needs no migration. Pinning is a local UI preference. Compaction receipts consume native lifecycle facts; only redundant manual summaries on an unchanged surface of the same Agent are skipped. Summary content, initial-call budgets, and native admission remain unchanged.

## 2026-11-04：文件页外部打开

“文件”标签按需打开并可关闭，状态仅存在桌面会话内存中。路径栏分体按钮只作用于当前文件／目录：主按钮沿用默认打开方式，下拉菜单由主进程检测已安装编辑器并显示一次性选择，不改变系统文件关联。脚本仍走既有代码编辑器路径，不交给可能执行脚本的文件关联。`open-target` 沿用原会话／单文件授权，主进程在菜单返回后再次校验 realpath、对象类型及窗口生命周期；前端不能指定任意程序路径。没有新增聊天持久化或权限扩展，旧数据无需迁移。

繁體：檔案頁按目前物件提供外部開啟；主程序持有程式探索與啟動，選單結束後重新驗證原授權和生命週期。不修改系統關聯或聊天資料，腳本仍以編輯器開啟。

English: File-view controls open the current target. The main process discovers applications and revalidates the existing path grant and window lifetime after menu selection. One-shot choices do not change OS associations or chat storage; scripts retain the editor-only opening path.

Windows 文件菜单通过 Shell 的 `SHAssocEnumHandlers(ASSOC_FILTER_RECOMMENDED)` 按文件类型读取推荐应用，并用 `AssocQueryString` 读取默认应用名称；应用图标来自系统关联。主进程持有查询和调用，选择后通过 `IAssocHandler.Invoke` 打开，其他应用入口使用系统 `SHOpenWithDialog`，不解析或拼接注册表命令，不修改默认应用。目录及脚本保留已安装编辑器列表；macOS/Linux 保留原有编辑器发现路径，不宣称已接入其系统关联列表。查询失败时保留默认打开和系统选择入口并显示原因。

繁體：Windows 依檔案類型讀取系統推薦應用程式、預設名稱和圖示，以 Shell handler 開啟，其他應用程式使用系統選擇器；不修改系統預設。目錄和腳本保留編輯器路徑，macOS/Linux 保留原有行為。

English: Windows discovers recommended handlers, default app names, and icons by file type using Shell APIs. The main process invokes the selected handler or the native Open With dialog without parsing registry commands or changing defaults. Directories and scripts retain editor discovery; macOS/Linux retain their existing behavior.

## 2026-11-04：右侧本地文件浏览

主进程 `workspacePanelMain.ts` 持有原生文件选择器返回的窗口级、内存内只读授权；单文件选择不授权同目录其他文件，目录选择沿用 realpath 工作区路径检查。渲染层只消费返回的 selection，复用现有文本、媒体与文档预览。不修改会话工作区、Agent 工具权限或聊天持久化；窗口退出、渲染进程重建及完整导航使授权失效。旧聊天数据无需迁移。

繁體：主程序持有原生選擇器的視窗級唯讀授權，單檔選擇不授權同目錄其他檔案。目錄沿用 realpath 邊界；不改變對話工作區或 Agent 權限，視窗生命週期結束時失效。

English: The main process owns window-local, in-memory read-only picker grants. A file grant excludes siblings; directory grants reuse realpath containment checks. Rendering reuses existing previews without changing session workspaces, Agent permissions, or chat persistence. Window disposal, renderer loss, and full navigation revoke grants; no data migration is needed.

## 2026-11-04：输入框文件与对话引用

桌面 `@` 菜单复用工作区面板的目录／搜索服务和 ACP 会话列表，只消费文件类型、路径、会话 ID、标题与更新时间；不按文件扩展名猜目录、不复制整份会话内容。会话选中后使用锁定 Harness 的规范 `dsh-session:` mention，沿用文本草稿和消息通道，不新增持久化引用表或公共 RPC。

官方 `dsh-session-reference` 是引用解析、只读投影、预算、来源标记和快照持久化的唯一 owner。配置每条消息最多 3 个来源、每来源预览最多 24 KiB。只投影直接用户／助手文本与压缩检查点，排除工具、推理及其他注入上下文；旧对话里的指令和权限声明不能成为当前授权。快照保存后不随源对话变化而更新；前端的标签、移除和数量提示仅为交互，原生校验仍是最终门槛。旧消息和旧记录不迁移；未拥有原生历史的来源由原生 resolver 明确拒绝。

繁體：桌面只列出候選並傳遞原生 mention；Harness 持有有界、唯讀、不受信任的對話快照。沿用文字草稿與訊息持久化，不新增引用資料表；來源更新不改寫已捕獲快照。

English: Desktop lists candidates and sends native mentions. Harness owns bounded, read-only, untrusted session snapshots. Existing text drafts and message persistence are reused; no reference table or public RPC is added. Later source changes do not rewrite captured snapshots.
## 2026-11-04 已批准：桌面单文件只读引用与大文本展示

桌面主进程 `workspacePanelFiles` 统一解析用户点击的单文件引用，工作区外引用由文本/源码扩展到 PDF、Word、Excel、PPT、图片与视频。引用不授权所在目录的枚举、写入、终端工作区或 Agent 工具权限；普通 `read/list/save` 仍受当前会话根目录约束。文档预览每次读取重新核对规范路径和文件版本；媒体主进程注册表只发放绑定指定文件的不可猜测能力 URL，读取时重新核对路径、类型及大小，窗口关闭/重载撤销。界面消费只读引用标记，刷新、右键和预览沿用同一检查，不通过切换会话根目录绕过限制。

输入框、草稿、队列和 ACP 消息仍使用完整原始文本。附件统一位于输入区上方；大文本悬停预览由桌面展示层限量呈现，不以占位文字代替模型输入。只有用户单击文本块时，桌面主进程才在系统临时目录生成 UTF-8 TXT 副本并交给系统默认文本应用；渲染端不能指定写入目标、文件后缀或命令，副本编辑不回写草稿。文件路径的可点击展示不代表文件存在、交付完成或取得执行授权。

## 2026-11-03 已批准：会话级自定义智能体与独立子智能体

本节按用户明确要求覆盖下方 2026-10-29 角色与工作区强绑定约定的新使用入口。产品仍称“自定义智能体”，属性配置表单为必需的创建、编辑入口；对话创建只可作为后续生成草稿的辅助入口。模板沿用 `runtime/agent-profiles.mjs` 和现有 Store，不绑定或推荐模型，旧模板的模型字段忽略；模型统一由对话页选择，旧角色会话也不再锁定模型。同一会话选用、切换或撤销不新建目录、不改会话 ID、标题、模型、思考档位、额度或批准模式。旧工作区绑定和能力限制保持可读，撤销主身份不解除已有共享限制。

角色定义及输入采用的配置引用由同一模板 owner 保存。Store 在原生 prompt 准入前耐久保存 `{sessionId, rpcId}` 的不可变角色版本引用；相同原生请求 ID 重试不改绑。原生 Inbox 与 `user/message` 仍唯一持有准入事实。候选只在已等待的原生请求准备阶段校验；`agent/inbox/claimed` 不是最终接纳，也不能用其监听异常代替拒绝。恢复从原生已提交输入及原生待处理输入身份核对配置，不从模型文字、最新 UI 选择或内存映射推断；缺少必需绑定明确拒绝，不切换成普通无限制角色。配置引用不是执行日志，不持有任务、停止、完成或工具回执事实。

界面当前角色由原生已接纳人工输入的身份投影；选择与实际采用不同，不以忙碌状态结束代替采用事实。按用户追加的界面要求，输入框不常驻显示“下轮生效”，差异说明放在角色菜单及触发器提示中。原生真人 `user/message` 接纳后只发送会话定位的失效通知，界面重新查询原生日志投影，不另存角色事实；子级、调度与其他自动消息不更新主会话采用状态。查询经过服务器的延迟加载代理和产品/原生会话 ID 映射，不为打开选择菜单创建模型请求。旧工作区角色通过显式转换保存原已采用快照，转换不采用刚编辑的模板，也不移除原共享能力限制。

稳定执行组合不随主身份变化。角色正文使用原生 scoped prompt 贡献并设置 `interpolate: false`；业务能力复用原生 scope、工具限制、Skill 注册表和 MCP 代际租约。候选失败不得假报旧角色完整恢复；资源准备与实际提交分开，必要恢复失败明确阻断该输入。不新增角色连接池、工具注册表、Agent 循环或调度器。

自定义智能体与子智能体为独立产品模块。有无主角色都保留现有子模板、模型、并行限制、消息与结果回传。主助手可以继续执行并同时委派。子级身份、模型和工具过滤继续由原生 descriptor 创建与冷恢复；Host 只接入稳定共有配置，不整份继承父级主角色及其当前资源。原生扁平作用域和委派策略不冒称父角色权限自动继承，已有批准的共有授权与沙箱限制不因分离而扩大。

用户随后授权提供默认智能体并从 GitHub 复用配套 Skill。`runtime/agent-presets.mjs` 持有随包只读模板、稳定 ID、逐模板 revision 与资源元数据；直接选用不向用户模板列表写入副本，自定义后保存才走已有 save 产生独立 ID 与 revision。选择时继续由原模板 owner 保存版本快照，相同 ID/revision 的已有快照不得被不同内容覆盖。关联继续保存在原角色快照的 `skills` 中，不新增用户角色表或权限记录。内置 Skill 的文件、许可证与固定来源由 `runtime/harness/skills/agent-presets/` 持有；`role-skills.mjs` 通过官方 Skill Provider 挂在目标主 Agent 的作用域，按当前有效角色筛选并在角色更换时失效原生缓存。未选角色与子级不自动获得该挂载。正文读取、调用和原生加载回执继续由 DSH 持有；目录可见或角色选用成功都不代表模型已经读取或实际完成任务。

管理页只消费导航明确携带的来源会话，不猜测最近聊天。已有来源时应用仍经原选择接口的 revision 校验，无来源时仅设置窗口内的新会话草稿，发送前不创建会话或目录。编辑保存与应用分开结算；保存成功、应用失败保留原 ID 供重试。新角色沿用对话现有能力并可补充配套技能；旧配置已有的能力限制继续保留，不能通过简化表单扩大权限。

配套 Skill 的最后读取结果由实际执行文件读取的同一 Provider 观测，生命周期随主 Agent 的作用域，不额外持久化或创建全局健康注册表。读取失败可向界面显示“上次加载失败，可重试”；取消不算文件损坏，后续真实读取成功清除提示。候选目录保留以允许重试；冷查询没有已存在的观测就不伪造结果，也不启动 Agent 或预加载所有正文。有效角色只消费原生日志已提交的人工输入，准备中的请求快照不能提前成为“已生效”事实。

## 2026-11-01 已批准：输出额度与有界截断恢复

模型服务元数据或用户明确关联的能力目录持有已知输出容量；用户调用配置持有显式额度，未知容量保留 DSH 的 32768 兜底且不宣称它是服务实际上限。已知容量通过原生 Provider 配置与 Pi adapter 的动态上下文 fitting 传递，显式额度超过已知容量时在请求前明确拒绝，未知兜底不阻止用户显式指定更高额度。适配器的最终 fit 与原始 stop/usage 是预算和截断事实，模型自然语言不参与裁决；诊断只记录额度、来源、上下文和计数，不记录密钥或请求正文。

通用提供商沿既有配置读写保存 `outputBudgets[精确模型名]`，对应 `maxTokens:模型名` 字段；留空删除默认额度，保留模型、思考档位及独立容量。锁定适配器兼容边界的可选 `models[].requestMaxTokens` 仅提供原生 `modelInfo.defaultMaxTokens`，不改 `model.maxTokens` 容量；原生 prepareCall/header 为该默认值标记来源，后续清除和冷恢复由原生 requestProposal 正确撤下。实际调用和子 Agent 自身明确的 maxTokens 优先于默认值；不新增历史注入账本或改变连接身份。输出偏好修改沿 `model-output-budget` 配置变更通知，仅刷新后续配置，不失效无关会话已有许可；正在使用该提供商的会话仍受原有编辑保护。连接探测晚提交时保留当前已提交的输出偏好，避免覆盖其他窗口的设置。目录补全逐属性进行，不能因为已有上下文容量就漏掉输出容量。

Harness 保持唯一循环、工具执行、取消、持久化和完成权威。主生成在确有原始输出用量时，把服务 length 分类为 `OUTPUT_TRUNCATED`（提前终止）或 `OUTPUT_LIMIT_REACHED`（单次额度耗尽），交给原生 `agent/request-error`。前者仅在原生压缩确实改善最终 fit 后补试，后者在额度完整可用时按相同额度请求较小步骤；两条路径共享每原生 step 至多一次、每用户 turn 累计至多两次恢复，沿用原生步骤身份，不按模型汇报文字清零。原生压缩另行去重同一步失败或无改善的摘要尝试，不授予额外生成次数；普通网络重试继续由 DSH normal 策略独立负责。缺少用量或 Responses 明确不发送额度时分类为 `OUTPUT_LENGTH_STOP`，保留原始 length 和未知用量，不自动补试；未发送的预算不作为实际请求额度展示。输出受限终止后的 Agent 消息保留在原生 inbox，运行准入阶段在 turn/start 前阻止它们单独唤醒父任务；有明确后续用户输入时放行。摘要 purpose 保留独立的完整摘要预算、检查点事务与原失败回执。

原生 `assistant/attempt` 留下失败草稿，工具不执行且草稿不进入下一次模型历史；兼容展示保留并标记未采用片段。恢复次数通过原生可忽略的 `plugin:codebuddy/output-recovery` 记录和 host-only projection 折叠，不另建任务日志或恢复调度器。v2 记录保存原生 turn、step 和本次输入累计次数；投影版本变更通过原生历史重放恢复，fork 的继承前缀不消耗子会话额度。原生 turn/start 只清步骤状态；第一步实际接纳结构化 user 输入、独立 schedule 触发或来自 header.parentSession 的父指令时，才更新整轮额度。子回报、结算通知和同一原生 turn 后续步骤的立即插话不清零；不能仅因子回报自动开启另一个原生 turn 而额外获准重试。旧版已消耗一次的输入保留原一次上限，直到接纳上述新输入才使用两次规则；旧会话无记录时保持兼容，打开历史不发送请求。停止优先，恢复通知后的取消仍阻止下一次 HTTP；重载不补发。用户手动发送或点击已有发送链路上的“继续尝试”按上述新输入边界取得额度，不改写旧记录。

满额度补试的较小步骤指令通过注册的原生 `systemPrompt.context` 贡献进入实际请求，不使用会被原生工具更新投影过滤的普通 developer 消息。该贡献仅在本次补试待生成期间有效，在 assistant 生成结算或 turn 结束时撤下；下一步由原生运行上下文完整快照明确取代旧快照。旧快照作为历史保留，不删除人工消息或执行回执，也不把历史快照当成仍有效的恢复指令。

终态的可选 `stop_reason` / `output_limit` 是持久展示注解，不能作为完成、工具回执或自动恢复指令。长度耗尽和本地上下文无输出空间分别说明；补试后网络失败保留真正错误，不能假称再次截断。子 Agent 的原生 error code 经既有只读父侧快照传递，不改变原生子任务生命周期。旧客户端忽略可选字段，非法可选详情仅降级相应展示，不阻断旧记录恢复。

## 2026-10-31 已批准：授权范围覆盖与可扩展展示

用户已明确批准按展示的补丁边界应用，并要求完整回归与 CU 验收。实现、自动回归和桌面验收分别记录，不以本表宣称通过。Harness 仍持有执行、审批、取消和审计；现有会话 owner 与工具/连接身份继续持有授权。工作区预设、沙箱外命令、Git 写入、明确逐次确认和安全检查均不扩大。未声明可复用范围的能力保持单次确认，并在审批内容中明确此次许可的有效范围。

受信宿主工厂通过既有 `registerToolSessionApproval` / `registerMcpSessionApproval` 声明范围。新增能力使用 v2 展示描述：id、名称、范围说明，以及可选工具成员和范围明细。工具成员由宿主实际注册表核对，描述文字不决定执行权限，模型输入、外部 MCP 注解和同名工具不能制造类别授权。前端按结构化描述显示新类别，不增加工具名白名单。描述和成员作不可变快照；范围变更和待决审批期间的范围撤换使旧许可失效。

一个宿主能力由多个工具组成时，各成员必须声明相同的完整范围和成员清单，并由实际注册定义共同绑定；缺少成员时只显示逐工具授权。单工具的多种操作继续沿用原绑定。同一 MCP 连接的不同业务类别分别缓存身份，切换类别不撤销其他类别的许可；新增成员或改变某类范围只使对应类别重新确认。类别标识仅标识同一宿主或连接下的明确范围，不按工具名或模型文字猜测分组。

桌面保留 `businessSessionApproval: 1`，另声明 `extensibleBusinessApproval: 1`；旧客户端继续使用原有类别或逐工具许可，不能收到不认识的新类别授权选项。授权不持久化、不跨聊天，也不改变停止、恢复、工具禁用或既有安全检查。新增功能的验收应覆盖首次确认、同范围复用、单次不复用、并发、取消、范围变化、连接重建、跨聊天、旧客户端和无范围声明的回退；不能以“以后自动兼容”为由自动扩大旧许可。

## 2026-10-31 已批准：会话归档的保存性能优化

Harness 继续持有执行历史；transcript journal 继续持有兼容展示投影的逐条耐久记录及重放高水位。归档通过 Store 的内部 `updateSession` 在既有单写队列中只复制目标会话，其他会话复用最后已提交的编码。Store 仍原子替换同一个完整 JSON 文件，提交成功后才发布内存状态与编码缓存；旧完整/按根字段更新继续兼容并失效相关缓存。草稿和返回值不授予外部修改已提交会话的引用。

记录内容、JSON 格式、消息计数、标题、用量、原子高水位与重启重放规则不变。journal 仍在快照提交并同步后清理，失败或进程退出时保留重放来源；不提前回报保存成功，不把缓存当作恢复数据，也不把展示投影变成第二个执行事实 owner。

## 2026-10-30 已批准：仅自动任务迁移到 DSH 原生 Schedule

删除或归档聊天通过官方 `workspace/session-stop` 停止其活动原生提醒；取消归档不会重新创建提醒。修改标题或内容不附加时序变更，保留官方已计算的下次运行时间。

范围以用户最终澄清为准：仅自动任务模块，保留 CodeBuddy 其余前端；暂停与继续采用下方已批准的原生队列扩展，不把删除或改频率称作暂停。新建入口进入一条待发送的聊天草稿，由模型通过官方 `dsh-tool-schedule` 创建；`dsh-schedule` 是唯一的新任务持久化、计时、原始聊天绑定、收件箱投递及历史保留 owner。界面目录、卡片、右栏、侧栏时钟只消费原生记录和精确工具的成功结构化回执；不从模型自述提取任务。管理请求沿用原生生成的 Typert codecs 校验，不重新实现时间规则。

提醒由原生 Host 直接 followup 到原始 Session，不中断、steer 或重新发送一条人工 query。CodeBuddy 仅在投递前准备该聊天已有模型、工具与权限，并为其原生轮次接通现有流式、授权、记录和取消观察通道；已有人工轮次接收提醒时继续使用同一通道。子 Agent 不暴露四个提醒工具。投递记录只确认持久化收件箱交付，不能作为模型完成或外部动作成功的证据。

旧 `runtime/schedules.mjs` 规则和历史保留可查，原生接通时停止旧计时器，并拒绝通过退役入口继续创建或启用旧规则，避免双调度。旧版每次新建会话与原生固定聊天投递不等价，不自动改写绑定或悄悄迁移为另一种执行方式；用户可在聊天中重建所需提醒。旧记录不删除。以下早期任务级模型、表单及两种会话方式说明仅描述旧配置，受本节覆盖。

## 2026-10-30 已批准：自动任务界面与任务级模型设置

自动任务的新会话模型选择继续保存在既有 Recipe.settings.goose_provider/goose_model；可选 goose_thinking_effort 仅覆盖该 Recipe 会话的请求，不修改全局或其他聊天。省略或 null 沿用既有模型默认规则，运行前仍由现有模型能力与协议校验拒绝不支持的档位。当前聊天跟进继续继承该聊天的模型、强度及权限，不能附带 Recipe.settings。界面只显示已配置模型和实际可用档位。

自动任务页也可关闭每次新聊天开关；无当前聊天时，必须由用户从既有聊天列表明确选择跟进目标。界面只调用已有会话列表/元信息接口，不加载历史、不切换当前聊天；提交仍使用原有 targetSessionId，目标有效性与运行校验仍由调度器负责。创建时按任务内容首行或 Recipe 标题自动命名，不再显示名称、来源切换及更多设置；既有 Recipe 链接入口保持兼容。

重复菜单将每天、工作日、每周映射到原有 cron；其他旧周期仍可编辑或保留为自定义表达式。Harness 的 cron 解析和调度仍是时间事实 owner。本批不接入系统通知，不新增通知策略、完成状态或原生调度替代实现。


## 2026-10-30 已批准：原生插话与子 Agent 的控制边界

用户本轮明确要求：停止或重新加载后，本地尚未接纳的输入保留在原会话队列，暂停自动派发，默认折叠为草稿；展开、编辑不表示允许发送，只有再次明确发送才投递。已接纳内容不因停止而从历史抹除，发送结果不明仍保留核对入口，不能自动重试。草稿展示复用现有队列及其会话存储，不新增执行状态或第二份消息持久化。停止后的新请求展示仅用于显式取消收尾，普通回答收尾仍按原队列顺序执行。

立即插话保留原生 `steer` 标记，展示、滚动窗口与文件回执统计将其归入当前执行轮；等待发送的普通输入仍另起一轮。显式停止后的新消息可提前显示本地待发送气泡，但原生取消确认和旧 prompt 请求释放前不得派发；回执不明仍显示核对入口。

原生 `completed` 且最终 assistant 消息确有正文时，兼容层通过已有 Goose `codepro_response_phase` 展示注记发布可选 `answer_message_id`，先写入现有 transcript journal，再通知当前观察者。前端只按此消息身份配对最终回答和已成功的文件回执；该注记不开放新 prompt、不改变运行状态、不认证业务完成，也不替代后续持久化的宿主 terminal。旧注记省略该字段时保留原有边界语义，旧客户端忽略可选字段并继续依赖 terminal。子会话 `max-tokens` 只显示达到输出上限，不解释为上下文窗口已满。

聊天普通发送在忙碌时仍进入现有本地待发送队列，等待当前请求及其所属子 Agent 收尾后才开始下一轮。现有“立即发送”按钮通过 `onSteerQueuedMessage`、ACP steer 和 Harness driver 交给 DSH 原生 `next-step` 收件箱；接收回执只证明已接纳，模型在下一步骤读取，不中止当前模型请求、工具或子 Agent。发送失败保留待处理消息，回执不明保留核对状态，不自动转换成取消再发送。

主 Agent 判断提醒与各子任务的关系，需要时通过已有原生 `send_message` 转告；UI 和兼容层不广播用户自由文本，不替模型重新解释任务。普通发送与插话都不改变子任务生命周期。显式停止仍由当前请求 owner 调用现有取消链路，停止该请求及其所属后代和后台作业，保留会话历史；不扩大到其他聊天或独立任务。DSH 继续持有收件箱、步骤接纳、子 Agent 状态及执行事实，桌面只消费回执和显示状态，不引入第二套执行控制协议。

## 2026-10-29 已批准：自动任务的两种会话方式

`runtime/schedules.mjs` 继续持有唯一的自动任务时间调度、暂停、运行记录和持久化配置；日期计算复用锁定 DSH schedule 的现有助手，不加载第二个调度器。任务增加可选 `executionMode` 和 `targetSessionId`，旧数据缺省为 `new_session`。`new_session` 每次通过现有 CodeBuddy `session/new` 创建会话；`current_session` 绑定用户明确选择的当前聊天，通过同一 `Compat.prompt` 和 Harness driver 执行，消费该聊天的实时模型、权限、工具及历史，不覆盖它们，也不改变普通聊天分类。

兼容层提供会话存在、只读、归档及活动状态；调度器据此校验绑定并跳过忙碌聊天的本次自动触发，不抢占手动执行。同一聊天已有调度尝试时也不再启动另一份。跟进 runner 仅取消自己登记的 turn，不能因任务停止而取消随后进入的手动 turn。删除聊天先暂停绑定任务并撤销已测试状态；删除新会话模式的某次结果不删除自动任务。重启后的中断及错过次数沿用现有规则，不重放。运行结束只消费结构化结果，不从模型文字判断成功。

桌面移除常用任务导航入口；旧 Recipe 数据、链接和定时任务快照继续兼容。创建自动任务默认直接填写指令，默认每次新会话；只有确有当前聊天时才能选择跟进。跟进只接受任务指令，模型与工具配置仍归聊天自身所有。测试执行仍使用隔离数据；源码、自动回归与真实桌面验收分别记录。


# CodePro 事实权威与模块职责

## 2026-10-29 已批准：外部源码链接的单次只读预览

同日用户批准统一模型选择入口：聊天输入框中显式选择模型成功后，通过现有 ModelAndProviderContext 同步保存当前会话选择与新会话默认选择；打开旧会话本身不重写默认值。设置页移除独立的当前模型切换卡片。默认提供商不是“正在执行”的事实，前端不再据此阻止删除连接；删除仍须用户确认，运行时 checkProviderMutation 保留对活跃主会话、识图、审查等实际使用的保护。删除默认连接时由现有 runtime 清空默认值，前端刷新默认状态；历史会话不自动改写为其他模型。

同日用户追加批准：点击会话中的外部源码链接直接在右侧只读预览，取消二次确认框。Electron 主进程仍校验真实路径、常规文件、大小和文本类型，读取期间路径、会话或窗口变化则拒绝。renderer 只接收本次只读内容，以会话作用域内的临时标签显示，不生成编辑、保存或执行入口。预览不扩大工作区根目录，不授权 Harness 或模型读取该文件，不持久化目录许可；工作区内文件以及原有写入、终端、媒体和脚本打开路径保持原权限边界。

用户最终批准：左键右侧预览并定位行号；Ctrl/Meta 左键将源码交给全局默认代码编辑器，媒体和普通文档继续使用系统默认应用。首次使用或已选编辑器失效时，Electron 主进程检测常见安装目录及 PATH，弹出选择菜单；取消或无编辑器时返回右侧预览。用户可在右键“打开方式”中更换默认代码编辑器。主进程经显式选择及启动成功后，通过现有 settings.json 的 defaultCodeEditor 保存程序路径、显示名及有限的行号参数类型；通用 renderer set-setting 不接受此键。旧设置缺失时默认为 null，不迁移或修改 Windows 文件关联。启动前校验当前窗口、会话、目标文件及程序路径；不使用 vscode://、命令拼接或 shell。源码启动使用选定程序及参数数组，支持的编辑器携带行号，普通文档仅传真实路径。原有外部目录枚举、Agent 读取、文件原路径保存边界不变；编辑器偏好不授予模型外部文件权限。参考官方 https://learn.chatgpt.com/docs/app/windows 的 Preferred editor：只采用明确选择默认编辑器的行为，不新增项目级覆盖，不宣称复制 Codex 内部实现。

## 2026-10-28 已批准：媒体业务展示元数据

主 Agent 在原生图片/视频生成请求中给出可选 `display_name`，表示用户可识别的业务名称。`comfyui-tool.mjs` 校验、保存并经原任务回执与 `/jobs` 发布；无效或缺失名称只降级展示，不阻断生成。名称不进入执行输入、权限范围、幂等参数比较或完成判断，重试保留已存名称。旧记录无需迁移，前端不从思考、编号、文件名或提示词片段另造业务名称。

提交期间可展示该次 `generate` 请求的显式名称；任务关联仍须已有真实回执，随后优先使用 owner 确认的名称。回执缺少可选名称时可保留原提交名称，不能用 `status`/`cancel` 请求改名。用户确认本批只修新任务，旧会话不补名，不增加后台命名或历史迁移。

同一 owner 在现有错误分支发布可选 `failure_info` 或临时 `observation_error_info`，区分提交、远端执行、状态查询、结果获取、校验和保存阶段。该元数据只解释既有状态或观察异常，不改变 throw/return、取消、重试与状态转换。没有稳定错误码时不从错误文字推断共同根因；原始回执完整保留。

聊天只对已确认采用该合同的原生工具，按会话、媒体种类和任务 ID 聚合多次调用。状态继续由原生任务 owner 确认；工具调用成功及 Agent 结束均不表示生成完成。普通工具与未经适配的外部 MCP 保留原展示和执行语义，思考留在原过程位置。产物仍通过现有工作区文件能力打开，不按业务名改路径。

## 2026-10-27 已批准：业务能力的会话授权

电脑操作、图片生成和视频生成分别申请会话授权，不隐含彼此权限。受信工厂声明业务范围；内置电脑操作只绑定已校验的固定 MCP 驱动、连接及已登记工具定义，远端注解、同名自定义 MCP 和模型文字不能制造业务授权。当前电脑操作范围为桌面读取及鼠标键盘能力，不承诺按应用隔离或只读；不升级或替换驱动。媒体沿用现有服务、工作区、会话和任务记录绑定，不扩展文件访问、输出目录或取消范围。

Harness 继续持有执行策略、审批请求、取消和审计。兼容层复用现有 owner 与工具身份授权存储，只有明确支持业务范围展示的客户端才能申请业务授权；旧客户端保留逐工具选择。每次调用仍先经过启用状态、明确禁止、逐次确认和安全检查；会话许可不能越过它们。同业务并发请求共享待决选择，允许一次仍只批准当前调用；工具重连、定义或范围配置变化，以及原生会话 owner 释放或进程重启使相关许可失效。renderer 只展示宿主提供的准确范围和返回选择，不保存执行授权。撤销后续访问不表示已经派发的输入被撤回，未知结果仍由原执行回执与后续观察核对。

繁體：三種業務分別取得明示會話許可，沿用 Host 身分與既有安全檢查；舊客戶端仍逐工具詢問，不更換驅動、不承諾應用隔離。English: Computer use, image generation and video generation have independent explicit session grants. Trusted factories and live definitions own scope; Harness retains execution policy and approval audit. Older clients keep per-tool grants, and existing safety checks remain authoritative. No driver upgrade or app-isolation claim is introduced.
## 2026-10-30 已批准：素材删除、分组与容量

本节扩展 2026-10-29 素材库的只读范围：用户已批准通过素材库主动删除选中素材。生成工具仍唯一写入生成任务回执；`runtime/media-library.mjs` 根据会话和回执解析素材 ID，只删除生成目录内经过逐级普通路径检查的文件，不接受客户端文件路径，不递归删除目录或改写生成回执。成功删除或已缺失的输出将其稳定 ID 写入现有 store 的 `mediaLibraryDeleted` 根字段，由素材库独占写入；后续投影排除该 ID。删除仅由显式确认请求触发，逐项返回真实结果，失败项不标记成功；持久化失败可安全重试。

容量来自当前可访问文件的逻辑字节数，同一路径去重、缺失文件不计入；不声称文件系统实际分配空间或生成目录全部占用。全库容量、筛选结果容量、工作区筛选结果容量均在分页前计算。时间视图全局从新到旧；工作区视图按目录分组、区内从新到旧，游标与视图保持一致。桌面消费统计与回执，确认框列出待删除文件，不从模型文字推断删除授权。

素材全选通过列表的可选 `all: true` 查询取得全部匹配项，分页不决定选择范围；删除仍以逐项真实 ID、显式确认和单请求最多 500 项为边界。容量来自每次查询的文件元数据，回执解析缓存只用于性能，不成为持久事实来源。工作区显示名称继续由 `projectAliases` 持有，素材库只消费并监听名称更新。

## 2026-10-29 已批准：自定义智能体与工作区角色

`runtime/agent-profiles.mjs` 持有角色模板校验、版本及工作区绑定快照，存于现有 store 的 `agentProfiles`、`agentWorkspaces`；不保存模型或 MCP 凭据。创建工作区复用 WorkspaceService 租约，新的同目录及子目录会话从规范路径绑定继承角色，模板编辑或删除不改变既有快照。兼容层持有会话投影、固定模型、人设和服务选择，不接受客户端替换角色快照；普通工作区保持原行为。角色能力取配置与全局可用能力的交集，不能提升原有审批或沙箱权限。

Harness 官方包保持不变。宿主 `runtime/harness/agent-policy.mjs` 继承公开 SkillRegistry 接口过滤 list/snapshot/get，宿主适配器通过原生 scoped toolFilter 与 monotonic guard 约束工具执行；原生子智能体继承同一宿主能力配置。延迟工具发现只展示已准入能力。角色提示词约束模型表达，但不作为授权、完成或执行事实；角色 Skill 清单不是文件访问隔离。桌面只编辑模板、请求创建及展示角色摘要；语音本期不实现。

## 2026-10-29 已批准：跨会话素材库

图像与视频工具继续持有生成任务回执和作品发布，文件仍位于对应会话工作区。`media-library.mjs` 只读聚合当前产品会话（含归档会话）的完成回执，按类型、工作目录和文本筛选并分页；不调用 ComfyUI、不刷新任务、不创建第二份持久索引。桌面素材库消费该投影，文件预览和打开位置复用现有工作区访问边界。缺失文件显示不可用，损坏或越界记录不授予文件访问；已删除会话或已清除回执不能仅凭散落文件重建来源。读取列表不改变执行、审批或完成状态。

## 2026-10-29 已批准：Inno 历史目录、进程检查与可选数据清理

Inno 使用同一 AppId 的安装记录恢复默认程序目录；不承担 Squirrel 安装迁移。安装和卸载通过只读进程检查要求用户退出 CodeBuddy 及当前安装目录内的后台进程，检查失败停止，不强制结束任务。

交互式卸载窗口持有本次“清理个人数据”的选择，默认关闭；静默卸载始终保留数据。数据位置仍由既有 storage-management 定位规则持有。用户确认后、Inno 删除程序前，随包 `windows-uninstall.cjs` 取得原生 profile 锁、校验位置及文件身份，只清理已知数据子目录，保留工作区、已登记项目、其他根目录文件和历史数据。锁文件及诊断报告可保留；链接、损坏元数据、活动会话或身份变化阻止清理，IO 失败可能部分清理并中止程序卸载。此操作不暴露为 Agent/MCP 工具，不改变 Harness 任务状态或 Mac 卸载规则。实现与原生安装验收分别记录。
## 2026-10-27 已批准：共享技能发现与启用

`runtime/harness/skill-catalog.mjs` 统一提供文件系统技能发现、真实路径去重、同名优先级及诊断；Harness 注册表消费可调用候选，Library 消费同一目录快照展示待启用、已启用和被覆盖的来源。保留原有 Harness 根目录顺序，用户共享 `~/.agents/skills` 排在应用自有目录之后。已有应用技能不迁移、不复制；旧客户端缺少新增字段仍可展示基础信息。

共享技能默认仅出现在工具箱。用户通过现有技能管理确认通道启用后，选择持久化在当前 profile 的 `backend/harness/shared-skills.json`，键为真实文件路径；其他应用的技能文件保持原样。启用只允许加载该技能说明，工具执行继续由 Harness 权限与沙箱处理。禁用阻止后续加载，不追溯删除已有会话消息。目录、文件元数据和策略变化使缓存失效；工具箱打开/重新获得焦点、发送下一轮及加载技能时核对目录。未知或损坏文档报告诊断，不把安装成功表述为实际调用已通过。

繁體：共用技能目錄由同一個 catalog 提供給工具箱與 Harness。共用技能預設待啟用，確認後將選擇儲存在目前 profile；不修改來源檔案。真實路徑去重、同名優先序、變更失效及診斷由 catalog 負責，執行權限仍屬 Harness。

English: One filesystem catalog supplies toolbox inventory and Harness candidates. Shared skills start pending consent; profile-local invocation choices never modify shared source files. The catalog owns canonical-path deduplication, precedence, invalidation and diagnostics. Harness remains authoritative for execution and permissions. Existing conversation messages are not retroactively erased by disabling a skill.

## 2026-10-27 已批准：公开网页读取会话授权与真实工具发现

本节覆盖下文网页读取的 origin 范围。原生 `web_fetch` 按根 Agent、实际工具定义及 Web 服务身份共享“本会话允许网页读取”；仅适用匿名公开 HTTP(S) 读取。Compat 仍持有内存授权，Harness 仍负责执行，ACP 使用 `authorizationGroup: web_read` 和 `permissionClass: read_only` 展示范围。保留单次允许、拒绝、明确禁止和逐次询问。重启、根会话销毁、对应能力失效或同名实现替换不继承授权；旧源站审批历史仍按原范围显示。原生公网地址、DNS、重定向、凭据、超时和大小限制不变。

扩展已有 `available_tools` 选择传入同一 MCP 注册层，按服务端原始工具名过滤，再与角色过滤相交；空选择保留既有全量语义。断线期间注销工具，重连后由注册层恢复清单，不重放动作。模型发现和界面都消费真实注册表。查找可用工具作为可见只读动作展示；相邻思考仅在界面合并，不修改原生会话、模型请求和工具边界。

繁體：原生公開網頁讀取共用根對話的明確授權，保留單次允許、拒絕與原有網路限制。工具清單遵循擴充功能既有選擇與連線狀態。介面顯示工具查找並合併相鄰思考，執行與記錄仍由 Harness 持有。

English: Explicit public web-reading consent is bound to the root agent and native implementation/service identity, with once, reject, explicit rules and network restrictions preserved. Existing tool selections filter the actual MCP registry; disconnected tools are removed until recovery without replay. Discovery becomes visible, and adjacent reasoning is combined only in presentation. Harness retains execution and history authority; Compat retains in-memory grants. Legacy origin cards retain their original scope.

## 2026-10-27 已批准：统一 MCP 会话授权与局部失效

本节扩展下方电脑控制方案。内置和用户自建 HTTP/stdio MCP 均以真实连接、当前工具清单为授权单元，共享该模块工具及资源访问的会话授权。界面显示“本会话允许使用〈模块名〉”，保留单次允许和拒绝。Harness MCP 适配层创建 `mcp_module` 身份，提供配置来源的 `authorizationModule` 名称；Compat 持有原有内存授权，桌面只消费结构化范围。不同模块、聊天及重启后不继承授权，破坏性工具、明确禁止、逐次询问和安全检查仍优先。无关提示词或扩展设置不清空授权；修改、停用对应扩展时立即撤销该模块身份，晚到答复作废。现有连接组合确实被重建时仍按重连重新确认。

宿主内置能力沿用各工厂既定范围（浏览器、图像、视频、桌面宠物、项目记忆），网页读取仍限当前源站，不把整个开发者工具组作为可复用权限。旧审批卡片保持原范围；无结构化模块标记时不推断整组授权。

繁體：內建及自訂 HTTP/stdio MCP 以目前連線與工具清單共用模組會話授權，涵蓋工具與資源存取。保留單次允許、拒絕與個別規則。無關設定保留授權；修改或停用該擴充時撤銷其身分及待答覆，重連、清單變更與重啟後重新確認。宿主能力和匿名網站讀取沿用原有範圍，介面只顯示結構化授權。

English: Built-in and custom HTTP/stdio MCP tools and resources share explicit session consent bound to the live module and current catalog. Allow-once, reject and individual rules remain authoritative. Unrelated settings preserve grants; changing or disabling the affected extension revokes its identity and pending answers. Reconnects, catalog changes and restarts require new consent. Host capabilities and anonymous web reads retain their existing tool/origin boundaries. The renderer only presents structured permission metadata.

## 2026-10-27 已批准：电脑控制按模块授予本会话权限

用户选择“本会话允许电脑控制”后，当前聊天及其所属子 Agent 复用当前电脑控制模块全部可复用工具的授权。“仅此次允许”仍只覆盖当前调用。Harness MCP 连接适配层持有真实注册定义、连接代次及工具清单身份；`qwen_computer` 的整组身份只由该层建立，不能由模型参数、工具名字前缀、远端注解或界面文案创建。Compat 继续使用既有会话授权缓存与 ACP 审批答复；桌面消费结构化 `authorizationGroup: computer_control` 展示授权范围，不另存权限事实。

授权仅在内存中存活，不写全局规则、不扩展到其他聊天或模块。连接替换、重连、清单增加/删除/定义变化或会话身份释放后失效；相同清单刷新保留。明确禁止、逐次询问规则及安全检查优先于整组授权，标记为破坏性的工具不进入可复用授权。旧审批卡片缺少整组标记时继续显示单工具范围。Harness 的执行、取消和完成权威不变。

繁體：使用者選擇「本會話允許電腦控制」後，同一聊天及其所屬子 Agent 共用目前模組的可重用工具授權；僅此次允許仍只涵蓋當次呼叫。MCP 適配層持有連線與清單身分，Compat 沿用現有記憶體授權與 ACP 答覆，介面只顯示結構化範圍。重啟、重連、清單或會話身分變更後重新確認；明確禁止、逐次詢問與安全檢查優先，其他模組與舊卡片不擴權。

English: An explicit “Allow computer control for this session” choice covers reusable tools in the current module for that conversation and its owned agents. Allow-once remains call-specific. The MCP adapter owns live connection, registered definition and catalog identities; Compat reuses the existing in-memory grant and ACP reply, while the UI only renders structured scope. Restart, reconnection, catalog changes and released session identities invalidate the grant. Explicit deny, ask-before and safety checks take precedence; destructive tools, other modules and legacy cards do not inherit broader authority.

## 2026-10-27 已批准：新任务草稿跨重启保存

2026-11-02 更新：设置页、新任务及已有对话共用本机配置 gooseMode。用户显式选择后，Compat 将预设应用到已打开和后续加载的可执行根会话。Harness 负责实际执行权限，逐工具授权仍按原范围保存。

繁體：設定、新任務及既有對話共用本機 gooseMode。明確選擇後套用到目前及後續載入的可執行根會話。Harness 裁決實際權限，個別工具授權維持原範圍。

English: Settings, new tasks and existing chats share this device's gooseMode preference. An explicit choice applies to open and subsequently loaded executable root sessions. Harness enforces the effective preset and tool grants retain their scope.

用户批准将新任务文字、目录及附件保存到本地并在重启后恢复。Electron `drafts/DraftStore` 持有按窗口槽位和聊天模式隔离的草稿文件及附件副本；renderer 仅缓存已恢复内容、提交字段更新并显示保存错误，不以草稿恢复启动任务。普通/CodePro 会话创建成功回执触发草稿清空，失败保留；已发送历史引用的附件副本继续存在。正常退出等待已接收的草稿写入。该缓存不更改 Harness 的任务、会话、权限或完成权威。最近目录文件继续由 `utils/recentDirs` 写入，原生菜单订阅保存通知刷新。

繁體：Electron 擁有按視窗與模式隔離的本機草稿及附件副本，介面恢復草稿不啟動任務；會話建立成功清空草稿，失敗保留，正常結束等待寫入。最近目錄儲存後通知原生選單刷新。Harness 執行權責不變。

English: Electron owns local draft files and attachment snapshots isolated by window slot and chat mode. Hydration never launches a task. Session creation acceptance clears the draft; rejection retains it, and normal exit drains admitted writes. Sent-history attachment copies remain valid. Recent-directory persistence notifies the native menu. Harness execution authority is unchanged.

## 2026-10-26 已批准：桌面更新与确认后停止任务

Electron 主进程的 `update/` 持有更新频道、GitHub Release 与文件身份、下载状态和安装调度。用户自己的 GitHub CLI 登录提供瞬时凭据；不使用 GitHub MCP 凭据、不复制到设置或安装包，不向 renderer 或 CDN 转发 Token。renderer 只发起检查、下载、取消和确认安装，消费主进程状态。Windows Inno 负责安装目录中的程序更新，Mac Squirrel.Mac 负责签名应用替换；更新器不迁移、清空聊天、配置、工作区或凭据。

Harness 仍持有任务与持久化权威。下载不要求任务空闲；桌面明确提示重启会停止对话和自动任务、关闭终端，并保留已保存的数据。选择“稍后”不停止工作。用户确认后，运行服务阻止新请求及调度，调用原生取消、等待任务和已接收的设置请求收尾，再 flush/close；桌面收到保存确认及正常退出后才交给安装器。停止或保存失败不启动安装，也不以超时强制终止代替保存成功。原有未确认调用仍使用空闲检查。被中断的工作不由更新器自动续跑，调度后续运行继续遵循原有配置。桌面阻止新终端，已有终端按应用退出生命周期关闭。安装成功后由新版启动确认实际版本。正式频道不接收预发布，源码预览不执行安装。

繁體：下載不受執行中的工作阻擋。使用者確認中斷後，Harness 封鎖新工作與排程、取消執行、等待已接收請求並儲存關閉；停止或儲存失敗不安裝。稍後更新不停止工作，中斷工作不自動續跑，後續排程仍依原設定。Electron 管理確認、終端與更新；Inno 與 Squirrel.Mac 負責程式升級，不變更聊天、設定或工作區。

English: Electron owns release selection, transient CLI credentials, downloads, confirmation and installation. Downloading does not require idle tasks. After explicit interruption consent, Harness fences new work and schedules, cancels tasks, drains admitted requests and flushes before acknowledging shutdown. Installation requires that acknowledgement and a clean exit, never a timeout or forced kill. Choosing Later does not stop work. Interrupted attempts are not resumed by the updater; future scheduled runs follow existing settings. Inno and Squirrel.Mac replace application files without deleting conversations, configuration, credentials or workspaces. The renderer receives state, never tokens.

## 2026-10-23 已批准：子 Agent 完整只读会话展示

DSH alpha2 的原生会话日志、父子 catalog 和 session controller 持有子会话身份、历史与实时 assistant stream。CodeBuddy 只通过原生 `subagent` 地址的 `follow` 观察已验证的父子关系，不使用普通 session 地址激活子 Agent，不改变调度、停止、恢复、审批与完成语义。兼容层按连接管理只读观察订阅；断开或关闭面板只取消观察，不取消子任务。切换或 fork 后旧根地址失效，不能向新聊天发布旧子会话内容。

桌面复用主聊天的消息、Markdown、思考和工具回执渲染。公开委派、思考、文字和文件差异完整呈现；事件分页仍限制批次数量与通常体积，单个较大的原生事件保持完整。provider/replay 状态、认证信息、系统及注入上下文不进入展示。观察数据仅用于展示，不能作为工具执行、授权或完成判断。断线后只读重连以原生快照替换展示，不重放模型或工具动作。

工具输入准备态复用锁定 DSH 的 `PartialArguments`，只投影调用身份、工具名、完整且解码有效的路径和已接收内容大小。大小按解码后UTF-16长度换算KB，是生成进度而非落盘字节数。主聊天通过已有临时 execution_activity 通道接收，子级通过只读 follow 接收；均不写入聊天历史、不计为实际修改或审批。原生 `tool/call` 才发布调用展示，block-end 不代表执行；停止、失败、重试或失去当前会话身份会清除准备态。正文中的路径和修复后的部分JSON不得充当真实参数。

桌面 locale 作为可选的当前语言提示随 prompt 传入，兼容层只传递规范化语言代码，原生 scoped system prompt 为主子 Agent 设置默认回复及委派语言。用户明确要求其他语言仍优先；历史记录、代码和原始工具输出不翻译，模型实际遵循情况需单独验收。此提示不持有执行状态或权限，也不替换现有持久化设置。

繁體：子會話使用原生唯讀 follow，關閉僅停止觀察；完整顯示公開記錄，權限與執行仍由 Harness 持有。English: Native read-only child follow owns synchronization; closing a viewer never stops or resumes execution, and display projections cannot authorize actions.
## 2026-10-26 已批准：GitHub 默认连接与简化入口

本节补充并覆盖下方 2026-10-23 的入口限制：首次配置默认启用官方 GitHub，已有本人 CLI 登录时自动调用同一凭据验证与加密保存流程；保留已有连接、自定义地址和明确停用选择。设置和工具箱共用简洁账号连接界面；代码仓库卡片展示在技能的内置技能区，展示分组不改变底层工具身份、配置或执行权威。未登录仍需用户完成自己的 GitHub 授权，安装包不包含共享 Token。并发连接合并为同一在途操作。

繁體：首次設定預設啟用官方 GitHub，已有本人 CLI 登入時沿用同一驗證流程自動連線；保留既有連線、自訂位址與停用選擇。儲存庫卡片位於內建技能區，分組不改變工具身分與執行權責，安裝包不含共用 Token。

English: Fresh configuration enables official GitHub and reuses the user's existing CLI login through the same verified encrypted-credential flow. Existing connections, custom endpoints and explicit opt-outs are retained. The repository card appears under built-in skills; grouping does not change tool identity or execution ownership. Concurrent connection requests share one operation. Packages contain no shared tokens.

### 2026-10-23 原连接协议与所有权（入口由上节覆盖）

用户明确点击“连接 GitHub”后，runtime 核对 GitHub CLI 当前账号，仅对固定官方 MCP 地址验证凭据，验证成功且配置未变化时原子保存加密凭据与启用状态。新登录在浏览器授权完成后继续同一次连接流程；打开页面和检查状态不复制凭据。CLI/系统凭据库继续持有登录凭据，CodeBuddy store 持有独立加密副本；退出 CLI 不删除该副本。凭据不返回界面、不进入诊断或日志，失败不覆盖已有配置。安装包不携带此凭据。

工具箱与账号设置复用“代码仓库”连接界面，仅在显示层合并本地 Git 与官方 GitHub。原配置身份、执行职责和会话选择不变；两个启用开关分别影响新任务默认配置，已有聊天保留其选择。旧详情链接转入统一界面，自定义远端地址仍保留独立配置。启用状态不等于 Git 命令已验证成功。

繁體：工具箱與帳號設定共用「程式碼儲存庫」介面；新登入在明確授權後繼續驗證 GitHub。保留原設定身分與執行權責，啟用開關只變更新任務預設，既有聊天選擇不變；自訂遠端不併入官方連線。

English: Toolbox and account settings share Code repositories controls. An explicitly started sign-in continues into GitHub verification. Grouping changes presentation only; configuration identities and execution owners remain unchanged. Toggles affect new-task defaults, existing chats retain their selection, and custom endpoints retain separate controls. Enabled does not imply verified Git command execution.

繁體：明確連線 GitHub MCP 時，核對 CLI 帳號與固定官方位址，驗證成功且設定未變才儲存獨立加密副本；登出 CLI 不刪除此副本，憑據不回傳介面、不納入安裝包。

English: Explicit GitHub MCP connection verifies the current CLI account and fixed official endpoint before atomically saving a separate encrypted credential copy. CLI logout leaves that copy unchanged. Credentials never reach the renderer, diagnostics, logs, or distribution packages. Harness retains execution and terminal-state authority.

## 2026-10-22 已批准：双入口浏览器控制

Harness 继续持有工具发现、审批、执行与完成判断。browser_control 经现有 ACP 请求连接到 Electron 工作台；Electron 持有当前窗口、会话、真实工作区路径和 WebContentsView 身份，只接受有限操作，不暴露全局调试端口。页面观察与输入回执分别返回；派发成功不等于页面行为已成功。后台会话的浏览器标签由现有工作台状态保存，不能转移到另一会话。

2026-11-17 电脑控制方案内的可选观察扩展：BrowserController 持有观察 ID、分页候选及节点语义，调用者只能引用当次兼容候选；导航、重新观察或派发使旧候选失效。原生 appSnapshot 持有字段候选，结构化字段复用现有 field token 与 set_value 校验，不新增执行者。主模型继续判断，CUA 只提供识图证据；候选不是授权或完成事实。旧节点调用与旧结果消费者保持兼容，不迁移持久化状态。

Windows 默认观察使用控件视图；原生快照输出 `desktop_observation.view=fields`，MCP 桥仅消费该观察方式，将控件文本交给主模型，原始截图留在回执。没有输入框不等于必须识图；主模型在控件证据不足时显式请求 `full`。旧客户端需要完整视觉观察时显式指定 `full`，Mac 默认不变。繁體：觀察方式由原生快照持有，橋接層只消費，原圖保留。English: Native snapshots own the observation mode; the bridge projects control text while preserving the frame. Explicit full observations retain visual inference.

繁體：瀏覽器控制器持有觀察與候選生命週期；原生快照的欄位候選沿用 field token。主模型判斷、CUA 識圖，權限與完成判定不變。English: BrowserController owns observation-bound candidates; native snapshots expose existing field tokens. The main model decides and CUA perceives. Approval and completion ownership are unchanged; legacy callers remain compatible.

独立浏览器与用户浏览器使用锁定版本的 Microsoft Playwright MCP，分别消费隔离配置和官方扩展连接；用户浏览器由用户选择并确认标签页，不复制日常浏览器 profile。工作区 HTML 预览只服务选中文件同目录的公开网页资源，关闭标签或宿主时释放服务。旧配置和历史不迁移；设置中移除“工具与连接”入口不删除用户数据或改变工具箱配置。

繁體：Harness 持有執行與審批；Electron 管理會話內嵌頁面，Playwright MCP 管理獨立或使用者選擇的瀏覽器。English: Harness owns execution and approval; Electron owns embedded session pages and Playwright MCP owns isolated or user-selected browsers.

## 2026-10-22 已批准：Mac 原生卸载与安装界面

Electron 主进程持有原生菜单选择、最终路径确认和退出流程；独立卸载 worker 在主进程与 Harness 服务退出后，重新校验应用身份、目录身份及清理白名单并记录逐项结果。该流程不暴露为 Agent/MCP 工具，不改变 Harness 执行与完成语义。普通卸载只移除当前应用副本；清理模式删除已知应用数据，项目默认保留，应用管理工作区需要单独勾选。外部项目、未知文件、其他安装副本和旧迁移目录保持原样。

数据根继续消费既有 storage-management 位置结果，不恢复存储管理页面或迁移操作。清理专用钥匙串及 TCC 仅发生于用户确认的清理卸载；更新不触发。系统拒绝和残留由真实回执判定，逻辑容量不视为实际磁盘释放量。DMG 布局由打包脚本负责，验收状态另行记录。

繁體：原生選單確認後由卸載 worker 執行，專案預設保留，更新不清理資料。English: Native menu confirmation authorizes a dedicated uninstall worker; projects remain by default and updates never run cleanup.

## 2026-10-21 已批准：子 Agent 停止交接与只读终态上下文

DSH 继续持有子 Agent 生命周期、原生收件箱和 `turn/start`、`turn/end` 事实。CodeBuddy 在取消所属运行后，使用同步的原生 `turn/start` 边界阻止后续取消息，不在已经 claim 的 `pre-step` 阶段假定 `keepInbox` 能恢复消息。当前取消请求自身尚未处理的人工输入，使用原生队列移除接口清理；不删除其他人工排队输入或子 Agent 通知。

根 Agent 空闲且待处理 next-turn 项全部为原生 `subagent-settled` 时，新人工输入通过公开 `steer` 投递。2026-10-22 经用户授权接入补充：适配层使用原生 `agent/pre-step` 将余下原始通知纳入同一人工输入步骤，保留各自 id、source 和完整内容；先由 DSH 记录原生 `user/message`，再通过原生 Inbox 接口移除精确匹配的待处理项，不采用先移除再插入的队列搬移。重启后的核对仍只读取原生日志和原生 Inbox，不持久化第二份待交付或已交付状态。接入仅限当前根执行，混合人工队列保留原生 FIFO，不过滤完成、失败或停止通知，也不修改子 Agent 调度、权限和终态语义。宿主正常关闭仍遵守原生销毁与队列清理语义，不重放已清除通知。恢复及后续模型请求通过原生运行上下文读取本聊天 catalog 和对应子会话的实际末轮边界；缺失终态保持未知，不从 inactive、模型报告或进度文字推断停止或成功。该上下文是只读快照，没有独立状态或完成判定。

审批中的调用参数按原生 Agent ID 和 call ID 共同关联，不能只以模型 call ID 跨会话索引。既有精确工具授权和连接失效规则保留，不把 MCP 开关、远端注解或其他聊天的审批视为授权。

文件卡片与工作台复用同一只读工具回执投影。子级文件操作按原生日志中的人工输入 admission 与 rpcId 划分显示轮次，不用兼容层秒级时间排序，也不把显示归属当作子任务因果或完成事实；无法确定的归属不计入主轮次。只读预加载缓存独立失效，主聊天子树与后台连接不能因切换缓存而重挂。

## 2026-10-21 已批准：alpha2 原生权限预设与审批接线

保留官方 `0.2.1-alpha.2` 依赖与现有桌面，仅调整权限选项及必需接线。DSH 的 `permissionPresets`、`sandboxPolicy`、`approval` 持有当前 Agent 的预设、文件/命令沙箱与审批事实；会话原生日志负责持久化及恢复。ACP `session/set_mode` 调用原生 setter，再发布确认后的 `current_mode_update`。产品聊天 ID 到原生 ID 的转换只在 conversation driver 进行。全局默认只属于新会话的创建输入，不覆盖已保存的原生选择。

选项为 `read-only`、`workspace-write`、`danger-full-access`。旧 `approve/smart_approve/auto/chat` 不能解释成同名原生授权；缺少原生权限记录的旧会话以只读方式初始化，不自动把旧放行扩为原生完全权限。已有原生记录和 fork 继承记录优先，读取不按产品旧字段重设权限。

DSH 子 Agent 保留原生创建时捕获的沙箱范围及非交互 `approval: never`；父级后续切换不广播覆盖已有子级。这一条覆盖 2026-10-17、2026-10-18 章节的“子级实时消费根会话旧三态”约定。适配层不再按旧模式拒绝子级，也不把原生拒绝改写成产品成功。

CodeBuddy 继续持有连接鉴权、凭据保护、工具启用与明确禁用、可信工具定义及已有显式授权绑定。`tools/pre-execute` 仅把这些边界和用户启用的安全检查编译为原生 allow/deny/ask；需要 Agent 审批时交给 DSH 的请求、非交互拒绝、取消和审计，现有 ACP 表单仅提供答复。远端 MCP 注解不自动授予权限，非沙箱能力不能因移除旧审批模式而静默放开。原生 `tools/execute` 只为既有审计提供派发观测，不代表实际副作用成功。

直接 UI 操作没有模型 turn，沿用原有的显式用户确认和原生 maintenance/工具执行；不伪造原生 Agent 审批审计，也不把一次 UI 确认写成模型长期权限。原生 Windows 沙箱的已知兼容问题本轮仅记录，不修补官方包；实施和实际验收结果另行记录。
## 2026-10-21 用户修订：移除存储管理

设置中的存储管理页面、导航、手动缓存清理、空间统计和迁移 IPC 及 worker 已移除。runtime/storage-management.cjs 只保留已有数据位置和旧迁移记录的兼容读取与启动占用检查；安装器不选择、迁移或覆盖数据位置。默认 ~/.CodeBuddy，已保存位置优先，不因功能移除重置或删除数据。Harness 继续拥有会话、执行和任务状态；既有 Electron 自动缓存维护不变。

繁體：儲存管理入口與操作已移除，保留既有資料位置相容讀取，不刪除資料。English: Storage management actions are removed; existing data locations remain compatible and no user data is deleted.

## 2026-11-19 已批准：模型思考能力读取与切换

Provider 发现层仍为能力唯一 owner；模型切换通过 model-settings/read 一次返回当前连接及模型的档位、默认值、来源和未知/不可调状态。UI 不将接口通用 OpenAPI 枚举当作模型能力，也不重新推断档位。模型声明优先；缺少 owned_by 的网关可由 OpenAPI 中明确的聊天模板路由合同识别无生成探测。连接身份缓存与并发去重继续复用，显式重新检测使现有发现缓存失效，不在启动时遍历所有模型。

显式请求 default 表示不覆盖服务端思考参数，与 none 关闭不同。2026-11-19 用户追加批准：模型菜单不再为已确认支持关闭的模型额外显示“服务默认”，以“无”作为最低档；未设置、旧 default 或失效偏好由 model-settings owner 回退为 none，既有有效选择保留。明确不支持思考的模型只显示“无”而不发送控制参数；未知或不能关闭的模型仍保留真实的服务默认语义，不伪造关闭。现有 thinkingEfforts 持久化容器及 Recipe 字段继续复用，不迁移旧记录；Recipe 的显式 default 仍表示省略覆盖。当前正在执行的请求不变。Harness 仍负责序列化，前端只消费结构化结果。回退旧版本前需将使用 default 的 Recipe 改回既有可用档位或清除覆盖。

繁體：Provider 仍是模型能力唯一權威；切換以單次模型快照讀取，快取命中不重複探測。OpenAPI 通用列舉不是模型能力。已確認能關閉的模型以「無」起步，未設定、舊 default 或失效偏好由既有 owner 回退至 none，有效選擇保留。未知或不能關閉的模型不偽造關閉；明確不支援思考的模型只顯示「無」。舊資料不遷移，Recipe 的 default 仍省略覆寫，執行中的請求不變。

English: Provider discovery remains the sole capability owner. Model switching consumes one scoped snapshot and reuses the connection cache. Generic OpenAPI enums are candidates, not model capabilities. For confirmed off-capable models, the existing settings owner resolves unset, old default, or stale preferences to none; valid selections remain. The menu starts at None without an extra service-default slot. Unknown and always-on models do not acquire a fabricated off control; explicitly non-reasoning models display None without sending controls. No stored records are migrated. Recipe default still omits overrides, and active requests retain their snapshots. Older Recipe consumers do not accept the default literal.

## 2026-10-19 已批准：安装版手动配置与模型能力读取

安装版默认使用 `~/.CodeBuddy`，不再重命名或沿用旧 `~/.CodeBuddy-Harness`，也不导入预览版 `.preview-data`。旧目录保持原样；显式数据目录覆盖仍有效，安装版自身的已保存配置在后续启动和升级时保留。预览版继续沿用其现有数据目录。此条覆盖此前自动更名及占用时回退旧目录的规则，不删除或清空任何用户数据。

模型连接由用户在设置中创建，runtime store 持有记录；首次引导只读取配置清单，不再发现、创建内网连接或写入默认模型。保存连接仍实际验证所选聊天模型，成功后关闭配置表单；当前模型由用户在聊天栏通过原有事务选择，不再自动弹出第二个选模窗口。

连接卡片读取已保存的本地清单，不等待远端逐模型能力请求；保存表单在该本地清单刷新后关闭，避免出现仅剩“添加提供商”的假空状态。聊天模型列表按需读取服务清单并过滤已声明的非聊天模型，具体思考与上下文能力继续按现有缓存读取。未选择默认模型是正常状态，设置页显示选择入口；只有非空但不存在的提供商身份才保留未知配置错误。

runtime Provider 适配层消费 Ollama 公开能力，区分聊天与决策、嵌入模型，不按模型名称猜测；本地及云端 Ollama 的模型清单使用 `/api/tags`。未知能力仍可尝试现有聊天协议，已声明不支持 completion 的模型不进入聊天选择或验证请求。此处不新增决策、嵌入执行协议。思考能力允许布尔开关与命名档位混合；失效的可选默认值、旧保存档位不再阻断整组模型读取或被发送到不支持它的模型，读取不改写旧偏好，新的显式选择仍按当前能力校验。认证失败和真实接口失败继续报告，不能因模型列表可读就宣布连接可用。

模型请求、能力读取和切换使用同一套源码逻辑；预览版与安装版只在启动环境、数据目录和交付形态上区别。自动回归、源码桌面验收与安装包验收分别记录，本表不宣布产品通过。

## 2026-10-19 已批准：按模型保存思考强度与能力选项

现有 provider 配置持有 `thinkingEfforts[modelId]`，只保存用户明确选择的档位，不保存思考文本、凭据或会话上下文。模型能力来自既有服务商发现缓存及锁定版 DSH/pi-ai 公开目录；界面与执行器消费同一解析结果。Ollama 兼容接口使用其公开 `reasoning_effort` 控制，其他 Gemma 模板部署保留原有 chat-template 传输。此处覆盖下方将所有 Gemma 部署统一视为模板协议的旧说明，不修改 DSH 安装包。

已确认具备思考能力且没有用户选择的模型默认开启，优先使用模型推荐档位或 medium；旧全局偏好仅在该模型明确支持时作为兼容回退。单模型偏好优先，不把模型 A 的新选择写入模型 B 或全局默认。未知能力使用服务默认，不通过模型回复或是否出现思考文字推断支持情况。原有全局偏好保持可读，不迁移、删除或覆盖。

用户界面的思考卡片只呈现真实可选档位；仅有开关的显示无／开启，只有一个档位时不提供展开箭头。模型切换菜单与当前模型入口复用同一展示组件。保存沿用现有 provider config API 和原子 store 更新；只有明确的思考偏好更新可在运行中保存，当前已准备轮次和已有子 Agent 保留原生配置快照，后续准备轮次使用新偏好。适配层继续将档位交给 DSH 序列化和流解析，不改执行循环、权限或完成语义。

旧原生子会话的冷恢复保留升级前的思考 profile 候选，只在原生记录的完整连接身份精确匹配时使用；不据此切换已有子 Agent 的模型或强度。2026-10-22 已批准补充：若创建时采用默认上下文容量，冷恢复可消费 DSH 原生 `requestContext()` 与子 Agent 固定思考档位，重建该已知 fallback 候选；仍须完整路由精确匹配，当前明确容量较小时拒绝，不持久化第二份恢复状态、不改写原生记录或全局能力。此兼容路径仅用于已有记录，待旧 profile 的子会话全部不再需要恢复后可移除。聊天模型入口直接列出已配置模型，点击后沿用现有会话切换事务；失败保留原选择。Agent 模板模型仍在设置页配置，聊天切换不再写入模板或全部 Agent 默认值。

## 2026-10-18 已批准：默认子 Agent 模板与聊天内职责复用

2026-10-23 已批准补充：通用职责不再提供单独模型设置，新建通用子 Agent 继承主 Agent；旧 `models.generic` 保持可读但不用于新建，保存时归一为空。自定义模板的显式模型、已有子 Agent 的原生记录及冷恢复不受影响。`config.subagentLimits` 只保存用户选择的最大深度和并行数量，缺省仍为 1 和 3；下一轮会话准备将配置交给 DSH 原生 volatile 配置，深度检查、活跃后代计数、拒绝、停止与恢复仍由 DSH 负责，不增加第二套调度或授权。降低上限不取消现有子 Agent。

2026-10-22 已批准补充：`config.subagentTemplates.custom` 保存自定义模板的稳定标识、名称、适用场景、职责说明、可选模型和工具档位；旧的 `version: 1` 模型设置保持可读，不迁移执行记录。简化后的界面只编辑名称、模型和提示词，模型默认继承，适用场景摘要随提示词更新。配置兼容继承、仅阅读与检索、不使用工具三档，界面编辑会保留已有工具限制；后两档复用默认 explorer 的原生允许列表或空允许列表，不代表授权。工具发现沿用现有只读接线，仅返回原生限制后的子级目录；无工具档位也不安装工具发现。

子级装配时通过原生 sessionQuery 与 foldSubagentDescriptor 读取 DSH 已持久化的 toolFilter。宿主工具和会话本地 stdio MCP 在重新注册及目录刷新前消费同一限制，避免作用域内重新注册绕过原生继承过滤。共享远端 MCP 仍由原生作用域过滤，不改写共享目录。此消费规则不增加批准、执行或恢复状态，也不改变普通主聊天的工具配置。

主 Agent 根据模板目录选择通用 `subagent` 工具的精确 `template` 标识，不能同时用 `role` 覆盖该职责。模板职责经公开 persona 参数交给 DSH，本次任务单独经 prompt 传入；模型和工具允许列表仍经公开 agentOptions、toolFilter 传入。DSH 原生描述符持有创建时的实际配置，编辑或删除模板不改变已有实例和冷恢复记录。模板不得存储权限预设、批准结果、子会话标识、历史或凭据；原生停止、恢复、非交互审批和父级限制优先，不修改 alpha2 核心。

全局 `config.subagentTemplates` 仅保存 explorer、browser 和通用职责的默认模型选择（未指定则由 DSH 在创建时继承父 Agent 的实际模型）。设置入口经已有 ACP config API 校验并保存，不存储子会话 id、历史或凭据，也不恢复旧五角色路由。explorer/browser 是两个按需实例化的默认模板，不预启动、不占用并发名额；其他职责经通用 `subagent.role` 声明，仅在当前主聊天中创建和继续。

CodeBuddy 适配层把模板、职责、已配置模型转换成 DSH 公开 `SubagentService.startActivation` 的 persona、toolFilter 与 agentOptions；默认 explorer 收窄原生文件/命令工具，browser 使用当前已启用的浏览器/网页能力。宿主现有权限检查和能力停用边界保持优先。原生描述符持有实际 persona、模型、直系归属和历史，后续使用原生 send_message 继续，冷恢复不重新按新设置改写旧实例。主模型负责按语义选择职责与是否复用；不通过名称、关键词或月份作第二次宿主业务裁决。

相同模板在不同主聊天中创建独立原生子会话，配置可共用，聊天历史不共享。浏览器 cookie、标签页与账号资源的隔离不由聊天上下文隔离推导。活跃轮次沿用本轮已准备的模型配置，下一轮准备后用于新建实例；已有实例不热切换。冷恢复只重建与原生描述符路由完全匹配的现有连接，无法匹配时明确拒绝，不偷换模型或实例。连接删除时提示修正该新建请求，不替换成另一模型。并发上限仍由 DSH Host 持有，不是每轮创建配额。

## 2026-10-17 已批准：会话内单工具授权

2026-10-22 已批准补充：宿主内置生图工具接入同一 Compat 会话授权缓存和 ACP 选项。授权绑定原生根 Agent、可信生图实现、工作区、任务记录目录、所属聊天和规范化服务地址；同配置的逐轮重装配可复用，替换服务、移除工具、重启或替换实现后失效。子级只能消费匹配上述范围的已有根授权，不能改变原生非交互审批规则。查询或取消旧任务时，原始任务回执中的服务地址必须匹配当前授权服务，否则仍需单次审批。工具实例与实际注册定义由宿主代码核对，不采信模型参数或同名工具声明。仅此次允许、停止、明确禁用和安全检查继续走原有审批链路，不新增全局权限、授权持久化或 DSH 执行状态。

生图授权不绑定单次参数；在上述范围内更换提示词、尺寸、种子和任务编号，或从生成转为查询、取消本会话任务，均可复用已明确授予的会话权限。conversation driver 仅提供调用上下文的产品 ID 投影，Harness 宿主适配层在实际调用时应用，保留原始工具定义身份；子 Agent ID 不改写。此接线不改变原生命令的沙箱或审批边界。

2026-10-18 已批准补充：当前嵌入 profile 的 `load_workspace_dependencies` 仅配置 source，不配置安装目标 root；原生工具只验证现有载荷并返回路径。适配层将实际已注册定义纳入只读能力，同名覆盖不继承，不授予依赖下载、安装或复制权限。

原生 `web_fetch` 的会话授权复用下述 Compat 内存缓存与 ACP 选项，不新增审批 owner 或持久化协议。授权按原生根 Agent 身份、实际工具定义、Web 服务身份与规范化 origin（协议、主机、端口）绑定；不同路径与查询可复用，同名替换、不同根身份和重启不继承。审批正文明确展示目标站点与匿名读取范围。子 Agent 只能消费已有根授权，不能自行弹审批。DSH 原生匿名 GET、URL/DNS、公网地址、重定向、超时和大小限制仍负责实际网络执行；会话允许不绕过这些检查。未改变 PowerShell 审批，也未挂载实验性 Auto 或另建隔离执行器。

模型思考仍由已有模型 profile 与 Harness/pi-ai 适配器负责序列化和流解析。已声明思考档位且未显式选择时，默认选择 medium（无 medium 时选择已声明的可用开启档位）；显式关闭优先。未知模型不凭历史保留或默认偏好推断能力，不统一强塞请求参数。Gemma 4 的界面能力与执行配置消费同一已存在的 chat-template profile；使用 `enable_thinking`，不伪造思考文字，也不把思考搬成正文。

界面三态统一为“请求批准／智能批准／完全访问”，模式 id 与原检查语义不变。重复查询采用会话内单工具明确授权，不按用户或模型自由文本判定“同类任务”。参考 Codex 对命令、文件、网络和 MCP 分别限定授权对象的公开设计；本次只处理外部 MCP 单工具：Codex MCP Auto 模式按服务器／连接器／工具记忆，Prompt／Writes 模式则把会话批准降为单次。本产品允许在请求批准模式显式选择本会话单工具授权，并且对明确破坏性工具更保守，不声称三态与 Codex 预设完全相同；当前安装的 DSH `dsh-user-approval` 仅有单次 `allowed-once`，不含记住规则，因此不另挂原生审批服务。

`Compat.approveTool` 仍为唯一人工批准 owner。MCP 桥绑定实际在线定义、连接代次及原生根 Agent 的不透明身份，显式破坏性工具不提供会话放行；其他 MCP 工具必须先由用户选择“本会话允许此工具”，远端只读注解本身不授予权限。现有 ACP `allow_always` 选项使用已有 `authorizationScope: session` 元数据准确呈现本次会话范围，不再从聊天审批写入全局工具规则。原全局配置保留且不迁移。原生命令、文件和无可信绑定的工具仍走已有单次批准边界。

临时授权由 Compat 在内存持有，跨轮有效并按同一根身份供原生子 Agent 消费；不持久化、不跨会话／根重绑，应用重启、设置重新配置或工具连接／定义替换后失效。同工具并发请求先等待已有选择：会话批准可覆盖后续调用，单次批准仍只覆盖原请求。每次继续及迟到回答均重新检查当前策略、能力启用、取消与实际绑定；明确禁止、只聊天、安全升级和工具停用优先。已存在的权限 RPC、原生拒绝与回执持有执行事实，不新增审批服务或以模型解释作为授权。

## 2026-10-17 已批准：子 Agent 非交互委派与回执分离

本节补充下方三态权限章节：子 Agent 的权限判定仍归根会话的现有 `Compat.approveTool`，每次工具检查读取当前授权；不会把手动自动提升为智能，也不创建独立子 Agent 权限设置。执行中的模式变更继续在下一次权限检查生效。DSH 的实际在线归属链识别子调用（不比较可能已 fork 的产品会话 id，也不信任模型参数）。权限足够则执行；不足时通过 DSH 原生 `tools/pre-execute` 的 deny 和工具错误回执结束该操作，不向用户打开子会话审批 RPC。子 Agent 可继续权限内工作，由原生委派结果／父子通信把限制交回主 Agent；父 Agent 无权自行放宽用户授权。

原生会话日志持有完整工具与拒绝回执，现有子会话详情继续读取它们；适配层不复制日志、不另建审批队列或完成状态。按原生／宿主实际工具定义标记的委派、父子通信、状态查询和工具 schema 发现回执不投影为主聊天工具消息或活动行；普通同名替代工具不继承此标记。审计事件保留可选内部展示标记，结果沿用对应调用的标记，审计事实与回执不删除。子 Agent 自身的文字和工具仍按原生会话身份分流，主 Agent 的用户可见进展、结论、必要的失败与权限说明保留。历史保存记录不重写，恢复后新产生的回执遵守同一规则。

采用 DSH 的非交互拒绝、原生持久化、原生跨轮继续及结果递交机制；不照搬其创建时固定的独立权限快照，以保留已批准的根会话实时三态切换。未挂载第二套 permission presets／审批服务，也未改变 Windows 命令沙箱、ACL 或既有明确禁止规则。

## 2026-10-17 已批准：会话审批模式与工具检查边界

现有 runtime store 继续持有会话 `mode` 和显式工具权限，ACP `session/set_mode` 写入并发布 `current_mode_update`；UI 只消费确认后的选择。`Compat.approveTool` 在每次工具权限检查、异步安全检查后及人工审批返回后读取当前事实；原生子 Agent 通过原父会话审批回调消费同一选择。切换不回滚已运行动作，不自动回答待处理审批；明确禁用、只聊天和工具停用不得被旧审批绕过。旧会话字段、全局默认和协议不迁移，不新增持久化状态。

只读能力由适配层对锁定版原生工具的已审查定义绑定，以及宿主注册工具的明确只读/非破坏性声明提供。按实际执行的工具定义匹配，同名替换不继承；远端 MCP 注解、模型参数、工具名称或命令文字本身不授予权限。手动和智能均自动放行已核实只读且未触发安全升级的调用；手动对其余动作逐项批准，保留明确长期授权。

智能进一步复用已挂载的原生 `fs-sandbox`：仅已确认可写项目、实际原生 write/edit 定义、当前原生 workspace-write 策略且未申请提权的调用可自动进入文件执行。实际路径、规范化、项目/临时目录可写集合及越界拒绝仍由原生文件系统持有，宿主不另造路径白名单。Shell 未受沙箱约束，命令、Git 写入、MCP 和未知动作仍请求批准。完全访问保留显式拒绝、能力可用性与既有安全升级；Harness 仍负责实际工具执行和取消。原 `smart_approve` 标识保留，界面同步说明项目文件自动批准语义；本功能分支尚未发布，不迁移旧权限字段，不启用实验性逐调用模型审查。

原生委派、直系父子消息和中断属于受原生所有权约束的内部控制，适配层按实际已注册定义识别，在手动/智能档免重复确认；明确禁止、工具停用、只聊天仍优先。`SubagentService` 校验实际 sender、直系归属和生命周期，子 Agent 每次文件/命令调用仍单独检查当前父会话权限。原先前端按原生工具名自动批准委派的规则移至后端；前端收到请求必须等待明确答复，不再自行放行。此变更不授予跨会话通信或更宽目录权限。

本批参考原生审批的单次请求和调用边界设计，不挂载 `permission-presets` 或 Windows ACL 沙箱；不宣称现有模式等同于原生沙箱预设。验证结果单独记录，不由本表宣布产品通过。

## 2026-10-19 桌面宠物展示消费者

本批补充（用户已要求）：侧栏完成绿色未读点与宠物完成勾选共同消费 Electron 提醒快照，由真实可见且聚焦的会话确认已读，不维护两份完成未读裁决。宠物暂停按钮委托现有会话 controller.stop，继续跟进打开对应会话；不引入第二套暂停或恢复状态。官方 Harness `userQuestions` 与 `ask_user_question` 通过 ACP `elicitation/create` 接到现有表单，待回答事实仍来自实际输入请求，宠物仅展示摘要。媒体工具沿用 ComfyUI 服务端队列和历史回执，图像与视频使用独立任务收据目录，不改变 Harness 完成语义。

2026-10-22 提问卡片补充（用户已批准接入原生 timed，并限定补答窗口）：保持 alpha2，`tool-ask-user` 使用官方 timed 模式与默认 120 秒等待；模型根据缺失决定对目标、范围和结果的影响选择等待，关键问题用 `timeout: -1`，次要偏好未答或跳过可说明假设后继续。DSH `userQuestions` 拥有等待计时、pending、空答案与补答准入，桌面只显示原生剩余时长，不另设原生问题超时。超时仍为待回答，不是跳过或授权。适配层只允许当前仍运行的原生轮次中的问题补答，以原生 turn/start、turn/end、工具调用标识及当前取消信号限定；轮次结束、主动停止、断连或进程重启后旧卡片不可触发新轮次，原生历史不删除、不伪造答案。补答经 `userQuestions.answer` 进入原生 inbox，同一问题重复排队由 DSH 拒绝；跨聊天或 native fork 身份变化时拒绝旧卡片，迟到提交在实际准入前重新核对轮次。单选、多选、自填与跳过仍映射到官方答案形态。恢复继续使用原生执行路径，旧卡片不重新授权。

人工授权 `session/request_permission` 没有倒计时，持续等待明确允许或拒绝；主动停止、连接关闭、工具结束仍撤销实际请求，之后的旧回复无效。不改变会话授权范围或缓存失效规则，不把提问跳过、超时和静默当作许可。通用扩展表单保持原有行为，网络请求及实际工具执行的超时不变。

繁體：側欄未讀點與寵物勾選共用提醒快照；暫停委託現有 controller，提問由官方 Harness 經 ACP 表單傳遞。English: sidebar unread dots and pet checks share the notification snapshot; pause delegates to the existing controller, and official Harness questions use the existing ACP form channel.

桌面宠物复用现有 ACP 会话快照、输入请求、错误及 `turnTerminal` 结构化记录，仅选择展示动作和提醒优先级，不解析对话文字、改变任务终态或驱动 Agent。Harness 的执行、审批与完成所有权保持。Electron `petMain` 持有宠物选择、显示、尺寸、位置、素材校验缓存及本次运行的提醒已读状态；提醒已读不修改会话。悬浮窗口属于辅助窗口，不成为会话事件的宿主。

自定义创建通过现有 CodeBuddy Agent 会话提出请求，图像工具的可用性与权限仍由该会话决定；文件生成后由本地素材加载器验证，最后发布有效素材。静态内置素材及 Codex 的制作工具不授予产品图像生成能力。用户确认小熊猫为默认，奶油猫和白狐作为其他内置选择。详见[宠物说明](../../docs/desktop-pets.zh-CN.md)。

繁體：寵物僅消費 ACP 結構化狀態；Harness 保留執行與完成權威。Electron 持有顯示偏好、素材驗證及提醒已讀，不改寫聊天。建立寵物沿用實際 Agent 與既有工具權限。

English: pets only consume structured ACP state. Harness retains execution and completion authority. Electron owns display preferences, validated art and local notice acknowledgements, without rewriting sessions. Pet creation uses the real Agent chat and its existing tool permissions.

## 2026-10-16 Mac 独立工具接入（实现待统一测试）

用户明确要求补齐 Mac 电脑控制和独立 MCP，并在开发完成后统一测试。平台适配复用 Go/Swift `qwen_computer` 与 Rust `codebuddy-tools`，不恢复旧 Agent/CLI。Mac `computercontroller` 与 Windows 一样只公开 PDF、网页文件、缓存；桌面操作唯一入口是现有九工具合同，权限仍由 Harness 回调与 macOS 屏幕录制/辅助功能实际授权共同约束。

工具原生构建、来源和载荷身份由打包脚本持有；`runtime/builtin-artifacts.mjs` 只解析固定文件名的包内清单，运行时校验二进制大小/哈希/普通文件与执行权限。电脑控制前端和同目录 Swift helper 一起校验；配置、环境变量及外部同名 MCP 不取得内置信任。签名回调在所有内部代码签名后、外层应用封装前写入最终工具哈希，保留签名前来源；不在已签名应用启动时修改资源。Windows 原固定身份和配置键保留。清单有效只表示产物可用，不代表 MCP 发现、TCC 授权或桌面 E2E 通过。

繁體：Mac 共用既有 Go/Swift 電腦控制及 Rust 工具，Harness 持有執行與核准，系統持有 TCC 授權。封裝持有固定工具檔案身份，內部簽名後、外層封裝前更新雜湊；啟動不修改已簽名資源。文檔工具不另公開桌面動作，實機驗收尚未執行。

English: Mac reuses existing Go/Swift computer control and Rust tools. Harness owns execution/approval; macOS owns TCC grants. Packaging owns fixed artifact identities and refreshes hashes after child signing but before the outer seal. Startup never rewrites signed resources. Document tools expose no second desktop route. Artifact validation is distinct from discovery, permissions and desktop acceptance; tests remain deferred.

## 2026-10-16 同事分支合并：原生子 Agent 与只读投影

本次按用户要求合并 `codex/dsh-frontend-ux`。当前会话选择的模型和思考强度是实际请求来源；原生子 Agent 继承父 Agent 的实际模型与强度，旧角色路由配置保留可读但不再覆盖执行选择。Host 的子 Agent 插件限制为同时 3 个、深度 1；旧配置中的角色并发值不修改原生 Host。此条覆盖下方历史角色路由执行约定，不删除保存的配置或历史。

子 Agent 状态、目录和对话由原生记录持有；适配层验证归属路径并投影只读视图。文件变更面板仅展示已保存的工具回执，不宣称覆盖 shell/MCP/子 Agent 的全部修改。取消完成与请求释放分开处理，队列只在已有请求释放后继续；不从显示文案判定完成。工具权限先绑定远端组合再施加筛选，工具 schema 仍按需发现，保留本地主分支的 MCP 复用与异步任务适配。

繁體：子 Agent 繼承父模型與強度，原生 Host 限制為 3 個並行、深度 1；舊路由仍可讀但不介入執行。目錄、對話及變更僅投影已保存事實，取消後須等請求釋放，權限與按需工具發現保持。

English: native children inherit the parent's actual model and effort; the Host admits three concurrent children at depth one. Saved legacy role routes remain readable but do not override execution. Catalogs, transcripts and change views project durable facts. Queues wait for request release after cancellation; permission filtering and deferred tool discovery remain intact.

## 2026-10-16 修复：GitHub 账户设置沿用官方 CLI

GitHub 账户授权、登录和凭据继续由现有 GitHub CLI 负责，Electron IPC 仅提供受限状态/设备流程/登出适配；移除旧 Rust OAuth 卡片调用，不恢复旧核心。`gh auth status` 的结构化验证结果是账户事实来源，MCP 独立连接配置不由账户卡片自动修改。Harness Agent 的执行、审批、完成所有权不变。见修复验收（历史文件，见 Git 历史：`docs/reconstruction/2026-10-16-github-account-fix.zh-CN.md`）。

繁體：帳戶由官方 CLI 驗證和管理，MCP 連線獨立，移除舊 OAuth 呼叫。English: the existing official CLI owns account authentication; MCP configuration remains independent and retired OAuth UI calls are removed.

## 2026-10-16 已批准：移除旧 Office 编辑工具并合并工具箱入口

用户批准将旧 DOCX/XLSX 能力迁移到现有 Harness `dsh-skill-office`、`dsh-tool-workspace-dependencies` 和原生 shell。Rust 的 `docx_tool`、`xlsx_tool` 注册、实现及专属依赖删除，不新增同名 Python 编辑服务。工具箱按注册技能身份将 Word、Excel、PowerPoint 归入 Office 文档组，技能详情及覆盖顺序仍由原注册表决定。`computercontroller` 的配置键保持，以兼容现有启用状态及保留的 PDF、网页保存、缓存；不迁移权限、不改写旧对话工具回执、不重放历史动作。已完成的历史可查看，恢复后的调用使用当前工具清单；硬编码旧工具名称的外部配方需按迁移文档修改。

公网文本读取优先复用上游 `web_fetch`；锁定版本不提供等价的二进制保存和私网抓取，旧 `web_scrape` 暂保留这些独有用途。外部 MCP 配置与凭据保留，安全 MCP 本批按用户要求不测试。迁移边界与同事合并步骤见 Office 工具合并记录（历史文件，见 Git 历史：`docs/reconstruction/2026-10-16-office-consolidation.zh-CN.md`）。

繁體：舊 DOCX/XLSX 實作移除，Office 由 Harness 技能與原生 shell 執行；保留 PDF、網頁檔案、快取及原配置鍵。歷史不重播，權限不擴張。English: Harness Office skills and native shell replace the retired Rust DOCX/XLSX tools. PDF, web-file saving, cache and the existing configuration key remain. Historical actions are not replayed and permissions are not broadened.

## 2026-10-16 已批准：复用官方 Office 技能与公网网页工具

Harness 的 `dsh-skill-office` / `dsh-skill` 负责内置 Office 技能注册、加载及同名覆盖顺序；`dsh-tool-workspace-dependencies` 提供官方锁定的独立 Python 载荷位置。CodeBuddy 只准备、打包载荷并将注册表投影到现有工具箱只读条目，不维护第二套 Office 编辑引擎。公网正文抓取由 `dsh-tool-web` / `dsh-web-fetch-http` 执行，保留官方地址、内容类型和返回长度限制；工具发现仍按需加载，权限走现有 Harness 回调。原 Rust 文档、PDF、缓存、图表及天气工具保留，尚未验证的替代能力不提前删除。

繁體：Office 技能與 Python 載荷查詢、公網抓取均復用 Harness；CodeBuddy 僅準備載荷與投影工具箱。舊獨立工具保留，不新增第二套編輯或抓取引擎。

English: Harness owns Office skill resolution, bundled Python discovery and public web fetch. CodeBuddy prepares the pinned payload and projects read-only toolbox entries. Existing standalone tools remain until their replacement capabilities are verified; no duplicate Office or web engine is introduced.

## 2026-10-16 已批准：MCP 异步探测与 300 秒默认超时

扩展配置继续由 runtime settings 持有；`mcp-settings.mjs` 统一秒到毫秒的转换。`mcp-bridge.mjs` 在连接／发现时读取服务端能力与工具声明，`mcp-tasks.mjs` 仅适配已协商的 Tasks 提交、轮询及取消，将最终 MCP 回执交给 Harness。远端服务拥有任务状态与执行结果，Harness 仍拥有审批、工具执行及 Agent 生命周期；不新增 Agent 调度器或任务持久化副本。同步及单次协议请求默认 300 秒，明确配置优先；异步轮询不因累计达到 300 秒结束。任务句柄不等于完成，取消请求不等于停止，失败或断线不重放原调用。当前 Tasks 交互输入、跨进程自动恢复未实现。

繁體：設定歸 runtime settings，遠端任務狀態歸 MCP 服務；適配層探測能力並輪詢，最終回執交給 Harness。預設單次請求 300 秒，明確設定優先；不新增 Agent 排程或持久化副本，不重送已受理動作。

English: runtime settings owns configuration and the MCP server owns task state/results. The adapter detects capabilities and polls; Harness retains approval and execution authority. Requests default to 300 seconds with explicit overrides. No duplicate Agent scheduler, task store or replay of accepted actions is introduced.

## 2026-10-16 已批准：移除旧 Rust Agent 源码

用户明确要求清理剩余旧核心并保留工具与前端功能。旧 Agent、CLI、Provider 和其专用 SDK/推理 crate 已移除，Cargo 只保留独立 MCP 工具。前端兼容协议 schema 从旧 crate 原样迁至 `ui/sdk/schema`；名称与通知格式不变，继续由 Harness 适配实现。后续历史章节中的旧路径不是新实现入口。执行、调度、完成、上下文与压缩的事实 owner 仍为官方 Harness，不新增 CodeBuddy 裁决循环。

繁體：舊核心原始碼移除，協議原樣保留於 SDK，工具獨立保留，Harness 權威不變。English: retired Rust Agent sources are removed; compatibility schemas and independent tools remain, with Harness retaining execution and compaction authority.

## 2026-10-14 已批准：新版 Harness 执行与目标权威

2026-10-28 异步工具显示核对：现有临时 `execution_activity` 可携带 `active_tool_call_ids`，由适配器投影本轮原生工具调用/结果及下一模型流的批次边界。Harness 在进入下一模型流前等待当前工具批次结束；桌面只核对同一 run、同一用户输入的运行标记，保留并行及直接工具调用。缺失回执的结果仍为未知，不补造成功或失败，不修改持久会话。媒体观察超过时限或断联时仅将显示降为“状态待确认”，保留远端任务和查询；不据此取消、重复提交或改变已确认终态。

繁體：工具活動核對僅清除失效顯示，缺失回執保持未知；媒體觀察失效不改變遠端任務。 English: ephemeral native activity reconciles display occupancy only; missing receipts remain unknown, and stale media observations do not cancel or resubmit remote work.

2026-10-20 用户明确要求通过输入框 `/` 菜单提供长期目标、暂停/继续和计划入口，取代常驻目标表单：桌面通过结构化 `codebuddy/goal` prompt 元数据和原生目标读/暂停适配接入 GoalService。Harness 仍是目标日志、revision、轮次、激活及完成的唯一 owner；UI 只读取投影、提交用户操作并展示实际回执。创建/继续绑定普通 prompt 的批准和取消通道；暂停先提交原生 CAS，再取消当前执行。新任务批准选择先完成现有 ACP set_mode，再发送首条消息，不修改全局默认。计划使用锁定上游 `PlanModeController` 的日志与投影，`codebuddy/plan` 仅传递显式选择；不改变批准模式，不新增调度器。没有目标或计划元数据的旧会话保持原行为。三语说明见 `docs/long-term-goals.*.md`。

繁體：斜線命令沿用原生目標與計畫狀態，長期目標 UI 沿用 Harness 唯一狀態與續輪權威，結構化控制綁定原有核准、取消及 revision 檢查。English: Slash commands consume native Harness goal and plan state; structured controls retain existing approval, cancellation, and revision checks without adding a second scheduler.

压缩中进程退出后，只有不存在活跃操作的历史加载才核对原生 `compaction/end`：有结束记录就恢复其结果，没有则仅将显示投影置为“中断、结果未确认”，不写入 Harness 完成事实、不改原始日志，也不重放摘要请求。繁體：重啟僅核對原生結束記錄，缺失時清除失效進度但不宣告完成。 English: idle replay reconciles missing notifications with durable Harness end events; absent evidence clears a dead spinner as interrupted/unconfirmed, without changing native history or replaying work.

本日夜间补充：上下文计量、压缩范围、摘要事务与重试归官方 `tokenMeter` / `compaction-basic`；`runtime/context-updates.mjs` 只转换现有 UI 通知，当前占用不得与累计账单混同。压缩不等于长期记忆，摘要不证明需求无损；多次压缩后的独立验收另留证。MCP 截图按实际执行 Agent 的图像能力原生准入，缺能力时复用 `VisionRouting` 的零工具辅助观察；原始工具回执归 MCP，视觉失败不得重放已执行动作。

锁定版本的已知压缩缺陷适配：`runtime/harness/compaction.mjs` 继承官方引擎，在普通压力路径略过已选中的单个 `compact-checkpoint`，避免无新增事实时反复摘要。2026-10-28 真实宠物历史回归另确认：原生选区可吞掉最新人工输入，摘要遗漏限制后回到旧任务。锁版 `sdk-budget/compaction-patch.mjs` 在共享选区函数内保留最新 `source.kind=user` 原事件，不把后续 runtime-context／skill-catalog 当成人工输入；遵守原有 tail 预算，只在其两侧选择工具配对完整的连续区间，优先非单检查点区间中的估价较大者。只有旧检查点可选时保留超限恢复与手动压缩能力，普通压力路径仍略过它。压力、超限／本地预算恢复和手动压缩共用人工输入保留边界；长 turn 后续工具历史仍可压缩，不复制、重排或补造人工消息。选区估价不替代 adapter 的真实 fit 门槛，后半区摘要可能损失前缀缓存；摘要事务、取消与 Session 格式仍归官方引擎。升级官方依赖时复查并在等价上游修复后撤除相应补丁。早期回归与实际证据见夜间跟踪（历史文件，见 Git 历史：`docs/reconstruction/overnight-acceptance.zh-CN.md`）。

2026-10-28 用户批准锁定 SDK 的请求预算与恢复合同修复：`runtime/harness/sdk-budget-contract.mjs` 在内存中对精确版本及 SHA 校验后的原生模块实施兼容变换。Pi adapter 持有同一请求的最终规范化投影、拟发送预算（fit）与派发；LLM 服务只以既有 `requestId` 关联一次性的进程内 fit 和原请求重测闭包。`tokenMeter` 的服务用量锚及压力估计保持原职责，不强行与最终投影估价写成同一数字，也不重写历史 usage。`LOCAL_OUTPUT_BUDGET_EXHAUSTED` 在 HTTP 前拒绝没有输出空间的请求；`OUTPUT_TRUNCATED` 表示原始 length 的实际输出小于本请求 clamp 前所需上限，不冒称服务端上下文溢出。`compaction-basic` 消费该 fit，沿原安全选区与摘要事务每轮最多尝试恢复一次，只有真实 surface 替换且同路由预算改善后才返回原生 retry；取消、无进展、摘要失败或第二次截断保留明确失败。通用网络重试不接管这两个错误。没有新宿主循环、持久事件、Session v4 版本或工具重放；升级及撤除边界见 `runtime/harness/PROVENANCE.json`。

繁體：最終請求 fit 歸 adapter，暫存關聯歸 LLM 服務，單輪有界壓縮恢復仍歸原生引擎；歷史用量與 Session 格式不變。English: The adapter owns final request fit; the LLM service carries a transient association; native compaction owns the single recovery attempt. Historical usage and Session format are unchanged.

输出用量证据同样由 adapter 在 Pi 公开的结构化 provider-stream 回调处读取：明确报告的输出计数（包含 0）才可参与 length 恢复与依赖零输出的 length 溢出判定；缺字段时保持未知，不用规范化后的默认 0 替代真实回执，不从正文猜 token 数。未知用量的 length 保留原 `max-tokens` 终态；显式服务错误仍由原分类处理。此观察不改变 usage、原始停止原因或持久化字段。

协议的最小输出也属于 adapter fit：Responses 启用 `max_output_tokens` 时最小值为 16，用户显式上限小于该值以 `INVALID_OUTPUT_BUDGET` 在 HTTP 前拒绝，不抬高用户上限，不摘要或网络重试；可用上下文小于最小输出则走有界的本地预算恢复。恢复重测须满足同一最小值，且可用空间和有效输出均达到它。显式 `supportsMaxOutputTokens=false` 继续表示该连接不发送上限，不把它冒称成服务端强制预算。[官方 Responses 参数约束](https://developers.openai.com/api/reference/ruby/resources/responses/methods/create)。

2026-10-28 真实回归补充：摘要自身也必须消费 adapter 最终 fit，完整摘要输出空间不足时由 LLM 服务在 HTTP 前以 `COMPACTION_OUTPUT_BUDGET_EXHAUSTED` 拒绝。原生压缩事务持有缩区：按工具配对边界有限地几何缩短选区，同步重建摘要输入、计量及 shadow 集合，未摘要的尾段仍为原 active surface 事件；不以“只裁输入、仍替换整段”丢弃事实。本地准备不增加摘要 HTTP 重试，最终候选复用已绑定连接快照及配置，只发一次摘要；实际 length、取消或未找到可用选区不提交检查点。候选搜索不是最长或穷尽保证，普通压力的旧单检查点保护覆盖缩区后的实际输入。没有新宿主循环、持久字段或 Session 迁移。

同日工具状态展示补充：原生附件存储仍持有图片对象的读取与校验，driver 只将已验证图片转换为 ACP 展示块，compat 消费真实工具终态。可选预览读取失败只降级图片展示，不丢弃完成通知或更改工具事实。旧记录只修复回放投影，不改写持久回执或重放工具。图片 I/O 后统一重新读取当前历史与实时高水位，再同步重置并发布回放，避免旧图读取期间的新消息丢失。

**繁體補充**：上下文計量及壓縮由 Harness 持有，CodeBuddy 只投影現有通知。摘要不是無損記憶；反覆壓縮另驗。MCP 圖片優先交實際執行模型，缺能力時輔助視覺只觀察，保留原始回執且不重放動作。

**English addition:** Harness owns context metering and compaction transactions; CodeBuddy only projects existing notifications. Summaries are not lossless memory, so repeated compaction requires independent acceptance. MCP images use the executing model's native capability first, then a tool-free visual observer when configured. Original receipts remain authoritative; observation failures never replay actions.

**繁體補丁界線**：薄子類只延後普通壓力下的單一既有 checkpoint；不另選範圍，不攔截手動或超限恢復，官方修復後撤除。 **English patch boundary:** the thin subclass defers only an upstream-selected singleton checkpoint under normal pressure. Manual and overflow recovery remain unchanged; remove this guard after an upstream fix.

本日追加的远程 MCP 复用授权：长期组合、作用域租约、修订保留和回收由官方 `agent-preset-registry` / `dsh-scope` 持有；CodeBuddy 仅按完整配置选择组合、投影状态和维持每会话权限/Apps 适配。stdio 保留工作目录与会话边界。详见复用验收（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-mcp-reuse.zh-CN.md`）。

**繁體補充**：遠端 MCP 長期組合、作用域租約及修訂回收由 Harness 持有；CodeBuddy 選擇設定組合並維持每會話權限與 Apps 適配。stdio 保留工作目錄與會話邊界。

**English addition:** Harness owns standing remote MCP compositions, scope leases and revision retention/collection. CodeBuddy selects the configuration and retains per-session permissions and Apps adaptation. Stdio retains its workspace/session boundary.

适用范围仅为 `D:\CodeBuddy-v1` 新版运行时。用户基于普通问候正常结束却被新版门禁标为中断的真实会话，批准将执行、调度及完成生命周期交官方 Harness，CodeBuddy 保留必要适配，并允许前端为原生后端调整。此修订覆盖本目录旧表中关于新版自造计划/调度/完成门禁的职责，不改写原 Rust 产品或旧历史事实。

官方 Session Controller / AgentLoop / subagent 负责执行；goal/tool-goal/goal-round-driver 负责目标、自动续轮、CAS 与进程内激活；todo/write 仅为当前轮清单，turn/start 清空。CodeBuddy 的 codepro 只投影原生状态、实际工具回执及 UI 控制引用，不再注入 codebuddy_task，也不要求模型提交第二套计划或证据 ID。harness_turn 仅表示一轮结束；harness_goal 仅表示原生目标已完成；两者都不等于独立测试通过。原工具效果、未知副作用及旧事件前缀保留，恢复不自动重放。

**繁體修訂摘要**：此修訂僅適用新版執行時。官方 Harness 擁有執行、排程、目標與續輪；CodeBuddy 只做投影及必要權限/設定適配。原生完成不替代真實測試證據，舊歷史及未知效果保留。

**English revision summary:** This revision applies only to the new Harness runtime. Official Harness owns execution, scheduling, goals and continuation; CodeBuddy adapts presentation, permissions and settings. Native completion is distinct from independently verified tests. Historical events and uncertain effects remain intact.

实施、替代方案、锁定版本/许可证与验证边界：简体中文（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-harness-authority.zh-CN.md`） · 繁體中文（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-harness-authority.zh-TW.md`） · English（历史文件，见 Git 历史：`docs/reconstruction/2026-10-14-harness-authority.en.md`）。当前仅自动夹具已验，最终产品证据单独记录，不由权威地图宣布产品通过。

## 2026-10-12 已批准：常用只读查询与每轮时间

新版接线：runtime store 仍持有查询设置；独立 commonqueries MCP 每次消费宿主生成的请求元数据，不持有第二份设置。Harness 主导调用、审批及完成，原 Rust 查询实现只提供结构化工具回执。繁體：設定由 runtime store 持有，每次經宿主 MCP 中繼資料傳入，無設定副本。 English: the runtime store owns query settings; host MCP metadata carries them per call, with no mirrored state. 详见接线边界与验收（历史文件，见 Git 历史：`docs/reconstruction/2026-10-15-common-queries.zh-CN.md`）。

用户批准 COMMON_QUERY_TOOLS_PLAN 三语方案的开发与测试。现有平台工具注册与执行边界负责 `time_now`、`location_resolve`、`weather_get` 的结构化回执；时钟来源是执行主机，指定时区只影响展示，不作为实际地点证据。城市由用户参数或设置中的默认查询城市提供，地理编码返回候选，模型负责追问歧义。天气与数据时间来自供应商；宿主标记缓存、过期、限流及缺值，查询时间不提升为观测时间。

沿现有配置 owner 保存常用查询设置，工具每次调用读取；联网关闭在命中缓存之前检查。普通聊天沿原意图分类及执行器，只开放本轮已启用的常用查询工具；明确禁止工具时保留空工具面，原权限拒绝优先。时间上下文由现有 MOIM 请求投影刷新，不写入历史或恢复摘要；保留缓存检测需要的结构。无新增任务终态、完成裁决者或回执库。实施及平台验收结果见三语实施记录。

## 2026-10-05 已批准：Mac worker 强制停止的既有 owner 接线

用户在 MACOS_PARITY 三语方案与批准问题后回复“继续”。`SystemProcessGroupOwner` 仍是 OS 进程组操作和退出观测的唯一 owner；`WorkerRegistry` 在 worker generation 内保留 PID 与 `SessionProcessOwner` 的同一引用，scheduler tracker 负责注册／消费，lifecycle 负责停止流程。强制清理取快照和关闭注册原子完成；终止与退出确认在锁外；未确认对象保留以供重试，直到生命周期确认成功后清除。新 generation 拒绝旧 handle，冲突 owner 不覆盖现有记录。仅运行时引用，不增加 ACP 或持久化格式，不授予重启后的 PID 回收权限。Windows 无 owner 的既有终止入口保留；Mac 缺 owner 保持未确认。`SessionProcessOwner::is_empty` 缺省报不支持确认，不把未知退出状态转成成功。


本文是 CodePro 跨模块事实所有权地图。它回答的是“谁有权写入和裁决某项事实”，不是当前实现已完全达成的证明。修改相关链路前，应从根目录 `AGENTS.md` 或 `documentation/codebuddy/CURRENT.md` 进入本文，再用当前源码、日志和运行证据核对迁移状态。

> **架构基线冻结声明（2026-09-21）**：本文与 `docs/superpowers/plans/2026-09-20-codepro-dag-runtime-refactor-plan.zh-CN.md` 共同构成冻结的架构基线。实现过程中发现的双写、兼容债务、测试失败和迁移进度写入独立实施记录，不因文件名、类型名或模块拆分变化而修改本文。只有用户目标变化、E2E 推翻核心不变量，或源码约束证明所有权设计无法实现时才修订，并必须留下原因、证据和 revision。

### 2026-10-03 Mac 项目父目录的已批准扩展

用户在可写父目录方案后要求继续实施。新增 `codepro_workspace_binding.v1` 的 `project_container { path }` 变体，由 ACP 宿主在确认创建后记录；父目录不获得项目工具写权限。旧 `root_container` 仍只表示文件系统根，旧 `writable_project` 及租约语义保持不变。旧后端遇到未知变体应拒绝读取，不得降级成可写。

新端点 `_goose/unstable/workspace/project-container/v1/allocate-child` 要求双方 `projectContainers: 1`。Agent 只提出子目录名，宿主签发关联 session/run/sourceMessage 的有时效令牌，前端选择并确认准确路径；Mac 用已持有的父目录 fd 创建直接子目录，冲突拒绝，不自动换名。共用既有分配令牌、租约归属、幂等收据和失败回滚。宿主持久化容器后，由既有 session/load 消耗同会话子目录租约并提交 writable_project；前端沿既有回调继续原消息/run，不创建新会话。

重启后仅恢复容器状态，不恢复创建令牌；继续创建须新请求、新令牌和重新确认。关闭/归档/删除会话撤销令牌及收据。文件清理权限不由创建权限派生。Mac 新通知 `codepro.needs_project_workspace_v1` 与旧通知区分，避免旧客户端把父目录当根目录或自动执行。实现和验证进度见 MACOS 三语记录。


## 已批准修订（2026-10-04）：项目确认刷新

用户在三语方案后回复“继续”，批准 `_goose/unstable/workspace/confirmation/v1/refresh`，双方协商 `workspaceConfirmationRefresh: 1`。ACP 宿主在既有会话生命周期屏障内，读取既有 RunBinding、控制面 Projection、原用户消息和宿主工作区通知，验证未终结运行及受限绑定；只通过现有 capability registry 取得有效确认。重复调用复用同一有效令牌；已分配租约、已绑定、已关闭／归档、终态或身份不匹配均拒绝。刷新不调用模型、不创建目录、不绑定租约、不执行原任务，不新增持久化事实或权限 writer。前端重新展示路径，经明确确认后使用既有分配、绑定、结构化续行。旧客户端不调用；旧后端由新客户端提示升级。

修订原因：bundle16 的自然语言重发曾改变 run 身份，bundle17 的结构化续行虽保留身份，但绑定后会执行任务，不适合作为只刷新确认的 UI 入口。基于 `00a6656` 与现有未提交合并；实施与验证见 MACOS 三语记录。

## 已批准修订（2026-10-05）：Mac 清理分阶段适配

用户在 MACOS_CLEANUP_DESIGN 三语具体方案及批准问题后要求继续开发以对齐 Windows。批准范围为沿用既有清理语义，抽取共用策略，并分阶段验证 Mac 只读审核、原生对象操作及恢复；不由项目创建令牌派生清理权限。ACP 宿主、cleanup registry/journal 与 UI 投影的 owner 不变。

当前阶段只加入内部只读 Inspection：复用保守目标范围及项目排除，用持有的目录链/文件描述符读取摘要并检测源替换、祖先变化、内容/硬链接变化。它不签发权限、不开放 Mac 清理 RPC、不修改目标、隔离或恢复日志；Windows 日志格式和原生操作保持既有语义。隔离/恢复/永久删除须先通过方案中的精确对象及故障恢复门禁，再接通产品；通过只读审核不授权后续按路径 rename/unlink。具体实现与未完成项记在 MACOS 三语实施记录，候选 FSRef 不视为已经证明满足合同。

### 2026-10-10 本地融合验收中的失败计划归档（用户批准）

Tester 失败经原计划修订边界保存原快照；当前图由独立复测承担原验证责任，旧失败状态与原工具回执留在历史中，不改写为成功。宿主 TaskInput 仅为 RecoveryEvidence 解析同一 DAG 已安装旧版本的精确节点、合同及失败证据，并核对原 run / task 身份；普通执行依赖仍只引用当前图。归档不改变授权、未结副作用、完成证据或重试上限的原 owner。缺历史身份的旧数据保持原行为，不猜测补造。实施与验收结果见 MERGE_LOCAL_REPAIR_20261010 三语记录。

## 使用规则

### 2026-10-09 停止执行与受阻交接修复边界

用户基于 `20261009_12` 授权计划与实施，起点 `08a440604 + 保留 dirty`。ACP Stop 只停止本次 prompt：由 ACP 原执行入口确认当前 prompt 已实际 register/resume 的 durable run，先经原 runtime 提交 PauseRun，再取消本次 token；临时分类、问答或提示请求引用历史 run ID 不构成执行绑定。该请求内标志不持久化、不裁决业务成果。明确取消业务仍走原 Cancel/EmergencyStop；已 Failed/Cancelled 的同目标续作建立带原始要求版本的新 run，不复活旧 run，不继承授权。模型仅分类需求是否变化，不再承担终态能否原地恢复的裁决。

重复相同完成缺口复用既有 Paused 后无工具答复，不提前退出丢弃交接。已经接受的新输入先被消费；取消与真正失败仍优先。要求修订的 continuation_source 由已提交要求关系保留，模型不填写任意来源。无正式 answer phase 的旧记录，UI 保留最后工具后的全部公开正文，不能用最后一条宿主提示吞掉此前交付说明。以上不把模型正文、可运行成品或部分测试通过提升为 Completed，也不把平台证据缺口提升为业务整体失败。实施与验证状态以实施记录为准。

2026-10-10 补充授权：用户批准续作引用原文件回执。原 ACP 绑定 owner 验证会话/工作区，runtime 验证原终态与要求版本，ToolAuditStore 验证原调用身份与回执；ToolTaskProgress 沿原 source 引用当前版本一致的文件事实。可选 continuation 不伪造 delegation，旧记录不补造来源；不转移权限、动作预算或成功 shell/外部证据。已认证原 scope 的未结动作、原 runtime 未确认效果和原审计缺终止回执，一并进入原完成检查的临时可重建投影；原 owner 对账后重建消除缺口，不写第二账本、不清除或遮蔽旧 Unknown。平台来源不可用不是业务效果失败。此批准扩展的是证据可寻址范围，不改变原事实裁决 owner。

### 2026-10-09 超时清理回执与终态后的流式交接

用户批准基于综合题 `20261009_1` 修复，起点 `4c984d799 + 保留 dirty`。进程终止、命令结果和业务副作用保持独立。工具执行边界在原超时/取消 ErrorData 的可选 `codepro_bounded_execution` v1 中保留同一次 operation 在清理窗口返回的原结果；审计仍记录 TimedOut/Cancelled，不写 Success。原任务投影只在 Platform `developer::shell`、原回执明确确认终止且输出管道收集未超时的条件下消除执行终止未知；部分文件变更保留，不进入成功写入或通过验证集合，不证明远端副作用成功。缺回执、无身份的旧 Unknown 不迁移、不追猜 PID；任意 Shell 的远端效果不可绕过保证不在本修复能力范围内。

`report_blocked.summary` 是模型提出的交接材料，不再直接充当已结束的用户回答。原 runtime 先提交 Paused，执行器将已提交状态及原未结动作投影给主模型，关闭执行派发，沿现有消息增量通道生成正式回答。最后才发 TurnTerminal，不再重放原 summary；并发取消/失败不被暂停覆盖。此投影仅在当前请求装配，不新增生命周期或持久状态；正文仍由模型负责，不以关键词或第二模型判决。旧会话原样回放，旧消费者忽略新的可选错误详情；实施、兼容与 E2E 结果见实施记录，不由本文宣称通过。

补充授权：回放反例发现原 `ToolResponse` 错误序列化仅存字符串，无法保留清理回执或原审计。用户批准在原记录的 `toolResult` 增加可选 `errorData`，由 `goose-provider-types/conversation/tool_result_serde.rs` 无损序列化原执行错误，SessionManager 沿原消息存储；工具事实消费者恢复原数据，不新增 owner。原 `status/error` 字段不变，旧读取器可忽略新增字段；缺失或损坏的可选字段退回原错误文字，不从文字补造事实。旧记录不迁移。回滚到旧 writer 后重新保存可能丢失可选数据，不宣称旧版具有新版恢复能力。

### 2026-10-09 委派文件事实的带来源引用

用户批准父任务消费子任务原始文件证据，起点 `ab8338527 + dirty`，原因是 R02 子任务已有写入回执而父 scope 过滤后无法引用，导致无业务意义的重写。原委派事件与 SessionManager 负责 run/task/parent/child 身份；原 ToolAuditStore 核验原始 started/completed、请求和参数摘要。父 ActionFacts 只投影已核验的文件写入，现有证据条目增加可选 `source`（子会话、子任务、原 scope 摘要和委派 EvidenceRef），不将子回执改为父回执，不新增账本。

当前文件版本仍现场核验；子运行状态、未结效果、显式接手仍归原 runtime/plan。`task_scope_digest` 仅绑定 run/task 身份，不是完整权限或工作区能力摘要；原授权结果来自原执行边界，不在引用时重新推断。导入文件不改变子状态，也不增加父执行预算、成功计数或提供外发/命令验证证据。普通任务和其他父的委派不导入；旧审计、委派容器或子会话不可读只使对应引用不可用，不能让其他完整引用失效。来源查询只读，不恢复或截断原日志；最终未结审计核验仍覆盖全 run 的任务。旧证据不推断来源、不迁移。来源字段只扩展当前写出的证据快照，原回执/事件格式不变；旧消费者可忽略该可选字段，但不保证旧执行器具备子证据重建能力。实现与 E2E 状态仍见实施记录，本文不代表验收通过。

### 2026-10-09 审计查找索引（不新增结果 owner）

用户批准由原审计模块维护可重建的位置索引，起点 `7ceeae2c9 + dirty`。`ToolAuditStore` 仍唯一写入/校验 started/completed 原回执；新增旁路文件 `tool-audit-locations-v1.json` 仅保存会话目录内容指纹及其中出现的 task scope 摘要，不保存执行结果或完成资格。Completion 仍读取原回执和原 effect ledger。

查询枚举会话目录与记录元数据（文件名、长度、修改时间），对照派生索引；仅未变化且不包含目标 scope 的会话免读记录正文。命中的会话始终重读并校验原回执；未索引或发生变化的会话先重建。索引版本无效、损坏或丢失时回读源数据，写索引失败只影响下次查找性能，不使任务失败或变为成功。索引以临时文件原子替换；并发更新丢失只导致后续重建，不能覆盖原事实。

原审计格式不变，旧版忽略这个旁路文件，旧版写入的记录仍因目录内容变化被发现；不迁移、删除或重写历史回执。该优化依赖宿主既有的不可原地改写回执约定，元数据也检测通常的外部修改，但不宣称能防止具备文件写权限者同时伪造源文件、时间戳与索引。它是可失效的查找优化，不是新的权限边界。实施及真实性能验收见现有实施记录。

### 2026-10-08 撤回普通多轮入口重构

用户明确要求恢复删除分类器前的多轮入口，只处理分类器超时。TaskEntry 按需登记、自动关联、完成门槛迁移及 answered 新终态全部撤回；原 resolve_codepro_run_input、conversation_only 和既有完成核验恢复。只读正文修复、子 Agent 和独立 UI 修复保留。实验会话不迁移、不将 answered 当 completed；实验记录仅作为失败证据保存。具体备份、差异与验收见实施记录。

### 2026-10-08 只读回答与查证事实分离

用户确认“调整职责，边调边确认”。源码起点 `63a6d5a38 + dirty`，失败样本 `20261008_8`：普通方案咨询被只读工具记录门槛强制重试并吞掉两次正文。原记录列表包含失败动作，既不能证明查证成功，也不代表用户每次回答都需要新资料。

本项修订 9/30 “只读有证据才流式”的限制：只读是当前动作能力边界，不是工具调用义务。原执行器沿 Message/SessionManager/ACP 发布和保存模型公开回答，零工具记录不再单独触发重试或替换正文；收尾和结构化输出不通过固定项目报告模板产生“已核实”判断。工具回执继续由工具边界产生并保留失败事实，活动展示不能替代验收证据。

Main Agent 决定如何回答、是否需要查资料，并对缺失资料作说明；宿主不保证自由文本的每项主张正确。明确结构化验收义务、权限、真实副作用和 Unknown 仍由原 owner 校验。只读回合 finished 表示本次响应结束，不写入业务 Completed。无新增 owner、状态机、持久字段或自然语言分类器，旧会话不迁移；实现与验收进度见现有实施记录。

### 2026-10-08 未完成委派的显式接手（计划审计扩展）

源码起点 `63a6d5a38`。子 Agent E2E Case3 发现预算退出被 String 包装丢失，而当前完成检查又要求当前图所有节点成功。用户明确批准“接手／替换，保留原事实”。新增入口只提出一次带 `reassigned_to` 的既有计划修订：Main Agent 选择是否接手；Summon 核对 SessionManager 的父子关系和已提交委派证据的 run/task/parent/child 身份；原 runtime 在同一运行锁内检查效果、回执与并发版本，原 plan reducer 校验已停止的部分结果节点及拓扑，再提交修订。它不是新的任务终态或第二份账本。

原 Paused/outcome/evidence 留在 RunProjection 历史，当前图不再要求该次委派自身成功；剩余责任绑定当前主任务，由模型决定自己补做还是再次委派。用户要求不变，Completion 继续消费原 owner，包括全部历史任务的未结回执，不把接手当完成。旧证据缺身份不猜测迁移。审计字段可选，新版读取旧历史保持原样；含新字段的事件不保证旧版 strict reader 能读，回滚不得把新运行数据交给旧版写入。实施及产品验收状态见 10/8 子 Agent 计划，不由本文宣称通过。

ACP 的可选 `inCurrentPlan` 只投影原 TaskGraph 的成员资格；UI 据此区分当前进度和历史详情，不能改变旧任务状态。旧快照无此字段沿用旧展示，不猜测哪些任务已转交。执行器遇到旧 max_turns 上限或撤回工具进入限额交接时，通过原消息通道记录 `codepro.execution_limit_reached`；子 runner 消费此事实，不从总结文案判断是否耗尽。

### 2026-10-07 工作过程与正式回答分离（展示约定修订）

用户明确要求执行时实时展示、正式回答开始时整体折叠此前过程，并授权按公开协议比较后实施。源码起点 `8f1b1ae0757ce4603d7660a7004795b9525654f7`，计划见 `docs/superpowers/plans/2026-10-07-process-final-answer-repair.zh-CN.md`。这不是产品 E2E 通过声明。

原 `propose_coverage` 提案在工具回执返回前调用同一个完成核验入口；拒绝保留为该工具的错误回执，接受仍由原 runtime 提交完成。之后只有回答生成，不再开放执行派发；新输入不因此获得授权，也不作为已完成任务的暗中续执行。可选 summary 是提案说明，不是证据。未使用该提案的旧客户端仍保留既有出口，不推断旧文本用途。

为表达回答开始，9/30 的“仅 Message 与 TurnTerminal”展示约定增加现有 ProgressMessage data 内的可选 `codepro_response_phase` 标记。执行器是该展示标记的 writer，SessionManager 保存，ACP 传输/回放，UI 消费；它不写入控制面、不证明业务成功，不是新的任务状态。旧历史缺失时不补猜。TurnTerminal 仍只投影原 runtime 的事实，正文发送结束后才发布，不能提前 seal 截断正文。此修订不改变权限、观察、Effect、Unknown 或完成资格的 owner。

10/7 后续缺材料 E2E（`20261007_2` / `tser5vss`）证实交接正文、宿主包装、空终态兜底重复。用户授权继续修复结束判定和内部对话割裂，起点 `cb5914e0d`：`report_blocked` 的原交接正文由既有 TurnTerminal 同一消息携带，先由原 runtime 记录 Paused，再发布回答边界与交接消息；不再先发独立交接、后发空终态。不覆盖并发 Cancelled/Failed，不清除 Unknown，不将暂停解释为业务完成。旧历史不迁移。旧兼容结束出口的核验拒绝不再伪装成 user 消息：执行器只在进展指纹仍匹配时将原核验结果作为本次模型请求的事实上下文，指纹变化后不复用旧缺口；上下文明示为上次检查，不将该指纹提升为全部事实的版本。工具提案的拒绝仍是原工具回执。此处修订传播与展示方式，不新增事实 owner；实施和产品验收状态见现有实施记录。

### 2026-09-30 公开正文与完成核验分离（展示约定修订）

用户在对照公开协议及 WorkBuddy 分享材料后选择体验优先，并明确批准实施。修订原因是 9/30 网页会话已有上游 Text 分片，却被宿主缓冲到结尾才展示；下面 9/28 约定中“Main Agent 普通文本分片仍先缓冲”对普通公开正文不再适用。源码起点为 `4e6b3ae1f`，实现及验收状态见 `docs/superpowers/reports/2026-09-30-codepro-ux-repair-progress.zh-CN.md`，不是产品验收通过声明。

模型仍是公开正文作者。Agent 保留原 audience/visibility 边界，沿现有 Message/ACP 发送普通正文增量；没有 provider message ID 时由宿主分配当前响应的展示 ID。SessionManager 仍唯一保存会话，显示过的正文在响应结束、取消或 provider 流错误边界保存，不因完成提案被拒绝改为仅模型可见。这里不承诺进程崩溃前逐 token 落盘，也不修改旧历史。

完成提案、证据、权限和终态仍由原控制面负责；正文生成结束不能提交 Completed。核验拒绝时保留模型原文，另发明确的未通过说明；继续执行或交接仍走既有路径。核验通过不重放已经流式发送的同一正文；宿主依原事实替换出的核验说明使用独立消息。只读有证据的普通回答沿原消息路径流式；finalize、结构化 final-output、simple-change 和 exact-reply 等特殊出口不在此约定中强行放开。

ACP 和 UI 仅消费消息与原 TurnTerminal，不新增持久协议、完成 owner、正文分类器或状态机。取消后 ACP 不再转发正文，但为原 Agent 的保存和取消处理保留有界收尾消费；收尾超时只能记录历史可能不完整，不能宣称保存成功。本文修订的是展示与保存语义，不授予任何执行权限，也不把模型文字变为业务事实。

### 2026-09-28 高级模型路由停用保留组合

用户明确批准将“关闭并保存清空组合”改为“停用但保留组合”。`GOOSE_CODEPRO_MODEL_ROUTING` 仍是唯一配置来源，ACP 专用配置接口负责结构校验与持久化；前端只编辑草稿并显式保存，不新增偏好存储或状态机。`advancedRoutingEnabled` 决定是否使用 `routes`，不决定是否记住它们。`ModelRouterConfig` 只在启用时将角色选择转换为执行配置；停用时忽略保留组合及其并发数，主 Agent 沿用会话模型、其他角色沿用既有默认路由。

停用时允许保留完整的厂商/模型对（可以只有部分角色），仍拒绝重复角色、空标识和未知字段，但不联系厂商检查可用性；再次启用必须具备原有必需角色并通过既有实时模型校验。厂商删除/模型移除导致自动停用、以及用户切换普通默认模型时，也只停用而不清空角色选择。保留旧标识不恢复厂商、凭据或执行权限。

这是现有版本 1 配置形状的语义扩展，旧的空配置和四角色配置继续可读；旧后端不能读取含非空 `routes` 的停用配置，新前端必须配套新后端。降级前需备份组合并将停用配置的 `routes` 显式置空，不能把拒绝读取解释为默认配置或静默清空。具体实现与验收状态见 `docs/superpowers/reports/2026-09-28-main-agent-model-routing.zh-CN.md`；源码身份为 `18753e430` 加本批未提交改动。

### 2026-09-28 输入关系与计划归属的有限扩展

用户明确批准将普通追问边界纳入原方案并实现计划关联。普通下一轮沿用 `resolve_codepro_run_input` 的一次语义判断，增加 `question`：只回答上下文/常识问题，不注册、恢复、取消或终结旧运行，不提交要求或清单。要求项目事实检查的请求不属于此无工具分支；执行中 steer 仍由现有 Main Agent 接收解释，没有新增分类请求或旁路并发问答。

ACP 在已接受执行的原始用户消息上保存 `taskRunId`，统一执行的既有 `codepro_unified_turn.v1` 同时保留 `run_id`，用于压缩后的来源恢复。消费者必须重新校验原 `RunBinding` 的 session/workspace 与 runtime；Todo 不得反向选择任务。无关联历史沿用既有拒绝歧义行为，不按文件时间猜归属。这里只新增关联记录，不改变控制面生命周期或权限。

CodePro 清单使用同一会话数据库的 `todo.v1`，键为宿主运行 ID 与要求版本，binding 额外含 session ID；模型只提交 `content`，宿主工具上下文绑定来源与 request ID。SessionManager 事务只更新这一命名空间，选中版本与写入版本不符时拒绝该次清单写入。同一运行/要求版本继续时复用；新运行隔离；要求修订保留旧版本供同任务核对，不把旧勾选当作新版当前计划。`todo.v0` 原样保留，不迁移或猜测绑定；非 CodePro 的旧 Todo 行为不变。

模型上下文和 UI 消费同一绑定清单。旧 Todo 调用只从 provider 输入投影移除，不从持久会话删除；未绑定历史仍可在聊天记录查看。UI 通过原进度消息通道的 `codepro_plan_context` 展示投影和成功工具回执更新卡片，重放末尾从持久状态恢复；动效需匹配实际活动运行，不按最新用户消息推断。清单没有新增状态机，也不决定完成或授权。

公开进度允许可选 `stage`（至多 100 字）作当前阶段标题；异常可选标题降级，不阻断有效正文。标题与经过校验的回执沿现有工具通道保存，UI 只展示，不当执行证据；不增加标题润色请求。过程计时只表示当前提示持续时间，不表示网络已收到分片或工作完成。实施与未验收边界见复盘第 22 节。

### 2026-09-28 执行中插话的有限修正

用户批准去掉“插话即要求修订”，复用 Main Agent 语义理解和既有合同提交，不增加分类请求或计划状态机。执行器接收的原始插话仍由 `SessionManager` 保存；接收本身不提交要求、不清除完成覆盖、不授予权限。当前执行内的来源索引仅供 `codepro__task_contract inspect/revise` 使用：Main Agent 判断确属要求变化后提出修订，宿主核对该输入来自当前执行或已有合同，再由原控制面提交版本。普通提问通过公开说明回答，不因传输标记自动成为要求。

索引不另建持久存储，不从整个会话历史反推运行归属；已提交要求按原协议保存，未提交插话在执行结束后只保留原消息历史，不自动迁移。`inspect` 的补充 `followup_inputs` 是原始输入，不是已接受要求或授权。修订须单独提交，混有其他调用的整批不执行，以保留修订后的原有授权校验。停止/授权入口和完成门槛不变；普通下一轮续接分类、历史插话恢复和 Todo 归属不在本次扩展内。依据及验证边界见 9/27 全链路复盘第 21 节。

### 2026-09-28 消息与清单展示修复

用户批准按 9/27 全链路复盘逐步修复。Main Agent 普通文本分片仍先缓冲；同次响应出现真实工具请求时，将之前的公开说明按原消息通道发送并保存，不再丢弃。无工具最终答复仍走原完成门槛，特殊只读/simple-change/exact-reply 出口不放宽。没有新增消息协议或完成权威，普通说明和 `publish_progress` 都不能充当执行证据。

Todo 的既有 `content` 文本补充 `[-]` 进行中展示约定，兼容原 `[ ]`/`[x]`；唯一作者仍是模型，原请求/成功回执和 `todo.v0` 仍是存储来源。UI 只对当前执行轮次最新成功计划中的显式进行中项显示动效，停止/等待/历史不转动，不从待办顺序推执行事实。清单不是控制面的任务状态，不改变权限、恢复或终态。实施与未验收边界继续记在 `docs/superpowers/reports/2026-09-27-codepro-end-to-end-retrospective.zh-CN.md` 第 17 节。

### 2026-09-27 用户旅程与进程归属有限扩展

用户在 1504 E2E 对照分析后批准实施。新增 `developer::shell` 可选 `process_action=start/status/stop`、`process_handle`、`port`，仍经过原 shell 权限和审计入口；有任务 scope 时仅全访问 Main Agent 可保留长进程，受限 worker 不获得后台权限。工具复用 `SystemProcessGroupOwner` 作为进程组生存与终止的唯一 owner，工作目录、session、原命令与随机 handle 绑定；Windows 端口归属由 OS Job 成员核对。`managed_process.schema_version=1` 回执随原会话工具结果持久化，活句柄只在当前后端有效，重启后拒绝拿旧 PID 替代。运行/端口归属不是网页或业务就绪证明。旧无句柄 unknown 不回填、不根据 HTTP 200 或用户回答消除；仅同 owner 对同 handle 的进程组退出回执可结清该组此前不确定的 stop。

`codepro__task_contract report_blocked` 是 Main Agent 提出的用户可读受阻交接，不是 Completed 或授权。宿主复用原 Pause/终态路径提交暂停，原 unknown 与未完成要求保留。正常预算 Finalize 保留一次无执行工具的交接机会；自然语言不反向改变控制事实。相关实施及未验收边界见 `docs/superpowers/reports/2026-09-27-codepro-1504-journey-repair.zh-CN.md`。

展示侧仍从原 todo/工具回执消费计划和修改记录；工具输入预览只按 call ID 展示，不能作为执行或文件已写入的证据。

### 2026-09-25 公开进度有限扩展

用户批准统一对话体验实施，并要求直接完成到 E2E-ready。本次增加展示专用 `codepro__publish_progress` v1：Main Agent 是公开说明的作者，宿主仅校验结构与长度并写入现有会话请求/回执，桌面按同一 call ID 消费成功回执后显示正文。它不产生授权、要求修订、执行证据、失败计数重置或终态。旧会话无此请求时保持原呈现；失败请求保留错误，不当作成功说明。没有新增状态库或控制事实 owner。原因及迁移边界见 `docs/superpowers/reports/2026-09-25-codepro-conversation-experience-implementation.zh-CN.md`。

1. 每项事实只有一个业务裁决者；其他模块只能校验边界、执行动作或建立展示投影。
2. 原始输入、候选解释、已验证合同、运行事件、证据和报告是不同对象，不能相互冒充。
3. 新增跨层字段时同时写清 owner、唯一 writer、consumer、持久化位置、版本及失效规则。缺少任一项时，该字段不能成为新的硬门禁。
4. 子目录 `AGENTS.md` 可以细化局部实现方式；与仓库级协作规则冲突时以更深目录为准。若局部规则改变本表的事实所有权，必须连同本文和跨层协议一起修改。
5. 表中的“迁移断点”是当前需要核对的已知双轨位置，不应被当作长期允许的第二权威。

## 权威来源与消费边界

| 事实 | 权威 owner 与唯一 writer | 持久化或版本 | 合法 consumer | 禁止的第二裁决 |
| --- | --- | --- | --- | --- |
| 原始用户输入与会话历史 | `crates/goose/src/session/` 的 `SessionManager` 及会话写入入口 | 会话消息 ID、顺序和持久化记录 | 路由、Planner、恢复、报告引用原文 | 任何下游改写原文来证明不同目标或授权 |
| 入口模式与初始安全路由 | `agents/codepro_intent.rs` 生成；`agents/codepro_routing_evidence.rs::CodeProRoutingEvidence` 提交当前消息进入普通回答、CodePro 或拒绝/澄清等入口决定 | `schema_version`、来源消息、build provenance | ACP 分流、执行入口、诊断 UI | 把入口 intent 枚举当成运行中每一步业务动作，或由 Planner、报告、UI 再从自然语言重分类 |
| 运行中的语义决策 | 目标 owner 是 Main Agent；它基于已提交 Observation 提出版本化 `AgentDecision`，决定 `Respond/Act/Delegate/RevisePlan/AskUser/ProposeFinish/Stop`。当前 Coordinator 仅是旧 DAG 管理协议，不代表该目标已落地 | requirement/plan revision、decision ID、引用的 evidence IDs | Action binder、Planner/Worker 委派、完成评估 | 入口路由、Scheduler 或字符串规则替模型决定具体技术下一步 |
| 用户要求的版本化解释 | 原始用户输入始终保留；Main Agent/Planner 只提出 `UserRequirement` 候选，用户修正可覆盖；目标唯一提交者是宿主 `RequirementReducer/Registry`，负责来源绑定、revision 和授权边界，不负责发明语义。该提交组件尚未落地 | 来源消息、requirement ID、解释 revision、不确定项、用户修正、状态 | Main Agent 决策、计划提案、完成语义评估 | 把模型候选、Planner JSON、TaskDAG 或报告文字直接当作已提交用户目标 |
| 计划拓扑 | 目标 owner 是宿主校验并提交的 `PlanGraph`；Main Agent/Planner 只提出语义候选。当前 `TaskDAG` 仍同时承载拓扑和运行字段，是待拆分的过渡控制源 | `plan_revision`、修订审计、task/edge identity；task 状态变化不得产生新 revision，只有显式 `RevisePlan` 可替换拓扑 | Scheduler、恢复、TaskInput 绑定、验收映射 | 把完成节点从当前图删掉、用 retry/resume 冒充 replan，或让兼容 DAG 静默改图 |
| 任务执行合同 | 宿主校验后的 `TaskContract`；模型可提出目标、输入、行为和验证建议，宿主只做结构、安全和引用校验。当前 scope 字段仍混有权限兼容语义，属于迁移债务 | task/contract revision、requirement 来源、input/evidence 类型 | Worker 输入、验证策略、完成义务 | 从任务文案补造合同，或把合同目标等同于权限授予 |
| 动作授权与 CapabilitySet | 目标 owner 是宿主 Authorization/Execution Policy；根据原始用户授权、系统策略、工具策略、工作区和当前 Action 生成最小 `CapabilitySet`。当前工具权限仍分散在角色、TaskContract 和工具层，尚未统一 | authorization revision、action/attempt ID、scope、有效期、撤回/失效原因 | Action dispatcher、工具边界、审计与恢复 | PlanGraph、Planner、AgentRole 或 `RevisePlan` 扩大权限；旧 capability 跨授权 revision 复用 |
| 任务间结构化输入 | 正式 `InputEdge` / `TaskInputRef` 声明来源关系；普通 Dependency 与 `RecoveryEvidence` 等关系分别验证。当前 `TaskDAG.depends_on`、`TaskInputRefV1` 和 `TaskInputEnvelopeV1` 是兼容实现 | run、plan revision、consumer/source task、input kind、producer attempt 与 evidence ref | Scheduler 和对应 Worker | 把失败摘要拼进 description，或由 Worker 根据“参考 task-1”自行找上游事实 |
| 运行与任务生命周期迁移 | `agents/control_plane/reducer.rs` 是唯一业务裁决者：校验 `ControlCommand` 相对当前 Projection 是否允许，并产生事件意图 | command、当前 sequence、plan revision、状态迁移规则 | `RunEngine` | EventStore、Projection、Scheduler、报告或 UI 独立决定状态迁移 |
| 运行事件提交与持久化 | `RunEngine` 负责命令校验、调用 Reducer、物化事件和原子提交；`RunEventStore` 只按 sequence 追加/读取事件，不作业务判断 | append-only event、sequence、command receipt | 恢复、重放、Projection rebuild、审计 | EventStore 根据内容重新解释业务语义，或绕过 Reducer 写入生命周期事件 |
| 运行状态派生视图 | `reporting::RunProjection::rebuild` 从已提交事件确定性重建；它是派生视图，不是 writer | 最后 event sequence、plan revision、task/agent/effect projection | 调度、恢复、收敛、报告、ACP/UI | 直接修改 Projection，或用本地 DAG/UI 状态覆盖已提交事件 |
| 动作尝试与未知结果 | 目标 owner 是 control-plane Action reducer + durable action/effect ledger；统一提交 `Proposed -> Authorized -> Dispatched -> Succeeded/Failed/Unknown/Cancelled`。当前 attempt/effect 记录分散在 Scheduler、Tester、Computer 和 effect ledger，尚未形成通用合同 | operation ID、attempt ID、plan/authorization revision、幂等/可重试属性、工具回执 | 恢复、重试、证据、进度和完成门槛 | 根据自然语言或进程退出猜测是否执行；Unknown 外部副作用自动重放 |
| 模型、动作、replan 与委派预算 | 目标 owner 是宿主 Budget Policy 与 control-plane reducer；模型只能申请额外预算。当前 action budget 仍部分保存在 `TaskDAG`，属于迁移实现 | run/task/action、budget revision、消耗事件、上限和耗尽处置 | Main Agent loop、Scheduler、报告 | 模型自行重置预算，或在压缩/恢复/replan 后丢失已消耗额度 |
| 原始工具执行事实 | 工具边界产生的结构化回执 | tool call/result ID、命令、退出码、时间、作用域、结果未知标记 | evidence normalizer、审计、恢复 | Agent 自述或关键词替代真实回执 |
| 规范化验收与工作区证据 | 最终目标为控制面引用的版本化 evidence；过渡期验证事实由 `TaskDAG::VerificationEvidenceV1` 保存，工作区 delta 只允许宿主在 implementation 完成门槛处根据真实文件观测确定性派生，并随 task evidence bundle 提交 | run/task/plan revision、产物或文件版本、evidence ref、失效状态 | `CompletionRequirements`、Reviewer、terminal report | Worker 自述 delta、通用输出 DTO 的可漂移副本，或 DAG ledger 与 control-plane refs 各自证明不同完成结论 |
| 独立审查结论 | `reviewer_agent.rs::ReviewVerdict` 的结构化 verdict，由宿主提交到控制面审查事实 | run、plan revision、review round、issues/remediation、approved | 收敛门禁、返工、报告 | Reviewer 任务自然语言或“任务成功”自动等价为 approved |
| 暂停、用户输入与恢复 | `agents/protocol::{Checkpoint, UserInputResolution}` 与控制面事件；文件恢复事务由 `CheckpointTransactionStore` 提交 | checkpoint ID、event sequence、待完成任务、未知结果动作、用户决议 | 恢复调度、ACP/UI、报告 | 从最终文案猜 checkpoint 存在、恢复策略或用户授权 |
| 语义交付判断 | Main Agent 默认根据权威 Observation 提出 `ProposeFinish`；风险策略、用户要求或证据冲突时由独立 Reviewer 复核。它只能提出语义结论，不能提交终态 | requirement/plan revision、语义结论、引用 evidence IDs | ConvergenceEngine、报告事实构造器 | Scheduler、Convergence 或报告自行解释用户委托是否已交付 |
| 完成硬门槛 eligibility | `ConvergenceEngine` 根据宿主从 Projection、Evidence Store、Authorization 和风险策略构造的要求判定 Eligible/InProgress/Blocked；当前 `CompleteRun` 仍可携带调用方 requirements，是待修复边界 | 当前 requirement/plan/authorization revision、evidence refs、blockers | Reducer、报告事实构造器 | 申请完成者自行选择门槛/evidence authority，或 Convergence 改写语义交付判断 |
| 正式运行终态 | control-plane Reducer 是唯一 writer；仅接受通过语义提议和硬门槛校验的完成 command/event | terminal event、sequence、run state | Projection、恢复、terminal report、UI | legacy run state、Scheduler、Reviewer 文案或报告自行宣布 Completed |
| 最终报告事实 | `codepro_terminal_report.rs::build_report_facts(ReportFactsInput)` 是当前宿主 Builder/Projector；`CodeProReportFacts` 只是不可反向写状态的数据结构 | 终态 event sequence、引用 evidence、limitations/recovery action | `ReportDraftV1`、确定性 renderer、ACP/UI | Report Writer 或报告文字反向改变 outcome、验证、权限或恢复动作 |
| 压缩/恢复后的 Main Agent 上下文 | 目标 owner 是宿主 Context Assembler；从已提交 requirement revision、plan revision、RunProjection、未完成/Unknown action、blocker、EvidenceRef 和不可重复副作用装配一次模型输入。当前仅有部分会话压缩与 checkpoint 机制，尚未形成统一装配器 | context assembly revision、来源 event/evidence IDs、压缩 operation ID | Main Agent/Planner/Reviewer 模型调用 | 自然语言摘要成为状态权威，或模型从旧对话自行猜测当前授权和动作结果 |
| 父会话上下文占用 | 父会话实际 provider usage/update；未知时保持未知 | session/message usage 记录和 context limit | 输入栏容量提示、自动压缩预算 | 把子 Agent 多次请求累计量当父上下文占用 |
| 子 Agent 单次请求用量与压缩生命周期 | 共用 subagent/provider 边界写入带 origin 的 `worker_usage`、`compaction_lifecycle` | parent session、run/task/role、worker session、operation ID | 任务面板、诊断记录、对应 worker 的状态视图 | UI 把不同 worker 相加为某一请求上下文，或从进度文案推断压缩 |
| 用户界面状态 | 后端 ACP 结构化事件经前端 store/reducer 形成 projection | session/run/task/operation identity 与重放状态 | React 组件只读展示 | 组件局部状态、文本关键词或动画反推后端控制状态 |

## 当前迁移断点

这些位置在收敛完成前必须显式标注“谁暂时提供数据、谁最终裁决”，不得用兼容桥掩盖双写或双判定。

| 断点 | 当前风险 | 收敛方向 |
| --- | --- | --- |
| `TaskDAG` evidence ledger 与 control-plane `evidence_refs` | 两边覆盖范围可能不同；一个评估放行后，另一个提交阶段仍可拒绝 | 将规范化证据一次写入并引用；过渡期的 authority 枚举必须被 assessor、reducer 和持久化层一致解释 |
| `TaskDAG` Ready/依赖/状态 与 `PlanGraph + RunProjection` | Durable 批次选择的 Ready、全局生命周期 blocker 和 repair 依赖已改由同 revision 的 `RuntimeSchedulingView` 提供；完整 PlanGraph 在任务完成后保持不变，TaskInput/evidence 使用 runtime 当前 revision；Scheduler 仍从 DAG 读取任务描述、合同、恢复上下文、结果账本及其他兼容状态 | 继续迁移剩余依赖输入与状态迁移；全部切换前明确称为过渡控制源，不称为只读镜像 |
| host retest resume 与 plan revision | 当前 `commit_host_retest_resume()` 用同拓扑的新 revision 使验证任务重新入队，plan revision 暂时代替了 retry/resume attempt | 建立通用 Action/Task Attempt 状态机后，恢复只新增 attempt；仅拓扑、合同或义务变化才 `RevisePlan` |
| TaskContract scope 与动作 CapabilitySet | 当前 TaskContract、角色工具列表和工具自身策略都携带部分权限语义，撤回与失效规则不统一 | Authorization Policy 生成绑定 action/attempt 和 authorization revision 的最小 CapabilitySet；计划和合同只能申请/消费，不能授予 |
| `CodeProRunState` 与 `RunProjection` | legacy 状态先得到 Completed/Paused，control plane 再给出不同终态 | legacy 仅作兼容快照；control-plane reducer 是最终提交者，报告读取已提交投影 |
| DAG 中的 Reviewer 任务与独立 `ReviewVerdict` | 通用 Planner 已不再创建 Reviewer 节点，宿主 Reviewer 消费 `TaskDAG::verification_disposition()`；专用桌面验收 DAG 仍保留 Reviewer 节点 | 只保留一个结构化审查提交入口；专用 DAG 的复核结果也必须显式产生或引用同一 verdict |
| task-level checkpoint 与 run-level checkpoint | 任务已保存局部检查点，但终端事件可能没有可恢复 checkpoint ID | 用一次事务提交运行暂停、checkpoint 和恢复策略；UI 只展示已提交 ID |
| 父会话 usage 与 worker usage | 父会话无 usage 时 UI 显示未知，worker 已有用量却只存在于旁路消息 | 保持口径分离，但在同一状态模型中明确显示当前 worker 请求，不伪造父上下文总量 |

## 修改路由

| 要修改的行为 | 先查 owner | 主要 consumer 或相邻边界 |
| --- | --- | --- |
| 意图、只读/修改分流 | `codepro_intent.rs`、`codepro_routing_evidence.rs` | ACP server、执行入口、路由证据 UI |
| 用户要求解释、计划、任务合同与验收义务 | 原始会话 + 主 Agent/Planner proposal + 宿主 PlanGraph/contract 校验边界；当前兼容入口在 `planner_agent.rs`、`task_dag.rs` | `task_scheduler.rs`、恢复、Completion Evaluator 与 convergence |
| 工具回执、命令和文件变更证据 | `task_scheduler.rs` 的结构化采集/normalizer | DAG evidence bridge、control-plane event/result |
| 任务/运行状态与终态提交 | `control_plane/{runtime,reducer,convergence}.rs` | `agent.rs` bridge、checkpoint、terminal report |
| 审查与返工 | `reviewer_agent.rs` 的结构化 verdict | DAG 修订、control plane、report facts |
| 暂停/继续/用户确认 | protocol、runtime、checkpoint transaction | ACP server、session store、任务面板 |
| 最终用户报告 | `codepro_terminal_report.rs::CodeProReportFacts` | report writer、确定性 renderer、UI |
| token/压缩显示 | provider/subagent 结构化事件 | ACP adapter、chatSessionStore、任务面板与输入栏 |

任何模块发现上游事实缺失时，应返回“缺少哪个结构化事实、来自哪个 owner、绑定哪个版本”，而不是重新解析自然语言补造事实。安全边界可以拒绝危险动作，但不能借安全兜底改写用户目标或伪造完成。

### 2026-10-05 Mac 桌面验收先决条件接线

在用户继续对齐 Windows 功能的范围内，修复 Scheduler 的非 Windows 恒 false 门槛。现有原生电脑助手是 OS 环境事实的唯一读取者，doctor 新增内部版本 1 desktopEnvironment；Scheduler 只消费结构化 desktopAvailable/permissionAvailable，不解析 text，不改变 Reviewer 决策、Checkpoint、ACP 或持久化格式。事实仅用于当前 Reviewer 启动，不缓存、不授予任务权限、不构成验收证据。每次动作仍由原生工具执行既有权限与目标校验。

相比在 Rust 再读一套 TCC／Quartz 或放开所有 Mac，调用已打包的 Swift 助手保持同一 OS 读取实现；直接启动助手使 3 秒超时可结束并回收唯一探测子进程。输出上限 64 KiB；旧助手／非法结果保持等待，Windows OpenInputDesktop 保留。版本随同包部署，不新增模型可调用工具、公开 ACP 接口或状态库。锁屏补充信号的非公开键兼容限制及真实桌面待验收边界见 MACOS_PARITY_ZH_CN.md 的 stage26。


### 2026-10-07 stage28：已批准先交付 Mac 只读审计与取消

用户在 stage27 具体方案后回复“允许”，批准调整 MACOS_CLEANUP_DESIGN 第 5 步：原有 workspace_lease 继续拥有 root/session/run/sourceMessage/nonce 校验与生命周期；cleanup::Inspection 读取目标摘要。Mac 仅连接 audit/cancel，明确返回 executionAvailable=false；Agent 通知也携带同一平台能力，UI 只消费该结构化字段。Windows 回应新增 true，旧 Windows 无该字段仍保留原语义；非法字段拒绝显示动作。

Mac 审计回执仅在内存中保存持有的 Inspection 与原能力。审计提交、取消和会话撤销按同一 receipt→capability 锁序串行，撤销期间的检查不得重新插入回执。取消令 audit token 失效，只在原有效期内释放原只读能力以便重新选择；过期不续期、不恢复权限，重启不载入回执。五个其余清理入口继续由后端返回 cleanup_read_only；通过检查不授予隔离、删除或恢复权限。没有新增持久化库、修改 Windows 日志或降低精确对象写入保证。

### 2026-10-16 已批准：Mac 凭据保护

`runtime/secrets.mjs` 继续拥有配置密文的保护/解封调用边界。Mac 独立 `codebuddy-credentials` helper 通过 Security Keychain 持有随机主密钥，以 CryptoKit AES-GCM 处理版本化密文；打包流程拥有 helper 的固定路径、哈希和签名身份。解密只读取已有密钥，缺失或无权访问时失败；不改变 Harness 执行或 MCP 权限所有权。Windows DPAPI 数据不迁移。

繁體：Mac 獨立憑證 helper 擁有 Keychain 主金鑰與加解密，既有設定與 Harness 權威不變。English: The standalone Mac credential helper owns its Keychain master key and encryption; existing settings and Harness authority remain unchanged.


## 2026-10-20 已批准：媒体实时预览消费者

`comfyui-tool.mjs` 继续独占任务收据、状态确认与产物落盘；`comfyui-live.mjs` 只缓存该任务 WebSocket 的节点进度和最近预览帧，不裁决任务或 Agent 完成。认证后的 `_codebuddy/media/jobs` 根据宿主持有的会话目录读取收据并复用原发布逻辑，不接受客户端指定服务或文件目录，不提交、取消或重放生成。帧数据不进入模型工具回执或对话持久化。前端右侧仅消费结构化观测，断线保留提示并重试；已完成产物通过原工作区媒体协议播放。旧收据无需迁移，关闭窗口后生成仍归 ComfyUI，关闭宿主清理观测连接。

繁體：工具持有收據與落盤，WebSocket 快取僅供預覽；右側透過認證 RPC 消費，不重新提交生成。English: media tools retain receipts and publication ownership; WebSocket observations are transient, and the authenticated side-panel consumer never resubmits generation.

## 2026-10-26 已批准：桌面路径打开与桥接复用

用户批准在既有电脑控制 MCP 增加 Windows `open_path`，接受明确的本地文档／文件夹路径，不接受命令、URL、网络路径、脚本、可执行文件或快捷方式。独立 Go MCP 校验路径和前台输入启用状态，经系统默认应用打开；Harness 继续拥有工具启用、审批与执行事实。此能力不调整原生 Shell 沙箱，也不通过保活任务延长 Shell 子进程寿命。启动受理与画面验证分别报告，旧九工具及 macOS 合同保持兼容。

### 2026-10-27 已批准：电脑控制提示与取消连接

**2026-10-28 用户追加修订：移除全局状态条。** 下述紧凑状态条及恢复按钮方案撤回。Electron 不再渲染全局电脑控制卡片或状态条；Esc 保留暂停，原因在原对话工具结果和回复中说明。新的显式用户 prompt 在无在途动作及无有效活 lease 时解除旧暂停（含旧文本及 owner_lost 标记），只开始新输入对应的任务，不复活旧对话。已受理的原对话插话可以解除自己的本进程暂停；其他活对话和在途动作仍受隔离保护。内部 desktop/control 协议保留兼容，后台任务与压缩不自动恢复。当前实际产品验收以本轮报告为准。

繁體：使用者要求移除全域狀態列；透過對話新訊息繼續，沒有在途動作或有效活 lease 時解除舊暫停，不復活舊任務。English: The user requested removal of the global status bar. Explicit chat input releases idle pauses without restarting old tasks; live ownership and in-flight actions stay protected.

**2026-10-28 用户批准简化交互，覆盖下文鼠标基准及永久接管语义：** 鼠标移动不改变暂停状态；点击、滚轮、键盘输入由原生 MCP 记录为瞬时输入版本变化，旧观察随即失效。安静 600 ms 后允许重新观察，等待超过 3 s 返回本次输入冲突；不自动重放动作，也不写永久暂停。Esc 与暂停按钮保留明确暂停。协调器继续独占桌面 lease、队列、暂停与恢复事实；原轮次结束且无 live lease 时，原对话的新显式 prompt 可以解除自己的 Esc/manual 暂停，后台任务和压缩不触发。旧 mouse/keyboard/cancelled 标记在无占用的新显式 prompt 前退役，未知或 owner_lost 标记保留。停止等待原生动作收尾后释放自己的暂停；不续接已停止任务。Electron 消费结构化状态，显示紧凑状态条和所属对话入口，空闲时隐藏。Harness 的执行、审批与完成权威保持不变。此为本项目经批准的实现；Codex 截图仅提供交互参考，不据此推断其私有算法。

繁體：移動滑鼠不暫停；實際輸入使舊觀察失效並要求重新觀察。Esc／按鈕明確暫停，原輪次結束後可由原對話新訊息繼續；停止收尾後釋放暫停。介面使用緊湊狀態列。English: Pointer movement does not pause. Input invalidates observations; fresh observation is required. Escape/button pauses explicitly; a new prompt in the original chat may resume an ended turn. Stop releases its pause after cleanup. UI projects a compact status bar; Harness authority is unchanged.

**2026-10-28 用户批准修订，覆盖下段旧 Esc 语义：** Harness 仍是任务执行、审批与完成的唯一 owner。`runtime/desktop-coordinator.mjs` 只拥有共享桌面控制权、等待队列及接管闸门；独立内部 `desktop/control` 请求负责 pause/resume/withdraw/state，Esc 不再调用整轮取消。旧客户端携带 desktop token 的 session/cancel 也只暂停桌面；普通 session/cancel 保留整轮停止。用户接管闸门在本机用户目录持久化，阻止其他 profile 自动抢占；活 lease、窗口与元素不作为可恢复输入保存。原生 MCP 检查宿主 lease/generation，恢复后清空旧 UIA 观察；底层输入钩子写接管标记，原生动作在输入与观察边界检查。Electron 只投影状态和提交用户明确恢复，模型无解除闸门工具。暂停首次返回工具级受阻结果，独立非桌面步骤可继续；重复桌面提案等待恢复后作废，不重放。待测状态及未覆盖平台以本批验收报告为准。

繁體：Esc 僅暫停桌面控制；使用者接管後須明確恢復，多對話共用桌面控制權，恢復後重新觀察。Harness 保有任務與核准權威。English: Escape pauses desktop control only. Human takeover persists until explicit resume; conversations share one desktop lease and re-observe after resumption. Harness retains task and approval authority.

**2026-10-28 恢复交接修订：** 原接管标记兼容扩展为 revision/reason/at JSON，旧纯文本标记仍保持暂停，原因显示未知。原因由原生输入钩子或协调器写入，展示层不解析报错或模型文字推断。协调器的 paused/stale/withdrawn 结果经 Harness 适配、ACP 元数据投影到工具行，不改任务完成判定。恢复请求核对用户看到的占用会话；已停止任务只解除暂停，不自动续接。原生输入新 lease 重新建立鼠标基准。Electron 提示层暂停时隐藏复用，断连/退出销毁；加载完成时再次检查活动状态，加载失败明确提示。

繁體：接管標記相容舊純文字並加入結構化原因；原因及工具受阻狀態由宿主提供，介面只顯示。恢復核對佔用對話，已停止任務不自動續接；新 lease 重設滑鼠基準，提示層暫停時隱藏重用、斷線時銷毀。

English: Pause markers add structured reasons while retaining legacy text compatibility. Host-owned outcomes are presented through Harness/ACP without changing completion authority. Resume checks the displayed owner and never restarts cancelled work. A new lease resets the pointer baseline. Overlays are hidden and reused on pause, disposed on disconnect, and checked again after loading.

用户批准完整控制提示方案。Harness 实际工具开始与 prompt 结束驱动仅实时的内部 `desktop_control` 展示事件；Electron 只投影顶部提示，不从自然语言或历史回放判断正在控制。Esc 复用 `session/cancel`，附当前 prompt token；Compat 校验 token 与现有活动轮次一致后交给 Harness 取消，延迟消息不得取消新轮次。展示事件、动画和 token 不持久化、不新增 MCP 工具、不改变审批权限。传输断开、渲染器关闭或任务结束清理展示。

原生 Go/PowerShell/C# 层只绘制鼠标微光和短暂余光，既有目标校验、输入派发和 after-state 仍为执行事实。动画不阻塞动作、不抢前台、不消费点击。按用户确认，每块显示器拥有独立的 Electron 静态透明表面，顶部提示固定、边缘保持淡蓝微光；仅状态与显示器配置事件更新，不轮询鼠标、不逐帧重绘整屏。原生鼠标动画仍限于小窗口。用户明确选择保留当前模型思考设置，优化仅减少重复发现、重复观察和不必要的叙述。

繁體：Harness 的實際工具開始及 prompt 結束驅動即時提示，Electron 僅負責顯示。Esc 沿用 session/cancel 並核對當前輪次 token；舊取消不影響新輪次。原生層繪製微光與餘光，維持既有審批、輸入及觀察合同，不新增公開工具或持久化狀態，保留使用者模型思考設定。

English: Harness tool dispatch and prompt settlement own live control presentation. Electron only renders it; Escape uses session/cancel with the current prompt token, checked before native cancellation. Stale cancellation cannot affect a replacement turn. Native control renders pointer glow and afterglow without blocking input. Existing approvals, execution evidence and model reasoning preferences remain unchanged; no public MCP tool or persisted state is added.

同一 MCP 连接复用一个 Windows PowerShell 桥接进程，仅复用代码初始化，每次重新获取窗口／UIA／截图；窗口快照和元素索引继续由原有服务管理。桥接中断使本次动作结果未知，不自动重放，下一次显式观察可重新启动桥接。模型成功加载内置 computer-use 技能后，适配层从当前受限工具注册表展示入口工具，不启用关闭的扩展、不授予输入权限、不解析用户文本裁决意图。

繁體：既有 MCP 增加本機文檔／資料夾開啟入口；Harness 仍持有審批，橋接僅重用初始化，動作結果未知時不重放。English: The existing MCP opens explicit local documents/folders; Harness retains approval ownership. The bridge reuses initialization, not observations, and never replays an uncertain action.


### 2026-10-28 用户澄清：Esc 仅打断电脑控制，任务继续

Esc 不取消 Harness 轮次、模型请求或非桌面工具，不强制插入任务结束提示。原生输入先隔离桌面动作；DesktopCoordinator 根据结构化 escape 原因禁止本轮继续派发电脑工具，重复调用立即返回 desktopOutcome=stopped，不进入等待恢复的循环。工具回执仅显示电脑控制已停止；不把它提升为任务取消或完成。已派发动作可能部分完成，用户显式新消息允许重新控制后先观察核对。轮次 token 和桌面 lease 仍决定影响对象，旧通知不影响替代轮次。普通停止按钮仍通过 Harness 取消整个任务。

繁體：Esc 僅打斷電腦控制，保留模型思考與獨立非桌面工具；重複電腦呼叫立即回傳 stopped，不等待恢復，也不強制結束任務。顯式新訊息後重新觀察，不重播未知動作。

English: Escape interrupts computer control only, preserving reasoning and independent tools. Repeated desktop calls return stopped immediately rather than waiting for resume. No task-cancel terminal is generated. A new explicit message permits fresh observation without replaying uncertain actions. Harness retains whole-task cancellation authority for the normal Stop button.


### 2026-10-28 用户要求补充：反复打断与多对话桌面仲裁

正常电脑操作继续由 DesktopCoordinator 独占租约和串行队列管理，Harness 持有任务执行权。Esc 撤回当前所有已排队的电脑提案，其他工具继续；原生动作清理完即可释放租约，不必等待整个任务结束。共享暂停标记仍阻止其他旧轮次自动接管。只有已接纳的用户新消息重新允许对应 token；恢复不得重置其他轮次的停止状态。复用共享 epoch 识别其他进程错过的中断，旧轮次也要等待新的用户输入。已派发动作结果未知时先观察核对，不重放。无全局暂停／恢复条，无强制任务结束提示。

繁體：正常操作依租約串行排隊。Esc 讓既有電腦提案退出，非桌面工作繼續；清理完即釋放租約。僅新訊息的對應 token 可再次控制，其他舊輪次保持停止，共享 epoch 防止跨程序漏看中斷。

English: Desktop leases serialize normal operations. Escape withdraws existing desktop proposals while other work continues, and releases the lease after native cleanup. Only the admitted new message's token regains desktop access. Other interrupted turns remain stopped; the shared epoch prevents missed interruption across processes. No global resume UI or forced task-end notice is added.

电脑工具审批使用 DesktopCoordinator 的局部取消信号：Esc 只撤回电脑审批，Harness 记录工具停止结果并继续任务；文件等其他审批仍使用原任务信号。RPC 的通用 AbortError 由局部适配还原成结构化 desktopOutcome，不提升为任务取消。繁體：局部訊號僅撤回電腦審批，保留任務與其他審批。English: A desktop-local abort signal withdraws only desktop approvals; Harness retains task and other approval lifetimes. Transport AbortError is mapped back to the structured desktop outcome.

前端排队消息保存入队时的桌面 generation，自动发送通过 ACP 可选元数据 codebuddy/desktop-generation 透传。DesktopCoordinator 比较共享中断版本，旧排队消息仅限制电脑工具，独立任务继续；显式“立即发送”重新取当前版本。generation 不构成工具授权，原审批仍生效。共享 epoch 在 Esc 时持久化，暂停标记清理后仍有效。旧队列缺少字段按空版本处理，不删除数据；旧客户端缺少元数据维持原行为，因此升级验收需配套桌面与运行时。繁體：入隊版本隨訊息保存，舊訊息不因自動發送取得新的電腦控制權。English: Queued inputs retain the desktop generation captured at enqueue time; automatic delivery cannot renew a revoked desktop episode. The optional ACP metadata is a fence, not authorization. Legacy queues remain readable and conservative; older clients retain previous semantics and should be upgraded with the runtime.

### 2026-10-29 用户批准：连续三次输入冲突退出本轮电脑控制

原生 C#/PowerShell 判定输入冲突，Go 在 MCP 可选 desktop_control 回执中输出 schema_version=1 与 outcome=input_conflict/action_completed；Harness 适配层按调用透传，包括错误回执，不解析自然语言。DesktopCoordinator 独占计数：每个冲突回执加一（含仅刷新画面而未输入），实际动作成功回执清零；观察、排队及其他错误不清零也不计冲突。第三次复用共享 epoch 隔离本轮及既有排队的电脑请求，清理后释放租约；Harness 任务和非桌面工作继续。不新增恢复提示，不重放旧动作。新用户输入只允许对应 token 开启新轮次；旧排队消息保留原 generation。旧原生客户端缺少字段时不推测冲突，需配套新版工具验收。

繁體：原生層提供版本化結構回執，Harness 逐次透傳，DesktopCoordinator 累計三次輸入衝突後撤回本輪及既有排隊電腦請求。成功輸入才清零，觀察不清零。任務與非桌面工作繼續，無恢復提示、不重播；新訊息只重新允許對應 token，舊客戶端不從文字推測狀態。

English: Native code owns input-conflict facts, supplied through optional version-1 desktop_control MCP receipts and preserved by Harness even on errors. DesktopCoordinator counts once per receipt, including refresh-only outcomes; successful input resets the streak, observations and unrelated failures do not. Three conflicts fence the episode and previously queued desktop requests via the shared epoch, then release the lease after cleanup. Harness and independent tools continue. No resume UI or automatic replay is added. New input renews only its own token; legacy clients without receipts are not classified from prose and require a matched tool upgrade.

### 2026-10-30 已批准：当前聊天自动任务暂停与继续

原生 DSH Schedule 继续独占定时器、任务表、同一串行管理/投递队列、会话绑定和投递历史。CodeBuddy 对锁定 0.2.1-alpha.2 的内存加载扩展新增 `paused` 状态和 CAS 暂停/恢复操作；不引入 MichengAI 调度器、不删除重建任务、不复制任务状态。按钮与 `schedule_pause` / `schedule_resume` 共用此入口，`schedule_status` 只读本根聊天的任务；不额外增加批准弹窗，不授予文件、网络或子 Agent 权限。暂停仅阻止尚未进入原生投递的次数，已经投递到 Inbox 或开始运行的任务不取消。恢复保留原周期/时区并跳过已错过的次数；已过期的一次性任务结束且不补发。暂停任务保留 ID、历史及会话绑定，可编辑但不自动恢复；归档会话时暂停任务同样纳入原生停止处理。

现有 active/inactive 数据无需迁移。暂停状态使用同一任务表；不支持把含 paused 行的数据交给未扩展的旧版本（旧版严格解码会拒绝，不会暗中执行）。回滚前先恢复/结束或明确删除所有暂停任务，并保留原数据备份。升级 DSH 时版本与源码哈希门禁要求重审本扩展；上游提供等价暂停接口后删除本扩展，不能静默混用。兼容层只传输实际回执，前端只展示提交后的状态。测试通过不等同真实桌面验收。

## 2026-11-03 聊天发起安装

前台主聊天可提出 MCP 或技能安装。桌面逐次审批具体命令、地址或技能目标。扩展设置服务在真实连接测试成功后原子保存新扩展及当前聊天的选择，下一轮重新加载。技能管理服务校验下载预览、目标冲突及写入结果。模型消费工具回执。配置写入、握手、工具发现和具体工具执行各自有独立证据。

给定 GitHub 仓库时，宿主从该仓库读取根目录的 `server.json`。仓库身份、单一兼容的 Python stdio 包、固定位置参数和本地可执行文件共同确定可供审批的候选。清单缺失或候选不明确时，聊天仍可使用发布方文档给出的命令或 HTTP 端点。

繁體：前景主聊天提出安裝，桌面逐次核准。GitHub 清單與本機 CLI 提供候選，擴充設定服務測試連線後儲存。技能管理服務預覽、套用並讀回結果。

English: The foreground root chat proposes installation and the desktop confirms each target. A publisher manifest and matching local CLI can supply a candidate. Extension settings test the connection before saving. The skill manager owns preview, installation and readback.
## 2026-11-03 已批准：本轮电脑操作的窗口身份

模型在首次发现窗口前以 `window_title` 声明用户指定的准确标题；未指定时传空字符串。DesktopCoordinator 按本轮 token 保存该声明，重连、切换对话和新的窗口列表不能改写它。原生电脑工具消费租约元数据，并在输入前核对唯一可见窗口的标题、PID 与窗口句柄。目标不可识别仅阻止对应桌面操作，普通任务与原有权限审批仍由 Harness 管理。

繁體：每輪在探索前聲明指定標題，原生工具在輸入前核對唯一可見視窗的身分。English: The host binds the requested window title before discovery for each turn. Native input requires a unique visible match and the observed window identity.

## 2026-11-04 已批准：全局主对话与宠物消息

- `runtime/main-conversation.mjs` 与 Compat 是唯一主对话身份的 owner：通过不可由 ACP JSON 注入的内部标识创建，`globalConversation` 随现有会话原子持久化；并发获取合并，重启按记录恢复。官方 Harness 继续拥有执行与历史。
- 宠物仅转交输入；Electron 主进程选定主窗口并等待入队回执。主窗口输入栏仍是消息持久队列的唯一 writer，沿用忙碌排队、停止暂停、重启确认和送达状态语义。宠物拿到入队确认后才清除草稿；入队不代表模型已经完成。
- 主对话专属 `workspace_memory` 从已登记工作区按需只读召回。ProjectMemory 继续拥有候选／批准／禁用／过期判断，工具不得重新解释原文作为批准；返回来源，普通会话不注册此能力。文件系统与其他工具权限独立，不把记忆可读等同于跨项目可写。
- UI 消费 `globalConversation` 排除项目分组；角色工作区的列表来源为既有 `agentWorkspaces` 绑定，不另存第二份角色绑定。
- 宠物审批由现有前端 ACP pending request 注册表继续持有 resolver；宠物只显示该请求允许的操作，携带一次请求令牌交回原窗口。Electron 校验来源及任务归属，注册表拒绝过期令牌，不新增权限持久化或第二套审批策略。问题填答和工作区确认不转换成工具授权。
- 对话展示标题由 Compat 在首轮结束后更新既有 `title` 字段，上层驱动适配调用 Harness 公开辅助标题推理接口，使用已登记模型路由但不开放工具；纯工具交付或辅助推理不可用时采用 Harness 首条用户请求的标题。启动时仅为仍有占位标题的已有对话补投影原生标题。主对话、只读导入和手动 `userSetName` 名称保持不变。智能体名称作为既有项目别名初始值，和对话标题独立。
  - 繁體：工具直接交付或命名服務不可用時採用首個請求的標題，啟動時僅修復遺漏的標題。English: Tool-only replies and unavailable auxiliary inference use the first request’s title. Startup restores missing product titles from native history.
- 主对话清空由既有 `ConversationEditing` 在会话锁下执行官方空历史分叉并更新投影，保留产品会话身份与独立记忆；非主对话或活动执行不允许调用。原生日志按既有审计规则保留。Electron 转交 ID 沿用为队列及提交 ID，接收端按 ID 合并重复通知，禁止按消息文本去重。


### 2026-11-06 宠物菜单的草稿转交

宠物“＋”菜单通过既有带回执的主窗口通道转交草稿及 `composerAction`。Electron 校验宠物来源、载荷和动作；主输入栏保留已有草稿，追加新内容并打开技能／工具、智能体或目标／计划编辑模式。该回执只代表草稿接收，不入执行队列、不自动发送，不授予工具权限。普通宠物发送仍沿用既有持久队列。菜单目录缓存只用于展示，按项目、会话与语言隔离，实际选择仍走原有工具加载和审批。

繁體：寵物「＋」沿用具回執的主視窗通道交付草稿；Electron 驗證來源與動作，主輸入欄追加內容並開啟選擇或編輯模式。草稿回執不代表入列或執行，不會自動傳送或授予權限。普通傳送仍使用既有持久佇列；目錄快取僅供顯示，依專案、對話及語言隔離。

English: The pet add menu delivers drafts and a validated composer action over the existing acknowledged main-window channel. The main composer preserves existing content and opens the requested picker or editor. Draft acknowledgement never queues, submits, or authorizes execution. Ordinary pet sends retain the existing persistent queue. Menu snapshots are presentation-only and scoped by project, session, and locale; tool loading and approval remain authoritative.

### 2026-11-06 对话读取与原会话继续

简体：Store 在复制前筛选运行记录和元数据，返回的仍是独立快照；CodeProRuns 继续拥有最新运行的选择，Compat 的加载回包附带同次读取的会话信息，旧服务回包缺省时前端仍补查。普通回复的重试在同一个 Harness 会话提交继续指令，不复制原任务或附件、不截断历史、不分叉。`message-presentation.continuation` 仅控制该输入不显示为额外气泡，随原有会话投影保存和重放，不改变模型历史、权限、工具结果或执行所有权。右侧面板每次应用启动默认关闭并保留宽度；底部任务卡默认折叠。

繁體：Store 在複製前篩選執行記錄與中繼資料，仍回傳獨立快照；CodeProRuns 擁有最新執行的選擇，Compat 載入回包附帶對話資訊，舊服務缺省時前端補查。一般回覆的重試在原 Harness 對話提交繼續指令，不複製原任務或附件、不截斷歷史、不分叉。`message-presentation.continuation` 僅隱藏額外輸入氣泡，沿用投影保存與重播，不改變模型歷史、權限或工具結果。右側面板啟動時關閉並保留寬度；底部任務卡預設摺疊。

English: Store selects run rows and metadata before cloning and still returns detached snapshots. CodeProRuns owns latest-run selection. Compat includes session metadata in load responses; clients retain the extra lookup for older servers. Ordinary response retry submits a continuation in the same Harness session without copying the task or attachments, truncating history, or forking. The optional `message-presentation.continuation` flag hides only the extra input bubble and survives existing projection persistence and replay; it changes neither model history, permissions, tool receipts, nor execution ownership. The workspace panel starts closed while retaining its width; the bottom task card starts collapsed.
## 2026-11-07：扩展通知与预览源码身份

连接事实仍由 mcp-bridge / 原生 scope 持有；UI 的逐扩展通知去重只消费结果，不裁决连接、重试或权限。runtime/source-status 持有开发源码指纹诊断，server 通过只读 ACP runtime/status 暴露，桌面仅提示重启，不自动中断任务。启动器复用 profile-lock 的 SQLite 租约保护启动记录，不引入第二份扩展或会话状态。独立 Python 环境修复仍经现有 Settings writer 保存单项配置，离线写入需持有原 profile 锁。

繁體：連線事實仍歸 bridge／原生 scope；通知只去重。原始碼指紋僅供預覽診斷，不決定任務或權限。啟動與離線設定寫入沿用 profile 鎖與 Settings writer。

English: Connection facts remain owned by the bridge/native scope. Notification deduplication is presentation-only. Source fingerprints are preview diagnostics, not task or permission decisions. Launch and offline settings updates reuse profile leases and the existing Settings writer.

## 2026-11-24：技能目录的有界展示与内容版本

原生 `dsh-tool-skill` 继续持有完整目录、发布摘要、历史及加载权限。锁定版本的适配仅为主 Agent 的目录正文提供有界索引，完整 `source.entries` 保留；`search_mcp_tools(kind="skills")` 从原生、按 scope 过滤的快照分页返回候选，不加载正文、不授予执行权限。工具定义查询回执明确标记 `discoveryOnly`，真实业务结果仍来自工具执行回执。

文件技能目录沿用已有文档版本哈希，注册表适配从原生已选候选转交可选 `revision`；正文变化参与原生目录摘要，触发重新加载提示。可选 `source.presentation` 标识展示版本，支持冷恢复及配置回退；旧记录缺省时原生 owner 重新发布，历史消息不删除。未提供内容版本的其他技能 provider 保留原有失效语义。实现和回退边界见 `docs/context-discovery-sdk.zh-CN.md`。

繁體：原生技能外掛仍擁有完整目錄、歷史、載入與權限；有界索引及分頁搜尋只改展示。檔案技能的既有版本雜湊透過原生候選傳遞，正文變更觸發目錄更新與重新載入提示。可選展示版本支援冷恢復與回退，不刪除歷史、不建立第二套註冊表。其他 provider 未提供版本時沿用既有失效語義；查詢定義的回執不代表執行完成。

English: The native skill plugin retains the complete catalog, history, loading and permissions. Bounded indexes and paginated scoped discovery are presentation only. Filesystem skill revisions reuse the existing document hash and pass through native winning candidates; body changes republish the catalog with reload guidance. Optional presentation metadata supports cold restoration and rollback without rewriting history. Providers without content revisions keep existing invalidation semantics. Schema-discovery receipts never establish tool execution results.
