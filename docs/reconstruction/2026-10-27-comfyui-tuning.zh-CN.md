# ComfyUI 参数、技能与后台等待

[繁體](2026-10-27-comfyui-tuning.zh-TW.md) · [English](2026-10-27-comfyui-tuning.en.md)

## 结果与边界

2026-10-27，基于 `D:\CodeBuddy-v1`、`main`、`797b2b0acb12456a12a42a5dc9f3cf97ca2880c9` 的既有 dirty worktree 实施。保留本轮之前的 ComfyUI 进度与其他桌面改动；本批未提交、未推送，未安装依赖，未更改服务器已保存工作流或提交新的 GPU 任务。

用户提供的三个文件均为 API 图：I2V 与 T2V 的默认时长为 30 秒，R2V 为 5 秒。“期间”对应秒数，通过现有表达式按 24 fps 转为帧数并对齐。时长绑定此前已存在，本批补足参数可见性和调参接口。

## 改动

- `runtime/comfyui-saved-workflows.mjs`：检查结果新增 `duration_seconds` 与 `tunable_parameters`；沿原图连接暴露 Turbo 开关、普通／Turbo 步数、LoRA 强度、采样器、scheduler、denoise、适用节点的 CFG 和参考图尺寸策略。`workflow_parameters` 只接受检查返回的标量控件，校验当前类型、范围和枚举，拒绝重复／未知 ID。提交前重新读服务端图和 schema；UI 子图控件与 API 图同步更新。模型、文件路径、公式、图连线和 fps 不在通用调参范围。
- `runtime/comfyui-tool.mjs`、`runtime/comfyui-video-tool.mjs`、`runtime/comfyui-workflows.mjs`：接入共享参数定义和输入校验。状态等待支持 0–240 秒；省略或 0 仍保留一次即时查询的兼容行为。
- `runtime/comfyui-live.mjs`、`runtime/comfyui-tool.mjs`：侧栏与长等待共享观测节奏，WebSocket 连通时约 30 秒核查一次历史，断线时约 10 秒。结束事件唤醒核查，不直接声明完成。慢下载可继续进行，不延长模型的前台等待预算，也不重新提交生成。
- 从任务创建起累计 240 秒后，仍 queued/running 的回执返回 `waiting_in_background=true`，指导模型结束本轮，准确告知仍在排队／生成，结果在右侧生成面板显示。停止自动模型轮询；用户主动询问仍可即时查询。右侧现有会话观察继续保存和展示结果。切换会话或退出应用后，ComfyUI 可继续运行，回到原会话恢复本地观察。
- `runtime/harness/comfyui-skill.mjs`、`profile.mjs`、`tool-discovery.mjs` 与 `skills/comfyui/SKILL*.md`：使用现有 Harness 技能注册、加载与权限范围，提供简体／繁体／英文技能。模型选择加载技能后展示已注册的媒体工具；不通过用户文本关键词强制分流，不额外授予执行权限。
- 回归位于 `runtime/tests/comfyui-saved-workflows.test.mjs`、`comfyui-video-tool.test.mjs`、`comfyui-skill.test.mjs`。完成事实仍归原 ComfyUI 工具的历史回执与产物保存逻辑；未新增完成状态 owner、后台 Agent 或另一套执行核心。

## 为什么自写适配技能

[ComfyUI 官方事件文档](https://docs.comfy.org/development/comfyui-server/comms_messages)区分执行开始、节点进度、执行结束及错误；据此复用现有 WebSocket，仅用终结事件触发历史确认。

[artokun/comfyui-mcp 的 MiniMax 技能](https://github.com/artokun/comfyui-mcp/blob/main/plugin/skills/minimax-h3-video/SKILL.md)是可参考的现成资料。2026-10-27 查询其仓库未归档，最近推送为 2026-10-26，MIT 许可；该技能最近提交为 `a04162b4f566ce5b31be10fb9b70868cf68f38f0`。它依赖自己的 `save_workflow`／`panel_load_workflow` 等工具，直接装入并不适配 CodeBuddy 的现有接口与任务收据。采用官方工作流知识，自写薄技能，不安装另一套 MCP 或复制第三方实现。许可证：[MIT](https://github.com/artokun/comfyui-mcp/blob/main/LICENSE)。

## 实际验证

运行时测试使用已有 Node `v24.22.1`，可执行文件位于 `C:\Users\jiangrui\AppData\Local\OpenAI\Codex\runtimes\cua_node\1fb7137c46617d50\bin\node.exe`。

| 命令／检查 | 结果 |
| --- | --- |
| 上述 Node 执行 `--test runtime/tests/comfyui-*.test.mjs runtime/tests/generated-image-observation.test.mjs runtime/harness/test/computer-skill.test.mjs` | 58/58，退出码 0 |
| `corepack pnpm --dir ui/desktop run test:run src/workspace-panel/WorkspaceGeneration.test.tsx src/workspace-panel/WorkspacePanel.test.tsx` | 38/38，退出码 0；系统 Node 22.23.2 发出 engine 警告，未改环境 |
| `corepack pnpm --dir ui/desktop exec playwright test generation-wait.browser.spec.ts --reporter=line --output=D:/CodeBuddy-v1/.local/comfyui-tuning/browser-results` | 2/2，退出码 0；真实 Edge，含 MP4 播放与窄窗口截图检查，使用受控媒体夹具 |
| 用户三个 API 图及服务端四个视频 UI 图，只读绑定并重新编译 | 7 组通过，T2V/I2V 各 7 个可调控件，R2V 8 个；未调用 `/prompt` |
| `git diff --check` | 退出码 0 |
| `python .../skill-creator/scripts/quick_validate.py runtime/harness/skills/comfyui` | 退出码 1：现有 Python 缺少 `yaml`；未安装。改用现有 JS YAML 库验证三个技能文件的 frontmatter，并通过真实 Harness 注册／加载测试 |

第一轮新增测试暴露了后台启动时序断言与技能测试夹具过滤范围问题；修正后完整相关测试通过。旧版本测试、首次失败和只读服务检查均不作为真实视频生成成功证据。

开发启动沿 README 的 `start-preview.ps1`，仅通过已有 `CODEBUDDY_HOME` 配置指定隔离目录 `.local/comfyui-tuning/preview`。SDK、语言资源、Electron 主进程和 preload 已构建，日志确认 React ready；启动进程持续运行，非安装包交付。构建来源为上面的 revision 加当前未提交改动。

本机证据：`.local/comfyui-tuning/final-tests.log`、`panel-tests.log`、`browser-tests.log`、`live-audit.json`、`preview/logs/preview/launch.json`。夹具与 profile 不提交。

## 待真实产品验收

在新开发版新建会话，使用当前 ComfyUI 连接，提出“生成一段 30 秒视频，使用已保存 MiniMax T2V，开启 Turbo；超过 240 秒就告诉我后台仍在生成，完成后右侧展示”。核对模型读取技能和 live 参数、仅提交一次、240 秒后停止自动轮询、右侧完成并能播放。I2V／R2V 使用自己的 PNG 验证参考身份，核对实际时长与画面质量。会话导出用应用现有入口；日志在上述隔离目录中。

尚未执行真实模型 + GPU + 桌面完整生成流程，未确认调参后的内容质量、显存占用或长视频成功率。当前交付为实现、自动验证与开发版验收准备完成。

## 后续修复：使用技能先进入新建对话

截图中的提前建目录来自通用技能入口：`noAutoSubmit` 只禁止自动发送，仍会创建会话。`SkillManager.tsx` 现在传递已有 `draftOnly`；`App.tsx`、`Hub.tsx` 支持普通对话草稿，CodePro 复用已有草稿流程。点击“使用技能”只预填命令，用户可编辑、选择项目或离开；发送后才沿原流程创建会话及目录。项目技能保留原工作目录，既有空文件夹未删除。

补充回归位于 `App.test.tsx`、`CodeProHub.input.test.tsx`、`codepro/CodeProHub.test.tsx`、`skills/SkillManager.test.tsx` 和 `tests/e2e/skill-draft.spec.ts`。Windows E2E 的 `fixtures.ts` 对齐 README 的 `start-preview.ps1`，传递当前 Node 和 Harness 调试端口；未安装依赖或更换系统环境。

- `corepack pnpm --dir ui/desktop run test:run src/components/skills/SkillManager.test.tsx src/components/codepro/CodeProHub.test.tsx src/components/CodeProHub.input.test.tsx src/App.test.tsx`：首轮 63/64，唯一失败是新增测试的 Windows 路径字面量；修正并增加普通路由断言后，重跑后两文件 31/31、退出码 0，前两文件已通过。
- `corepack pnpm --dir ui/desktop run typecheck`：退出码 0。
- 现有 Node 24 执行 `../node_modules/@playwright/test/cli.js test skill-draft.spec.ts --reporter=line --output=D:/CodeBuddy-v1/.local/skill-draft/e2e-rerun`（工作目录 `ui/desktop`）：1/1、退出码 0。隔离 profile 中真实 Electron 连续两次点击不产生目录，发送后只新增一个；已审阅前后截图。首次启动因旧夹具选用 Node 22 失败，不计为产品行为失败。
- 上述 `src/` 文件及新 E2E 的定向 ESLint、`git diff --check`：退出码 0。额外对共享 `fixtures.ts` 执行 ESLint 返回 16 个既有规则错误；对 HEAD 内容重跑确认同样 16 个，未扩大整理。新 E2E 已格式化；`CodeProHub.test.tsx` 的既有整文件格式差异未扩大整理。

证据在 `.local/skill-draft/`，其中 `e2e-rerun/` 保存截图与启动回执。验收来源仍为 `main@797b2b0` 加本批未提交改动；未提交、推送或打包安装版。本次确认技能入口与建会话流程，前述真实 GPU 生成验收仍待执行。

### 技能预填文案统一

工具箱“使用技能”复用输入框技能菜单的 `composerMessages.useSkill`，简体和繁体显示“使用 comfyui 技能：”，英文显示“Use the comfyui skill to:”。保留草稿及目录选择行为。`corepack pnpm --dir ui/desktop run test:run src/components/skills/SkillManager.test.tsx src/components/ChatInput.queue.test.tsx` 通过 63/63、退出码 0；定向 ESLint、格式检查与 diff 检查通过。证据前缀为 `.local/skill-draft/unified-text-`。

真实 Electron 运行同一 skill-draft.spec.ts 对照工具箱与 / 菜单：预填文字完全一致、发送前无新目录、发送后一个目录，1/1 通过、退出码 0。截图已检查，结果位于 unified-text-e2e/。
