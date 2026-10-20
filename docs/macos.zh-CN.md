# macOS 开发与打包

[繁體中文](macos.zh-TW.md) · [English](macos.en.md)

目标为 macOS 14+、Apple Silicon 原生 arm64。脚本也保留 Intel x64 的同架构构建路径。截至 2026-10-19，开发证书签名 v10 批次已生成 DMG/ZIP，原生构建、包内 smoke 与 DMG 安装 smoke 均退出 0。电脑控制完整输入流程和覆盖升级权限保留仍在验收；v10 不包含后续 v11 签名性能修复及最新虚拟宠物改动。初始记录见[本轮测试记录](reconstruction/2026-10-16-macos-validation.zh-CN.md)，签名升级状态见本文末节。

## 架构与范围

Electron 继续启动包内独立 Node 运行 Harness，通过现有 ACP 适配连接界面；执行、调度、完成和压缩的 owner 不变。Mac 使用已存在的官方 Bash 插件。旧 Rust Agent/CLI 不参与构建。

包内包含 Node 及对应许可证、同架构 Python/Office 载荷和运行依赖。分别处理 Electron 与 Harness 的 node-pty，保留 PTY helper 执行权限。打包验证脚本在签名前后运行；签名后的验证数据写在 `.app` 外，避免破坏签名。

已在源码接入以下原生独立工具，保留原配置键与逐次审批：

| 配置键 | Mac 原生产物与能力 |
| --- | --- |
| `qwen_computer` | Go `qwen-computer-use` + Swift `qwen-computer-runtime`；窗口观察、截图、点击、拖动、滚动、键盘、Unicode 文字、设置控件值及辅助动作九工具 |
| `computercontroller` | Rust `codebuddy-tools mcp computercontroller`；PDF、网页文件、缓存 |
| `autovisualiser` | 同一 Rust 工具的图表服务 |
| `commonqueries` | 同一 Rust 工具的时间、位置解析、天气服务 |

源码接入不代表工具已构建或通过验收。工具目录只在对应产物存在且身份校验成功后显示可用；可用也不等于已启用、已连接或 TCC 已授权。Mac 文档服务与 Windows 一样移除旧桌面/脚本路由，不自动安装 Peekaboo。外部 MCP 沿用既有流程。模型对话、项目编辑、Office、历史恢复等继续使用原链路。

## 本机准备

在 Mac 上使用本批源码及其锁文件，准备原生 Node 24+、项目指定 pnpm、Git、Go 1.22+、Xcode Command Line Tools，以及 `rust-toolchain.toml` 指定的 Rust 和本机 Apple target。UI、`runtime`、`runtime/harness` 的依赖须在 Mac 本机准备，避免复用 Windows 的 `node_modules`、Python 或原生模块。安装/下载是独立环境准备步骤，本批已按授权完成。Rust 依赖应事先按锁文件准备；原生工具构建强制离线，Go 禁止自动下载工具链与模块。Go 非 PATH 时使用 `CODEBUDDY_GO_EXECUTABLE`。

依赖准备命令从仓库根目录运行，并在获得下载授权后执行：

```bash
corepack pnpm --dir ui install --frozen-lockfile
npm ci --prefix runtime --ignore-scripts --no-audit --no-fund
npm ci --prefix runtime/harness --ignore-scripts --no-audit --no-fund
npm ci --prefix scripts/office-builder --ignore-scripts --no-audit --no-fund
node scripts/prepare-harness-office.mjs
```

Office 准备复用锁定的官方构建器，根据当前进程选择 `mac-arm64` 或 `mac-x64`。已有 `runtime/py`、`runtime/office` 会保留并报错；混入 Windows 载荷时应先核对来源，不直接覆盖或删除。正式打包复制已有 Office 载荷，并从当前源码构建独立原生工具，不下载依赖。

## 开发启动与安装包

```bash
bash ./start-preview.sh
# 或 node scripts/start-harness-preview.cjs

node scripts/build-harness-macos.cjs --arch arm64 --node-license /absolute/path/to/Node/LICENSE
```

`CODEBUDDY_NODE` 可指定已有 Node 的路径供启动脚本使用。打包命令自身须由目标架构的 Node 执行。`--node-license` 指向该 Node 分发包的许可证文件。桌面目录的 `bundle:mac`、`bundle:default`、`bundle:intel` 均沿用同一 Harness 打包实现；旧 `--backend` 参数已退出。

开发启动会先执行 `scripts/prepare-harness-macos-tools.cjs`，再启动服务和 Electron。该步骤仅构建 Rust/Go/Swift 工具，不运行测试，构建失败立即停止启动。独立执行可用 `node scripts/prepare-harness-macos-tools.cjs --arch arm64`。生成的本地工具清单及二进制不提交；原 Windows 产物与来源文件保留。打包每次使用新的工具暂存目录，不拿旧 preview 工具证明当前版本。

Mac 工具身份记录位于载荷的 `runtime/tools/artifacts.json`。运行时只接受固定的四个本地文件名，校验大小、SHA256、普通文件及执行权限；电脑控制会同时校验前端和 Swift helper。签名时在内部代码签名结束后、外层 `.app` 封装前写入最终哈希，并保留签名前来源，不在应用启动时修改资源。顺序依据 [osx-sign 源码](https://github.com/electron/osx-sign/blob/main/src/sign.ts) 与 [Apple 嵌套签名说明](https://developer.apple.com/library/archive/technotes/tn2206/)。

电脑控制需用户在系统设置授予当前应用屏幕录制/辅助功能权限；工具不会自行授予权限。`doctor` 只读报告桌面与授权状态，锁屏或错误登录会话会拒绝观察/输入。MCP 发现不触发桌面输入。`cmd`/`super` 是 Command，`ctrl` 是 Control；每个动作绑定最新窗口观察，未知执行结果先重观，不重放输入。开发 helper 的 TCC 身份与安装版可能不同，以系统实际回执为准。

构建产物位于 `ui/desktop/out/CodeBuddy-darwin-arm64/`：`CodeBuddy.app`、`CodeBuddy-arm64.dmg`、`CodeBuddy.zip`、`artifacts.json` 与 `SHA256SUMS`。Intel 构建使用 `--arch x64`，ZIP 名为 `CodeBuddy_intel_mac.zip`。清单记录 revision、dirty 状态及暂存载荷摘要；载荷摘要对应签名前文件，安装介质 SHA256 对应最终产物。

默认采用本地 ad-hoc 签名。使用 `CODEBUDDY_MAC_SIGN_IDENTITY` 明确选择已有证书；Developer ID 公证另需 `APPLE_TEAM_ID`、`APPLE_ID`、`APPLE_ID_PASSWORD`。本机已按授权使用开发证书签名；尚未执行公证或公开分发验收。方案参考 [Electron Forge 官方签名说明](https://www.electronforge.io/guides/code-signing/code-signing-macos)，沿用已有依赖，不新增打包框架。

## 后续验证

统一测试命令如下。各批次需要分别记录源码身份、退出码与产物；历史通过项不替代当前批次重测：

```bash
corepack pnpm --dir ui/desktop run test:macos-package
corepack pnpm --dir ui/desktop run test:macos-native
corepack pnpm --dir ui/desktop run typecheck
npm --prefix runtime test
cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1
corepack pnpm --dir ui/desktop run test:macos-smoke
corepack pnpm --dir ui/desktop run test:macos-install
```

后两项须使用同批 Mac 产物。`test:macos-native` 在本机执行 Go/Swift 合同测试；默认构建不执行这些测试。新增用例覆盖固定工具身份、架构/路径拒绝、缺失 helper、签名后哈希及文档工具清单。历史 Mac 批次已执行原生合同测试，当前签名升级与 TCC 验证仍在进行。

脚本 smoke 覆盖启动、工作区、PTY 和内嵌浏览器的接口路径，不替代真实模型对话或完整用户交互。打包验证会检查四个 MCP 的真实工具发现，但不宣称桌面输入通过。后续通过 RustDesk 核对 Finder 启动、中文项目、实际模型与工具调用、退出重启及历史持久化；电脑控制单独验收 TCC、截图、中文输入、窗口切换和动作后置结果。验收前记录 revision、dirty 差异、产物清单和哈希。

开发版数据和日志位于 `.preview-data`；安装版沿用 `~/.CodeBuddy-Harness`，运行日志位于其 `logs/harness`。测试使用独立 profile，保留现有用户数据。

## Mac 凭据保护（2026-10-16）

Mac 使用独立 `codebuddy-credentials` Swift helper，将随机 256 位主密钥保存在当前用户 Keychain，配置仅保存 `macos-keychain-aesgcm-v1` AES-GCM 密文。解密不创建密钥；密钥缺失、锁定、密文损坏及跨平台记录均报错。Windows 继续使用 DPAPI。helper 随原生工具构建、校验和签名，运行时不需要 Swift 编译器。系统授权提示由用户处理。

运行 runtime 测试前先执行 `node scripts/prepare-harness-macos-tools.cjs --arch arm64`，以准备本批四个固定原生产物。`test:macos-native` 同时运行独立 Keychain 测试，使用随机测试服务名和虚构值，结束时仅清理该测试项。

历史状态：Mac 依赖及 Office 载荷准备、Go/Swift 原生组件和类型检查已完成。首轮 runtime 的 311 通过、46 失败、6 跳过属于修复前记录。后续 v6 包内校验已验证凭据保护，原生打包、包内 smoke 与 DMG 安装 smoke 均退出 0；安装版时间、缓存、PDF 提取及图表回执已验证，电脑控制截图后输入仍待修复验收。这些结果不代表当前签名批次或完整产品 E2E 通过。

## 签名身份与升级权限（2026-10-19）

签名构建必须显式设置 CODEBUDDY_MAC_SIGN_IDENTITY 为证书完整名称。Apple Development 用于本机开发验收；Developer ID Application 用于站外分发。设置 APPLE_TEAM_ID 时还必须提供匹配的 Developer ID 身份及已有公证凭据。未选择身份的构建仍为 ad-hoc，不保证跨构建保留隐私授权。

构建后读取主程序与四个原生工具的真实签名，核对证书、Team ID 和应用标识，并在 artifacts.json 记录 designated requirement；环境变量不再充当签名成功证据。不要每次升级重置 TCC 或删除权限条目。保持应用标识、签名身份与安装位置连续，在实际覆盖升级后检查录屏、辅助功能和 Keychain。实时权限查询已存在，但不替代系统授权。

参考：[Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[Electron osx-sign](https://github.com/electron/osx-sign)。本机开发证书的升级保留验收正在执行；Developer ID 分发与公证尚未验收。

v10 本机验收使用 `Apple Development: YuanHong Lin (U3ZPY586Q2)`，实际签名 Team ID 为 `R3JK7R29AC`。证书名称末尾的个人标识与 Team ID 不同，以实际签名为准。当前同一安装副本的虚构凭据加密/解密基线已通过；尚需用下一次构建解密原密文，基线通过不代表跨版本连续性通过。

录屏和辅助功能已为固定安装位置的新签名副本重新添加。安装版已执行时间、缓存、PDF 提取与图表回执检查，电脑控制仍在前台窗口校验处失败。后续应依据真实工具回执修复，再验证截图、中文输入与保存；权限开关开启和工具发现成功均不代替输入验收。
