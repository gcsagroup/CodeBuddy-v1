# Harness 上下文与生成中压缩验收

候选：1.43.3-harness10。构建来源：D:\CodeBuddy-v1，main，01610d03764570282eee439cd2bfb49fcd373e98，加保留的前批与本批未提交修改。本批不提交或推送。

## 问题与修复

- 普通问候的主要固定开销是工具 schema 与系统说明，而非“你好”本身。用户原会话实际输入 6638 tokens，底部 7927 是 Harness 保守估算。43 个基础工具中包含 14 个 Git 包装工具和 4 个角色 Agent 包装工具；MCP 完整 schema 已是 0 个，但服务器说明仍被注入。
- 复用 Harness 注册表、提示装配钩子和原生工具执行，把 Git、角色包装和 MCP 的 schema 按需加载。服务器说明随对应工具加载；权限、工具箱目录、连接复用、子 Agent 调度保持原有职责。基础请求现在 25 个工具；原生文件、命令、通用子 Agent 等能力保留。
- 缩短空记忆策略说明，保留隔离、候选记忆审核与事实规则。宿主会话指令保持独立 section，防止被原生子 Agent persona 覆盖。全量回归曾发现此继承回归，修复并复测通过。
- 生成过程中用官方 BlockAssembler 与估算器投影流式增量，每 250ms 至多一次。它只用于显示，不参与压缩决策；持久化后的原生 token meter 覆盖临时估算，避免重复计算。
- SDK 会剥离 usage_update 的额外元数据。容量/用量来源通过现有 status_message.data 合同送至 UI，不修改生成 SDK；估算显示 ≈，未确认容量显示 ?，悬浮说明区分来源。临时流式投影不逐条写入历史。
- 32768 是 CodeBuddy 适配层在服务未提供元数据时的默认预算，并非每个模型的真实容量或 Harness 固定上限。读取服务元数据；设置新增按连接、模型配置部署容量的入口。配置受服务已知上限约束，清空恢复自动发现，下次发送生效。

## 压缩语义

Harness 原生 token meter 与 compaction 插件仍是事实 owner。阈值比例来自现有设置，按模型有效预算检查，工具 schema 参与压力计算。自动压缩在模型步骤边界发生，不在一次正在传输的回答中途截断；最终回答后高于阈值也可能等下一次模型步骤。实时计数与压缩事件是两回事，不把流式估算冒充计费量或压缩控制事实。

## 本批已完成验证

- Node 24：`--test --test-concurrency=2 runtime/harness/test/*.test.mjs runtime/tests/*.test.mjs`，退出 0，373/373。包括同一轮八次工具调用与多次原生自动压缩、流式更新经过真实 SDK 解析、MCP 200 工具按需加载/权限/重连、子 Agent 策略继承与并发上限、配置隔离。
- ui/desktop：`../node_modules/vitest/vitest.mjs run --maxWorkers=1`，选取 ModelContextSettings、ModelsAndRuntimeSettings、ContextWindowIndicator、gooseSessionNotifications 四个目标，退出 0，19/19；`../node_modules/typescript/bin/tsc --noEmit` 退出 0。
- 真实 Kimi-k3 ACP：独立工作区普通问候输入 4536 tokens，底部估算最终 5211；25 个基础工具、0 个 MCP schema。与原用户样本输入下降约 32%，不是跨模型保证。冷/热新会话总耗时 8.824/5.054 秒，不能把缓存后 1 个未缓存输入 token 当作全部输入（热样本另有 4535 缓存输入）。
- 真实 Kimi-k3 多模块：同一轮 233.278 秒、20 次工具调用、7 次成功原生自动压缩、256 次上下文相关更新。顺序读取六份合同，修复金额、发票、报表三个模块。独立执行测试退出 0；再由验收代码核对 9 条断言，覆盖六份合同的舍入、数量乘法、负数异常、空集合、金额格式、接口/依赖约束。
- 真实 MCP：模型自行搜索并调用时间工具，正常结束。并非仅检查工具清单。

## 本地证据与边界

原始日志、凭据隔离 profile、测试项目均位于忽略目录，不提交。自动化：.preview-evidence/context9-full-final.log、context9-ui-final.log、context9-typecheck-final.log。真实问候：context9-real-2g9Fg2/receipt.json；多模块：context9-real-klEBZ9/receipt.json、independent-contracts.json、backend/harness/sessions。

该多模块样本是数分钟压力验收，不等价于小时级生产大项目、所有技能或 macOS 全量验收。

## 桌面、安装与后续回归

1. harness9 桌面真实输入：新会话 1011ms 出现，首个正文 UI 10779ms；后台首轮准备 4496ms（adapter 1264ms、native setup 3232ms），请求到首个思考 4385ms、正文 4813ms。冷启动仍有准备/网络/模型等待，未宣称所有延迟已消除。
2. 实际设置界面保存当前 Kimi 容量 65536，下次对话显示 ≈5k / 66k；重新打开设置读到保存值；清空后下一轮恢复 33k?。仅隔离 profile 改动。
3. 桌面多模块任务 196738ms，5 次自动压缩。停止按钮仍显示时观察到 ≈5k、≈6k、≈13k、≈20k、≈14k、≈15k、≈16k、≈17k 等数值；压缩后继续执行。独立重跑项目 11/11 测试，额外 9 条合同断言通过。
4. harness9 实际安装退出 0；应用、asar、清单和 50 个运行源码文件指纹一致。安装版重启打开历史，并真实续聊正确复述 cents/invoice/report、101 分舍入、RangeError、USD 0.00，原生 turn/end 为 completed 且无工具调用。计时脚本曾因历史渲染/消息数量假设未收敛，不记为产品失败或脚本 PASS；另用可见最终正文与原生终态独立核实，记录在 harness9-installed-resume-verified.json。
5. 回放时发现已结束任务的通知过滤器会丢弃 context_meter 来源，导致 ?/≈ 暂时消失。harness10 把它与 usage_update 一样作为会话维护处理，不重开任务；新增回归先失败后通过。chatSessionStore 与通知适配器 68/68，TypeScript 退出 0；连同此前其余组件，共 75 项不同前端测试通过。后端未再改动，复用本批 373 项及真实模型证据。

桌面证据：.preview-evidence/harness9-ui-live-meters.json、harness9-ui-project.json、harness9-ui-independent.json、harness9-ui-capacity.json、harness9-installed-identity.json、harness9-installed-resume-verified.json；回归 context10-store-before.log、context10-store-after.log、context10-typecheck.log。

## 最终交付

harness10 按 README 入口完整重建，构建、安装 --silent 均退出 0。安装后 EXE、asar、清单与候选一致，50 个运行源文件与当前工作树及 harness9 真模型验收版本一致。harness10 真实打开历史显示 ≈17k / 33k?，来源提示正确；新建真实问候正常 end_turn，会话 1026ms 出现、正文 10175ms 首次可见。相关新验收：harness10-installed-identity.json、harness10-replay.json、harness10-installed-hello.json、harness10-ui-accept.log。

安装包 target/accepted-harness-installer-1.43.3-harness10/CodeBuddy-Harness-Setup.exe，325128704 字节；SHA256 F0545B0619DF3375801B9F33CF121D426D865D0CA5E516F6BF5BDEB5F62C562B。清单 sourceDigest 1b913f9dd9a56ae845bf7193552a48aa109d31375b8ed99ab7b1611fd90425f2。Git 保持 main 与全部相关未提交修改，没有提交、推送或新分支。
