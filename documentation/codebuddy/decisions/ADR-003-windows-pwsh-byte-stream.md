# ADR-003：Windows 受限 PowerShell 的字节流初始化

日期：2026-11-25。范围为本轮 Windows 沙箱恢复授权；不安装 PowerShell、不升级 SDK、不扩大只读权限。

## 问题与选择

锁定 DSH 0.2.1-alpha.2 在每条 PowerShell 命令前构造两次 UTF8Encoding。只读 CLM 拒绝这些构造，命令即使成功也输出两条初始化错误。仅加 FullLanguage 判断能去噪，但本机 PS7 的 Console 输入/输出仍是 CP936：中文输入、捕获原生输出和 emoji 会丢失，宿主事后解码不能恢复。

采用现有 `SandboxPwshExecutor.confine` 内的只读 ASCII 主版本探针，随后仍交回同一原生执行、Job、进程事实和取消链。探针和实际命令只捕获一次同一可执行路径，使用相同工作目录及环境合并，探针独享空 stdin。每次重新探测，避免把启动器文件 stat 当成邻近运行时和环境的永久身份。实测增加约0.6–1.1秒单次准备成本；不另给用户命令一份执行预算。

探针的五秒上限覆盖受限准备、启动、结果和受管范围退出；调用方更短的取消信号优先。IPC交接、spawn前和成功返回前复检单调期限。失败不派发用户命令，保留原生 `SANDBOX_UNAVAILABLE`；已启动探针的终止与退出仍由 subprocess owner 执行。失败或取消先terminate，再以独立最多5秒的cleanup边界等待同一handle的done和waitForExit；确认失败返回明确的SANDBOX_UNAVAILABLE，不伪装成已退出。执行器只等待同一preparation Promise，避免原生取消race丢弃其cleanup。默认tool-pwsh在尚未取得payload handle时也等待该startup Promise，并只从原始异常实例恢复结构化错误，避免job文字视图抹掉错误类型或提前发取消终态。

## 字节流与所有权

- 仅实际 Windows 默认 ACL carrier 宣告支持。完全权限、自定义 runner、非 Windows 保持原路径。进程内 Symbol 标记跨准备 IPC 转成严格的 `core/legacy`，返回真实受限 argv 后重新附标；没有新增 ACP 或持久化状态。
- carrier 在创建受限 token、PowerShell 缓存 Console 编码之前，仅脱离自身继承的 console，创建自己的隐藏 console。保存并恢复 PIPE/DISK 标准句柄，保留原生控制通道；真正 CHAR/console 句柄在任何分离前拒绝。缺省 stdin 在这条链路使用空 PIPE，立即 EOF；显式 stdin 保留原数据。
- PS6+ Core 在新 console 上预置输入/输出 CP65001，CLM 内取公开的 `Encoding.Default` 作为 `$OutputEncoding`：UTF-8、无 BOM、replacement fallback。没有反射、签名 helper 或语言模式提升。
- PS5.1 Framework 保留原输入码页，只预置输出 CP65001；FullLanguage 保留旧初始化，CLM 跳过非法构造。去噪、直接输出及基本 ASCII 兼容成立，但其 ASCII 原生管道和本地码页输入仍有 Unicode 限制。本变更不宣称修复 PS5 全部 Unicode，不隐式删除其回退支持或依赖本机 Codex 私有 PS7 作为交付依赖。
- 用户命令前核对实际运行时 family；配置启动器若切换引擎，该实际进程给出非零回执，不自动重放。宿主只将探针前失败判为未派发，不能从用户可生成的 stderr 文本重判授权或自动重试。
- preload 初始化失败早于上游 main catch，因此按锁版原生 runner 的 `windows-acl-run: …` 与 exit127 合同结算并停止，不继续加载用户命令；真实用户错误、退出码、stderr不清空。

`confine`、`spawnSpec` 是上游私有 TypeScript 接缝。适配锁定 pwsh-sandbox/pwsh-local 源码 SHA256；升级须重新审查派发、argv复制、环境、stdio与取消合同。

## 拒绝的方案

仅隐藏警告无法恢复已经丢失的字节；PowerShell脚本内 `chcp` 晚于异步输入读取器初始化，存在竞态。临时使用严格 UTF8 getter 在无效代理字符上导致 PS5 异常退出；unsigned helper DLL也被真实CLM拒绝。统一将PS5输入CP改65001会引入已有Framework BOM行为。强制仅支持PS7属于发布依赖与兼容迁移，本轮不实施。

## 证据边界

同一真实执行链回归先测红，再测绿；覆盖默认 EOF、显式 Unicode stdin、直接及捕获输出、原生管道原始字节/BOM、无效代理字符替换、CLM/只读拒绝和真实用户 exit/stderr。失败路径另测真实 CHAR 拒绝、原生错误类型、5.1秒延后 IPC 不启动探针、探针取消回执前受管范围已退出、原生job停止第二次等待缩短到1ms仍不能绕过该barrier。独立审查发现的三处错误路径已修复。组件回归不替代真实模型或桌面验收。

## 依据

- [DSH PowerShell 本地执行器](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/shell/pwsh-local/src/index.ts)
- [PowerShell：ConstrainedLanguage](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes)
- [Microsoft：FreeConsole](https://learn.microsoft.com/en-us/windows/console/freeconsole)、[AllocConsole](https://learn.microsoft.com/en-us/windows/console/allocconsole)、[标准句柄](https://learn.microsoft.com/en-us/windows/console/getstdhandle)
- [Microsoft：Encoding.Default 的 Framework/Core 区别](https://learn.microsoft.com/en-us/dotnet/api/system.text.encoding.default)
- [PowerShell 异步输入初始化源码](https://github.com/PowerShell/PowerShell/blob/v7.6.9/src/Microsoft.PowerShell.ConsoleHost/host/msh/Executor.cs)
