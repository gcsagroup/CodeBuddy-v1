# Mac 本地 FORMS 标签映射

[繁體中文](mac-form-label-projection.zh-TW.md) · [English](mac-form-label-projection.en.md)

这项接入解决中文控件标签无法进入当前 FORMS 英文词汇的问题。主模型解释字段含义并提供英文评分标签，FluidUse/CUA-S1-FORMS 在 Mac 本地评分，已有原生工具执行主模型选择的输入。没有增加网络模型、输入权限或自动提交。

上游明确说明已发布的小模型主要依赖训练概念词汇，词汇外标签容易得到高概率 skip。实际消融也发现 `Work email` 会跳过，而 `Email` 可以匹配；中文表单标题、已有内容也可能影响结果。不能把所有 skip 都视为错误，更不能清空评分上下文中的旧值来强迫填写。参考：[上游模型说明](https://github.com/trycua/cua/blob/main/libs/cua-s1/MODEL_CARD.md)、[训练概念](https://github.com/trycua/cua/blob/main/libs/cua-s1/python/src/cua_s1/concepts.py)。

## 调用方式

先用 `get_app_state` 观察准确窗口，再向同一个窗口传入 `form_entities` 和可选 `form_labels`。以下编号仅是示例，必须复制实际观察中的编号：

```json
{
  "app": "window:42:8",
  "form_entities": [
    {"label": "公司", "value": "海风测试"},
    {"label": "工作邮箱", "value": "qa@example.test"}
  ],
  "form_labels": {
    "title": "Customer Form",
    "fields": [
      {"element_index": "18", "label": "Company"},
      {"element_index": "23", "label": "Email"}
    ],
    "entities": ["Company", "Email"]
  }
}
```

- `title` 只用于评分，不改变窗口选择范围；缺省时使用原窗口标题。
- `fields` 只列主模型已经明确辨认、需要匹配的字段。未列字段不推理，返回 `skip`、`execution=not_run`。同名邮箱确实无法区分时不填写映射。
- `entities` 与原资料顺序一一对应。英文评分标签最长 64 ASCII 字节，不允许把两份资料映射成相同标签，从而丢掉不同收件人的区别。
- 原始标签、当前值和填写值保持原样。回执分别包含 `original_label`、`matching_label`、`current_value`、原资料和实际本地概率；无推理的字段没有伪造概率。

## 绑定与兼容

Go 从当前快照取原生控件身份，模型不能提供或覆盖原生绑定。Swift 在推理前验证窗口标题、边界，以及所有带名称或值的节点和全部可编辑字段的身份、名称、值和位置。无名称、无值且不可编辑的装饰节点不参与翻译上下文比较，避免 Safari 增减空 AXGroup 导致假过期；空白、无名的可编辑字段仍参与，目标字段的原生路径仍须精确一致。字段、附近标签、草稿或窗口发生变化时拒绝旧投影；返回新观察和匹配不可用原因，不执行输入，不自动重播。

无效的可选映射只降级匹配，不能阻断普通观察，也不能静默退回原始标签评分。无映射的旧调用保留原行为。映射随现有内存快照失效，没有新增持久状态。主模型仍决定是否根据用户明确指令覆盖已有内容；FORMS 的 skip 不是权限裁决。实际保存必须区分按键回执、界面状态和磁盘结果。

测试包含真实 CoreML 中文字段推荐、未映射字段保留、映射过期、重复资料别名、旧调用兼容和控件编号重映射。真机结果另见本批性能验收记录，自动测试成功不代表产品验收通过。
