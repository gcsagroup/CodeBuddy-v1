# 回复语音播报与 TTS 设置

基于 `D:\Projects\CodeBuddy-v1` 的 `main@d464cc3` 加本地改动；本批未提交、未推送。沿用已有 Electron/TypeScript 与 Harness 本地兼容服务，不新增依赖。

## 使用与配置

设置 → 模型与运行 → 语音识别与合成中，新增完整的合成服务配置卡：接口地址、模型名称、保存并检测、检测连接、放弃修改及连接状态。ASR 与 TTS 各自保存；保存前重新读取配置，保留其他服务和未知字段。检测会实际合成短句验证音频响应，但不会播放。

回复播报默认接口为 `http://192.168.50.231:18004/v1/audio/speech`，模型为 `Qwen3-TTS-12Hz-0.6B-Base-INT4`。设置保存在现有 `SPEECH_SERVICES` 的 `REMOTE_TTS_URL` / `REMOTE_TTS_MODEL`，保存后新播报立即使用。可选密钥沿用独立 secret 配置项 `REMOTE_TTS_API_KEY`，不放入 URL 或播报协议。此配置用于回复播报；已有电话专用链路仍使用其原配置。

助手最终回复的“复制”左侧显示“语音播报”。点击后才连接合成服务，按钮变为“停止播报”；再次点击、切换到其他回复或卸载当前消息组件会立即停止音频并停止提交旧回复后续片段。用户消息不显示该按钮。仅打开聊天、收到回复或进入设置不会自动合成。

播报使用该回复原有正文数据，解析 Markdown 后读正文、链接标题和代码文字，不读格式标记、链接目标、时间戳或操作栏。没有正文时不显示播报入口。

## 流式实现与边界

- `runtime/speech-playback.mjs` 读取配置、校验接口与输入、分段请求 TTS 并转发 PCM。新 `/speech-playback` WebSocket 复用现有本地运行时 token 认证，不进入 Agent 执行或保存音频。
- 首段最多 16 字符，后续最多 90 字符，遇标点提前分段。分段仅用于播放，不判断意图或任务状态。每段 `model/input/stream:true/response_format:pcm`，同一服务地址的播报串行合成，浏览器边接收边播放；仅对尚未接受的 HTTP 429 请求短暂重试。
- 支持现有 QwenTTS NDJSON（`chunk.audio_b64` / `done`）与原始 `audio/pcm`、`audio/raw`、`application/octet-stream` PCM 响应；音频须为 24 kHz 单声道 PCM16。仅输出 MP3/WAV 的服务尚不支持。
- `speechPlayback.ts` 在用户点击时启动 AudioContext，顺序调度 PCM buffer，并在实际播完每块后发送确认。后端最多提前发送约四秒音频，避免长回复堆积。一个页面只播放一条回复。
- 单次正文最多 60000 字符。每段请求超时 120 秒，首次连接等待 30 秒；停止会立即中止本地播放；已提交的当前片段继续在后台读到结束回执，随后新播报才进入远端槽位，旧回复后续片段不再发送。失败统一在右上角铃铛通知中提示，不在消息操作栏显示，也不自动重播。

## 验证

以下为当前工作区的隔离验证，未修改生产会话或用户配置：

- `node --test runtime/tests/speech-playback.test.mjs runtime/tests/loopback-transport.test.mjs`：7 项通过、退出码 0，覆盖按需触发、配置透传、分段顺序、PCM 分片、停止取消、不可用服务、播放背压及认证。加入 429 重试后单独重跑 `speech-playback.test.mjs` 的 6 项，退出码 0。
- `npm --prefix ui/desktop run test:run -- src/components/settings/models/SpeechSettings.test.tsx src/components/settings/models/ModelsAndRuntimeSettings.test.tsx`：17 项通过、退出码 0，覆盖两类设置独立保存、检测、保留最新 ASR 值及无自动合成。
- `npm --prefix ui/desktop run test:run -- src/components/MessageCopyLink.test.tsx`：6 项通过，验证按钮顺序、点击触发、用户消息排除与正文提取。
- `npm --prefix ui/desktop run test:run -- src/components/GooseMessage.stream.test.tsx src/components/GooseMessage.handoff.test.tsx`：22 项通过、退出码 0，验证实际消息组件的流式及交接显示。
- `npm --prefix ui/desktop run typecheck` 与新增/修改组件的定向 ESLint：通过。
- 显式设置 `SPEECH_LIVE_TEST=1` 后执行 `npm --prefix ui/desktop run test-e2e -- speech-playback.browser.spec.ts --reporter=list`：真实浏览器组件与 QwenTTS 联调，覆盖无自动连接、非零音频、完整播放、切换、停止及设置检测；配置使用隔离夹具。截图在 `ui/desktop/test-results/speech-playback.png`。

首次热服务样本，点击到首块音频排入播放约 240ms（请求发出到排入播放约 159ms）。这不是冷启动保证、P50/P95 或物理扬声器延迟；真实桌面人工听感尚待验收。

正文提取调整后的最终源码浏览器复测同样通过：点击到首音频排入播放约 332ms，请求发出到排入播放约 153ms。两次样本仅用于核实链路，不作为普遍延迟承诺。

桌面使用仓库入口 `./start-preview.ps1 -SkipOptionalToolCheck`，沿用此前已授权的可选 MCP 工具检查跳过方式；后端新增路由需要退出旧窗口后重启。

## 2026-11-27 切换与文本修复

远端只读日志显示，客户端断流可触发 HTTP handler 未捕获的 `ConnectionError`，随后新任务返回零音频 error；其单槽锁可能在工作进程完成前释放。本地改为按服务地址串行交接，停止播放后排空已接纳片段的回执，不主动断开这个 HTTP 请求；不修改远端部署。这样避免通过取消连接触发该竞态，代价是新播报可能等待当前短片段收尾。等待期间按钮显示旋转加载图标和“等待播报…”，可以再次点击取消；开始出声后显示停止按钮。

正文清理增加组合表情、肤色、旗帜、键帽与装饰符号过滤，保留正文、正常标点、时间和数字；纯符号内容不合成。错误由已有 `ModelInventoryNotice` 铃铛区域展示，含预览、计数和关闭操作，不伪装为模型连接错误。

验证：`speech-playback.test.mjs` 覆盖排空旧片段后才提交新播报及跳过纯标点；`MessageSpeechButton.test.tsx`、`ModelInventoryNotice.test.tsx`、`MessageCopyLink.test.tsx` 共 19 项通过（退出码 0）。真实浏览器连续三次在第一条已出声时切换，并等待第二条成功出声，全部通过；同时验证右上角错误提示与关闭。类型检查和定向 ESLint 通过。此前只验证切换后立即停止的浏览器场景不足以覆盖用户反馈，本次已替换为真实出声验证。
