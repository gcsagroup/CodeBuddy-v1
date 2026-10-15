# 无效归一化坐标的重试计数

日期：2026-09-14。[繁体中文](2026-09-14-computer-invalid-coordinate-retry.md)为默认版本；另有[English](2026-09-14-computer-invalid-coordinate-retry.en.md)。

## 已确认反例

隔离窗口的真实 ACP 调用使用 `screenshot_normalized_1000`、`x:1001`、`y:500`，三次使用不同新截图，均在输入前返回“归一化截图坐标必须位于 0..1000”。截图更新不能修正此坐标错误，但原有重试指纹包含截图标识，会分别计数。证据：`.cargo/evidence/audit-fixes-20260914/computer-normalized-range-native.json`。直接 ACP 不经过主 Agent 的重试状态机，不能单凭这三次拒绝宣称主循环停止已验收。

## 最小设计

仅对电脑坐标工具、归一化坐标模式、明确错误回执及上述精确单一错误文字，从失败指纹排除截图标识。保留坐标、坐标空间、目标及其他参数；修正输入可再次尝试。沿用既有第二次检查、第三次暂停的机制，不改权限、工具输入或任务完成判定。

现接口没有此拒绝的结构化错误类别，因此本次精确文字分类有明确局限：不使用模糊匹配，不扩大到过期状态、窗口变更、一般 unknown 或所有电脑错误。

## 公开方案比较

OpenAI 的公开电脑使用文档要求执行环境保留状态、应用权限与执行限制，并依据动作、截图和最终状态评估结果。本方案保留新状态的重新评估机会，只限制无法由换截图修正的已知参数拒绝；不推测 Codex 私有重试算法，也不将回合上限视为产品故障。[OpenAI：Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)

## 验证状态

回归已通过：定向 tracker 26 项；完整 goose 库 3307 项通过、2 项忽略；ACP 114 项。新增主执行层测试及相关统一回合复测 9 项、既有分析 provider 回归 1 项均通过；格式、Clippy 和新版后端构建退出码均为 0。

主执行层证据确认第二次失败后持久化修复提示、第三次后暂停、provider 仅调用 3 次，且原目标保留。首次测试因 MOIM 在 provider 消息中追加内容导致整条相等断言失败；改为包含完整提示常量，持久化精确内容和停止断言保持不变。这是测试断言不匹配现有消息封装，不是产品回归。

新版隔离 Electron 的真实 ACP 验收：越界坐标在输入前被拒绝，页面未切换；新截图配合正确坐标后进入历史记录页，目标按钮从不存在变为可见，回执为 `worked`。证据见 `retry-gates.json`、`retry-execution-focused.json`、`retry-final-gates.json`、`retry-native-summary.json`（均位于上述证据目录）。直接 ACP、真实回执重放和主执行层测试是独立证据；真实模型自主闭环因用户停服仍为 `NOT_RUN`，不探测 120 或 107。
