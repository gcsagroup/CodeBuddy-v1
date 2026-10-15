# Windows → Mac 功能对齐跟踪（2026-10-07）

## Mac 只读审计与取消（stage28，2026-10-07）

已按用户批准的方案接通 audit/cancel。Mac 回应 executionAvailable=false，只显示摘要与取消；Windows 为 true，旧回应保持兼容。复用 root/session/run/sourceMessage/nonce 和生命周期校验，回执只保存在内存，提交／取消／撤销采用同一锁序。取消不延长原有效期，过期后提示新请求并禁用旧提示的重试。

Windows Rust 85/85、原生 Mac Rust 35/35、两端前端各 17/17 通过。两端 Clippy、TypeScript、相关 ESLint 和格式检查退出 0；Mac 保留既有平台告警。真实 Chrome 的正式组件通过摘要／取消／过期交互，文件选择和 ACP 是隔离替身。截图两次超时，不算产品失败；原生回归使用真实临时文件。

bundle28 已重建后端，通过 DMG 校验、挂载／复制／卸载、签名和哈希检查。安装后 ACP 11/11，模型调用 0；包含缺权限 audit/cancel 拒绝及五个只读限制入口。成功审计由原生回归覆盖，完整 Electron 正向流程仍未验收。

其余五个清理入口仍停用，另待 Mac 可见完整流程、Intel／最低 macOS 实机及 Developer ID 公证。本包是 ARM64 ad-hoc 内部测试版。没有新建分支、提交或推送。旧阶段保留当时状态，当前以本节和功能表为准。

Local: `target/macos-release-20261007-bundle28/`

Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261007-bundle28/`

Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261007-bundle28/CodeBuddy.app`

- CodeBuddy.zip: SHA-256 `4be0986bd58408b0fc85891dcab3bfac01486023a8e79979ac7ede2cd76d273d`
- CodeBuddy-arm64.dmg: SHA-256 `b0257855e26ae08ef822699c681c08278ca262d54acd5c5221f3c754c44778a2`

Source: `00a6656df` + dirty. Build manifest: `0b148acbead0021a0d803c5121cfc4fca1f306e9343d111d04565cb0f6d40ec5`. Evidence: `target/macos-parity-20261007/cleanup28-state.json`; commands: `cleanup28-commands.json`.


## 桌面验收调度对齐（stage26）

已移除 Mac 一律无桌面的硬编码。既有 Swift 助手的只读 doctor 现在返回版本 1 结构化桌面与权限事实；Scheduler 直接调用同一原生助手，以 3 秒与 64 KiB 限制读取，只消费 desktopAvailable / permissionAvailable。Windows 原 OpenInputDesktop 检测保留；Linux 仍不宣称支持。旧助手、缺字段、版本不符、非零退出、超时及过大输出均保持等待；不解析说明文字。

原生判定使用 Quartz console/login/UID 与 AX／屏幕录制预检。另采用 Chromium 使用的 CGSSessionScreenIsLocked 拒绝锁屏；此键不是 Apple 公开常量，缺键明确记为 notReported，不声称已证明解锁。这是当下先决条件，非验收回执；每次实际操作仍核对原有权限、窗口与前台状态。SSH 的 TCC 结果只代表该启动环境。未要求授权、未输入、未启动 Electron。

bundle26 已交付并安装至远程独立测试目录。

Windows Rust 回归 58/58、Mac Rust 回归 60/60 通过（含 1 项真实原生助手集成）；两端 Clippy 退出码 0。Swift 新增 9 项环境检查及 Go 助手测试通过。DMG 挂载／复制、签名、安装副本哈希，以及安装后 ACP 4 项检查通过；模型调用为 0。完整 Electron 验收为 NOT_RUN。

Local: `target/macos-release-20261005-bundle26/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle26/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle26/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `9b043631a3b789990b4c2b803149c93b0acc0189fac1483d50e1e50a82573449`
- CodeBuddy-arm64.dmg: SHA-256 `a171966fac61525f012548da5b106897316d5a0d722d7b5266468260340fb586`

清理的七项产品路由及完整 Electron／TCC／Intel 验收仍未完成。

References: [Apple Quartz session API](https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary%28%29), [Apple session properties](https://developer.apple.com/documentation/coregraphics/window-server-session-properties), [Chromium lock detection evidence](https://issues.chromium.org/issues/40594056).


## 工作任务强制停止接线（stage25）

用户在具体方案后回复“继续”，批准既有 owner 接线。PID 与 `SessionProcessOwner` 在 `WorkerRegistry` 同一锁内注册；tracker 与 lifecycle 消费同一引用。OS 操作仍由 `SystemProcessGroupOwner` 负责。强制停止取快照时关闭新注册；终止、runner 取消与退出确认在锁外执行。已确认退出的记录逐笔移除；未确认的记录保留供重试，避免 runner drop 后再次停止时误报完成；过期 generation 与冲突 owner 被拒绝。

Windows 本轮 18/18、Mac 本轮 19/19 通过；两端 Clippy 退出码为 0。bundle25 已重新构建后端，包含 stage24 的 shell 取消／超时与端口归属修复，以及 stage25 的强制停止接线。DMG 挂载／复制／卸载、签名、安装副本哈希与 ACP 启动握手 4 项通过（模型调用 0）。这是 arm64 ad-hoc 内部测试包，未公证。

Local: `target/macos-release-20261005-bundle25/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle25/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle25/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `9aa02168c6fb4260a480074e5e724e7d6c464e424b0db9bd8669085e536bf1bd`
- CodeBuddy-arm64.dmg: SHA-256 `1c1aa6357374559eb695e379ecdde5a9057dfcd35deacb2555a78a20cfaefccc`

新增覆盖 owner 失败与重试、协作取消期间注册、旧 generation，以及 Mac 真实后代退出／父进程先退出／无关进程存活。完整 Electron 流程维持 NOT_RUN。清理写入、桌面验收调度、TCC／Keychain 和 Intel 验收仍有缺口，不能据此宣称完整对齐。


以本机 Windows 工作目录的实际代码为基准：`main` `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`，包含既有待提交合并与 dirty 修改。本表是本轮已追踪的入口清单，并非完整验收证明；共用代码、原生适配、自动测试、安装后 ACP 和可见桌面流程分开判定。


| Feature / 功能 | Windows baseline / 基準 | Mac status / 狀態 | Source / 源碼 |
| --- | --- | --- | --- |
| Model routing, sessions, history / 模型、會話、歷史 | Shared implementation | Shared code; current visible Electron acceptance pending | `acp/server/{providers,new_session,load_session}.rs`, `agents/model_router.rs` |
| Planning, workers, task reports / 計畫、工作任務、報告 | Shared control plane | Shared code; native force-stop gap repaired in bundle25 | `agents/{task_scheduler,control_plane}` |
| Project selection and creation / 專案選擇與建立 | Workspace leases and root allocation | Native Mac leases + writable project-container flow; installed ACP evidence in bundle18/23, visible flow pending | `acp/server/workspace_lease{,_macos}.rs`, `custom_dispatch.rs` |
| Root disk usage / 磁碟容量 | Structured read-only result | Native implementation; earlier installed ACP evidence, not fresh desktop acceptance | `agents/agent.rs`, `workspace_lease_macos.rs` |
| Cleanup: audit, quarantine, restore, delete, cancel, recovery list/retry / 清理 | Seven live Windows routes | Read-only audit and cancellation implemented in bundle28; five mutation/recovery routes remain unavailable | `custom_dispatch.rs`, `workspace_lease/{cleanup_macos,cleanup_api_macos}.rs` |
| Foreground shell cancel/timeout / 前台命令取消與逾時 | Stops tree using taskkill | Implemented with existing process-group owner; Windows 16/16 and native Mac 24/24 passed; included in bundle25 | `developer/shell.rs` |
| Worker forced stop / 工作任務強制停止 | Lifecycle controller invokes native tree terminator | Existing owner reaches lifecycle; native force-stop/retry checks passed; included in bundle25 | `control_plane/lifecycle.rs:140`, `workers/process_tree.rs:496`, `task_scheduler.rs:1035` |
| Background process start/status/stop / 背景程序 | Owned process handles | Shared process API and Unix groups; native listener ownership included in bundle25 | `developer/managed_process.rs`, `workers/process_tree.rs` |
| Listener belongs to launched process / 監聽埠歸屬 | Windows listener PID + owned Job check | Native lsof + existing owner implemented this turn; native 2/2 passed (one subprocess fixture ignored); included in bundle25 | `developer/managed_process.rs:237` |
| File tree, Git review and embedded terminal / 檔案樹、Git、內建終端 | Shared workspace panel | Shared UI with Mac PTY/login-shell adapter; current Electron journey pending | `ui/desktop/src/workspace-panel/` |
| MCP extensions / MCP 擴充 | Shared manager and editor | Shared manager; POSIX argument preservation repaired in bundle23; real extension journey pending | `agents/extension_manager.rs`, `settings/extensions/utils.ts` |
| Computer control / 電腦控制 | Nine tool entries via Windows native runtime | Same nine tool entries via Swift runtime; TCC and visible input acceptance pending | `tools/qwen-computer-use/{main.go,native_runtime.go,macos/runtime.swift}` |
| Desktop acceptance scheduling / 桌面驗收調度 | Checks Windows input-desktop access | Native structured environment probe wired in stage26; real unlocked Electron journey pending | `agents/task_scheduler.rs:95`, `:5422`, `:5459` |
| Keyboard, tray, notifications / 快捷鍵、選單列、通知 | Windows desktop integration | Mac branches and shortcut recorder exist; OS interaction acceptance pending | `ui/desktop/src/main.ts`, `settings/keyboard/` |
| Installer / 安裝包 | Existing Windows build | bundle26 arm64 internal ad-hoc DMG/ZIP delivered; full visible acceptance pending | `target/macos-release-20261005-bundle26/` |

## stage24 修复背景与剩余门槛

先修 Mac 前台 shell 的取消／超时：启动前使用既有 `SystemProcessGroupOwner` 创建独立进程组，向既有 tracker 注册 owner，取消时终止进程组并等待父进程与整组退出。Windows 原路径保留。正常前台命令结束时 owner 释放；持续服务使用既有 `process_action=start`。新增原生回归同时检查后代进程退出、无关兄弟进程仍存活、输出管道关闭与结构化回执。

工作任务强制停止已按 stage25 接线，现有 owner 送达 lifecycle，验证进度见上方。监听端口归属已新增 Mac 原生只读查询，仍由既有 owner 判定，原生回归 2/2 通过。

清理仍受已批准设计第 2 项约束：确认后目标被替换时不得移动另一个对象。Apple 的 renameatx_np 接收父目录 fd 与名称，并未接收预期 inode；额外 rename flags 不能直接证明对象身份匹配。维持原门槛，未将缺口标为完成。参见 [既有设计](MACOS_CLEANUP_DESIGN_ZH_CN.md) 与 [Apple 源码](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/vfs/vfs_syscalls.c)。

本轮不重新触发之前暂缓的 Keychain／TCC 认证。Intel、最低支持系统及完整 Electron 验收仍待完成。没有创建分支、提交或推送。

## 工作任务强制停止接线方案（已批准，历史方案）

现象：`LifecycleController` 只取得 PID，而 `RuntimeWorkerProcessTracker` 保留既有 `SessionProcessOwner`；Mac 的裸 PID terminator 返回不支持。方案 A 依 PID 扫描并结束进程树，身份与后代关系会随时间变化，且重复既有 owner，因此不采用。方案 B（建议）把既有 owner 的引用和 PID 一起注册到 `WorkerRegistry`，lifecycle 取得同一 owner，先终止，再等待可验证的进程组退出回执；缺少 owner 的 Mac 旧记录保持明确未确认，Windows 保留既有 fallback。

范围：`session/session_manager.rs` 的既有 owner trait 补退出确认、`workers/registry.rs` 原注册表保留 owner 引用、`control_plane/runtime.rs` 转送、`task_scheduler.rs` 的 tracker 委派、`control_plane/lifecycle.rs` 消费及测试。原 OS owner 仍唯一操作进程组；不创建第二套 PID 权威，不更改 ACP、持久化格式或重启恢复权限。owner 注册与 PID 注册须在同一锁内完成，终止与等待在锁外；过期 worker generation 不接纳新注册。

验收：原生 Mac shell／测试进程停止、取消前后注册竞态、父进程已退出但后代仍存活、重复停止、owner 失败时不得标完成、无关进程存活，以及 Windows 回归。先通过自动与原生测试，再验收安装后 ACP；可见 Electron 流程保持独立待办。根目录 AGENTS.md 要求跨模块事实注册与核心接口修订先给出比较与边界并取得批准，用户已回复继续并批准本方案；现况见 stage25。

## 2026-10-06 stage27：Finder／Dock 打开项目的启动时序

- 修复 `open-file` 在应用就绪前直接创建窗口的缺口。主进程同步接收事件，等待存储初始化与窗口服务完成后依次打开；启动途中到达的事件也会排队处理。
- 成功打开外部文件／目录时跳过多余的默认窗口；全部失败时仍保留默认入口。Dock 激活事件在打开尚未完成时不另建空窗口。失败不阻塞后续文件，成功后才加入最近目录。
- 使用 Electron 官方 `open-file` 单文件事件处理多文件，移除未受支持的 `open-files` 事件。普通符号链接按目标类型打开，特殊文件不作为项目目录。
- 本地生命周期与启动目录回归 8/8、TypeScript 与相关 ESLint 通过。远程回归与 bundle27 交付结果记录于 `target/macos-parity-20261006`；可见 Finder／Dock 操作仍待实机验收，测试不代表该项通过。
- 本次仅修改桌面主进程，复用 bundle26 已验证的 release 后端；未改变清理功能门槛。清理 7 个产品入口、真实 Electron 权限流程、Intel 与正式公证仍未完成。
- 依据：[Electron app open-file 官方文档](https://www.electronjs.org/docs/latest/api/app#event-open-file-macos)。该事件可能早于 ready，应提早注册并延后创建窗口；本次未增加依赖、公共协议或持久化格式。

### bundle27

Windows 与 Mac 回归各 8/8、TypeScript、相关 ESLint 与打包命令退出码均为 0。DMG 校验、只读挂载／复制／卸载、签名和安装副本哈希通过；ACP 4/4，模型调用 0。Electron 可见操作 NOT_RUN。

Local: `target/macos-release-20261006-bundle27/`

Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261006-bundle27/`

Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261006-bundle27/CodeBuddy.app`

- CodeBuddy.zip: SHA-256 `b9aa4cf6b823153c8b220cbe2d142a4dd24bfcad46888a86a1523fdcebbdd9cb`
- CodeBuddy-arm64.dmg: SHA-256 `d4f4ff59b4f95b5fa4ce5164805e9b59c3c7470806ccdb70808322d269695e3f`

Source: `00a6656df` + dirty; build manifest `a5ad96dff6f262b88173fd680b20d12d3f4b18d94020fbc04e6fd5a17d5eaa75`. Evidence: `target/macos-parity-20261006/desktop27-state.json`. arm64 ad-hoc.
