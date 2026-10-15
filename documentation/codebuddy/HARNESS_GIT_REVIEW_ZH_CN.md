# Harness Git 与代码审查适配

## 范围

新版保留原前端，通过 ACP 和官方 deepseek-harness 接入 Git 读取与独立代码审查。Git CLI 负责仓库事实，`CodeProReviews` 负责审查状态，Harness 负责模型执行。审查完成不代表开发任务完成或测试通过。

`runtime/git-extension.mjs` 提供运行环境、GitHub CLI 状态、仓库快照、状态、冲突、分支和差异七个只读工具。`git__` 工具名与原界面的裸名兼容；返回原 JSON 字段和 text content。Git 注册为默认启用的 builtin，避免旧前端对 platform Git 的重复扩展清理规则。关闭扩展后不向该会话提供工具。

Git 读取使用固定参数、porcelain NUL 协议、输出上限和取消信号。继承的 Git 路由变量被清除；可选索引写入、fsmonitor、外部 diff、textconv、延迟抓取和配置的 clean/smudge/process filter 被关闭。未知或失败状态保留错误，不伪装为空仓库。

## 审查行为

原有 snapshot/start/get/cancel 四个 RPC 由 `runtime/codepro-review.mjs` 接收。工作区范围比较索引与当前文件并包含未跟踪文件；暂存范围比较 HEAD 与索引；分支范围比较 merge-base 与 HEAD。连续两次采集得到相同 fingerprint 才接受快照，启动前重新检查内容和模型。

快照限制为每文件 64 KiB、200 个文件、总内容 256 KiB。敏感路径、链接、非普通文件、二进制、非法 UTF-8 和超额内容明确排除。差异使用已有 jsdiff 5.0.0，在可取消 Worker 中执行。模型接收固定快照，只能调用 `codebuddy_review_result`。宿主验证问题定位确实落在快照的差异段内；覆盖不完整时，空问题列表不构成成功结果。

只有有效结构化提案加 Harness 正常结束才提交 completed。普通文字回复不代表审查成功。取消等待实际执行退出，超时记录 failed，服务重启遗留的 running 记录转换为 interrupted，并保留历史。查询重新计算 current/stale/unknown；读取历史不会自动重跑模型。

## 验证与剩余边界

在当前源码运行 Node 测试：`runtime/tests/git-extension.test.mjs`、`runtime/tests/codepro-review.test.mjs`、`runtime/tests/review-harness-integration.test.mjs`。覆盖原 UI 解析器与 SDK Zod、真实临时 Git 数据、索引不变、快照/位置/时效校验、取消/重启，以及 ACP → 官方 Harness → 本地 HTTP 模型 → 真实宿主回执。没有使用用户仓库或真实云端模型执行这些测试。

Git 暂存、恢复、提交、分支变更、拉取和推送等写操作仍需按原预览合同接入；只读工具测试不代表这些操作已支持。真实 Electron 审查交互、真实模型质量和 macOS 产品验收须分别确认。本记录不是安装包或全功能发布验收。

实现依据：[Git status](https://git-scm.com/docs/git-status)、[Git diff](https://git-scm.com/docs/git-diff)、[jsdiff](https://github.com/kpdecker/jsdiff)。既有 cyanheads Git MCP 适配器的 Windows runner 和输出结构不同，未用其旧 Agent 执行链替代 Harness。
