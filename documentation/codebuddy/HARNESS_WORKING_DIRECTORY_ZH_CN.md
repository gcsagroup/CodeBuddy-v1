# 普通聊天工作目录切换

日期：2026-10-14。源码为 `D:\CodeBuddy-v1` 当前文件；无 Git revision，本批未提交或推送。原界面保持不变。

## 合同与实现

原 ACP `_goose/unstable/session/working-dir/update` 接收 `{sessionId, workingDir}`，成功返回 `{}`。只接受真实存在的绝对目录；不创建目录。活动会话、导入的只读历史及 CodePro 会话拒绝切换。CodePro 继续受任务工作区 lease 约束。

官方 `workingDirectory.set` 只改变有效目录，明确保留原权限；`sandboxPolicy.resolve` 的 workspace-write 根来自不可变的 `session.header.cwd`。因此仅改产品字段或调用目录 setter 会造成新路径与旧写入边界不一致。

`runtime/harness/working-directory.mjs` 复用公开的官方 `buildForkSeed`、`agents.create`、`workingDirectory.set` 和 `sessions.flush`：保留完整旧日志，为新目录创建新 native session header，按需纠正继承的目录投影并持久化。没有新增模型循环、变更旧日志或将沙箱扩大为完全访问。已有 agent preset 的特殊组合会明确拒绝，当前产品普通会话不使用该组合。

`conversation-driver.mjs` 保持产品会话 ID 稳定。Compat 在会话锁内原子保存新 native 指针、目录和 `directoryChanges`；保存失败只留下未发布的 native fork，旧产品指针及会话仍有效。成功后清除旧能力 scope，下次 ensure 用新目录重建 Git、项目记忆和 MCP。旧 native ID 从会话列表投影中隐藏，日志仍保留。旧 scope 释放失败记录明确日志，服务关闭负责最终清理。

AGENTS 和原生文件工具使用官方目录机制；新 header 同时成为新写入边界。工具审批仍生效，不携带一次性审批。历史消息及旧工具结果继续保留，所以历史中出现旧项目资料不等于当前项目记忆作用域泄漏；主动记忆读取和注入只使用新目录。

## 验证与边界

执行命令：`node --test runtime/tests/working-directory-harness.test.mjs runtime/tests/working-directory-acp.test.mjs runtime/tests/conversation-editing.test.mjs runtime/harness/test/mcp-apps.test.mjs`。14/14 通过，退出码 0：目录切换 4 项、历史编辑回归 6 项、MCP 驱动回归 4 项。

隔离 `.preview-evidence/codebuddy-directory-harness-*` 夹具位于系统 Temp 之外，验证 A→B→重启→C，相对 write/read 落新目录，以及 B 会话对旧 A 绝对路径的写入被官方文件沙箱拒绝。模型上下文的当前目录与写入根均精确指向 B。其他临时夹具验证历史、AGENTS、审批、无效路径、活动拒绝、CodePro/只读拒绝、项目记忆隔离，以及 stdio MCP 的实际 PID 退出与新 cwd。

测试使用真实官方 Harness、ACP、原 SDK Zod、本地受控模型 HTTP 和 stdio MCP；不涉及用户项目分支或提交。真实 Electron 目录选择器交互及 macOS 尚未由这组结果验收。宿主文件沙箱的验证不代表 PowerShell 进程具有同等级操作系统沙箱。

## 依据

使用本地锁定的 MIT 许可 DeepSeek Harness `0.2.1-alpha.2`；检查了 `dsh-working-directory`、`dsh-sandbox-policy`、`dsh-agent`、`dsh-session` 的公开类型与实现。官方 [工具目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md)说明各工具目录与执行后端职责；具体接线以本地版本为准。无新增依赖或 vendored 修改。
