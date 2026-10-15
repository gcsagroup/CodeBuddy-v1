# 历史记录管理第一阶段验证

日期：2026-09-15。

## 范围与设计

本阶段加入 Active、Archived、All 三种历史视图，以工作目录作为项目筛选值，并提供 Today、Last 7 days、Last 30 days 的活动时间筛选。单个会话可以归档或恢复；删除仍沿用现有确认流程。

后端原本已经提供 `_goose/unstable/session/archive`、`unarchive`，列表中也已返回 `archivedAt`、`projectId` 与活动时间。本阶段复用现有协议，不增加另一套归档状态。历史页加载全部分页后在客户端应用筛选，因此当前结果正确，但不适合无限增长的大型历史库；服务端筛选和事务式批量管理留待后续协议设计。

OpenAI 的公开行为把归档定义为隐藏而非删除，归档不需要删除确认，并提供独立的归档管理与恢复入口。本阶段采用这一可恢复边界；没有采用“一键删除全部”，因为 CodeBuddy 当前没有批量删除的原子 ACP 契约。[OpenAI：删除与归档聊天](https://help.openai.com/en/articles/8809935-how-to-delete-and-archive-chats-in-chatgpt) [OpenAI：Codex 聊天归档与删除](https://help.openai.com/en/articles/20001333-how-to-archive-and-delete-chats-in-codex)

## 自动化证据

- RED：`SessionListView.management.test.tsx` 首次运行 3 个失败，缺少视图、筛选和归档操作。
- GREEN：新增测试 3 个通过；连同分页、搜索、复制能力和 ACP session 测试共 31 个通过、0 个失败。
- `prettier --write`、`tsc --noEmit`、精确 ESLint 均 exit 0。
- 证据：`.cargo/evidence/audit-fixes-20260914/history-management-red.log`、`history-management-green.log`、`history-management-focused.log`、`history-management-ui-gates.json`。

## 尚未完成

- 15 个语言目录尚未重新生成；需要等待共享 i18n 写入任务结束后统一执行。
- 真实 Electron 窗口中的归档、恢复、筛选和刷新持久化尚未验收；本任务当前没有原生应用控制 API。
- 批量管理尚未实现。批量删除必须先定义原子性、部分失败和确认边界，不能用前端 `Promise.all` 冒充事务。
