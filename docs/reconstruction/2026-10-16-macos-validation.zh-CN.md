# 2026-10-16 Mac 统一测试记录

[繁體中文](2026-10-16-macos-validation.zh-TW.md) · [English](2026-10-16-macos-validation.en.md)

本轮在 `D:\CodeBuddy-v1`、`main`、基线 revision `732113504de3601ab087a609ce20827b814db2c2` 加未提交 Mac 适配上执行。未切换分支、未提交、未推送。测试使用项目已有依赖和现有 Node 24.21.0，未安装依赖。

## 已执行：Windows 自动化

| 命令或目标 | 退出码 | 结果 |
| --- | --- | --- |
| `node --test ui/desktop/scripts/macos-package.test.cjs scripts/harness-macos.test.cjs scripts/start-harness-preview.test.cjs scripts/harness-dependencies.test.cjs runtime/tests/builtin-artifacts.test.mjs runtime/tests/builtin-extensions.test.mjs` | 0 | 32 通过 |
| `node --test runtime/tests/*.test.mjs` | 0 | 363 通过 |
| `node ui/node_modules/typescript/bin/tsc --noEmit --project ui/desktop/tsconfig.json` | 0 | 类型检查通过 |
| `cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1` | 0 | 69 通过，1 忽略 |
| `cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings` | 0 | 通过 |

上表 Node 使用现有 Codex `cua_node` 中的 Node 24.21.0 绝对路径调用。类型检查首次误用了 `ui/desktop/node_modules/typescript/bin/tsc`，退出 1，模块尚未加载；更正为实际提升的 UI 根目录依赖后通过。这是验证命令路径错误，没有据此修改产品或安装依赖。

Rust 忽略项为既有公网 Open-Meteo 测试，未启用。首批 32 项与运行时全套有重叠，不相加声称独立覆盖数量。真实 MCP 发现/调用发生在 Windows 的独立工具进程；Mach-O 及签名哈希用例为夹具检查，不证明 Mac 原生执行或真实签名成功。已执行检查没有发现项目缺陷，本轮尚无产品修复。

## 尚未执行：Mac 原生与产品验收

RustDesk 窗口已读取，显示目标 ID 和“正在接入 RustDesk 网络”。连接动作后未出现远程桌面窗口，没有取得 Mac 实时画面或当前源码目录。已请用户手动连上目标 Mac 并保持解锁。该阻塞不记为项目测试失败。

因此下列项目均为待执行：Mac Go/Swift 合同测试、同批原生工具构建、安装包生成、签名和安装检查、真实电脑控制、Mac 独立 MCP 执行。尚无本批 Mac 安装包或产品 PASS。历史 Mac 包、历史截图和此前验证结果不作为本轮证据。

后续须核对远端 revision 和未提交差异，准备/复用独立测试 profile；先做原生自动化和打包，再验收 TCC、只读截图、隔离中文输入及窗口切换、PDF/缓存/图表/时间天气 MCP，保留命令退出码、可见后置结果和包内工具身份。授权/密码弹窗由用户处理，不重放未知输入。

本地证据位于 `.preview-evidence/mac-acceptance-20261016/automated-results.json`，包含实际检查结果及测试源码文件哈希；同目录 `source.patch` 和 `added/` 是待同步的当前差异及新增源码，未传输到 Mac。它们属于忽略的本地验收材料，不纳入提交。

## 后续恢复：RustDesk 已连接，输入仍待确认

用户再次要求继续后，RustDesk 出现 `159817412@erjinyidemacbook-air.local` 远程窗口，已观察到 Mac 桌面，菜单时间从 19:03 更新至 19:06。此前“尚未连接”的状态已失效；但打开 `work` 文件夹和还原 RustDesk 窗口的动作都没有产生可见变化，输入派发尚未确认，不能宣称远程控制已正常。

辅助 SSH 探测确认可到达同名 Mac 主机，但现有凭据认证失败，退出码 1，返回 `Permission denied (publickey,password,keyboard-interactive)`。首次主机记录仅保存到本地验收目录的 `known_hosts`，未修改全局 SSH 信任配置，未读取或输入密码，未执行 Mac 命令。

已请用户将 RustDesk 远程窗口移到 Windows 主屏并置前、手动打开 Mac 的 `work` 文件夹并提供项目路径。构建/安装/桌面及 MCP 验收仍待这一输入或执行通道恢复。当前 21 个实施源码/配置文件与此前通过自动化时的哈希一致；这是证据复用核对，不是重跑测试或 Mac 验收。后续状态保存在本地 `rustdesk-resume.json`。

## 输入通道诊断：Windows 权限级别不一致

后续已确认 RustDesk 位于 Windows 主屏，但目录双击、标题栏操作仍无可见后置变化。只读进程令牌检查返回：当前执行进程 `elevated=0, uiAccess=0`，两个 RustDesk 界面进程（PID 27456、57876）均为 `elevated=1, uiAccess=0`；命令退出 0。RustDesk 版本为 `1.5.0+68`。会话日志未发现键鼠权限关闭记录，但这不等于已证明 Mac 辅助功能授权有效。

权限不一致构成明确的本地输入阻塞线索；[微软 SendInput 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)说明 UIPI 只允许向相同或较低完整性级别注入输入。通过受支持的正常应用入口再次启动 RustDesk 后，返回的仍为原窗口，未得到普通权限的新界面。已请求用户退出 Windows RustDesk 并普通双击重开、连接原 Mac。没有改变 UAC、应用权限、Mac TCC 或凭据，没有执行 Mac 命令。

该诊断尚未构成修复成功：恢复后须重新核实窗口与权限，完成一次有可见后置结果的点击和输入，再执行同批源码同步、Mac 原生构建、安装及电脑控制/独立 MCP 验收。本轮未重跑此前通过的 Windows 自动化，Mac 各项仍为 `NOT_RUN`。本地诊断见 `rustdesk-input-diagnostic.json`。

## 已恢复：远控点击与原生命令执行

用户普通启动 RustDesk 后，新界面进程 PID 为 10972，远程窗口 ID 为 14881372。已通过真实双击打开 Mac `work` 文件夹，观察到普通按键输入，并使用远端原生“编辑 → 粘贴”执行 `uname -m`，得到 `arm64`。批量文字快捷键仍有 Windows/Mac 映射差异；翻译模式未解决，已恢复传统模式，命令使用原生粘贴并核对后执行。“新命令”未勾选“在 Shell 中运行命令”时的带引号查询曾报 `unmatched '`；勾选后环境查询正常输出，该错误不记为产品测试失败。

实机观察到 macOS `27.0.1`、Node `v26.3.0 arm64`、Go `go1.26.5 darwin/arm64`、已安装 Rust `1.96.1-aarch64-apple-darwin` 和 Xcode Swift 编译器。文稿目录的系统授权由用户手动允许。在 Desktop、Documents、work 的深度 4 查询范围内未找到 CodeBuddy 目录，这不是全盘扫描结论。

本地已准备并验证包含 `main@7321135`、未提交差异、新增源码和哈希清单的同步包，尚未传输。已请求授权在 `/Users/erjinyi/Desktop/work/CodeBuddy-v1` 准备源码，并按锁文件安装 Mac 依赖和 Office 载荷。原生构建、安装包及产品电脑控制/独立 MCP 验收仍为 `NOT_RUN`；远控恢复不等于产品工具验收。详见本地 `rustdesk-input-recovery.json`。

## 原生准备进展：同批源码已校验，Office 准备待修复

用户已授权在 `/Users/erjinyi/Desktop/work/CodeBuddy-v1` 创建本批源码目录、准备锁定依赖及 Office 载荷，并继续构建验收。RustDesk 内置文件传输完成 1/1 文件、77.34 MB；远端运行外层 SHA256 门禁成功后进入脚本，内层 `source.zip` 哈希检查返回 `OK`。源码应用与校验完成，`source-verify` 退出 0，36 个改动/新增文件的 LF 归一化哈希与清单一致，基线为 `732113504de3601ab087a609ce20827b814db2c2`、`main`、dirty。既有 `/Users/erjinyi/CodeBuddy` 未覆盖。

首次准备在安装前以退出 2 停止：根目录选中的 pnpm 为 12.8.1，项目指定 11.9.0。续跑显式使用 `corepack pnpm@11.9.0`，保留源码与系统包管理器。依赖阶段已推进到 Office 准备；现场明确观察到 `harness-dependencies`、`office-builder-dependencies` 均退出 0。期间 npm 官方源有慢请求和重试警告，未修改锁文件或切换镜像。

Office 准备在系统 Node `v26.3.0` 下退出 13，报 `Detected unsettled top-level await`，位置 `scripts/prepare-harness-office.mjs:30`。现场输出目录 `runtime/office-assets` 为空，下载缓存已有 Python 和首个 NumPy 归档；该现象的根因尚未确认。两处常规 Homebrew Node 24 路径未发现可执行文件。正在按上游锁文件下载项目内 Node `24.21.0`、`darwin-arm64`，预期 SHA256 为 `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`，校验后再重试；系统 Node 26 保留。此前 Windows 检查继续作为复用证据，不算作本轮 Mac 原生测试。

源码准备日志：`/Users/erjinyi/Desktop/work/.codebuddy-source-20261016.kbeXOp/prepare-build.log`。依赖与失败日志：`/Users/erjinyi/Desktop/work/.codebuddy-source-20261016.KJbc8Z/prepare-build.log`。原生测试、原生安装包、真实电脑控制与独立 MCP 产品验收尚未执行。没有提交或推送。

## Keychain 适配与重测（本轮续作）

用户已批准 Keychain 主密钥 + AES-GCM 方案。已实现独立 Swift helper、版本化密文、固定产物校验及构建接线；Windows 完整运行时 365/365 通过（退出码 0，日志 `.preview-evidence/mac-acceptance-20261016/windows-runtime-keychain.log`），相关打包及凭据两组回归 21/21、38/38 通过（覆盖有重叠，不作新增覆盖累加）。Mac 首轮仍为 311 通过、46 失败、6 跳过。本次增量包已传输，但尚未应用：RustDesk 重连恢复实时画面后确认 Mac 停在登录锁屏，等待用户解锁。Mac Keychain 编译/执行、重测、原生安装包及电脑控制/独立 MCP 产品验收仍待执行。

## 2026-10-17：原生工具通过，安装包前回归仍待完成

上述增量已在 Mac 应用并校验。Swift Keychain 原生合同测试退出 0，覆盖真实 Keychain 主密钥读取/重开、Unicode、空值、缺失密钥不创建及篡改拒绝。Rust 原生编译发现 `ProcessSession` 所需 feature 未开启，已在 `crates/goose-mcp/Cargo.toml` 启用现有 `process-session` feature；没有新增依赖。修复后 `native-tools` 退出 0，原生工具产物生成成功；`package-tests` 18/18、退出 0。证据：本地忽略目录中的 `mac-native-v3.log`。

同次 Mac `npm --prefix runtime test` 为 360 通过、4 失败、1 跳过，退出 1。失败涉及 XDG 缓存断言、`/var` 与 `/private/var` 路径别名、隔离 HOME 下凭据访问、压缩中断后冷启动恢复。已修正测试夹具/断言、将 Mac 凭据子进程 HOME 绑定到登录用户主目录，并准备 Harness 持久化根目录 canonicalization；最后一项仍为待原生验证的修复假设，工作区符号链接拒绝策略保持原样。

最新 Windows 完整回归 365 通过、0 失败、1 项 Mac 专用跳过，退出 0（`windows-runtime-v4.log`）；不作为 Mac 通过证据。六文件 `mac-native-v4.zip` 已传到 Mac，SHA256 为 `99fb3a55938f498ecdd971da3692c755b36e7efd8cfc90f5bcccacfb60638d66`，尚未应用：再次重连确认 Mac 自动锁屏，等待本人解锁。续跑命令已准备独立、限时的 `caffeinate`，避免测试退出后保活随之结束。

源码仍为 `main@7321135` 加本批未提交修改，无提交/推送。Rust 库测试及 Clippy、原生 DMG 构建、安装后冒烟、安装应用内电脑控制与独立 MCP 实际操作均待执行。最终验收以本批 Mac 原生安装包安装后的应用为对象；原生工具编译和工具清单不等于产品验收。

## 2026-10-17：Mac 回归通过，进入安装包验收

解锁后已应用 v4b、v5 增量。v4b 原生运行时为 364 通过、1 失败、1 跳过；规范化持久化路径未解决冷恢复失败，该候选修改已撤回。进一步追踪发现官方 JSONL 插件存在 200ms 写入缓冲，适配层此前未在返回完成回执前等待落盘。现使用 Harness 既有 sessions.flush，在回复完成前提交其原生持久化队列；未新增持久化 owner 或格式。崩溃回归同时断言开始压缩前原始事实已经落盘。

Mac v5：npm --prefix runtime test 365 通过、0 失败、1 跳过；cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1 为 69 通过、0 失败、1 忽略；cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings 通过。三个阶段退出码均为 0，证据为本地 mac-native-v5.log。跳过项为 Windows 凭据集成用例，Rust 忽略项为公网 Open-Meteo。Windows 压缩与恢复定向回归 7/7 通过、退出 0。

原生打包首次在预打包工具调用检查退出 1：verify-harness-stage.mjs 直接创建的会话缺少 commonqueries 必需的设置元数据。现复用 openStore/commonQueryMetadata 接入原生会话 mcpRequestMetadata；相关真实 MCP 回归通过，退出 0。v6 修复已应用，正在从打包阶段续跑，DMG 和安装后产品验收尚未形成通过结果。源码仍为 main@7321135 加未提交改动，无提交或推送。

### v6：应用已生成，签名后 Keychain 授权待本人处理

v6 预打包原生服务检查通过，sourceDigest 为 532c35c9c7a0169135d387ff398fdb929af6a0bfc63675e53ce5ff9da6ab1d95；实际验证了 Shell、Office、MCP 发现及时间/缓存调用、凭据保护。Electron Forge 已生成 ui/desktop/out/CodeBuddy-darwin-arm64/CodeBuddy.app，并完成 ad-hoc 签名和首轮 codesign 验证。随后从签名后的应用执行凭据复测时，macOS 弹出 codebuddy-credentials 访问 local.codebuddy.credentials.v1 的钥匙串认证；30 秒等待超时，native-package 退出 1。已请求用户本人处理该系统认证，未读取或输入密码、未更改钥匙串 ACL。该阻塞不等于凭据算法测试失败；签名后凭据验证仍未通过，DMG 未生成，安装后冒烟/电脑控制/独立 MCP 产品验收未运行。日志 mac-native-v6.log 已回传。


## 2026-10-19：原生安装包通过，电脑输入仍在定位

本节更新上述历史阻塞。Keychain 授权处理后，v6 的 native-package、package-smoke、install-smoke 均退出 0。已回传并核对 mac-native-v6.log、macos-install-2VVt43/result.json 和 artifacts.json：Apple Silicon 1.43.5 DMG/ZIP 已生成；DMG 校验、只读挂载、复制安装、codesign 检查及安装副本 smoke 通过。构建为 main@732113504de3601ab087a609ce20827b814db2c2 + dirty，sourceDigest=532c35c9c7a0169135d387ff398fdb929af6a0bfc63675e53ce5ff9da6ab1d95，ad-hoc 签名，未公证。

安装副本为 ui/desktop/out/macos-install-2VVt43/installed/CodeBuddy.app。隔离夹具改用 LaunchServices open -n -W 启动，按用户授权为该批应用添加录屏、辅助功能及桌面访问。installed-mcp-YMIJp8 回执证明应用内 ACP 调用的时间、缓存列表、真实 PDF 提取、图表结构化回执通过；电脑工具列举窗口、PNG 截图及 AXTextArea 观察成功。click 在原生前台检查拒绝，未派发输入；中文/emoji 输入和保存尚未执行。未使用真实模型对话，图表渲染与完整产品 E2E 尚未验收。

本地证据：.preview-evidence/mac-acceptance-20261016/received-20261019/；远端证据包：/Users/erjinyi/Desktop/work/mac-evidence-20261019.zip。DMG SHA256=5259849878c0b794e7ab02854f6b5185d87d2c7678e617122477ccb67771777e。该哈希仅对应 v6，后续重建不得复用此结论。

只读 Swift 探针中，异步入口与 AppKit run loop 入口均返回实际前台进程；单独隔离 HOME 亦正常，两个命令退出 0。AX 查询因终端未授权返回 -25204，额外终端授权请求已关闭，未扩大权限。已给 runtime.swift 的前台拒绝回执增加期望/实际 PID 与窗口信息；未放宽输入保护。诊断增量 v8 已通过源码前置哈希校验应用到 Mac，正在执行原生回归及重建，尚无该新安装包验收结论。未提交或推送。
