# Mac 当前 PDF 的只读落盘核对

[繁體中文](mac-pdf-disk-observation.zh-TW.md) · [English](mac-pdf-disk-observation.en.md)

原生观察和动作后的新回执增加可选 `pdf_document`，同时以 `PDF disk fields` 显示。它只读取当前已匹配窗口的 AXDocument 所指定的本地 `file:` PDF。没有模型提供路径的参数，不搜索文件，不写文件，不自动保存或提交。旧调用继续有效。

`status=read` 表示 PDFKit 成功解析了一份稳定的磁盘快照。`fields` 保留每个 widget 的 `page`、`annotation`、`name`、`value`；重复名称不合并，空字符串与未知 `null` 分开。磁盘字段不是 AX 界面字段：保存前两者可以不同。主模型在用户授权保存后比较目标值和保留值，使用该动作的新回执核对，不必为同一事实额外识图或执行 shell。

原生层核对读前、读后及路径当前的设备、inode、长度、修改与变更时间，拒绝读取中被修改或原子替换的文件；窗口换文档也使结果不可用。文件打不开、损坏、加锁或超过限制时返回 `status=unavailable` 与具体原因，不携带旧字段，不阻断普通窗口观察。缺少本地 PDF 文档 URL 时不返回该字段。

资源边界为 16 MiB、100 页、256 个 widget、32 KiB 字段文本；超限不返回截断的成功结果。回执包含文件大小、修改时间和本次读取耗时。它只能证明读取时的字段落盘状态，不能保证未来不变，也不证明云同步、视觉渲染或整个任务完成。

使用系统 [PDFKit widgetStringValue](https://developer.apple.com/documentation/pdfkit/pdfannotation/widgetstringvalue) 与字段名，不引入新依赖。原先 AXEdited 实验失败记录仍保留在[修改状态实验](macos-document-state.zh-CN.md)，本实现不恢复那个不可靠的布尔判断。
