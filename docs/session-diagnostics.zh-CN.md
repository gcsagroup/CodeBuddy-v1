# 日志导出

聊天菜单的“导出日志”先生成文件预览，默认选择标准日志；也可选择详细日志。标准文件名为 `session-log.jsonl`，详细版为 `session-log-detailed.jsonl`。首行包含 `log-export`、版本 `codebuddy-log-v3`、详细级别与 `restorable: false`，不冒充可恢复的原生会话归档。

Compat 的 `session/log/export` 沿用同一出口，缺省 `detail` 为 `standard`，也接受 `detailed`；不支持无处理原文模式。标准日志保留事件顺序、原始时间及相对耗时、轮次/步骤、真实模型/提供商标识、调用及请求 ID、结束种类、窗口容量、maxTokens/思考档位、工具名及声明、参数结构与非敏感控制值、压缩范围/被替换序号/token 统计，以及 stream 内的 usage 和 finish 分类。usage 标明来源，不重复累加。普通长 ID 不因长度或随机外观被当成凭据。保留的字符串仍处理已知密钥、个人资料和私有位置，不能通过模型名或 ID 绕过敏感值处理。

标准版的 `error` 保留处理后的原始错误码、message、stack、异常链、已记录的 HTTP 状态和请求 ID；`diagnostic` 单独保留原有 `publicFailure` 分类和处理建议。原始原因不会被通用提示覆盖，也不从错误文字推断 HTTP 状态、压缩预算或控制事实。工具 isError 的文本同样进入标准版错误记录；`TOOL_OUTCOME_UNKNOWN` 仍表示结果未知。可用的 request-id、Retry-After、内容类型和速率限制响应头可保留；认证头、Cookie 等不导出。

详细版额外提供普通工具输出片段；错误原因不再必须切换详细版才能看到。两种模式均不直接导出对话、思考、摘要正文、原始附件、replay payload、工具写入内容和任意未知字段值。摘录仍可能夹带自动规则识别不了的业务内容，不能保证工具读取回执或错误回显中绝无文件内容。schema 保留实际参数名、类型、必填项、数值/布尔验证约束与 enum 数量，描述/default/examples/enum 值不外发，因此不是 schema 全文。工具参数保留 offset/limit/timeout 等控制值，路径替换私有目录后保留定位线索；自由业务参数仍只保留形状。

错误内回显的已记录正文、结构化 messages/prompt/content 等请求内容及具名凭据会处理。URL 保留接口路径及 model/stream/max_tokens 等技术 query，认证、其他 query 值和私有主机隐藏；本机环回和明确的公开服务主机可保留。路径保留工作区相对结构或文件名、行列号，私有目录使用一致占位。自动处理不能识别任意自由文本中的业务秘密，故保留预览；保存的就是预览内容，无额外勾选。处理在后端完成，不调用远端模型。

只采用已经记录的事实，不读取今天的模型配置来补历史。缺少成功 summary 的压缩失败可能没有摘要路由/预算。`request/header` 是规范化的原生声明，其 tools 的 absent/empty/null/nonempty 状态按实际字段保留，但上游可能已经归一化，不能据此声称 HTTP wire 上发送了空数组。`adapterDefaults` 是布尔来源标记，不是预算数值。`parentSession` 是原生 seed/fork 关系，不自行提升为子任务调度权威。未知事件名称保留，未知 payload 不直接放行。

每段原始摘录最多处理 32768 UTF-16 码元，结果最多 4096；超出则整段省略并标记 truncated，避免先截断导致凭据前缀泄漏。错误和工具输出分别有 65536 原始码元预算，优先保留近期事件。已知正文匹配集合有独立的 4194304 码元预算，耗尽时只省略自由文本摘录，不抹去模型、ID、错误码和事件名。凭据扫描本身遇深度/容量限制时采用明确安全降级，不放行未检查原文。计量不是 UTF-8 字节数；运行特征、计数与标识仍可能用于关联会话。

桌面只保存预览的同一份字节，不在保存时重新读取变化中的日志。切换会话/级别或关闭预览会丢弃迟到读取；取消不写文件，读取/保存失败不回显原异常。新版桌面要求 v3；v2 的保真能力不同，不冒充 v3。旧客户端缺省请求仍得到标准日志，按首行版本识别新字段。`containsTextExcerpts` 两种模式均为 true，`includesToolOutput` 区分普通工具输出是否包括在内。

这种按字段处理、局部替换和预览的方式参考 [OWASP 日志数据排除](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude) 与 [Sentry 字段级脱敏](https://docs.sentry.io/security-legal-pii/scrubbing/advanced-datascrubbing/)。预览复用项目现有 Radix Dialog；异步读取按 [React 的迟到结果处理方式](https://react.dev/reference/react/useEffect#fetching-data-with-effects) 丢弃过期结果，未新增执行状态机。

完整历史没有删除或重写：`driver.exportSessionLog`、Harness 原生日志、检查点、工具回执和恢复输入继续采用原机制。只有下载副本被投影；导出不发起模型请求、工具调用或压缩。诊断文件不能导入为可执行会话，原始历史恢复应使用本机已有数据及正式备份流程。

“查看会话 JSON”“导出会话”仍属于用户选择的内容导出，会包含对话、工具内容等业务资料；它们不是本安全诊断出口，外发前需要检查。原始本机 Harness 日志同样不是脱敏文件。


已有产品历史中的结构化故障观察会放在导出头的 observations 中，明确标为 saved_product_diagnostic。它可能保留原生日志未持久化的 HTTP 状态；只按原始 run/user/operation 引用匿名关联，不按时间或报错文字强行合并，不改写原生失败。exportEnvironment 只表示导出时的环境，不冒充故障发生时的版本。

## 普通聊天的失败原因恢复

普通聊天的新失败沿用现有 transcript journal 保存脱敏终态卡片。只有 `publicFailure` 白名单分类、已观察到的 HTTP 状态及固定处理建议进入卡片；服务响应正文、凭据和本机路径不会作为错误说明保存。即时红字仍属当前请求提示，重启后从历史卡片的“查看未完成原因”查看。

旧版未保存卡片时，Harness driver 只读原生日志的 `turn/end`，Compat 将失败投影到对应的历史用户消息，不回填或改写原生事件。同一请求消费的追加输入仍归属发起请求的第一条消息，与直播记录去重；等待子任务时，由子结果通知、next-step 消息或原生 steer 引起的续轮也保留该归属。新排队用户请求、定时任务等独立输入，以及原生失败或取消会截断旧归属，不将后续错误套到旧请求上。原生按输出限制结束的轮次沿用原契约，不在重启后变成普通失败；手动压缩继续使用压缩生命周期。

读取期间若已有新输入或正在运行的轮次，旧读取不会补入终态。可选诊断和旧版停止记录查询共享两秒等待预算；失败或超时只降级原因展示，不挡住可读历史，迟到结果不再套入界面。取消信号仅传给只读观察，不取消会话中的模型或工具执行。已确认失败后才收到的停止不会抹去卡片中的真实故障，即使期间发生了后续原生清理轮；只在最终请求抛出的错误与本请求已观察到的主会话错误匹配时保留失败原因，不将子会话错误或此前已恢复的其他错误套入取消结果。先停止导致取消的情况仍走原取消流程。加载、刷新、查看原因均不自动推理或重放工具。

历史原生记录只有自由文本、缺少可公开结构化字段时，显示原因未知，不从文本猜测。极长历史的只读扫描仍随日志长度增长，本批未改造存储或引入扫描缓存。

## 验证边界

- `runtime/tests/session-log-export.test.mjs` 覆盖下载成功/失败的隐私哨兵、原日志不变、重启重导、事件对应及拒绝将诊断导入为会话。
- `runtime/tests/session-diagnostic-detail.test.mjs` 覆盖路由/工具声明/压缩与流结束事实、真实 adapterDefaults 形状、已知凭据跨片段与深度限制、自定义认证头、摘录预算及对话/思考正文不直接导出。
- `runtime/tests/session-log-fidelity.test.mjs` 同时断言真实模型、长关联 ID、具体错误、时间、工具参数与 schema 约束保留，以及个人字段、编码认证值、正文回显不泄漏；覆盖有效 JSON 片段、正文预算降级与解释性 input/content 文案误删。
- `ui/desktop/src/components/DiagnosticExportDialog.test.tsx` 覆盖纯文本预览、详细模式、预览/保存字节一致、迟到读取、会话/级别切换、取消与固定错误提示。
- `runtime/tests/ordinary-chat-failure-replay.test.mjs` 覆盖原生追加输入归属、旧失败冷补、重复加载、输出限制、可选诊断失败、异步加载与新请求竞争、停止前后次序和隐私哨兵。真实 HTTP 服务及 ACP 与有屏障的协议夹具分开验证。
- `runtime/tests/ordinary-chat-subagent-replay.test.mjs` 通过真实 Harness 和本机可控模型验证子结果自动续轮失败后的冷恢复，检查完整原始历史与工具调用数不变；`runtime/tests/user-turn-terminals.test.mjs` 补充独立输入、原生 steer、通知链与取消边界。
- `runtime/tests/compaction-diagnostics.test.mjs` 分别核对安全下载与完整本机压缩日志，保留原生失败及检查点断言。
- `runtime/tests/tool-crash-recovery.test.mjs` 在工具副作用发生前/后、回执未持久化时强制终止隔离 Host。恢复追加原生 `TOOL_OUTCOME_UNKNOWN` 错误回执与 `interrupted`，不自动推理或重放工具，原日志前缀保留。显式继续的模型夹具不再次提案该操作。
- `runtime/tests/timeout-exhaustion.test.mjs` 让真实本机 HTTP 连接完全无响应或只返回 SSE 响应头。在隔离提供商中缩短 watchdog 与退避，保留原生五次重试，核对六次实际超时、最终 `TIMEOUT`、停止后无额外请求、冷恢复和继续不重复工具。本测试不更改产品默认超时配置。
- `ui/desktop/tests/e2e/session-log-export.browser.spec.ts` 通过真实 ACP 导出日志，核对入口、预览、保存文件、取消不覆盖和本机原生日志不变；文件对话框使用测试桥接，不代表原生系统对话框验收。
- 上述结果不保证任意外部工具“恰好执行一次”。副作用已发生、回执缺失时，结果仍未知；模型若再次提出非幂等操作，应先核对外部状态或征询用户，不能把未知当作未执行。
