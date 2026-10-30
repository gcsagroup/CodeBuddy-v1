# MiniMax H3 提示词

适用于本工具已支持的 T2V、I2V、图片 R2V。模型另有的音频／视频参考、末帧、控制网络功能不自动成为本工具能力。先读真实参考图，按用户目标组织内容，不把模板旧文案当需求。

## 结构选择

- T2V：使用 `integrated_multimodal_description`、`overall_soundscape`、`non_diegetic_music` 三段，分别承载视听事件、环境音和配乐。
- I2V：沿 [requests.json](requests.json) 的首帧对齐开头和三段结构；从图中构图与身份出发描述后续运动，不重新发明首帧。
- R2V：使用 `subject_definitions`、`summary`、`retention_analysis`、`detailed_description`、`overall_soundscape`、`non_diegetic_music` 六段。把第一个上传路径映射为 `<Picture 1>`，第二个为 `<Picture 2>`；给复用人物／物体稳定的 `<Subject N>`。说明保留与改变的特征，在画面描述里保持同一对应关系，不虚构 `<Video N>`／`<Audio N>` 参考。

## 让内容可生成

场景与动作描述优先用英文；用户对白及画面文字保留原语言。镜头从 `[Shot 1]` 开始，后续镜头按递增切点描述，例如 `[Shot 2] At 00:03.500, ...`；切点须在请求时长内。少量连续动作可用一个镜头，不为填满时长堆无关情节。

明确主体、动作结果、镜头运动、声音；对白写在相应画面，使用稳定说话人 `(S1)` 等与 `<d>` 标签，字面台词按用户要求保留。用户要安静／无配乐时明确声音字段，不凭空补音乐或对白。H3 的输出可带音轨，但是否有声和具体内容须检查。

检查时间线是否可实现、两参考是否误换身份、画面文字是否逐字保留。没有负面条件分支的图不塞入禁词清单；不靠更高 CFG 代替清楚的正向描述。示例只是结构，实际身份和场景来自用户。

## 调参与验收

时长由 `duration_seconds` 传秒数，工作流保留帧对齐；不要自己重写 length/fps。Turbo／采样参数依 live 绑定，默认值不因教程中的数字而被覆盖。没有用户试样授权时不额外生成样片。首次产物先检查实际尺寸、时长、画面和可播放性，再依据反馈讨论下一次修改；技术成功与质量满意是两件事。

来源（2026-10-27 查阅）：[Comfy H3 提示指南](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide)、MiniMax 的[基础模式](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)和[全参考模式](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)。只使用本接口支持的子集，完整指南不授予新增接口能力。
