# 模型切换修复：同事合并交接（2026-10-09）

[繁體中文（預設）](2026-10-09-model-switch-merge-handoff.md) · [English](2026-10-09-model-switch-merge-handoff.en.md)

## 提交与范围

- 仓库：`https://github.com/erjinyi-bool/CodeBuddy`，分支 `main`。
- 本次代码提交：`6d63cb6fa672918796bf527439d326bb46ad284c`。
- 修改前基底：`eadb7cf9852eab5b76ee629d1db0dabf216b7cb3`。文档作为后续独立提交；可用 `git log -1 -- docs/superpowers/reports/2026-10-09-model-switch-merge-handoff.zh-CN.md` 查询。
- 仅提交本次模型切换的 9 个文件增量和三种语言交接文档。没有新增依赖、协议、配置格式或数据库迁移。
- 工作区原有大量暂存／未暂存修改，保留原状；它们没有被批量吸收。本次并非“所有 Mac 开发代码”的完整快照。

## 根因：为什么以前修过又出现

前端模型下拉列表读取服务的实时模型列表；已有会话的切换校验却读取本地提供商保存时的旧列表。现场本地保存 `qwen3.8-flash-next`，服务已改为 `Qwen3.8-27B-direct-A-best15-FP4`，所以界面能选新模型，后端却返回 `Invalid params / Model ... is not available`。

之前的回归覆盖创建提供商和保存默认模型，没有覆盖已有会话的 `provider_model` 切换入口。默认设置已有实时校验，会话入口没有复用。前端又把后端错误替换成统一“请重试”，隐藏了区别。

## 文件与改动

| 文件 | 本次增量及合并重点 |
| --- | --- |
| `crates/goose/src/acp/server.rs` | `validate_provider_model_selection` 对自定义提供商先复用 `validate_saved_custom_provider_models`；已下线模型和离线服务均拒绝，不回退旧缓存。内置提供商沿用原路径。 |
| `crates/goose/tests/acp_unauthenticated_custom_provider_test.rs` | 扩展原 ACP 集成测试：实时模型替换、本地列表过期、会话与默认设置一致、旧模型下线、503、失败后持久化模型保持不变。 |
| `ui/desktop/src/components/ModelAndProviderContext.tsx` | `changeModel` 保留 `Promise<boolean>`，选项增加可选 `onError(message)`；按已知结构化错误码显示本地化提示。保留失败回滚，未知错误仍使用通用提示。 |
| `ui/desktop/src/components/ModelAndProviderContext.test.tsx` | 覆盖下线、网络、凭据错误；不显示原始私有路径／错误正文，拒绝时不写默认设置。 |
| `ui/desktop/src/components/settings/models/subcomponents/SwitchModelModal.tsx` | 弹窗接收上述错误消息；保留会话切换守卫、默认模型事务和失败时不保存后续选项的行为。 |
| `ui/desktop/src/components/settings/models/subcomponents/SwitchModelModal.test.tsx` | 覆盖具体中文错误、弹窗保持打开、重试成功；更新回调参数断言。 |
| `ui/desktop/src/i18n/messages/{en,zh-CN,zh-TW}.json` | 新增 `modelAndProviderContext.{modelUnavailable,endpointUnreachable,credentialsRejected,invalidResponse}` 四个键，每项仍用 `{defaultMessage: ...}` 结构。 |

`server/providers.rs` 的现有实时校验会获取模型列表并进行最小非流式请求。本次直接复用，不创建第二套提供商探测，也没有直接改用户保存的模型列表或凭据。切换因此需要服务在线，并可能产生少量模型调用用量。

## 同事如何合并

先保存自己的工作，执行 `git status --short` 和 `git fetch origin`，核对提交后按团队分支流程集成。不要用覆盖整个目录或文件的方式处理冲突。

- 自己分支可以快进：`git merge --ff-only origin/main`。
- 自己分支有独立提交：审查 `git log --oneline HEAD..origin/main`，再合并或选择性 cherry-pick；不要强行快进、重置或覆盖自己的改动。
- 只接收本次修复：确认现有实时校验 helper、`acpErrorCode`、默认模型事务已存在，然后 `git cherry-pick 6d63cb6fa672918796bf527439d326bb46ad284c`。缺少这些基础实现时先评估相应前置提交。
- 若双方都修改模型切换：保留“校验成功后才修改会话”的顺序；不要以静态列表替代实时列表；保留 `updateDefaults`、`onError`、`superseded` 和当前会话守卫。
- 翻译冲突按键合并，保留其他语言修改及消息对象结构；不要整文件采用一方。
- 合并后重新构建后端和桌面程序。旧二进制加载新 UI 不代表修复生效。

前一批已提交的记忆／延迟修复见[前次交接文档](2026-10-09-memory-fixes-merge-handoff.zh-CN.md)：`7b34092cf`（记忆）、`803f9431b`（审计）、`bc4ff081d`（等待超时），文档提交 `eadb7cf98`。本次没有重新打包这些代码为重复提交。

## 已完成验证

| 层级 | 结果 |
| --- | --- |
| Windows ACP 集成测试 | 1 项通过，涵盖上述真实 ACP 通道和模拟 HTTP 服务边界，退出码 0。 |
| Mac ACP release 集成测试 | 同一测试通过，退出码 0。 |
| 两端前端组件测试 | 每端 2 文件、26 项通过，退出码 0。 |
| Windows 类型检查／ESLint／i18n／Clippy | 最终运行均退出码 0；中途测试脚本断言和翻译类型问题已修正后重跑。 |
| 格式与构建 | Rust 格式检查、Windows 后端构建、Mac arm64 release 后端和安装包构建完成。 |
| Windows 真实 Electron | 原报错会话 `20261009_24` 完成 LAN → Ollama → LAN；约 0.888 / 4.520 / 0.942 秒。核对页脚、持久化和默认设置；旧模型被拒绝且选择不变。新会话 `20261009_26` 使用新 LAN 模型实际回复“模型切换正常”。 |
| Mac 安装版 bundle43 | 会话 `20261009_21` 完成 LAN → Ollama → LAN，约 0.412 / 4.041 / 0.435 秒；核对持久化并实际回复“模型切换正常”。 |

现场两端 LAN 配置不同：Windows `192.168.9.120:8001`，Mac `192.168.9.101:8001`。Mac 的实时模型是 `Qwen3-VL-30B-A3B-Instruct-FP8`。没有为了测试修改这些已有地址。时延是本次观测值，不是性能保证。

### 验证命令与证据

在 README 约定的现有平台环境中运行，下列命令供同事合并后复验；Mac ACP 测试另外使用 `--release`，打包入口为 `node ui/desktop/scripts/bundle-macos.cjs --arch arm64 --backend target/aarch64-apple-darwin/release/goose`。

```powershell
# 仓库根目录 / repository root
cargo test --locked --offline -p goose --test acp_unauthenticated_custom_provider_test --jobs 1 -- --test-threads=1
cargo clippy --locked --offline -p goose --lib --test acp_unauthenticated_custom_provider_test --jobs 1 -- -D warnings
cargo fmt --all --check
# ui/desktop
pnpm exec vitest run src/components/ModelAndProviderContext.test.tsx src/components/settings/models/subcomponents/SwitchModelModal.test.tsx
pnpm exec tsc --noEmit
```

本机证据位于 `target/model-switch43-20261009/`（测试日志、退出码、根因、会话导出及截图）；Mac 位于 `target/macos-acceptance43/`。这些包含本地验收数据，不提交 Git；文档中的结论是脱敏摘要。真实应用测试使用带既有未提交修改的工作区构建，不等于对本次纯提交快照做了全量验收。合并后的组合须由同事按上面步骤复验。

## 安装包与限制

- Mac 桌面目录：`~/Desktop/CodeBuddy-Mac-Test-20261009-bundle43/`。
- 已安装：`~/Applications/CodeBuddy-Test-20261009-bundle43/CodeBuddy.app`。
- DMG：`CodeBuddy-arm64.dmg`，SHA-256 `805d3207527b351d6ff9213110a08c6684c885c5ed65c8cd009a3cfbd5f9a6f1`。
- 安装结构、DMG 校验、签名完整性、后端哈希一致性通过。Apple Silicon 内部测试包、ad-hoc 签名；Intel、Developer ID 公证、Gatekeeper 和 Finder 拖拽安装未验收。安装包及配置／密钥均不提交源码仓库。

## 单独记录的现场现象

原来的记忆清空会话在切换成功后，续发消息曾触发“恢复判断等待模型超时，原任务没有改变”。新会话同模型已正常回复；本次没有修改恢复判断状态机或延长超时，因此不把该现象宣称为已修复。随后 Windows 的 120 服务又出现连接拒绝，发生于成功回复之后；服务可用性需要服务端保持运行。这两项与已确认的旧列表校验根因分别记录。
