# MCP 按需載入與 Gemma 思考驗收（2026-10-15）

候選 1.43.3-harness8；基線 main / 01610d0 加本批未提交修改。

Harness 0.2.1-alpha.2 沒有現成通用 tool_search 插件。本次透過官方 system-prompt/assemble 擴充點裁剪模型可見的 MCP schema；search_mcp_tools 每次最多載入 5 個，會話最多保留 16 個。工具箱、權限、執行和壓縮仍使用官方機制，HTTP 連線沿用既有預設復用，stdio 保留會話隔離。重啟恢復已選工具，舊版全目錄不會被誤恢復；無 MCP 的唯讀觀察者不新增搜尋工具。

容量依服務模型資料，Gemma LAN 實際 65536；缺少容量資料的服務仍保守採 32768，不是模型理論上限。系統說明與工具定義也佔上下文。Gemma 改用官方 pi-ai chat-template 參數 enable_thinking：none 關閉，其餘開啟，不宣稱不同檔位有不同強度。針對模型在普通對話自行重複查看空目錄的現象，加上通用工具使用約束，沒有關鍵詞分流或自行判定完成。

369 項自動回歸初輪 367 通過；新 Gemma 夾具缺少無驗證設定及既有 Git 請求計數斷言已修正，相關 5 項復測全部通過，exit 0。包含 200 個工具、權限拒絕、連線復用、重啟和原生多次壓縮。日誌 discovery-full-tests2.log、discovery-repaired-tests.log。

真實服務隔離驗證：Gemma 首次/熱新會話建立 8/9ms，首個思考 11.1/2.1s，正文 14.2/14.6s，輸入各 9896 token；Kimi 雲端正文 7.5s、輸入 9302。皆 end_turn；問候不再呼叫工具。首輪 43 個基礎工具，0 個 MCP 完整 schema。Gemma 搜尋並實際呼叫時間工具完成；數字是單次樣本，不是延遲保證。證據 .preview-evidence/discovery-real-nQL0Zr/receipt.json。

安裝包構建與真實介面結果完成後追加；源碼驗證不替代安裝驗證。

## 安裝版結果

build-harness-windows.cjs 及安裝程序 --silent 均 exit 0。包內 Node、原生子程序和服務啟動通過，安裝後 EXE、app.asar、Harness 清單及修改的執行檔與本次來源一致。安裝包 target/accepted-harness-installer-1.43.3-harness8/CodeBuddy-Harness-Setup.exe，325128192 bytes；SHA256 FD45E62AF22FD10324CB589D85E3B5258655ACA45A12D9F8FF2969EF136F5CB7。

真實介面兩次問候：會話 1001/956ms 出現，思考首片段 6.10/2.85s，正文 10.39/8.49s，均 end_turn，顯示 10k / 66k。計算問題的可見思考區 616ms 開始，30 次不同長度，思考完成可展開。MCP 搜尋和時間工具實際執行成功，原生首輪 0 個 MCP schema、搜尋後 5 個，沒有工具錯誤。介面切到 Kimi 後仍記得計算結果 391，7.1s 完成，顯示 13k / 33k。

證據 .preview-evidence/harness8-ui-*.json、harness8-installed-native.json、harness8-installed-identity.json。首次測試資料缺少 version、腳本曾選到隱藏舊節點，均修正夾具後驗收，不當作產品缺陷。Windows 候選未重跑小時級大專案或 macOS；推理與網路耗時仍在。此批尚未提交或推送。
