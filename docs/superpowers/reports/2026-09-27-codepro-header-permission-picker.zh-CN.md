# 会话标题、操作分组与权限入口修订

## 范围与源码身份

用户要求：标题放在左上角；“已执行命令”等分组标题略大，与具体命令同色；当前模式点击后弹出小卡片切换，并核对不同模式的设计。

工作区 `C:\Users\admin\CodeBuddy`，分支 `fix/codepro-context-compaction`，基点 `25d4d48c1c2f90ef161f726bc1a76f013cd1ee5f` 加现有未提交改动。本轮未切分支、提交、推送，未修改 Rust 权限策略。遵照用户要求不运行测试。

## 已实现

- `BaseChat.tsx`：CodePro 对话左上角显示真实 `session.name`，长标题截断但悬停可看全；标题不随正文滚动，不再用右上角产品水印占据此位置。收回原本为水印留的正文顶部空隙。
- `ToolCallExpandable.tsx`、`CodeProWorkStep.tsx`、`ProgressiveMessageList.tsx`、`styles/main.css`：单独标记操作组标题，字号 14px/字重 500，与具体命令使用同一 secondary 颜色；具体命令仍为 13px，不扩大所有工具详情。
- `SessionPermissionSummary.tsx`：说明折叠改为窄幅 Popover，提供请求批准（手动）、只读自动放行（智能）、完全访问（自主）、仅聊天；全访问以橙色提示，聊天与执行权限选项分隔。选项复用现有模式说明，不复制一套权限判定。
- `acp/sessions.ts`：调用已有 ACP `setSessionMode`，不写全局 `gooseMode` 默认偏好、不乐观更新当前权限。现有 `current_mode_update` 通知是 UI 选中项的数据来源。
- `BaseChat.tsx`、`ChatInput.tsx`：运行中先停止/完成再切换；切换请求待确认期间暂停新消息发送与队列派发，提示“正在切换权限”。失败不把选中项改成用户刚点的值；会话隔离保留。
- `i18n/messages/en.json`、`zh-CN.json`：增加对应短文案；其他语言回落到默认文案。

## 实际调用链

用户明确选择 → `acpSetSessionMode(session.id, mode)` → `GooseClient.setSessionMode` → Rust `dispatch.rs` 的 `SetSessionModeRequest` handler → `server.rs::on_set_mode` → `Agent::update_goose_mode`（provider 接受、会话持久化、Agent 当前模式更新）→ 后端发送 `CurrentModeUpdate` → `chatSessionStore` 更新相同 session 的 `goose_mode` → UI 显示。

这条链已有后端支持，因此不需要为了增加一个切换入口重建权限协议。源码证据不代替实际点击/重载验收。

## 与 Codex 的已确认差异

使用 OpenAI Docs 技能查阅了 [官方权限说明](https://learn.chatgpt.com/docs/sandboxing)：Codex 将访问边界与审批者分开，`auto_review` 让独立 reviewer 处理符合条件的审批请求，并不扩大 sandbox；full access 则是另一组访问与审批设置。

本项目 `permission_inspector.rs` 中：

- 自主主任务在已有 full-access 分支放行，但显式禁止、不可用工具和子任务合同边界仍有效。
- 手动允许已有授权/只读策略覆盖的动作，其他请求批准。
- 智能的额外识别主要是未分类工具的只读识别；已分类的 CodePro 工具先走统一 `permission_action`，因而与手动存在重合。它不是独立代批审核，不应标成 Codex “帮我批准”的等价实现。
- 仅聊天是不用工具的执行方式，不是一档更高级的权限。

完整复制 Codex 的沙箱/独立审核组合涉及新的权限链实现，本轮没有自行扩大权限。已向用户提出选择：先完成准确的模式入口，或先制定独立审批方案和边界再确认。没有把 UI 对齐写成权限内核已对齐。

## 验证与待验收

- 局部 Prettier：退出 0。
- `pnpm.cmd run typecheck`：初轮与发送等待补齐后均退出 0。
- `pnpm.cmd run i18n:compile`：退出 0。
- 本批文件 `git diff --check`：退出 0。
- 现有 Vite 开发服务接收更新，未重启桌面或后端，未触发真实模式切换、工具操作、自动测试或产品 E2E。
- 用户可验收：标题位置与滚动、分组标题层级、小浮层键盘/鼠标选择、后端成功后选中项更新、重载保留、其他会话不变、执行中不可切换及失败反馈。以上不是已通过声明。
