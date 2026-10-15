# Computer Use 移植实施记录

## 授权与基准

- 用户授权：以当前工作区为基准执行已讨论的移植方案，每阶段单独 commit；不是整分支 merge。
- 工作区：`C:\Users\admin\CodeBuddy`，分支 `fix/codepro-context-compaction`。
- 调查起点：`18753e4308ce3a746dc5d0d0cec31a548766601e` 加既有 dirty 内容。用户随后要求先提交模型路由，已提交为 `f7fd065b48ac8750135fe009d8e0ccffb51e22cd`，后续实施以此为基准。GitHub 来源仍固定为 `679ac67a0b7b864bab5b316db432c62b4e62f576`。
- [范围与验收矩阵](../plans/2026-09-28-computer-use-porting-inventory-and-acceptance.zh-CN.md)仍是实施边界；本文记录进度，不修改冻结架构。
- 只暂存本批明确归属的文件。模型设置、Main 路由、Agent/Scheduler、SDK 等相关改动已独立提交，不混入移植提交；其他规则及历史资料保持未提交原状。

## S0：基准保护

开始时暂存区为空。以下是已有 tracked dirty 文件的原始字节 SHA256，用于检查未被本批覆盖；不是将这些修改提交，也不是可用于独立重建的完整快照。已有 untracked 夹具、报告、`.workbuddy/` 和本地规则保留原位，不纳入本批。

```text
3FA04A219E3E2DF00CEE6D3617A899CC52A7BC2C130C493E01D7E4F7D5A1A535  AGENTS.md
FEE8B6EFA2BC6D469CAD8398064488A92E463B833117406164805002407694B7  crates/goose-sdk-types/src/custom_requests.rs
275042449D8293843F51667676AE15E319987C2FBEF840464C2AEDD6DFA03569  crates/goose-sdk-types/tests/codepro_model_routing_contract.rs
B9E782B115223C58545A0BA7C199B428F27816D1EEE7436B93CD79AF0DC88EE0  crates/goose/acp-schema.json
21FEEA8AEE6AA7ED6CB5ADE568412C0E7A9E70E362A4DECF3A50853C5B35313D  crates/goose/src/acp/server/config.rs
565DA835120D68C65AE8301729E7C573CCABCC9A4FA112288C111BD4C974DE49  crates/goose/src/acp/server/providers.rs
51241A73FC517D924BBA8CF059E011F791CAC19EF99934AFA29F5C7800888950  crates/goose/src/agents/agent.rs
6445D7658CFF7FE4CC6FBC9750279F9AE9937E49D7CAED862BB14DDD5F006CCD  crates/goose/src/agents/model_router.rs
F37C7DA06F1E9DCA7CBFAC3E806CE2023C325DADD38736E7C5DC8716A0D03CC0  crates/goose/src/agents/reply_parts.rs
D99A6A0D7374DC5E46D888EC08CC82F8F2A6CA946213B9AD04EEC7246EDDB812  crates/goose/src/agents/task_scheduler.rs
3E9E5852B487640023E381276812DA6D7C6760351F2622DD5D5E997478283C60  crates/goose/tests/acp_custom_requests_test.rs
B9FF0901E1638739E0FAD84DC41085F7FD717CF2062F1CB440F0E0D9AA5B3A24  documentation/AGENTS.md
75B0599BACEFCFFE45BA1DF8CEEBD44C16F008B4B7C5C213BD96D2B75938F448  documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md
DABC1E9C002979EB18DCE5234479EBE484875286E964883156D6EE06FEA092F3  evals/harbor/.agents/skills/compare_tasks/SKILL.md
8724FBF523EA245A3741FF893F53D48DFD08004ED3575913EF0D27130242B2A0  ui/desktop/src/acp/codeproModelRouting.test.ts
8A56D06775341D28CD983F7D8784754AFCAE9197C9A1B6FA9F8B6EAC9D3A1139  ui/desktop/src/acp/codeproModelRouting.ts
3303ADE02BDB7B9AF3CEC20F520A6EFBD6ADD2882330629029C5C54B9EAFAF1B  ui/desktop/src/components/codepro/CodeProModelModal.modelDiscovery.test.tsx
B2D7B44B02D0B93007EC8EA44E1077E7FEE0B902ABB13515E301E563E806B2B1  ui/desktop/src/components/codepro/CodeProModelModal.test.tsx
B4465C9E991CCC7CBBF7DAC139D83E122057E459E51B7A7A5407D8315BD57BEC  ui/desktop/src/components/codepro/CodeProModelModal.tsx
267C946CCE1DF007C12C4750F1804041E0CAC4C660B16CEE1D94F0B3AC80DE4D  ui/desktop/src/i18n/messages/en.json
B709CF1D011F6955447C9DD1AF7F62EDB629C82A70B4B92D946A04235DE1043F  ui/desktop/src/i18n/messages/zh-CN.json
7A2CDB810C4D045B687B57FAE7965802383D84461BA82382868314F47A997618  ui/sdk/src/generated/types.gen.ts
74C9F46B0AAE461DDC60E7F818FE97B31CA1E71098F162B3C7974E0B671AA0ED  ui/sdk/src/generated/zod.gen.ts
57092D7DA4EBEB4BFE3C83E6E5419C359A392815A77FF250732539E0C147202A  ui/text/AGENTS.md
```

行为保护：当前 Tool/Runtime/Permission 入口、Main 与停用保留模型组合、任务/计划归属、中文执行反馈、未知副作用处理均以当前实现为准。远端旧 Agent Loop、自动确认、固定内网视觉服务不导入。

验证：只读检查分支、revision、status、暂存区和文件摘要；未构建、未运行产品 E2E。首次移植文档暂存/提交因 Git 索引权限失败，未生成移植提交。随后遵照用户新指令，仅提交模型路由 21 个文件，`git diff --cached --check` 和 `git commit` 退出码均为 0；提交后暂存区为空。移植方案及本文仍未提交，Computer Use 产品代码尚未修改。

## S1：受控驱动与基础操作（进行中）

先验证内部 provider 的能力握手、坐标/截图绑定、取消与不重放边界，再接 Computer 工具。内部适配器尚未接入前不得称为可用功能；未完成权限、停止及消费者映射前不向模型开放驱动原始工具。

已发现并明确排除：来源适配器用错误文本触发重新建会话后重试输入。固定驱动的“未派发”保证尚无独立证据，本次不移植自动输入重放。

S1 开始时尚未执行驱动下载；后续经用户授权完成下载，结果见 S1a。仍未执行系统服务安装、真实电脑操作、视觉配置迁移、外发消息、完整构建与产品验收。

### S1a：内部驱动合同与固定资产

从固定来源提取 C01/C02，以及 C03 中的固定驱动资产校验；拆成内部 provider 模块，未注册新工具、未切换现有 ComputerClient。阶段性拆分只用于隔离提交与验证，不降低 S1 放行条件。

- 保留：窗口/进程/generation/transport 绑定，schema 指纹，桌面到窗口图片坐标换算，后台输入不自动切前台重放。
- 调整：取消错误文本触发的会话重启与重试；派发前消耗截图凭据；增加宿主观察实例 ID，防驱动复用 snapshot label 使旧凭据复活；PNG 头尺寸必须与元数据一致。
- 等待与关闭：观察/输入串行且等待可取消；关闭立即阻止新请求，分别限制结束会话与关闭 transport 的时间。MCP shutdown 默认不声称成功，真实 client 调用已有 close_with_timeout。这里只证明请求/transport 行为，未证明真实输入在取消时已撤销或物理按键已释放。
- 资产：来源固定 0.28.1、归档与文件哈希；现有损坏目录报错，不自动递归删除重装。资产准备函数接在既有脚本内，但本阶段不加入默认启动流程。二进制目录忽略提交，许可证固定 LF，保留 MIT 版权。
- 不变：模型路由、Agent Loop、Scheduler、Runtime、权限、计划/UI、消息检查点、证据留存政策均未改动。

用户另行批准下载固定版本。执行窄入口 `ensureWindowsCuaDriver()` 成功（退出码 0）；7 文件逐项 SHA256 匹配，路径 `ui/desktop/src/bin/cua-driver/0.28.1/windows-x86_64`。临时下载/解压目录已由脚本清理，不涉及用户资料或已有驱动。未安装系统服务。

验证：

- `cargo fmt --all`、相关 `git diff --check`、脚本 `node --check`：退出码 0。
- 资产清单 valid/missing/extra/corrupt 断言：退出码 0。
- `cargo test --offline -p goose --test computer_provider_cua --jobs 1`：最终退出码 0，21 项通过，测试本体 0.82 秒；均为假驱动/临时资产，不输入真实桌面。首次编译期间补入资产模块，使测试链接到旧库快照而报 unresolved import；稳定源文件后重跑同一目标通过，最终编译 3 分 56 秒。今后切片稳定后再启动编译，避免此类重复。
- Rust 复用 `ensure-dev-backend.cjs` 导出的 Windows 环境、Cargo 和 dev 配置，无新依赖/工具链/环境变更。仍有基准已有的 3 条 dead_code 警告。
- 固定驱动只读进程探测：校验全部资产后，仅发送 initialize 与 tools/list；57 个工具、14 个必需 schema 全部匹配。未发送 start_session、截图或输入请求；关闭 stdin 后驱动退出码 0。此项不代表 Rust 宿主接入或桌面 E2E。
- `cargo clippy --offline -p goose --test computer_provider_cua --jobs 1 -- -D warnings`：退出码 1（Cargo 101），被基准已有的 `crates/goose-provider-types/src/conversation.rs:221` 中 `MessageSlot` 的 `large_enum_variant` 阻断，尚未完成本包检查。已用 `git show f7fd065b4:...` 核对基准存在该实现，当前文件无 diff。未降低 lint 等级、未压制告警、未顺手改依赖包；不能标记 Clippy PASS。
- 完整 S1、产品构建/重启、A02–A07 的宿主到桌面验证、S2–S4 尚未完成。S1a 可作为未启用的独立实现提交，不能据此启用 CUA 路径或声明 S1 已放行。

接入前发现的现有边界：配置停用当前只写配置，扩展移除当前只移出注册表；两者还不能证明已缓存/在途 ComputerClient 停止。当前 computer_stop 会执行全局按键释放。S1b 必须在原配置/运行 owner 下补齐模块关闭、单任务取消和物理输入锁的范围，不搬入第二套全局业务状态，不误释放其他会话输入。本阶段未改变这些既有行为。

下一步：先处理严格 Clippy 的既有基准阻塞（独立小修或用户明确调整验收约定），再实施 S1b 宿主接入；不能用已有驱动探测替代权限/停止/真实产品回归。已下载驱动只是本地验证资产，不把二进制纳入 Git。

### 基线 Clippy 小修与验证节奏调整

用户批准单独修复基线问题，并要求中间不测试、继续选择性移植。`MessageSlot::NonVisible` 改用 `Box<Message>`；只改变私有临时枚举布局，原消息的克隆、顺序和输出内容不变。不添加 lint 豁免。执行格式化与提交差异检查，不运行测试、Clippy 或产品构建；本批改动的验证集中留到最终集成阶段，不沿用 S1a 的测试结果证明后续改动。

### S1b：基础输入与宿主生命周期接入（候选，未验收）

基于 `1cbc9fa2c`，继续从固定远端提取动作映射；不整分支合并。基础 focus/move/click/drag/scroll/type/key 接入原 Computer 工具入口，工具注册、角色/操作方式检查、物理输入锁、前后观察和后置条件判断仍由当前实现提供。没有驱动资产时保留原生路径；资产损坏/握手失败时拒绝，不在已派发后更换执行器。键盘保留当前前台语义，不搬入隐式后台到前台重放。

内部 stdio 不注册为外部工具，不提供模型 sampling、roots 或 elicitation；只把固定驱动作为执行器。进程沿当前 `SystemProcessGroupOwner` 的挂起创建、绑定、恢复、终止与等待退出机制管理，包括驱动辅助进程。每个业务会话有独立 transport/generation；连接失效只在后续明确观察入口清理，不重放之前输入。

扩展卸载会关闭原 Computer 客户端，缓存引用不能继续工作；ACP 配置关闭取消当前 Computer 资源，重开只重载原已启用的会话配置，不新增 worker 权限、不清空 available_tools。配置仍是启停 owner，弱引用表只用于释放资源，不保存第二份业务启用状态。单会话 stop 只关闭该会话驱动，释放输入先等待现有跨进程输入锁；驱动关闭无法确认时停止现有电脑客户端，不声称副作用已撤销。观察不再无条件替换仍有效的停止令牌。

平台资产准备接入既有脚本，沿原开发/打包复制目录；本阶段未执行下载或重建。与源端不同，未引入固定 LAN 视觉服务、旧 Agent Loop、自动审批、消息发送/文档追加/重命名的新路径。

按用户要求只执行 `cargo fmt --all` 与相关 `git diff --check`（退出码 0）；未运行新增代码的测试、Clippy、编译或真实输入。S1a 的 21 项通过不覆盖 S1b。结果/失败映射与 UI 消费继续作为 S2 检查，全部门禁未完成前不是可发布版本。

### S2a：输入结果不确定的端到端映射（候选，未验收）

基于 `2e90be9b0`。驱动适配器记录本次是否已跨入输入调用；窗口/坐标/取消等派发前拒绝可与派发后未知区分，不解析错误文本推断副作用。对输入可能已发生的失败保留现有 `outcome=unknown` 回执、原 trace 和可保存的前态证据，明确禁止盲目重试；证据保存失败也不能覆盖原来的未知事实。

Computer 通过仅进程内消费的结果标记报告未知，ExtensionManager 只信任已解析的真实平台 Computer 输入来源，移除标记后投影到既有 `ToolAuditOutcome::Ambiguous` 与 `ToolIdempotencyOutcome::Uncertain`。外部同名工具不能借该标记改变审计。超时/取消且已经进入 Computer 输入客户端时也保守保留不确定性。没有新增公共枚举、完成状态、权限 owner 或业务账本。

UI 消费已有 audit ambiguous，不再将它当成一般失败；同时保留“派发成功不代表验证成功”。修正 task-scoped 回执里 step_id 是任务 ID、attempt_id 才是调用 ID 的匹配边界，不把合法 worker 回执误判为未知；无任务 scope 时仍要求原调用身份。补充前后端针对这些边界的回归用例，但按用户要求中间不执行。

限制：新观察只让后续定位可用，不自动结清历史未知；本批不新增通用动作对账接口，也不改现有消息检查点的授权/终态。S1/S2 的实机并发、取消、退出、未知恢复和当前 UI 表现仍需最终验收，源码提交不等于放行。

同批收尾：输入已派发后的验证、截图、证据保存失败，也保留未知回执而不是退成可重试的普通输入错误；观察失效清理失败则关闭该客户端。初始化 future 被取消时将缓存 provider 标记失效，后续必须先显式观察清理，不能复用半初始化连接。配置名称沿原规范化函数匹配；更换扩展后立即失效工具缓存，不因旧客户端关闭失败留下旧缓存。仅加载/探测过而未请求过输入的 Computer 资源，关闭时不运行全局按键释放。

本阶段执行 `cargo fmt --all` 与相关 `git diff --check`，退出码 0。新增回归只落盘，未执行测试、Clippy、类型检查、构建或真实桌面输入；不是 S2 验收通过。

### S3 兼容决策（已选择独立视觉模型）

静态核对固定来源：视觉服务默认指向开发内网 `192.168.9.109:8001/v1`，使用独立视觉 provider/model 字段；当前接收方已有 Main 和停用保留组合，不能直接覆盖为远端配置版本。依据冻结清单 6/S3 与 9.5，先确定兼容增量再实施。已提出两种边界请用户选择：先复用当前有效且支持图片的模型、不新增配置格式；或本批增加独立视觉厂商/模型选择并明确升级/降级兼容。两者都禁止默认内网回退，视觉输出均不成为授权。未收到选择前不修改该公共配置合同；S3/S4 尚未实施完成。

用户随后回复“独立选择”，批准本批增加独立视觉厂商/模型选择。基于 `c43fe4537`，实施边界如下；之前的待定记录保留为过程记录，不代表现在仍待选择。

#### S3：配置与只读截图解读（源码候选，未验收）

- 配置 owner 不变，原键升级为明确版本 2，新增可选 `vision` 完整厂商/模型对及独立开关。版本 1 无视觉配置继续读取，不在读取时写盘；显式保存才写新版本。未知版本拒绝。旧客户端版本 1 保存不能覆盖已存在的视觉选择，兼容检查与厂商变更停用共用短写锁，不跨网络等待持锁。ACP schema 和 SDK 类型/校验器同步修改，最终生成器一致性尚未运行核对。
- UI 在原弹窗增加视觉辅助卡片，明确图片接收方和只读用途；不作为第六个执行 Agent，不加入主/子 Agent 同模型警告。视觉开关不受高级路由开关影响，开关往返与停用保存保留完整组合，不自动选择默认视觉服务。保存保留已有并发上限，避免仅修改视觉配置将隐藏并发设置重置为 1。厂商删除/模型移除分别停用受影响的 Agent 或视觉路由，保留选择。
- 新工具 `computer_analyze_screenshot` 沿现有平台工具注册/权限/Runtime/审计入口执行，标记只读但涉及外部服务；模型须显式调用，不给所有截图隐式附加请求。输入仅当前会话截图 ID 与有界问题；宿主校验 run/task（适用时）、Agent 和授权范围，读取内存中的已验证截图，不接受任意路径。等待初始化后再次校验截图有效期及配置；关闭模块、调用取消及会话 stop 取消请求。
- 采用固定来源的独立只读视觉解释思路、非可信观察与相对图片区域表达；没有搬入旧 Agent Loop、默认内网端点、自动裁切多次调用、跨会话缓存或失败后换模型。使用现有 provider 工厂与已配置凭据，无工具列表；排除可自主执行的 Agent/CLI 厂商。单次解读总等待上限 60 秒、输出上限 1024 token，沿 provider 原有有限网络重试及上层预算上下文，不新增业务重试循环。厂商目录当前不能可靠声明所有自定义模型的图片能力，保存只验证可用标识；实际图片拒绝明确报错，不根据模型名称伪造支持能力。
- 结果带实际 provider/model/usage、调用 trace、截图 ID/摘要、耗时及来源是否过期；视觉输出不升级为授权、身份验证或已完成事实。用量随原工具回执保存，不覆盖主模型上下文占用；尚未新增全局费用汇总。图片中的指令、越界坐标和额外动作字段不会成为执行命令。现有视觉消息发送检查仍要求原图实际交给当前模型，未因独立视觉描述放宽；这条 S4 高影响链路尚未移植。

落盘了配置兼容、独立开关保留、厂商删除隔离、视觉输出结构/坐标边界回归，并更新现有版本/工具清单期待。遵照用户要求未执行这些测试、Clippy、类型检查、产品构建、图片请求或 E2E。只执行格式化及差异检查：`cargo fmt --all`、工作区已安装的 Prettier 与 `git diff --check`。首次误用 desktop 层 Prettier 路径失败（1），改用已存在的 `ui/node_modules/.bin/prettier.CMD` 完成（0），未安装依赖；schema 格式恢复为原有 JSON 缩进，避免无关全量排版变化。

剩余：S1/S2/S3 最终集成门禁及真实产品验收仍未运行，S4 的消息、文档追加、文件重命名移植与验收尚未完成。当前运行的旧桌面不含本批源码，不能用其表现验收这些改动。

### 2026-09-28：阶段性 E2E 候选构建与启动

用户选择先亲自执行完整会话 E2E，再提供会话和日志定位具体问题；本轮仅构建、启动，不运行额外自动测试或 Clippy。工作区为 `C:\Users\admin\CodeBuddy`，分支 `fix/codepro-context-compaction`，构建基线 `017d2427879b040997a3f52497dad56de14e01dd` 加下述编译修正；已有规则文件和本地材料的未提交改动保留，不纳入提交。

- 首次 `pnpm.cmd run ensure-dev-backend` 失败（脚本退出 1、Cargo 101）：新增 stdio 适配器把 `Option<Arc<InitializeResult>>` 当作引用调用 `cloned()`。按现有 `mcp_client.rs` 的写法改为解引用克隆，不修改执行、权限或生命周期合同。`cargo fmt --all`、`git diff --check` 退出 0。
- 同入口重跑成功（退出 0，Cargo 报告 4m05s），保留三条已有 dead-code 警告。`target/debug/goose.exe` 与桌面副本 SHA256 一致：`BBE0B5C8F21971CB708D1E93207105857B86DE755190D07315E27D8BCDC5BA6D`。
- `pnpm.cmd run start-gui` 首次后台执行在 SDK 生成器写入 `index.ts` 时返回 Windows `UNKNOWN` 文件错误；以前台受控方式重跑同一入口成功（退出 0）。SDK 生成、SDK `tsc`、语言资源、Electron main/preload 构建完成。生成文件与手工同步内容只有导出/定义顺序差异，保留生成器结果。
- Forge 报告启动后未保持进程，按既有 `ui/desktop/BUILD_AND_E2E_RUNBOOK.md` 的备用步骤独立保持 Vite 并启动已构建 Electron；不修改构建环境、不安装依赖、不重复 Rust 构建。18:54 启动新桌面 PID 22048、新后端 PID 24836，后端端口 61912；18:55:03 日志收到 `React ready`。用户已确认无执行任务并授权关闭旧桌面，旧进程已退出。

这是开发模式的阶段性候选，不是 release 安装包，也不是 Computer Use 全部移植/验收完成。可由用户验证基础观察/输入、独立视觉配置与解读、停止及当前反馈；S4 新移植路径仍不在本轮完成声明内。未执行产品操作、真实发送、图片模型请求、Clippy 或新增自动回归；用户 E2E 结果待回收。

启动辅助日志位于 `C:\Users\admin\AppData\Local\Temp\codepro-cua-build-20260928-185238`；产品日志在 `C:\Users\admin\.CodeBuddy\logs\cli`，桌面日志在 `C:\Users\admin\.CodeBuddy\state\electron-app\logs\main.log`。用户沿用既有配置，本轮未改动模型或视觉路由选择。
