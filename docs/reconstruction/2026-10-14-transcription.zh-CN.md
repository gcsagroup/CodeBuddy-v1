# 语音转写基础接入

本批在 `D:\CodeBuddy-v1` 增加 `runtime/transcription.mjs` 及 `runtime/tests/transcription.test.mjs`，没有改动 renderer、兼容层或设置模块。基线见 `source-baseline.json`；没有建立分支、提交或推送。

原界面的麦克风、录音和分段逻辑保持原样，`useAudioRecorder` 生成 16 kHz、单声道 PCM16 WAV，再通过 `_goose/unstable/dictation/transcribe` 发送 `{audio,mimeType,provider}`，返回 `{text}`。转写文字仍由原输入框决定何时提交，不直接触发 Agent。

宿主接口为 `new TranscriptionService(store,{resolveOpenAI?})`，提供 `handles(name)`、`request(name,params,connection)`、`disconnect(connection)` 和 `close()`。路由支持完整前缀或去前缀的 `dictation/config`、`dictation/secret/save`、`dictation/secret/delete`、`dictation/transcribe`。断线时取消该连接的请求，关闭时取消全部请求。

OpenAI 默认只使用明确的 `OPENAI_BASE_URL` / `OPENAI_HOST` 与受保护的 `OPENAI_API_KEY`，或模型列表中 `id/catalogProviderId=openai` 的连接。多连接时优先所选匹配连接；仍有歧义则显示未配置。不会把当前 Ollama 或其他未指定连接的凭据借给转写。`resolveOpenAI({includeSecrets})` 可由主集成层提供，返回 `{baseUrl,apiKey?,headers?,configured}`。配置查询传入 `includeSecrets:false`，只读状态，不要求解密密钥；请求时才获取凭据。OpenAI 继续使用原“设置 > 模型”入口。

Groq 与 ElevenLabs 使用原语音设置的密钥表单，分别存到 `state.config.GROQ_API_KEY`、`ELEVENLABS_API_KEY`，复用宿主 DPAPI 保护，查询只返回配置状态。三个原模型键继续有效：`OPENAI_TRANSCRIPTION_MODEL`、`GROQ_TRANSCRIPTION_MODEL`、`ELEVENLABS_TRANSCRIPTION_MODEL`。默认分别为 `whisper-1`、`whisper-large-v3-turbo`、`scribe_v2`；明确保存的模型值保持优先。ElevenLabs 官方已宣布 `scribe_v1` 于 2026-07-09 移除，因此没有继续使用旧源码中的退役默认值。[官方变更记录](https://elevenlabs.io/docs/changelog/2026/6/8)。

传输复用 Node.js 标准 `fetch` / `FormData` 和服务原生 multipart 协议；音频校验复用已安装 Harness 的 `validateWave`。原 MIME 列表继续支持 WAV、WebM、MP4、MPEG、MPGA、M4A；WAV 遵循原前端生成的标准格式。音频最大 50 MiB、单次请求默认 30 秒、返回内容最多 1 MiB，最多 4 个并发请求。服务自身的上传额度仍可能更低。请求不跟随 HTTP 重定向；服务错误、响应正文、URL 查询及凭据不会进入 RPC 错误。录音和转写结果不由此模块落盘。

`node --test runtime/tests/transcription.test.mjs` 在既有 Node.js 24 下执行，7 项通过，0 失败，退出码 0。测试使用真实临时状态目录和本地 HTTP 服务，覆盖原 SDK 合同、三个服务的实际 multipart 字段和鉴权头、模型覆盖、凭据重启保存、网关路径与查询、损坏音频、状态错误、响应限额、断线/超时/关闭取消。所有上游服务地址在测试中显式重定向到本地夹具，没有请求用户真实账户，没有采集麦克风。

本地 Whisper/SenseVoice 运行时和模型下载尚未接入；`local` 转写明确返回 `local_dictation_unavailable`，配置列表不伪造可用本地模型。真实云端转写及桌面麦克风用户流程仍需已配置服务后的独立验收。

协议参考：[OpenAI transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)、[Groq speech-to-text](https://console.groq.com/docs/speech-to-text)、[ElevenLabs transcript](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)。本批没有新增或安装依赖。
