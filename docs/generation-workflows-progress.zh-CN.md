# 生成等待反馈与固定工作流（2026-10-23）

本批基于 main 开始于 f6d5317；验证期间另一个任务提交后 HEAD 为 09b0219。本批改动尚未提交，未修改其他任务的模型默认配置或安装凭据。

## 证据与原因

- 用户提供的宠物会话 fc2cd641-4c2f-45e4-8438-49afa98036da：底层模型 transport 日志显示两次 HTTP 响应头等待分别为 206286 ms、122499 ms，整次请求为 208810 ms、122632 ms，均只有一次请求。事实是响应前等待；服务端排队、网络或推理预填充各占多少尚无服务端证据。
- 另外两个会话 a2f2de52-72dd-4488-ae86-8091a5e17051、46622249-8cdb-4253-a578-33e9b4dbe6b5：有 1377089 ms、714797 ms 请求，响应头只花 19 ms、56 ms，期间分别收到 22026、16423 个推理字符。此类等待发生在流式生成期间，不等同于连接卡住。
- 宠物会话中首图没有传 reference_images；仅凭搜索文本填写了未核实的外观，之后八个动作沿用这张生成图。搜索成功与视觉相似度是不同证据。
- 预览 jobs 接口原先等待 history/queue/下载完成才返回，慢服务也拖住已有任务卡片。
- 导出的消息时间全部相同，不能用于耗时归因。本次采用原生 session.v4.jsonl 与 transport 日志。旧导出时间回退问题尚未修改。

## 改动与边界

前端保留宿主状态权威，明确显示准备、连接、等待模型、接收输出和工具执行；20 秒无新活动时增加等待说明及停止提示，不伪造百分比或把长等待判为失败。已有停止按钮负责取消。右侧先返回持久化任务快照、后台去重刷新，再显示真实节点阶段、队列位置、经过时间、预览与完成结果。

默认优先复用固定 workflow_id。经用户本轮授权，当当前生成模式的已登记模板都缺少节点或模型时，允许通过 fallback_workflow 提交新 API 图；提交前由宿主重新检查 /object_info。有依赖可用的模板时拒绝替换图。原导出完整保存在 runtime/assets/comfyui，适配器只填提示词、参考文件、种子、输出前缀、尺寸选择和视频时长；显式指定编辑尺寸时使用原模板已有的尺寸开关。尺寸必须满足原分辨率节点支持的比例及至少 0.1 MP。省略尺寸/时长保留模板默认值。单张参考图绑定模板两个参考槽中的同一真实图片，避免读取示例图。

| ID | 导出文件 | 用途 |
| --- | --- | --- |
| qwen_image | QI2.1_t2i1.json | 文生图 |
| qwen_edit | QI2.1_i2i.json | 一至两张参考图编辑 |
| minimax_text | video_minimax_h3_t2v (1).json | 0.6 MP 文生视频 |
| minimax_text_detail | TextToVideo.json | 0.9 MP 文生视频 |
| minimax_image | video_minimax_h3_i2v.json | 首帧生视频 |
| minimax_reference | video_minimax_h3_r2v.json | 一至两张参考图生视频 |

唯一经用户明确批准的模板修订：QI2.1_i2i 的 459:453 编码器由 qwen3vl_32b_minimax_h3_int8_convrot.safetensors 换成 qwen3vl_8b_int8_convrot.safetensors。原模板真实运行报期望 4096 维、实际 5120 维。D:/ 原始文件保留，仓库副本仅改这一值；修订后 SHA256 为 6e05bc8a3e62376e9ad80603f7f5eba8f25e0e1f73795da500ac194a4dcc59be。

宠物 prepare 指引要求已知角色先取得并查看真实参考图，首稿展示后询问用户相似度，再制作动画。这是 Agent 制作流程指引，尚未新增强制审批状态机；真实角色相似度仍需用户确认。没有通过换模型、自动重试生成或关闭推理来掩盖等待。

## 验证

- Node 24：`node --test runtime/tests/comfyui-workflows.test.mjs runtime/tests/comfyui-tool.test.mjs runtime/tests/comfyui-video-tool.test.mjs runtime/tests/comfyui-live.test.mjs runtime/tests/desktop-pet-tool.test.mjs`：22 项通过，退出码 0。覆盖固定图结构、非法覆盖拒绝、Harness 真实工具调用、非阻塞快照、参考上传、输出保存、去重、取消与旧回执。
- 在 ui/desktop 使用现有 ui/node_modules 下的 Vitest 执行包脚本对应参数：三个相关组件文件 23 项通过，退出码 0。`tsc --noEmit` 通过，退出码 0。
- `node scripts/i18n-compile.js` 后，Playwright 的 work-status.browser.spec.ts 在真实 Edge 中完成简体、繁体、英文三项，退出码 0，包含模拟 206 秒等待的可见提示；截图已检查。这是实际组件的浏览器验收，尚非已安装桌面应用全流程验收。
- ComfyUI 真实文生图：57e1eec4-dec4-414a-a8a1-4fc0851ae650，512×512，成功。
- 图生图原模板：9318d7bd-43a3-445a-af45-39ea77b4a178，模型维度不匹配，失败如实显示。
- 经批准修正后：b7c30e5d-48e6-4e5a-a53c-0210a1ca3ede，512×512，成功；实际检查原小熊猫保留，蓝围巾变红。此结果验证参考编辑链路，不代表菲欧妮相似度已验收。
- 临时验收回执与产物位于 `%TEMP%/codebuddy-approved-workflows-BB7oRB`，不纳入提交。

测试过程中的两类问题已修正：新增可选字段 undefined 不符合 Harness 无损 JSON 合同；中文文案需要编译才能被真实浏览器加载。第一次 pnpm 测试触发依赖自动同步（日志 downloaded 0）和 postinstall，已中止并恢复它删除的四个已跟踪 SDK 生成文件；没有继续安装依赖，后续直接调用现有测试程序。node_modules 曾被该同步改动，不宣称环境完全未变化。

本批未打包、未覆盖安装版、未提交/推送。模型服务首响应耗时与实际角色最终相似度没有被前端改动消除。

参考：ComfyUI 官方 [路由](https://docs.comfy.org/development/comfyui-server/comms_routes) 与 [WebSocket 消息](https://docs.comfy.org/development/comfyui-server/comms_messages)。节点进度只代表当前节点，不冒充整个任务的完成百分比。

补充真实验收：参考图生视频 c2b7f86f-cfb0-4bf6-999b-edd59f80268f 已成功，512×512、2.333 秒 MP4（按模型帧网格取整）。Edge 实际播放到 0.515 秒且 video.error 为 null，截图已检查。其余三个视频模板通过结构与参数合同测试，本轮未逐一生成视频。

## 无可用工作流时创建（本轮补充）

图片与视频工具新增 operation=inspect，返回对应模式的模板、缺失依赖、creation_allowed、分页节点名称和指定节点的实际输入/输出定义。Agent 根据实际已安装节点、模型组合工作流；宿主检查图大小、连接、环路、输出、参考上传绑定与提示词/显式参数绑定，再交给 ComfyUI /prompt 做最终节点校验。网络故障、排队和执行失败不开放替换。创建图及指纹记录在原有任务回执中，继续使用原来的查询、取消、预览和产物保存链路。

范围：可复用目录目前是 CodeBuddy 已登记的六份导出，不会自动扫描 ComfyUI 前端保存的任意工作流；新建图保存于任务回执，尚不自动加入可复用模板目录。没有所需模型/节点时提示缺项，不自动安装下载。

本轮 Node 24 运行六个相关测试文件（新增 comfyui-fallback.test.mjs），27 项通过、退出码 0。新增测试覆盖真实 Harness 调用及隔离 HTTP 服务，另验证视频提交和服务校验拒绝；不冒充 GPU 生图/视频验收。真实服务只读 inspect 返回 960 类节点，六个模板的依赖均可用、五种模式 creation_allowed 均为 false；因此没有改动用户服务去人为制造缺失。新分支未做桌面模型自动选择及 GPU 生成 E2E，当前已启动桌面进程尚未重启加载本轮后端修改。
