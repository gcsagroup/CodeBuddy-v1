# CodeBuddy E2E 边界修复记录

日期：2026-09-28。工作区：`C:\Users\admin\CodeBuddy`；分支：`fix/codepro-context-compaction`。

## 基准与范围

移植版本源码已经提交到 `33ec805d0`，不是未提交源码；本次诊断报告已另提交为 `9cda7e013`。本批只修复 EDU-0928-1906 已确认的厂商选择、视觉分类、活动传输和等待提示，不把普通失败改成成功，不调整完成门槛或运行状态机。

厂商选择与视觉分类修复独立提交为 `52b8cbb61`；活动传输与等待提示独立提交为 `d00f61169`，不与此前本地夹具混合。

保留所有既有规则、夹具和本地资料改动，不纳入本批提交。没有推送、安装依赖、修改用户配置或调用真实模型/桌面输入。

## 实际改动

1. 厂商分类由既有 catalog 统一返回。补全已注册旧 CLI ID 的 Agent 分类，目录别名按既有 canonical identity 解析；不重写用户保存的厂商 ID。视觉保存和运行前校验继续消费这个共同结果。
2. 视觉列表复用角色配置已有的已配置 Custom 模型端点集合，不把自带默认地址/命令的 Builtin 当成用户连接。独立视觉选择仍独立保存。
3. 加载失败的厂商保留在列表并标为暂不可用；部分厂商失败不再报整个列表失败。重试跳过本次弹窗中已成功的厂商，不变更任何角色选择；全部失败时保留明确错误。
4. ActivityEvent 经既有 ACP status_message 通道传输，保留真实 event_id/event_type/run/task/status，而非转换成缺少身份的 PublicProgress。标题、命令、输出和差异说明继续脱敏限长，不公开 routing_evidence。真实 worker PublicProgress 的协议不变。
5. UI 的成功策略隐藏规则现在能消费真实事件；不同活动不再因空 attempt 键互相覆盖。
6. 没有活动工具或有效阶段标题时明确显示“正在等待模型响应”；只有最新可见消息含实际 thinking 内容时才提示正在接收思考内容。不恢复过期文件标题。
7. 修正模型配置停用保存测试仍期待版本 1 的过时断言，保持已有版本 2 合同。

改动文件：

- `crates/goose-provider-types/src/canonical/catalog.rs`：共同厂商分类。
- `ui/desktop/src/components/codepro/CodeProModelModal.tsx` 及同目录 `.test.tsx`：列表、失败隔离、选择保存回归。
- `crates/goose/src/acp/server.rs`：活动传输、脱敏和两项后端边界回归。
- `ui/desktop/src/components/ProgressiveMessageList.test.tsx`：将策略隐藏回归改为经过真实 ACP adapter，并验证不同事件不覆盖。
- `ui/desktop/src/components/BaseChat.tsx`、`ui/desktop/src/i18n/messages/{en,zh-CN}.json`：等待模型/接收可见思考内容的提示。
- 本记录与已提交诊断报告：证据、归因、验证及剩余边界。

## 验证边界

依用户要求只聚焦两个问题簇：模型/视觉配置边界，以及 ACP 活动/进度展示边界。不运行完整教务系统开发或无关全量测试。

前端聚焦选择：

```powershell
# cwd: ui/desktop
& ../node_modules/.bin/vitest.cmd run src/components/codepro/CodeProModelModal.test.tsx src/components/ProgressiveMessageList.test.tsx src/components/codepro/currentWorkStage.test.ts -t 'isolates visual|hides successful internal|current work stage|retains the draft after save failure' --maxWorkers=1
```

首次选择的 5 项中 4 项通过，1 项受新增测试 mock 污染影响；将新增模拟限定为单次响应后，仅重跑模型配置的 2 项，退出 0、均通过。活动 UI 的 1 项和旧文件阶段退场的 2 项已通过，未重复运行。

`tsc --noEmit` 首次发现本批使用 Array.at 不符合项目目标库；改用索引后重跑退出 0，最终源码再次检查也退出 0。相关文件 ESLint 退出 0。

后端验证（cwd 仓库根目录）：

```powershell
cargo fmt --all -- --check
cargo test -p goose --lib e2e_repair_ --jobs 1 --offline
```

格式检查退出 0。后端测试退出 0：2 项通过，3394 项按过滤器未运行；两个用例分别验证视觉分类及公开活动身份/类型和脱敏。没有调用真实模型、驱动或桌面输入。编译测试目标耗时 22 分 46 秒，测试自身 0.01 秒；主要额外成本是该测试配置的原生依赖和大型 lib test 目标编译，不是新增了全量执行。

本批选中的前端 5 项、后端 2 项最终均通过。不是此前 66 项或全仓测试重新全部通过。

严格静态检查：`cargo clippy -p goose -p goose-provider-types --lib --jobs 1 --offline -- -D warnings` 退出 1，报告 24 项错误，包含未使用函数、参数数量、布尔表达式、字符串切片等。相对基准 `33ec805d0`，报错所在的 `agents/`、`utils.rs` 文件未修改；`acp/server.rs` 中报错的 `handle_tool_request` 签名也未修改。因此本批没有清理这些既有告警，也不能宣称 Clippy 通过。`git diff --check` 退出 0。

这些是 mock/组件和源码边界验证，不是实际产品 E2E。旧报告记录的其他活动折叠断言本轮未全量重跑，不能称全套测试通过。

## 明确保留的未完成项

- 文件参数生成预览的延迟：仍需一次带 request ID 的网络到达/解析/ACP/UI 时序取证，不能用本次修复代替。
- 最终正文流式：仍保留完成检查后的发布门槛。已询问用户是否接受带“尚未确认”标记的流式草稿；没有据此提前显示未确认的完成结论。
- 合同错误具体原因与恢复关联：本批未修改。当前跨层错误主要以字符串传递，不能靠 UI 字符串匹配或“后一次成功”推断旧失败原因/恢复；需要单独完成 owner 的结构化原因到展示链路。
- 本批未构建/重启桌面，当前正在运行的旧后端不能作为本批改动的产品证据。启用本批后端修复需要按既有入口重新构建并启动。
