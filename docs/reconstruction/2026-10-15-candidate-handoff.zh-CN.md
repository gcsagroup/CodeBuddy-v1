# 2026-10-15 首版候选交付核对

08:54 北京时间：当前为 Windows 源码开发预览，全部功能尚未完成验收，非正式安装包。

## 当前候选与启动

目录 D:\CodeBuddy-v1，无 .git；没有新建分支、提交、推送或安装依赖。启动前逐项核对 overnight-source-context-ui.json 的156个文件，全部指纹一致。本轮没有修改产品源码。

按 README 执行 start-preview.ps1（仅设置已有 CODEBUDDY_PREVIEW_DEVTOOLS_PORT=9387 供本地验收）。08:52启动，launcher22692、Harness runtime24552、desktop launcher7796；exec53339保持运行，未记作退出0。默认数据 .preview-data，默认工作区 D:\CodeBuddy-Workspace。启动回执 .preview-data/logs/preview/launch.json。之前的默认和隔离进程均已退出，旧 running 回执不再代表存活。

日常启动：在 D:\CodeBuddy-v1 执行 .\start-preview.ps1。请使用这个入口；旧 start-gui / Forge安装包仍走旧后端，Harness安装包资源与接线待完成。

## 本轮新证据

- 真实默认 Electron + 原 Kimi 配置：你好正常回复；冷启动工具/会话准备3996ms，模型首块2206ms，流结束3526ms、106块。冷创建页面计时因测试URL参数大小写写错而作废。
- 第二个新会话页面创建955ms，准备916ms，共享MCP reused=true；模型首块2254ms、流结束3687ms。commonqueries/autovisualiser仍有会话级准备，不能称所有工具零准备。
- 原会话追加条件、切换返回历史、修正750→625基点，保留MORNING-625、运费350分不征税；正确10975分。4轮均Harness completed/harness_turn，未见虚假中断。
- 首次第二会话脚本在导航尚未结束时发送到了旧会话，因此该次不计新建耗时；随后等待新任务页就绪再实测955ms。
- 原635会话ID全部保留；默认模型/提供商/配置整体哈希不变；旧日程仍暂停。未将隔离测试配置覆盖用户配置。
- 回执 .preview-evidence/default-candidate-morning.json，截图 default-candidate-morning.png；诊断在默认 runtime.log。原始秘密没有写入验收回执。

## 复用已有有效验收

- 后端367/367（零失败/取消/跳过，exit0）；最新阈值前端53/53、配方断线40/40及相关TypeScript/lint exit0，详见专题。各组有重叠，不相加当全集。
- 十二模块项目23分39秒，11次原生目标续跑、31次成功自动压缩/38次尝试、独立82/82测试，暂停和后端重启续跑；7次未缩短摘要被拒绝。
- 另真实UI五批材料4次成功自动压缩，阈值保存99%/35%并恢复80%；显示压缩进度及用量下降。重载、后端重启第八轮仍保留修正和待办，金额10975分。当前上下文是本地估计，非精确计费token。
- 电脑控制真实点击/输入/键盘/滚动、主视觉及辅助降级；新增技能发现执行、附件、审批、设置、记忆、历史、工作区、部分Git/配方/日程均有专题证据，具体覆盖以功能矩阵为准。

## 明确剩余项

Harness安装包接线与macOS实机验收；高级配方retry/sub_recipes/response.json_schema；非零秒七字段cron；普通聊天部分入口；远端Git冲突/GitHub/OAuth/PR/CI等外部流程；真实麦克风/云语音及本地ASR下载；外部技能下载。用户默认辅助视觉尚缺配置，隔离环境通过不代表默认已配置。小时级、生产规模项目尚未证明。

首响应波动未彻底解释：夜间直接Harness也出现32.745/47.952/115.878秒首增量；本轮约2.2秒不抹去先前慢样本，仍需分辨模型服务排队/推理与网络贡献。没有把全部延迟归因CodeBuddy，也没有宣称性能全面修好。

本轮仅交付已启动候选与实际证据。09:00汇总后按约停止重复验收，等待用户后续选择。
