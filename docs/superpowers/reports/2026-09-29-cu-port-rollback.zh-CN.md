# CU 移植回退记录

日期：2026-09-29。用户决定放弃本轮 Computer Use 移植及后续修复，仅保留完全不依赖 CU 的正向改动。

## 源码边界

- 当前分支：`fix/codepro-context-compaction`，回退前 HEAD：`76531c539`。
- 恢复基线：`f7fd065b48ac8750135fe009d8e0ccffb51e22cd`（主 Agent 与模型路由偏好已提交）。不重写 Git 历史，不切分支、不推送。
- 移植后的 CU adapter、驱动接入、独立视觉及 v2 配置/协议、权限/执行/回执相关改动、图片传递修复全部撤回。两个未提交 CU 修改也已备份后撤回。
- 模型列表优化与 CU 共用选择逻辑；整批不保留。立即显示用户输入尚有重复 query 疑点，也不保留。
- 基线原本已有的 Computer 功能仍在；本次不是删除全部 Computer 能力，更不是证明旧 CU 安全或成熟。
- 原会话、审计、效果存储、用户文件及系统设置不迁移、不清理。历史调查报告保留为档案，不表示相关实现仍生效。此前 CU 修复计划停止实施，以本记录为当前决定。

## 相对基线仅保留的产品差异

| 文件 | 保留行为与理由 |
| --- | --- |
| `crates/goose-provider-types/src/conversation.rs` | 私有 MessageSlot 的 Box 布局调整，不依赖 CU |
| `crates/goose/src/acp/server.rs` | 通用 ActivityEvent 身份/脱敏传输，停止说明的持久化和发送；移除混入的视觉分类测试 |
| `ui/desktop/scripts/ensure-dev-backend.cjs` | 查找已安装 VS 的 CMake，不安装依赖、不修改系统 PATH |
| `ui/desktop/src/components/BaseChat.tsx` | 无有效活动时显示等待模型响应，接收可见思考时显示对应提示 |
| `ui/desktop/src/components/ProgressiveMessageList.test.tsx` | 通用活动身份和隐藏内部成功策略的已有回归 |
| `ui/desktop/src/components/GooseMessage.tsx` | 停止/中断使用自然语言解释，不仅显示框框 |
| `ui/desktop/src/components/ProgressiveMessageList.tsx`、`ToolCallExpandable.tsx` | 历史对话展开区域允许达到 70vh |
| `ui/desktop/src/i18n/messages/en.json`、`zh-CN.json` | 仅上述等待/停止说明文案，不保留视觉和模型列表相关增量 |

共 10 个产品文件。原有 AGENTS、技能规则与本地资料不纳入回退提交。

## 备份与配置

- 本地备份：`C:\Users\admin\AppData\Local\Temp\codepro-pre-cu-rollback-20260929-160248`。
- `history.bundle` 保存基线之后至原 HEAD 的提交（依赖原仓库中的基线）；`working-tree.patch` 与 `files/` 保存回退前未提交差异和 21 个修改/未跟踪文件，逐文件哈希一致。
- `config.before.yaml` 保存降级前本地配置，含敏感设置，仅留在本机，不提交。
- 经用户明确授权关闭此工作区旧桌面/后端；仅将本地 `GOOSE_CODEPRO_MODEL_ROUTING.version` 从 2 改为 1 并删除 `vision`。解析后深比较证明其他配置及全部 5 个角色选择保持不变。
- 两处已下载的 CUA 0.28.1 运行资产移至备份目录 `driver-assets-0/1`，可恢复，不删除系统服务或其他安装。
- 源码回退不能撤销过去实际执行的文件操作、外发或系统执行策略变化。

## 本次验证与交付边界

- `cargo fmt --all`、`git diff --check`：退出 0。
- `pnpm.cmd --filter @aaif/goose-sdk run build`：退出 0；SDK 从回退后的 schema 生成。
- `pnpm.cmd run typecheck`（`ui/desktop`）：退出 0。
- 相对基线的产品差异仅允许上表 10 个文件；不以 Git 提交标题替代逐文件基线核对。
- 后端构建及桌面启动在回退提交后按既有 `start-gui` 入口交付，实际结果见本轮交付说明，不以旧程序充当回退版。
- 本轮未运行单元测试、Clippy 或真实产品 E2E。保留改动既有测试记录不等于本次组合重新通过产品验收。
