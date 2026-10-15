# 真实 Kimi 暂停、服务重启与同任务恢复验收

2026-10-14，当前 `D:\CodeBuddy-v1` 源码；基线见 [source-baseline.json](source-baseline.json)。使用精确锁定的官方 Harness 0.2.1-alpha.2、原 ACP 控制接口和用户已配置的 kimi-k3。没有第二模型循环，没有安装依赖、Git 操作或外部业务写入。只复制默认 provider 一项到独立 profile；未修改原用户配置，也未覆盖此前真实验收回执。

命令：Node 24 执行 `scripts/accept-real-codepro-resume.mjs`。实际 10:23:50–10:27:43 UTC（约 233 秒），退出码 0。[完整回执](../../.preview-evidence/real-codepro-resume-qwEdcn/receipt.json)；[独立测试日志](../../.preview-evidence/real-codepro-resume-qwEdcn/independent-tests.log)。

## 经过与结构化事实

| 阶段 | 实际事实 |
|---|---|
| 原任务 | session `62c07f46-3c6b-43e9-b311-5240e2c34bd8`；run `a4b24ed2-f603-4649-979e-549c462218b9` |
| 计划与首个模块 | Kimi 创建 money → invoice-tests → verification。money 原生 write 成功回执 sequence 8，task_result succeeded 为 9 |
| 暂停 | 基于真实 task_result 通知调用 pause_run；pause_requested 10、attempt_finished 11。activeAttempt=null，pendingEffects=0，uncertainEffects=0 |
| 服务重启 | 关闭服务器及连接，新建 createCompatServer，重新 acquire lease、session/load；原事件序列逐项相等，保持原 runId |
| 恢复 | run/control resume_run 为 12，attempt_started 13；Kimi 先读取已有模块，再补 invoice、tests、package.json |
| 验证完成 | 源码检查后批准唯一固定 Node 测试命令；原生 verification exitCode=0，任务成功 27，run_completed 28、attempt_finished 29 |
| 独立复验 | 15/15 测试通过，退出码 0；第一模块 SHA256 和 mtime 不变，原事件前缀完整、原 write 回执仅一份；无待执行或不确定副作用 |

工具授权限定隔离目录与四个目标文件，恢复阶段禁止重写第一模块。shell 只批准固定本地测试命令；四个生成文件只包含本地模块、node:test、node:assert/strict 及包元信息，人工源码检查以文件哈希和 mtime 回执绑定后放行。测试过程没有执行网络、安装或 Git 工具。

脚本后续补严了 shell workdir、run_in_background、权限升级字段校验；实际记录的那次调用使用本隔离 workdir、未请求后台或升级，符合补严后的条件。相关权限与事件连续性回归 2/2；会话编辑 6 项及 ACP 编辑 1 项联合 9/9，退出码 0。

## 覆盖边界

这是一个实际云端模型通过 ACP、官方 Harness 原生工具和真实文件完成的恢复验收，非脚本模型回复夹具。暂停由已提交回执触发，没有用等待时间猜测状态；重启使用新的服务器实例，未杀宿主操作系统进程。第一阶段没有人为长时间写操作。

该结果不代表真实 Electron 关闭重开、macOS、强制杀进程时的工具副作用、大型仓库全量质量或持续数小时负载已经通过。测试项目用于验证执行与恢复链路，不作为生产财务库交付。真实 SIGKILL journal 恢复另有自动测试，不与本次主动停机混为一项。

若重新运行，脚本创建全新独立 profile；遇到固定测试命令审批，会生成 review-pending.json。检查四个源文件后，将该精确哈希回执保存为 source-review.json。脚本设九分钟总时限，超时保留可续的状态并报告 interrupted，不归因为产品缺陷。
