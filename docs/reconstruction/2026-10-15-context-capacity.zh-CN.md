# MCP 工具占用与模型窗口修复

源码：`D:\CodeBuddy-v1` 既有复制目录，无 `.git`，未提交或推送。候选 `1.43.3-harness6`。默认使用用户当前配置，未改模型、思考强度或工具权限。

最终交付更新为 `1.43.3-harness7`，含首页首次容量修复，见文末。下文明确标识 harness6 的中间候选实测，不冒充新包重复执行过全部长任务。

## 已核实根因

- 当前 Gemma 服务 `/v1/models` 返回 `max_model_len: 65536`。这是当前部署容量，不是按模型名称推测的理论规格。
- CodeBuddy 原先只保留模型 ID，库存显示和 Harness 路由均回落到 32768，因此界面显示约 33k。
- 实际安装版新会话带 205 个工具；规范工具定义共 167380 字符，服务实际输入约 32260 tokens，本地估算约 43k。输入包含工具和系统指令，不能把全部输入都称为工具 token。
- Harness 的 pi-ai 传输按窗口扣除估算输入和 4096 安全余量，最低保留 1 个输出 token。错误的 32k 容量使真实“你好”仅输出 1 token，以 `max_tokens` 停止。这是确切的中断证据，不是成功首响验收。
- 官方 token meter 包含工具定义；官方自动压缩缩减历史，不缩减系统提示、工具 schema 或会话前缀。首次请求没有历史可压，不能靠压缩处理工具定义本身超限。

## 实施边界

`runtime/providers.mjs` 从模型列表读取有效正整数窗口，包括 vLLM 的 `max_model_len`。连接指纹缓存元数据五分钟，并合并并发读取；连接/凭据变化使旧缓存失效。旧配置首次需要模型时进行最长两秒的可选发现；失败短暂缓存，保持原有保守回退。元数据不覆盖用户凭据，不持久化明文，不在每轮重新连 MCP。

`runtime/roles.mjs` 按提供方和模型共同缓存路由，避免同一服务中不同模型共用容量；普通会话、审查和辅助视觉路径也传入选中模型。窗口通过现有 Harness 模型资料接口交给官方执行器、token meter 和压缩器；压缩阈值仍来自用户设置。

同时包含此前的单会话快照优化，以及 `harnessService.ts` 从实际清单文件定位安装资源目录的修复。Windows 应用容器的目录解析与文件解析可能不同；保留工具文件身份校验。

## 验证状态

- `providers.test.mjs`、`roles.test.mjs`、`vision-routing.test.mjs`：24/24，exit 0。验证服务容量、同服务不同模型、并发复用、连接变化和元数据失效回退。
- `session-lifecycle.test.mjs`：9/9，exit 0。首次扩展运行暴露旧夹具未处理 GET 模型列表，补齐真实路由后复测通过；中断的首次运行不计通过。
- `capabilities.test.mjs` 过滤 `tool schema pressure|configured pressure threshold|manual compaction`：3/3，exit 0。大工具定义保留 4096 输出预算，计入压力；历史累积后自动压缩，工具保留。
- 真实 Gemma、205 工具：修复后完整 `end_turn`；证据 `.preview-evidence/gemma-context-fixed-real.log`、`harness-compare-X05bSL`。该次源码冷启动首段总时间约 12 秒，模型阶段首段约 0.8 秒；不作为安装版性能结论。
- `harness6-goal-integration.log`：1/1；`harness6-codepro-adapter.log`：11/11，exit 0。分别覆盖双模块任务的暂停/重启、适配层任务行为。harness5 构建被主动作废，不是交付候选。

### 真实长上下文与恢复

隔离普通会话保留 201 个工具（CodePro 另有四个角色工具），完成六次官方压缩，前七轮正常结束。第八轮在 180 秒验收期限后由脚本取消；该轮包含压缩和模型等待，不计通过，也不称为模型返回失败。重启服务并加载原生持久化会话后，第九轮正常结束；直接核对最后一条原生 assistant/message，正确回答项目代号 `HARBOR-fd137641`、修正后税率 750 bps、金额整数分、运费不计税。没有用历史回放中出现过答案来代替本轮回答。

六次压缩走的是官方上下文超限恢复路径：服务拒绝过大的请求后，由 Harness 压缩并重试；不宣称全部请求都在发送前得到精确预算。自动压缩会保留原子消息和工具定义，这个边界仍存在。约 53k 输入的模型等待可达数分钟，未证明小时级大型生产项目稳定。

证据：`.preview-evidence/mcp-context-pliiLm/receipt.json` 保留原始超时；`resume-receipt.json` 为恢复回执；`verified-summary.json` 从原生事件重新核对六次压缩、八次完成及一次取消。

### 已安装界面的真实验收

冷启动新会话 1.321 秒出现，首段 45.360 秒；其中模型传输首段等待 36.653 秒，服务 HTTP 响应头约 0.551 秒。随后新会话复用两个远程 MCP 连接，准备耗时从 6.476 秒降至 1.295 秒；会话 1.292 秒出现，首段 3.885 秒，模型首段 0.549 秒。两轮均完整 `end_turn`，没有将单 token 截断视为成功。

冷/热两轮分别收到 179/230 个文本分段、观察到 26/33 次界面文本变化，证明真实流式显示。安装版原生 request/context 为 65536，输出预算 4096，205 个工具仍在。样本只有一组冷/热对照；远端缓存和负载会影响结果，不能保证每次都是 3.9 秒。冷启动延迟尚未消除，尤其大工具列表仍增加模型预填充成本。

证据：`.preview-evidence/harness6-gemma-cold.json`、`harness6-gemma-warm.json`、`installed-context6-4ElYTl/logs/harness/runtime.log`。本批未改前端布局。

安装版真实 UI 还完成 PowerShell 输出、创建 hello.txt、读回内容。原生 `pwsh` 成功，文件实际为 `HARNESS6-FILE-OK`，最终原生完成；耗时 41.646 秒。模型调用 write 时两次没有成对填写 sandbox_permissions/justification，Harness 正确拒绝，模型补齐后成功；保留这两次参数重试，不将它们隐去，也没有放宽权限校验。证据：`harness6-installed-tools.json/png`、`harness6-tools-native-summary.json`。

## 安装候选身份

`node scripts/build-harness-windows.cjs target/harness-package-context6/harness-distribution` 在 13:07 完成，exit 0；`CodeBuddy-Harness-Setup.exe --silent` 在 13:09 完成，exit 0。服务由包内 Node 24.18.0 启动；可执行文件、app.asar、manifest 和五个受影响运行文件与构建产物哈希一致。真实 UI 的两轮模型对话已完成上述验收。

- 版本：`1.43.3-harness6`
- Harness 资源指纹：`d5d62f8a871f78583170eeac088547d3bedfff0a671836ec24098e10709bdf05`
- 安装包 SHA256：`FB73321B967854A566E6A684E6CE38F2677B59483B6ADE38DD4D24BBE68D53C0`
- 稳定副本：`target/accepted-harness-installer-1.43.3-harness6/CodeBuddy-Harness-Setup.exe`。目录名称不代表所有验收已通过，以本记录结果为准。
- 安装路径：`C:\Users\jiangrui\AppData\Local\CodeBuddyHarness\app-1.43.3-harness6\CodeBuddy.exe`
- 回执：`.preview-evidence/harness6-build-exit.json`、`harness6-install.json`、`harness6-installed-identity.json`。

参考：[Harness 压缩边界](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md)。实现按本地已安装 `0.2.1-alpha.2` 核对。

[繁體中文](2026-10-15-context-capacity.zh-TW.md) · [English](2026-10-15-context-capacity.en.md)

## 首页容量补充修复（harness7）

harness6 切回默认用户目录时发现：首页首次读取模型库存早于创建会话，因此尚未拉取容量元数据，仍显示 33k；虽然后续执行已使用 65536，首页表现仍不符合要求。`resolvedInventory` 复用同一个有界元数据缓存，`providers/list` 等待配置好的连接完成查询后返回窗口；未配置连接不发请求，离线连接保留回退值。无前端布局改动，无额外 MCP 握手。

`node --test runtime/tests/providers.test.mjs runtime/tests/acp-contract.test.mjs`：24/24，exit 0。新增首屏回归覆盖未创建会话前的真实容量、并发列表、首轮路由复用同一查询及离线回退。日志 `.preview-evidence/harness7-inventory-tests.log`。harness6 的长上下文/流式/工具验收作为未变化执行链路的既有证据单独保留；最终安装包需再验证首次首页容量与真实对话。

本批源码范围：`runtime/providers.mjs`、`roles.mjs`、`compat.mjs`、`vision-routing.mjs` 的容量传递；`store.mjs`、`conversation-driver.mjs`、`transcripts.mjs`、`codepro.mjs` 的定向快照；`ui/desktop/src/harnessService.ts` 的资源根目录；`ui/desktop/package.json` 的候选版本。回归位于 `runtime/tests/{providers,roles,store-atomicity,session-lifecycle}.test.mjs`、`runtime/harness/test/capabilities.test.mjs`、`ui/desktop/src/__tests__/harnessService.test.ts`。保留目录内其他既有修改，无分支、提交、推送或依赖安装。

### 最终安装包身份

- `node scripts/build-harness-windows.cjs target/harness-package-context7/harness-distribution`：13:39:45 完成，exit 0，包内原生 PowerShell/文件搜索门禁通过。
- `CodeBuddy-Harness-Setup.exe --silent`：13:40:55 完成，exit 0。实际安装位置 `C:\Users\jiangrui\AppData\Local\CodeBuddyHarness\app-1.43.3-harness7`。EXE、app.asar、清单、providers.mjs、compat.mjs 五项哈希与打包源一致。
- 稳定安装包：`target/accepted-harness-installer-1.43.3-harness7/CodeBuddy-Harness-Setup.exe`，SHA256 `FC3003A48ECCF82C6B3E47C93C360DA844296C43D40CBC4122AFEEAA6006EDAC`。
- Harness 指纹：`5d43f6e7208d83c2c25a8b43c8b78215c68c77c144ba5d7a8cc4eadcf9f18d9b`。
- 默认用户目录真实启动，Gemma 配置与历史保留；第一次发送前首页为 `0 / 66k`，即 65536 的缩写显示。证据 `harness7-initial-homepage.json/png`、`harness7-default-launch.json`、`harness7-installed-identity.json`、`harness7-install.json`。

最终包两次 UI “你好”均 `end_turn`，原生 `completed`：会话出现 0.986/1.282 秒，首段 8.007/3.878 秒，全轮 18.880/12.875 秒；文本分段 219/166，实际界面变化 31/25 次。两轮均保留 205 工具，原生窗口 65536。第一轮模型首段 0.748 秒，剩余包含启动和 MCP 准备；此时远端缓存状态未受控，不将它与此前 45 秒样本直接归因为新补丁。

最终包第三个真实 UI 任务调用原生 pwsh 输出 `HARNESS7-OK`，回执无错误、原生 completed，耗时 10.360 秒。默认工作区自动创建，未手动选择文件夹。证据：`harness7-installed-greeting.json`、`harness7-installed-greeting-warm.json`、`harness7-installed-command.json/png`、`harness7-native-summary.json`。新包已留在默认用户配置下运行。长对话六次压缩沿用本批 harness6 执行链路证据，未在 harness7 重跑；长输入等待和压缩后的信息保真仍需更长实际项目覆盖，不据此承诺所有大任务准确完成。
