# 安全检测设置的运行时接入

对象为 `D:\CodeBuddy-v1` 当前工作区，源身份见 [source-baseline.json](source-baseline.json)。本批只增加 `runtime/safety-policy.mjs` 及测试；不修改 renderer、旧 Rust 核心或现有权限 owner，没有安装依赖、提交或推送。

原 UI 位于 `SecurityToggle.tsx`。原 `crates/goose/src/security/{mod,scanner,classification_client,command_chunker,security_inspector}.rs` 明确：总开关启用后，在 shell 调用前检查；命令分类器分析原命令，提示分类器分析最近十条用户文本；结果超过阈值时升级为 RequireApproval。默认阈值 0.8；实际审批比较为严格大于。模型映射或完整 endpoint 指向专门分类服务，并非当前对话模型。

实现沿用原结构化分类协议和评分组合，不增加 Agent 或模型调度循环。配置开启后会产生额外分类 HTTP 请求。采用 Hugging Face 的 `{inputs,parameters?}` 与 `label/score` 数据结构，兼容原嵌套数组及当前扁平数组；支持原 INJECTION/SAFE、LABEL_1/LABEL_0 与 logits 的稳定 softmax。未知标签、非有限分数和损坏响应均为未完成检测，不转换成“安全”。[官方 API](https://huggingface.co/docs/inference-providers/tasks/text-classification)

## 宿主接法

```js
const safety = new SafetyPolicy(store, {
  modelMapping: process.env.SECURITY_ML_MODEL_MAPPING,
  overrides: {
    promptEnabled: process.env.SECURITY_PROMPT_ENABLED_OVERRIDE,
    commandEnabled: process.env.SECURITY_COMMAND_CLASSIFIER_ENABLED_OVERRIDE,
  },
});
const finding = await safety.inspect({ tool, userMessages, signal });
```

`tool` 保持真实 `{id,name,arguments}`。只精确匹配官方原生 `pwsh`、`bash` 和宿主旧 `shell`；读取 `arguments.command` 原串。不会凭 MCP 名称后缀认定 shell 身份。`userMessages` 由宿主根据消息角色提供，按时间从旧到新，只含明确用户输入文本；服务取最后十条，不混入工具响应或 Assistant 内容。

在原权限流中先执行禁用扩展、never_allow、chat 等拒绝条件，再调用检查，最后处理 always_allow/auto。若 `requiresApproval` 为 true，必须使用现有审批通道确认本次调用，不能由“总是允许”自动放过；同一 finding 的确认不得保存为以后安全告警的免检凭据。安全模块从不直接执行、批准或拒绝工具，也不修改任务完成状态。

返回字段为 `status`、`requiresApproval`、`confidence`、`threshold`、`reasonCodes`、`explanation`、可选 `findingId`、`classifierScores`、`coverage`。状态有 disabled、not_applicable、clear、flagged、unavailable。clear 仅表示本次配置分类分数未超过阈值，原工具权限仍适用。外部取消抛 AbortError，不再弹出确认。

## 配置、隐私与行为边界

- 总开关关闭、非适用工具，或对应分类器关闭时，不发送对应文本。端点来自明确配置或显式传入的组织模型映射；不自动借用主对话模型、下载模型或寻找其他服务。
- 命令分窗沿用 500 UTF-8 字节、256 字节重叠、最多 12 窗口，保留字符边界。近期用户文本每条最多 64 KiB；超限表示覆盖不足。各分类器最多并发 3 次请求，默认单次 5 秒，响应最多 64 KiB。达到阈值的判断保留原命令主信号和提示辅助信号组合。
- 令牌通过既有保护存储解密，只用于内存内请求的 Bearer header；配置改变时重新解析。拒绝带 URL 用户信息的端点和 HTTP 重定向，不记录原文本、令牌或服务响应体。请求只发生在用户已启用对应分类器的路径。
- **与旧 fallback 的明确差异**：本实现没有复制原正则 patterns。总开关开启却没有命令分类器、端点缺失、分类服务错误、部分窗口失败或尾部未扫描时，返回 unavailable 并要求本次确认；不伪造恶意概率、不把未检测当 clear。仅启用提示分类器仍缺少命令主信号，因此也保留该未完成边界。该路径不是原 pattern-only 检测的等价移植。
- 配置的外部分类模型仍有误报和漏报可能。这是审批升级信号，不是系统沙箱、语义授权判定或“所有提示注入已阻断”的保证。

## 验证

在 `runtime` 执行 `node --test tests/safety-policy.test.mjs`，7/7 通过，退出码 0。使用本机受控 HTTP 服务和随机测试令牌的实际 DPAPI 加解密；没有调用用户分类服务或真实主模型，没有执行被分类命令。

覆盖开关及阈值立即生效、按分类器分离发送内容、最近十条、组织映射、原 payload、UTF-8 窗口、截断尾部、部分失败、未知标签、响应大小、重定向、超时、取消、概率及 logits。实际桌面告警与用户分类服务需经主集成单独验收；本模块测试不替代权限流集成证明。

参考：本仓库上述 Goose 安全源码与 Apache-2.0 许可证；[Hugging Face Text Classification](https://huggingface.co/docs/inference-providers/tasks/text-classification)。复用原协议、标准 Node fetch 和既有凭据模块；未引入新的第三方依赖。
