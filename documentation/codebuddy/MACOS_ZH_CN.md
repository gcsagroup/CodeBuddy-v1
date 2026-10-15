# macOS 开发与验证

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

[Details](MACOS_PARITY_ZH_CN.md)

## 工作任务强制停止接线（stage25）

用户在具体方案后回复“继续”，批准既有 owner 接线。PID 与 `SessionProcessOwner` 在 `WorkerRegistry` 同一锁内注册；tracker 与 lifecycle 消费同一引用。OS 操作仍由 `SystemProcessGroupOwner` 负责。强制停止取快照时关闭新注册；终止、runner 取消与退出确认在锁外执行。已确认退出的记录逐笔移除；未确认的记录保留供重试，避免 runner drop 后再次停止时误报完成；过期 generation 与冲突 owner 被拒绝。

Windows 本轮 18/18、Mac 本轮 19/19 通过；两端 Clippy 退出码为 0。bundle25 已重新构建后端，包含 stage24 的 shell 取消／超时与端口归属修复，以及 stage25 的强制停止接线。DMG 挂载／复制／卸载、签名、安装副本哈希与 ACP 启动握手 4 项通过（模型调用 0）。这是 arm64 ad-hoc 内部测试包，未公证。

Local: `target/macos-release-20261005-bundle25/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle25/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle25/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `9aa02168c6fb4260a480074e5e724e7d6c464e424b0db9bd8669085e536bf1bd`
- CodeBuddy-arm64.dmg: SHA-256 `1c1aa6357374559eb695e379ecdde5a9057dfcd35deacb2555a78a20cfaefccc`

新增覆盖 owner 失败与重试、协作取消期间注册、旧 generation，以及 Mac 真实后代退出／父进程先退出／无关进程存活。完整 Electron 流程维持 NOT_RUN。清理写入、桌面验收调度、TCC／Keychain 和 Intel 验收仍有缺口，不能据此宣称完整对齐。


[繁體中文（默认）](MACOS_ZH_TW.md) · [English](MACOS_EN.md)

## 阶段 24：依 Windows 入口核对并修复两项差异（2026-10-05）

以本机 Windows 现有 main + dirty 工作目录为基准重新追踪实际入口。完整对照及后续方案见 [功能清单](MACOS_PARITY_ZH_CN.md)。

- Mac 前台 shell 现使用既有进程组 owner；取消／超时等待同组后代退出。Windows 回归 **16/16**，原生 Mac shell 回归 **24/24**，其中新增两项实际后代进程测试同时确认无关兄弟进程仍存活、输出管道关闭及结构化回执。
- Mac 后台服务现通过系统 lsof + 既有 owner 判定监听端口归属。原生测试 **2/2**，另 1 个子进程 fixture 标记 ignored，不计入通过数。实际临时 TCP 监听验证所属／非所属进程组及停止后状态；异常输出保留未知，查询并非业务就绪证明。
- 最终 Windows 严格 Clippy 与 Mac Clippy 均退出 0；Mac 最终保留 6 条现有平台告警。fmt 和 diff 空白检查通过。原生探测曾发现 lsof 自动附带 f 记录，已按实测协议修复后通过正式测试；一次 Windows Clippy 误与 Mac 重叠启动后已中断、保留记录并串行重跑。

**全功能一致仍未完成。** 工作任务强制停止 owner 接线方案待批准；Mac 桌面验收调度仍固定关闭；清理隔离／恢复／永久删除及可见 Electron 流程仍待完成。未重新触发已暂缓的 Keychain／TCC 认证。

本轮两项源码修改尚未打包；最新已交付仍为 bundle23，并不包含上述修复。没有创建分支、提交或推送。命令、工作目录、退出码、测试计数及源码哈希见 `target/macos-parity-20261005/parity24-state.json`。

## 阶段 23：扩展命令参数修复（2026-10-05）

修复 Mac/POSIX 编辑扩展设置时启动命令和参数被改写的问题。原先仅为空格添加引号，会丢失空参数、解释美元符号／引号／反斜杠，或拆开制表与换行参数。现在按既有解析器保护字面参数，保留简单命令的显示格式；Windows 原路径处理继续通过回归。没有新增依赖、协议或配置格式。

- 修复前：新增回归 4 项失败、其余 39 项通过。最终 Windows 与真实 arm64 Mac 的转换／正式编辑弹窗测试各 **57/57**，两端 TypeScript 退出 0。
- 真实 Chrome 正式编辑弹窗：修改描述→保存→重新打开→取消，命令与六个参数保持一致。保存与 ACP 配置使用隔离替身，未修改用户扩展。控制台错误 0；已有 DialogContent 描述缺失警告出现 2 次。
- 真实 Mac 原生子进程 **2/2**：包含中文、单引号、美元符号及反斜杠的可执行路径／脚本路径正常启动，子进程实际收到完整空参数、引号、通配符、制表与换行字节。此项不等于真实 MCP 扩展或完整 Electron 验收。
- 最初引用函数与当前解析器的通配符往返不符、测试替身属性与超时值不完整、测试查询类型错误均已修正，保留失败日志。最终校验全部通过。

bundle23 已生成并通过 DMG 实际挂载／复制／卸载、签名、安装副本哈希和 ACP 启动握手检查（4 项，模型调用 0）。当前后端从源码重新构建；完整 Electron 验收仍为 NOT_RUN。此包为 arm64 ad-hoc 内部测试版，未公证。

Local: `target/macos-release-20261005-bundle23/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle23/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle23/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `542b79a2cdfc0e852d9b9ebfe13854acf71b7651430d6077f7ca64a74ff04233`
- CodeBuddy-arm64.dmg: SHA-256 `14356dc2d423613de3c7402f2e638681741204e94a4bd3077429959d4dd326d3`

全功能一致尚未完成：清理隔离／恢复／永久删除、完整 Electron／钥匙串与 TCC、Intel 及最低系统实机仍待完成。源码为 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加既有合并和 dirty 修改，未创建分支、提交或推送。

修改：`ui/desktop/src/components/settings/extensions/utils.ts`、同目录 `utils.test.ts`、`modal/ExtensionModal.test.tsx`。命令、工作目录、退出码与证据：`target/macos-parity-20261005/extension23-state.json`。

## 最新开发：2026-10-05 阶段 22（尚未打包）

继续补齐 Mac 清理功能：抽取 Windows 已有白名单、项目边界和摘要结构；新增 Mac 内部只读检查，覆盖普通文件／空目录、内容哈希、链接拒绝、文件／父目录替换、项目重叠和读权限错误。具体文件与后续门禁见 [清理适配设计](MACOS_CLEANUP_DESIGN_ZH_CN.md)。

- Windows 相关 Rust 回归 **72/72**；真实 arm64 Mac 原生回归 **22/22**，其中新增清理检查 **8 项**。均退出 0。
- Windows 严格 Clippy、Mac release Clippy 与 Mac fmt 均退出 0；Mac Clippy 的 7 条警告位于本轮未修改的 shell／state store／process tree／secure_fs 模块。
- 既有 UI／ACP 隔离基线 **9/9**；不是 Mac 产品清理验收。初次 Mac 测试误用了 debug，已中断并恢复原 release 配置；中断记录保留，不计作测试结果。没有新增依赖或清理缓存。
- 只读模块尚未连接 Mac 清理 RPC／UI。隔离、恢复、永久删除仍待开发，完整 Electron／权限与钥匙串流程、Intel 及最低系统验收仍为 NOT_RUN。全功能一致尚未完成。
- 路径替换实验已确认普通 rename 可移动替换文件；FSRef 的有限实验尚未证明精确对象安全合同。下一步先解决原生对象操作方案，再接入清理写入与持久恢复。当前不放宽合同。

本轮没有新安装包，最新已交付包仍为下方 bundle21。来源为 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加既有待提交合并及 dirty 修改，未创建分支、提交或推送。命令、工作目录、退出码、源码哈希及未完成项见 `target/macos-parity-20261005/cleanup22-state.json`。

## 历史交付：2026-10-05 bundle21（Apple Silicon 内部测试版）

修正电脑控制 `set_value` 的 Mac 差异：Go 省略空文本字段时，原生层现在按空字符串处理，支持清空文本控件。数值控件仍要求有限数字，空值不转换为零；沿用既有窗口／元素绑定、可写属性检查和 TCC 门槛。

- 本地封装／开发入口回归 **27/27**，退出 0。
- 真实 arm64 Mac 原生 Go／Swift helper 编译、既有合同及新增 **11 项** set_value 合同检查通过，退出 0。Go 测试使用有效缓存。新增检查覆盖省略／显式空文本、中文与 emoji／空白、数字／零及非法数值拒绝。
- DMG／ZIP 封装、实际挂载／复制到独立安装目录／卸载、签名和安装后端／helper 哈希检查通过；新 Swift helper 与 bundle20 不同，安装副本 app.asar 与封装输出一致。本地与远程交付文件大小和 SHA-256 一致。
- 复用 bundle18 的已验证后端；本轮未更改 Rust 或前端，不重复计算既有 ACP／UI 证据。既有 macOS 14 activation 弃用警告仍在，未影响编译。
- 此前源码上传被自动审批拦截；用户在明确主机、目录与三个文件的问题后回复“继续”，已据此完成上传。

**真实文本控件清空和完整 Electron 验收仍为 NOT_RUN。** 安装 helper 的只读 doctor 在 SSH 上下文报告 Accessibility=false、ScreenRecording=false，这不代表 Electron 启动后的权限状态。未启动新版 Electron，保留用户延后的钥匙串认证现场。清理隔离／恢复／永久删除、完整桌面流程、Intel 和最低支持系统实机仍待完成，全功能一致尚未达成。此包为 ad-hoc 内部测试版，未公证。

Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` + existing pending merge and dirty changes; 3,251 build-source entries verified. No branch, commit or push created. UI 1.43.2 / backend 1.43.0. Commands, cwd, exits and logs: `evidence/commands.json`.

Local: `target/macos-release-20261005-bundle21/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle21/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle21/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `26aca3ac3c406c50784afbec290f159113ead598ed3c88f3fe63a515c9f654b4`
- CodeBuddy-arm64.dmg: SHA-256 `b1902fa408316c403489d81ba5b27f1a914edeca9997896046ba6f6179b59900`

## 历史交付：2026-10-04 bundle20（Apple Silicon 内部测试候选版）

修复 Mac 快捷键录制将 Control 误存为 Command，以及同时按下 Control／Command 时丢失 Control 的问题。ShortcutRecorder 现分别记录两个修饰键，保留既有设置格式与 Windows 行为；避免录制 Control 组合时误判与 Command 组合冲突。

- 修复前 **5 失败／5 通过**；修复后 Windows 与真实 Mac 执行相关组件测试各 **29/29**，两端 TypeScript 退出 0。新回归覆盖独立／组合修饰键、Option 字符、Windows 行为、取消，以及正式设置页保存后保留其他快捷键。首次类型检查发现新测试查询参数不受支持，修正后重跑通过，原失败日志保留。
- 真实 Chrome 按键交互通过：Control+K、Control+Command+K 分别保存，原 Command+K 保持启用；真正 Command 冲突仍提示，取消重新分配与取消编辑均保留设置。控制台错误／警告 0。验收使用正式设置页、Mac 平台标记及隔离设置／对话框替身，**不代表原生 Mac 全局快捷键触发通过**。
- 新 DMG／ZIP 已放到本机及远程桌面。实际 DMG 验证、挂载／复制／卸载、安装副本签名、后端版本、app.asar 一致性与包 SHA-256 核验通过。
- 本轮只修改前端并新增测试；复用 bundle18 已验证后端，原始与签名后哈希一致。Rust／模型 ACP 未重跑、不计入本轮测试数。既有设置不自动迁移；之前误存的组合需重新录制。

依据：[Electron 官方快捷键文档](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts)，CommandOrControl 在 Mac 对应 Command，Control 是独立修饰键。

**全功能一致尚未完成。** 延后的钥匙串认证、完整可见 Electron／系统快捷键验收、清理隔离／恢复／永久删除、电脑控制权限、Intel 与最低支持系统实机仍待完成。此 arm64 包为 ad-hoc 内部测试版，未公证。

Source: main 00a6656df0c4ba0563b4cf03e560cb81a46b0f53 + pending merge and dirty changes; 3,251 entries verified. No branch, commit or push created. UI 1.43.2 / backend 1.43.0. Commands/cwd/exits/logs: evidence/commands.json.

Local: target/macos-release-20261004-bundle20/. Remote: /Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle20/. Installed: /Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle20/CodeBuddy.app.

- CodeBuddy.zip: SHA-256 2aacb636df7d57cfcf95c67c00408cafa25cc3d7ae141ad9c1cc84d0885d76d5
- CodeBuddy-arm64.dmg: SHA-256 0bb3f9341124b4c91f11ed1523ae682cf429630d3ed4e0510bdb8b24ff76fb87

## 历史交付：2026-10-04 bundle19（Apple Silicon 内部测试候选版）

修复 Mac 旧会话重新确认工作区时，正确目录仍被判定为不匹配的问题。CodeProWorkspaceReconfirmation 原先把所有路径转换成 Windows 反斜杠并小写；现复用既有 normalizeWorkspaceIdentity，与文件检查器一致。保留 POSIX 大小写、中文、空格及括号；不同身份或不存在的目录仍拒绝，确认前不触发回调。

- 修复前：2 个 Mac 回归案例失败、6 个通过。修复后 Windows 相关测试 **102/102**、最终组件 **8/8**；Mac **99 通过、3 个 Windows 专属案例跳过**。两端 TypeScript 退出 0。
- 真实 Mac 临时目录手动 API 验证 **5/5**：原生规范路径、现有目录确认、大小写身份不符拒绝、缺失目录检查零创建及既有文件不变。组件测试也直接调用正式文件检查器。
- 真实 Chrome 受控交互通过：显示原路径、明确确认、不符／移除拒绝、重试与取消；控制台错误／警告 0。使用真实 Mac 检查结果、正式组件与测试回调，未执行完整 ACP／Electron 流程。
- DMG／ZIP 已生成并复制到本机与远程桌面。实际 DMG 验证／挂载／安装／卸载、签名、安装后端版本与 app.asar 哈希一致性通过。
- 本轮仅改前端，复用 bundle18 后端且原始／签名后哈希一致。未重跑 Rust 或前阶段 17 项模型 ACP，不将其计入本轮数字。

**全功能一致尚未完成。** 延后的钥匙串认证及可见 Electron 验收仍未执行；清理隔离／恢复／永久删除、电脑控制权限、Intel 与最低支持系统实机仍待开发或验收。此 arm64 包采用 ad-hoc 签名，未做 Developer ID 公证。

Source: main 00a6656df0c4ba0563b4cf03e560cb81a46b0f53 + pending merge and dirty changes; 3,250 entries verified. No branch, commit or push created. UI 1.43.2 / backend 1.43.0. Commands/cwd/exits/logs: evidence/commands.json.

Local: target/macos-release-20261004-bundle19/. Remote: /Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle19/. Installed: /Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle19/CodeBuddy.app.

- CodeBuddy.zip: SHA-256 70ffd920a8a2238f20380a0e24aa3ba6eaee564c49dc87f5c0fb75038b93dad1
- CodeBuddy-arm64.dmg: SHA-256 22b30331f300f8cf50a1257a30f6a5f817570e9ab90dbba01d4846f769305228

## 历史交付：2026-10-04 bundle18（Apple Silicon 内部测试候选版）

新增“重新获取项目确认”入口与已批准的 ACP 方法 `_goose/unstable/workspace/confirmation/v1/refresh`。双方协商 `workspaceConfirmationRefresh: 1`；宿主验证原 session／run／来源消息、持久控制面与等待工作区通知，只刷新确认。重复刷新复用有效令牌；已分配租约、已绑定、关闭／归档、终态或身份不符均拒绝。刷新不调用模型、不创建目录、不绑定租约、不执行任务；用户仍须明确确认路径，再沿既有结构化续行恢复原任务。补齐确认卡片繁体／简体文案。

- Windows Rust **114/114**、严格 Clippy 退出 0；Mac 原生 Rust **39/39**、Clippy 退出 0。两端组件测试各 **43/43**，TypeScript 退出 0。
- 真实 Chrome 受控组件流程通过：过期错误→刷新→等待再次确认→新令牌创建／绑定／原任务续行；旧后端只显示升级提示。目录选择与 ACP 传输为测试替身，非 Mac 桌面 E2E；修正夹具图标 404 后控制台无错误／警告。
- 新 Release 及实际 DMG 安装副本后端各通过真实 ACP **17/17**，覆盖重启后用新方法刷新、原 run／消息身份、并发幂等、刷新零项目写入、伪造身份／已绑定拒绝、原权限拒绝重试、准确子目录、模型实际写文件及重启恢复。
- DMG／ZIP 已生成，DMG 验证／挂载／复制／卸载、安装副本签名与哈希验证通过。**未启动新版 Electron；用户延后的钥匙串认证与完整可见桌面验收仍待完成。**

全功能一致尚未完成：清理隔离／恢复／永久删除、电脑控制权限、Intel 与最低支持系统实机仍待开发或验收。此 arm64 包采用 ad-hoc 签名，未做 Developer ID 公证。

Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` + pending merge and dirty changes; 3,250 source entries verified. No branch/commit/push created. UI 1.43.2 / backend 1.43.0. Commands/cwd/exits/logs: `evidence/commands.json`.

Local: `target/macos-release-20261004-bundle18/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle18/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle18/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `c0df12aa750de29c7f35184ae6fada3183e072b0c3ad57cddfdfafd29c319dfe`
- CodeBuddy-arm64.dmg: SHA-256 `9dc13110a59716dc14fccf610020818048a6e41ad249c157b2c61ab0e22c9512`

## 历史交付：2026-10-04 bundle17（Apple Silicon 内部测试候选版）

修复 Mac 创建项目遭目录权限拒绝后，恢复权限仍因令牌已消耗而重试失败的问题。仅在确认尚未创建目录时，返回既有 `workspace_permission_denied / retryable / capabilityPreserved` 合同并保留原确认；创建后的异常仍回滚并消耗令牌。ACP 宿主继续持有权限与生命周期判定，前端复用原确认卡片。

- 真实 Mac 修复前复现：测试目录设为只读，创建返回 `OSErr -5000`；恢复权限后，同一确认被拒为令牌已消耗。证据 `evidence/baseline-permission-error.json`。
- Windows Rust **112/112**、严格 Clippy（`-D warnings`）退出 0；Mac 原生 Rust **37/37**、Clippy 退出 0。两端相关前端各 **39/39**，TypeScript 退出 0。新增回归覆盖读／写拒绝、伪造令牌、原确认重试、创建后失败回滚及前端只在创建成功后续行。首次前端回归使用缺少消息身份的夹具，修正后通过，原失败日志保留。
- 新 Release 真实 ACP **12/12**：读／写权限拒绝与原确认重试、准确子目录、父目录受限、幂等、空目录回滚、绑定前重启拒绝旧令牌、以既有结构化续行请求取得新确认且保持原 run／消息、同会话绑定、模型以原控制请求实际写档、已绑定重启，以及删除会话保留文件。证据 `evidence/project-container-permission-acp-result.json`。
- bundle16 旧验收脚本本轮的 10 个目录流程断言通过，但后续身份审计发现重发自然语言请求后 run 已变更；该结果**不算原 run 恢复通过**。新脚本已补原 run／消息身份断言，使用既有结构化续行协议；可见 UI 的过期卡片重新取得确认入口仍待完善与验收。原失败的解析后模型日志只有思考内容、最终正文为空，另一次超时；当时未保存原始 HTTP 流，根因尚未固定。本轮原始接口诊断已取得 JSON。未因此放宽解析、把思考当作决策或调高超时；历史模型不稳定记录保留。
- 安装副本后端也通过同一 ACP **12/12**（`evidence/installed-project-container-permission-acp-result.json`）。新后端构建、DMG／ZIP 封装及实际 DMG 挂载／复制／卸载、安装副本签名及后端哈希验证均通过。**未启动新版 Electron；用户延后的钥匙串认证及完整可见桌面验收仍待完成。**

来源：main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、既有合并及未提交修改；3,249 个来源项目核验一致。未创建分支、提交或推送。UI 1.43.2／后端 1.43.0。命令、工作目录、退出码与日志见 `evidence/commands.json`。

Backend SHA-256: `eeb898a355dc95f367834a0c811bb9bc1b52a34e72baef9bfd6d289f8283f02d`; packaged backend: `212bb77059800a308bd62a5783bd924f6f7011f67504bb809ce452bad91f347b`.

Local: `target/macos-release-20261004-bundle17/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle17/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle17/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `e2f7fbbb5ed64b2b7aa446724de1096483286589abc1beb3ca0ec85d568eb6ed`
- CodeBuddy-arm64.dmg: SHA-256 `29f6de32a30930bd8152a43e581c5011cd6c77e6bb29d4830edfef992c8d4cb9`

**全功能一致仍未完成**：清理隔离／恢复／永久删除、完整桌面流程、电脑控制权限、Intel 与最低支持系统实机仍待开发或验收。此包为 arm64 ad-hoc 内部测试版，未做 Developer ID 公证。

## 历史交付：2026-10-03 bundle16（Apple Silicon 内部测试候选版）

已实现 Mac 项目父目录流程：使用现有目录选择器选取父目录，显示准确子路径，明确确认后才创建并把原会话绑定到新项目。父目录保持受限，不授予普通项目工具写入权限；同名冲突拒绝且不自动换名。

- 后端：新增 `project_container` 持久化状态、`projectContainers: 1` 协商及版本化分配端点。Mac 通过持有的父目录 fd 创建直接子目录，复用令牌、租约、所有者校验和回滚。重启保留父目录记录，但创建令牌失效，需要重新确认。Windows 原容器流程保留。
- 前端：确认卡片、升级提示、会话元数据、权限摘要和工作区面板已接入；项目绑定前不把父目录作为可写工作区。成功后续行原消息与 run。
- Windows：相关 Rust **112/112**（含扩展启用边界、空正文续行及原消息恢复）；严格 Clippy（`-D warnings`）退出 0。Mac：原生 Rust **34/34**（含并发确认、空正文续行及原消息恢复）；Clippy 退出 0，9 条既有平台警告。两端前端各 **89/89**，TypeScript 退出 0。
- Chrome 受控交互通过：选择不创建、明确确认与原任务续行、旧后端升级提示、取消不创建。使用正式组件和流程函数，Electron 选择器与 ACP 传输为夹具；不计为原生 Electron E2E。此验收发现通用错误遮蔽升级提示，已用类型化错误修正并补回归。
- 新 Release 后端“首次确认”真实 ACP **8/8**：令牌校验、准确子目录、父目录工具拒绝、重复确认幂等、原会话绑定、原空正文控制请求续行且模型实际写入 `acceptance.txt`、已绑定项目重启恢复、删除会话保留文件。证据 `evidence/project-container-fresh-acp-result.json`；使用仓库外临时中文目录。
- 首轮原生 ACP 暴露空闲上下文整理被误判为活动任务，确认创建遭拒。已使用现有会话访问屏障，等待访问占用清空后才读取最新状态并创建；补回归验证等待和并发元数据保留。修复后重跑测试、Clippy、编译并执行严格 ACP 验收；后续诊断另发现共享 ACP 入口把现有的空正文工作区续行拒绝为空输入；现仅允许有效 CodePro 工作区续行控制请求，原消息仍由 Agent 恢复。另一次测试为 33 通过／1 夹具初始化失败；按真实 session/new 补齐重新开放访问后，最终 34 项全部通过。首轮失败、中断编译和候选版后续诊断单独保存。
- **绑定前重启后重新确认：未通过完整验收。** 两次严格流程均完成前 6/10 项（含空目录回滚和旧令牌拒绝），随后共享恢复判断先遇模型 JSON 校验失败，再遇模型超时，后续任务未执行。`project-container-acp-16-model-relation-error.log`、`project-container-acp-16-model-timeout.log` 和 `project-container-acp-result.json` 保留证据；上项首次确认测试是独立场景，不代表此流程通过。
- bundle16 打包退出 0。实际挂载 DMG、复制到独立安装目录、卸载映像，再验证签名和内置后端版本/哈希，全部通过。按用户要求保留现有钥匙串认证现场，**未启动 bundle16 Electron，完整可见桌面 E2E 未执行**。
- 来源：main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、现有合并内容及未提交修改；3,249 个来源项核验一致。未创建分支、提交或推送，合并提交仍待完成。产品 UI 1.43.2／后端 1.43.0；原始后端 SHA-256 `3bcf7d4de4aafb52ab1ec9239a901df3fa165b0efee54241d9a03a759fb38366`；签名后封装 SHA-256 `c107d1f7cde1fda925f5e176b944726008d7ccec251720a66d3859399b947399`。

交付：本机 `target/macos-release-20261003-bundle16/`；远程桌面 `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261003-bundle16/`；安装 `/Users/erjinyi/Applications/CodeBuddy-Test-20261003-bundle16/CodeBuddy.app`。准确命令、工作目录、退出码及日志见 `evidence/commands.json`。构建来源快照为 `BUILD_SOURCE_STATE.json`；后续文档同步另有核验。

- DMG SHA-256：`8e78723df49b0b225b42575a223dfe54b3e775481c2c14ff46cd33e5d0ea1815`
- ZIP SHA-256：`dc517f76537b13cfe1e1c84f95af992430b006c179f43db52b70de893bd4874f`

待可见桌面验收：完成现有认证后启动 bundle16；在未绑定会话要求创建新项目并写入 `acceptance.txt`，选择包含中文和空格的测试父目录，核对准确子路径。先取消并确认没有新增目录，再重新发起并确认，核对同一会话完成写文件。重启应恢复子项目和文件，父目录不应成为可写项目。此流程尚未执行。

**全功能一致尚未完成**：清理隔离／恢复／永久删除、完整桌面流程、电脑控制权限实测、Intel 和最低支持系统实机仍待开发或验收。此包为 arm64 ad-hoc 内部测试版，未做 Developer ID 公证。

## 历史交付：2026-10-03 bundle15（Apple Silicon 内部测试版）

补上 Mac 根容器的只读磁盘容量查询，沿用既有 `codepro.root_disk_usage` 结构化结果及会话持久化流程，不授予工作区写入权限。Mac 先验证根目录与目录对象，再通过既有 fs2 读取操作系统容量；Windows 实现及公共协议不变。

- 修改：`workspace_lease.rs`、`workspace_lease/lifecycle.rs` 共用容量数据类型；`workspace_lease_macos.rs` 新增原生读取；`agent.rs` 接入 Mac 分支及持久化回归；`workspace_lease/macos_tests.rs` 验证真实容量、非根目录、相对路径与符号链接拒绝。
- Windows：后端相关测试 **100/100**，严格 Clippy（`-D warnings`）退出 0。Mac：原生 Rust **16/16**，Clippy 退出 0（9 条既有平台警告）。格式检查通过。首次 Mac 测试编译因新测试访问私有函数报 E0603，移除该跨模块断言后重跑通过，未扩大 API 可见性。
- 新编译后端的真实 ACP 验证 **3/3**：无写租约建立根会话、宿主容量与原生文件系统统计一致、重启后回放同一结构化结果。总容量 `494384795648` bytes，查询当时可用 `254468087808` bytes；可用量随系统使用变动。证据：`evidence/root-disk-acp-result.json`。这是桌面模式后端实测，非可见 Electron E2E。
- Release 后端、bundle15 封装均退出 0。实际从 DMG 复制到独立安装目录并卸载映像后，签名验证、安装后端 `--version` 及哈希比对通过。未启动 bundle15 Electron；按用户要求保留既有钥匙串认证现场，完整桌面验收待完成。
- 来源：既有 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、既有合并内容与未提交修改；3,248 个构建来源项目核验一致。本轮未建分支、提交或推送，合并提交仍待完成。产品 UI 1.43.2，后端 1.43.0；新后端原始 SHA-256 `412e8f1ef395c9fafb3f21b948cad6288b6bd7efddffc4a4cbaba79b5e2c1068`，签名后封装 SHA-256 `a84b4e82ebb4d9e774f8a109dfcfd46dcf40c3b80e26ed8793b3305f30d47e08`。前端未改，bundle14 前端测试列为前阶段证据。

交付：本机 `target/macos-release-20261003-bundle15/`；远端桌面 `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261003-bundle15/`；安装 `/Users/erjinyi/Applications/CodeBuddy-Test-20261003-bundle15/CodeBuddy.app`。命令、退出码、原始日志及安装结果位于 `evidence/`，构建来源快照为 `BUILD_SOURCE_STATE.json`；后续文档同步另有来源核验记录。

- DMG SHA-256：`386a3f9d5cfdc11ae270557141f9a90ae36fe57397ff581a44fa4335157a32b5`
- ZIP SHA-256：`2e09a01a64afe9cd764c70c7374bae47f3ea7d0b2e2af24ddd6e034d0f57149d`

**全功能一致尚未完成**：新项目容器方案待批准；清理隔离／恢复／永久删除、完整桌面流程、Intel 实机仍待开发或验收。此包为 arm64 ad-hoc 内部测试版，未公证。只读电脑控制诊断在 SSH 上下文显示 Accessibility/ScreenRecording=false；它使用未变更的 bundle14 helper，既不代表 Electron 权限状态，也不计为桌面操作验收。

## 已批准方案：Mac 新建项目容器（2026-10-03）

实机 `/` 挂载标记为 `apfs, sealed, read-only`。现有 `NeedsWorkspaceInline` 只接受文件系统根目录；`load_session` 也只允许根容器绑定直接子目录。仅移植 Windows allocate-child 处理器，仍无法在一般 Mac 系统卷创建项目。[Apple 签署系统卷说明](https://support.apple.com/guide/security/signed-system-volume-security-secd698747c9/web)。

建议新增独立的 `project_container` 状态：由用户通过既有目录选择器选择可写的本地父目录，确认预期子目录后才创建。父目录不取得项目工具写入权限；成功后原会话只绑定新建的直接子目录，保留原始消息、run 与继续执行的关联。

沿用宿主租约／nonce／单次消耗／所有者检查／回滚状态机。前端仅提交确认数据；宿主验证规范路径、持有的目录对象及直接子目录关系。重启后，容器记录本身不授予创建权限，必须重新确认后获取新令牌。清理权限另行设计，不由项目创建权限派生。

旧 `root_container` 和 `writable_project` 记录保持原义，不自动迁移。新能力需要协议协商；旧客户端／后端保持既有流程，遇到未支持的新状态则明确要求升级，禁止静默降级为可写项目。排除自动改用主目录及修改系统卷设置。

验收：两端既有工作区回归；Mac 真实临时父目录下的中文命名、冲突、替换／符号链接、令牌重用、失败回滚、重启重新确认、同会话继续执行；最后执行桌面选择／确认流程。这会新增持久化状态并调整容器授权范围，依根 AGENTS.md 提案后，用户要求继续，现已进入实现与验证；最新状态见页首。

## 历史交付：2026-10-03 bundle14（Apple Silicon 内部测试版）

用户暂缓钥匙串认证后，本轮继续修复工作区路径并完成不依赖桌面认证的验证。

- 提示词中的 POSIX 绝对路径现在会进入既有工作区确认流程；支持引号内的中文、空格及末尾标点，保留大小写与多候选选择。URL 和相对路径不再误识别为 Windows 盘符路径。候选提取不授予写入权限。
- 选择及确认工作区时保留合法末尾括号等字符；新增两端真实目录案例，验证检查及确认后原文件保持一致。
- Windows：工作区回归 77/77，面板／终端平台配置／确认卡片 24/24；Mac：74 通过、3 项既有 Windows 专属案例跳过，另 24/24 通过。两端 TypeScript 退出 0。
- 新包从 DMG 复制到独立安装位置，卸载映像后签名检查及后端 `--version` 退出 0。这是安装结构验证；bundle14 的 Electron 安装烟测和完整桌面 E2E **未执行**。bundle13 的可见启动仍停在 Safe Storage 钥匙串认证，按用户要求保留现场。
- 来源：既有 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、合并内容及未提交修改；本轮未创建分支、提交或推送。构建前 3,248 个源码项核验一致；只更新前端，沿用 bundle13 已验证的后端 1.43.0，产品 UI 1.43.2。
- 首次本机 pnpm 包装脚本意外重配置依赖并执行 SDK 生成，已停止；日志下载量为 0，锁文件／工作区配置／SDK 生成文件哈希均与前次清单一致。后续直接用现有 Node 24 执行 Vitest、TypeScript，无新增依赖。首轮回归发现 URL 误识别，修复后取得上述通过结果。

交付：本机 `target/macos-release-20261003-bundle14/`；远端桌面 `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261003-bundle14/`；远端安装 `/Users/erjinyi/Applications/CodeBuddy-Test-20261003-bundle14/CodeBuddy.app`。完整命令、退出码及结果位于交付目录 `evidence/`，原始 Mac 日志位于 `target/macos-parity-20261003/`。

- DMG SHA-256：`8ca5870bf771aaea497b02f4ff34a3491ebb6de1426f374732cde6865b6628ec`
- ZIP SHA-256：`d3f877818a966b3affe2d2d03f9ceaf20a8353826404827dcd2730df6e45d9e7`

仍待完成：根容器分配、清理隔离／恢复／永久删除、完整桌面验收及 Intel 实机。此包仍为 ad-hoc 签署，未公证。以下记录为历史阶段。

## 历史交付：2026-10-02 bundle13（Apple Silicon 内部测试版）

已生成并交付产品 1.43.2 / 新编译后端 1.43.0。DMG 和 ZIP 在 Windows 本机与远程 Mac 的 SHA-256 均一致。开发改动及现有合并内容仍未提交、未推送。

- 源码：本机 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、合并内容和未提交修改；远程构建副本保持原 detached HEAD。构建前 3,248 个清单文件／链接核验通过。
- Windows：后端 100/100、前端 65/65；TypeScript 和严格 Clippy 退出 0。
- Mac：原生 Rust 14/14；前端 62 通过、3 个既有 Windows 专属案例跳过；TypeScript 退出 0。Mac Clippy 退出 0，保留 9 条现有平台警告。
- 真实原生后端：通过桌面实际入口 `serve --platform desktop`，在仓库外临时工作区完成 9 项检查，涵盖模型实际写文件、正常结束任务、重启恢复绑定、替换目录拒绝，以及删除会话后保留项目文件。证据：`evidence/desktop-acp-result.json`。
- 安装验证：DMG 校验、安装后卸载映像、签名校验，以及安装副本的文件／PTY／内嵌浏览器烟测全部通过。这是受控安装和 API 验收；远程仍锁屏，可见桌面完整 E2E 未执行。
- 验收修正记录：最初 CLI stdio 探针缺少桌面模式的证据持久化配置，首轮超时。第二轮中，模型对源码仓库内的测试文件额外创建分支／提交；已停止探针，只撤回该测试产生的 Git 变更，完整源码再次核验一致。修正入口及隔离位置后才取得上述 9 项通过；前两轮不计为桌面产品 PASS。

本机安装包：`target/macos-release-20261002-bundle13/`。远程桌面：`/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261002-bundle13/`。新版已单独安装到 `/Users/erjinyi/Applications/CodeBuddy-Test-20261002-bundle13/CodeBuddy.app`，等待解锁后进行可见桌面验收。

- DMG SHA-256：`82ddd98f70e8684e0e41780300e185de25c998901647d65755dd83ddfd9d2058`
- ZIP SHA-256：`d07b65d7341daefe28d3ae5a46d39bb182a5d1f578fbd1c3b90d493a0c3c856a`

**全功能一致尚未完成**：根容器自动分配、清理隔离／恢复／永久删除仍待开发；Intel、最低支持系统版本实机及完整桌面操作尚未验收。此包为 ad-hoc 签署，尚未 Developer ID 公证。以下是本轮实现与历史记录。

## 本轮核心适配：2026-10-02（实现与验证中）

用户已批准此前的 Mac fd 适配方案。来源为现有 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、合并内容及未提交修改；Windows NT 文件操作保持原实现。

- 租约令牌、pending/session 登记、会话访问屏障和恢复流程抽至 `acp/server/workspace_lease/lifecycle.rs`，Windows/Mac 共用同一份状态机。权限事实 owner 与持久化协议未变。
- Mac 使用 `secure_fs/macos.rs` 的 `openat/O_NOFOLLOW`、`fstatat` 设备/inode 与 `F_GETPATH`，获取及使用租约时检查整条目录绑定。fd 不阻止其他进程改名，未宣称等同 Windows 排他锁。
- ACP acquire/release、新建/恢复/关闭/删除/归档及上下文维护接入 Mac 生命周期。文件附件通过 fd 相对打开，拒绝符号链接、硬链接、越界及超过 2 MiB 的内容。
- 前端新建流程原先只在 Windows 获取令牌，并固定使用 Windows 路径校验；现在加入 darwin，共用保留 POSIX 大小写的 identity 规范化。
- Windows 前端相关回归 65/65；Mac 62 通过、3 项现有 Windows 专属测试跳过。两端 TypeScript 退出 0。Mac Rust 原生回归 14/14，退出 0，包含 ACP 派发、归档/删除与持久绑定恢复。

Mac 空目录回滚保留 `FSCreateDirectoryUnicode` 创建时返回的 FSRef，直接对该引用调用 FSDeleteObject；回滚时不再根据旧 fd 路径重建引用。原生回归第 4 轮为 12 通过、1 失败：APFS 已删除目录的 fd 仍可返回旧路径和非零链接数，原先的“已删除”判定失效。已修正并新增空替换目录保留案例，第 5 轮 14 项全部通过（退出 0）。非空目录拒绝删除，失败时保留 pending 租约。FSRef API 已弃用，Apple 说明 APFS 的 32/64 位 inode 兼容可能带来性能成本；未引入外部依赖。尚未完成：根容器自动分配，以及清理隔离/恢复/永久删除。远程仍锁屏，真实桌面端到端验收未执行。bundle12 不包含本轮核心修改，后续 bundle13 构建与交付结果见上方最新记录。

Windows 后端本轮回归 100/100、严格 Clippy（`-D warnings`）通过，均退出 0。参考：[Apple FSRef](https://developer.apple.com/documentation/coreservices/fsref)、[node-pty 的线程目录 API](https://github.com/microsoft/node-pty/blob/main/src/unix/pty.cc)。

完整验证命令见[繁体记录](MACOS_ZH_TW.md)。远程证据：`target/macos-parity-20261002/lease-tests-*.log`、`workspace-ui-tests.log`、`workspace-typecheck.log`。

## 历史 bundle12：2026-10-02（核心适配前）

bundle-arm64-12 已生成并通过 DMG 安装烟测；产品 1.43.2，后端沿用同一已验证 Release 1.43.0。来源仍为 main 00a6656df0c4ba0563b4cf03e560cb81a46b0f53、既有合并内容及未提交修改；未创建分支、提交或推送。

- 修正 Mac Option+B 字符变化导致浏览器快捷键失效；识别物理 KeyB，保留原 Windows 行为。
- 工作区文件搜索、浏览器、保存快捷键显示 Mac Command/Option；共用设置页原有的格式化逻辑。保留 Ctrl+反引号终端入口。
- 加入 Command+S 草稿保存回归，避免 Shift/Option 修饰及输入法组字被普通保存快捷键拦截。英文、简体、繁体提示同步。
- Windows/Mac 面板组件测试各 11/11；两端 TypeScript 退出 0，翻译编译退出 0。Mac 原生封装与安装烟测退出 0，证据 `target/macos-parity-20261002/`、`ui/desktop/out/macos-install-XFuq3q/`。

| 关键流程 | 本次证据与剩余缺口 |
| --- | --- |
| 模型初始化 | 已连接 qwen3.8-flash-next，bundle11 主界面保留模型 |
| 面板开关与目录菜单 | bundle11 真实 Electron renderer 点击成功；远程桌面目前锁屏，完整可见流程待解锁 |
| 新建 CodePro 工作区 | 安装后端的 lease/acquire 实际回复 -32601 Method not found；Mac 尚未注册现有租约处理器 |
| CodePro 写入、清理及恢复 | 核心工作区适配待方案批准，尚未完成 |
| 文件、PTY、内嵌浏览器 | bundle12 安装烟测通过；完整任务中的使用仍待工作区链路接通 |
| 本次 Mac 快捷键 | 组件回归通过；新包真实桌面快捷键待解锁后验收 |

根 AGENTS.md 要求核心权限抽象变更单独确认，已向用户提出沿用协议/状态机并新增 Mac fd 实现的方案；待批准后继续。Windows/Mac 全功能一致仍未完成。bundle12 为 ad-hoc 内部测试包，尚未公证；用户安装位置仍运行 bundle11，避免在锁屏期间替换其前台应用。

Artifacts / 安装包：`target/macos-release-20261002/`；remote / 遠端：`/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261002/`。

- DMG SHA-256: `105fc338c9477ef9374e7922805f24d706831d0c2a2048f267a3f5ed6e3f0835`
- ZIP SHA-256: `5ed9203ecfcca5c55464bb47d6ce3bfd8ec2f9746ab887c082de47909df339fc`


## 历史交付：2026-10-01 19:14

已生成 CodeBuddy 1.43.2 Apple Silicon 内部测试包；后端沿用源码版本 1.43.0。原生 Release 编译成功，bundle-arm64-11、DMG 安装及安装副本烟测均退出 0。Windows/Mac 功能一致验收尚未完成。以下较早日期的记录作为历史保留，不代表当前状态。

来源为 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、已整合的 `b8c6eb06c77281aa0a7ed1633b40cc861f2389af` 及未提交修改。合并冲突为零；合并提交仍待有效作者资料，未推送。

- 本机交付：`target/macos-release-20261001/CodeBuddy-arm64.dmg`、`CodeBuddy.zip`、哈希清单与验收证据。
- 远程桌面：`/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261001/`。
- 远程安装：`/Users/erjinyi/Applications/CodeBuddy-Test-20261001-4nejwg57/CodeBuddy.app`。
- DMG SHA-256：`3f9156719a552bab618aeda7ef7d79a7ee9a39aefae00ce21b94363812fdde60`。
- ZIP SHA-256：`c2f698f005990391f8b6147f3702ea06c77b0fd768df3ca4a77223c05bea100e`。

封装修正包含原生 node-pty 与编译头文件暂存、Forge 完成后重新签署，以及局域网用途说明。沿用已有 @electron/osx-sign；签名后重算封装文件哈希，保留签名前哈希。`codesign --verify --deep --strict` 和 `hdiutil verify` 均退出 0。这是 ad-hoc 签名，尚未 Developer ID 签署或公证；Intel 包与 Gatekeeper 用户流程尚未验收。

安装测试从 DMG 复制并卸载映像后，启动真实 Electron 安装副本：中文文件列出/读写/搜索、原生 PTY 工作目录与 32×110 尺寸、Unicode 输出、WebContentsView 本机 HTTP 页面均通过。封装回归 27/27，工作区/布局回归 27/27；这是不同测试批次。证据：远程 `out/macos-install-Bh86fE/`、`out/macos-smoke-arm64-GTNFNJ/`（相对 ui/desktop），本机 `target/macos-release-20261001/evidence/`。

已从 macOS LaunchServices 启动安装副本，按用户授权允许桌面文件夹及本地网络访问；网络提示显示名称为“Electron”。bundle-arm64-10 重试后成功进入主界面并显示 qwen3.8-flash-next，模型初始化通过，先前的 OS error 65 已解除。证据：`target/macos-ui-final-uHcPDk/after-local-network-permission.png`。

实际 UI 发现标题栏拖动区域遮住工作区面板按钮。已将展开面板及收起后的入口移到 32px 拖动区域下方；Windows 与 Mac 的面板组件测试各 8/8，两端 TypeScript 检查退出 0。bundle-arm64-11 复用同一已验证 Release 后端重新封装，构建及 DMG 安装烟测退出 0；证据 `out/macos-install-2bsGs8/`。目前新版启动停在“CodeBuddy Safe Storage”登录钥匙串密码认证，等待用户亲自完成；面板真实点击、完整聊天与重启恢复验收仍待完成。核心工作区租约适配仍依根 AGENTS.md 等待方案批准；Windows/Mac 全功能一致未完成。

### 局域网模型排查

2026-10-01 后续验证：安装包内同一 goose 可执行文件通过 SSH 启动 ACP，模型发现、创建供应商及保存默认模型的真实 completion 校验均成功；新建普通 ACP 会话后收到 `Mac native model acceptance OK.`，`stopReason=end_turn`。证据：`target/macos-release-20261001/evidence/network-comparison/`。这仍不代表 Electron UI 或 CodePro 写入任务验收通过。

Apple 说明，SSH/Terminal 命令行程序具有局域网访问例外，而应用启动的 helper 归属该应用；因此 SSH 成功并不证明应用已获准。解锁后检查“系统设置 → 隐私与安全性 → 本地网络”的 CodeBuddy 项目，再由应用重试。若设置要求认证，由用户亲自完成。ad-hoc 签名的身份跟踪也有局限，正式发行应使用 Apple 颁发的签名身份。参考：[Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。

模型发现和 completion 验证保留原有 ACP 错误码，新增去除 URL 的底层连接诊断；不要从 `custom_provider_endpoint_unreachable` 单一错误码推定权限已被拒绝。

### 历史实施记录

2026-09-30：已补齐 macOS 打包入口和终端适配；**尚未产出或执行 macOS 安装包，尚未完成 Mac 实机验收**。源码来自 CodeBuddy 仓库 main / `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加现有未提交修改；产品名称沿用 CodeBuddy。没有新分支、提交、推送或新增依赖。

## 2026-10-01 原生编译缺口与租约适配方案

新增清理预览回归在 Windows 通过 1/1（退出 0）；证据 `target/macos-parity-20261001/cleanup-preview-regression.log`。Mac 原生 PTY 已验证中文目录、Unicode 输出及 stty 实际回报 32×110，退出 0；证据 `target/macos-native-evidence/native-pty-check-3.log`。开发入口复用封装的 preparePty 修正 spawn-helper 执行权限。安装烟测也增加实际尺寸与 Unicode 断言，尚待安装包执行。

首轮 Release 编译在 goose 项目库退出 101：四处调用 Windows 专有 workspace_lease，另有跨平台清理预览引用被 Windows 条件编译排除的函数。已修正编译边界；未实现的分配/清理操作明确报错，不发出虚假能力或略过工作区保护。清理预览保留 pending/recovering/recovery 目录排除，新增真实目录回归。此前纯组件测试不代表 CodePro 写入会话可用。

待审核的原生适配：保留 ACP acquire/consume/bind/release 与 session/run/message/nonce 所有权；抽出平台文件操作层，Windows 保留现有 NT handle 实现，macOS 使用已有 libc 的逐层 openat/O_NOFOLLOW、fstat 设备/inode、F_GETPATH 与 fd 相对操作。不采用“canonicalize 后直接按路径写入”方案，因为它不涵盖检查与操作之间的替换。POSIX fd 不提供 Windows share-delete 的同等排他语义，重命名/删除需要单独设计竞态及恢复合同，不能直接宣告等价。

影响文件：acp/server/workspace_lease.rs、secure_fs、ACP new_session/custom_dispatch/dispatch gate、agents/agent.rs，以及必要的工作区前端合同；不建立第二套权限裁决。阶段一验证租约一次性消耗、身份变化、符号链接/硬链接、会话关闭与重启；阶段二验证根目录清理的审核/隔离/恢复/删除竞态；最后完成真实 Mac UI 新建及恢复 CodePro 任务。这是核心文件权限抽象及状态合同的变更，依根 AGENTS.md 在方案批准后实施。

参考：[Apple F_GETPATH](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)、[openat 相对目录与 O_NOFOLLOW](https://man.freebsd.org/cgi/man.cgi?query=openat)。使用系统 API 与既有 libc，不引入外部实现源码。

## 2026-10-01 依赖与跨平台回归更新

用户已授权安装构建依赖。远程使用 Rust 1.96.1、Node 24.10.0、pnpm 11.9.0、CMake 4.2.3、protoc 31.1 及已有 Go/Command Line Tools。`scripts/prepare-hermit.py` 恢复 Windows 检出中的 Hermit 序列化链接及执行权限；Mac CI 在首次启用 Hermit 前运行该脚本，已验证其他文件保持不变及重复运行。`node-pty` 加入已有依赖构建允许列表。通过锁定版本和文件哈希核对后，经局域网复用本机依赖缓存；最终 `pnpm --dir ui install --frozen-lockfile --offline` 退出 0。

Mac 原生封装/开发入口测试 26/26、TypeScript 退出 0、工作区/布局测试 27/27。实机测试发现工作区根目录经过符号链接（如 macOS `/var`）时，列表混用原始路径和 canonical 路径，导致搜索误报越界；已统一相对路径基准，保留越界拒绝。Windows 同一回归先复现失败，修复后通过 8/8。Swift 按键合同也已验证修饰键别名、Command、符号和数字键盘区别。证据在远程 `target/macos-native-evidence/`，本机 Windows 回归在 `target/macos-parity-20261001/linked-root-*.log`。

Rust Release 原生构建进行中；尚无 `.app`、DMG/ZIP 或完成的安装/完整 UI 验收。上述结果不代表 Windows/Mac 全功能一致验收完成。

## 2026-10-01 Mac 原生验证更新

已通过 RustDesk 开启远程登录、配置任务专用公钥，SSH 已接通；之前的连接拒绝阻塞已解除。远程目录：`/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001`。传输 3,242 个源码文件并逐个核对 SHA-256；UTF-8 文本 CRLF 转 LF，二进制字节保留，来源 HEAD 与未提交整合工作可追溯。

在 arm64 / macOS 26.6.2 使用已有 Command Line Tools（各构建进程设置 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`，未切换系统 Xcode 选择），Go 测试、Swift 合同测试、两个原生 helper 编译均退出 0。首轮发现 Foundation 未导入 CoreGraphics 扩展，已在合同和测试文件显式导入，重建通过。MCP 初始化、九工具注册、缺少屏幕录制权限时返回错误也已在 Mac 通过。证据：`target/macos-remote/computer-build-2.log`、`native-probe.json`。

doctor 显示 Accessibility=false、ScreenRecording=false；真实操作和 Retina 坐标后置条件待验。helper 编译保留 `activateIgnoringOtherApps` 自 macOS 14 弃用且无效果的警告，未导致编译失败。完整 Rust/Electron、`.app`、DMG/ZIP、安装及 UI 全流程仍为 NOT_RUN。现有 Mac 的 Node 26、Rust 1.97.1 与项目指定版本不同，缺 CMake/protoc；用户已授权下载和安装构建依赖，正在通过已有 Hermit/pnpm 入口准备锁定版本。此环境缺口没有计为产品测试失败。

## 2026-10-01 本地验证（原生构建前）

来源仍为原主目录 `main` / `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`，整合 `work/codebuddy-next` / `b8c6eb06c` 加未提交修改。冲突已清零，原有 50 个 dirty 文件的备份与 stash 保留；合并提交等待有效作者姓名/邮箱，未推送。

Mac 专用电脑执行层已接入源码和打包：共用 Go MCP 九工具接口、快照索引、精确窗口绑定和 `desktop_observation` 回执，使用 Swift / AppKit / Accessibility / ScreenCaptureKit 执行 Mac 操作。没有直接换成上游另一套 MCP 状态机。输入失败或取消使所有窗口快照失效；结果未知先重新观察。本机 Mac 已接入 `qwen_computer` 路由，开发启动同步两个 helper，封装检查架构、执行权限和 SHA-256。

已修正此前 8 项失败：ACP 负数用量归零、非 Tester 角色不得将 host verification 当成通过证据；报告测试遵循现有可见摘要/技术详情分层，DAG 测试使用明确验证合同和最新失败回执，避免根据命令字符串猜优先级。受影响 Rust 回归 **191/191**；Go **29/29**、vet；Mac 打包及开发入口 **26/26**；TypeScript、严格 Clippy 均退出 **0**。证据：`target/macos-parity-20261001/`。此前发布检查 34/34、UI 12/12、provider 14/14、SDK 8/8 在 `target/integration-20261001/`，未把不同批次当成一次完整测试。

Go MCP 已交叉编译 arm64/x64 Mach-O 元件；**这些不是安装包**。Swift 原生编译及合同测试、Mac Rust/Electron 构建、DMG/ZIP、安装、TCC、完整 UI 验收均为 **NOT_RUN**。SSH 连接仍被拒绝，待远程登录/公钥接通后继续。Windows/Mac 功能一致尚未验收完成。


```powershell
# Repository root
cargo test --offline -p goose --lib --jobs 1 -- --test-threads=1 agents::codepro_terminal_report::tests agents::task_dag::tests acp::server::tests::test_build_ agents::tool_task::tests
cargo clippy --offline -p goose -p goose-providers -p goose-provider-types -p goose-sdk-types --lib --tests --jobs 1 -- -D warnings
# ui/desktop
node --test scripts/macos-package.test.cjs scripts/ensure-dev-backend.test.cjs
node ../node_modules/typescript/bin/tsc --noEmit
# tools/qwen-computer-use; use CODEBUDDY_GO_EXECUTABLE if Go is outside PATH
go test -json ./...
go vet ./...
```

## 构建

准备 Node 24.10+（24.x）、项目指定 pnpm、Rust 1.96.1、Go 1.22+、Xcode Command Line Tools（含 Swift）、Python 3、CMake、protoc、对应 Rust target。现有 Hermit 入口可提供工具链；首次准备会访问网络。先在仓库根目录执行 `pnpm --dir ui install --frozen-lockfile` 安装锁定依赖，再运行：

```bash
# Repository root; dependencies must already be prepared.
python3 scripts/prepare-hermit.py
source ./bin/activate-hermit
cd ui/desktop
pnpm run bundle:mac --arch arm64
# Run on an Intel Mac for x64:
# pnpm run bundle:mac --arch x64
pnpm run test:macos-smoke
pnpm run test:macos-install
```

在 Apple Silicon 原生构建 arm64，在 Intel 原生构建 x64。`bundle:default` 固定 arm64，`bundle:intel` 固定 x64；不生成 Universal 包。默认先构建 Release Rust 后端；CI 可指定 `--backend /absolute/path/to/release/goose`，来源标记为外部 Release 工件，不声称已验证外部二进制来源。

产物：`ui/desktop/out/CodeBuddy-darwin-ARCH/` 中的 `.app`、arm64 的 `CodeBuddy.zip` 或 x64 的 `CodeBuddy_intel_mac.zip`，以及 `backend-manifest.json`。清单包含 revision、dirty、目标架构及签名前/打包后 SHA256。独立暂存位于 `target/codebuddy-package/macos-ARCH-*/bin`，不会整理开发 `src/bin`。检查后端、pty.node 和 spawn-helper 的 Mach-O 架构，保留 Forge 原生重建、在签名前修正 helper 执行权限。Unix JS 从 ASAR 加载以避免重复 `.unpacked`；终端使用 login shell，缺省 zsh。

原有 `.github/workflows/bundle-macos.yml` 已接入双架构原生 runner、产品元数据路径、源码测试、打包及实际应用烟测，通过后上传包。工作流程尚未推送/执行。

包内包含 `qwen-computer-use` 和 `qwen-computer-runtime`，与 goose 同目录。构建先跑 Go 测试及 Swift 合同测试；清单包含 `computerHashes` 和 `packagedComputerHashes`。缺少 helper、架构错误、内容替换均阻止封装通过。

### DMG 安装验收

打包另生成 `CodeBuddy-ARCH.dmg`、`artifacts.json` 和 `SHA256SUMS`。使用 macOS 内置 `hdiutil` 创建只读 UDZO 映像，包含应用和 Applications 快捷方式；清单记录版本、来源、架构、大小与 SHA-256，校验采用分块读取。

`pnpm run test:macos-install -- /absolute/path/CodeBuddy-arm64.dmg` 要求同目录存在 `artifacts.json`。先检查清单、主机架构和映像完整性，再挂载、用 `ditto` 复制到独立验收目录、卸载映像，然后对安装副本执行烟测。应用和安装回执保留在 `out/macos-install-*/`，烟测证据保留在 `out/macos-smoke-ARCH-*/`。CI 已将此步骤接入安装包上传前门槛；Finder 操作、Gatekeeper 和公证仍需独立验收。

2026-09-30 远端预检：通过 RustDesk 观察到 MacBook Air M2、16 GB、macOS Tahoe 26.6.2。SSH 22 连接被拒绝；原生构建、DMG 产出、传输和远端安装验收仍待执行。待用户完成远程登录和公钥配置后续接。

## 功能与依赖

| 功能 | 条件及剩余验收 |
| --- | --- |
| 文件工作区 | 现有 Node 文件 API；相关测试通过，Mac 实际编辑/保存待验 |
| 终端 | node-pty + 用户 SHELL/zsh；Mac 原生 PTY、多标签、退出清理待验 |
| 内嵌浏览器 | WebContentsView；网络/代理/站点凭据；Mac HTTP/HTTPS、缩放导航待验 |
| 一般 Computer Controller | 现有 computercontroller/Peekaboo；macOS 15+、Homebrew、屏幕录制和辅助功能权限；未安装/执行 |
| 专用电脑验收 Agent | 共用 qwen_computer + 原生 Swift helper；macOS 14+、屏幕录制和辅助功能权限；源码已接入，原生构建及实机验收待执行 |
| 搜索 MCP | 已有 node/npx/uvx + Hermit 首次启动环境，服务 API Key/网络；待真实调用 |
| Git/GitHub MCP | Git、MCP Node/服务配置、GitHub 凭据；Windows 绝对路径在 Mac 重新设置；待真实调用 |
| 记忆 | 现有用户目录/SQLite；外部 Hindsight 单独需要服务；待重启读回 |

桌面部署基线更新为 macOS 14，因为原生执行层使用 ScreenCaptureKit 的 SCScreenshotManager。一般 Peekaboo Controller 仍另需 15+；专用验收 Agent 使用打包的 Go/Swift helper。TCC 需要用户在系统设置授予；Finder 启动和权限归属仍待实机核对。

## 签名与实际验收

本地未签名构建不需要 Apple 凭据。正式分发需要 Developer ID Application 证书/私钥、APPLE_TEAM_ID、APPLE_ID、APPLE_ID_PASSWORD（App 专用密码），可选 KEYCHAIN_PATH。沿用 Forge/osx-sign、公证及当前 optionsForFile entitlements 接口；均未实机验证。

烟测使用隔离 profile/中文工作区，在真实打包应用中经 preload IPC 检查文件读写搜索、PTY 实际输出/cwd/resize、本机 HTTP WebContentsView 导航，保留 Node inspector fuse，通过 Chromium CDP 驱动。日志/图片/JSON 保存到 `out/macos-smoke-ARCH-*/`。这是待执行的受控烟测，不等于用户完整 UI 验收。

arm64 和 Intel Mac 都需完成 Finder 启动、界面编辑保存、多终端、公网浏览器、TCC 观察→操作→复核、搜索/Git/GitHub MCP、记忆跨重启；签名版检查 codesign、spctl、stapler。CI 不能替代用户授予系统权限。

## 2026-09-30 验证（历史记录）

Windows x64 / Node 22.23.2，低于 package engines 的 Node 24 要求。cwd 为 ui/desktop；使用已安装工具。

- Vitest 工作区、终端和 AppLayout：退出 0，26/26。
- TypeScript：退出 0。
- macos-package 单测：退出 0，12/12，证据 `target/macos-package-tests.log`；包含工件校验、清单缺失/替换和架构拒绝；Mach-O 数据夹具未执行 Mac 二进制。
- 现有 distribution：退出 1，31/34。证据 `target/macos-distribution-tests.log`；失败为既有模型/供应商技术名称、tokens/URL/Terminal 文案断言和 Windows jobs 固定命令断言，相关来源本次未修改。
- 首次 pnpm 工具命令自动同步了缓存依赖（下载 0、增加 21/移除 80），执行 SDK postinstall 并清除 .vite；已中断，生成源码没有新增 Git 差异，不计通过。
- 本轮终端 TypeScript 文件 ESLint：退出 0。
- Mac Rust/Electron 构建、烟测、完整 UI、TCC、签名/公证：NOT_RUN。

完整命令和能力边界见[繁体记录](MACOS_ZH_TW.md)。

## 参考

- [Electron Forge signing](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [node-pty ASAR helper issue](https://github.com/microsoft/node-pty/issues/923)
- [node-pty helper execute permission issue](https://github.com/microsoft/node-pty/issues/850)
- [Peekaboo upstream](https://github.com/steipete/Peekaboo)

- [Apple ScreenCaptureKit capture API, macOS 14+](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager/captureimage(contentfilter:configuration:completionhandler:))
- [Pinned Qwen upstream, MIT](https://github.com/QwenLM/open-computer-use/tree/24b7cae4d449a5a8ea58c583e5151096b26de03c)
