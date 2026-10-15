# Mac 微信操作延迟：诊断与修复记录（2026-10-13）

## 范围与来源

- 用户提供的会话 `20261013_4`，工作目录 `/Users/erjinyi/CodeBuddy/2026-10-13-19-02-42-93a67918`，主模型 `custom_ollama/deepseek-v4-pro:0813`。
- 本次源码：`main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`。保留之前的 MCP、权限、Gemma 和合同修复；本记录只描述微信延迟这次增量。
- 会话与截图含个人资料，仅保存在本地 `target/mac-send-latency-20261013/`，不纳入 Git。

## 已验证的现象

会话约从 19:02:42 持续到 19:08:22，最后取消，未取得“你好”发送成功回执。

| 项目 | 记录 |
| --- | --- |
| 带宿主审计的工具调用 | 35 次 |
| 工具耗时累计 | 54.172 秒（不是端到端耗时） |
| 原生电脑工具累计 | 2.590 秒 |
| 最长工具 | 临时 Swift OCR 脚本 30.850 秒 |
| 工具回传图片块 | 9 个（不代表 9 次视觉分析） |

截图采集成功；模型输入中的辅助视觉路由关闭，使文本主模型未获得图像理解结果。微信的无障碍树稀疏，模型转而编写 OCR、读取其他截图、估计缩放与位置，多轮调用扩大了等待。其余时间还包含模型生成、授权等待、工具间隔；本记录没有独立网络分段计时，不能全部归入“模型慢”，也没有模型连接超时证据。

第一阶段缺少辅助功能权限。用户继续后，搜索输入打开无标题浮层；输入 Jr 被焦点检查拒绝。原始浮层截图是“搜索网络结果”，不是已验证的联系人会话。之后点击又被遮挡检查拒绝。

## 根因与边界

1. **视觉缺失反馈不足**：原来的通用 provider 错误只说明辅助视觉关闭，没有指导通过现有 ask_user 等待用户选择配置。启用电脑控制扩展并不等于启用辅助视觉。
2. **焦点定义错误**：原生实现用窗口叠放顺序第一个窗口代替键盘焦点窗口。非激活型搜索浮层会造成二者不同；本次截图符合该场景。修复使用系统 AXFocusedWindow，与当前进程、窗口几何和标题唯一匹配；匹配不确定时拒绝键盘输入，真实桌面路径仍需验收。
3. **派送回执过早**：激活窗口之前就标记 actionDispatched，导致输入前检查失败也显示“可能已经输入”。现在只在 CGEvent/AX 写操作边界标记；已派送后失败仍保留未知结果，不自动重放。
4. **坐标与窗口信息不足**：模型混用了工具截图与外部 screencapture 图像。现在显式输出所观察和活动窗口的精确选择器及窗口局部坐标范围。

苹果官方将 AXFocusedWindow 定义为应用当前的焦点窗口；它与窗口叠放顺序不是同一事实：[AXFocusedWindow](https://developer.apple.com/documentation/applicationservices/kaxfocusedwindowattribute)。

## 修改文件

- `crates/goose/src/agents/vision_service.rs`：辅助视觉关闭使用明确的 Disabled 错误，归类为配置问题。
- `crates/goose/src/agents/agent.rs`：文本模型缺少视觉时反馈配置选择及 ask_user 指引；主模型本身可识图时保留图片，不因辅助路由失败删除图片。反馈不会擅自启用模型，也不把模型回复变成宿主权限事实。
- `tools/qwen-computer-use/main.go`、`main_test.go`：精确窗口标识、坐标边界与跨窗口观察回归。
- `tools/qwen-computer-use/macos/{RuntimeContract.swift,runtime.swift,contract-tests.swift}`：实际焦点匹配与派送边界，覆盖搜索浮层、真正聚焦弹窗、身份不唯一、进程隔离、派送前失败和部分派送失败。

本次未修改公共 MCP schema、控制面状态、权限授予方式、自动发送规则或用户模型配置。

## 验证进度

- Mac `go test ./...`、`go vet ./...`：退出 0。
- Mac Swift 合同回归及完整原生执行层编译：退出 0。仅构建/单元验证，没有通过这些命令发送消息。
- Mac 打包脚本测试：15 项通过，退出 0。
- Rust：`cargo test -p goose --lib unavailable_vision_keeps --jobs 1 --locked --offline`（1 项）、`cargo test -p goose --lib agents::vision_service::tests --jobs 1 --locked --offline`（25 项）、`cargo test -p goose --lib text_only_model_context --jobs 1 --locked --offline`（2 项），均退出 0。`cargo fmt --all` 已执行。
- Mac release 后端、`bundle-macos.cjs`、`macos-install-smoke.cjs` 均退出 0。安装冒烟覆盖独立夹具，不等于微信交互验收。
- 2054 个构建输入与远程逐文件哈希一致。远程 Git 基底为 `c3a537517a464053d090bc1983bafeddd00a79df + dirty`；构建来源需联合本地 revision、源码同步记录读取，不能仅看远程 manifest 的 Git 基底。
- 新版已安装到 `/Applications/CodeBuddy.app`，旧应用备份为远程仓库内 `target/mac-send-latency-20261013/CodeBuddy-before-latency.app`，用户 profile 保留。
- Apple Silicon 安装包：远程桌面 `CodeBuddy-Mac-20261013-desktop-latency/CodeBuddy-arm64.dmg`；本地 `target/mac-send-latency-20261013/delivery/CodeBuddy-arm64.dmg`。
- DMG SHA256：`a90b6b92a14fda71339e5f786043dd10236ba42a6d7f72ff7a09b30e3661925e`。后端 SHA256：`839143ec4f8677dfea3e57281c22568178dbe705976e8d77be056b1e74099711`。包为 ad-hoc 内部测试签名，未验证 Intel 或 Developer ID 公证。
- **产品验收阻塞**：19:49 系统明确返回 `CGSSessionScreenIsLocked=Yes`。RustDesk 停留在 19:34 的旧画面，不能拿该画面证明新版已就绪。已请求用户解锁；缺失视觉时实际 ask_user、微信搜索焦点及真实识图仍未验收。没有执行外部消息发送。辅助视觉设置未擅自更改。

## 验收场景

1. 文本主模型且辅助视觉关闭：只读观察微信，信息不足时明确询问，不生成临时 OCR 绕行。
2. 用户选择开启已配置视觉后：观察当前窗口并核对可见内容。
3. 微信搜索浮层出现时：区分键盘焦点与浮层，不向未经核对的会话发送消息。
4. 前景变更/遮挡：输入前拒绝回执明确；派送后观察失败不重放。

真实发送需另行核对当前对象与内容；历史会话指令不作为本次发送授权。源代码修复、自动测试和实机验收分别记录。当前未提交、未推送。

## 解锁后的补充调查与修复（20:50）

- 用户确认远程已恢复，并要求全部使用 `Ollama / kimi-k3` 测试。实机两次切换失败；后台均在模型发现阶段报 `Connect, TimedOut`，尚未开始识图。
- 独立探测 `https://ollama.com/v1/models`：一次 HTTP 200、总耗时 2.625 秒；将 HTTPS 建连限制为 3 秒时复现 SSL connection timeout；较宽限时请求曾成功，也出现过 15 秒超时。客户端门槛过短与网络波动应分别记录。
- `acp/server/providers.rs` 移除独立的 3 秒建连门槛，保留 30 秒请求总限时、模型与凭据校验。慢建连回归通过：1 项，退出 0，测试耗时 3.22 秒。
- 用户已批准视觉缺失由宿主直接询问并等待的方案。`agent.rs` 保留视觉服务的类型化错误，当前图片缺少理解路径时，经现有 ActionRequired 通道显示处理选项，停止后续模型/工具调用；配置后由重试重新检查。历史图片不阻塞新请求，主模型可直接识图时保留原图。
- 使用现有 elicitation 的 accept/decline/cancel 语义，不新增公共协议、自动授权或第二套状态库；参考 [MCP elicitation](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/client/elicitation.mdx)。
- 本补充逻辑的回归和新版实机验收尚在进行；当前安装包仍是上文 SHA256 对应版本。Kimi K3 尚未切换成功，不计作测试通过。


## 新增验证结果（21:13）

- `cargo test -p goose --lib vision_configuration_ --jobs 1 --locked --offline`：3 项通过，退出 0。覆盖首次拒图后的宿主询问、等待期间不追加模型调用、取消清理、历史图片与可识图主模型。
- `cargo test -p goose --lib provider_persistence_tests --jobs 1 --locked --offline`：11 项通过，退出 0。
- `cargo clippy -p goose --lib --jobs 1 --locked --offline -- -D warnings`：退出 0；`cargo fmt --all` 已执行。
- 前端 ElicitationRequest 组件 4 项、ACP elicitationRequests 5 项通过，退出 0。本机 Node 22 与 package 要求 Node 24 的版本警告保留；没有更换环境。
- 最初前端命令多传了 `--`，过滤未按预期生效，已停止该进程，使用正确文件过滤重跑；被停止的运行不作为通过证据。
- 2054 个本地与 Mac 构建输入哈希一致；Mac 正在构建新包。
- 21:13 再次检查，Mac 系统返回锁屏，RustDesk 仍为 20:30 旧画面。实机 Kimi K3、宿主询问与恢复验收待解锁和新包安装后进行。


## 新包交付（21:29）

- 新后端 release 构建、bundle、安装冒烟全部退出 0；已安装到 `/Applications/CodeBuddy.app`，通过 codesign 严格校验。
- 新包（arm64，1.43.2，ad-hoc）：远程桌面 `CodeBuddy-Mac-20261013-vision-pause/CodeBuddy-arm64.dmg`；本地 `target/mac-send-latency-20261013/vision-pause-delivery/CodeBuddy-arm64.dmg`。
- DMG SHA256：`bd667cf618d240ed63cc1ad16d7325a25f72f8cb856a9574b99e86020c9cab45`；后端 SHA256：`fdabb89890c7a00ac36e04735ea08c29f98b35dd431aac8b3582b1149538af49`。本节包包含宿主视觉询问与建连限时修复，取代上文旧包作为本轮候选。
- 旧应用备份：远程仓库 `target/mac-send-latency-20261013/vision-pause/CodeBuddy-before-vision-pause.app`；用户资料保留。源码身份为本地 main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty，与远程 2054 个构建输入一致。
- 21:19 已确认桌面解锁，但 21:27 再次自动锁定；21:29 系统确认 `CGSSessionScreenIsLocked=Yes`。已启动新版桌面进程，尚无新版 renderer 就绪证据。已再次请求用户解锁。真实 Kimi K3 切换、识图与失败恢复尚待验收；没有对外发送消息，未提交或推送。


## 解锁后实机验收（23:21）

- 新版 `/Applications/CodeBuddy.app` 于 22:49 启动并完成 React 就绪；使用新后端日志 `20261013_224941.log`，排除同时运行的旧测试应用。
- **实际模型切换通过**：设置页和新对话均显示 `Ollama / kimi-k3`，会话 `20261013_5` 持久化为 `custom_ollama / kimi-k3`。模型发现耗时 1016 ms，返回 18 个模型。
- 新对话“CodeBuddy窗口只读验收”通过真实 UI 提交只读观察请求。调用 `list_apps` 后 macOS 弹出明确的 CodeBuddy 录屏授权提示，工具回执说明当前 `/Applications/CodeBuddy.app` 缺少录屏权限；没有派送桌面输入。
- 本轮随后明确解释权限阻塞并询问下一步，没有重复截图或对外发送消息。此结果验证了本轮模型请求/回复与权限错误反馈，**尚未进入图像理解，也未触发新增的视觉模型缺失宿主问询路径**。
- 已请求用户亲自处理系统隐私授权；真实识图、宿主视觉问询 UI 与恢复、微信焦点流程仍待验收。当前包不因本轮文档更新而重建，未提交、未推送。

## 2026-10-14：录屏开关开启仍被拒绝的根因

- 用户截图显示 CodeBuddy 录屏开关开启。10:48:35 的 macOS tccd 日志确认请求来自 `/Applications/CodeBuddy.app/Contents/Resources/bin/qwen-computer-runtime`，责任应用正确归属 `local.codebuddy.desktop`，不是另一个 helper 的授权遗漏。
- 系统明确记录 `Failed to match existing code requirement ... kTCCServiceScreenCapture`。旧授权要求为 `cdhash 5b9ee82b0866b12ff00e2bfbd26119fa3a6eff2c`，当前应用为 `cdhash 8e849af0e426fc06e6b114ba5c999fce1eb272b0`。这是更新后旧 TCC 授权与当前临时签名不匹配；本次失败发生在截图之前，与模型图片理解及网络超时无关。
- 10:53 后另有安装盘副本从 `/Volumes/CodeBuddy 1/CodeBuddy.app` 启动，属于后续验收的干扰项，不能用它解释此前 10:48 已安装应用的失败。后续检查已看到 `/Applications/CodeBuddy.app` 进程。
- 经用户明确要求移除旧条目，执行 `tccutil reset ScreenCapture local.codebuddy.desktop`，退出 0，系统返回成功；范围仅限 CodeBuddy 的录屏授权。未修改 TCC 数据库、其他应用权限或系统保护。新授权需用户重新添加当前安装应用并确认。
- `RuntimeContract.swift` 的拒绝提示已修正：区分“当前进程被拒绝”和“开关未打开”，解释更新后的旧签名条目，给出移除旧条目/添加当前安装应用的恢复路径，提示退出安装盘副本，避免反复要求切换旧开关。
- 在远程既有源码目录按 `build-macos-computer.cjs` 的 Swift 合同测试入口编译并运行，退出 0。此提示变更尚未重新打包或覆盖正在授权的安装应用；当前候选包仍是上文 DMG SHA256。
- 当前机器未列出有效的 Developer ID Application 签名身份。后续分发升级的权限连续性需要稳定、适用的签名证书及发布配置；临时签名的本地测试包不属于正式签名发布包。参考 [Apple：TCC permissions](https://developer.apple.com/forums/thread/730043)。
- 原始证据：本地与远程仓库 `target/mac-permission-20261014/tcc-signature-mismatch.log`。源码基线 `main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`，保留既有改动；未提交、未推送。授权恢复后的真实截图/识图仍待验收，重置成功不等于产品验收通过。
