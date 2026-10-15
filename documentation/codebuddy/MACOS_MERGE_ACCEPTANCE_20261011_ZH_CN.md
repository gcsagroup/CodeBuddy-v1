# Mac 主目录融合修复与验收记录（2026-10-11）

## 本次结论

依下表区分自动化、原生安装包和真实界面验收。此记录涵盖当前 main 加本次修复；未执行的范围仍标记为 NOT_RUN。

**PARTIAL_ACCEPTANCE — Kimi/native gates PASS; DeepSeek completion BLOCKED**

已修复本次 Mac 平台契约与测试夹具问题，Windows/Mac 最终自动回归通过，最终 arm64 DMG 与真实安装副本通过；Kimi 完成整套 10 项真实界面验收。整体尚非全绿：原主模型 DeepSeek 在最终副本仍未提交完成核验，只能确认文件已正确写入和读回，宿主保持暂停。新增恢复指引并未在这个模型上解决该问题，保留为后续模型兼容性/完成链路缺口；未降低完成标准，未更改默认模型。

## 修复内容

- 补齐 Unix 测试 Agent 的工具与命令契约：使用实际提供的工具、每轮一条测试命令，报告真实退出码；纯文本任务使用 read_document 核对内容，未执行动态测试时报告 NOT_RUN。权限检查与完成证据要求沿用现有设计。

- 修正测试夹具中的 Windows 路径、CMD 和 Python 可执行文件假设。Unix hook 夹具以 sh 执行其普通文件；宿主验证夹具执行实际 Python 测试，并核对只执行一次。新增 Unix 活动展示测试及原生 Python 执行测试。

- 补上 Mac 专用 ActivePromptRun 测试初始化器的 durable_execution_bound；人工核对 Unix 提示快照与当前 main 的工具注册结果。

- 加强主 Agent 完成拒绝后的恢复指引：读取当前要求和真实回执，再以已有回执提交核验；未核验部分具体交接，保留已完成工作。指引与结构化完成事实分开，未更改权限、要求或宿主完成门槛。

## 验收结果

| Check | Exit | Result | Evidence |
| --- | --- | --- | --- |
| Mac SDK/locale build + TypeScript | 0 | PASS | sdk-build.log / locale-build.log / typecheck.log |
| Mac frontend | 0 | 60 passed | frontend-native.log |
| Mac package contracts | 0 | 41 passed, 8 skipped | mac-package-contract.log |
| Mac Git MCP | 0 | 3 passed, 1 Windows-only skipped | git-mcp-native.log |
| Mac backend regression | 0 | 2130 passed, 0 failed, 5 ignored | backend-final-recovery.log |
| Mac context | 0 | 18 passed | context-repaired.log |
| Mac Clippy | 0 | PASS, 6 retained platform warnings | clippy-final-recovery.log |
| Windows backend regression | 0 | 2213 passed, 0 failed, 3 ignored | windows-final-recovery-regression.log |
| Windows final fixture | 0 | 1 passed | windows-final-fixture.log |
| Windows final strict Clippy | 0 | PASS | windows-final-recovery-clippy.log |
| Format + diff checks | 0 | PASS | cargo fmt --all -- --check / git diff --check |
| Mac runtime integration | 0 | 18 passed | runtime-repaired.log |
| Mac native package/install | 0 | PASS; final-source arm64 DMG + copied installed application | cli-repaired.log / package-repaired.log / installed-final-result.json |
| Mac actual UI / original DeepSeek | 1 | FAIL: correct file; host completion_blocked; 2/10 checks | deepseek-final-result.json / deepseek-final-authority.json |
| Mac actual UI / Kimi | 0 | PASS: 10/10, committed completion + persisted terminal | kimi-final-result.json / kimi-final-authority.json |
| Mac native ACP workspace/restart | 0 | PASS: 8 lifecycle/boundary checks | workspace-restart.log |
| Private test credential cleanup | 0 | PASS: removed after both tests; formal profile/Keychain untouched | credential-cleanup.json |

## 平台边界

Mac/Unix 的技能导入及 held-object 清理写入仍依既有设计受限。Windows 写入成功/回滚测试只在 Windows 执行；Unix 补上拒绝写入、设置字节和任务数据原样保留的测试。这些功能的 Mac 写入能力尚未开放，通过拒绝测试不代表完整功能对齐。Intel Mac、跨应用电脑输入/TCC、Developer ID 公证及 Gatekeeper/Finder 安装验收未执行。

## 环境、备份与失败历史

macOS 26.6.2 arm64、16 GB RAM；原生 Rust 1.96.1/Node 24.10.0。Mac 旧目录的二进制 patch、未跟踪文件、原生启动器及 stash 已保留。使用 Git bundle 快进到 21b5582f9b0cc645ba096d560eb6291d15f7e7b2，再同步修复文件哈希；既有安装副本保持原状。

第一轮 2086 通过、48 失败；指定原生 PATH、TMPDIR=/private/tmp 和单线程后，2106 通过、28 失败。修复后一轮为 2128 通过、1 失败（目录观察不是动态验证证据）；改用实际测试夹具后进行最终回归。中途主动终止的编译及一次夹具缺少导入导致的编译失败均保留，未计入通过。Windows 默认测试线程栈曾溢出；沿用仓库 CI 的 RUST_MIN_STACK=8388608 后完整回归通过。

## 凭据与来源

用户授权将 Windows 主模型的必要设置/一项凭据传至 Mac 隔离验收环境，模型预检取得 HTTP 200 和实际回复。凭据只供测试子进程环境使用；不写入正式 Mac 设置或全局 Keychain，不提交 Git。原 Windows shell 权限文件已于先前验收后恢复。

## 原生验收与证据

```text

Source base: 21b5582f9b0cc645ba096d560eb6291d15f7e7b2 + tested repair-source-manifest.json (8 files)
CLI SHA-256: 337ec245bbaa267596eb41d09b00acb8f565f8fd92dc78d83131043411286ec6
DMG SHA-256: a92dc22bb0c655808cecfb5ce5f8f9b626911c87e1182d8369da4afa937d4305
App version: 1.43.2; arm64; deployment 14.0; signing: ad-hoc
CLI release build: 20m 32s; exit 0
Manifest records dirty=true because repair commits followed acceptance.
Raw source hashes are provenance, not canonical Git blob hashes.

/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/ui/desktop/out/macos-install-XDZwnT/installed/CodeBuddy.app

/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/ui/desktop/out/CodeBuddy-darwin-arm64/CodeBuddy-arm64.dmg

```

Kimi：普通新任务入口→实际模型写入→磁盘字节核对→run_completed→会话 turnTerminal completed→重载保留→文件树/预览/编辑/保存 Unicode→取消关闭保留草稿→真实 PTY 键盘输入与工作区 cwd→WebContentsView 本机及公开 HTTPS，10/10 通过。DeepSeek 同一安装副本只通过入口与正确文件两项；实际回执为 run_paused/completion_blocked，而非完成。Kimi 并未证明所有模型兼容。两轮各自使用隔离 profile，未重放已完成动作；私有凭据文件已删除。

```text

Local: D:\Users\jiangrui\Desktop\CodeBuddy\target\macos-merge-acceptance-20261011

Remote: /Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/target/macos-merge-acceptance-20261011

Source: repair-source-manifest.json

Windows backup stash: 442a5495f

Mac backup stash: ad5c457ee

```

## Commands

```sh

cargo test --locked --offline -p goose --lib --release --jobs 1 -- agents:: acp:: context:: permission:: --test-threads=1

cargo test --locked --offline -p goose --lib --release --jobs 1 -- context_mgmt:: --test-threads=1

cargo test --locked --offline -p goose --test codepro_runtime --release --jobs 1 -- --test-threads=1

cargo clippy --locked --offline -p goose --lib --release --jobs 1

cargo build --release -p goose-cli --bin goose --target aarch64-apple-darwin --jobs 1 --locked --offline

node scripts/bundle-macos.cjs --arch arm64 --backend /Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/target/aarch64-apple-darwin/release/goose

node scripts/macos-install-smoke.cjs

cargo test --locked --offline -p goose --lib --release --jobs 1 -- main_agent_ rejected_completion_feedback --test-threads=1

```

原主模型 DeepSeek 的两轮真实任务已写入并读回正确文件，但未提交完成核验，宿主保持 completion_blocked；模型口头完成不是通过。本次新增已有回执的恢复指引。首次指引位置破坏旧 JSON 解析的回归测试已揭露并修正，最终 Windows 2213/Mac 2130 通过。Kimi 在较早安装副本已通过 10 项真实界面流程；下表只以最终重新构建副本的结果作为本次交付依据。

## Source SHA-256 (raw tested files)

```json
{
  "crates/goose/src/acp/server/custom_dispatch.rs": "67afe08e70b5af8b16ba41b4f7b56c8a9f5a33ad88df6f15d5aa779ac0ce56f1",
  "crates/goose/src/acp/server/onboarding.rs": "f13eaacae6a193ea49a86d6500f64d56995c45e2145aa08fd9d6ddda680cb3ec",
  "crates/goose/src/agents/agent.rs": "20195ea3113e638910f1540651ba286b38b18ecbbb3a10005baff015e85daf2f",
  "crates/goose/src/agents/codepro_state_store.rs": "beb7b8a67be790d5f6f01bea0bebc3ebf4ee5fe3203270b49960f602be31b28c",
  "crates/goose/src/agents/snapshots/goose__agents__prompt_manager__tests__all_platform_extensions.snap": "0699a5bb55721b17f5575e4b8f66c0da2e39ed13313c8400a4d69f1c7b56cb23",
  "crates/goose/src/agents/task_scheduler.rs": "ec58622c0735782b0f8dc5e4cb668b97628593e3131fd825f7faaec26e1500ca",
  "crates/goose/src/agents/tester_runtime.rs": "b3b972639f0d3004fec59fbb8fa5bdbefaa557c170a1d6ae7ab0964f773220e0",
  "crates/goose/src/agents/tool_execution.rs": "7d9743feff5f0dc2b0a596dc8070664e2464e66013cb8e0b3e890d84ff98fb56"
}
```

## Windows final verification commands

```powershell
$env:CARGO_PROFILE_DEV_DEBUG = "0"
$env:CARGO_INCREMENTAL = "0"
$env:RUST_MIN_STACK = "8388608"
cargo test -p goose --lib --jobs 1 --offline -- agents:: acp:: context:: permission:: --test-threads=1
cargo clippy -p goose -p goose-providers -p goose-provider-types -p goose-sdk-types --lib --jobs 1 --offline -- -D warnings
cargo fmt --all -- --check
git diff --check
```
