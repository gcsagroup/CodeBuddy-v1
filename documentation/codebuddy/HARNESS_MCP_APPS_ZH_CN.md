# Harness MCP 应用适配记录

日期：2026-10-14。源码：D:\CodeBuddy-v1 当前文件；该目录无 Git revision，本批未提交或推送。界面源码保持原样。

## 实现

- `runtime/harness/mcp-bridge.mjs` 每个会话的每个 MCP 服务只建立一个连接。复用官方 MCP SDK Client、Harness `createMcpToolDefinition`、`mcpResources.register`；Harness 继续拥有唯一模型循环、工具执行与审批。
- 宿主按执行 token 保留原始 MCP 工具回执。只有最终成功且 canonical 值、展示内容仍与原结果一致时，才向界面恢复 `content`、`structuredContent` 和 `_meta`；后置策略替换结果时不恢复原数据。工具 `_meta.ui.resourceUri` 转换为原界面的 `_meta.goose.mcpApp`。
- `resources/read` 返回 `{result: MCP ReadResourceResult}`，保留文本、blob、资源 `_meta`。范围由当前会话启用且已连接的服务确定；读取执行官方资源工具，独立审批，不插入模型历史，支持对话期间读取和取消。
- `runtime/mcp-apps.mjs` 提供原 ACP `apps/list/import/export/delete`。导入文件使用原 GooseApp JSON-LD 元数据格式；存储落在新版 profile 的 `state.mcpApps`。重名自动追加序号；远程缓存应用不可作为本地导入应用删除。导入/缓存有体积、数量和分页上限。
- HTTP 沙箱由 `runtime/mcp-app-proxy.mjs` 处理；具体来源隔离、认证和 TTL 见 `docs/reconstruction/2026-10-14-mcp-app-proxy.zh-CN.md`（以实际同目录文件名为准）。

## 验证与边界

本轮联合命令 `node --test runtime/tests/mcp-apps.test.mjs runtime/tests/mcp-apps-harness-integration.test.mjs runtime/harness/test/mcp-apps.test.mjs runtime/tests/builtin-extensions.test.mjs runtime/harness/test/capabilities.test.mjs`：30/30 通过，退出码 0。最后收紧后置策略的元数据恢复后，受影响的 driver 4 项与 ACP 1 项再次通过，退出码 0。

使用隔离临时 profile、真实本地 HTTP/stdio MCP、官方 Harness、本地受控模型响应、冻结 SDK Zod 和原界面适配器。覆盖单连接、审批拒绝、会话隔离、子代理继承、对话中读取、取消、stdio PID 退出、重连、导入导出删除、重启缓存，以及原界面消费结构化输出和应用资源标志。

真实 Electron 小应用操作、外部 MCP 服务、云端模型选择应用及 macOS 验收未包含在这些自动化结果内。冻结界面的初始聊天工具结果适配器只消费应用资源标志；应用自身后续 `tools/call` 的完整 `_meta` 已透传。后置策略改变结果及 MCP 错误结果保留 Harness 的最终错误/展示事实，不补造成功回执。

## 依据

- [MCP Apps 官方概述](https://modelcontextprotocol.io/extensions/apps/overview)：工具声明资源、资源策略、沙箱桥接。
- [官方 MCP Apps SDK 与规范](https://github.com/modelcontextprotocol/ext-apps)。
- 本地锁定的 DeepSeek Harness `0.2.1-alpha.2`：`dsh-mcp-client`、`dsh-mcp-resources`、`dsh-tools`，许可证 MIT。官方客户端桥在该版本省略 Apps 元数据，宿主适配补齐此缺口，未修改 vendored 包。
