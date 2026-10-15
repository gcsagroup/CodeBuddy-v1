# 项目记忆与等待延迟：合并交接

[繁體中文（預設）](2026-10-09-memory-fixes-merge-handoff.md) · [English](2026-10-09-memory-fixes-merge-handoff.en.md)

## 来源与提交

现有 `main` 工作区；基底 `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`。本批两端应用验收完成，下列代码提交与本交接文档一并交付。

### 代码提交

- `7b34092cf4c90587ee592ee47263b49474ebea5e` — memory
- `803f9431b5dfd1eaaffdc4226cf79322d7d6fa40` — audit
- `bc4ff081d1bdd3f43e5d5dd55c296ca592885588` — providers

## 修改内容

| 文件 | 原因及修复 |
| --- | --- |
| `crates/goose/src/agents/tool_task.rs` | 删除／清空记忆成功后，完成检查未接受其回执。接受可信内置工具的类型化成功回执，绑定原始 UUID／当前项目，包含幂等删除与清空；失败、伪造或目标不符仍拒绝。 |
| `crates/goose/src/agents/agent.rs` | 纯对话仍带执行任务绑定，造成反复完成检查。在已有纯对话限制应用处清除该绑定；一般执行任务保留证据门槛。 |
| `crates/goose/src/agents/tool_audit.rs` | 历史文件逐笔异步 I/O 与串行扫描拖慢收尾。批量阻塞 I/O、复用已解析回执，以共享四线程池扫描；仍逐一锁定并验证所有历史会话。增加锁等待／读取耗时诊断。 |
| `crates/goose-providers/src/openai.rs`、`openai_compatible.rs` | 自定义 Ollama 使用 OpenAI 兼容路径，原来只有 600 秒整体 HTTP 超时。默认 60 秒限制无数据等待，涵盖重试与响应头，响应头不重置首次期限；后续 SSE 数据延长等待期限，心跳注释不延长。超时结束本次请求，不自动重发。 |

已有明确 `timeout_seconds` 配置仍用于 OpenAI 提供商的等待期限；未配置时使用 60 秒。非流式模式沿用原 HTTP 超时。这限制应用等待，不代表外部模型的推理速度已提高。没有新增依赖、公共协议或记忆格式迁移；没有停用审计损坏检查或任务完成门槛。

## 同事接收步骤

1. `git status --short`，按团队流程保留自己的未提交工作。
2. `git fetch origin`，核对本报告最终提交编号。
3. `main` 可快进时执行 `git merge --ff-only origin/main`；已分歧时先检查差异再集成。
4. 注意上述五个文件的重叠修改，尤其纯对话绑定、记忆回执、审计锁定、提供商重试和 SSE 解析。
5. 按 README 使用原平台环境，执行[验收报告](2026-10-09-project-memory-acceptance.zh-CN.md)的命令并重建后端。自定义慢速模型若需要更长的静默等待，可使用已有超时设置。

## 交付边界

同项目不同对话可共享已保存记忆；完整聊天历史和跨设备同步不在此范围。工作区另有已有暂存和未暂存修改，本批不吸收这些其他修改；真实应用验收使用该工作区产物，并不表示所有产物内容都包含于本批提交。配置、凭据、原始会话、夹具和安装包留在忽略目录。

Mac 包是 Apple Silicon 内部测试版，使用 ad-hoc 签名；Intel、Developer ID 公证和 Gatekeeper 交互未验收。

## 设计参考

复用现有 Rayon 依赖限制并行 I/O；按 [Tokio 阻塞任务说明](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)避免无界阻塞任务。HTTP 总超时和读取等待不同，参考 [reqwest ClientBuilder](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html)。SSE 等待限制留在提供商传输层，不增加业务判断者。
