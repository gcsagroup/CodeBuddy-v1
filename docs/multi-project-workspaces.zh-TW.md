# 多專案工作區

建立對話時可用置中視窗加入多個本機資料夾。首項預設為主要目錄，建立前可切換；名稱可自訂。關聯目錄可填寫說明並設定允許修改或僅供參考。移除關聯不刪除檔案。

側欄懸浮卡顯示全部目錄、主要與唯讀標記，並提供編輯入口。修改適用於新對話；既有對話保留目錄快照。主要目錄是現有專案身分，儲存後不由編輯器遷移磁碟目錄。

`WorkspaceService` 擁有目錄成員、版本及實體目錄身分；Compat 儲存 `projectFoldersSnapshot`。檔案工具及終端共用此設定，子任務透過驗證的原生父子關係繼承。參考目錄存在時禁止完整存取，工具核准不能繞過。失效目錄明確報錯。

Windows 沿用鎖定 Harness 的 ACL、受限權杖、Job 與控制管線，目錄組合使用獨立 capability SID。保留原生 partial enforcement 限制，不宣稱網路或外部 MCP 完整隔離。macOS Seatbelt 與 Bubblewrap 表達額外目錄權限；無法表達策略的 runner 拒絕啟動，不降級為無沙箱。

參考 [Codex Projects](https://learn.chatgpt.com/docs/projects) 與 [Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/shared_options.rs) 的公開設計，未複製實作或新增依賴。自動回歸涵蓋工作區快照、原生寫入與拒絕、建立彈窗、懸浮卡與權限選單；各平台桌面及模型驗收須另外執行。
