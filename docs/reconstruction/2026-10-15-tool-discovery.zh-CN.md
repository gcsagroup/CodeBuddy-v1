# MCP 按需加载与 Gemma 思考验收（2026-10-15）

候选：1.43.3-harness8。源码基线 main / 01610d03764570282eee439cd2bfb49fcd373e98，加本批未提交修改。源码、用户模型配置与聊天历史保留。

## 原因与边界

- 安装的 Harness 0.2.1-alpha.2 提供原生工具注册表、权限、执行及 system-prompt/assemble 扩展点，没有现成的通用 tool_search 插件；PTC 会把 SDK 全量加入提示，不能直接解决本问题。
- CodeBuddy 的薄适配器现在通过该扩展点，只投影本会话已选择的 MCP 工具。search_mcp_tools 每次返回最多 5 个工具，保留最多 16 个已加载工具；工具箱仍读取完整的原生注册表。权限、执行、压缩和完成仍由 Harness 处理。HTTP MCP 仍复用既有原生预设连接。会话专属 stdio MCP 保留隔离。
- 重开会话从原生请求头恢复已选择工具；旧版全目录请求头不会被误当成已选择列表。辅助视觉等无 MCP 的只读会话不会新增搜索工具。
- 上下文容量按服务提供的模型元数据解析，Gemma LAN 当前 max_model_len=65536。未声明容量的服务仍使用适配层保守默认 32768，不代表模型理论最大值。历史消息、系统说明、工具定义均占上下文；压缩历史不会消除必须保留的工具定义，因此首先减少工具注入。
- Gemma 4 使用 chat_template_kwargs.enable_thinking；原先把 high 映射为 reasoning_effort 不能启用该服务的思考。改用官方 pi-ai chat-template 适配，none 映射关闭，其余已支持档位开启。Gemma 仅有布尔开关，不宣称六种档位有不同强度。
- 真实测试另见 Gemma 在普通问候后自行检查空目录并重复执行成功的空输出命令；增加通用提示约束，由模型判断何时需要工具，不以用户文本关键词分流或替代 Harness 完成判定。

## 自动验证

Node 24 执行 runtime/harness/test/*.test.mjs 与 runtime/tests/*.test.mjs（test-concurrency=2）：369 项，初轮 367 通过。失败分别是新 Gemma 夹具遗漏 requiresAuth:false，以及既有 Git 断言把只读模型容量发现也算成了模型执行。修正夹具及只统计实际 completion 后，相关 5 项全部通过，exit 0。其他已通过项未重复。包括原生多次压缩、权限拒绝、子 Agent、暂停/恢复及原生持久化回归。第一轮过高并行的超时不算通过。

证据：.preview-evidence/discovery-full-tests2.log；discovery-repaired-tests.log。新发现测试覆盖 200 个 MCP 工具的首轮裁剪、实际搜索调用、权限拒绝、连接复用与重启恢复。Git diff --check 通过；本批未修改 Rust 或渲染布局。

## 真实服务验证

隔离数据目录，使用已有模型配置，不输出密钥。最终源码第二轮证据 .preview-evidence/discovery-real-nQL0Zr/receipt.json：

| 场景 | 会话创建 | 首个思考片段 | 正文首片段 | 输入 token | 结果 |
| --- | --- | --- | --- | --- | --- |
| Gemma 首次问候 | 8ms | 11.1s | 14.2s | 9896 | end_turn，无工具调用 |
| Gemma 热进程新会话 | 9ms | 2.1s | 14.6s | 9896 | end_turn，无工具调用 |
| Kimi 云端新会话 | 27ms | 7.3s | 7.5s | 9302 | end_turn，无工具调用 |

普通问候发送 43 个基础工具，0 个 MCP 完整 schema。之前 harness7 约 32k 的输入降至约 10k（保留系统说明及 Harness 原生能力）。数字为单次样本，不是稳定延迟保证；模型预填充、思考、网络和冷启动分别仍需时间。MCP 时间查询由真实 Gemma 自行搜索后调用 commonqueries/time_now，3 次模型请求正常完成；注册能力未因裁剪丢失。直接 SSE 对照默认 0 个思考片段，开启后 205 个；Harness ACP 问候也收到连续 agent_thought_chunk。

## 安装包验收

构建与安装后真实界面验证结果待本次流程完成后补充。此前旧包或源代码测试不替代本候选安装验证。

## 安装版实际结果

构建命令：Node 24 执行 scripts/build-harness-windows.cjs target/harness-package-discovery8/harness-distribution，exit 0；包内 Node、原生子进程、Compat 服务门禁通过。随后 CodeBuddy-Harness-Setup.exe --silent 实际升级安装，exit 0。

安装包 target/accepted-harness-installer-1.43.3-harness8/CodeBuddy-Harness-Setup.exe，325128192 字节。SHA256：FD45E62AF22FD10324CB589D85E3B5258655ACA45A12D9F8FF2969EF136F5CB7。安装目录 LOCALAPPDATA/CodeBuddyHarness/app-1.43.3-harness8。EXE、app.asar、运行清单及修改过的全部运行文件与候选/当前源码指纹一致。清单 sourceDigest：262e9c37b68b5765e0654a5169731fe2a44a50e7a0c817c1c774f2251bde5a04。

真实 Electron 界面使用鼠标/键盘控件提交、展开思考、切换模型。Gemma 两次“你好”会话分别在 1001/956ms 出现；首个思考 ACP 分片 6.10/2.85s，正文首分片 10.39/8.49s，均 end_turn，116/153 个思考分片，界面显示 10k / 66k。后续计算问题的可见思考区 616ms 开始增长，采样获得 30 个不同内容长度。思考完成后可展开查看（491 字符的问候思考记录）。第一次脚本选中了隐藏的旧会话节点，已改用可见节点验收，不作为产品失败。

安装版的 MCP 查询由模型搜索后调用 commonqueries/time_now，原生记录为两个成功工具调用，首轮 0 个 MCP schema、搜索后 5 个；原生所有轮次 completed，无工具错误。通过界面把 Gemma 切为 Kimi，继续询问前一轮乘法，正确返回 391，约 7.1s 完成，显示 13k / 33k。未知容量仍不推断为模型最大值。

隔离验收目录 .preview-evidence/harness8-installed-WZF6IR；证据 harness8-ui-cold.json、harness8-ui-warm.json、harness8-ui-reasoning-visible.json、harness8-ui-mcp-time.json、harness8-ui-switch-result.json、harness8-installed-native.json、harness8-installed-identity.json。首次隔离数据种子遗漏 version 字段导致测试配置启动退出；补齐合法测试数据后上述验收通过，产品代码未为该夹具错误修改。

本批交付为 Windows 验证候选；没有重做小时级大项目或 macOS 验收。模型思考与网络仍影响耗时，不宣称消除所有冷启动等待。改动未提交/推送，之前 main=01610d0 的上传状态不代表本批代码已上传。
