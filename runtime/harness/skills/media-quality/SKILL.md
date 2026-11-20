# 图片、视频与宠物质检

检查动画卡顿、透明边距、角色被裁切、提示框遮挡和帧尺寸时，先获取实际文件及显示尺寸。
使用 inspect_media，参数 path、columns、rows 为文件路径、横向格数、纵向格数。只读取用户授权文件。单张图片默认 1 1，精灵表必须先确认布局。输出透明像素包围盒、各帧延时、裁切风险及跨帧稳定包围盒。

将 stableBounds 按真实显示比例换算，提示框底边可放在稳定轮廓 top 上方用户指定的距离。空白帧、无透明通道、触边帧须核对。包围盒包含全部可见内容，无法自动区分耳朵和伞。动作切换使用固定包围盒。播放流畅程度及角色一致性仍需实际预览。

格内坐标应映射到播放器实际显示帧的原点；精灵表里的裁切偏移不是屏幕位置，不要随帧索引把提示框横向移动。仅凭图片可确认空白帧等素材事实，不能确认界面抖动的代码根因。工具已给出所需测量且没有矛盾时直接使用回执；仅在测量缺口或证据冲突时另写扫描脚本。

视频先使用已安装的 ffprobe，通过参数数组执行 -v error -show_streams -show_format -of json FILE，检查尺寸、帧率、时长。需要定位卡顿时再读取对应片段的帧时间戳。缺少 ffprobe 时明确说明依赖缺失。禁止以元数据正常声称视觉自然。

繁體：依實際顯示比例換算跨幀穩定輪廓，再預覽動作。以顯示影格原點定位，不把素材裁切偏移當成螢幕位置；素材本身不能證明程式根因。
English: Inspect frame metadata and stable alpha bounds, scale from the displayed frame origin, then verify playback visually. Sprite-sheet source offsets are not screen positions. Image facts alone do not establish rendering root causes. Reuse sufficient tool measurements; write another scanner only for missing or conflicting evidence.
