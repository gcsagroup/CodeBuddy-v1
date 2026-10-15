# 工具发现、扩展启用确认与 Mac 授权诊断（2026-10-13）

[繁體中文](CAPABILITY_PERMISSIONS_20261013_ZH_TW.md) · [English](CAPABILITY_PERMISSIONS_20261013_EN.md)

## 实际问题

用户提供的 Mac 会话 `20261013_1`、`20261013_2` 来自 `c3a537517a464053d090bc1983bafeddd00a79df + dirty`。

- 第一份会话先调用 `list_functions`，随后宣称没有桌面工具。这份清单实际仅列代码模式允许的只读回调，代码明确排除了电脑控制。导出文件只有最终扩展快照，不能倒推第一轮当时的开关状态；该清单本身也不足以证明能力不存在。
- 随后的第一份会话和第二份会话真实调用了 `qwen_computer__list_apps`，工具返回录屏权限错误；这些调用证明当时电脑扩展已加载，失败发生在原生权限检查阶段。
- SSH 只读核对发现两个应用同时运行：`/Volumes/CodeBuddy/CodeBuddy.app` 的标识是 `local.codebuddy.desktop`，旧 `~/Applications/CodeAgentPro-Test-20261001-4nejwg57/CodeAgentPro.app` 的标识是 `local.codeagentpro.desktop`。截图勾选的是旧 CodeAgentPro，不能作为新 CodeBuddy 当前进程获得授权的证据。
- Swift 助手只做 `CGPreflightScreenCaptureAccess` 检查，失败后直接返回文字，没有发起系统授权请求。现有错误还把应用名写死，缺少实际路径与身份信息。

## 修复范围与职责

| 文件 | 变化 |
| --- | --- |
| `crates/goose/src/agents/platform_extensions/code_execution.rs` | `list_functions` 保留只读回调定义，同时消费 ExtensionManager 的真实扩展/工具清单；标明清单不等于执行权限，不把电脑工具伪装成 TypeScript 回调。 |
| `crates/goose/src/agents/platform_extensions/ext_manager.rs` | 指引模型发现所需扩展后提出启用请求，等待宿主确认；已加载能力不再要求重复启用，系统权限与扩展启用分开处理。 |
| `crates/goose/src/permission/permission_inspector.rs` | 对 `manage_extensions(action=enable)` 使用已有批准流程，自主模式不默认跳过；明确的已有允许/拒绝和会话范围授权继续生效。没有新增 ACP 接口或权限持久化格式。 |
| `crates/goose/src/agents/extension_manager.rs` | 回归验证代码模式外的电脑工具仍能被发现，移除后清单及时失效。 |
| `tools/qwen-computer-use/macos/RuntimeContract.swift`、`runtime.swift`、`contract-tests.swift` | 已授权不提示；缺少录屏/辅助功能权限时调用系统请求，再复查。错误带当前应用名称、bundle ID 和路径，单独运行助手不冒充主应用。doctor 保持只读，不弹窗。 |
| `ui/desktop/forge.config.ts` | 添加录屏与辅助功能用途说明。 |

扩展加载事实继续归 ExtensionManager；启用审批继续归 PermissionInspector；Mac 权限事实继续归原生助手。没有通过扫描用户自然语言决定授权，也没有读取或修改 TCC 数据库。系统提示仍需用户选择，提示出现本身不是授权成功。

## 验证及交付

- `cargo test -p goose --lib permission::permission_inspector::tests --jobs 1`：53 项通过，退出码 0（包含新增启用确认回归）。
- `cargo test -p goose --lib --features code-mode capability_activation_catalog --jobs 1`：1 项通过，退出码 0；首次新增测试使用了错误的 MCP 内容方法引用（退出码 101），修正测试写法后重跑通过。
- `node --test ui/desktop/scripts/macos-package.test.cjs`：15 项通过，退出码 0。
- Mac 使用 `xcrun swiftc -parse-as-library -O -target arm64-apple-macos14.0` 编译原生合同测试与完整助手；合同测试和两次编译均退出 0。覆盖已有权限不重复请求、拒绝后仍拒绝、请求后复查及应用身份定位。完整助手保留一条既有 API 弃用警告。

- `cargo test -p goose --lib --features code-mode agents::platform_extensions::code_execution::tests --jobs 1`: 12 项通过，退出码 0。
- `cargo fmt --all -- --check`, `git diff --check`: exit 0.

- 日志与输入哈希：`target/capability-permissions-20261013/`；只作为本地证据，不纳入源码提交。

- 本地源码：`D:\Users\jiangrui\Desktop\CodeBuddy`，`main / 964bbeb1587f1c5551ee17907e0b26632c4163ce` 加前批及本批未提交修改。
- Swift 验证使用本地修改文件的独立构建产物，文件哈希与远程输入一致；没有覆盖远程不同 revision 的源码或当前应用。
- 尚未执行真实系统授权弹窗、批准/拒绝后的完整桌面流程或微信发送验收。没有发送消息、切换用户应用、修改系统权限、生成安装包、提交或推送。本批自动验证不证明已安装程序已修复。
- 已有用户明确授权“始终允许”时复用其选择；没有授权时需经现有确认卡。模型仍须调用扩展管理工具提出启用请求，发现清单不自动执行或授权。
- 安装位置与应用身份应稳定；当前从 DMG 运行的新应用和旧应用并存，单独授予旧应用权限不会验证新应用。以后应从确定的安装位置启动并按系统提示授权。

参考：[Apple 录屏权限说明](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac)、[系统授权请求 API](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess%28%29)。

## 后续 Mac 安装交付更新（2026-10-13）

本节更新前述源码修复阶段的“未安装”状态。

- 已生成 1.43.2 / arm64 安装包，放在远程桌面 `CodeBuddy-Mac-20261013-permissions`，安装到 `/Applications/CodeBuddy.app` 并正常启动；旧应用、用户配置和历史保留。
- 本地源码 `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`。远程 Git 基线仍为 `c3a537517a464053d090bc1983bafeddd00a79df + dirty`；35 个差异文件备份后同步，2,054 个构建输入核对一致。产物内 revision 记录远程基线，实际内容映射见 `source-applied.json` 和 `delivery.json`。
- 后端 release、bundle、安装冒烟均退出 0。Mac 包脚本测试 15 项、扩展组件测试 16 项通过。安装冒烟覆盖 DMG 校验、签名完整性、安装副本启动、文件读写搜索、真实 PTY 和 WebContentsView。
- 真实对话 `20261013_3` 使用现有 Ollama / deepseek-v4-pro:0813。缺少录屏权限时真实弹出当前 CodeBuddy 授权，工具回执包含准确应用路径。用户授权并重启后，list_apps 返回 6 个窗口，工具回执成功且未重复弹窗。未发送外部消息。
- **整体验收部分通过**：工具成功后仍有重复完成检查，最终状态为 `paused / completion_blocked`、终态 `interrupted`。录屏授权和窗口列举通过，不代表整轮完成状态通过。模型自述的成功不作为宿主成功证据。
- 未验收：禁用扩展后的真实批准卡、辅助功能输入权限、Gemma/MCP 全套产品回归、Intel 和 Developer ID 公证。当前包为 ad-hoc 内部测试包。
- 首次默认旧 target 缓存构建出现 xet-runtime E0463；复用当天既有成功构建脚本的 target 后通过，未清缓存、安装依赖或更换工具链。交付辅助脚本针对 Mac 旧 Python 缺少 hashlib.file_digest 调整为流式哈希，重跑退出 0。
- 本轮无额外产品源码修改、提交或推送。本地安装包、三语说明与回执：`target/mac-update-permissions-20261013/delivery/`。

### Commands and artifact identity

All final commands exited 0 in the established remote build environment:

```text
cargo build --release -p goose-cli --bin goose --target aarch64-apple-darwin --jobs 1 --locked --offline
node ui/desktop/scripts/bundle-macos.cjs --arch arm64 --backend /Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001/target/macos-release-20261013/rust-build/aarch64-apple-darwin/release/goose
node ui/desktop/scripts/macos-install-smoke.cjs
node --test ui/desktop/scripts/macos-package.test.cjs
# cwd: ui/desktop
pnpm run test:run src/components/settings/extensions/modal/ExtensionModal.test.tsx
```

DMG SHA256: `ec96e52d8da95f9f9f444885d8347c3978041c84c8529636197361bfcd789b9e`.
Backend SHA256: `5cc9995191d8aae5d610a3b4813188e28ba3f6a3550ca1021786e67c7c930a7c`.
Remote installation evidence: `ui/desktop/out/macos-install-LxevkV/result.json`.
Build logs: `target/mac-update-permissions-20261013/{backend,bundle,install}.log`.
