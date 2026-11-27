# Haru 实时语音通话

> 历史实现记录：2026-11-27 已按用户要求替换为 GemmaE2B 原生语音输入 → 文本流 → QwenTTS。当前行为与验证以 [电话页说明](voice-call.zh-CN.md) 为准，以下 Haru 接口、文件名和 PID 不再是当前实现。

主对话右上角的电话按钮打开工作区内的通话页。开始通话时固定所选自定义智能体的名称与提示词；通话中不切换角色。挂断后可重新选择。关闭页面、切换会话或卸载组件会释放麦克风和远端会话。

波形下方始终显示实时字幕栏，尚未收到内容时显示等待提示；模型文字逐段追加，自动滚动到最新内容。角色提示词由运行时使用 Haru `/api/config` 返回的默认语言模板构造，按照官方人物设定、名称段落填入所选智能体的完整资料。原资料中的性别、用户称呼、关系和场景原样保留在人物设定内；缺省信息不通过关键词提取、猜测或套用网页示例补齐。音色继续使用服务默认参考音频，本版不提供音色设置。

当前服务为 `http://192.168.50.231:8998`。`runtime/voice-call.mjs` 通过受现有运行时密钥保护的 `/voice-call` WebSocket 转发 Haru 的就绪检查、角色会话创建、WebRTC offer/answer 与取消。远端地址由该模块持有，客户端不能指定任意代理目的地。音频经浏览器原生 WebRTC 直达 Haru；不会进入 ACP 消息、Harness 工具链或 ASR 听写流程。

`WorkspaceVoiceCall` 持有页面角色选择与 UI 展示；`HaruCall` 持有单次通话、麦克风、音频播放、静音和资源释放。通话字幕是 Haru 返回的模型文字，不是用户语音转写。人设超过服务声明的字符上限时明确报错，不截断设定。通话不保存音频或历史，也不执行 Agent 指令。

## 服务要求

- Haru `/api/ready` 返回 `ready: true`，`/api/webrtc/config` 返回 `enabled: true`。
- 配置中文默认参考音色，支持 `/api/session`、`/api/webrtc/offer`、`/api/webrtc/cancel`。
- 预协商 DataChannel `events`，ID 为 4。使用 `session.ready`、`text`、`error`、`session.done` 和 `session.end` 事件。
- 桌面与服务端能够通过 UDP 直连。当前服务使用空 ICE 服务器列表用于局域网，不依赖公网 STUN/TURN。跨网部署需要另外配置经过验证的 TURN 服务。
- 目前服务限制为单路通话、每次最长 600 秒。模型冷启动期间页面会显示未就绪错误，可稍后重新开始。

## 验证

运行时隔离夹具回归：`node --test runtime/tests/voice-call.test.mjs`。

前端类型检查：`npm --prefix ui/desktop run typecheck`。

真实服务浏览器测试（模拟麦克风，不使用个人数据）：在 PowerShell 设置 `$env:HARU_LIVE_TEST='1'` 后运行 `npm --prefix ui/desktop run test-e2e -- voice-call.browser.spec.ts --reporter=list`。未显式设置时跳过，避免普通测试自动占用远端模型。它检查真实 RTP 收发、静音、挂断及重新接通，不能替代真实麦克风的听感、回声和端到端延迟验收。

桌面源码启动仍使用仓库根目录 `./start-preview.ps1`；没有新增依赖或独立启动入口。

## 2026-11-27 验证记录

源码基于 `main@d464cc3`，本次改动未提交或推送。类型检查、定向 ESLint、`git diff --check` 均退出 0；运行时通话与认证测试 5/5、麦克风生命周期测试 3/3、真实 Haru 浏览器电话页测试 1/1 通过。浏览器使用模拟麦克风验证真实 RTP 双向传输、持续连接、静音、挂断和重新接通；未进行真实麦克风的 Electron 产品听感验收。

远端使用原有 `/ssd/shared/External/Haru/venv`，按上游约束安装 `aiortc==1.15.0`（带入 `av==17.1.0` 等依赖），启动参数改为 `--webrtc on --ice-servers /ssd/shared/External/Haru/ice-servers-lan.json`。原启动脚本保存在 `start-haru.sh.before-webrtc-20261127`，安装前依赖清单为 `requirements-before-webrtc-20261127.txt`；未改动其他模型服务。最终 `/api/ready` 为 true，WebRTC enabled 为 true。

性能尚不满足稳定实时：本次冷启动权重加载 289.4 秒，预热 185.7 ms/帧，高于 133 ms 音频帧预算。持续通话测试日志记录收到 11.1 秒用户音频、发送 6.2 秒模型音频、播放欠载 4940 ms。该数据证明当前部署存在产生音频速度不足的问题，不能把传输连通测试视为低延迟体验通过；没有测得真实发言结束到首段可播放回复的 P50/P95。

桌面已从当前目录启动（后端 PID 1012，桌面启动器 PID 40072），运行时 source hash 为 `21a44a84a0a01960f3ebb81101c6dfffca0161f33c1920928c7a733d8d374864`。普通启动因既有 `qwen-computer-use.exe` 与 main 登记哈希不符被阻止，最终使用现有 `-SkipOptionalToolCheck` 参数启动；未替换该工具，可选工具校验问题仍待处理。

## 后续修复：有回复但听不到声音

上一阶段的 RTP 连通检查不足以证明声音正在播放。使用固定合成语音复现时，旧 WebAudio-only 接收出口已经收到模型文字，但 WebRTC `inbound-rtp` 的 `totalSamplesDuration` 与 `totalAudioEnergy` 均为 0。改为原生 `HTMLAudioElement.srcObject` 并显式 `play()` 后，相同测试的播放时长约 13.8 秒，能量约 0.228，字幕正常。挂断会暂停播放并清空 `srcObject`，播放失败明确报错。该对照确认了客户端音频出口问题，与上节服务推理吞吐瓶颈是两个不同问题。

最终角色模板版本再次验证了约 13.7 秒非零音频播放，并返回包含测试角色名的字幕。真实服务测试增加了实际播放时长和音频能量断言；设置 `HARU_TEST_AUDIO` 为本地测试 WAV 路径可启用语音回复断言，该 WAV 不纳入提交。运行时 6 项、麦克风生命周期 3 项、真实服务浏览器 1 项均通过，类型检查、定向 ESLint 与 diff 检查通过。真实用户麦克风的听感和说话结束到首段回复延迟仍待产品验收。上节 PID 和 hash 为上一轮启动记录，当前运行身份以 `logs/preview/launch.json` 为准。
