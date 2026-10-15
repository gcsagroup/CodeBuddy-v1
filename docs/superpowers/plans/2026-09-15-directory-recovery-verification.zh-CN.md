# 目录恢复修复与验收

## 已确认的问题

自建隔离目录暂时改名后，公开 `session/info` 请求在读取数据库元数据前即被工作区租约检查拒绝，原生界面因此显示英文错误，无法进入 `session/load` 既有的重新确认流程。

同一会话尚在加载时，带有不同 `cwd` 或 `workspaceLeaseId` 的请求也会共用旧请求，造成新的明确参数未送达。成功及失败的旧请求均有确定性 RED 用例。

## 最小修复与边界

`GetSessionInfo` 由处理函数保护：先取得会话生命周期锁，再取得访问许可，只读数据库元数据，不读取项目文件、不取得或刷新工作区租约。工具及写入仍使用既有工作区校验；不存在及已关闭会话仍拒绝。

前端相同加载参数共用请求，不同参数按顺序执行，前一个请求失败后仍可继续。不同会话互不等待。这不新增取消 API，也不授予跨目录重绑权限。

既有会话恢复原目录；新目录使用新任务。原目录失效不应静默建立新目录或改绑另一项目。

## 验证状态

前端相关 6 文件 78 项通过，TypeScript 与 ESLint exit 0。后端新增 2 项通过；分发回归 9 项、加载回归 12 项通过，前端全量 2060 通过、4 跳过。首次后端测试为 1 通过、1 测试夹具失败（缺少独立 cleanup journal root）；修正夹具后重跑通过。

Rust 回归、Clippy 与新后端构建通过。公开 ACP、取消不改绑定、恢复原目录、重试重新检查、明确确认、刷新及双窗口 A/B 隔离均通过；原有 8 条会话哈希未变。全量 2060 通过、4 跳过发生于最后“无效目录映射／重试按钮”之前，最后改动由 78 项定向测试、类型／ESLint 及原生验收覆盖。真实模型十轮为 NOT_RUN，未探测 120 或 107。

证据：`D:/CodeBuddy/.cargo/evidence/audit-fixes-20260914/` 中的 `directory-acp-recovery-red.json`、`directory-missing-before.png`、`directory-load-concurrency-red.log`、`directory-focused-final.log`、`directory-metadata-tests-fixed.json`、`directory-source-frozen.json`。

Final evidence: `directory-native-summary.json`, `directory-acp-recovery-green-final.json`, `directory-focused-retry-final.log`, `directory-final-ui-gates.json`.
