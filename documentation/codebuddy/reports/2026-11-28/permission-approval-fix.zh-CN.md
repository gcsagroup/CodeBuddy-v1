# 插话后的权限误拦与审批审查

2026-11-28。目录`C:/Users/admin/Documents/ChatGPT/codebuddy-v1`，分支`codex/fix-streaming-navigation-20261128`，开发基线`bcc6ab77731cc6f1c67985a83f71f1ecb0e41d15`加既有dirty。本批只修权限误拦；前批流式渲染、滚动、导航和DOCX改动不吸收入本次提交，不推送。

## 结论与真实证据

用户Aegis会话`2c9a6d4f-0756-4960-8a2d-0b16d931bf8b`为`danger-full-access`、原生`approval:never`。第3轮第6/7/8步的三次真实`write`分别尝试桌面MD、工作区MD和`.artifacts`文件，都在宿主执行前返回`APPROVAL_UNAVAILABLE`，并明确用户未拒绝。模型报告写不了有真实回执依据。这不是Windows访问拒绝、MD格式问题或17分钟标签准备复发；未重新修改Aegis文件、权限或原聊天记录。

根因是2026-11-16的补充逐次确认规则与后续原生引导/权限模式联动：原生用户消息或队列来源设置当前run的`supplementReceived`；后续主/子Agent非只读提案附`supplementReview`，原本`allow`也会被强制改成`ask`。遇到`approval:never`再确定性拒绝。标记在当前run中持续，不是持久化会话损坏；新普通prompt会重置。工作区子Agent也原生使用`never`，所以仅豁免根“完全访问”会遗漏同类误拦。

## 最小修复与所有权

产品只改`runtime/harness/driver.mjs`的补充升级条件：已有决策为`allow`且执行Agent的原生审批策略不是`never`时，才附加补充逐次确认。`never`下保留原判定，仍调用原生`next()`。

- 不将`never`解释为允许全部动作；已有`ask`、`deny`、`cancel`不变。
- 不跳过原生文件/命令沙箱、取消检查、单调guard或已挂载的reviewer。
- 不用根Agent模式替代子Agent权限；读取`exec.agent.session`。
- 不改变Compat的显式工具规则、安全检查、连接/会话身份、授权复用与失效；交互式补充确认仍为单次。
- 保留原生历史与真实回执上下文，不自动重放先前失败写入。

所有权地图与ADR-004同步记录该例外；未新增协议、持久字段或第二套授权存储。Auto reviewer未在当前产品profile启用，只核对锁定上游执行链仍保留其拒绝，不宣称跑过Auto集成测试。

默认发送方式另核：`defaultSettings.followUpMode`、hook缺省与当前QA配置均已为`steer`，本批没有改UI或强制迁移用户明确保存的选择。

## 按权限与行为审查

| 行为 | 只读 / 工作区 | 完全访问 | 本批验证或边界 |
| --- | --- | --- | --- |
| 原生文件读取 | 原生文件/路径规则处理；只读不是禁止读取工作区外的一切数据 | 仍消费原生文件规则 | 真工具回归、引用目录读取 |
| 原生write/edit | 只读拒写；工作区允许原生可写根，区外需要原有升级合同 | 已允许写不因插话失效 | MD读→引导→写、子Agent四格、真实FS_SANDBOX_DENIED |
| 原生临时目录 | workspace-write明确允许平台临时目录；不能把temp内的兄弟目录当区外 | 原模式 | 直接复用锁定上游writableRoots，先验证负例在全部根外 |
| 只读关联目录 / 目录身份变化 | 保留reference边界和失效检查 | 完全访问也不能绕reference边界 | project-folders实际写入与身份替换回归 |
| 原生命令与子Agent | 继承各自原生沙箱；子Agent通常不能自己弹审批 | 保留原审批和安全门 | 真45秒命令、取消/恢复/进程恢复、跨聊天隔离 |
| 显式never_allow / ask_before、安全复审 | 禁止先拒绝，额外询问仍需真实决定 | 完全访问不是这些规则的豁免 | 真实Compat策略、模块授权、安全分类器、未知与取消回归 |
| 外部HTTP/stdio MCP | 不受本地文件沙箱自动保护；首次授权及既有范围复用 | 仍受显式禁止、安全检查和连接身份约束 | 模块/调用隔离、重连/定义变化、跨聊天及撤销 |
| 浏览器 / CU | 单独的真实能力范围和授权 | 不绕站点、模块和scope边界 | native web、computer模块和过期选择回归 |
| 生图 / 视频 / 业务工具 | 独立服务与能力授权；不混用图像和视频grant | 不绕显式规则和服务身份 | image/video、business、真实ACP授权回归 |
| 队列 / 引导 | 可交互策略保持补充逐次确认；never保留既有allow | 主会话及后续队列可继续写 | 真实steer、queued native turn、拒绝/取消/未知回执 |

“文件沙箱”和“外部工具授权”是不同层；不能从只读文件模式推断任意MCP没有外部副作用，也不能从MCP的名字或远端hint直接放行所有工具。当前未发现需要另外修改的确定性越权或误拦；不把有限回归写成所有平台/工具行为穷举通过。

成熟机制对照采用范围而非照搬常数：[Codex公开协议](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)将`AskForApproval`和`SandboxPolicy`分开定义；never不等于取消沙箱。[Claude Code权限文档](https://code.claude.com/docs/en/permissions)区分deny/ask/allow及MCP规则，显式询问可在无人应答时拒绝。CBD本次保留这些既有职责，不引入新的权限框架。未从旧Codex安全文档跳转页推断当前桌面具体行为。

## Exa：取证后暂不修改

本地既有会话中，实际工具为`mcp__exa__web_search_exa`。workspace-write/ask的审批原因是`This operation runs outside the native file and command sandbox.`，同会话后续存在无新审批的调用；两条完全访问/never会话合计7次调用成功且无审批。没有证据证明每次搜索都问，也未证明这些Exa审批来自本次补充误拦。

当前连接配置整体加密，本次未解密或读取凭据；实际URL origin未知。原生请求schema只保存名称/描述/参数，不保存annotations；不能从该投影缺字段认定远端漏标。[Exa官方当前webSearch实现](https://github.com/exa-labs/exa-mcp-server/blob/main/src/tools/webSearch.ts)声明只读hint，但与本地含`objective`的schema不同，未证明版本一致。[MCP规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)的远端annotations不是自动授权依据。

原会话许可绑定owner与当前连接/catalog身份；重启、owner置换或catalog变化可能重新询问。按用户最新要求，Exa先保持现状，未调用真实搜索、未给外部MCP统一免审批；若要首次也免问，需要另定可信连接、查询外传与失效范围。

## 实际验证

使用现有Node与锁定Harness，未安装/下载依赖。所有写入均在新建独立夹具；真正区外用用户目录下随机`.codebuddy-native-boundary-*`新目录，先核对全部原生可写根；清理仅限该生成目录并检查父目录及前缀。

- 改前：`node --test --test-name-pattern='full access preserves allowed Markdown' runtime/tests/supplement-review.test.mjs`，exit1，读→真实steer→新MD缺失。子Agent工作区内写的新增矩阵同样exit1。
- 修后聚焦3测试exit0，含子Agent工作区内成功、真区外拒绝、只读拒绝、完全访问区外成功四格；native never下无审批请求。
- 首批12文件56项：55过、1项新增夹具错误。该夹具把只读根会话误当never，实际profile为ask；修正为“真实批准补充提案后，原生只读仍拒写”，未修改产品来迎合断言。首批其他文件44项已通过。
- 最终重跑受影响supplement整文件，加image/session-tool/stdio三文件，共35项，exit0；再跑project-folders两项，exit0。去重共81项、16文件通过。已有结果复用，不重复45秒命令测试。
- 中间区外负例误置于temp，官方允许temp使其成功；据原生事实改为真正区外，未收窄产品权限。测试静态导入SDK曾触发正式加载顺序保护，随后在driver启动后动态导入原生writableRoots；未改loader、版本或校验。
- `node --check runtime/harness/driver.mjs` exit0。未改前端或Rust，本批不重复前端构建或Rust测试。

### 真实GLM同会话四轮

独立夹具使用用户已授权的`OLLAMA_API_KEY`环境变量，密钥不输出；GLM5.3低档、既有原生driver和真实Compat工具策略、仅启用内置developer，数据与原Aegis会话隔离。运行`node .local/permission-approval-20261128/real-model.mjs`，最终exit0：

| 轮次 | 实际行为 | 耗时 |
| --- | --- | ---: |
| 1 | 读需求时真实引导，创建评估.md；新增原文要求进入文件 | 7.9s |
| 2 | 同会话继续读取并edit该MD，原补充要求保留 | 5.3s |
| 3 | 创建真实原生子Agent，父轮接收补充；核子Agent成功write回执及使用说明.md | 17.6s |
| 4 | 带queuedWhileBusy来源的下一原生轮，将汇总写入项目目录外、夹具目录内的交接.md | 6.9s |

四个阶段均核实际内容、长度与SHA（第1、2轮是同一文件的两个版本）；审批问题数0，APPROVAL_UNAVAILABLE数0。排队项验证的是后端队列来源合同，不冒充前端队列点击验收。结果与实际child ID/receipt在`.local/permission-approval-20261128/real-model-result.json`，夹具位于其中caseRoot，未自动提交。

真实夹具中间问题保留：最初缺少模型reasoningEfforts声明，在HTTP前拒绝low；另一次未选择内置developer，模型无法发现子Agent，虽然文件由主Agent写出也整体判失败。补齐与产品一致的夹具配置后再测，并强制核真实child写入回执；没有把主Agent自写当子Agent通过，也没有为夹具修改产品权限规则。前述失败分别保留`real-model-setup-failure.*`和`real-model-no-discovery.*`。

原始失败会话、回归日志和本批前快照在`.local/permission-approval-20261128/`，不提交。主要日志为`read-then-write-red.log`、`child-red.log`、`focused-green.log`、`regressions.log`、`final-supplement-and-external.log`和`project-folders.log`。独立Agent只读审查没有剩余产品Required，已采纳真正区外和只读根ask的测试纠正。

用户授权本批通过后单独提交、不推送；不是安装包发布或全部工具的真实窗口验收。原Aegis会话写入没有自动重放，既有未提交前端/导航改动保持原样。当前进程是否加载新版以重启收据和源码指纹为准，不能把旧窗口运行当成修复验证。
