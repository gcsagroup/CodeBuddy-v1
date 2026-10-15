# 会话编辑、重试与分叉

源码为 `D:\CodeBuddy-v1` 当前文件，身份见 [source-baseline.json](source-baseline.json)。renderer 保持原样，本批未安装依赖、提交或推送。实现文件为 `runtime/conversation-driver.mjs`、`runtime/conversation-editing.mjs` 和 Harness driver 的 fork 薄适配。

原 `chatSessionController.ts` 的普通 retry 在当前会话追加原用户请求，不调用 truncate。edit 调用 `_goose/unstable/session/conversation/truncate`，然后发送编辑内容。普通 fork 使用 `session/fork` 和可选 `_meta.conversationBefore`；CodePro 的原 UI 已禁止 fork。继续执行和重新验证仍由 CodePro 的结构化控制面负责。

固定官方 Harness `0.2.1-alpha.2` 提供 `sessionController.fork({sessionId,atSeq})`，按精确事件前缀创建新 native session，并封闭开放 turn；其 Session 是追加日志，没有原地 truncate API。本实现选择官方 fork，拒绝直接修改 JSONL 或另建模型循环。项目为 MIT developer preview，继续锁定当前版本。[官方仓库](https://github.com/deepseek-ai/deepseek-harness)

## 接入合同

```js
const driver = createConversationDriver(rawDriver, store);
const editing = new ConversationEditing(store, driver, {
  isActive: id => active.has(id),
  beforeTruncate: async session => { /* 调用 CodePro owner 的取消接口 */ },
  onChanged: id => initialized.delete(id),
});
await editing.request(method, params);
```

- server 需先包装 driver；懒加载入口增加 `fork` 与 `history`，其他原 driver 方法继续透传。prompt 必须传原 UI `userId` 为 `requestId`；steer 同样保持真实消息 ID。
- fork 返回新产品 `{sessionId}`；truncate 返回 `{}`。编辑在一次 product store 提交中更新可见消息、usage 和 `nativeSessionId`，产品会话 ID 不变。旧 native 日志和 `conversationEdits` 迁移记录保留；没有文件回滚。
- 对应消息边界取官方 `agent/inbox/spliced` 中精确 user-rpc admission 的前一事件。只在 `user/message` 前截断会保留旧队列输入，因此不采用该位置。新 native 日志先完成官方 flush，再发布产品指针。
- facade 映射调用参数、主 Agent 的事件/审批身份和宿主工具执行上下文；子 Agent 保持真实 ID。会话编辑、prompt、直接工具调用共享互斥边界。内存、MCP 测试和 skills 刷新仍由原 driver 提供。
- CodePro 活动中拒绝 edit。idle edit 经 `runs.control` 的 emergency_stop 结束非终态旧 run；completed/cancelled/failed/fatal/exhausted 保留原结论。下一次 prompt 创建新 run。旧工具副作用、不确定 effects 和审计事实保留，不自动重放或回滚。

原 UI 以整秒时间裁剪，因此同秒的多条消息共同进入被移除前缀边界。倒序或交错时间戳、旧预览缺少精确 UI/native request 映射、只读导入、活动任务均明确报错；不按消息文字猜测边界。历史复制只继承选定配置和消息，不复制运行状态、审批凭据或 journal receipts。

若取消旧 run 后产品状态提交失败，原指针和可见历史保留，可能留下一个未发布 native fork；旧 run 的取消仍是已发生事实。这样的失败不会让新上下文继续使用旧 run。后续原任务执行需按界面状态重新发起，未自动删除审计日志。

## 验证

在 `runtime` 执行 `node --test tests/conversation-editing.test.mjs`，6/6 通过，退出码 0。真实官方 Harness + 本机受控 HTTP，临时目录，覆盖第一条编辑不重排旧输入、精确上下文、同秒语义、历史和 usage、重启、真实主/子 Agent 工具身份、审批、活动互斥、取消/状态提交失败。

`node --test tests/conversation-editing-acp.test.mjs`，1/1 通过，退出码 0。真实 WebSocket ACP + 官方 Harness 执行计划、开始任务与原生写文件，原 UI truncate RPC 取消旧 run，再通过原 prompt 建立新 run、新计划与新模型上下文；旧事件和实际文件保留。未调用真实用户模型，未修改用户资料；原桌面编辑交互仍需单独验收。
