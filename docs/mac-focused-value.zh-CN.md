# Mac 单字段聚焦写入

[繁體中文](mac-focused-value.zh-TW.md) · [English](mac-focused-value.en.md)

`set_value` 增加可选布尔参数 `focus`，仅 Mac 提供。用户于 2026-11-19 批准：主模型仍选择已观察的字段和值，`focus=true` 将该字段的聚焦与写入放在一次原生调用内，省去单独 click 和一次模型往返。不是批量表单执行器，也不自动选择其他字段。

原生执行顺序：校验窗口/字段绑定与控制租约；检查值可写；需要时通过 AXFocused 聚焦；重新核对当前窗口、原控件身分/旧值/位置、实际焦点和人工输入版本；最后写入并生成新回执。聚焦可能触发应用事件，因此复核不能省略。失败即停止，不猜坐标、不使用键盘回退、不重放。聚焦本身已经派发时，后续失败仍记录可能有副作用。

不传或传 false 保持原行为：网页字段必须已经处于核实过的焦点；原生 PDF 可按既有规则直接写值。Windows 不公布这个参数，也不接受它。没有新增持久化状态或修改宿主的 Esc、排队、断线、恢复语义。

调用选择：网页字段优先使用 `focus=true`；Preview PDF 等原生文档字段省略 `focus`。实测 Preview 字段即使声明 AXFocused 可写，仍可能返回 AX 错误 -25200，因此不为直接写值添加不必要的聚焦步骤。

采用系统 [AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue) 与 [AXFocused/焦点属性](https://developer.apple.com/documentation/applicationservices/carbon_accessibility/attributes)。复用现有身份、前台、输入版本及租约校验；不引入依赖。另一方案保留 click→模型→set_value，兼容路径继续可用；没有采用自动遍历并填写整表，因为这会跳过逐字段决策及中断观察点。

FORMS 仍只做建议。文本回执不再重复候选资料与已拆解的 selected_option；原始结构化评分保留完整内容，精确推荐值、当前值、标签来源、概率及截断告警仍可见。不能将本地评分耗时当整轮耗时。
