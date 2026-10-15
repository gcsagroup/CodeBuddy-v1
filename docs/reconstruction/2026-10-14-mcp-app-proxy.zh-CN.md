# MCP 应用代理与隔离来源

`runtime/mcp-app-proxy.mjs` 复用旧 `crates/goose/src/acp/templates/mcp_app_proxy.html`。安装包使用 `runtime/assets/mcp-app-proxy.html` 的逐字副本，测试核对两者相同；原 renderer 和消息协议未改。旧模板遵循本仓库 Apache-2.0 许可证。MCP Apps 官方方案同样由宿主提供沙盒 iframe，并通过 postMessage 交换协议消息。[官方概览](https://modelcontextprotocol.io/extensions/apps/overview)

主集成创建 `await createMcpAppProxy({secret})`，在普通 HTTP header 认证之前，按 `proxy.handles(req)` 分派 `await proxy.handle(req,res)`；该模块独立执行认证和 loopback 检查。服务关闭时调用 `await proxy.close()`。

| 路由 | 认证与行为 |
|---|---|
| 主来源 GET `/mcp-app-proxy?secret=...` | 验证随机后端 secret，返回原代理模板与规范化 CSP |
| 主来源 POST `/mcp-app-guest` | JSON body 内 secret，接收 HTML 与 CSP，返回 `{nonce,guestUrl}` |
| 独立 loopback 来源 GET `/mcp-app-guest?nonce=...` | 只读取随机 nonce 对应的临时 HTML；没有主后端、配置、工具调用或写入路由 |

guest 来源与宿主代理来源使用不同端口，HTML 中不注入后端 secret。原模板使用 `sandbox="allow-scripts allow-same-origin allow-forms"` 并检查 postMessage 的实际窗口来源。工具调用和资源读取仍经现有宿主权限路径；此 HTTP 模块没有审批或执行工具的能力。

CSP 域参数沿用原支持范围：HTTP(S)/WS(S) 来源、DNS/通配子域、localhost 和 IP，可选端口；移除路径并拒绝策略分隔符、认证用户信息、通配全域和非法协议。代理响应和 guest 响应均禁用缓存。Guest 内容的 CSP header 拒绝换行；缺省使用受限策略。

临时存储保持原 300 秒 TTL、64 条、单请求 16 MiB 上限，新增总内容 64 MiB 上限。数量或总预算用尽时淘汰最旧项；过期项清理，服务 close 清空内存并释放 guest listener。仅临时内存，无用户文件写入或 HTML 落盘。

验证：`runtime` 内 `node --test tests/mcp-app-proxy.test.mjs`，4/4，退出码 0。真实两个 loopback HTTP 来源覆盖原模板、认证、独立只读端点、CSP、真实 chunked 超限、TTL、数量/总字节淘汰及关闭端口。与编辑基础和真实 ACP 编辑联跑 10/10。没有把 HTTP 测试当作浏览器沙盒或真实第三方应用交互验收；这些由主集成在原桌面继续验证。
