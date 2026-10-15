# 统一任务续接来源

2026-09-15 · [繁體中文](2026-09-15-unified-continuation.md) · [简体中文](2026-09-15-unified-continuation.zh-CN.md) · [English](2026-09-15-unified-continuation.en.md)

已确认反例：`继续。` 被当作新目标，丢失先前 unknown 操作的追踪窗口。定向 RED：0 通过、1 失败；证据 `continuation-red.json`。

沿用统一回合既有 source_message_id 作为目标来源；新增可选消息元数据 task_continuation_of 仅记录对此来源的引用。turn_id 仍表示本轮执行，steer 仍只表示投递方式。可信入口核对既有任务状态、工作区、intent 和历史来源后写入；默认缺省兼容旧数据，用户原文不能建立关系。目标提取和 unknown 历史追踪共用此已解析的关系。

本次只支持既有纯继续语句加句末标点，以及明确的继续加仅鼠标限制短句。取消、停止、明确新目标、额外混合内容和不匹配来源不自动视为续接。不扩大旧 clarification 的纯继续语义；不宣称任意自然语言分类，也不代表已强制禁止键盘或脚本。

OpenAI 公开文档描述 steering 将新增要求纳入续接并保留已完成工作。本次采用保留原任务和更新原文的原则，不推测 Codex 私有分类器，不引入外部代码或依赖。

公开 `reply_codepro` 入口及续接回归 10 项通过；消息类型 429、tracker 30、统一回合 10、既有 provider 回归 1、ACP 114 项均通过。各过滤器有重叠，不相加为总数。格式、Clippy、后端构建退出码均为 0，见 `continuation-focused.json` 和 `continuation-gates.json`。

公开入口测试先提交附加鼠标限制，再重载后提交带标点的继续；每次 provider 实际收到原目标、限制原文及 unknown 回执，原 source 保留，三次失败后暂停。旧消息缺省、来源／工作区不匹配、伪造文字和晚到旧关联的边界见 `continuation-boundary-evidence.json`。首次执行层失败源于测试漏掉公开入口的消息持久化步骤；保留原记录，最终已直接测试公开入口，见 `continuation-test-fixture-classification.json`。

新版独立 Electron 已验证旧会话加载及 Ctrl+R 重载兼容性，原消息和手动模式仍可见，见 `continuation-native-summary.json`。这只证明加载／刷新兼容；真实模型理解及自主桌面续接仍为 `NOT_RUN`，不探测 120 或 107。仅用鼠标的工具执行强制仍未实现，属于下一切片。

[OpenAI: Model guidance](https://developers.openai.com/api/docs/guides/latest-model)

Evidence: `.cargo/evidence/audit-fixes-20260914/`.
