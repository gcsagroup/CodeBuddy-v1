# macOS 開發與驗證（預設版本）

## Mac 唯讀審核與取消（stage28，2026-10-07）

已依使用者批准的方案接通 audit/cancel。Mac 回傳 executionAvailable=false，只顯示摘要與取消；Windows 為 true，舊回應保持相容。既有 root/session/run/sourceMessage/nonce 與生命週期仍為權限依據。回執只在記憶體保存；提交／取消／撤銷採同一鎖順序。取消不延長原有效期，過期後提示新請求並停用舊提示的重試。

Windows Rust 85/85、原生 Mac Rust 35/35、兩端前端各 17/17 通過。兩端 Clippy、TypeScript、相關 ESLint 與格式檢查退出 0；Mac 保留既有平台告警。真實 Chrome 的正式元件通過摘要／取消／過期互動，選取視窗與 ACP 為隔離替身。截圖兩次逾時，不算產品失敗；原生回歸使用真實暫存檔案。

bundle28 已重建後端並通過 DMG 校驗、掛載／複製／卸載、簽章及雜湊檢查。安裝後 ACP 11/11，模型呼叫 0；包含缺權限 audit/cancel 拒絕與五個只讀限制入口。成功審核由原生回歸覆蓋，完整 Electron 正向流程尚未驗收。

其餘五個清理入口仍停用，另待 Mac 可見完整流程、Intel／最低 macOS 實機及 Developer ID 公證。本包是 ARM64 ad-hoc 內部測試版。沒有新增分支、提交或推送。舊階段保留當時狀態，目前以本節和功能表為準。

Local: `target/macos-release-20261007-bundle28/`

Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261007-bundle28/`

Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261007-bundle28/CodeBuddy.app`

- CodeBuddy.zip: SHA-256 `4be0986bd58408b0fc85891dcab3bfac01486023a8e79979ac7ede2cd76d273d`
- CodeBuddy-arm64.dmg: SHA-256 `b0257855e26ae08ef822699c681c08278ca262d54acd5c5221f3c754c44778a2`

Source: `00a6656df` + dirty. Build manifest: `0b148acbead0021a0d803c5121cfc4fca1f306e9343d111d04565cb0f6d40ec5`. Evidence: `target/macos-parity-20261007/cleanup28-state.json`; commands: `cleanup28-commands.json`.

[Details](MACOS_PARITY_ZH_TW.md)

## 工作任務強制停止接線（stage25）

使用者在具體方案後回覆「繼續」，批准既有 owner 接線。PID 與 `SessionProcessOwner` 在 `WorkerRegistry` 同一鎖內註冊；tracker 與 lifecycle 消費同一引用。OS 操作仍由 `SystemProcessGroupOwner` 負責。強制停止取快照時關閉新註冊；終止、runner 取消與退出確認在鎖外執行。已確認退出的紀錄逐筆移除；未確認的紀錄保留供重試，避免 runner drop 後再次停止時誤報完成；過期 generation 與衝突 owner 被拒絕。

Windows 本輪 18/18、Mac 本輪 19/19 通過；兩端 Clippy 退出碼為 0。bundle25 已重新建置後端，包含 stage24 的 shell 取消／逾時與埠歸屬修復，以及 stage25 的強制停止接線。DMG 掛載／複製／卸載、簽章、安裝副本雜湊與 ACP 啟動交握 4 項通過（模型呼叫 0）。這是 arm64 ad-hoc 內部測試包，尚未公證。

Local: `target/macos-release-20261005-bundle25/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle25/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle25/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `9aa02168c6fb4260a480074e5e724e7d6c464e424b0db9bd8669085e536bf1bd`
- CodeBuddy-arm64.dmg: SHA-256 `1c1aa6357374559eb695e379ecdde5a9057dfcd35deacb2555a78a20cfaefccc`

新增覆蓋 owner 失敗與重試、協作取消期間註冊、舊 generation，以及 Mac 真實後代退出／父程序先退出／無關程序存活。完整 Electron 流程維持 NOT_RUN。清理寫入、桌面驗收調度、TCC／Keychain 和 Intel 驗收仍有缺口，不能據此宣稱完整對齊。


[简体中文](MACOS_ZH_CN.md) · [English](MACOS_EN.md)

## 階段 24：依 Windows 入口核對並修復兩項差異（2026-10-05）

以本機 Windows 現有 main + dirty 工作目錄為基準重新追蹤實際入口。完整對照及後續方案見 [功能清單](MACOS_PARITY_ZH_TW.md)。

- Mac 前台 shell 現使用既有程序群組 owner；取消／逾時等待同組後代退出。Windows 回歸 **16/16**，原生 Mac shell 回歸 **24/24**，其中新增兩項實際後代程序測試同時確認無關兄弟程序仍存活、輸出管線關閉及結構化回執。
- Mac 背景服務現透過系統 lsof + 既有 owner 判定監聽埠歸屬。原生測試 **2/2**，另 1 個子程序 fixture 標記 ignored，不计入通過數。實際臨時 TCP 監聽驗證所屬／非所屬群組及停止後狀態；異常輸出保留未知，查詢並非業務就緒證明。
- 最終 Windows 嚴格 Clippy 與 Mac Clippy 均退出 0；Mac 最終保留 6 條現有平台告警。fmt 和 diff 空白檢查通過。原生探測曾發現 lsof 自動附帶 f 記錄，已按實測協議修復後通過正式測試；一次 Windows Clippy 誤與 Mac 重疊啟動後已中斷、保留記錄並串行重跑。

**全功能一致仍未完成。** 工作任務強制停止 owner 接線方案待批准；Mac 桌面驗收調度仍固定關閉；清理隔離／恢復／永久刪除及可見 Electron 流程仍待完成。未重新觸發已暫緩的 Keychain／TCC 認證。

本輪兩項源码修改尚未打包；最新已交付仍為 bundle23，並不包含上述修復。沒有建立分支、提交或推送。指令、工作目錄、退出碼、測試計數及來源雜湊見 `target/macos-parity-20261005/parity24-state.json`。

## 階段 23：擴充功能命令參數修復（2026-10-05）

修復 Mac/POSIX 編輯擴充功能設定時，啟動命令與參數遭改寫的問題。原先僅為空格加上引號，會遺失空參數、解讀美元符號／引號／反斜線，或拆開定位字元與換行參數。現在依既有解析器保護字面參數，保留簡單命令的顯示格式；Windows 原路徑處理持續通過回歸。沒有新增依賴、協定或設定格式。

- 修復前：新增回歸 4 項失敗、其餘 39 項通過。最終 Windows 與真實 arm64 Mac 的轉換／正式編輯對話框測試各 **57/57**，兩端 TypeScript 退出 0。
- 真實 Chrome 正式編輯對話框：修改說明→儲存→重新開啟→取消，命令與六個參數維持一致。儲存及 ACP 設定使用隔離替身，未修改使用者擴充功能。主控台錯誤 0；既有 DialogContent 描述缺少警告出現 2 次。
- 真實 Mac 原生子行程 **2/2**：包含中文、單引號、美元符號及反斜線的執行檔／指令稿路徑正常啟動，子行程實際收到完整空參數、引號、萬用字元、定位字元與換行位元組。此項不等同真實 MCP 擴充功能或完整 Electron 驗收。
- 初次引用函式與目前解析器的萬用字元往返不符、測試替身屬性與逾時值不完整、測試查詢型別錯誤均已修正，保留失敗日誌。最終驗證皆通過。

bundle23 已產生並通過 DMG 實際掛載／複製／卸載、簽章、安裝副本雜湊與 ACP 啟動交握檢查（4 項，模型呼叫 0）。目前後端由原始碼重新建置；完整 Electron 驗收仍為 NOT_RUN。此包為 arm64 ad-hoc 內部測試版，尚未公證。

Local: `target/macos-release-20261005-bundle23/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle23/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle23/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `542b79a2cdfc0e852d9b9ebfe13854acf71b7651430d6077f7ca64a74ff04233`
- CodeBuddy-arm64.dmg: SHA-256 `14356dc2d423613de3c7402f2e638681741204e94a4bd3077429959d4dd326d3`

全功能一致尚未完成：清理隔離／還原／永久刪除、完整 Electron／鑰匙圈及 TCC、Intel 與最低系統實機仍待完成。來源為 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加既有合併及 dirty 修改，未建立分支、提交或推送。

修改：`ui/desktop/src/components/settings/extensions/utils.ts`、同目錄 `utils.test.ts`、`modal/ExtensionModal.test.tsx`。命令、工作目錄、退出碼與證據：`target/macos-parity-20261005/extension23-state.json`。

## 最新開發：2026-10-05 階段 22（尚未打包）

持續補齊 Mac 清理功能：抽取 Windows 既有白名單、專案邊界與摘要結構；新增 Mac 內部唯讀檢查，涵蓋一般檔案／空目錄、內容雜湊、連結拒絕、檔案／父目錄替換、專案重疊及讀取權限錯誤。具體檔案與後續門檻見 [清理適配設計](MACOS_CLEANUP_DESIGN_ZH_TW.md)。

- Windows 相關 Rust 回歸 **72/72**；真實 arm64 Mac 原生回歸 **22/22**，其中新增清理檢查 **8 項**。均退出 0。
- Windows 嚴格 Clippy、Mac release Clippy 與 Mac fmt 均退出 0；Mac Clippy 的 7 條警告位於本輪未修改的 shell／state store／process tree／secure_fs 模組。
- 既有 UI／ACP 隔離基線 **9/9**；並非 Mac 產品清理驗收。初次 Mac 測試誤用 debug，已中斷並恢復原 release 設定；保留中斷記錄，不計為測試結果。沒有新增依賴或清除快取。
- 唯讀模組尚未連接 Mac 清理 RPC／UI。隔離、還原、永久刪除仍待開發，完整 Electron／權限與鑰匙圈流程、Intel 及最低系統驗收仍為 NOT_RUN。全功能一致尚未完成。
- 路徑替換實驗已確認一般 rename 可移動替換檔案；FSRef 的有限實驗尚未證明精確物件安全合同。下一步先解決原生物件操作方案，再接入清理寫入及持久還原。目前不放寬合同。

本輪沒有新安裝包，最新已交付包仍為下方 bundle21。來源為 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加既有待提交合併及 dirty 修改，未建立分支、提交或推送。命令、工作目錄、退出碼、原始碼雜湊及未完成項目見 `target/macos-parity-20261005/cleanup22-state.json`。

## 歷史交付：2026-10-05 bundle21（Apple Silicon 內部測試版）

修正電腦控制 `set_value` 的 Mac 差異：Go 省略空文字欄位時，原生層現按空字串處理，支援清空文字控件。數值控件仍要求有限數字，空值不轉成零；沿用既有視窗／元素綁定、可寫屬性檢查與 TCC 門檻。

- 本機封裝／開發入口回歸 **27/27**，退出 0。
- 真實 arm64 Mac 原生 Go／Swift helper 編譯、既有合同及新增 **11 項** set_value 合同檢查通過，退出 0。Go 測試使用有效快取。新增檢查涵蓋省略／顯式空文字、中文與 emoji／空白、數值／零及非法數值拒絕。
- DMG／ZIP 封裝、實際掛載／複製到獨立安裝目錄／卸載、簽名與安裝後端／helper 雜湊檢查通過；新 Swift helper 與 bundle20 不同，安裝副本 app.asar 與封裝輸出一致。本機與遠端交付檔案大小及 SHA-256 一致。
- 復用 bundle18 的已驗證後端；本輪未變更 Rust 或前端，不重複計算既有 ACP／UI 證據。既有 macOS 14 activation 棄用警告仍在，未影響編譯。
- 先前原始碼上傳被自動審批攔截；使用者在明確主機、目錄與三個檔案的問題後回覆「繼續」，已據此完成上傳。

**真實文字控件清空與完整 Electron 驗收仍為 NOT_RUN。** 安裝 helper 的唯讀 doctor 在 SSH 上下文回報 Accessibility=false、ScreenRecording=false，這不代表 Electron 啟動後的權限狀態。未啟動新版 Electron，保留使用者延後的鑰匙圈認證現場。清理隔離／復原／永久刪除、完整桌面流程、Intel 與最低支援系統實機仍待完成，全功能一致尚未達成。此包為 ad-hoc 內部測試版，未公證。

Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` + existing pending merge and dirty changes; 3,251 build-source entries verified. No branch, commit or push created. UI 1.43.2 / backend 1.43.0. Commands, cwd, exits and logs: `evidence/commands.json`.

Local: `target/macos-release-20261005-bundle21/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261005-bundle21/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261005-bundle21/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `26aca3ac3c406c50784afbec290f159113ead598ed3c88f3fe63a515c9f654b4`
- CodeBuddy-arm64.dmg: SHA-256 `b1902fa408316c403489d81ba5b27f1a914edeca9997896046ba6f6179b59900`

## 歷史交付：2026-10-04 bundle20（Apple Silicon 內部測試候選版）

修復 Mac 快速鍵錄製將 Control 誤存為 Command，以及同按 Control／Command 時遺失 Control 的問題。ShortcutRecorder 現分別記錄兩個修飾鍵，保留既有設定格式與 Windows 行為；避免錄製 Control 組合時誤判與 Command 組合衝突。

- 修復前 **5 失敗／5 通過**；修復後 Windows 與真實 Mac 執行相關元件測試各 **29/29**，兩端 TypeScript 退出 0。新回歸涵蓋獨立／組合修飾鍵、Option 字元、Windows 行為、取消，以及正式設定頁儲存後保留其他快速鍵。首次型別檢查發現新測試查詢參數不受支援，修正後重跑通過，原失敗日誌保留。
- 真實 Chrome 按鍵互動通過：Control+K、Control+Command+K 分別儲存，原 Command+K 保持啟用；真正 Command 衝突仍提示，取消重新指派與取消編輯均保留設定。控制台錯誤／警告 0。此驗收使用正式設定頁、Mac 平台標記及隔離設定／對話框替身，**不代表原生 Mac 全域快速鍵觸發通過**。
- 新 DMG／ZIP 已放到本機及遠端桌面。實際 DMG 驗證、掛載／複製／卸載、安裝副本簽名、後端版本、app.asar 一致性與套件 SHA-256 核驗通過。
- 本輪只修改前端並新增測試；復用 bundle18 已驗證後端，原始與簽名後雜湊一致。Rust／模型 ACP 不重跑、不計入本輪測試數。既有設定不自動遷移；先前誤存的組合須重新錄製。

依據：[Electron 官方快速鍵文件](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts)，CommandOrControl 在 Mac 對應 Command，Control 是獨立修飾鍵。

**全功能一致尚未完成。** 延後的鑰匙圈認證、完整可見 Electron／系統快速鍵驗收、清理隔離／復原／永久刪除、電腦控制權限、Intel 與最低支援系統實機仍待完成。此 arm64 包為 ad-hoc 內部測試版，未公證。

Source: main 00a6656df0c4ba0563b4cf03e560cb81a46b0f53 + pending merge and dirty changes; 3,251 entries verified. No branch, commit or push created. UI 1.43.2 / backend 1.43.0. Commands/cwd/exits/logs: evidence/commands.json.

Local: target/macos-release-20261004-bundle20/. Remote: /Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle20/. Installed: /Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle20/CodeBuddy.app.

- CodeBuddy.zip: SHA-256 2aacb636df7d57cfcf95c67c00408cafa25cc3d7ae141ad9c1cc84d0885d76d5
- CodeBuddy-arm64.dmg: SHA-256 0bb3f9341124b4c91f11ed1523ae682cf429630d3ed4e0510bdb8b24ff76fb87

## 歷史交付：2026-10-04 bundle19（Apple Silicon 內部測試候選版）

修復 Mac 舊會話重新確認工作區時，正確目錄仍被判定為不相符的問題。CodeProWorkspaceReconfirmation 原本把所有路徑轉成 Windows 反斜線並小寫；現復用既有 normalizeWorkspaceIdentity，與檔案檢查器一致。保留 POSIX 大小寫、中文、空格及括號；不同身份或不存在的目錄仍拒絕，確認前不觸發回呼。

- 修復前：2 個 Mac 回歸案例失敗、6 個通過。修復後 Windows 相關測試 **102/102**、最終元件 **8/8**；Mac **99 通過、3 個 Windows 專屬案例跳過**。兩端 TypeScript 退出 0。
- 真實 Mac 暫存目錄手動 API 驗證 **5/5**：原生規範路徑、現有目錄確認、大小寫身份不符拒絕、缺失目錄檢查零建立及既有檔案不變。元件測試亦直接呼叫正式檔案檢查器。
- 真實 Chrome 受控互動通過：顯示原路徑、明確確認、不符／移除拒絕、重試與取消；控制台錯誤／警告 0。使用真實 Mac 檢查結果、正式元件與測試回呼，未執行完整 ACP／Electron 流程。
- DMG／ZIP 已產生並複製到本機與遠端桌面。實際 DMG 驗證／掛載／安裝／卸載、簽名、安裝後端版本與 app.asar 雜湊一致性通過。
- 本輪僅改前端，復用 bundle18 後端且原始／簽名後雜湊一致。未重跑 Rust 或前階段 17 項模型 ACP，不將其計入本輪數字。

**全功能一致尚未完成。** 延後的鑰匙圈認證及可見 Electron 驗收仍未執行；清理隔離／復原／永久刪除、電腦控制權限、Intel 與最低支援系統實機仍待開發或驗收。此 arm64 包採 ad-hoc 簽名，未做 Developer ID 公證。

Source: main 00a6656df0c4ba0563b4cf03e560cb81a46b0f53 + pending merge and dirty changes; 3,250 entries verified. No branch, commit or push created. UI 1.43.2 / backend 1.43.0. Commands/cwd/exits/logs: evidence/commands.json.

Local: target/macos-release-20261004-bundle19/. Remote: /Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle19/. Installed: /Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle19/CodeBuddy.app.

- CodeBuddy.zip: SHA-256 70ffd920a8a2238f20380a0e24aa3ba6eaee564c49dc87f5c0fb75038b93dad1
- CodeBuddy-arm64.dmg: SHA-256 22b30331f300f8cf50a1257a30f6a5f817570e9ab90dbba01d4846f769305228

## 歷史交付：2026-10-04 bundle18（Apple Silicon 內部測試候選版）

新增「重新取得專案確認」入口與已批准的 ACP 方法 `_goose/unstable/workspace/confirmation/v1/refresh`。雙方協商 `workspaceConfirmationRefresh: 1`；宿主驗證原 session／run／來源訊息、持久控制面與等待工作區通知，只刷新確認。重複刷新復用有效令牌；已分配租約、已綁定、關閉／封存、終態或身份不符均拒絕。刷新不呼叫模型、不建立目錄、不綁定租約、不執行任務；使用者仍須明確確認路徑，再沿既有結構化續行恢復原任務。補齊確認卡片繁體／簡體文案。

- Windows Rust **114/114**、嚴格 Clippy 退出 0；Mac 原生 Rust **39/39**、Clippy 退出 0。兩端元件測試各 **43/43**，TypeScript 退出 0。
- 真實 Chrome 受控元件流程通過：過期錯誤→刷新→等待再次確認→新令牌建立／綁定／原任務續行；舊後端只顯示升級提示。目錄選擇與 ACP 傳輸為測試替身，非 Mac 桌面 E2E；修正夾具圖示 404 後控制台無錯誤／警告。
- 新 Release 及實際 DMG 安裝副本後端各通過真實 ACP **17/17**，涵蓋重啟後用新方法刷新、原 run／訊息身份、併發冪等、刷新零專案寫入、偽造身份／已綁定拒絕、原權限拒絕重試、準確子目錄、模型實際寫檔及重啟恢復。
- DMG／ZIP 已產生，DMG 驗證／掛載／複製／卸載、安裝副本簽名與雜湊驗證通過。**未啟動新版 Electron；使用者延後的鑰匙圈認證與完整可見桌面驗收仍待完成。**

全功能一致尚未完成：清理隔離／復原／永久刪除、電腦控制權限、Intel 與最低支援系統實機仍待開發或驗收。此 arm64 包採 ad-hoc 簽名，未做 Developer ID 公證。

Source: main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` + pending merge and dirty changes; 3,250 source entries verified. No branch/commit/push created. UI 1.43.2 / backend 1.43.0. Commands/cwd/exits/logs: `evidence/commands.json`.

Local: `target/macos-release-20261004-bundle18/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle18/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle18/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `c0df12aa750de29c7f35184ae6fada3183e072b0c3ad57cddfdfafd29c319dfe`
- CodeBuddy-arm64.dmg: SHA-256 `9dc13110a59716dc14fccf610020818048a6e41ad249c157b2c61ab0e22c9512`

## 歷史交付：2026-10-04 bundle17（Apple Silicon 內部測試候選版）

修正 Mac 建立專案遭目錄權限拒絕後，恢復權限仍因令牌已消耗而重試失敗的問題。僅在確認尚未建立目錄時，回傳既有 `workspace_permission_denied / retryable / capabilityPreserved` 合同並保留原確認；建立後的異常仍回滾並消耗令牌。ACP 宿主繼續持有權限與生命週期判定，前端復用原確認卡片。

- 真實 Mac 修復前復現：測試目錄設為唯讀，建立回傳 `OSErr -5000`；恢復權限後，同一確認遭拒為令牌已消耗。證據 `evidence/baseline-permission-error.json`。
- Windows Rust **112/112**、嚴格 Clippy（`-D warnings`）退出 0；Mac 原生 Rust **37/37**、Clippy 退出 0。兩端相關前端各 **39/39**，TypeScript 退出 0。新增回歸覆蓋讀／寫拒絕、偽造令牌、原確認重試、建立後失敗回滾及前端只在建立成功後續行。首次前端回歸使用缺少訊息身份的夾具，修正後通過，原失敗日誌保留。
- 新 Release 真實 ACP **12/12**：讀／寫權限拒絕與原確認重試、準確子目錄、父目錄受限、冪等、空目錄回滾、綁定前重啟拒絕舊令牌、以既有結構化續行請求取得新確認且保持原 run／訊息、同會話綁定、模型以原控制請求實際寫檔、已綁定重啟，以及刪除會話保留檔案。證據 `evidence/project-container-permission-acp-result.json`。
- bundle16 舊驗收腳本本輪的 10 個目錄流程斷言通過，但後續身份稽核發現重發自然語言請求後 run 已變更；該結果**不算原 run 恢復通過**。新腳本已補原 run／訊息身份斷言，使用既有結構化續行協議；可見 UI 的過期卡片重新取得確認入口仍待完善與驗收。原失敗的已解析模型日誌只有思考內容、最終正文為空，另一次超時；當時未保存原始 HTTP 流，根因尚未固定。本輪原始接口診斷已取得 JSON。未因此放寬解析、把思考當作決策或調高超時；歷史模型不穩定記錄保留。
- 安裝副本後端亦通過同一 ACP **12/12**（`evidence/installed-project-container-permission-acp-result.json`）。新後端建置、DMG／ZIP 封裝及實際 DMG 掛載／複製／卸載、安裝副本簽名及後端雜湊驗證均通過。**未啟動新版 Electron；使用者延後的鑰匙圈認證及完整可見桌面驗收仍待完成。**

來源：main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、既有合併及未提交修改；3,249 個來源項目核驗一致。未建立分支、提交或推送。UI 1.43.2／後端 1.43.0。命令、工作目錄、退出碼與日誌見 `evidence/commands.json`。

Backend SHA-256: `eeb898a355dc95f367834a0c811bb9bc1b52a34e72baef9bfd6d289f8283f02d`; packaged backend: `212bb77059800a308bd62a5783bd924f6f7011f67504bb809ce452bad91f347b`.

Local: `target/macos-release-20261004-bundle17/`. Remote: `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261004-bundle17/`. Installed: `/Users/erjinyi/Applications/CodeBuddy-Test-20261004-bundle17/CodeBuddy.app`.

- CodeBuddy.zip: SHA-256 `e2f7fbbb5ed64b2b7aa446724de1096483286589abc1beb3ca0ec85d568eb6ed`
- CodeBuddy-arm64.dmg: SHA-256 `29f6de32a30930bd8152a43e581c5011cd6c77e6bb29d4830edfef992c8d4cb9`

**全功能一致仍未完成**：清理隔離／復原／永久刪除、完整桌面流程、電腦控制權限、Intel 與最低支援系統實機仍待開發或驗收。此包為 arm64 ad-hoc 內部測試版，未做 Developer ID 公證。

## 歷史交付：2026-10-03 bundle16（Apple Silicon 內部測試候選版）

已實作 Mac 專案父目錄流程：使用既有目錄選擇器選取父目錄，顯示準確子路徑，明確確認後才建立並將原會話綁定到新專案。父目錄保持受限，不授予一般專案工具寫入權限；同名衝突拒絕且不自動換名。

- 後端：新增 `project_container` 持久化狀態、`projectContainers: 1` 協商及版本化分配端點。Mac 以持有的父目錄 fd 建立直接子目錄，復用令牌、租約、擁有者檢查及回滾。重新啟動保留父目錄記錄，但建立令牌失效，需重新確認。Windows 原容器流程保留。
- 前端：確認卡片、升級提示、會話元資料、權限摘要及工作區面板已接入；專案綁定前不把父目錄開成可寫工作區。成功後續行原訊息與 run。
- Windows：相關 Rust **112/112**（含擴充啟用邊界、空正文續行及原訊息恢復）；嚴格 Clippy（`-D warnings`）退出 0。Mac：原生 Rust **34/34**（含並發確認、空正文續行及原訊息恢復）；Clippy 退出 0，9 條既有平台警告。兩端前端各 **89/89**，TypeScript 退出 0。
- Chrome 受控互動通過：選取不建立、明確確認與原任務續行、舊後端升級提示、取消不建立。使用正式元件及流程函式，Electron 選擇器與 ACP 傳輸為夾具；不計為原生 Electron E2E。此驗收發現通用錯誤遮蔽升級提示，已以具型別錯誤修正並補回歸。
- 新 Release 後端「首次確認」真實 ACP **8/8**：令牌校驗、準確子目錄、父目錄工具拒絕、重複確認冪等、原會話綁定、原空正文控制請求續行且模型實際寫入 `acceptance.txt`、已綁定專案重啟恢復、刪除會話保留檔案。證據 `evidence/project-container-fresh-acp-result.json`；使用倉庫外臨時中文目錄。
- 首輪原生 ACP 暴露空閒上下文整理被誤判為活動任務，確認建立遭拒。已改用既有會話存取屏障，等待會話存取占用清空後才讀取最新狀態並建立；補回歸驗證等待及並發元資料保留。修復後重新測試、Clippy、編譯並執行嚴格 ACP 驗收；後續診斷另發現共享 ACP 入口將既有的空正文工作區續行拒絕為空輸入；現僅允許有效 CodePro 工作區續行控制請求，原訊息仍由 Agent 復原。另一次測試為 33 通過／1 夾具初始化失敗；依真實 session/new 補齊重新開放存取後，最終 34 項全數通過。首輪失敗、中斷編譯與候選版後續診斷另存。
- **綁定前重啟後重新確認：未通過完整驗收。** 兩次嚴格流程均完成前 6/10 項（含空目錄回滾及舊令牌拒絕），之後共享恢復判斷先遇模型 JSON 校驗失敗，再遇模型超時，後續任務未執行。`project-container-acp-16-model-relation-error.log`、`project-container-acp-16-model-timeout.log` 及 `project-container-acp-result.json` 保留證據；上項首次確認測試是獨立場景，並非此流程通過。
- bundle16 封裝退出 0。實際掛載 DMG、複製到獨立安裝目錄、卸載映像，再驗證簽名及內置後端版本/雜湊，全部通過。依使用者要求保留既有鑰匙圈認證現場，**未啟動 bundle16 Electron，完整可見桌面 E2E 未執行**。
- 來源：main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、既有合併內容及未提交修改；3,249 個來源項目核驗一致。未建立分支、提交或推送，合併提交仍待完成。產品 UI 1.43.2／後端 1.43.0；原始後端 SHA-256 `3bcf7d4de4aafb52ab1ec9239a901df3fa165b0efee54241d9a03a759fb38366`；簽署後封裝 SHA-256 `c107d1f7cde1fda925f5e176b944726008d7ccec251720a66d3859399b947399`。

交付：本機 `target/macos-release-20261003-bundle16/`；遠端桌面 `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261003-bundle16/`；安裝 `/Users/erjinyi/Applications/CodeBuddy-Test-20261003-bundle16/CodeBuddy.app`。精確命令、工作目錄、退出碼及日誌見 `evidence/commands.json`。建置來源快照為 `BUILD_SOURCE_STATE.json`；後續文件同步另有核驗。

- DMG SHA-256：`8e78723df49b0b225b42575a223dfe54b3e775481c2c14ff46cd33e5d0ea1815`
- ZIP SHA-256：`dc517f76537b13cfe1e1c84f95af992430b006c179f43db52b70de893bd4874f`

待可見桌面驗收：完成既有認證後啟動 bundle16；在未綁定會話要求建立新專案並寫入 `acceptance.txt`，選擇含中文與空格的測試父目錄，核對準確子路徑。先取消並確認沒有新增目錄，再重新發起並確認，核對同一會話完成寫檔。重啟應恢復子專案與檔案，父目錄不應成為可寫專案。此流程尚未執行。

**全功能一致尚未完成**：清理隔離／復原／永久刪除、完整桌面流程、電腦控制權限實測、Intel 與最低支援系統實機仍待開發或驗收。此包為 arm64 ad-hoc 內部測試版，未做 Developer ID 公證。

## 歷史交付：2026-10-03 bundle15（Apple Silicon 內部測試版）

補上 Mac 根容器的唯讀磁碟容量查詢，沿用既有 `codepro.root_disk_usage` 結構化結果及會話持久化流程，不授予工作區寫入權限。Mac 先驗證根目錄與目錄物件，再透過既有 fs2 讀取作業系統容量；Windows 實作及公共協議不變。

- 修改：`workspace_lease.rs`、`workspace_lease/lifecycle.rs` 共用容量資料型別；`workspace_lease_macos.rs` 新增原生讀取；`agent.rs` 接入 Mac 分支及持久化回歸；`workspace_lease/macos_tests.rs` 驗證真實容量、非根目錄、相對路徑與符號連結拒絕。
- Windows：後端相關測試 **100/100**，嚴格 Clippy（`-D warnings`）退出 0。Mac：原生 Rust **16/16**，Clippy 退出 0（9 條既有平台警告）。格式檢查通過。首次 Mac 測試編譯因新測試存取私有函式報 E0603，移除該跨模組斷言後重跑通過，未擴大 API 可見性。
- 新編譯後端的真實 ACP 驗證 **3/3**：無寫租約建立根會話、宿主容量與原生檔案系統統計一致、重啟後回放同一結構化結果。總容量 `494384795648` bytes，查詢當時可用 `254468087808` bytes；可用量隨系統使用變動。證據：`evidence/root-disk-acp-result.json`。此結果是桌面模式後端實測，非可見 Electron E2E。
- Release 後端、bundle15 封裝均退出 0。實際從 DMG 複製至獨立安裝目錄並卸載映像後，簽名驗證、安裝後端 `--version` 及雜湊比對通過。未啟動 bundle15 Electron；依使用者要求保留既有鑰匙圈認證現場，完整桌面驗收待完成。
- 來源：既有 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、既有合併內容與未提交修改；3,248 個建置來源項目核驗一致。本輪未建分支、提交或推送，合併提交仍待完成。產品 UI 1.43.2，後端 1.43.0；新後端原始 SHA-256 `412e8f1ef395c9fafb3f21b948cad6288b6bd7efddffc4a4cbaba79b5e2c1068`，簽署後封裝 SHA-256 `a84b4e82ebb4d9e774f8a109dfcfd46dcf40c3b80e26ed8793b3305f30d47e08`。前端未改，bundle14 的前端測試列為前階段證據。

交付：本機 `target/macos-release-20261003-bundle15/`；遠端桌面 `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261003-bundle15/`；安裝 `/Users/erjinyi/Applications/CodeBuddy-Test-20261003-bundle15/CodeBuddy.app`。命令、退出碼、原始日誌及安裝結果位於 `evidence/`，建置來源快照為 `BUILD_SOURCE_STATE.json`；後續文件同步另有來源核驗記錄。

- DMG SHA-256：`386a3f9d5cfdc11ae270557141f9a90ae36fe57397ff581a44fa4335157a32b5`
- ZIP SHA-256：`2e09a01a64afe9cd764c70c7374bae47f3ea7d0b2e2af24ddd6e034d0f57149d`

**全功能一致尚未完成**：新專案容器方案待批准；清理隔離／復原／永久刪除、完整桌面流程、Intel 實機仍待開發或驗收。此包為 arm64 ad-hoc 內部測試版，未公證。唯讀電腦控制診斷在 SSH 上下文顯示 Accessibility/ScreenRecording=false；它使用未變更的 bundle14 helper，既不代表 Electron 權限狀態，也不計為桌面操作驗收。

## 已批准方案：Mac 新建專案容器（2026-10-03）

實機 `/` 掛載標記為 `apfs, sealed, read-only`。現有 `NeedsWorkspaceInline` 只接受檔案系統根目錄；`load_session` 也只允許根容器綁定直接子目錄。僅移植 Windows allocate-child 處理器，仍無法在一般 Mac 系統卷建立專案。[Apple 簽署系統卷說明](https://support.apple.com/guide/security/signed-system-volume-security-secd698747c9/web)。

建議新增獨立的 `project_container` 狀態：由使用者以既有目錄選擇器選擇可寫的本機父目錄，確認預計子目錄後才建立。父目錄不取得專案工具寫入權限；成功後原會話只綁定新建的直接子目錄，保留原始訊息、run 與續行關聯。

沿用宿主租約／nonce／單次消耗／擁有者檢查／回滾狀態機。前端僅提交確認資料；宿主驗證規範路徑、持有的目錄物件及直接子目錄關係。重新啟動後，容器記錄本身不授予建立權限，必須重新確認後取得新令牌。清理權限另行設計，不由專案建立權限派生。

舊 `root_container` 和 `writable_project` 記錄不改義、不自動遷移。新能力需協議協商；舊客戶端／後端保持既有流程，遇到未支援的新狀態則明確要求升級，禁止靜默降級為可寫專案。排除自動改用家目錄及修改系統卷設定。

驗收：兩端既有工作區回歸；Mac 真實臨時父目錄下的中文命名、衝突、替換／符號連結、令牌重用、失敗回滾、重啟重確認、同會話續行；最後執行桌面選擇／確認流程。這會新增持久化狀態並調整容器授權範圍，依根 AGENTS.md 提案後，使用者要求繼續，現已進入實作與驗證；最新狀態見頁首。

## 歷史交付：2026-10-03 bundle14（Apple Silicon 內部測試版）

使用者暫緩鑰匙圈認證後，本輪繼續修復工作區路徑並完成不依賴桌面認證的驗證。

- 提示詞中的 POSIX 絕對路徑現在會進入既有工作區確認流程；支援引號內的中文、空格及尾端標點，保留大小寫與多候選選擇。URL 與相對路徑不再誤識別為 Windows 磁碟路徑。候選提取不授予寫入權限。
- 選取及確認工作區時保留合法尾端括號等字元；新增兩端真實目錄案例，驗證檢查及確認後原始檔案保持一致。
- Windows：工作區回歸 77/77，面板／終端平台配置／確認卡片 24/24；Mac：74 通過、3 項既有 Windows 專屬案例跳過，另 24/24 通過。兩端 TypeScript 退出 0。
- 新包從 DMG 複製到獨立安裝位置，卸載映像後簽名檢查及後端 `--version` 退出 0。這是安裝結構驗證；bundle14 的 Electron 安裝煙測和完整桌面 E2E **未執行**。bundle13 的可見啟動仍停在 Safe Storage 鑰匙圈認證，依使用者要求保留現場。
- 來源：既有 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、合併內容及未提交修改；本輪未建立分支、提交或推送。建置前 3,248 個來源項目核驗一致；只更新前端，沿用 bundle13 已驗證的後端 1.43.0，產品 UI 1.43.2。
- 首次本機 pnpm 包裝腳本意外重配置依賴並執行 SDK 生成，已停止；日誌下載量為 0，鎖檔／工作區配置／SDK 生成檔雜湊均與前次清單一致。後續直接用現有 Node 24 執行 Vitest、TypeScript，無新增依賴。首輪回歸發現 URL 誤識別，修復後取得上述通過結果。

交付：本機 `target/macos-release-20261003-bundle14/`；遠端桌面 `/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261003-bundle14/`；遠端安裝 `/Users/erjinyi/Applications/CodeBuddy-Test-20261003-bundle14/CodeBuddy.app`。完整命令、退出碼及結果位於交付目錄 `evidence/`，原始 Mac 日誌位於 `target/macos-parity-20261003/`。

- DMG SHA-256：`8ca5870bf771aaea497b02f4ff34a3491ebb6de1426f374732cde6865b6628ec`
- ZIP SHA-256：`d3f877818a966b3affe2d2d03f9ceaf20a8353826404827dcd2730df6e45d9e7`

仍待完成：根容器分配、清理隔離／復原／永久刪除、完整桌面驗收及 Intel 實機。此包仍為 ad-hoc 簽署，未公證。以下紀錄為歷史階段。

## 歷史交付：2026-10-02 bundle13（Apple Silicon 內部測試版）

已生成並交付產品 1.43.2 / 新編譯後端 1.43.0。DMG 與 ZIP 在 Windows 本機和遠端 Mac 的 SHA-256 均一致。開發改動及既有合併內容仍未提交、未推送。

- 原始碼：本機 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、合併內容與未提交修改；遠端建置副本維持原 detached HEAD。建置前 3,248 個清單檔案／連結核驗通過。
- Windows：後端 100/100、前端 65/65；TypeScript 與嚴格 Clippy 退出 0。
- Mac：原生 Rust 14/14；前端 62 通過、3 個既有 Windows 專屬案例跳過；TypeScript 退出 0。Mac Clippy 退出 0，保留 9 條既有平台警告。
- 真實原生後端：以桌面實際入口 `serve --platform desktop`，在倉庫外臨時工作區完成 9 項檢查，包括模型實際寫檔、正常結束任務、重啟恢復綁定、替換目錄拒絕及刪除會話後保留專案檔案。證據：`evidence/desktop-acp-result.json`。
- 安裝驗證：DMG 驗證、安裝後卸載映像、簽名驗證，以及安裝副本的檔案／PTY／內嵌瀏覽器煙測全部通過。這是受控安裝與 API 驗收；遠端仍鎖屏，可見桌面完整 E2E 未執行。
- 驗收修正記錄：最初 CLI stdio 探針缺少桌面模式的證據持久化配置，首輪逾時。第二輪中，模型對位於來源倉庫內的測試檔案額外建立分支／提交；已停止探針，只撤回該測試產生的 Git 變更，完整原始碼再次核驗一致。修正入口與隔離位置後才取得上述 9 項通過；前兩輪不計為桌面產品 PASS。

本機安裝包：`target/macos-release-20261002-bundle13/`。遠端桌面：`/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261002-bundle13/`。新副本已單獨安裝於 `/Users/erjinyi/Applications/CodeBuddy-Test-20261002-bundle13/CodeBuddy.app`，尚待解鎖後進行可見桌面驗收。

- DMG SHA-256：`82ddd98f70e8684e0e41780300e185de25c998901647d65755dd83ddfd9d2058`
- ZIP SHA-256：`d07b65d7341daefe28d3ae5a46d39bb182a5d1f578fbd1c3b90d493a0c3c856a`

**全功能一致尚未完成**：根容器自動分配、清理隔離／復原／永久刪除仍待開發；Intel、最低支援系統版本實機及完整桌面操作尚未驗收。此包為 ad-hoc 簽署，未做 Developer ID 公證。以下為本輪實作及歷史紀錄。

## 本輪核心適配：2026-10-02（實作與驗證中）

使用者已批准前一節的 Mac fd 適配方案。來源為既有 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、合併內容及未提交修改；Windows NT 檔案操作保持原實作。

- 將租約令牌、pending/session 登錄、會話存取屏障和恢復流程抽至 `acp/server/workspace_lease/lifecycle.rs`，Windows/Mac 共用同一份狀態機。權限事實 owner 與持久化協議未變。
- Mac 採用 `secure_fs/macos.rs` 的 `openat/O_NOFOLLOW`、`fstatat` 裝置/inode 與 `F_GETPATH`；取得及使用租約時檢查整條目錄綁定。fd 不會阻止其他程序改名，因此不宣告與 Windows 排他鎖等價。
- ACP acquire/release、新建/恢復/關閉/刪除/封存及上下文維護接入 Mac 租約生命週期。檔案附件以 fd 相對開啟，拒絕符號連結、硬連結、越界及超過 2 MiB 的內容。
- 前端新建流程原先只在 Windows 取得令牌，而且固定用 Windows 路徑格式校驗；現已加入 darwin，共用保留 POSIX 大小寫的 identity 正規化。
- Windows 前端相關回歸 65/65；Mac 62 通過、3 項既有 Windows 專屬測試跳過。兩端 TypeScript 退出 0。Mac Rust 原生回歸 14/14，退出 0；包含 ACP 派送、封存/刪除與持久綁定恢復。

Mac 空目錄回滾保留 `FSCreateDirectoryUnicode` 建立時返回的 FSRef，直接對該引用呼叫 FSDeleteObject；不在回滾時由舊 fd 路徑重建引用。原生回歸第 4 輪為 12 通過、1 失敗：APFS 已刪除目錄的 fd 仍可返回舊路徑和非零鏈接數，原先的「已刪除」判定失效。已修正並新增空替換目錄保留案例，第 5 輪 14 項全部通過（退出 0）。非空目錄拒絕刪除，失敗時保留 pending 租約。FSRef API 已棄用，Apple 註明 APFS 的 32/64 位 inode 相容可能造成效能代價；未引入外部依賴。尚未完成：根容器自動分配，以及清理隔離/復原/永久刪除。遠端仍鎖屏，真實桌面端到端驗收未執行。bundle12 不包含本輪核心修改，後續 bundle13 建置與交付結果見上方最新紀錄。

Windows 後端本輪回歸 100/100、嚴格 Clippy（`-D warnings`）通過，均退出 0。參照：[Apple FSRef](https://developer.apple.com/documentation/coreservices/fsref)、[node-pty 使用執行緒目錄 API](https://github.com/microsoft/node-pty/blob/main/src/unix/pty.cc)。

驗證入口：`cargo test --locked --offline -p goose --lib --release --jobs 1 -- acp::server::workspace_lease acp::server::custom_dispatch::workspace_lease_macos_dispatch_tests acp::server::load_session::tests::codepro_resume_consumes_and_binds_a_fresh_workspace_lease acp::server::load_session::tests::persisted_writable_binding_resumes_without_user_reconfirmation secure_fs::macos::tests --test-threads=1`。證據位於遠端 `target/macos-parity-20261002/lease-tests-*.log`；前端證據 `workspace-ui-tests.log`、`workspace-typecheck.log`。

## 歷史 bundle12：2026-10-02（核心適配前）

bundle-arm64-12 已生成並通過 DMG 安裝煙測；產品 1.43.2，後端沿用同一已驗證 Release 1.43.0。來源仍為 main 00a6656df0c4ba0563b4cf03e560cb81a46b0f53、既有合併內容及未提交修改；未建立分支、提交或推送。

- 修正 Mac Option+B 字元變化導致瀏覽器快捷鍵失效；辨識實體 KeyB，保留原 Windows 行為。
- 工作區檔案搜尋、瀏覽器、儲存快捷鍵顯示 Mac Command/Option；共用設定頁原有的格式化邏輯。保留 Ctrl+反引號終端入口。
- 加入 Command+S 草稿儲存回歸，避免 Shift/Option 修飾及輸入法組字被一般儲存快捷鍵攔截。英文、簡體、繁體提示同步。
- Windows/Mac 面板元件測試各 11/11；兩端 TypeScript 退出 0，翻譯編譯退出 0。Mac 原生封裝與安裝煙測退出 0，證據 `target/macos-parity-20261002/`、`ui/desktop/out/macos-install-XFuq3q/`。

| 關鍵流程 | 本次證據與剩餘缺口 |
| --- | --- |
| 模型初始化 | 已連接 qwen3.8-flash-next，bundle11 主介面保留模型 |
| 面板開關與目錄選單 | bundle11 真實 Electron renderer 點擊成功；遠端桌面目前鎖屏，完整可見流程待解鎖 |
| 新建 CodePro 工作區 | 安裝後端的 lease/acquire 實際回覆 -32601 Method not found；Mac 尚未註冊既有租約處理器 |
| CodePro 寫入、清理及恢復 | 核心工作區適配待方案批准，尚未完成 |
| 檔案、PTY、內嵌瀏覽器 | bundle12 安裝煙測通過；完整任務中的使用仍待工作區鏈路接通 |
| 本次 Mac 快捷鍵 | 元件回歸通過；新包真實桌面快捷鍵待解鎖後驗收 |

根 AGENTS.md 要求核心權限抽象變更單獨確認，已向使用者提出沿用協議／狀態機並新增 Mac fd 實作的方案；待批准後繼續。Windows/Mac 全功能一致仍未完成。bundle12 為 ad-hoc 內部測試包，尚未公證；使用者安裝位置仍執行 bundle11，避免在鎖屏期間替换其前台應用。

Artifacts / 安装包：`target/macos-release-20261002/`；remote / 遠端：`/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261002/`。

- DMG SHA-256: `105fc338c9477ef9374e7922805f24d706831d0c2a2048f267a3f5ed6e3f0835`
- ZIP SHA-256: `5ed9203ecfcca5c55464bb47d6ce3bfd8ec2f9746ab887c082de47909df339fc`


## 歷史交付：2026-10-01 19:14

已生成 CodeBuddy 1.43.2 Apple Silicon 內部測試包；後端沿用原始碼版本 1.43.0。原生 Release 編譯成功，bundle-arm64-11、DMG 安裝及安裝副本煙測均退出 0。這不是 Windows/Mac 功能一致驗收完成。以下較早日期的紀錄保留為歷史，不代表目前狀態。

來源為 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`、已整合的 `b8c6eb06c77281aa0a7ed1633b40cc861f2389af` 及未提交修改。合併衝突為零；合併提交仍待有效作者資料，未推送。

- 本機交付：`target/macos-release-20261001/CodeBuddy-arm64.dmg`、`CodeBuddy.zip`、雜湊清單與驗收證據。
- 遠端桌面：`/Users/erjinyi/Desktop/CodeBuddy-Mac-Test-20261001/`。
- 遠端安裝：`/Users/erjinyi/Applications/CodeBuddy-Test-20261001-4nejwg57/CodeBuddy.app`。
- DMG SHA-256：`3f9156719a552bab618aeda7ef7d79a7ee9a39aefae00ce21b94363812fdde60`。
- ZIP SHA-256：`c2f698f005990391f8b6147f3702ea06c77b0fd768df3ca4a77223c05bea100e`。

封裝修正包含原生 node-pty 與編譯標頭暫存、Forge 完成後重新簽署，以及區域網路用途說明。沿用既有 @electron/osx-sign；簽署後重算封裝檔案雜湊，原始簽署前雜湊保留。`codesign --verify --deep --strict` 和 `hdiutil verify` 均退出 0。這是 ad-hoc 簽署，尚未 Developer ID 簽署或公證；Intel 包與 Gatekeeper 使用者流程尚未驗收。

安裝測試從 DMG 複製並卸載映像後，啟動真實 Electron 安裝副本：中文檔案列出/讀寫/搜尋、原生 PTY 工作目錄與 32×110 尺寸、Unicode 輸出、WebContentsView 本機 HTTP 頁面均通過。封裝回歸 27/27，工作區/布局回歸 27/27；這些是不同測試批次。證據：遠端 `out/macos-install-Bh86fE/`、`out/macos-smoke-arm64-GTNFNJ/`（相對 ui/desktop），本機 `target/macos-release-20261001/evidence/`。

已從 macOS LaunchServices 啟動安裝副本，依使用者授權允許桌面資料夾及本地網路存取；網路提示顯示名稱為「Electron」。bundle-arm64-10 重試後成功進入主介面並顯示 qwen3.8-flash-next，模型初始化通過。先前的 OS error 65 已解除；SSH 執行與一般應用程式啟動的權限路徑存在差異。證據：`target/macos-ui-final-uHcPDk/after-local-network-permission.png`。

實際 UI 發現標題列拖曳區遮住工作區面板按鈕。已將展開面板及收合後的入口移到 32px 拖曳區下方；Windows 與 Mac 的面板元件測試各 8/8，兩端 TypeScript 檢查退出 0。bundle-arm64-11 復用同一已驗證 Release 後端重新封裝，建置及 DMG 安裝煙測退出 0；證據 `out/macos-install-2bsGs8/`。目前新版啟動停在「CodeBuddy Safe Storage」登入鑰匙圈密碼認證，等待使用者親自完成；面板真實點擊、完整聊天與重啟恢復驗收仍待完成。核心工作區租約適配仍依根 AGENTS.md 等待方案批准；Windows/Mac 全功能一致未完成。

### 區域網路模型排查

2026-10-01 後續驗證：安裝包內同一 goose 執行檔經 SSH 啟動 ACP，模型發現、建立供應商及儲存預設模型的真實 completion 校驗均成功；新建普通 ACP 會話後收到 `Mac native model acceptance OK.`，`stopReason=end_turn`。證據：`target/macos-release-20261001/evidence/network-comparison/`。這仍不代表 Electron UI 或 CodePro 寫入任務驗收通過。

Apple 說明，SSH/Terminal 命令列程式具有區域網路存取例外，而應用程式啟動的 helper 歸屬該應用程式；因此 SSH 成功並不證明應用程式已獲准。解鎖後檢查「系統設定 → 隱私權與安全性 → 區域網路」的 CodeBuddy 項目，再由應用程式重試。若設定要求認證，由使用者親自完成。ad-hoc 簽署的身份追蹤亦有局限，正式發行應使用 Apple 核發的簽署身份。參考：[Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。

模型發現和 completion 驗證保留原有 ACP 錯誤碼，新增去除 URL 的底層連線診斷；不要從 `custom_provider_endpoint_unreachable` 單一錯誤碼推定權限已被拒絕。

### 歷史實施紀錄

## 2026-10-01 原生編譯缺口與租約適配方案

新增清理預覽回歸在 Windows 通過 1/1（退出 0）；證據 `target/macos-parity-20261001/cleanup-preview-regression.log`。Mac 原生 PTY 已驗證中文目錄、Unicode 輸出及 stty 實際回報 32×110，退出 0；證據 `target/macos-native-evidence/native-pty-check-3.log`。開發入口復用封裝的 preparePty 修正 spawn-helper 執行權限。安裝煙測也增加實際尺寸與 Unicode 斷言，尚待安裝包執行。

首輪 Release 編譯在 goose 專案庫退出 101：四處呼叫 Windows 專有 workspace_lease，另有跨平台清理預覽引用被 Windows 條件編譯排除的函式。已修正編譯邊界；未實作的配置/清理操作明確報錯，不發出虛假能力或略過工作區保護。清理預覽保留 pending/recovering/recovery 目錄排除，新增真實目錄回歸。此前純元件測試不代表 CodePro 寫入會話可用。

待審核的原生適配：保留 ACP acquire/consume/bind/release 與 session/run/message/nonce 所有權；抽出平台檔案操作層，Windows 保留現有 NT handle 實作，macOS 使用已有 libc 的逐層 openat/O_NOFOLLOW、fstat 裝置/inode、F_GETPATH 與 fd 相對操作。不採用「canonicalize 後直接按路徑寫入」方案，因它不涵蓋檢查與操作之間的替換。POSIX fd 不提供 Windows share-delete 的同等排他語義，重新命名/刪除需要單獨設計競態及復原合同，不能直接宣告等價。

影響檔案：acp/server/workspace_lease.rs、secure_fs、ACP new_session/custom_dispatch/dispatch gate、agents/agent.rs，以及必要的工作區前端合同；不建立第二套權限裁決。階段一驗證租約一次性消耗、身份變更、符號連結/硬連結、會話關閉與重啟；階段二驗證根目錄清理的審核/隔離/復原/刪除競態；最後完成真實 Mac UI 新建及恢復 CodePro 任務。這是核心檔案權限抽象及狀態合同的變更，依根 AGENTS.md 在方案批准後實作。

參考：[Apple F_GETPATH](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)、[openat 相對目錄與 O_NOFOLLOW](https://man.freebsd.org/cgi/man.cgi?query=openat)。使用系統 API 與既有 libc，不引入外部實作原始碼。

## 歷史狀態：2026-09-30

2026-09-30：已補齊 macOS 打包入口與終端適配；**尚未產出或執行 macOS 安裝包，尚未完成 Mac 實機驗收**。
來源：`D:/Users/jiangrui/Desktop/CodeBuddy`，`main`，`00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加未提交修改。倉庫名為 CodeBuddy，產品中繼資料仍為 CodeBuddy；本次沿用此名稱。沒有建立分支、提交或推送。

沿用 goose 的 Rust 後端、Electron Forge、node-pty 1.1.0 與 xterm；未新增依賴。新增 `scripts/bundle-macos.cjs` 統一現有 `bundle:default`、`bundle:intel` 和原生架構 `bundle:mac`。arm64 / x64 分別在相應架構的 Mac 建置；不輸出 Universal 包。

## 2026-10-01 依賴與跨平台回歸更新

使用者已授權建置依賴安裝。遠端使用 Rust 1.96.1、Node 24.10.0、pnpm 11.9.0、CMake 4.2.3、protoc 31.1 和既有 Go/Command Line Tools。Hermit 的 Windows 序列化連結與執行權限由 `scripts/prepare-hermit.py` 還原，Mac CI 在首次啟用 Hermit 前執行；腳本已驗證保留其他檔案及重複執行。`node-pty` 加入既有依賴建置允許清單。經鎖定版本與檔案雜湊核對後，透過區域網路重用本機依賴快取；`pnpm --dir ui install --frozen-lockfile --offline` 最終退出 0。

Mac 原生封裝/開發入口測試 26/26、TypeScript 退出 0、工作區/布局測試 27/27。實機測試發現工作區根目錄經符號連結（如 macOS `/var`）後，列表混用原路徑與 canonical 路徑，造成搜尋越界誤判；現在以同一 canonical 根目錄生成相對路徑，既有越界拒絕保留。Windows 同一回歸先重現失敗，再通過 8/8。Swift 按鍵合同亦已驗證修飾鍵別名、Command、符號與數字鍵盤區別。證據位於遠端 `target/macos-native-evidence/`，本機 Windows 回歸位於 `target/macos-parity-20261001/linked-root-*.log`。

Rust Release 原生建置執行中；目前尚無 `.app`、DMG/ZIP 或已完成的安装/完整 UI 驗收。上述結果不代表 Windows/Mac 全功能一致驗收已完成。

## 2026-10-01 Mac 原生驗證更新

已透過 RustDesk 啟用遠端登入並配置任務專用公鑰，SSH 已接通；原先 SSH 拒絕連線的阻塞已解除。遠端目錄：`/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001`。傳輸 3,242 個原始碼檔案並逐一核對 SHA-256；UTF-8 文字 CRLF 轉 LF，二進位位元組保留。來源 HEAD 與未提交整合工作保持可追溯。

在 arm64 / macOS 26.6.2 上使用已安裝的 Command Line Tools（每個建置程序設定 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`，未切換系統 Xcode 選擇），Go 測試、Swift 合同測試、兩個原生 helper 編譯均退出 0。首輪發現 Foundation 未匯入 CoreGraphics 擴充，已在合同與測試檔明確匯入並重建通過。MCP 初始化、九工具註冊、缺少螢幕錄製權限時回傳錯誤也已在 Mac 通過。證據：`target/macos-remote/computer-build-2.log`、`native-probe.json`。

doctor 回報 Accessibility=false、ScreenRecording=false；真實操作與 Retina 座標後置條件仍待驗收。helper 編譯有 macOS 14 起 `activateIgnoringOtherApps` 已棄用且無效果的警告，目前不是編譯錯誤。完整 Rust/Electron 建置、`.app`、DMG/ZIP、安裝及 UI 全流程仍為 NOT_RUN。現有 Mac 的 Node 26、Rust 1.97.1 與專案指定版本不同，CMake/protoc 缺少；使用者已授權下載並安裝建置依賴，正在透過既有 Hermit/pnpm 入口準備鎖定版本。沒有將此環境缺口列為產品測試失敗。

## 2026-10-01 本機驗證（原生建置前）

來源仍為既有 `main` / `00a6656df0c4ba0563b4cf03e560cb81a46b0f53`，整合 `work/codebuddy-next` / `b8c6eb06c` 加未提交修改。衝突已清零，原有 50 個 dirty 檔案的備份與 stash 保留；合併提交等待有效作者姓名/郵箱，未推送。

Mac 專用電腦執行層已接入原始碼與封裝：共用 Go MCP 的九工具介面、快照索引、精確視窗綁定和 `desktop_observation` 回執，以 Swift / AppKit / Accessibility / ScreenCaptureKit 執行 macOS 操作。沒有直接替換成上游另一套 MCP 狀態機。輸入失敗或取消會使所有視窗快照失效；輸入結果未知時先重新觀察。啟用 `qwen_computer` 的本機 Mac 路由，開發啟動會同步兩個 helper，封裝驗證架構、執行權限與 SHA-256。

已修正先前 8 個失敗：ACP 負數用量歸零、非 Tester 角色不得消費 host verification 作為通過證據；報告測試依現有可見摘要/技術詳情分層，DAG 測試使用明確驗證合同及最新失敗回執，避免從命令字串猜優先順序。受影響 Rust 回歸 **191/191**；Go **29/29**、vet；Mac 封裝與開發入口 **26/26**；TypeScript 和嚴格 Clippy 均退出 **0**。證據：`target/macos-parity-20261001/`。先前發布檢查 34/34、UI 12/12、provider 14/14、SDK 8/8 的記錄位於 `target/integration-20261001/`，沒有把不同批次計為一次完整測試。

Go MCP 已交叉編譯成 arm64/x64 Mach-O 元件；**這些不是安裝包**。Swift 原生編譯與合同測試、Mac Rust/Electron 建置、DMG/ZIP、安裝、TCC 和完整 UI 驗收均為 **NOT_RUN**。SSH 連線仍被拒絕，待遠端登入/公鑰配置接通後續接。Windows/Mac 功能一致尚未驗收完成。


```powershell
# Repository root
cargo test --offline -p goose --lib --jobs 1 -- --test-threads=1 agents::codepro_terminal_report::tests agents::task_dag::tests acp::server::tests::test_build_ agents::tool_task::tests
cargo clippy --offline -p goose -p goose-providers -p goose-provider-types -p goose-sdk-types --lib --tests --jobs 1 -- -D warnings
# ui/desktop
node --test scripts/macos-package.test.cjs scripts/ensure-dev-backend.test.cjs
node ../node_modules/typescript/bin/tsc --noEmit
# tools/qwen-computer-use; use CODEBUDDY_GO_EXECUTABLE if Go is outside PATH
go test -json ./...
go vet ./...
```

## 建置

需要已準備好的 Node 24.10+（24.x）、專案指定 pnpm、Rust 1.96.1、Go 1.22+、Xcode Command Line Tools（含 Swift）、Python 3、CMake、protoc 及對應 Rust target。`bin/activate-hermit` 提供倉庫已有工具鏈；首次啟用/安裝會存取網路。先以 `pnpm --dir ui install --frozen-lockfile` 準備已有鎖定依賴，再執行：

```bash
# Repository root; dependencies must already be prepared.
python3 scripts/prepare-hermit.py
source ./bin/activate-hermit
cd ui/desktop
pnpm run bundle:mac --arch arm64
# Run on an Intel Mac for x64:
# pnpm run bundle:mac --arch x64
pnpm run test:macos-smoke
pnpm run test:macos-install
```

`bundle:default` 固定 arm64，`bundle:intel` 固定 x64。CI 可用 `--backend /absolute/path/to/release/goose` 提供同架構 Release 工件；中繼資料會標示 supplied artifact，這個選項不證明外部二進位的來源。一般本機入口會先執行 `cargo build --release -p goose-cli --bin goose --target TARGET`。

輸出位於 `ui/desktop/out/CodeBuddy-darwin-ARCH/`，包含 `.app`、`CodeBuddy.zip`（arm64）或 `CodeBuddy_intel_mac.zip`（x64）、`backend-manifest.json`。清單記錄 revision、dirty 狀態、架構、簽名前及打包後後端 SHA256。暫存使用 `target/codebuddy-package/macos-ARCH-*/bin`，包含 POSIX 啟動腳本、對應後端及兩個電腦工具 helper，保留 `src/bin` 開發檔案。

Forge 保留 macOS 原生模組重建，檢查 `pty.node` 和 `spawn-helper` 架構，簽名前修正 helper 執行權限，整個 node-pty 解包。Unix JavaScript 從 `app.asar` 載入，避免 node-pty 再次替換造成 `.unpacked.unpacked`。macOS 互動終端使用 login shell，預設 `/bin/zsh`。

`.github/workflows/bundle-macos.yml` 沿用兩種原生 runner；移除失效的 Electron Builder Intel 設定，從產品中繼資料推導工件路徑；執行原始碼檢查、打包和煙測後才上傳桌面工件。此工作流程目前未推送、未觸發。

封裝包含 `qwen-computer-use` 與 `qwen-computer-runtime`，與 goose 同目錄。建置先執行 Go 測試及 Swift 合同測試；清單包含 `computerHashes` 和 `packagedComputerHashes`。缺少 helper、架構不符或內容替換會阻止封裝通過。

### DMG 安裝驗收

打包另產生 `CodeBuddy-ARCH.dmg`、`artifacts.json` 與 `SHA256SUMS`。沿用 macOS 內建 `hdiutil` 建立唯讀 UDZO 映像，包含應用程式及 Applications 捷徑；產物清單記錄版本、來源、架構、大小與 SHA-256，校驗採分塊讀取。

`pnpm run test:macos-install -- /absolute/path/CodeBuddy-arm64.dmg` 要求同目錄有 `artifacts.json`。先核對清單、主機架構與映像完整性，再掛載、以 `ditto` 複製到獨立驗收目錄、卸載映像，最後對安裝副本執行既有煙測。應用與安裝回執保留於 `out/macos-install-*/`，煙測證據位於 `out/macos-smoke-ARCH-*/`。CI 現在以此步驟作為上傳安裝包的門檻。此流程未代替 Finder 操作或 Gatekeeper / 公證驗收。

2026-09-30 遠端預檢：已透過 RustDesk 觀察 MacBook Air M2、16 GB 與 macOS Tahoe 26.6.2。SSH 22 連線回覆拒絕；原生建置、DMG 產出、傳輸與遠端安裝驗收仍待執行。遠端登入及公鑰配置需由使用者完成後續接。

## 系統依賴與功能邊界

| 功能 | macOS 路徑與條件 | 本輪狀態 |
| --- | --- | --- |
| 檔案樹、搜尋、預覽、編輯 | 現有 Node 檔案 API；所選目錄權限 | 自動測試通過，Mac 待驗 |
| 互動終端 | node-pty / zsh 或使用者 SHELL；Xcode/Python 僅建置需要 | ASAR 修復與 login shell 測試通過，原生 PTY 待驗 |
| 內嵌瀏覽器 | Electron WebContentsView；網路、代理與網站憑據 | 現有隔離規則沿用，Mac HTTP/HTTPS 待驗 |
| 一般 Computer Controller | 既有 `computercontroller` → Peekaboo；macOS 15+、Homebrew、螢幕錄製與輔助使用權限 | 僅確認原始碼路徑；未安装、未實機驗證 |
| 專用電腦驗收 Agent | 共用 `qwen_computer` + 原生 Swift helper；macOS 14+、螢幕錄製與輔助使用權限 | 原始碼已接入，原生建置及實機驗收待執行 |
| 搜尋 MCP | 原有 node/npx/uvx shims，首次使用會透過 Hermit 取得執行環境；服務所需 Key/網路 | 待 Mac 連線驗收 |
| Git / GitHub MCP | 本機 Git；MCP 的 Node 執行環境/服務配置；GitHub 憑據。Windows 絕對路徑需在 Mac 重新設定 | 待 Mac 真實倉庫與服務驗收 |
| 記憶 | 現有使用者目錄與 SQLite；Hindsight 等外部後端另需服務 | 待跨重啟讀寫驗收 |

桌面部署基線更新為 macOS 14，因為原生執行層使用 ScreenCaptureKit 的 SCScreenshotManager。一般 Peekaboo Controller 仍另需 15+；專用驗收 Agent 使用封裝的 Go/Swift helper。TCC 權限需要使用者在系統設定授予；Finder 啟動和權限歸屬仍待實機核對。

## 簽名與驗收

本機未簽名測試不需要 Apple 憑據。正式分發需要 Developer ID Application 憑證與私鑰，以及 `APPLE_TEAM_ID`、`APPLE_ID`、`APPLE_ID_PASSWORD`（App 專用密碼）；可用 `KEYCHAIN_PATH`。沿用 Forge/osx-sign 與 notarization，按當前 API 使用 `optionsForFile` 提供 entitlements。Gatekeeper、簽名、公證與授權均未驗證。

煙測以隔離 profile 和中文工作區啟動真實 `.app`，經 preload IPC 驗證檔案讀寫/搜尋、PTY 實際輸出/工作目錄/resize、WebContentsView 本機 HTTP 標題；輸出 `out/macos-smoke-ARCH-*/` 日誌、圖片和 JSON。保留 Node inspector fuse，使用 Chromium CDP。這是可執行的受控煙測，**不是已完成的使用者 UI 全流程驗收**。

每個架構仍需：Finder 啟動、實際點擊檔案編輯/儲存、多終端輸入與關閉、瀏覽公網 HTTPS/前進後退/縮放、授予 TCC 後觀察→操作→再觀察、搜尋/Git/GitHub MCP 真正呼叫、記憶寫入並重啟讀回、`codesign --verify --deep --strict`、簽名發行的 `spctl --assess` 與 `xcrun stapler validate`。需要可執行 GUI 的 arm64 / Intel Mac；CI 可補建置與受控煙測，不能替代所有人工授權與操作。

## 2026-09-30 本機驗證記錄（歷史）

Windows x64，Node 22.23.2（低於 package engines 的 Node 24 要求）；以下結果只代表此本機環境。命令 cwd 為 `ui/desktop`，直接使用已安裝工具以避免 pnpm 自動同步。

- `node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/workspace-panel src/components/Layout/AppLayout.test.ts`：退出 0，26/26。
- `node ../node_modules/typescript/bin/tsc --noEmit`：退出 0。
- `node --test scripts/macos-package.test.cjs`：退出 0，12/12，證據 `target/macos-package-tests.log`；包含工件校驗、清單缺失/替換與架構拒絕。Mach-O 夾具不執行 macOS 二進位。
- `node --test --test-reporter=spec scripts/codebuddy-distribution.test.cjs`：退出 1，31/34；證據 `target/macos-distribution-tests.log`。失敗來自既有模型/供應商技術名稱中文檢查、`tokens` / URL / Terminal JSX 文案，以及 Windows 腳本 jobs 固定為 1 的斷言。這些來源本次未修改。
- 第一次 pnpm 驗證命令意外觸發快取依賴同步（下載 0、增加 21/移除 80）及 SDK postinstall，該命令已中斷；產生的 SDK 原始碼無新增 Git 差異。postinstall 清除了 `.vite` 開發快取。此命令不列入通過結果。
- 本輪三個終端 TypeScript 檔案的 ESLint：退出 0。
- Rust/macOS 建置、真實 macOS 煙測、完整 UI、TCC、簽名/公證：NOT_RUN。

## 參考


- [Electron Forge signing](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [Apple disk image packaging](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
- [node-pty ASAR helper issue](https://github.com/microsoft/node-pty/issues/923)
- [node-pty helper execute permission issue](https://github.com/microsoft/node-pty/issues/850)
- [Peekaboo upstream](https://github.com/steipete/Peekaboo)

- [Apple ScreenCaptureKit capture API, macOS 14+](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager/captureimage(contentfilter:configuration:completionhandler:))
- [Pinned Qwen upstream, MIT](https://github.com/QwenLM/open-computer-use/tree/24b7cae4d449a5a8ea58c583e5151096b26de03c)
