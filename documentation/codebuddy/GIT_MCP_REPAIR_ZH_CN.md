# Git MCP 修复与合并交接

基准：CodeBuddy main / 00a6656，加本次未提交修复。原有安装包与 ACP 格式修改不属于本次。

## 修复内容

1. Git 写入仍由 MCP 执行。ExtensionManager 清除外部伪造 metadata 后，观察工作区与 Git 索引／引用变化；MainAgentActionFacts 消费宿主证据。既有权限和完成门槛继续由原模块负责。
2. 省略或相对 path 绑定当前任务工作区，避免服务器可变工作目录与验收范围不一致。
3. 普通分支推送由宿主查询实际 push URL 的远端 ref，SHA 一致才生成 external_effect 证据。dry-run、删除、tags、多个 push URL、工作区外 linked-worktree metadata 暂不生成此证据。
4. Windows Git 子进程复用已有 Job Object 管理器。MCP 超时／取消会结束监管进程并清理子进程；实际效果以验收报告为准。
5. status 使用 porcelain v2 的 NUL 记录，保留中文、空格、重命名方向和冲突文件名。merge 根据未合并索引判断冲突，报错并保留现场；abort 核对退出码。
6. 签名遵循仓库配置，默认不额外强加上游 -S；保留现有明确 GIT_SIGN_COMMITS 配置。禁用交互提示，认证失败交回用户处理。

## 合并原则

独立修改自动合并；内容冲突由 Agent 理解双方需求、编辑冲突、运行相关测试后暂存提交。语义依据不足时保留冲突并提出具体问题，不直接选择一边覆盖。只操作隔离仓库和指定 GitHub 测试分支；产品 main 未合并或推送。

## Files / 檔案 / 文件

- crates/goose/src/agents/git_mcp.rs
- crates/goose/src/agents/extension_manager.rs
- crates/goose/src/agents/tool_execution.rs
- crates/goose/src/agents/tool_task.rs
- crates/goose/src/agents/mod.rs
- crates/goose-cli/src/main.rs
- scripts/git-mcp-adapter.cjs
- scripts/git-mcp-adapter.test.cjs

## Runtime

`@cyanheads/git-mcp-server@2.15.3` (Apache-2.0). Keep its original bundle unchanged; the adapter generates `dist/index.codebuddy.js` alongside it. A version/anchor mismatch stops configuration.

`node scripts/git-mcp-adapter.cjs RUNTIME_ROOT GOOSE_EXECUTABLE`

The executable must contain this patch. Enable `git_merge` in the existing `local_git` tool allowlist. The launcher uses the existing Node runtime and credentials; do not commit profile data, credentials, bundles or test repositories.

## Checks

- `node --test scripts/git-mcp-adapter.test.cjs`
- `cargo test -p goose --lib git_mcp --jobs 4`
- `cargo clippy -p goose-cli --bin goose --jobs 4`
- `cargo build -p goose-cli --bin goose --jobs 4`

Use the repository's Windows development build environment. See the final acceptance report for actual results; commands here are not a pass claim.

## References

- [Upstream Git MCP](https://github.com/cyanheads/git-mcp-server)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

## 补充修复：已知冲突与未知结果

适配器仅在 Git 合并进程已返回退出码 1、索引仍有冲突时附带结构化冲突类别；宿主再次检查 MERGE_HEAD 和未合并索引后，才记录“已确认冲突”。它仍是失败工具回执，不计为合并成功，但不会永久污染后续完成判断。超时、取消、普通错误和伪造标记继续受未知结果检查约束。旧会话中缺少新回执的历史错误不会被自动删除。

Windows 规范化路径的 `\\?\` 前缀在适配器边界转换为等价普通路径，然后继续执行上游工作区检查；工作区外路径仍被拒绝。

完成核验缺少 expected_effect 时，错误消息现在明确要求先修订需求语义，再按新版本提交证据；外部效果应引用宿主回执中的资源标识，避免模型反复提交同一个无效请求。此改动仅改善错误引导，未降低证据要求。

## 2026-09-30 验收结果（Kimi 场景通过，仍有体验限制）

开发后端 SHA256：10385E8681E4461B36EBE3B7BBC6EF5D8BD9B46360D105445D126D6CB6D52D11。源码基准 main / 00a6656，加本批未提交修复；本次继续验收未修改后端源码。

- 自动验证：Git 回归 6/6，完成状态回归 50/50，适配器 4/4；前两组重叠，不相加。Clippy 和构建退出码 0，25 条既有 Clippy 警告。
- 真实 MCP：24 次基础及拒绝场景调用（含 5 次预期拒绝），6 次自动合并、冲突及撤销调用；路径边界、取消与 60 秒超时子进程清理均通过。
- **全新冲突聊天 20260930_28：通过。** Agent 从分支原始状态触发冲突，理解并修改 fee.cjs，保留两方行为，原测试 2/2；双父合并提交 d5e8d68 已推送本地测试远端。测试文件和未提交草稿保持原样。宿主状态 finished，无暂停原因。
- **GitHub 推送聊天 20260930_29：通过。** 仅提交 Kimi 验收.txt，提交 2c791c8 已在指定测试分支独立核实，草稿未提交；宿主 finished。
- **GitHub 拉取聊天 20260930_30：通过。** 实际快进拉取同事新提交 54c4c3d，新文件内容、远端 SHA 和草稿独立核对通过；宿主 finished。

边界与发现：

1. 本地 Qwen 早先的完整聊天验收仍未通过；上述通过只证明本轮 Kimi 与指定场景，不能推广到任意模型或零故障。
2. Kimi 会在完成核验时填错证据编号，或把要求保持不变的文件列为必须修改的目标；本轮自行纠正后完成，但存在多余调用。最终回复也有暴露内部核验术语的体验问题。
3. 会话 20260930_27 恢复了上一轮已经编辑的冲突现场，实物验证通过，但最后等待模型响应被停止；它不计为独立解冲突通过。
4. 用户授权后，kimi-k3 的 /api/chat 与 /v1/chat/completions 最小工具探测都返回 200。早先 DeepSeek 请求返回 410，不应概括为整个兼容接口不可用。产品 Ollama 类型聊天代码仍调用 /v1/chat/completions；不能把提供商类型切换宣称为原生聊天协议迁移。
5. 新建临时提供商触发 Windows 凭据库单条记录 2560 字符限制；本轮复用原提供商完成测试，此容量问题未在 Git 修复中解决。

配置已恢复：shell: never_allow；原 custom_1 提供商文件与默认 deepseek-v4.1-flash。原默认模型是否可用不由 Kimi 验收证明。凭据未写入仓库。源码未提交，GitHub 仅指定测试分支有验收提交。

本机证据：D:/CodeBuddy/.cargo/codebuddy-git-mcp/acceptance-summary.json；fresh-kimi-conflict-chat.json、conflict-independent-result.json、kimi-push-chat.json、kimi-pull-chat.json 与 kimi-*-independent-result.json。
