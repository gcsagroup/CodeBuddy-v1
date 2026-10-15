# 项目分析上下文超限修复

2026-09-14

代码修复、自动化验证和后端构建通过；真实模型及完整桌面验收被网关连接拒绝阻塞，尚未完成验收。

网关可以回答普通问候，但返回 HTTP 413 / context_exceeded 拒绝较大的分析请求。客户端显示的 128k 不能证明网关实际允许这么多内容。分析路径原先加载了过多扩展说明和工具定义；长工具结果还会进入后续请求。另外，压缩清理在单条或奇数条工具结果时存在索引错误。

只读分析先提供文件读取、目录、搜索及受限 shell，其余已启用的只读工具按需加载。每次加载 1～3 个定义并替换当前选择；加载本身不执行工具，也不算完成取证。保留原权限、工作区、用户和项目指令。

长工具文本在模型请求中改为首尾各 512 字符的明确节选；需要中段内容时继续定向读取。完整工具结果仍保存在用户可见历史中。该预算针对每条工具结果的文本，不是整个请求、图片或结构化内容的容量保证。

修正单条、奇数条工具结果的压缩清理，并检查压缩是否真正缩减模型上下文；无效时保留历史、明确报告未完成。普通聊天及其他执行路径保持现有行为。

采用公开的工具按需加载原则；当前接口是 Chat Completions，因此不直接接入 Responses 专属 defer_loading 或 /compact。没有推断 Codex 私有实现。 [OpenAI Agents SDK tools](https://openai.github.io/openai-agents-python/tools/)

分析回归 42 通过；压缩专项 13 通过；完整后端 3297 通过、0 失败、2 忽略；ACP 与控制 129 通过、0 失败、0 忽略（1+59+55+3+11）。格式及严格 Clippy 通过。专项测试包含在完整后端测试中，不应简单相加为总覆盖数量。以上命令工作目录均为 D:\CodeBuddy，退出码均为 0。

```text
cargo test -p goose --lib analysis --features code-mode --jobs 1 -- --test-threads=1
cargo test -p goose --lib context_mgmt::tests --features code-mode --jobs 1 -- --test-threads=1
cargo test -p goose --lib --features code-mode --jobs 1 -- --test-threads=1
cargo fmt --all --check
cargo clippy --all-targets --features code-mode --jobs 1 -- -D warnings
cargo test -p goose --test acp_custom_provider_methods_test --test acp_custom_requests_test --test acp_server_test --test codepro_control_command --test codepro_control_reducer --features code-mode --jobs 1 -- --test-threads=1
```

V2 在真实网关上前两轮分析成功，但第三轮约 60 KB 文件分析仍失败。该失败记录已保留，不能把 ACP end_turn 或测试程序退出 0 当作任务成功。V3 验收必须核对真实报告中的文件依据和末尾标识，并检查旧失败对话恢复及刷新持久化。

当前安装包和用户已运行的旧后端尚未更新；代码验证不等于安装包交付。测试凭据不写入本报告。

Evidence: `.cargo/evidence/analysis-context-20260914/` (`source-v3.json`, `v3/gates.json`, `v3/*.log`, `real-analysis-acp-v2-failed.json`, `real-request-sizes-v2-failed.json`).

V3 后端构建退出 0。真实 ACP 会话 20260914_4 第一轮返回“当前模型服务暂时不可用”，未产生项目分析，验收程序退出 1。随后模型列表与聊天接口均无法连接；2026-09-14 16:53（亚洲/上海）复查仍为 ECONNREFUSED，目标 192.168.9.107:8080。此结果属于外部服务不可达，不能宣称上下文修复的真实验收通过。

独立 Electron 实例成功使用新版后端启动并显示旧对话列表。旧失败对话续分析、文件末尾标识、真实项目分析和刷新持久化仍未完成；没有修改用户正在使用的旧后端。网关恢复后先重跑 accept-analysis.mjs 与 accept-repository.mjs，再完成原生桌面旧对话恢复及刷新验证。

```text
cargo build -p goose-cli --features code-mode --jobs 1
node .cargo/evidence/analysis-context-20260914/accept-analysis.mjs
```

Backend SHA256: `B17C4F9FF00F63FE8D8483E85015BF345ED70472122671BC372B6A120D43BAF2`

Latest evidence: `v3/fixed-binary.json`, `v3/gateway-availability.json`, `real-analysis-acp.json`, `native-launch.json`.
