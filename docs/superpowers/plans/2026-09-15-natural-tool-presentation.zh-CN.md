# 自然工具动作展示

已完成限定验收。

沿用工具卡和技术详情，标题使用有限本地化动作及文件短名，分列运行中、等待、失败、取消、未知与工具调用完成。工具完成不代表整轮任务完成。完整工具名称、参数、输出与错误仍可展开。

当前请求的新 toolCallId 经会话存储、hook 和消息列表传至工具卡，通知插入不再使状态变成未知。历史回放、已有 ID 与迟到结果不登记；新请求、结束、失败和清理会清空。审批严格匹配 ID，明确回执优先决定终态。ACP SDK 定义工具 ID 在会话内唯一。

相关测试 87 项通过；最终完整前端 230 个文件、2053 项通过、4 项跳过。类型、lint、格式、2600 条消息语言检查、语言编译和渲染构建均为 exit 0。因改动经过会话和消息列表，重跑全量前端；后端源码未变，哈希一致，未重复构建。

隔离原生窗口以脚本 loopback 提供器走真实聊天、审批和工具路径，观察运行中至工具完成；只读命令输出 original、exit_code 0。详情和错误可见，刷新后成功、工具取消及缺少回执的未知状态保持正确。历史失败/取消/缺失回执为已标注夹具；不等同真实模型验收。首次 shell 语法错误属于夹具错误，已保留证据。窗口、进程和提供器已关闭。

[OpenAI App Server](https://openai.com/index/unlocking-the-codex-harness/): public item/turn lifecycle separation informed the design; no private UI assumptions or external code.

Evidence: `.cargo/evidence/audit-fixes-20260914/natural-native-summary.json`, `natural-gates.json`, `natural-source-frozen.json`, `natural-tool-identity-audit.json`. Real model: **NOT_RUN**; 120/107 were not probed.
