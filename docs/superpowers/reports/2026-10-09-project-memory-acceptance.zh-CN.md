# 项目跨对话记忆与等待延迟验收

[繁體中文](2026-10-09-project-memory-acceptance.md) · [English](2026-10-09-project-memory-acceptance.en.md)

## 结论与来源

本批记忆修复与等待限制验收通过。同一设备、配置与项目下的不同对话可共享已保存记忆；完整聊天合并及跨设备同步不在范围内。Windows 开发版与 Mac 安装版均使用真实 Electron 应用及已配置的 Ollama `deepseek-v4-pro:0813`。

来源：既有 `main`，基底 `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加本批修复。工作区还有其他既有改动，五个 Rust 文件与后端哈希已经核对；安装包来自该 dirty 工作区，并非仅本批提交的干净重建。提交编号见[合并交接](2026-10-09-memory-fixes-merge-handoff.zh-CN.md)。

## 自动验证

- 两端各 56 项记忆单元、14 项集成、5 项纯对话限制、52 项任务合同测试通过；另有 1 项外部 Hindsight 测试按既有标记跳过。
- 最新两端提供商完整测试各 138 项通过，包括 5 项无数据等待回归：Chat/Responses 响应头停滞、心跳、持续文字/思考/工具参数、部分输出后停滞、非流式兼容性。
- 两端审计测试各 29 项通过，1 项手动基准默认跳过；Windows 另外显式运行基准并通过。损坏记录拒绝、子会话遗留请求及跨 run 隔离保持有效。
- Windows 适用 Clippy `-D warnings`、两端格式检查与后端构建退出码 0；Mac 安装包校验、只读挂载、安装与深度严格签名检查退出码 0。

## 真实应用验收

bundle41 两端完成保存、新对话召回、其他项目隔离、更新后原对话读取、删除、删除后召回、清空及清空后召回；核对持久化、工具回执及宿主状态。纯对话没有执行任务或工具调用。

bundle42 重验耗时（秒，包含模型与应用开销）：

| 路径 | Windows | Mac |
| --- | ---: | ---: |
| 保存记忆 | 92.371 | 24.542 |
| 新对话召回 | 21.807 | 17.988 |
| 清空记忆 | 45.406 | 21.688 |
| 本地无响应服务，结束等待 | 61.093 | 60.680 |
| 切回 Ollama，回复“连接已恢复” | 10.163 | 9.737 |

无响应服务仅监听各机 `127.0.0.1`，不用凭据；两端各一次流式 POST，没有自动重复提交。界面提示意图识别服务暂时不可用、保留原任务并可重试；错误不一定写入 assistant 消息。测试后删除临时提供商、停止服务，并切回 Ollama。

## 延迟与失败记录

旧 Windows 首次审计扫描 224.293 秒、复测 7.785 秒；新版另启测试程序全量扫描 2.016 秒。缓存条件不同，不宣称同条件冷启动提升。新版首个保存整轮 92.371 秒已包含收尾，未再重现旧 224 秒收尾，仍校验全量历史。

旧 Mac 曾等待外部模型约 286 秒；现在默认 60 秒限制无数据等待，活动 SSE 刷新期限。外部模型推理速度不由该修复决定；尊重明确配置的提供商超时，非流式模式不变。

原始失败保留：bundle41 首次 240 秒 UI 等待超时后宿主才完成；Windows 一次原对话召回遇服务不可用，定点重试通过。bundle42 初轮脚本选到隐藏面板、切换模型后没等页面更新、显示名称不匹配，以及手动操作混入旧测试会话；这些不计入通过证据。修正脚本后的独立会话通过。Windows timeout 数据中的 `turn not_started` 是预期的语义决策前失败；恢复记录没有失败项。

## 未覆盖

本批未验收 Intel 硬件、Developer ID 公证、Gatekeeper 交互、Finder 拖拽或产品所有功能。Mac 为 ad-hoc 签名内部测试包。本批未实现跨设备记忆同步或完整聊天历史合并。

## 复现命令

Windows 工作目录： `D:\Users\jiangrui\Desktop\CodeBuddy`. Mac： `/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001`. 沿用 README 的既有构建环境；Mac 测试使用 `--release`。

```text
cargo test --locked --offline -p goose --lib --test codepro_project_memory_tools --jobs 1 project_memory -- --test-threads=1
cargo test --locked --offline -p goose --test codepro_project_memory_tools --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose --lib explicit_no_tools --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose --lib agents::tool_task::tests --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose --lib agents::tool_audit::tests --jobs 1 -- --test-threads=1
cargo test --locked --offline -p goose-providers --lib --jobs 1 -- --test-threads=1
cargo clippy --locked --offline -p goose -p goose-providers --lib --tests --jobs 1 -- -D warnings
cargo fmt --all -- --check
```

Windows 审计基准使用新构建的测试程序，设置 `CODEPRO_AUDIT_BENCH_ROOT=C:/Users/jiangrui/.CodeBuddy/profiles/local/audit` 及参数 `agents::tool_audit::tests::completion_scan_existing_history_benchmark --ignored --nocapture --test-threads=1`：退出码 0，2,016 毫秒。

## 证据

本地忽略目录内的证据（含会话内容，不提交）：

- `target/memory-cross-chat-20261009/`: 记忆测试及原始／重试日志。
- `target/memory-cross-chat-20261009/retest/windows-e2e.json`, `windows-refresh-retry.json`, `mac-e2e.json`, `mac-late-clear.json`: bundle41 功能验收及延后完成记录。
- `target/memory-cross-chat-20261009/retest/windows-latency42.json`, `windows-timeout42.json`.
- `target/delay-fixes-20261009/`: 提供商／审计／Clippy／构建日志、退出码、来源清单、基准、超时请求及恢复日志。
- `target/delay-fixes-20261009/mac-evidence/target/macos-acceptance42/`: 安装验证、超时证据及恢复日志，恢复退出码 0。
- `target/delay-fixes-20261009/mac-evidence/target/memory-cross-chat-20261009/retest/mac-latency42.json`.

## 安装包

Apple Silicon bundle42： `target/macos-release-20261009-bundle42/CodeBuddy-arm64.dmg`.

SHA-256: `823a477eeca3d924c034ec20efb0d54a8f85aa00bdfd272b5aa8866e278eefa4`.

Mac 桌面副本： `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261009-bundle42/CodeBuddy-arm64.dmg`.

已安装的验收程序： `/Users/erjinyi/Applications/CodeBuddy-Test-20261009-bundle42/CodeBuddy.app`.

Windows 后端 SHA-256： `2c9271093b2c05585db42f95ed9fba8b4ef9ebb5b64cc16d5d11348c25cbc0fc`.
Mac 安装包后端 SHA-256： `9c92481bc2e16ddd53a2de1a6fe239e1475eb26b35f82da48e4ecae2c355cedf`.
