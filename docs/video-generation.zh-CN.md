# 内置视频生成

完成后返回本地 MP4 路径和可点击播放链接，链接在浏览器中播放 ComfyUI 保存的视频。播放链接要求该服务在线，本地文件可独立保存与播放；视频不会作为图片嵌入聊天。旧视频回执再次查询时可补齐播放链接，无需重新生成。

在“设置 → 模型与运行 → 图片与视频 · ComfyUI”保存地址，然后直接让 Agent 生成视频。Agent 通过工具发现加载 `generate_video`，与图片工具共用服务地址及现有会话权限。

文字生视频示例：“生成一段 5 秒视频，小熊猫坐在森林溪流边向镜头挥手，640×384，带流水和鸟鸣。”图片生视频示例：“以工作区 reference.png 为首帧，生成 5 秒挥手动画，保持角色一致。”图生视频目前接受工作区内 PNG，按输入图比例设置宽高以避免拉伸。

`generate` 指定 `mode=text_to_video` 或 `image_to_video`，后者要求 `image_path`。默认 640×640、5 秒、24 fps，宽高为 32 的倍数，总像素最多 1344×768；时长 5–15 秒会向上取整到模型的 17k+5 帧网格，因此 5 秒通常输出约 5.17 秒。主 Agent 编写画面、运动、镜头和声音提示词。

工具使用服务已有的 MiniMax H3 FL2VA int8、Qwen3-VL 32B MiniMax int8、视频 fp16 VAE 和音频 fp32 VAE，以及原生采样、解码和 SaveVideo 节点。使用 20 步基础采样，无需额外 LoRA；不会自动安装模型或节点。替换服务地址时需要匹配这些模型与节点。

提交仅一次，返回 job_id 后用 status 查询，wait_seconds 最大 30；网络请求超时 300 秒。只在服务完成、MP4 结构及视频轨元数据通过检查并保存到 `generated-videos/<job_id>/1.mp4` 后报告 completed。回执按会话持久化，修改服务地址后旧任务继续查询原服务；提交结果未知时不自动重发。cancel 仅取消指定任务，不发送全局 interrupt。暂停 Agent 等待并不等于取消 GPU 任务。

实现参考[官方 H3 原生工作流](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native)与已安装节点的 object_info，自行构造 API 图，不复制服务实现或安装第三方节点。复用官方 Harness 提问模块（MIT）；模型许可证按对应模型条款。未以列出模型或队列成功代替视频生成验收。
