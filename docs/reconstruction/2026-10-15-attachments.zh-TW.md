# 附件、識圖設定與執行前核准驗收（2026-10-15）

工作目錄D:\CodeBuddy-v1沒有.git，保留複製基線及未提交修改。本次僅變更前端適配與設定，Harness仍擁有執行、排程、完成和壓縮權威；未建立分支、提交、推送或安裝依賴，原使用者runtime20048未動。

## 修復與驗證

- 窄於480px的輸入框保留附件按鈕及可存取名稱，右側工作區開啟時仍可選取檔案。
- 新增識圖能力設定入口，復用既有model-capabilities介面。選擇已設定廠商與模型、明確宣告能力；保存前重新讀取以保留其他模型設定。模型發現不自動宣告能力，失敗保留選擇並可重試。簡繁英文完整，其他語言英文回退。
- 內聯及獨立核准共用ToolApprovalTarget，顯示Harness的file_path或bash command及舊欄位，不改權限判定。
- 最終前端6檔112/112、exit0；TypeScript、目標ESLint、i18n提取/編譯/一致性exit0。窄版先紅1失敗/23通過、核准先紅2失敗/28通過。測試模型name、lint型別及其他語言缺鍵初次失敗已修正，記錄保留。環境未變更；後端未改，復用05:26的360/360及Rust證據。

真實Electron+Kimi會話fb0759a6-7952-4c8f-b340-498e62785dbe，設定主模型圖像能力後正確辨識PIC-C384A761、紅圓/藍方、17+29=46。原生檔案視窗window:19552:235539488由真實Kimi經Harness/qwen_computer完成5次限定動作，end_turn/exit0；中文路徑進入輸入框，核准一次read後讀得DOC-25e04136ca3f與總額9443分。後續數量7改9、商品九折四捨五入、運費不打折得到10872分；頁面重載後仍記得兩個標記、數量和約束。四輪均Harness completed/harness_turn，僅一次讀取；兩份12412位元組JPEG保留在歷史。

第五輪在執行前看見完整路徑後拒絕，原生回執isError=true、Tool execution was declined，模型結束且未重試。證據在foundations-ui-receipt.json.attachments、attachment-*.png、native-export-probe-VtqnEf/receipt.json及native-attachment-real.log。Playwright合成檔案沒有Electron磁碟路徑，已另以原生選擇器驗證，未視為產品故障。

## 界限

能力宣告只留在隔離profile；輔助視覺仍未設定，本輪不重報先前降級證據。檔案走本機路徑及核准read，未證明上傳副本回執；四輪測試不取代既有十二模組與多次壓縮驗收。拒絕彙總誤報已修復：只有真實工具回執全部成功才使用完成標籤，拒絕/失敗/缺回執顯示中性記錄。先紅2失敗/37通過，真實重載後彙總和單項正確；Harness判定不變。macOS、安裝包、複雜配方及其餘矩陣缺口未宣稱通過。

目前是runtime7580/exec69369、CDP9395的開發預覽，Vite載入本次前端；來源指紋overnight-source-attachments.json，非安裝包。
