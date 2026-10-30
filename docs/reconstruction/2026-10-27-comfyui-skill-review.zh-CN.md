# ComfyUI 技能增强与公开方案比较

日期：2026-10-27。来源：`D:\CodeBuddy-v1`，`main@797b2b0` 加当前未提交改动。范围是现有内置技能、参考资料和合同测试；未改公共工具协议、权限、连接、任务状态归属，未安装第三方技能或依赖，未提交／推送／打包。

## 查到的做法与取舍

| 来源 | 当前核验 | 采用／不采用 |
| --- | --- | --- |
| [Comfy 官方 CLI 技能](https://github.com/Comfy-Org/comfy-cli/blob/main/comfy_cli/skills/comfy/SKILL.md) | GitHub API：GPL-3.0，未归档，最近推送 2026-10-27 | 采用发现与执行分开的思路、以 live schema 为准。CodeBuddy 已有宿主工具，不引入 CLI、云路由或其安装／部署行为；没有复制其实现。 |
| [ComfyUI Agent Toolkit](https://github.com/Zambav/ComfyUI-Agent-Toolkit/blob/main/SKILL.md) | MIT，未归档，最近推送 2026-06-04 | 采用按需读取专题参考、避免机器路径和模型名假设；不引入训练、批量 cron 和额外 API 客户端。未归档不等于已验证持续维护或质量。 |
| [ComfyUI Expert API 技能](https://github.com/MCKRUZ/ComfyUI-Expert/blob/master/skills/comfyui-api/SKILL.md) | MIT，已归档，最近推送 2026-03-18 | 其中每 5 秒轮询、无生成等待上限、直接全局 interrupt 的建议不适合当前产品；保留现有 240 秒转后台及按任务取消。 |
| [ComfyUI 路由](https://docs.comfy.org/development/comfyui-server/comms_routes)／[WebSocket 事件](https://docs.comfy.org/development/comfyui-server/comms_messages) | 官方协议文档 | 交叉核对排队、历史、输出节点事件与任务完成的区别；模型继续消费宿主回执，不直接发 HTTP。 |
| [MiniMax H3 提示词](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide)、MiniMax [基础模式](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)／[全参考模式](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md) | 发布方文档 | 针对当前支持的 T2V、I2V、图片 R2V 整理结构和参考映射，不照搬模型的音频／视频参考、末帧等尚未暴露能力。 |

以上是设计参考而非第三方依赖引入。许可证和仓库状态来自当日 GitHub API；状态会变化。按项目实际接口重新编写操作说明，未复制第三方运行脚本。

## 实际改动

- `runtime/harness/skills/comfyui/SKILL.md`、`SKILL.zh-TW.md`、`SKILL.en.md`：保留主要流程，增加按需阅读、需求边界、素材检查、一次恢复检查和真实交付条件；去掉无条件先跑小样的引导。
- `references/operations.md` 及繁体／英文版：五种模式、参考槽、大小与比例限制、秒数绑定、约束交集、Turbo 生效分支、错误分类和条件 fallback。
- `references/minimax-h3.md` 及繁体／英文版：T2V／I2V 三段、R2V 六段、图片／主体映射、时间线和声音处理，只覆盖现有工具支持范围。
- `references/requests.json`：五种模式各一个参数示例。模型先 inspect 再替换工作流和图片占位符，不自动跑整批。
- `runtime/tests/comfyui-skill.test.mjs`：原生 Harness read 可读取技能附属文件；五个例子通过真实工具代码到受控 HTTP 夹具，检查模式、参考上传数量、prompt／时长绑定、保存工作流身份和不重复提交。

这些文档没有修复或扩大工具自身的能力。例如当前尺寸绑定要求特定比例和 ResolutionSelector；1344×768 模板默认值可保留，但不能因此推断任意显式尺寸覆盖都可用。工具仍负责拒绝无效参数。

## 验证

使用既有 Node 24.22.1：

```text
node --test runtime/tests/comfyui-skill.test.mjs runtime/tests/comfyui-saved-workflows.test.mjs runtime/tests/comfyui-video-tool.test.mjs
```

37/37，退出码 0。补齐 I2V 官方对齐开头后定向重跑 `node --test runtime/tests/comfyui-skill.test.mjs`：8/8，退出码 0。覆盖加载与权限边界、五模式样例、长时长绑定、按原任务恢复、240 秒结束前台等待及后台发布。全部使用隔离临时目录和本地夹具，不消耗真实 GPU。

使用项目既有 JS YAML 库检查 3 个技能 frontmatter、全部 9 个 Markdown 文件的本地引用：通过，退出码 0；不安装 Python YAML。`git diff --check` 通过。分发脚本现有递归 skills 复制逻辑包含参考文件，本轮仅源码检查，未生成安装包。

本机日志：`.local/skill-draft/skill-upgrade-tests.log`、`skill-upgrade-examples-final.log`。本轮没有 UI 逻辑变化，因此未重复桌面构建。新会话加载技能可读取新内容；已加载旧内容的会话需要重新加载技能。

## 仍需真实任务验证

脚本化模型回执与 HTTP 夹具证明加载和调用合同，不证明真实模型一定遵守全部指导，也不证明真实 GPU 质量。真实验收应分别检查：指定 30 秒仍提交 30 秒；I2V 保留首帧身份；两图 R2V 对应不颠倒；修改 Turbo 作用于正确分支；超过 240 秒结束回复并在右侧显示后续产物；断网／OOM 不重复提交。尚未执行上述真实模型＋GPU 成片验收。

[繁體](2026-10-27-comfyui-skill-review.zh-TW.md) · [English](2026-10-27-comfyui-skill-review.en.md)

## 20 秒真实生成验收补充

真实桌面模型选中了 20 秒、512×288 和 Turbo 8 步，但参数未进入 ComfyUI：`workflow_parameters[].value` 的 `type` 数组超出 Harness 校验器支持子集，误报 `must be a lossless JSON value`。改用语义等价的三个标量 `oneOf` 分支，不改变参数值、任务归属或提交逻辑。新增原生 Harness 调用回归，确认布尔、数字、字符串原样传递，数组／对象／null 在派发前被拒绝。

上述三文件测试命令重跑：38/38，退出码 0；`git diff --check` 通过。通过仓库 `start-preview.ps1` 重启同一隔离 profile 后继续真实任务；成片结果另行记录，自动测试不代表 GPU 验收。

真实桌面会话 `0072aa1b-9ea1-4852-b6d8-cb9f472013f3` 于 13:05:49（上海时间）提交唯一任务 `32e161cf-b88f-4561-aade-d1191dc09ca4`。服务端队列确认时长 20、16:9／0.140625 MP／32 对齐、Turbo=true／8 步。模型只调用一次 `status(wait_seconds=240)`，返回 `waiting_in_background=true` 后结束回复；右侧继续显示采样 5/8、63%。本次已验证真实调参、单次提交和前后台交接；记录时视频尚未完成，MP4 时长、播放与画质仍待成片验收。模型未按指导读取额外参考文件，因此不把成功提交表述为完整技能遵循。
