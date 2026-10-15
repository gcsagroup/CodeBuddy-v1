# Gemma 思考与合同修订修复记录（2026-10-13）

[繁體中文](GEMMA_CONTRACT_20261013_ZH_TW.md) · [English](GEMMA_CONTRACT_20261013_EN.md)

## 已确认的问题与边界

1. OpenAI 兼容请求构造器没有把 Gemma 4 的 `thinking_effort` 转换成 `chat_template_kwargs.enable_thinking`。官方文档明确该开关控制思考；现有接收路径支持 `reasoning` 分片。用户提供的服务对照证据包含思考分片，但不是修复版桌面验收。
2. 合同修订的结构错误反馈含有笼统的 “Fields belong at the top level”，会误导 `revision_relation` 的位置。状态校验对缺失版本关系只报一般错误，缺少数组索引、正确路径及当前版本。
3. 本批保留版本关系校验，宿主不自动补造关系、不把根层级字段悄悄迁移到 `semantics`。模型仍须依据用户要求选择保留、替换或撤回。反馈修复不保证所有模型永远生成正确调用。

## 改动与所有权

- `crates/goose-provider-types/src/formats/openai.rs`：Gemma 4 的 off 映射为 false，low/medium/high/max 映射为 true；这些档位不会变成不同的 Gemma 思考预算。未选择时保留服务默认值，显式自定义模板参数优先。Qwen 原有关闭映射保留，不为未知模型猜测协议。
- `crates/goose/src/agents/main_agent_contract.rs`：复用既有 `serde_path_to_error` 和 wire 类型定位结构错误；指出 `requirements[i].semantics.revision_relation`。不变更协议或接受范围。
- `crates/goose/src/agents/reporting/projection.rs`：仍由 RunProjection 校验关系；错误包含具体数组索引、当前版本和示意 JSON，过期关系也给出当前版本。
- `crates/goose/tests/codepro_runtime.rs`：在既有恢复测试加入缺失关系、错误路径提示与失败后状态不变断言，随后用正确关系恢复。原有 stale/retained 校验继续执行。

## 验证

在仓库根目录执行，以下命令均退出 0：

| 命令 | 结果 |
| --- | --- |
| `cargo test -p goose-provider-types --lib formats::openai::tests --jobs 1` | 96 通过，含 Gemma 各档位、显式参数优先、Qwen/OpenAI 回归 |
| `cargo test -p goose --lib main_agent_contract --jobs 1` | 3 通过，含错层字段及正确结构恢复 |
| `cargo test -p goose --test codepro_runtime requirement_revision_recovers_after_rejected_unknown_effect_changes --jobs 1` | 1 通过，含缺失关系拒绝后状态不变、正确修订恢复 |
| `cargo test -p goose --lib run_relation_tests --jobs 1` | 7 通过，含 JSON 围栏、严格 schema、取消及超时边界 |
| `cargo fmt --all --check`、`git diff --check` | 通过 |

在 `ui/desktop` 执行 `pnpm run ensure-dev-backend`，退出 0，最终构建耗时 14 分 18 秒。新后端为 `target/debug/goose.exe`，SHA-256：`8186e7eb25a45e93d4ba29a4b56a1230985a30d5a9b8a7843f571a683f1d8b13`。已有桌面进程占用旧后端，因此没有覆盖旧进程使用的二进制。

日志：`target/mcp-discovery-20261013/` 中的 `provider-tests.log`、`contract-tests.log`、`contract-runtime-tests.log`、`relation-tests.log`、`final-backend-build.log`。源码校验值见 `source-manifest.json`。

### 实际服务复测

使用上述新二进制执行 `node target/mcp-discovery-20261013/probe.cjs target/debug/goose.exe --expect-fixed --model --thinking --both-thinking`，退出 0。隔离 profile 通过桌面 ACP 连接真实 Gemma 服务 `http://192.168.9.101:8001`，模型 `gemma-4-26B-A4B-it-uncensored-FP8-W8A16`。

| 场景 | 思考设置 | ACP 思考分片数 | 结果 |
| --- | --- | --- | --- |
| 查询 MCP 后，在同一对话继续提问 | high | 325 | 正确回答 15，正常结束，无恢复解析错误 |
| 同一对话继续提问 | off | 0 | 正确回答 15，正常结束 |
| 新对话 | high | 153 | 正确回答 15，正常结束 |
| 新对话 | off | 0 | 正确回答 15，正常结束 |

实际请求日志确认 high 对应 `enable_thinking:true`，off 对应 false。证据：`target/mcp-discovery-acp-DuSQFu/result.json`、`responses.jsonl`、`profile/logs/llm_request.*.jsonl`；构建后的源码哈希与 manifest 一致。

前一次同源复测 `target/mcp-discovery-acp-BdMMVj/` 的恢复判断和回答已成功，但“high 必须每次产生可见思考”的测试断言失败：请求确实开启思考，分类器收到 622 个思考分片，最终简单算术回答却只有正文。这些内部分类分片不应显示为用户回答的思考。最终验收分别核对 wire 参数、恢复成功和实际回答分片，保留该差异记录；分片数不是稳定性能指标，也不承诺每次开启都会输出思考。

### 验收边界

自动测试验证了失败输入及正确修订的状态变化；没有重放原“飞机大战”任务的完整开发流程。未运行完整 Electron 桌面、Mac 真机或安装包验收；本批未运行 Clippy，合并前仍需相应检查。构建和 ACP 联网测试不替代桌面验收。

## 构建及合并说明

- 当前 `main`，基线 `964bbeb1587f1c5551ee17907e0b26632c4163ce` 加本批未提交改动；另含 [MCP 发现与错误 UI 修复](MCP_DISCOVERY_20261013_ZH_CN.md)。
- 未修改用户供应商配置、凭据或历史会话；未提交、推送。
- 代码为 Windows/macOS 共用 Rust 层；Windows 后端验证不等于 Mac 真机验收。旧安装包不含本批修复。
- 服务模型列表与本地配置的上下文差异应单独核对，本批没有把它认定为本次失败原因。
- 参考：[vLLM Gemma 4 思考参数](https://docs.vllm.ai/projects/recipes/en/stable/Google/Gemma4.html#thinking-reasoning-mode)。

## 联网复测发现的关联问题

2026-10-13 的新后端实测中，Gemma 开启思考后的恢复分类返回了完整的 ` ```json ` 围栏包装，而内容是合法的 `{"kind":"question"}`。旧入口直接 `serde_json::from_str`，报“恢复判断返回了无效数据”，并未进入正式回答。证据在 `target/mcp-discovery-acp-TjnShw/`。

`agents/agent_clarification.rs` 的两个恢复分类入口统一经过局部格式解析函数，只接受裸 JSON 或单个完整的普通/JSON 围栏，随后仍由原类型校验字段和值。未知关系、额外字段、不完整围栏、多段 JSON、前后解释文字仍拒绝。未改变分类事实 owner、运行状态、权限或失败后的任务归属。
