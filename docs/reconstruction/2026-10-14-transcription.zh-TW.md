# 語音轉寫基礎接入

本批在 `D:\CodeBuddy-v1` 增加 `runtime/transcription.mjs` 及 `runtime/tests/transcription.test.mjs`，未變更 renderer、相容層或設定模組。基線見 `source-baseline.json`；未建立分支、提交或推送。

原介面的麥克風、錄音及分段邏輯維持原樣，`useAudioRecorder` 產生 16 kHz、單聲道 PCM16 WAV，再透過 `_goose/unstable/dictation/transcribe` 傳送 `{audio,mimeType,provider}`，回傳 `{text}`。轉寫文字仍由原輸入框決定何時提交，不直接觸發 Agent。

宿主介面為 `new TranscriptionService(store,{resolveOpenAI?})`，提供 `handles(name)`、`request(name,params,connection)`、`disconnect(connection)` 及 `close()`。路由支援完整前綴或去前綴的 `dictation/config`、`dictation/secret/save`、`dictation/secret/delete`、`dictation/transcribe`。斷線時取消該連線的請求，關閉時取消全部請求。

OpenAI 預設只使用明確的 `OPENAI_BASE_URL` / `OPENAI_HOST` 與受保護的 `OPENAI_API_KEY`，或模型清單中 `id/catalogProviderId=openai` 的連線。多連線時優先所選相符連線；仍有歧義則顯示未設定。不會將目前 Ollama 或其他未指定連線的憑證借給轉寫。`resolveOpenAI({includeSecrets})` 可由主要整合層提供，回傳 `{baseUrl,apiKey?,headers?,configured}`。設定查詢傳入 `includeSecrets:false`，只讀取狀態，不要求解密金鑰；請求時才取得憑證。OpenAI 繼續使用原「設定 > 模型」入口。

Groq 與 ElevenLabs 使用原語音設定的金鑰表單，分別存至 `state.config.GROQ_API_KEY`、`ELEVENLABS_API_KEY`，重用宿主 DPAPI 保護，查詢只回傳設定狀態。三個原模型鍵持續有效：`OPENAI_TRANSCRIPTION_MODEL`、`GROQ_TRANSCRIPTION_MODEL`、`ELEVENLABS_TRANSCRIPTION_MODEL`。預設分別為 `whisper-1`、`whisper-large-v3-turbo`、`scribe_v2`；明確儲存的模型值保持優先。ElevenLabs 官方已宣布 `scribe_v1` 於 2026-07-09 移除，因此未沿用舊原始碼中的退役預設值。[官方變更記錄](https://elevenlabs.io/docs/changelog/2026/6/8)。

傳輸重用 Node.js 標準 `fetch` / `FormData` 與服務原生 multipart 協定；音訊驗證重用已安裝 Harness 的 `validateWave`。原 MIME 清單繼續支援 WAV、WebM、MP4、MPEG、MPGA、M4A；WAV 遵循原前端產生的標準格式。音訊最大 50 MiB、單次請求預設 30 秒、回傳內容最多 1 MiB，最多 4 個並行請求。服務本身的上傳額度仍可能較低。請求不跟隨 HTTP 重新導向；服務錯誤、回應本文、URL 查詢與憑證不會進入 RPC 錯誤。錄音與轉寫結果不由此模組落盤。

`node --test runtime/tests/transcription.test.mjs` 在既有 Node.js 24 下執行，7 項通過，0 失敗，結束碼 0。測試使用真實暫存狀態目錄及本機 HTTP 服務，涵蓋原 SDK 契約、三個服務的實際 multipart 欄位與鑑權標頭、模型覆寫、憑證重新啟動保存、閘道路徑與查詢、損壞音訊、狀態錯誤、回應限額、斷線/逾時/關閉取消。所有上游服務位址在測試中明確導向本機夾具，未請求使用者真實帳戶，未擷取麥克風。

本機 Whisper/SenseVoice 執行環境及模型下載尚未接入；`local` 轉寫明確回傳 `local_dictation_unavailable`，設定清單不虛構可用本機模型。真實雲端轉寫及桌面麥克風使用者流程仍需已設定服務後的獨立驗收。

協定參考：[OpenAI transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)、[Groq speech-to-text](https://console.groq.com/docs/speech-to-text)、[ElevenLabs transcript](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)。本批未新增或安裝相依套件。
