# 模式、调参和故障处理

先以当前工具 schema 为准；以下是 CodeBuddy 接口说明，不是原始 ComfyUI HTTP 参数。

## 模式与素材

| 目标 | 工具／inspect.mode | generate 的素材 |
| --- | --- | --- |
| 文生图 | generate_image / text_to_image | 不传 reference_images |
| 图片编辑 | generate_image / image_to_image | 1–2 张 reference_images；检查时传相同数组 |
| 文生视频 | generate_video / text_to_video | 不传 image_path、reference_images |
| 首帧动画 | generate_video / image_to_video | 一个 image_path，不混用 reference_images |
| 身份／物体参考视频 | generate_video / reference_to_video | 1–2 张 reference_images，不混用 image_path |

图片生成的实际模式由 reference_images 决定；视频生成必须指定 mode。R2V 的图片用于身份／物体参考，不是首尾帧插值。当前视频接口没有 last_frame、音频参考或视频参考参数；即便底层模型支持，也不要发明字段。素材要求：工作区内普通 PNG 文件，每张不超过 20 MiB、像素数不超过 16,777,216；宿主还检查实际文件路径，不能用软链接指向工作区外文件。

## 可执行的参数形状

[requests.json](requests.json) 含五种模式各一例。每次只取用户需要的例子：先 inspect，将 `$workflow_id` 换为兼容条目的 `id`；把 `$image_1`／`$image_2` 换为已检查的工作区图片路径。例子的 prompt 是示范，必须依用户素材重写；不要把占位符提交。省略 request_id 由宿主分配 UUID，接下来保存真实 job_id，status/cancel 使用同一工具。

图像身份、编辑区域、必须保留和允许变化的内容写清楚；没有 mask 参数，不保证像素级局部编辑。透明背景请求需检查最终 alpha，不把纯色背景或画出来的棋盘格当透明。

## 参数选择

- 专用字段：prompt、width、height、seed；视频另有 duration_seconds。未指定尺寸就两项都省略，指定时同时给宽高，避免遗漏项默认为 1024。图片每边 256–2048、32 的倍数；视频每边 256–1344、32 的倍数且总像素 ≤ 1344×768。当前尺寸绑定还依赖唯一 ResolutionSelector 和受支持的比例，不能仅凭范围判定可用。
- 例如 1024×576 和 576×1024 满足数值与 16:9／9:16 比例限制；是否可写仍看选中图。官方模板默认的 1344×768 不应机械地作为显式覆盖发回：它与严格 16:9 比例不同。要保留原生默认就省略尺寸；返回值才是实际尺寸。
- 时长以秒传递，可含小数；不自行转成 length/fps，保留保存图的对齐公式。图没有唯一秒数入口时报告绑定缺口，不私改公式或将 30 秒静默降为 5 秒。
- 固定 seed 用于比较版本；省略会随机生成。一次比较尽量只改一个有效参数，记录 workflow.id／sha256、请求参数、seed 和产物路径。只在用户授权的试样／迭代范围内运行。
- 读取 `tunable_parameters` 中每个控件的 `parameter`、`current`、全部 `constraints` 和全部 `bindings`。constraints 是同时成立的条件；数字、布尔和枚举必须保留类型。最多 32 项，每个 ID 一次。省略控件表示保留；不要把一份工作流的 ID 用到另一份。
- 调步数先找 `bindings.input=steps`，然后确认 `branch`。`role=branch_switch` 对应布尔开关；设 true 后改 on_true 一侧，设 false 后改 on_false 一侧。一个控件可能控制多个绑定，先看所有下游。不能从界面位置、名称或固定节点号推断哪个是 Turbo。
- 调 Turbo 时保留模型分支、LoRA 与采样配置的一致性。强度、CFG、denoise、sampler、scheduler、ref_image_size 仅用 live 允许值。增大 CFG／步数不等于质量保证；不要将普通 SD 的负面词／CFG 经验套到无该分支的 H3 图。
- 示例结构是 `workflow_parameters:[{"parameter":"从当前 inspect 取得的 ID","value":true}]`。这里只示范结构，value 应与该控件语义匹配；不额外传 steps、turbo_mode 等未声明的顶层字段。

## 把失败分到正确层

| 证据 | 下一步 |
| --- | --- |
| inspect 连不上、权限拒绝 | 报告连接／权限问题，使用应用现有配置入口；不扫描地址、改凭据、安装客户端。 |
| missing 节点／模型，或 blockers 图转换错误 | 指出具体工作流和缺项。存在 blocker 时不猜图；安装、下载、改模型不属于普通生成。 |
| 参数 ID、枚举、尺寸比例／秒数绑定错误 | 重新检查选中图，修正尚未提交的参数；若明确要求超出能力，说明缺口，不替换目标。 |
| 已提交但 unavailable／submission_unknown | 对原 ID 最多一次恢复查询；仍不明就报告，不能用重复 generate 试探。 |
| failed 且 GPU OOM | 报告实际错误，提出减少像素／时长或其他有依据的方案；未经用户同意不缩短明确要求的成片，不自动重启或全局卸载模型。 |
| 空间不足、下载出错、completed 无可用产物 | 保留回执与旧文件，处理存储／获取问题；不伪报完成，不以生成新任务修复交付。 |
| cancel 未确认 | 如实说明未确认；没有单任务接口时用户到 ComfyUI 操作，不发全局 interrupt。 |
| job 不存在／跨会话被拒 | 回原会话取其 job_id，不扫描其他任务或改写回执。 |

## 条件创建

仅当前 inspect 明确 `creation_allowed=true` 时考虑 fallback。按需用 node_types（最多 24 个）取得 schema，node_offset/next_node_offset 分页；不把所有节点原文灌进提示词。构造的是 API graph，不能直接把 UI 的 nodes/links 当 API 图提交。

fallback_workflow 遵守工具合同：实际已安装 class_type、模型枚举和连接；用 `$prompt`，在 LoadImage.image 用 `$reference:0`／`$reference:1`；显式输入的宽高、seed、秒数分别用 `$width`、`$height`、`$seed`、`$duration_seconds` 绑定。仅一个最终 PNG／MP4 保存节点。宿主提交时再次检查资格与图结构。不要把 workflow_parameters 与 fallback 混用，也不要安装节点、下载模型或重启服务来扩大生成范围。

依据：当前 `runtime/comfyui-{tool,video-tool,saved-workflows,fallback,workflows}.mjs`；[ComfyUI 路由](https://docs.comfy.org/development/comfyui-server/comms_routes) 仅解释底层协议，模型仍调用宿主工具。
