# 小熊猫自然动作样板

> 2026-11-10 用户反馈：否决分部位生成、拼接的视觉方案。本文件记录的是已否决样板，不能作为后续整角色连续动画的视觉或性能证据；不进入正式桌宠。

2026-11-10；源码：`D:\CodeBuddy-v1`，`main`，`b7865d54aa19d3023e495bc7982b84ac68f686b2` 加本次未提交样板。没有新建分支、安装依赖、提交或推送，也没有替换正式桌宠。

样板位于 `ui/desktop/src/pets/prototype/`。使用 Canvas2D 分层骨骼变换，尚未使用 Spine SDK 或网格蒙皮。包含待机、鼠标观察、挥手、跳跃；动作可以打断并以短过渡衔接。头、躯干、手脚、尾巴分开绘制，脚掌在待机时保持地面位置。眨眼目前切换开眼／闭眼头图，尚无独立眼球和连续眼睑，因此观察不等于完整的三维转头。

## 查看和复现

从 `ui/desktop` 执行：

```powershell
node scripts/preview-panda-rig.cjs
node scripts/preview-panda-rig.cjs --export
```

第一条输出仅本机可访问的预览地址。第二条导出 `.local/panda-rig-review/panda-preview.html`，可双击离线打开，不需要服务、图像 API 或网络。该目录还包含 `panda-motion-preview.mp4`（实际浏览器录屏的前 15 秒）、截图和性能 JSON。源录屏为 25 fps，不能拿录像帧率代替渲染器帧率。

## 实测

Windows Edge Chromium，视口 1100×870，DPR 2；不录屏／截图的连续 40 秒测试。每秒采样帧率和绘制耗时；下表绘制耗时为各采样窗口 P95 的最大值。

| 条件 | 时长 | 平均 fps | 绘制耗时 | 帧间隔 P95 最大值 |
| --- | --- | --- | --- | --- |
| 320px 预览 | 15 秒 | 56.25 | 0.30 ms | 18.6 ms |
| 160px 实际大小 | 10 秒 | 56.38 | 0.30 ms | 18.6 ms |
| 160px，CPU 降速 4 倍 | 15 秒 | 56.30 | 1.60 ms | 18.6 ms |

上述阶段未记录到超过 50 ms 的帧；另一次含录屏／截图的交互测试出现少量长帧，保留在 `performance.json`。JS 堆快照从约 2.39 MB 到 1.96 MB；这不包含全部纹理、GPU 和浏览器内存，也不能证明长期无泄漏。CPU 降速是浏览器模拟，不是独立低端硬件。尚未做完整 Electron、跨平台、系统负载或多小时验收。

保护措施：图像仅加载和裁切缓存一次；动画循环不扫描 alpha、不更新 React；DPR 上限 2；按时间而非帧数推进；隐藏时取消动画调度并在恢复时重置时钟；减少动画时停止绘制；销毁时取消 RAF、移除监听器；性能采样最多保留 180 条。

## 验证命令与交付边界

以下最终检查退出码均为 0：

```powershell
corepack pnpm run test:run src/pets/prototype
corepack pnpm exec playwright test tests/e2e/panda-rig.browser.spec.ts --reporter=list
corepack pnpm run typecheck
corepack pnpm exec eslint src/pets/prototype/*.ts --max-warnings 0
corepack pnpm exec prettier --check src/pets/prototype/*.ts src/pets/prototype/preview.html scripts/preview-panda-rig.cjs
```

单元测试 7 项；浏览器场景 2 项分别运行通过（第二项使用 `-g 'without recording'` 单独执行）。覆盖动作阶段、跨刷新率的观察跟随、动作打断、减少动画、隐藏／恢复、销毁、实际画布像素、跳跃顶部不裁切，以及正常／降速条件下的帧预算。离线导出也已在浏览器成功加载。Node 22.23.2 与仓库声明的 Node 24 有版本警告；本轮未改变环境。

这是供用户判断画风和动作的独立样板，产品视觉验收仍由用户完成。尚未迁移正式素材协议、设置页或桌宠窗口；后续集成需要保留现有精灵图兼容路径，重新验证透明窗口、点击穿透及实际桌面资源占用。

## 素材和参考

素材 `assets/red-panda-parts.png` 为 imagegen 内置工具基于现有原创小熊猫参考图生成，862839 字节；未复制第三方角色。完整生成提示见同目录 `assets/provenance.json`。

参考 [Spine 骨骼权重](https://en.esotericsoftware.com/spine-weights)、[Live2D 参数过渡](https://docs.live2d.com/en/cubism-editor-manual/about-fade/)、[MDN Canvas 优化](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)和 [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)。没有复制其代码或引入商业运行库。
