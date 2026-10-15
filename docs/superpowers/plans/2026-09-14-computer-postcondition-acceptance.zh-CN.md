# 电脑动作后置条件验收

日期：2026-09-14。[繁体中文](2026-09-14-computer-postcondition-acceptance.md)为默认版本；另有[English](2026-09-14-computer-postcondition-acceptance.en.md)。

## 结论

旧记录的 unknown 是验收条件不足，并非已确认的产品误判。当时只要求 foreground:true，而窗口在点击前已位于前景；页面改变不能证明该条件由点击达成。本轮没有修改产品代码或成功判定阈值，原始证据保留。

在隔离 Electron 窗口 83169794（PID 19340）通过真实 ACP 电脑工具点击历史记录，指定已观察到的精确可见 button“导入链接”为后置条件：首次出现返回 worked；原本已存在且没有可归因变化时返回 unknown；指定不存在的按钮返回 unknown 与超时原因。独立原生窗口树核对了实际页面。

44.279 秒后使用旧观察时，工具在输入前拒绝并要求重新观察；更新观察后，旧截图标识已被清理，仍不能使用。这两笔是预期保护结果，不是测试失败。

## 证据与边界

证据根目录为 .cargo/evidence/audit-fixes-20260914/。computer-postcondition-native-summary.json 汇总 call-09、16、20、24、28、31；computer-\*-native.txt 保存独立原生观察。既有电脑模块测试 126 通过、0 失败、0 忽略，命令与退出码见 computer-postcondition-tests.json。

只证明指定页面目标转换，工具派发完成不等于结果已确认，更不等于整个任务完成。没有发送模型提示，没有探测 120 或 107；真实模型自主闭环仍待验。鼠标约束、同类失败重试及等待恢复仍在后续审计范围。
