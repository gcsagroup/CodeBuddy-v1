# 首段响应优化：会话与任务快照

范围：`D:\CodeBuddy-v1` 既有源码，没有 `.git`；未新建分支、提交或推送。候选版本 `1.43.3-harness4`。不修改前端交互、模型、思考强度、工具清单、权限或 Harness 的执行/完成/压缩权威。

## 证据与修改

此前安装版两个纯问候样本：约 1.3–1.7 秒进入会话，8.1–11.4 秒显示回复。不能把这段时间全部归因模型。隔离复制现有设置和历史后，真实 kimi-k3 请求的适配层读取 21 次累计约 1127ms。静态追踪发现当前会话查找、原生会话 ID 映射、转录开始、任务投影均有复制完整状态的调用，包括不相关历史。

`runtime/store.mjs` 增加选中单个会话后再复制的 `readSession`，返回的仍是已提交状态的独立快照。`runtime/compat.mjs`、`conversation-driver.mjs`、`transcripts.mjs` 使用该读取；`runtime/codepro.mjs` 的查询仅读取 `codeproRuns`。未改变写入事务、崩溃恢复、原生日志、权限和持久化格式。保留仅提供原有 read 接口的测试存储兼容。

同一份隔离历史数据、同一进程交替测量三组：每组 20 次“当前会话 + 任务”读取，原路径 2624/3105/2874ms，新路径 29/20/35ms。它证明局部读取提速，不代表整体请求提速比例。证据 `.preview-evidence/latency-snapshot-benchmark.json`；程序 `latency-snapshot-benchmark.mjs`。

真实对照维持 kimi-k3/high、55 个工具、52433 字节请求。隔离完整请求首段由 20.738 秒变为 9.003 秒，但首次模块加载、OS 文件缓存和网络不同，不能将全部差值归功本次修改；参考 `adapter-profile-before.log` / `adapter-profile-after.log`。产品结论以实际安装版界面计时为准。

## 自动验证

使用本机既有 Node 24.18.0，无安装或下载开发依赖。

```powershell
node --test --test-concurrency=1 runtime/tests/store-atomicity.test.mjs runtime/tests/conversation-admission.test.mjs runtime/tests/transcripts.test.mjs runtime/tests/codepro-harness-projection.test.mjs runtime/tests/codepro-harness-integration.test.mjs
node --test --test-concurrency=1 runtime/tests/codepro.test.mjs runtime/tests/codepro-integration.test.mjs runtime/tests/conversation-editing.test.mjs runtime/tests/session-lifecycle.test.mjs
```

第一组 23/23，第二组 43/43，均 exit 0。新增回归验证单会话快照的隔离、未提交写入不可见、提交后更新及删除；原有并发、实际 Harness 工具调用、恢复和编辑用例通过。日志 `latency-snapshot-tests.log`、`latency-adapter-regression.log`。

## 构建与实装

按 README：既有 Node 24 执行 `node scripts/build-harness-windows.cjs target/harness-package-latency4/harness-distribution`，构建和安装均 exit 0，但实际逻辑安装路径触发 MCP 文件身份错误，因此 harness4 不作为通过候选。查明 Windows 应用容器的目录与文件真实路径不同后，改为从实际 manifest 文件确定资源根目录；三个服务回归、TypeScript 与 ESLint 均通过。后续 harness5 构建因发现模型容量丢失而主动作废，统一进入 harness6。

当前用户模型已切换为 Gemma，工具数量也由 55 变为 205，不能与之前 Kimi 数据直接比较。harness4 的 Gemma 冷/热样本虽然在 9.38/4.86 秒出现文字，但原生状态为 `max_tokens`、仅输出 1 token，均为中断，绝不作为正常对话通过。容量根因、修复及新候选见[模型窗口记录](2026-10-15-context-capacity.zh-CN.md)。上一版安装程序保留到 `target/accepted-harness-installer-1.43.3-harness3`。

[繁體中文](2026-10-15-response-latency.zh-TW.md) · [English](2026-10-15-response-latency.en.md)
