# 网页交付验收

用于开发网页后的真实交互验收。先读取用户需求与现有测试配置，确定主流程和与本次改动相关的边界。逐项记录可观察的预期结果、操作和实际结果。用户已经授权验收时直接进行，否则遵循浏览器工具的现有确认机制。

复用 browser_control 的当前页面和操作回执。一个交互已给出充分证据时即可结束该项。仅对失败、修改后的行为或证据缺口重复测试。所有约定事项有结果后立即交付，清楚列出未通过或未覆盖项。不要为收尾另起无关探索任务。

表单检查输入、提交与重复提交；中文输入法检查选词回车；弹窗检查键盘打开、Esc、焦点归位；响应式检查用户目标宽度的溢出与主要按钮。按实际需求选择，避免机械全跑。

需要可重复回归或操作追踪时复用项目现有 Playwright 测试。优先 locator、角色与标签，等待可观察状态，失败保留 trace。无障碍扫描使用项目已安装的 axe-core 或 @axe-core/playwright，检查实际页面状态；自动扫描结果不能证明完整无障碍合规。缺少依赖时明确说明，按现有安装授权处理。文档 https://playwright.dev/docs/accessibility-testing 与 https://playwright.dev/docs/trace-viewer 。

繁體：依需求選取必要的真實互動，保留操作結果，證據充分後交付。
English: Validate requested interactions with fresh browser evidence. Reuse existing Playwright tests and capture traces for failures. Stop after the agreed checks have outcomes.

已内置 web_audit，可检查用户授权的工作区 HTML 初始页面的 axe 无障碍问题和指定宽度的溢出。使用 path、width 参数。必须在获准浏览器验收后调用，不能把初始状态扫描视为交互流程已通过。
