# 2026-10-23 桌面流式与交付修正

[繁體中文](2026-10-23-desktop-delivery.zh-TW.md) · [English](2026-10-23-desktop-delivery.en.md)

> 凭据更正：下文“双预置连接补充”描述的是已撤回的历史候选方案。共享云端 Key 及其分发导入已移除，当前源码不内置 Ollama 凭据；新用户须自行配置。请勿按该历史段落恢复共享凭据。近期实现与验证见[桌面交互开发说明](2026-10-25-desktop-ux-and-history.zh-CN.md)。

> 本文保留开发阶段的时间顺序记录；其中“待重建”“Mac LAN 待确认”等为当时状态。后续重建与限定范围的安装版验收已完成，最新状态、限制和 Git 提交交接见[合并交接](2026-10-23-merge-handoff.zh-CN.md)。本地 Ollama 与 Ollama Cloud 的验收范围不同。

## 源码与范围

Windows：`D:\CodeBuddy-v1`，`main`，`d43fcbbd0ec85afcb073cb74b14e835752a26e20` 加既有及本批未提交改动。接手时已有 278 条工作区变更；没有创建分支、提交或推送。Mac：`/Users/erjinyi/Desktop/work/CodeBuddy-v1`，使用同步文件哈希确认本批源码，不能用 Mac checkout 的旧 HEAD 代替。文件哈希快照、同步备份与校验回执位于两端 `desktop-fixes-20261023/final-visible-source` 本地证据目录。

本批实际改动：`runtime/harness/{profile,tool-discovery,transport-observation}.mjs`、`runtime/{browser-tool,providers,work-status}.mjs` 及对应回归；桌面 `MarkdownContent.tsx`、`ErrorBoundary.tsx`、`ui/scroll-area.tsx`、Markdown 测试和流式浏览器夹具/测试。保留原有 Harness、默认模型、浏览器控制和用户配置机制；没有恢复旧 Agent 核心。

## 证据与处理

- 原飞机会话 `31d71166-1257-4c44-87dd-512a4c7cd9d2`：第一轮首思考约 3.34 秒，首正文约 14.29 秒，118.13 秒时停止，未调用写文件工具。不能据此声称界面一直缓存到最后。第二轮写文件参数生成约 100 秒，仅写文件，没有浏览器调用。
- 可复现的前端开销来自流式长代码高亮。流式代码及超过 8000 字符的历史代码使用完整纯文本代码块，保留复制、滚动和内容；短的已完成代码仍高亮。ResizeObserver 中的布局写入合并到下一动画帧并在卸载时取消。普通窗口错误与 React 渲染异常分开记录。
- 将当前作用域允许的 `write`、`edit`、`browser_control` 放入首轮工具集，其余工具继续按需发现；不恢复被权限过滤的工具。模型负责区分项目交付与仅示例要求。提示要求真实落盘、浏览器检查和依据回执报告结果，宿主不扫描自由文本决定意图。
- 浏览器打开必须返回真实 tab ID 与 HTTP(S) 地址；错误回执不作成功。新增工具参数首包与字符数诊断，不记录参数内容；状态区显示参数生成尚未执行，避免把这段时间笼统展示为思考。
- Ollama 复用现有 Local Ollama 设置入口、`/api/tags` 和 `/api/show`。读取 chat/tools/vision 能力；明确不支持工具调用或非聊天模型时给出原因，未知能力保留兼容路径。默认 LAN 地址 `http://192.168.9.101:8001`，模型 `gemma-4-26B-A4B-it-uncensored-FP8-W8A16`、65536 上下文及图像能力不变；已有配置与主动删除默认连接的选择不被覆盖。

设计参考：[React memo](https://react.dev/reference/react/memo)、[useDeferredValue](https://react.dev/reference/react/useDeferredValue)、[Ollama 官方 API](https://github.com/ollama/ollama/blob/main/docs/api.md)。本批未增加依赖；未使用人为播放节流。

## 已完成验证

命令使用已有 Node 24，均退出 0。Windows Node 24.18.0；Mac Node 24.21.0。

| 验证 | 结果 |
| --- | --- |
| Windows `node --test`：providers、browser-tool、tool-discovery 及默认模型相关回归 | 首组 26 项通过；默认分发模型独立 6 项通过 |
| Windows transport-observation、browser-tool、work-status、store-atomicity | 16 项通过；追加参数状态回归后 work-status 8 项通过 |
| Windows Vitest：MarkdownContent、GooseMessage.stream、OnboardingGuard、CustomProviderForm.localConnection、browserControlClient | 60 项通过 |
| Windows Vitest：chatSessionStore、ProgressiveMessageList、ThinkingContent | 115 项通过，覆盖取消、迟到事件和历史恢复 |
| Windows Playwright：streaming.browser | 4 项通过 |
| Windows Playwright：scroll-area.browser、workspace-browser.electron | 21 项通过，包含原生嵌入页观察、输入、点击及释放 |
| 两端 `tsc --noEmit` | 通过 |
| Mac Node：providers、browser-tool、distribution-model、store-atomicity、tool-discovery、transport-observation | 38 通过、1 平台条件跳过；追加 work-status 8 项通过 |
| Mac Vitest：MarkdownContent、GooseMessage.stream、chatSessionStore、OnboardingGuard、browserControlClient | 109 项通过 |
| Mac Playwright：streaming.browser、workspace-browser.electron | 5 项通过 |

同一 Windows 长 HTML 夹具 112 次渲染：p95 从 9.7ms 到 3.9ms，最大从 748.7ms 到 9.1ms，总渲染时间从 2099.9ms 到 304.7ms；浏览器长任务从 3 个/1583ms 到 0。Mac 修复后 p95 4.2ms、最大 6.9ms、0 长任务。该数据是受控夹具结果，不代表所有会话或长期内存压力测试。

Windows 真实候选会话 `d21a0cca-c56f-4954-b593-54400b250380`：原提示实际写出 `plane_war.html`（9720 字节、345 行）；随后“在右边打开”确实加载右侧游戏，观察到游戏结束及重新开始。打开轮次约 32 秒，包含约 27 秒批准等待；批准后浏览器回执约 0.3 秒。真实停止：UI 恢复空闲 212ms，Harness 用户中止 253ms。旧历史可读。之后开发页发生重新加载，浏览器标签被释放；该次重载原因未确认，未归因于停止，也未把标签跨重启恢复列为通过。初次交付总结仍含“保存上面代码”的错误措辞，后续补充了根据真实文件链接报告的提示；最终提示的效果需用新会话验收。

## 环境边界与交接

Windows Ollama 服务可达，但模型列表为空；Mac 未发现运行中的 Ollama 服务及标准安装。未下载模型，所以两端真实 Ollama 推理、工具和图片效果仍待用户提供已安装模型。自动化 API 回归不等于这些产品验收。

本机证据：Windows `.preview-evidence/desktop-fixes-20261023`；Mac `/Users/erjinyi/Desktop/work/desktop-fixes-20261023`。原配置与历史继续放在 `browser-control-20261022/profile-ready`。详细手测提示在该目录的 `manual-tests`，应使用本批候选，不使用旧快捷方式。

安装包、签名、源码摘要及最终启动结果见本地 `delivery.json`。安装包构建不代表安装/卸载、公开分发、公证或全功能验收通过。持续内存压力、所有模型组合及完整 Mac 模型任务仍应按下面的用户流程验证。

## 手动验收

1. 新建会话发送“帮我开发一个飞机大战的小游戏用html就行”，检查实际 HTML 文件、变更卡片和右侧页面；如批准框出现，由用户处理。确认总结链接指向已经写入的文件。
2. 发送“在右边打开”，页面必须真实加载；要求观察页面并用浏览器工具验证交互，只有文字声称完成不算通过。
3. 新会话发送“只给一个 HTML 按钮示例，不创建文件”，应只返回示例；不应产生写文件动作。
4. 请求长代码，观察滚动与输入，生成中停止；切换旧会话再返回，检查最终状态、完整正文、复制及没有迟到文字继续增长。
5. 全新隔离数据目录首次启动，直接进入新任务入口并显示默认 LAN 模型；已有目录启动不得覆盖模型、历史或已选择的设置。
6. 设置中添加 Local Ollama，确认服务地址、加载模型；空列表提示先安装模型，不自动下载。使用已安装且支持工具的模型测试小文件写入；支持 vision 的模型另测图片。断开服务应显示连接问题；无工具能力模型应明确说明，不假装执行成功。


## 双预置连接补充

新安装同时提供 CodeBuddy LAN 和用户现有的 ollama 云连接（https://ollama.com，22 个模型预设）；LAN 保持初始选中。本批安装包按用户明确授权携带统一的 Ollama Cloud Key，首次启动自动导入本机受保护凭据，新用户直接可用。未配置连接也显示配置卡片，但不会进入可执行模型选择或子 Agent 模型设置；已有用户设置保持原样。相关改动为 runtime/default-model.json、store.mjs、distribution-model.test.mjs，ModelsAndRuntimeSettings、ProviderSettingsPage 及三组设置界面回归。

Windows 最终运行时七组回归共 51 项通过；双预置和原子存储原有 13 项在两端通过；新增共享凭据回归后的结果见 delivery.json。新增设置界面三文件 10 项通过，Windows 类型检查和定向 ESLint 退出 0。最终源码清单位于 shared-cloud-source/source.json；安装包和各端最终验证结果以本地 delivery.json 为准。

Mac DMG 在存在同名旧挂载卷时创建 Finder 布局失败，已将 macos-dmg.cjs 改为持有显式创建的 Finder 窗口；原有挂载卷保留。修正后完整 DMG 构建通过。Windows 经用户允许在用户临时目录暂存并验证载荷，原目录权限保持原样。

## 继续验收发现与修复（2026-10-23）

安装候选的真实云模型任务暴露了内置浏览器截图适配缺口：图片未经过官方附件入库，随后模型请求报 attachmentId 缺失。宿主工具入口现复用既有视觉路由和 Harness 附件服务，持久化图片引用，观察失败保留动作回执。新增下一步模型请求、重启恢复及异常图片回归；Windows 相关 82 项测试通过。候选包需要重建后重新做真实验收。

Ollama kimi-k3 原始流正文为空，独立 API 已复现，云列表首项调整为 kimi-k2.6；22 个目录项并未逐一验收。Mac 安装版 LAN 请求返回 EHOSTUNREACH，同机 curl 成功，本地网络权限仍待用户确认，不计为通过。
