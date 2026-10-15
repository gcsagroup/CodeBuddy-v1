# 会话复制能力一致性

日期：2026-09-14。状态：能力保护、并发修复及本轮隔离原生验收通过。

后端 `ensure_fork_allowed` 明确拒绝 `code_pro`，其他已知会话类型沿用既有复制能力。原先历史卡片、侧栏右键菜单、消息编辑按钮和 Ctrl+Enter 均可能发出不支持的请求。

所有入口共用 `canForkSession`；CodePro 或类型尚未获取时禁用复制，显示新建独立任务的说明。消息编辑快捷键被拒绝时保留草稿，不自动改成原位编辑。原位编辑仍须明确点击。ACP 包装层调用前重新读取会话类型，避免只依赖界面快照。后端租约和权限规则保持；本次不实现 CodePro 内容复制。

## 公开产品比较

当前 Codex 的 `fork_thread` 工具契约表示创建独立子任务，只继承已完成历史，执行中的未完成回合不复制。本修复采用能力明确和来源隔离原则，不把 CodePro 不支持的 fork 暴露为可用。已查阅公开 [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)；当前页面没有完整 fork 契约，详细比较依据本次会话可用工具说明，不推断私有实现。未复制第三方代码或新增依赖。

## 验证

前端定向检查最终为 5 文件、29 通过、exit 0（`fork-focused-final.log`）。完整前端运行在补充测试用例之前完成：227 文件、2022 通过、4 跳过、0 失败；之后补充的测试仅增加覆盖，由最终定向检查验证。类型、lint、格式、翻译检查与编译、渲染器构建均 exit 0（`fork-gates.json`）。

原生验收发现的加载问题促成了确定性回归：外层请求先持有访问许可，加载取得生命周期锁并等待在途请求，内层再次申请许可时相互等待。修复前在通知屏障下命中两秒超时断言，0 通过、1 失败、exit 101（`fork-deadlock-before-fixture-fixed.log`）。更早的独立清理日志目录缺失属于测试夹具失败，不作为死锁证据。

修复使用请求类型的 `JsonRpcMessage::matches_method` 识别 11 个已有内层访问保护的入口，跳过重复外层许可。内层保护完整保留；9 个入口仍要求可写工作区，另外两个保持原有较窄要求。映射见 `fork-reentry-access-map.json`。

后端检查全部通过（`fork-reentry-gates.json`）：并发与权限定向 7/7；完整核心 3304 通过、0 失败、2 忽略；ACP 集成 59+55=114 通过；格式、Clippy、后端构建 exit 0。定向测试包含强制进入原竞争屏障、11 入口缺失会话/关闭状态拒绝、9 入口可写要求，以及原有在途许可生命周期检查。

真实 Electron：CodePro 历史卡片、侧栏菜单、消息编辑入口禁用；Ctrl+Enter 保留草稿；普通会话复制生成新 ID、正文持久化，普通消息编辑的分叉入口仍可用。重新构建后，对源会话与副本执行 16 个场景：14 次真实加载、2 次缓存切换，包含 8 次刷新及一次进程重启，全部通过。实际加载后端耗时 2162–2229 ms，正文与对应加载结束日志同时确认。数据再次核对通过，未发送模型任务。

后端 SHA-256：`41709ABD6B42B800EEA57B7102CFFE7288912914FA6938ECC68E66E07F4D7051`。详细记录见 `fork-reentry-native-summary.json`、`fork-reentry-native-runs.json`、两轮 backend JSONL、`fork-persistence.json`。首次观察器错误地要求缓存切换产生新 RPC，原始误判与源码依据保留于 `fork-reentry-native-observer-mismatch.json`；它不是产品失败，也不计为真实加载。

以上证据均在 `.cargo/evidence/audit-fixes-20260914/`。本轮通过限定于隔离 profile 的这些场景，不宣称排除所有竞态；真实模型执行仍待停机服务恢复后单独验收，未连接该服务。
