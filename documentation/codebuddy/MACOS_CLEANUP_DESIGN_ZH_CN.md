# Mac 清理与恢复适配方案（已批准分阶段实施）

2026-10-05：用户在具体方案及批准问题后要求继续开发以对齐 Windows，据此按原边界分阶段实施；这不代表清理写操作已经通过验收。

[繁體中文](MACOS_CLEANUP_DESIGN_ZH_TW.md) · [English](MACOS_CLEANUP_DESIGN_EN.md)

## 目标与事实

2026-10-05，既有 main `00a6656df0c4ba0563b4cf03e560cb81a46b0f53` 加待提交合并和 dirty 修改。目标为对齐 Windows 的精确审核、隔离、恢复、再次确认永久删除和中断恢复流程。最新交付为 bundle23；阶段 22 的内部只读准备已包含在其重建后端中，但未启用产品清理操作。

Windows `workspace_lease.rs` 使用持有的对象 handle 重命名／删除；Mac `workspace_lease_macos.rs` 现仅有内部只读清理准备，allocation 的 CleanupAudit 仍限 Windows。既有 `RootCleanupInline.tsx` 和 `acp/rootCleanup.ts` 可复用。ACP 宿主及 cleanup registry/journal 保持权限与恢复 owner，UI 仅展示结构化结果；创建项目的权限不派生清理权限。

## 实机比较

真实 arm64 / macOS 26.6.2 的新建合成临时目录中，三项 OS 实验 3/3 符合预期、退出 0、夹具保留。证据：`target/macos-parity-20261005/cleanup22-primitives.json`。这不代表产品清理验收通过。

| 路线 | 证据与限制 | 选择 |
| --- | --- | --- |
| 检查路径后 rename/unlink | 持有源 fd 后同名文件被替换，renameatx_np 移走的是替换文件 | 拒绝作为精确对象实现 |
| 目录 fd + RENAME_EXCL | 同名恢复返回 EEXIST、两份内容保留；父目录改名后 fd 跟随原目录 | 用于防覆盖和定位；单独不足以保证源身份／授权路径 |
| CoreServices 对象引用 | 现有空目录回滚已使用 FSRef；Apple 已弃用并记录 APFS inode 兼容成本 | 仅作为候选原型，验证对象绑定和竞态后才接入写操作 |
| 系统垃圾桶 | 不提供现有令牌、两次确认和持久恢复合同 | 不作为等价替换 |

只使用现有系统 API/libc，无新增第三方依赖、不复制外部源码。

## 已批准实施边界

1. 复用七个 root-cleanup 方法的业务语义、session/run/sourceMessage/nonce 和生命周期屏障；抽取必要共用类型／策略，Windows 保持既有原生操作。Mac 先实现零目标修改的内部审核，不提前宣告完整能力。
2. 限一个明确选择的普通文件或空目录，沿用缓存／临时／构建白名单、项目重叠排除、符号链接和多硬链接拒绝。候选原生 API 必须证明替换后不触碰其他对象、祖先变化不扩张边界、内容变更令确认失效。移错再恢复不算通过；未达标保持写操作禁用，报告证据，不降级路径删除。
3. 首次确认只隔离到同卷专用目录；恢复原位占用时保留双方数据并报告待处理。永久删除须独立再次确认；过期／撤销／重启只保留既定恢复和诊断路径，不恢复删除授权。
4. 复用既有日志阶段、完整性验证、owner lock；Mac 使用平台／schema 标记及独立命名空间，保存完整原生设备／inode 和必要对象引用信息。Windows 旧日志原样读取，不自动迁移；未知平台／版本拒绝修改。活删除令牌不持久恢复。具体对象引用持久化取决于原型证据，未知不视为可用。
5. 原生操作与恢复门禁全部通过后接通 Mac ACP/Agent，复用现有 UI 确认。新增能力协商应兼容旧 Windows 客户端。同步批准后的权威地图修订、三语说明和源清单，再输出独立安装包。

## 验收及迁移门禁

审核零写入，覆盖普通文件／空目录、中文／空格、非法路径、项目重叠、链接、读拒绝。验证源／祖先替换、重命名、恢复同名冲突、内容／硬链接数变化，失败不得触碰其他对象。验证错误 session/run/message、重复／并发令牌、过期、关闭／归档／删除及重启旧令牌。对各日志边界做故障注入、完整性破坏、隔离目录替换、恢复重试，禁止恢复流程复活删除授权。

逐阶段运行相关 Rust 测试、fmt、Clippy，共用合同验证 Windows。随后在安装副本做 ACP，再做真实桌面审核→取消→隔离→恢复→再次确认删除，仅使用专用合成数据。Intel、最低系统、TCC／钥匙串另列，NOT_RUN 不算 PASS；纯方案文档不打包。

## 需要批准的依据

根 `AGENTS.md` 要求新增核心抽象、持久化语义或权限边界之前先比较方案和迁移边界；权威地图规定清理权限不由创建权限派生。批准对象为上述分阶段适配及三语文件／源码同步；测试只限新建隔离夹具，不含真实用户文件清理、系统权限修改、依赖安装或 Git 分支／提交／推送。

## 现有 UI／ACP 基线

本地使用隔离替身运行 `node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/components/codepro/RootCleanupInline.test.tsx src/acp/rootCleanup.test.ts`，cwd `ui/desktop`，9/9 通过，退出 0。覆盖现有两次确认／取消和恢复合同；不包含真实 Mac 文件修改或桌面操作。日志：`target/macos-parity-20261005/cleanup22-ui-baseline.log`。

## 阶段 22：只读检查已实现，写操作门禁待满足

抽取 Windows 已有的清理白名单、项目边界和摘要结构到 `workspace_lease/cleanup_policy.rs`；Windows 原生 handle 操作和旧日志格式保持原有语义。Mac 新增 `cleanup_macos.rs` 与八项原生回归，持有目录／文件 fd，检查普通文件或空目录、链接、项目重叠、路径绑定、内容摘要及元数据版本；再次校验时重新读取项目登记事实。读取被拒绝时返回错误，不改变目标权限。

这是内部准备模块，尚未连接 Mac 清理 RPC／UI，也未创建清理令牌或启用隔离、恢复、永久删除。模块上的局部 dead_code 标记在写操作门禁通过、正式接入时撤除。

候选 API 进一步验证：FSRef 两个顺序场景符合预期，200 次并发交换实验未观察到误移；这只是有限实验，Apple 明确记录 FSRef 的路径竞争限制，尚未证明既定精确对象合同。F_SETLEASE 在普通应用上下文返回 EPERM；XNU 实现要求私有 file-leases entitlement，不作为产品可依赖路径。不添加私有 entitlement、不放宽为路径删除、不采用移错后回滚。

下一门禁是确定可分发且满足原合同的对象操作方案；随后才实施隔离日志、恢复、再次确认删除并接入 ACP。当前准备代码不构成清理功能验收或新安装包交付。

证据：`target/macos-parity-20261005/cleanup22-{fsref-candidate,fsref-race,lease-candidate}.json`。测试最终状态见同目录 `cleanup22-state.json`。

验收结果：Windows 相关 Rust 72/72、Mac 原生 Rust 22/22（新增 8 项），两端 Clippy 与 Mac fmt 退出 0。Mac Clippy 有 7 条本轮未修改模块的警告。完整桌面清理为 NOT_RUN；新安装包未生成。

## References

- [Apple renameatx_np / RENAME_EXCL semantics](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/man/man2/rename.2)
- [Apple File Manager deprecation and APFS guidance](https://developer.apple.com/documentation/coreservices/carbon_core/file_manager)
- [Apple FSMoveObject object-reference signature](https://developer.apple.com/documentation/coreservices/1566291-fsmoveobject)

- [Apple Secure Coding Guide: FSRef and path races](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/Articles/RaceConditions.html)
- [Apple XNU: allow_setlease and private file-leases entitlement](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/vfs/vfs_subr.c)

## 2026-10-07 已批准的只读交付顺序（stage28）

用户在具体提案后回复“允许”，批准先接通 Mac 审计与取消，调整上方第 5 步顺序。完整对象操作及恢复门槛保留。

复用既有 audit/cancel 路由与能力来源；回应及 Agent 通知新增 executionAvailable，Mac=false、Windows=true，旧 Windows 缺省保持原语义，非法非布尔值拒绝。UI 只显示摘要与取消，隐藏破坏性确认及恢复面板；后端仍拒绝另外五个入口，包括旧客户端调用。

Mac 回执只在内存保存 Inspection 及原能力。提交、取消和撤销按 receipt→capability 锁序同步，取消不延长原有效期，过期与重启不恢复权限。仍拒绝链接、项目重叠及变化目标，保持目标零写入。Windows 隔离日志和写入合同保持原语义。

验证包含原生临时文件、ACP／组件回归、真实浏览器的隔离界面及新安装包 ACP；完整 Electron 操作另列。结果见 MACOS_PARITY_ZH_CN.md。沿用 [ACP extension methods](https://agentclientprotocol.com/protocol/v1/extensibility)，新增字段仅限自定义回应／通知数据，不扩充标准 ACP 类型。
