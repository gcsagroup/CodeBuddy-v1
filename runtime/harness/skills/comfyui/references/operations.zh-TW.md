# 模式、調參與故障處理

即時工具 schema 優先；這是 CodeBuddy 介面，不是原始 HTTP 參數。

| 目標 | 工具／inspect.mode | generate 素材 |
| --- | --- | --- |
| 文生圖 | generate_image / text_to_image | 不傳 reference_images |
| 編輯圖片 | generate_image / image_to_image | 1–2 張 reference_images，inspect 同樣傳入 |
| 文生影片 | generate_video / text_to_video | 不傳 image_path／reference_images |
| 首幀動畫 | generate_video / image_to_video | 一個 image_path |
| 身分／物體參考 | generate_video / reference_to_video | 1–2 張 reference_images |

圖片實際模式由 reference_images 決定；影片 generate 必須有 mode，不混用兩種素材欄位。R2V 不是首尾幀插值；介面沒有 last_frame、音訊／影片參考欄位，不因模型支援就發明參數。素材為工作區內普通 PNG，每張 ≤20 MiB、≤16,777,216 像素，解析後路徑仍須在工作區內。

## 呼叫與調參

[requests.json](requests.json) 每模式一例，只取當前需要的一項。工作流由當前請求解析器選擇，生成時省略 `workflow_name`；以看過的圖片路徑替換 `$image_1`／`$image_2`，依使用者需求重寫 prompt。不要提交占位符或整批範例。省略 request_id 由宿主分配 UUID，後續在原工具使用真實 job_id。

- 編輯要說明保留／改變範圍；介面沒有 mask，不保證像素級局部編輯。透明請求不等於實際 alpha。
- 尺寸保留就兩項都省略，覆寫就同時給 width、height，避免遺漏值默認 1024。圖片每邊 256–2048；影片 256–1344，總像素 ≤1344×768；均須為 32 的倍數。還需唯一 ResolutionSelector 與支援比例。
- 1024×576／576×1024 符合數值及比例條件，仍看圖是否可綁定。官方 1344×768 預設不是嚴格 16:9，不機械地當覆寫值傳回；保留原生尺寸應省略參數。
- duration_seconds 為秒，可含小數；保留秒轉幀與 fps。沒有唯一秒數入口就報告綁定缺口，不私改公式或縮短目標。
- 固定 seed 比較，省略則隨機。經使用者允許迭代後，盡量一次改一項，記錄 workflow.id／sha256、參數與產物。
- `tunable_parameters` 提供精確 parameter、current、所有 constraints／bindings；所有限制同時成立，保留數字／布林／枚舉型別。最多 32 個不重複 ID，省略保留原值，不跨圖重用 ID。
- 步數看 bindings.input=steps；branch_switch 是布林開關，true 對應 on_true、false 對應 on_false。檢查所有下游，不能從名稱／固定節點號猜 Turbo。
- Turbo 保持模型、LoRA 和采樣配置一致。強度、CFG、denoise、sampler、scheduler、ref_image_size 用 live 值；更多步數／CFG 不保證更好，不把 SD 負面詞套到無該分支的 H3。
- 覆寫形狀：`workflow_parameters:[{"parameter":"目前 inspect 的 ID","value":true}]`，實際 value 須符合語義；不新增頂層 steps、turbo_mode。

## 故障處理

| 證據 | 處理 |
| --- | --- |
| 連線／權限問題 | 使用應用既有設定，報告問題，不掃描位址、改憑據或裝客戶端。 |
| missing／blockers | 列出工作流與缺項；不猜圖、不自動安裝下載或換模型。 |
| ID／枚舉／比例／秒數綁定錯誤 | 重查選中圖，修正尚未提交的參數，超出能力就說明缺口。 |
| 提交／觀察不確定 | 原 ID 最多一次恢復查詢，仍不明就報告，不重複 generate。 |
| GPU OOM | 提出有依據的調整；未同意不縮短明確時長、不重啟或全域卸載模型。 |
| 空間／下載失敗或空產物 | 保留回執和舊檔，解決交付問題，不重生成或偽報完成。 |
| 取消未確認 | 如實說明，缺單任務介面時到 ComfyUI 停止，不發全域 interrupt。 |
| job 不存在／跨會話拒絕 | 回原會話查其 ID，不掃描或改寫回執。 |

## 條件建立

僅 inspect 的 creation_allowed=true 才考慮 fallback；按需用 node_types（≤24）取 schema，node_offset/next_node_offset 分頁。API graph 與 UI nodes/links 不同。使用已安裝節點、模型枚舉及合法連線；`$prompt`、LoadImage.image 的 `$reference:0`／`$reference:1`、顯式輸入的 `$width`／`$height`／`$seed`／`$duration_seconds` 按合同綁定。只有一個最終 PNG／MP4 保存節點；宿主重查資格和圖結構。不混用 workflow_parameters，不安裝下載或重啟來擴大範圍。

依據目前 `runtime/comfyui-*.mjs` 與[官方路由](https://docs.comfy.org/development/comfyui-server/comms_routes)，執行仍經宿主工具。
