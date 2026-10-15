# Mac 清理與恢復適配方案（已批准分階段實作）

2026-10-05：使用者在具體方案與批准問題後要求繼續開發以對齊 Windows，據此依原邊界分階段實作；這不代表清理寫操作已通過驗收。

[简体中文](MACOS_CLEANUP_DESIGN_ZH_CN.md) · [English](MACOS_CLEANUP_DESIGN_EN.md)

## 目標與當前事實

2026-10-05，既有 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加待提交合併及 dirty 修改。目標是移植 Windows 的精確目標審核、確認隔離、恢復、再次確認永久刪除及中斷恢復流程。最新已交付為 bundle23；階段 22 的內部唯讀準備已包含在其重建後端中，但未啟用產品清理操作。

Windows 實作在 `crates/goose/src/acp/server/workspace_lease.rs`，透過持有的物件 handle 重新命名／刪除。Mac 的 `workspace_lease_macos.rs` 目前僅有內部唯讀清理準備；共用 allocation 中 `CleanupAudit` 仍限 Windows。既有 UI `RootCleanupInline.tsx` 和 `acp/rootCleanup.ts` 已有完整交互入口。owner 是 ACP 宿主及 cleanup registry/journal，UI 僅投影結果；專案建立權限不產生清理權限。

## 實機實驗與方案比較

在真實 arm64 / macOS 26.6.2 的全新合成暫存目錄執行三項實驗，命令退出 0，3/3 觀察符合預期；所有夾具保留。證據 `target/macos-parity-20261005/cleanup22-primitives.json`。這是 OS 行為實驗，不是產品清理驗收。

| 路線 | 證據與限制 | 決定 |
| --- | --- | --- |
| 路徑檢查後 rename/unlink | 開啟目標後更換同名檔案，renameatx_np 實際移走替換檔案；持有舊 fd 不足以綁定來源 | 拒絕作為精確物件實作 |
| 目錄 fd + RENAME_EXCL | 恢復遇同名檔回傳 EEXIST，兩份內容保留；父目錄改名後操作仍跟隨原目錄物件 | 可用於防覆蓋及定位，不單獨證明來源身份／授權路徑 |
| CoreServices 物件引用 | 專案已限於新建空目錄回滾使用 FSRef；Apple 已棄用並記錄 APFS inode 相容成本 | 只作候選原型，先證明精確引用與競態合同，未證明前不啟用破壞操作 |
| 直接交給系統垃圾桶 | 不提供目前應用的令牌、兩次確認與持久恢復合同 | 不作為合同等價替換 |

只使用現有系統 API／libc，不新增第三方依賴或複製外部原始碼。官方原始碼僅用於查證接口。

## 已批准的實施邊界

1. **審核與共用合同**：復用既有七個 root-cleanup 方法的業務語義、session/run/sourceMessage/nonce 綁定與生命周期屏障。抽取必要的共用型別及策略，Windows 保持現有 native 操作。Mac 先實作不修改目標的內部審核，尚不對使用者宣告整條清理可用。
2. **平台物件操作**：只對一個明確選中的一般檔案或空目錄操作；沿用保守暫存／快取／建置允許規則、專案重疊排除、符號連結拒絕及多硬連結拒絕。原生候選必須證明替換後不操作其他物件、祖先變動不擴張邊界、內容變更使確認失效。不得把「移錯後再恢復」算作精確目標通過。若原型未達標，寫操作保持禁用，報告新證據後再決定；不降級為純路徑刪除。
3. **隔離與恢復**：首次確認只移動到同卷專用隔離目錄；原路徑已占用時保留兩份資料並回報恢復待處理。永久刪除須獨立再次確認。過期／撤銷／重啟不恢復刪除授權，只允許既定恢復／診斷路徑。
4. **持久化**：復用既有日誌階段、完整性驗證及 owner lock 設計；Mac 記錄使用平台／schema 標記與獨立命名空間，物件身份包含原生裝置／完整 inode／必要的引用資料。Windows 舊日誌原樣可讀，不自動轉換；未知平台／版本拒絕修改目標。日誌不存可在重啟後復活刪除權限的活令牌。具體物件引用持久化需以原型證據決定，未知部分不得先當作可用。
5. **整合與交付**：全部原生操作及恢復門禁通過後才接通 Mac ACP/Agent 清理入口，沿用現有 UI 確認流程；有新增能力協商時保留舊 Windows 客戶端行為。更新權威地圖的批准修訂、三語說明與來源清單，再產出獨立候選安裝包。

## 必須通過的驗收

- 審核零改動；單檔／空目錄、Unicode／空格、非法路徑、專案重疊、連結及讀取拒絕。
- 來源替換、祖先改名／替換、同名恢復衝突、內容／硬連結計數變更；失敗不觸碰其他物件。
- 錯誤會話／run／訊息、重複令牌、並發確認、過期、關閉／歸檔／刪除、重啟舊令牌拒絕。
- 各日誌提交邊界故障注入、完整性破壞、隔離目錄替換、原位置占用與恢復重試；永久刪除不因恢復而獲得授權。
- 每一階段完成相關 Rust 測試／fmt／Clippy；共享合同同時驗證 Windows。原生測試通過後做安裝副本 ACP 流程，再做真實桌面審核→取消→隔離→恢復→再次確認刪除，全程只用專用合成資料。
- Intel、最低支援 macOS、TCC／鑰匙圈待處理狀態分列，未執行不計通過。僅方案／文件修改不重新打包。

## 為何此處需要方案批准

根 `AGENTS.md` 的「需要授權」要求新增核心抽象、改變持久化語義或權限邊界前提供方案比較及遷移邊界。權威地圖明確規定「文件清理权限不由创建权限派生」。本次批准對象是以上分階段原生清理適配及相關三語文件／來源同步；測試僅限新建隔離夾具，不含使用者真實檔案清理、系統權限設定、依賴安裝或 Git 分支／提交／推送。

## 現有 UI／ACP 基線

本機以隔離替身執行 `node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/codepro/RootCleanupInline.test.tsx src/acp/rootCleanup.test.ts`，cwd `ui/desktop`，9/9 通過，退出 0。覆蓋現有兩次確認／取消與恢復合同；不包含真實 Mac 檔案修改或桌面操作。日誌：`target/macos-parity-20261005/cleanup22-ui-baseline.log`。

## 階段 22：唯讀檢查已實作，寫入操作門檻待滿足

抽取 Windows 既有的清理白名單、專案邊界與摘要結構至 `workspace_lease/cleanup_policy.rs`；Windows 原生 handle 操作及舊日誌格式維持原有語意。Mac 新增 `cleanup_macos.rs` 與八項原生回歸，持有目錄／檔案 fd，檢查一般檔案或空目錄、連結、專案重疊、路徑綁定、內容摘要與中繼資料版本；再次驗證時重新讀取專案登記事實。讀取遭拒時回傳錯誤，不變更目標權限。

這是內部準備模組，尚未連接 Mac 清理 RPC／UI，也未建立清理權杖或啟用隔離、還原、永久刪除。模組上的局部 dead_code 標記於寫入操作門檻通過、正式接入時移除。

候選 API 進一步驗證：FSRef 兩個順序情境符合預期，200 次並行交換實驗未觀察到誤移；這只是有限實驗，Apple 明確記錄 FSRef 的路徑競爭限制，尚未證明既定精確物件合同。F_SETLEASE 在一般應用程式環境回傳 EPERM；XNU 實作要求私有 file-leases entitlement，不作為產品可依賴路徑。不加入私有 entitlement、不放寬為路徑刪除、不採用誤移後回復。

下一門檻為確定可散布且符合原合同的物件操作方案；其後才實作隔離日誌、還原、再次確認刪除並接入 ACP。目前準備程式碼不構成清理功能驗收或新安裝包交付。

證據：`target/macos-parity-20261005/cleanup22-{fsref-candidate,fsref-race,lease-candidate}.json`。測試最終狀態見同目錄 `cleanup22-state.json`。

驗證結果：Windows 相關 Rust 72/72、Mac 原生 Rust 22/22（新增 8 項），兩端 Clippy 與 Mac fmt 退出 0。Mac Clippy 有 7 條本輪未修改模組的警告。完整桌面清理為 NOT_RUN；未產生新安裝包。

## References

- [Apple renameatx_np / RENAME_EXCL semantics](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/man/man2/rename.2)
- [Apple File Manager deprecation and APFS guidance](https://developer.apple.com/documentation/coreservices/carbon_core/file_manager)
- [Apple FSMoveObject object-reference signature](https://developer.apple.com/documentation/coreservices/1566291-fsmoveobject)

- [Apple Secure Coding Guide: FSRef and path races](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/Articles/RaceConditions.html)
- [Apple XNU: allow_setlease and private file-leases entitlement](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/vfs/vfs_subr.c)

## 2026-10-07 已批准的只讀交付順序（stage28）

使用者在具體提案後回覆「允许」，批准先接通 Mac 審核與取消，修訂上方第 5 步的交付順序。完整物件操作與恢復門檻保留。

共用既有 audit/cancel 路由與能力來源；回應及 Agent 通知新增 executionAvailable，Mac 為 false、Windows 為 true。舊 Windows 回應缺省保持既有語義，非法非布林值拒絕。前端顯示只讀摘要與取消，不顯示破壞性確認及恢復面板；後端仍拒絕另外五個入口，包含舊客戶端呼叫。

Mac 回執只在記憶體保存 Inspection 及原能力；提交／取消／撤銷共用回執到能力的鎖順序。取消不延長原有效期，過期與重啟不恢復權限。檢查仍拒絕連結、專案重疊及變更目標，並保持目標零寫入。Windows 隔離日誌與寫入合同保持既有語義。

驗證使用原生臨時檔案、ACP／元件回歸、真實瀏覽器的隔離介面，以及新安裝包的 ACP 檢查；完整 Electron 操作另列。結果見 MACOS_PARITY_ZH_TW.md。協議沿用 [ACP extension methods](https://agentclientprotocol.com/protocol/v1/extensibility)，新增欄位限於既有自訂回應／通知資料，不擴充標準 ACP 型別。
