# CodePro 流式技术证据折叠设计

## 目标

CodePro 报告流式生成 `<details>` 技术证据区时，任何阶段都不向用户显示原始 HTML 标签；报告完成后仍使用现有原生折叠组件。

## 范围

- 只识别以 `# CodePro` 报告标题开头、位于消息末尾的技术证据块。
- 完整 `<details>` 块继续按现有逻辑渲染。
- 未收到 `</details>` 时显示“正在整理技术证据…”，并隐藏尚未完成的标签与正文。
- 普通 Markdown、非 CodePro 内容和其他 HTML 的安全策略保持不变。

## 设计

扩展 `splitCodeProTechnicalEvidence`：先提取完整可信块，再检查剩余尾部是否为 CodePro 报告中的未闭合 `<details>`。若是，返回带 `streaming: true` 的技术证据段；组件将其渲染为不可展开的状态提示。结束标签到达后，现有完整块路径接管并显示正式摘要与正文。

## 安全边界

未闭合块识别必须同时满足 CodePro 报告标题和消息末尾两个条件，不能把任意模型 HTML 当作可信 DOM。

## 验证

- 单元测试覆盖刚收到 `<details>`、部分 `<summary>`、已有正文但未闭合、完整块和普通 Markdown。
- 运行 `MarkdownContent` 完整测试与 TypeScript 类型检查。
- 在当前 Electron 窗口检查裸 `<details>` 文本数量为 0。
