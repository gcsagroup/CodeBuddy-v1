# Read-only disk verification for the current Mac PDF

[简体中文](mac-pdf-disk-observation.zh-CN.md) · [繁體中文](mac-pdf-disk-observation.zh-TW.md)

Native observations and fresh action receipts optionally expose `pdf_document`, also rendered as `PDF disk fields`. The native observer reads only the local `file:` PDF identified by AXDocument on the matched window. Models cannot supply another path. This does not search or write files, automatically save, or submit. Existing calls remain compatible.

`status=read` means PDFKit parsed a stable disk snapshot. Each widget retains `page`, `annotation`, `name`, and `value`. Duplicate names remain separate; empty strings differ from unknown `null`. Disk values and AX UI values are distinct and can legitimately differ before saving. After an authorized save, the main model compares requested and preserved values using the action's fresh receipt, avoiding redundant image interpretation or shell reads.

The native reader compares device, inode, size, modification time and change time before/after reading and against the current path. Changes, atomic replacement, or a document switch invalidate the result. Missing, corrupt, locked or oversized documents produce `status=unavailable` with a reason and no stale fields; ordinary observation remains available. Nonlocal or absent PDF document URLs produce no PDF receipt.

Limits: 16 MiB, 100 pages, 256 widgets, and 32 KiB of field text. Exceeding a limit never produces truncated success. Receipts include size, modification time, and read duration. Evidence applies to disk fields at observation time, not future stability, cloud synchronization, visual rendering, or overall task completion.

Uses system [PDFKit widgetStringValue](https://developer.apple.com/documentation/pdfkit/pdfannotation/widgetstringvalue), with no new dependency. It does not revive the unreliable boolean inference from the [earlier AXEdited experiment](macos-document-state.en.md).
