# CodeBuddy 常用查詢工具設計方案

實施更新：首版已開發並完成 Windows 開發版問答驗收，詳見[實作與驗收記錄](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_ZH_TW.md)。以下保留最初提案及其當時狀態。

日期：2026-10-12。狀態：研究與設計提案，尚未實作、未宣稱驗收通過。
本機基準：main `c3a537517` 加現有未提交修改。本次只新增方案文件。

## 建議結論

沿用 CodeBuddy 的 goose 平台工具註冊、模型呼叫、權限與回執機制。首版內建時間、城市解析、天氣查詢；已有搜尋作補充。模型決定需要哪些資料，宿主驗證參數並取得真實結果。使用直接本機／HTTP 介面以減少部署步驟；需要擴充時才增加 MCP adapter，同一能力避免重複暴露。

## 公開方案比較

| 對象 | 已核實的公開設計 | 本案採用方式 |
| --- | --- | --- |
| Codex 開源 core | `clock.curr_time` 有 schema、UTC 回傳和宿主 time provider；同一工具組裝入口也接內建、動態工具與 MCP | 輕量時鐘工具；統一註冊與執行 |
| Claude API | 模型產生結構化 client tool 呼叫，應用執行並回傳結果；server tool 由 Anthropic 執行。官方以 get_weather 示範 | CodeBuddy 自己執行，適配可用模型，天氣資料由供應商 API 提供 |
| Hermes Agent | registry 登記 schema、handler、可用性檢查和 toolset；大量工具可選擇按需載入，但會增加首次呼叫往返 | 少量高頻工具直接提供；擴充工具沿用既有探索機制 |

上述是公開原始碼／API 設計，不代表已知 Claude 桌面內部實作或所有產品版本均提供相同工具。Hermes 文件中的 weather 是教學範例，不作為已出貨天氣工具的證明。

Codex 是 Apache-2.0；Hermes 是 MIT。參考模式，不搬入整套 runtime；若引用程式碼須保留適用聲明。專案目前 Apache-2.0。天氣 API 服務條款與資料授權另行確認。

## CodeBuddy 現況與主要缺口

- 已有 `platform_extensions/mod.rs`、`tool_registry.rs`、`extension_manager.rs`，可沿用 schema、ReadOnly 權限、網路屬性與回執。
- `agents/moim.rs` 已產生帶 UTC offset 的時間，但 `agent.rs` 的 conversation_only 路徑跳過該上下文，清空工具並要求直接回答。
- 因此只新增工具仍不足；需要讓一般聊天支援有限的常用唯讀查詢，同時保留使用者明確禁止工具時的語義。
- 不為查時間建立開發計畫、子 Agent、專案掃描或桌面操作。主 Agent 直接回答並視需要查詢。

## 首版工具與資料來源

| 能力 | 建議工具 | 執行位置／資料 |
| --- | --- | --- |
| 目前時間、日期、星期、指定時區 | `time_now(timezone?)` | 本機時鐘；回傳 UTC、當地時間、offset、時區來源 |
| 城市名稱、行政區與座標解析 | `location_resolve(query)` | 地理編碼 API；多個同名候選時提供選擇 |
| 當前天氣、溫度、體感、降雨及短期預報 | `weather_get(location?, query_kind, units?, days?)` | 指定天氣供應商；地點已確定可直接查一次 |
| 日期計算、溫度與常用單位換算 | 初期沿用現有計算能力；有錯誤證據再增結構化工具 | 確定性本機運算 |
| 新聞、營業時間等長尾問題 | 沿用既有搜尋 | 提供來源，尊重联网設定 |

時間上下文在每輪模型請求前刷新，置於動態上下文尾部，包含取樣時間與來源，避免每秒改動穩定 system prompt。恢復或壓縮後重新取得，不從舊摘要複用時間。需精確秒數或長任務中刷新時使用 time_now；若 runtime 在其他主機，時間應以桌面客戶端的時區為準。

## 地點的正確語義

使用者本輪指定城市優先。未指定時，使用已確認的預設查詢城市，回答註明城市；「預設查詢城市」不等於「人目前所在位置」。問目前所在位置時，使用獲授權的系統定位，或明確請使用者提供城市。系統時區不作為城市證據。

首版以手動選擇城市為預設。系統定位之後另做 Windows／Mac 權限與拒絕流程驗收。IP 定位只作可選的粗略候選，VPN／代理可能使其偏離；不得靜默稱為精確位置。不為普通問題持續取得或保存精確座標，地點偏好保存遵守現有記憶確認規則。

## 天氣供應商與成本

- Open-Meteo 適合隔離原型：官方免費端點限定非商業使用，無 uptime 保證；商業 API 需相應方案與 attribution。current conditions 基於 15 分鐘天氣模型資料，不描述成現場感測器讀值。服務程式碼 AGPLv3，資料 CC BY 4.0；本案只串 API，不導入服務程式碼。
- QWeather 提供城市解析與結構化當前天氣，可作正式供應商候選；需帳號憑據及按正式服務條款核對用途與額度。
- 建立一個小型 weather provider interface，首版只落地一個 adapter。正式選擇以中國／海外網路、城市覆蓋、商用條款、資料新鮮度的實測決定；不聲稱目前已驗證任何供應商更快或更準。

## 靈活呼叫與可靠回傳

少量查詢工具直接提供給支援 tool use 的主模型，不靠關鍵字表裁決自由文字。氣象／地點工具是唯讀但會連線，需沿用網路策略。明確「不要用工具」時不執行工具；時間上下文仍明示來源，禁止讀裝置資訊的要求也需尊重。模型不支援 tool use 時，顯示能力限制，不偷偷改走終端或桌面。

weather_get 可在地點唯一時由宿主完成地理解析，減少模型往返；有歧義回傳 needs_location。模型可平行查詢互不依賴的城市。供應商失效才按可用、已設定的備援查詢；搜尋所得資料標記為搜尋來源，不冒充 API 回執。

回傳至少包括 `status`、`location`、`location_source`、`timezone`、資料值與單位、`provider`、`fetched_at`、供應商若提供的 `valid_at/observed_at`、`cached`、`stale` 與來源連結。缺少供應商資料時間時保留 unknown，查詢時間不代替觀測時間。錯誤包括 needs_location、network_disabled、provider_unavailable、rate_limited、permission_denied；缺值不變成 0，也不猜天氣。

建議初始快取：天氣 5 分鐘、城市解析 24 小時；這是待測參數。快取依供應商、座標、單位、語言、查詢類型及日期區間分鍵，並遵守供應商條款。天氣若過期，刷新失敗時明示舊資料時間。時間不快取。設定總逾時及有限重試，429 按 Retry-After，不無限換供應商。

## 介面與实施切片

工具箱增加「常用查詢」，設定提供預設城市、單位、供應商、憑據和定位選項。憑據沿用現有安全儲存，模型與日誌不取得密鑰。聊天保持目前緊湊活動列，結果文字附城市、時間與來源；不另做大型面板。

1. 修補所有模式的時間上下文；加入可測試時鐘來源與 time_now。
2. 建立受限聊天查詢能力，接一個天氣供應商、城市解析與必要設定；沿用現有權限及註冊，避免複製 Agent loop。
3. 完成 Windows／Mac 真實問答驗收，再依失敗證據增加定位或更多生活工具。

## 驗收門檻

- 自動化：跨午夜、時區／夏令時間、恢復與壓縮後刷新、同名城市、單位、缺值、逾時、429、斷網、快取過期、禁止工具／定位。
- 真實產品：新聊天／舊聊天／任務中／重啟後問時間；指定城市及未設定地點問天氣；多城市比較；錯誤城市候選；服務失效；更改城市與單位；明確禁止工具。
- Windows 和 Mac 分別執行；記錄使用模型、原始呼叫、供應商來源、結果時間與耗時。至少以一個可用主模型驗證工具呼叫，其他模型單獨報告相容性。
- 當前溫度不能只和另一個網站數字逐字比對；須核對城市、資料時間、單位、供應商與資料類型。
- 先量測端到端延遲與模型往返數，再決定快取、並行和額外工具；本方案不承諾未量測的秒數。

## 參考來源

- [Codex 時鐘工具原始碼](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/current_time.rs)
- [Codex 工具組裝原始碼](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs)
- [Claude 官方工具機制與天氣示例](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- [Hermes 新增工具](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-tools)
- [Hermes 按需工具探索及其成本](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search)
- [Open-Meteo API 資料說明](https://open-meteo.com/en/docs)及[服務與授權條款](https://open-meteo.com/en/pricing)
- [QWeather 當前天氣](https://dev.qweather.com/en/docs/api/weather/weather-current/)及[城市解析](https://dev.qweather.com/en/docs/api/geoapi/city-lookup/)
- [Codex 授權](https://github.com/openai/codex/blob/main/LICENSE)、[Hermes 授權](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)
