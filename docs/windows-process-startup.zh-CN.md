# Windows 子进程初始化与错误弹窗

2026-11-10。适用：`python.exe`、`where.exe` 等子进程出现系统弹窗 `0xc0000142`。

这个状态是 `STATUS_DLL_INIT_FAILED`，表示 DLL 初始化失败，不等于 Python 未安装，也不能据此认定是模型或安装包损坏。锁定的 Harness Windows ACL 沙箱文档说明：受限子进程需要继承宿主控制台，创建独立控制台或无窗口进程可能导致这个状态。同事机器的具体加载失败原因尚未实机确认。

本次修复保持原生 Harness 执行器及其权限边界：

- 宿主启动时设置进程级错误模式，保留原标志，禁止关键错误弹窗阻塞工具调用；不修改系统注册表或全局错误报告设置。
- Windows ACL 启动器通过 Node `--import` 预加载初始化模块。已有控制台保持原样；没有控制台时，在降权前建立控制台，继承原生 Job 启动器的隐藏启动属性。
- 初始化后恢复重定向标准句柄，保留输出管道、控制描述符、Job 回收、超时和取消链路。初始化失败就报错，不绕开沙箱重试。
- 真实失败仍保留退出码与 stderr，界面显示“未成功”。抑制系统模态窗口不等于把错误记为成功。

代码：`runtime/harness/windows-process-errors.mjs`、`windows-sandbox-startup.mjs`、`windows-sandbox.mjs`、`index.mjs`。未改变 ACL 授权、受限 SID 或默认权限；macOS 不调用这些 Win32 API。

验证：Windows 4 项进程/权限集成测试以及 54 项 Harness 相关回归通过；Mac 54 项相关回归通过。新测试模拟没有控制台的桌面宿主，检查隐藏控制台、PowerShell 7/5.1、Python 嵌套启动，以及真正导入初始化失败 DLL 的 EXE。失败返回 `0xc0000142`，后续命令可运行，工作区外写入仍被拒绝。源码桌面版用本地确定性模型夹具发出真实命令，确认失败行显示“未成功”，其后命令成功。该夹具验证产品启动链路，不代表真实模型的自主完成能力。

测试入口（已有 Node 24 与 MSVC；不自动安装依赖）：

```text
node --test runtime/tests/windows-process-startup.test.mjs runtime/tests/windows-workspace-label.test.mjs runtime/tests/pwsh-failure-audit.test.mjs
node --test runtime/harness/test/driver.test.mjs runtime/harness/test/capabilities.test.mjs
```

可通过 `CB_STARTUP_TEST_PYTHON` 指定已有 Python。原生故障夹具和回执保留在测试打印的临时目录。本轮完整证据在 `.local/windows-startup-20261110`。该修复不能保证解决所有 DLL 依赖损坏、安全软件干预或外部程序自行重设错误模式的情况；同事机器需要用新包复测。

依据：[Microsoft SetErrorMode](https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-seterrormode)、[Harness 相同现象的用户复现](https://github.com/deepseek-ai/deepseek-harness/discussions/8142)。上游用户报告用于提出可验证假设，不作为同事机器根因的证明。
