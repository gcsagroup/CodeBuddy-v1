# MCP 應用代理與隔離來源

`runtime/mcp-app-proxy.mjs` 複用舊 `crates/goose/src/acp/templates/mcp_app_proxy.html`。安裝包使用 `runtime/assets/mcp-app-proxy.html` 的逐字副本，測試核對兩者相同；原 renderer 與訊息協議未改。舊模板遵循本儲存庫 Apache-2.0 授權。MCP Apps 官方方案同樣由宿主提供沙盒 iframe，並透過 postMessage 交換協議訊息。[官方概覽](https://modelcontextprotocol.io/extensions/apps/overview)

主整合建立 `await createMcpAppProxy({secret})`，在普通 HTTP header 認證之前，依 `proxy.handles(req)` 分派 `await proxy.handle(req,res)`；該模組獨立執行認證與 loopback 檢查。服務關閉時呼叫 `await proxy.close()`。

| 路由 | 認證與行為 |
|---|---|
| 主來源 GET `/mcp-app-proxy?secret=...` | 驗證隨機後端 secret，回傳原代理模板與正規化 CSP |
| 主來源 POST `/mcp-app-guest` | JSON body 內 secret，接收 HTML 與 CSP，回傳 `{nonce,guestUrl}` |
| 獨立 loopback 來源 GET `/mcp-app-guest?nonce=...` | 僅讀取隨機 nonce 對應的暫存 HTML；沒有主後端、設定、工具呼叫或寫入路由 |

guest 來源與宿主代理來源使用不同連接埠，HTML 中不注入後端 secret。原模板使用 `sandbox="allow-scripts allow-same-origin allow-forms"` 並檢查 postMessage 的實際視窗來源。工具呼叫與資源讀取仍經既有宿主權限路徑；此 HTTP 模組沒有審批或執行工具的能力。

CSP 網域參數沿用原支援範圍：HTTP(S)/WS(S) 來源、DNS/萬用子網域、localhost 與 IP，可選連接埠；移除路徑並拒絕策略分隔符、認證使用者資訊、萬用全域與非法協議。代理與 guest 回應均停用快取。Guest 內容的 CSP header 拒絕換行；預設使用受限策略。

暫存儲存維持原 300 秒 TTL、64 條、單請求 16 MiB 上限，新增總內容 64 MiB 上限。數量或總預算用盡時淘汰最舊項；清除過期項，服務 close 清空記憶體並釋放 guest listener。僅暫存記憶體，沒有使用者檔案寫入或 HTML 落盤。

驗證：`runtime` 內 `node --test tests/mcp-app-proxy.test.mjs`，4/4，退出碼 0。真實兩個 loopback HTTP 來源涵蓋原模板、認證、獨立唯讀端點、CSP、真實 chunked 超限、TTL、數量/總位元組淘汰與關閉連接埠。與編輯基礎及真實 ACP 編輯聯跑 10/10。HTTP 測試不等於瀏覽器沙盒或真實第三方應用互動驗收；這些由主整合在原桌面繼續驗證。
