# Harness 辅助视觉适配记录

日期：2026-10-14。源码为 `D:\CodeBuddy-v1` 当前文件，该目录无 Git revision；本批未提交、推送或改动界面源码。

## 行为与所有权

原设置界面的 `visionRoute` 现在参与真实请求。`runtime/vision-routing.mjs` 仅适配用户消息中的图片，不解析任务意图，不裁决任务完成，不拥有第二套 Agent 循环。

| 路由 | 实际行为 |
| --- | --- |
| 无图片 | 原内容数组直接交给主模型，不调用辅助模型 |
| auto | 主模型图片能力明确 supported 时原图直达主模型；否则使用已配置且能力明确 supported 的辅助模型 |
| always | 启用辅助视觉时，每次含图输入都经过辅助模型，即使主模型支持图片 |
| disabled 或未启用 | 仅使用主模型；图片能力 unknown/unsupported 时返回明确错误 |

模型能力来自当前能力解析器及用户保存的能力覆盖；没有按模型名称猜测支持情况。保存启用配置时要求明确的 provider/model 且连接已配置；执行时检查辅助模型图片能力，避免设置保存顺序相互阻塞。

辅助调用仍由官方 Harness 执行，使用独立会话、空工具列表、`toolFilter.allow=[]`、无 MCP、单次模型步骤、1024 输出 token 和关闭自动压缩。所有工具审批返回拒绝，模型即使提出工具调用也不产生成功描述。只有正常结束且有非空文本时才返回观察。

原用户图片保留在产品消息、原界面适配器和导出历史中。主模型接收的替换内容包含明确的不可信数据警示以及 JSON 包装的观察；这些内容不是工具事实、权限或开发验收证据。后续对话恢复使用 Harness 的观察文本历史，不自动重新解释或重放图像副作用。

## 边界与生命周期

- 每次辅助输入最多 8 张图、每张 8 MiB、总计 32 MiB；引用的用户文字最多 32000 字符；观察文本最多 16000 字符。实际图像格式和像素由官方附件 admission 再校验。
- 独立 90 秒超时；取消、超时、服务关闭均传递 AbortSignal 并等待官方驱动实际停止。部分输出、空响应、模型错误及工具尝试均不转为描述成功。执行期间辅助 provider 受到配置变更保护。
- 独立会话不加入产品会话列表；Harness 的会话日志与标准附件存储仍保留在当前 profile。当前驱动没有单会话物理清理 API，此处不承诺零留存。
- 原 Rust `vision_service.rs` 还包含截图定位、坐标、截图代次绑定、状态验证、缓存、缩图和重试。本模块不迁入这些电脑控制能力；它只实现用户图片解释，电脑控制需要其独立适配与验收。

## 自动验证与实际产品边界

命令：`node --test runtime/tests/vision-routing.test.mjs runtime/tests/vision-routing-harness.test.mjs runtime/tests/vision-routing-acp.test.mjs`。本批 11 项通过，退出码 0：7 项路由/状态单测、3 项真实 Harness 和本地 HTTP 模型协议测试、1 项真实 ACP 整链测试。

覆盖无图/主模型直达/always、不可信包装、配置与能力门禁、图像 admission、无工具 schema、工具尝试拒绝、空输出、错误、取消、超时、HTTP 流结束、provider 保护、原 renderer 图片消费以及重启导出/后续对话。夹具为临时 profile 和本地受控模型服务。真实 Electron 上传交互、外部视觉模型质量及 macOS 尚未由这组结果验收。

## 参考

使用已安装的 DeepSeek Harness `0.2.1-alpha.2`，沿用 MIT 许可的官方附件与会话执行方案；无新增依赖、无 vendored 修改。[官方附件架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md)解释图片 admission、归一化和持久化职责。[官方附件包](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/attachment/README.md)提供接口背景。具体行为以本地锁定版本和测试回执为准。
