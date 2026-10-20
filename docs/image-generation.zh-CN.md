# 内置图像生成

主 Agent 通过 `generate_image` 调用 ComfyUI，可生成普通图片、透明素材以及基于参考图的编辑结果。聊天模型负责理解需求和编写提示词，ComfyUI 工作流负责生成像素。

在“设置 → 模型与运行 → 图片与视频 · ComfyUI”保存服务地址。当前默认值为用户指定的 `http://192.168.9.111:8188`，使用该服务已安装的 Qwen Image 2.1 工作流。替换地址时，新服务需安装同样的节点和模型：Qwen Image 2.1 int8、Qwen3-VL 8B int8 编码器、Qwen Image 2.1 VAE、`TextEncodeQwenImage21` 与 `SaveImageAdvanced`。缺失时以服务实际错误为准，不自动下载模型或安装节点。

可直接对 Agent 说：“生成一张黄昏森林里的小木屋插画，横版。”工具按需通过 `search_mcp_tools` 加载，沿用现有 Harness 权限和执行链。`generate` 提交一次并返回任务 ID；`status` 最多等待 30 秒，未完成时继续查询同一个任务，不重复提交。每次 HTTP 请求上限为 300 秒。只有服务器完成且图片已保存，才报告 `completed`。

当前每次生成一张 PNG，宽高各为 256–2048，按 32 像素递增；支持最多两张当前工作区内的 PNG 参考图。结果位于当前工作区的 `generated-images/<job_id>/`。任务回执归当前会话所有，重建工具后仍可继续查询，修改服务配置也不会把旧任务发给新服务。可提供 UUID `request_id` 避免重试时重复提交；提交结果未知时保留回执，不自动重发。

`cancel` 使用服务的单任务取消接口，并复查实际状态。旧服务缺少此接口时返回明确说明，不发送影响其他用户的全局中断。停止聊天中的等待与取消远程 GPU 任务是两件事，远程任务须用该任务 ID 明确取消。

“自定义宠物”复用同一个生图工具，再由 `create_desktop_pet` 装配八组动作并注册预览。成品不自动切换当前宠物。透明度、角色一致性与动作质量仍应预览检查。

视频使用同一服务配置，通过内置 `generate_video` 调用 MiniMax H3，支持文生视频与 PNG 首帧图生视频。参数、模型要求和任务查询见[内置视频生成](video-generation.zh-CN.md)。

实现依据：[ComfyUI 官方接口](https://docs.comfy.org/development/comfyui-server/comms_routes)。ComfyUI 持有队列、执行和历史事实；适配工具只保存回执和输出文件，不创建第二套 Agent 调度核心。使用现有 API，自行编写客户端，不复制服务端实现。
