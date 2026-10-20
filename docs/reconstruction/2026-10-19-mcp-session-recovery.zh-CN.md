# 远程 MCP 会话恢复

## 行为与边界

修复有会话的 Streamable HTTP 连接收到会话失效回执后持续使用旧 Mcp-Session-Id，以及禁用/启用、删除/重加同一配置仍命中旧连接的问题。连接、重试与工具执行继续由既有 MCP bridge、SDK 和 Harness 租约管理；没有新增调度器或修改持久化格式。

- 带有效会话身份的 HTTP 404 触发现有退避重连。兼容 HTTP 400 且 JSON-RPC error.code 为 -32600、error.message 精确为 Session not found 的服务器回执；普通 400、认证错误和工具文本不视为会话失效。
- 新 transport 重新初始化，清除配置中任何大小写的 Mcp-Session-Id 请求头，保留认证头，重新发现工具。连接状态在恢复期间为 error，恢复后为 ready。
- 失败调用保留真实错误，不自动重放工具、资源请求或已受理的 Tasks。结果未知的操作不因重连而重复执行；用户/Agent 的后续独立调用使用新连接。
- 全局扩展设置和聊天内扩展增删使对应共享 preset 退役；下次使用重新取得连接。已有租约继续服务持有者，避免中断其他聊天的在途工作；释放后由 Harness 回收。普通查询与未涉及的配置继续复用健康连接。
- 遵守已有重试次数、退避与退出清理，不对健康会话定时更换 ID，也不强制迁移无会话协议。

## 依据

[MCP 2025-11-25 会话管理](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/transports.mdx#session-management) 要求会话失效的 404 触发不携带旧 ID 的初始化。复用本项目已安装的 MCP Client SDK 2.2.0 和 DeepSeek Harness 0.2.1-alpha.2（MIT）；本次没有新增依赖。400 处理是针对已观察到的服务端协议回执的兼容路径，不解析模型自然语言。

## 验证记录

源码来源：D:\\CodeBuddy-v1，main，基线 7321135 加当前工作区修改。保留已有其他功能的未提交修改。

使用现有 Node 24.19.0，以下相关测试命令退出码 0，74 项通过：

```powershell
node --test runtime/harness/test/mcp-session-recovery.test.mjs runtime/harness/test/mcp-apps.test.mjs runtime/harness/test/mcp-startup.test.mjs runtime/harness/test/mcp-metadata.test.mjs runtime/harness/test/mcp-vision.test.mjs runtime/tests/mcp-session-recovery-acp.test.mjs runtime/tests/mcp-apps-harness-integration.test.mjs runtime/tests/mcp-task-execution.test.mjs runtime/tests/settings.test.mjs runtime/tests/settings-runtime.test.mjs runtime/tests/extension-resolution.test.mjs
```

随后增加 Tasks 会话丢失、重试耗尽、退出取消三条边界回归，重跑以下受影响目标，10 项通过、退出码 0：

```powershell
node --test runtime/harness/test/mcp-session-recovery.test.mjs runtime/tests/mcp-session-recovery-acp.test.mjs
```

ACP 测试通过真实 WebSocket 和当前兼容服务/Harness，覆盖设置开关、删除重加、聊天内增删、会话失效后恢复。服务器、提供商和数据目录均为本地隔离夹具。

## 真实桌面验收（2026-10-19，三项核心场景通过）

通过现有 `scripts/start-harness-preview.cjs` 的 `startPreview` 启动当前工作区 Electron，使用独立 profile、本地 MCP 和确定性模型夹具。运行端口为 62957、渲染页面为 localhost:5174；会话为 bf402e8a-b86b-4ad8-92a8-20833439ccf3。6 个核心修复文件的 SHA-256 与启动前记录一致。通过桌面输入消息和工具箱开关操作，核对界面、服务端请求与 Harness 持久化工具回执：

| 场景 | 结果与证据（UTC） |
| --- | --- |
| 基线实际调用 | 08:44:27，session-2，execution=1，成功 |
| 404 会话失效恢复 | 08:48:58.437 旧会话被拒；534 ms 后无旧 ID 初始化 session-3；下一条消息于 08:49:20 成功，execution=2；原失败调用未重放 |
| 工具箱关闭再启用 | 界面显示停用后重新启用；08:52:12 初始化 session-4，08:52:15 实际调用成功，execution=3 |
| 删除后同名同地址重加 | 桌面确认删除后列表从 4 项变为 3 项，持久化配置同步移除；通过添加表单重建 DesktopProbe 和原地址，返回原聊天；09:15:49.251 无旧 ID 初始化 session-5，09:15:51.280 实际调用成功，execution=4 |

删除步骤曾遇到窗口最小化/用户输入保护及控制助手缓存错误：`call get_window_state before using this window`、`unknown screenshotId screenshot-0` 和 `element 1464 is not available in cached app state for electron.exe`。本轮重置 node_repl 控制会话、重新导入 sky 并按既有窗口 ID 绑定后恢复。部分无障碍元素点击位置与画面不符，使用最新截图定位按钮、每步重新观察，完成删除确认、同名同地址添加和原聊天发送。开发页面中途重载，重新打开表单后完成；未修改控制助手或产品源码，因此这里只确认本次控制链路恢复，不声称底层缺陷永久修复。

夹具中的 `search_mcp_tools` 被已有聊天的扩展权限拒绝；直接 MCP health 调用的成功由服务端及持久化回执证实。因此本轮不代表工具搜索路径通过。HTTP 400 兼容路径只有自动测试证据，未执行桌面场景。

本地证据保存在忽略目录 `.preview-evidence/mcp-session-desktop/`：`wire.jsonl`、`source-identity.json`、8 张截图及 `profile/backend/harness/sessions/`。新增截图 `06-deleted.png`、`07-readded.png`、`08-delete-readd-success.png`。第 5 轮持久化 `tool/result` seq=93、isError=false，与服务端及界面 session-5/execution=4 一致；原失败请求未重放。北京时间 17:15:51 完成删除重加的实际调用。

启动命令为现有 Node 执行该目录的 `run.mjs`；启动器仍运行，无最终退出码。本轮 SHA-256 核对、持久化查询和三语文档检查退出码 0；未重复运行此前已通过的自动测试。三语报告已更新，未提交、推送或重新打包；真实 Hex 服务端和安装版未验收。
