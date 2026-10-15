# CodeBuddy 记忆模块优化：修改说明与合并交接

日期：2026-09-30
用途：供另一位开发者审阅、移植和合并本次记忆模块改动。

## 1. 本次交付范围

本次在 CodeBuddy 现有本地 Project Memory 上增加 **可选的本机 Hindsight 语义索引**，并修复真实验收中发现的续聊权限、记忆任务预算和完成检查问题。

本地记忆继续负责内容、版本、来源、审核、有效期和删除状态；Hindsight 提供语义检索候选。当前桌面状态、动作回执、任务权限和任务完成状态仍由原宿主管理。

本批没有新增 UI 页面、修改电脑控制或搜索引擎，也没有修改 Cargo 依赖、锁文件或本地记忆持久化格式。此前的电脑控制、视觉路由、搜索、上下文压缩和活动 UI 改动已在基线提交中，本说明只介绍基线之后的记忆增量。

### 代码来源与提交顺序

- 仓库：<https://github.com/erjinyi-bool/CodeBuddy>
- 开发目录：`D:\Users\jiangrui\Desktop\CodeBuddy`，分支 `main`。
- 修改前基线：`912eb6f7b3950c2c0ccf0ed1095e0ab4863f940e`。
- 本批按功能拆分，交接说明作为最后一个独立文档提交。

| 顺序 | 提交 | 内容 | 建议 |
| --- | --- | --- | --- |
| 1 | `c89fa2e4b` | 修复按需隐藏工具定义导致只读续聊误拒绝 | 可独立审阅；保留显式拒绝检查 |
| 2 | `2764d1655` | 修复记忆任务分类、预算和完成协议错误反馈 | 与第 1 项一起合并、核对重叠的 `agent.rs` |
| 3 | `05f551774` | 可选 Hindsight 索引、回归与评估入口、接入说明 | 要获得完整产品行为，建议前两项一起合并 |

## 2. 文件清单与修改原因

| 文件 | 修改内容 | 原问题 / 合并关注点 |
| --- | --- | --- |
| `crates/goose/src/agents/analysis_tools.rs` | 增加当前完整工具目录的只读访问方法 `catalog()` | `offered()` 只是本轮提供给模型的精简定义，不代表执行权限全集 |
| `crates/goose/src/agents/agent.rs` | 只读执行检查使用完整目录；保留明确拒绝；调整纯记忆任务类型和预算；消费协议解析错误与示例；新增回归 | 涉及两批修复，最容易与同事的调度/权限改动冲突，按职责合并 |
| `crates/goose/src/agents/main_agent_contract.rs` | 增加 `request_formats()`、`parse_request()`；inspect 与格式错误返回正确参数结构 | 真实模型曾误用 `revision`、`payload`、额外 `basis`；仍严格解析，不替模型补证据 |
| `crates/goose/src/agents/tool_task.rs` | 增加记忆所有者回执的完成检查回归 | 这里只新增测试；验证正确记忆目标通过，错误目标和文件交付不能借用同一回执 |
| `crates/goose/src/agents/platform_extensions/project_memory.rs` | 本地变更成功后触发索引对账；搜索接入异步增强并传递取消信号 | 保留现有本地 CRUD 管理入口，避免形成第二套内容所有者 |
| `crates/goose/src/agents/platform_extensions/project_memory/hindsight.rs` | 新增可选 MCP 索引实现及测试 | 本机地址约束、项目/配置隔离、版本对账、召回校验、超时降级 |
| `crates/goose/tests/project_memory_retrieval_benchmark.rs` | 增加默认忽略的真实本地工具评估入口 | 读取外部合成数据集，输出命中结果和耗时；不是默认 CI 的准确率门槛 |
| `documentation/codebuddy/HINDSIGHT_MEMORY_ZH_CN.md` | 简体接入与行为说明 | 配置入口、范围、限制及已执行验收 |
| 同目录 `HINDSIGHT_MEMORY_ZH_TW.md`、`HINDSIGHT_MEMORY_EN.md` | 已有本次接入说明的繁体和英文版本 | 保留此前配套文档；本交接说明仅新增简体版本 |
| `documentation/codebuddy/MEMORY_MERGE_HANDOFF_ZH_CN.md` | 本文 | 供合并和交接使用 |

## 3. 关键行为变化

### 3.1 只读续聊权限

原流程用本轮展示的工具定义做执行校验。模型在第一轮知道某个工具后，后续仍可能调用它；定义按需隐藏时，原逻辑会把有效工具误认为不可用，产生 `policy_denied`。

修复后：使用当前完整有效目录校验。扩展从目录移除后仍应拒绝；宿主已经明确拒绝的请求也仍应拒绝。不要在合并时恢复“只要只读就从 denied 移到 approved”的旧逻辑。

### 3.2 记忆任务收尾

原纯记忆任务沿用 `SimpleChange`，要求产生工作区文件修改；即使记忆已成功保存，仍可能被完成检查拦住。同时 8 轮任务预留了 5 轮收尾空间，第 4 轮便开始收起工具。

修复后：使用既有 `ToolAction` 类型，保持 8 轮上限、只预留 1 轮最终回答。完成仍验证需求版本、具体记忆目标和记忆模块实际回执，不接受模型自述代替完成证据。低于 8 轮的外部上限仍有效。

协议错误现在附带可修正的参数示例；原字段、版本与证据校验仍保留。不要把示例中的标识符当作真实回执，也不要借此跳过完成检查。

### 3.3 Hindsight 语义索引

```text
保存 / 修改 / 删除
  -> 本地记忆先提交
  -> 后台按项目合并索引工作
  -> MCP 对账外部文档版本

搜索
  -> 本地文本匹配
  -> 可选 MCP 语义召回（最多等待 1.5 秒）
  -> 校验候选对应的本地 ID、版本、有效性
  -> 返回本地正文；失败明确回退本地结果
```

- 默认关闭；只有配置本机服务地址才启用。
- bank 由规范化项目路径与本地记忆配置目录共同派生，模型不指定 bank；不同配置/项目不共用固定测试 bank。
- 仅索引当前有效、允许召回的 `project` 范围记录，不复制 `user` 范围偏好。
- 外部文档采用本地 ID + 完整记录版本指纹；更新清除旧版本，删除在后台对账。
- 同一项目同步工作合并；失败后每 30 秒重试，进程退出即停止，下次记忆操作重新调度。
- MCP HTTP 成功不代表业务成功；显式业务错误、缺少结果数组、同步保存未完成都会作为失败处理。
- 语义候选只是可能相关，不是答案证明。未知问题仍可能返回无关候选，回答必须对照正文，无依据就说未知。
- 不自动调用耗时较高的 `reflect`；原有启动上下文注入仍为最近 20 条 / 约 6000 字符机制。

## 4. 同事如何合并

先确认自己的工作区没有待保护的未提交修改，查看目标分支是否已包含上述提交。本次不会替同事切换、重置或合并其开发分支。

```powershell
git fetch origin
git log --oneline --decorate -12 origin/main
git diff --stat 912eb6f7b3950c2c0ccf0ed1095e0ab4863f940e..05f551774
```

如果同事的目标分支需要只移植这次记忆增量，且尚未包含这些提交，在其已确认的目标分支按顺序执行：

```powershell
git cherry-pick c89fa2e4b 2764d1655 05f551774
```

如果本来就是同步整个 `main`，使用团队既有合并流程即可，不要再重复 cherry-pick。本文可直接在 GitHub 阅读，也可单独合并最后的文档提交。

### 冲突处理重点

1. `agent.rs`：分别保留完整目录权限检查、纯记忆 `ToolAction` + 预算、task contract 新解析入口和 inspect 格式示例，不整文件覆盖同事修改。
2. `main_agent_contract.rs`：若同事已升级协议，按新协议调整示例和回归，保持严格校验；不要新增第二套合同状态。
3. `project_memory.rs`：在同事当前版本的本地提交成功边界挂后台对账，保持锁与本地持久化语义；搜索保留取消、失效检查和降级路径。
4. `hindsight.rs`：与父模块的内部类型、有效性判断一起检查；不要单独拷贝后改成外部正文直接进入模型上下文。
5. `tool_task.rs`：本次只有新增测试，不需要用本分支整文件替换同事实现。

## 5. 配置和部署交接

合并源码不会安装或启动 Hindsight。当前个人电脑上的 Python 环境、PostgreSQL 数据、模型缓存、启动脚本和凭据没有随 Git 提交；同事需要自行准备服务，或暂时保持功能关闭。

完成本机服务部署后，在启动 CodeBuddy 后端的环境设置：

```powershell
$env:CODEPRO_HINDSIGHT_URL = 'http://127.0.0.1:18988'
pnpm.cmd --dir ui/desktop run start-gui
```

该地址是示例端口。实现只接受 `127.0.0.1` 或 `::1` 的 HTTP 根地址，不接受用户名密码、查询参数、子路径或远程域名；不要填 `/mcp/...`，代码会构造 MCP 路径。当前没有单独的设置页开关，修改启动环境后需重启后端。

服务需提供 `create_bank`、`list_documents`、`delete_document`、`sync_retain`、`recall`。根 MCP 用于建 bank，其余请求限定到对应 bank。不要把所有项目指向同一个手工测试 bank。

本轮验证环境：Hindsight 0.10.2、Kimi K3 抽取、multilingual-e5-small INT8 384 维、纯语义检索。代码不依赖测试机的绝对路径，也未把该模型配置写死。Hindsight 若使用云端抽取，索引内容会发送给对应供应商，需要按实际部署配置处理。

移除 `CODEPRO_HINDSIGHT_URL` 配置并重启后端即可停用增强，本地记忆继续工作。停用不会删除外部 bank；移动项目或更换配置目录会产生新 bank，旧数据需要明确清理。

部署接口参考：[Hindsight MCP 官方文档](https://hindsight.vectorize.io/developer/mcp-server)。本机隔离环境的搭建脚本不是项目可分发安装器，本次没有承诺一键部署能力。

## 6. 已执行验证与复验入口

以下结果来自同一 CodeBuddy 工作区、对应已修改源码。源码在验证后没有再改动；提交阶段只整理提交和文档，因此复用有效结果，没有重复进行全量构建。

| 命令 | 本轮结果 |
| --- | --- |
| `cargo test -p goose --lib read_only_analysis --jobs 1 -- --test-threads=1` | 10 通过，退出码 0 |
| `cargo test -p goose --lib project_memory --jobs 1 -- --test-threads=1` | 51 通过、1 忽略，退出码 0 |
| `cargo test -p goose --lib hindsight_ --jobs 1 -- --test-threads=1` | 4 通过、1 忽略，退出码 0；与上项有重叠，勿累计总数 |
| `cargo test -p goose --lib hindsight_live_roundtrip_update_delete_and_isolation --jobs 1 -- --ignored --test-threads=1 --nocapture` | 真实服务 1 通过，退出码 0 |
| `cargo test -p goose --test codepro_project_memory_tools --jobs 1 -- --test-threads=1` | 14 通过，退出码 0 |
| `cargo test -p goose --lib r3_ --jobs 1 -- --test-threads=1` | 17 通过，退出码 0，覆盖完成证据等边界 |
| `cargo test -p goose --lib task_contract --jobs 1 -- --test-threads=1` | 5 通过，退出码 0 |
| `cargo clippy -p goose --lib --jobs 1` | 退出码 0；25 条既有警告，并非零警告 |
| `pnpm.cmd --dir ui/desktop run ensure-dev-backend` | 构建并同步新版后端，退出码 0 |
| `git diff --check` | 通过 |

真实服务测试默认忽略，需先准备 `127.0.0.1:18988` 的兼容服务，并允许合成资料写入和模型调用费用。不要把普通测试中的 ignored 当作失败或通过。

`project_memory_retrieval_benchmark.rs` 是前期评估使用的默认忽略入口，通过 `CODEBUDDY_MEMORY_EVAL_INPUT` 和 `CODEBUDDY_MEMORY_EVAL_OUTPUT` 指定外部合成数据与报告。输入字段为 `memories`、`updates`、`crossProject`、`cases`；它含前期固定测试主题/更新断言，使用前需阅读测试并准备相匹配的数据。数据集与评分脚本没有作为产品源码提交，不是合并必跑门禁。前期评估正常执行不等于新增索引在所有问题上都准确。

### 真实产品验收（Kimi，合成项目）

| 场景 | 实际结果 |
| --- | --- |
| 保存一条发布规则 | 本地确实保存一条；工具约 64 毫秒，任务最终 `finished` |
| 新对话用“上线”查询原文“发布” | 实际原生记忆查询含版本核对后的语义候选，正确回答周五上午十点，正常收尾 |
| 同一对话追问时间与未知银行 | 正常查询；识别无关语义候选，核对本地记录后回答银行未知，没有编造 |
| 关闭隔离 Hindsight 服务 | 本地降级回执明确说明语义不可用；模型缩短关键词后找到记录，最终 `finished` |
| 服务恢复 | 健康检查 HTTP 200，数据库已连接 |
| 更新、旧版本、项目隔离、删除 | 另以真实服务集成回归验证，并非全部通过自然语言完整会话验证 |

正常检索调用约 40–195 毫秒；离线回退约 1.55 秒。这是工具调用耗时，不是完整任务耗时。本轮发生过超过两分钟的模型等待，以及离线测试开始时两次模型预检暂时不可用；之后在 Hindsight 仍关闭时重试并完成。预检失败的具体网络原因没有证实，未将其归因为记忆模块 Bug。

验收后端 SHA256：`F39BD93ED6A4D197000BFD682130FE278F4AF45F0C694AD8AD06122A9D79B4BF`。产品会话：`20260930_11`（保存）、`20260930_12`（新对话及续聊）、`20260930_13`（离线回退）。测试机原始回执与构建日志保留在 `D:\CodeBuddy\.cargo\hindsight-eval` 和 `D:\CodeBuddy\.cargo\codebuddy-port`，没有提交会话、截图或配置到 GitHub；同事可按上面的场景独立复验。

## 7. 尚未完成的范围 / 合并后注意事项

- 自然语言“删除/清空记忆”的完整任务完成链尚未验收；底层删除同步通过不等于该产品流程通过。
- 只验证了少量合成案例和 Kimi，不应宣称所有模型或所有实际项目稳定。
- Hindsight 仍可能返回无关候选；宿主校验的是本地身份与版本，问题相关性仍需模型判断。
- 本地回退仍是原文本包含匹配，多个词组成的查询可能需要缩短关键词；没有顺便重写本地检索算法。
- 初次索引是异步的，立即查询可能暂时没有完整语义结果；离线时本地删除立即生效，外部副本等恢复后对账。
- 当前任务核验仍有 inspect / revise / propose_coverage 的模型调用开销。本次修复错误阻断，没有重构整个公共任务协议。
- 原自动注入的最近 20 条 / 6000 字符策略、语义冲突合并、设置页配置、一键服务安装均不属于本次完成内容。

## 8. 回滚原则

仅停用语义增强：移除配置并重启，无需改本地记忆文件。需要撤回代码时，按团队流程逐个 revert 对应提交，保留同事后续改动；不要 reset 共享分支，也不要删除本地记忆目录。外部 bank 数据清理由部署负责人另行确认。

接入细节另见：[HINDSIGHT_MEMORY_ZH_CN.md](HINDSIGHT_MEMORY_ZH_CN.md)。
