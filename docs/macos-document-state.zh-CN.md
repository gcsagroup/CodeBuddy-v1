# Mac 文档修改状态实验：已撤回

[繁體中文](macos-document-state.zh-TW.md) · [English](macos-document-state.en.md)

2026-11-19 的实验没有进入交付版本。窗口级 `AXEdited` 在本机 Preview 中不支持；改读该窗口关闭按钮后，填写前、填写后和保存后均为 `false`，无法证明本次 PDF 字段是否存在未保存修改。源码及运行中的原生模块均已恢复实验前版本。

- `true`：应用报告有未保存修改。
- `false`：应用报告没有未保存修改。
- `unknown`：属性缺失、读取失败或类型错误，没有可用的修改状态证据。

这些是原拟采用的三态含义，不代表已实现的产品合同。`false` 不代表独立验证过磁盘、同步服务或远端持久化；不能单凭该值声称文件内容正确。用户未授权保存时，该属性也不构成保存授权。

实验参考 [Apple AXEdited 属性](https://developer.apple.com/documentation/applicationservices/kaxeditedattribute?language=objc)，只接受原生 CFBoolean，错误类型保持未知。原生合同测试通过，但真实应用没有返回所需状态变化，因此不能用编译或单元测试代替产品验收。

窗口级试验 `after-pdf-1` 为 39.156 秒、103,595 输入 token；关闭按钮试验 `after-pdf-2` 为 82.184 秒、371,010 输入 token，主模型额外查找磁盘文件。PDF 最终字段和保存内容正确，但性能目标未通过。记录位于本地 `.local/mac-speed-20261119/`。输入 token 包含缓存读取，不能当作计费金额。后续提示词去重结果见本批性能报告。
