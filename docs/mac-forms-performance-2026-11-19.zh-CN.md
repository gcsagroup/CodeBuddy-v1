# Mac FORMS 中文接入与 PDF 性能复验（2026-11-19）

[繁體中文](mac-forms-performance-2026-11-19.zh-TW.md) · [English](mac-forms-performance-2026-11-19.en.md)

后续状态：窗口定位、接管和断线问题已在[六项交付验收](mac-computer-use-six-acceptance-2026-11-19.zh-CN.md)中修复并复测。本页保留当时的候选与失败记录，不作为最新完成状态。

状态：中文字段映射、PDF 原生只读落盘回执和紧凑识图已实现。相同指令、相同初始字段值的 PDF 整轮由 69.216 秒降至 25.965 秒，填写与保留值均正确。一次泛称窗口定位失败单独保留；本批结果不代表 Mac 全功能或原六项全部重新验收通过。

## 后续获批的 PDF 回执与最终候选

用户随后批准了只读落盘核对，现已接入，而非停在方案或提示词调整。原生层读取已匹配窗口 AXDocument 指定的 PDF，分开返回界面与磁盘字段，核对文件身份及读取稳定性。Go 透传回执，主模型比较目标与保留字段。详见[读取边界](mac-pdf-disk-observation.zh-CN.md)。

最终候选 PID `26736`，启动于 `2026-11-19T02:05:52.141Z`，source/current hash 为 `d4fb5daa8fa4ca024beaae6406d397569bcab305127fb8f68cedc7da1f977811`。原生 SHA-256 为 `1e7be4114091ce6e852bbb6c5f7fcf12cb3fce5e0c0c9c895836ba889571a881`。新增 `macos/PDFDiskObservation.swift`、`macos/Tests/PDFDiskObservationTests.swift` 并更新 `Package.swift`；没有新下载依赖。

| 最终候选场景 | 秒（Harness 轮次） | 未缓存输入 / 缓存读取 / 输出 token | 结果 |
|---|---:|---:|---|
| 双字段改回对照初值 | 22.172 | 35,380 / 67,328 / 1,288 | UI 与磁盘正确，1 次保存，无识图/shell |
| CodeBuddy 可见对话，完全相同 PDF 指令 | 25.965 | 26,739 / 75,776 / 1,535 | 2/2，另两栏保留，1 次保存，无识图/shell |
| 英文提示词，只改工作邮箱 | 23.618 | 40,302 / 82,432 / 1,534 | 单字段正确，另三栏保留，1 次保存，无识图/shell |
| 明确要求截图抄录四栏 | 23.736 | 17,125 / 28,288 / 521 | 四栏完整正确，无输入；其中 CUA 11.167 秒、51 输出 token |
| 中文网页表单 | 23.665 | 47,106 / 133,888 / 2,053 | FORMS 推荐及填写 2/2，旧值保留，提交 0 |
| 英文网页表单 | 22.148 | 31,150 / 89,728 / 1,039 | 填写 2/2，旧值保留，提交 0 |
| 泛称当前表单，两个同名邮箱 | 47.527 | 33,235 / 112,640 / 3,783 | 只改公司；两邮箱和备注保留，提交 0；不计为 FORMS 匹配成功 |
| PDF 只读核对 | 10.990 | 15,786 / 29,184 / 428 | 无输入工具，文件哈希不变 |
| 精确目标窗口不存在 | 13.655 | 16,081 / 26,112 / 865 | 无输入工具，文件哈希不变 |

最终 15 个相关源文件均与 Windows 当前工作区哈希一致，运行进程 source/current hash 相同且无需重启。`python -X utf8 .local/mac-deep-20261119/verify-v2.py` 退出码 0，断言覆盖三组最终网页的每条事件、三轮 PDF 保存回执、独立磁盘读回、前后对照初值、只读哈希及四栏识图。网页最终可见界面另经 RustDesk 检查。

最终歧义会话 `9bad3e49-959f-45b4-b155-f3d34167438d` 使用泛称指令成功定位，但 FORMS 投影已过期，被原生校验拒绝；主模型只填明确的公司，并明确告知两格邮箱未填。因此这是安全降级通过，不能算 FORMS 推理通过，也不能据一次定位成功宣称早先定位缺陷已经修复。

可见对话会话为 `df366ee7-18fe-45c8-8f7f-fea12d4d23a8`；前后字段与上一个 69.216 秒会话相同，主模型与思考强度不变。耗时减少约 62.5%，未缓存输入减少约 54.2%，输出减少约 46.8%。这是单次配对结果，模型工具选择、缓存和服务延迟仍会波动，不把所有收益归因于一个因素。后一次 8 个工具调用，前一次 12 个；避免了用识图核对可直接读取的字段，再用 shell 查落盘。

原生磁盘读取在上述三轮中约 0.75–2.02 ms。8/8 Swift/CoreML 测试通过，包括真实 PDF 未保存值与磁盘值分离、保存后刷新、中文多行、重复名称、无效路径、损坏与超限；Go test/vet、Swift 合同及 release 构建退出码 0。最后使用现有预览入口重新启动，并验收该候选。

独立同图 CUA 对照：紧凑输出前 18.087 秒、132 输出 token；之后 9.164 / 9.129 秒、各 34 token，三次可见字段一致。仅限制冗余翻译、开头和总结，不缩短字段原文、不下调图像分辨率。观察器无工具和无执行权的边界保留。Windows/Mac 相关识图回归各 20/20，更新后的技能回归 4/4，退出码 0。

## 第一阶段构建来源（供前后对照，不是最终运行进程）

- Windows：`D:\CodeBuddy-v1`，`main@4c8afad978b6e893a3545c0859dd5b4824a91223`，含既有及本批未提交改动；未创建分支、提交或推送。
- Mac：`/Users/erjinyi/Desktop/work/CodeBuddy-v1`。Mac Git HEAD 为 `732113504de3601ab087a609ce20827b814db2c2`，不能据此声称两端整个仓库版本相同。本批 12 个运行相关源文件按规范化换行后的 SHA-256 核对，与 Windows 当前文件一致。
- 已运行候选：PID `25584`，启动 `2026-11-19T01:44:12.753Z`；运行时 source/current hash 均为 `1647bf8c7bdc8e2b31520ff76a47400ae1b249c003156e22492d518990609cb3`，restartRequired=false。
- 原生运行器 SHA-256：`7ce7aa44a148df67f4c6eb66b973d6584abbabce37823bfee0892758cdcc7fc1`。这是源码预览验收，不是新 DMG 发布。
- 主模型固定 Ollama `deepseek-v4.1-flash`、高思考强度；识图为配置中的 `CUA-S1-Qwen3.5-4B`，FORMS 在本地 CoreML 执行。

## 根因与代码变化

116 个真实模型消融场景确认：中文标签、中文资料键、中文标题都可能导致 skip；英文 `Work email` 也可能跳过，`Email` 可正常匹配；已有内容还会独立影响评分。不是所有 skip 都是语言错误。上游明确说明模型依赖有限训练概念词汇：[模型说明](https://github.com/trycua/cua/blob/main/libs/cua-s1/MODEL_CARD.md)、[概念定义](https://github.com/trycua/cua/blob/main/libs/cua-s1/python/src/cua_s1/concepts.py)。

1. `form_labels` 是用户批准的可选参数：主模型提供评分用英文字段、资料标签和标题；Go 绑定真实观察；Swift 在评分前复核原窗口、控件、附近标签、位置及旧值。旧调用兼容。未映射字段不评分，原始中文值不改写、不清空。详见[协议](mac-form-label-projection.zh-CN.md)。
2. 识图连接使用自定义 ID 时，原实现漏掉禁用 thinking。现在按已配置的同一分发端点和模型识别，仅对只读截图观察器关闭 thinking；不改变主模型。
3. 原生观察补充精确 AXDocument URL、确认过的前台窗口回执，省略 AX 树重复空属性；保留所有索引、非空证据和空白可编辑值。不把焦点当作落盘证明。

主要文件：`runtime/providers.mjs`、`runtime/vision-routing.mjs`、`runtime/harness/skills/computer-use/SKILL.md`、`tools/qwen-computer-use/{main.go,form_matching.go}`、`macos/{runtime.swift,RuntimeContract.swift,FormMatching.swift}`；相应 Go、Swift、Harness 回归及所有权说明同步更新。

## 第一阶段真实验收（后续 PDF 候选见上表）

耗时为 Harness turn start/end；输入分开统计未缓存与缓存读取，不能将合计当作计费金额。ACP 场景调用同一运行中 Mac CodeBuddy，不是直接调用原生工具伪装对话。

| 场景 | 入口 | 秒 | 未缓存输入 / 缓存读取 / 输出 token | 结果 |
|---|---|---:|---:|---|
| 中文公司、工作邮箱；保留账单、备注 | CodeBuddy 可见对话 | 60.802 | 45,160 / 187,136 / 2,600 | 2/2，FORMS 真实推荐 2/2，提交 0 |
| 英文提示词、英文标签 | CodeBuddy ACP | 22.894 | 43,758 / 74,880 / 956 | 2/2，旧值保留，提交 0；原始 Work email 评分 skip，主模型明确选择填写 |
| 同名邮箱，完整窗口标题 | CodeBuddy ACP | 24.162 | 35,951 / 60,416 / 2,048 | 公司正确；两邮箱及备注原样保留，说明歧义，提交 0 |
| PDF 双字段修改、保存原件 | CodeBuddy 可见对话 | 69.216 | 58,387 / 128,384 / 2,885 | 磁盘 2/2；另两栏保留；保存快捷键仅 1 次 |
| PDF 只读检查 | CodeBuddy ACP | 11.354 | 21,416 / 22,912 / 483 | 无输入工具；文件哈希不变 |
| 精确目标窗口不存在 | CodeBuddy ACP | 10.794 | 8,408 / 33,408 / 551 | 无输入工具；文件哈希不变 |

中文推荐中 Company→海风测试、Email→qa@example.test，概率分别约 0.999447、0.999953，每字段评分 1.94–3.53 ms。网页每一条 input/change 事件均检查了账单、备注与提交计数，并非只核对最后一帧。PDF 用 PDFKit 从磁盘独立读回；保存前后的实际字段及只读文件哈希已留存。

失败单列：`b9341ef2-8b54-4a4d-a375-c6d578ac1356`（17.453 秒），主模型把“当前客户表”中的“客户表”误作完整窗口标题，范围锁定后无法定位；无写入。这是未解决的窗口语义定位问题，不是 FORMS 推理失败。明确标题后的场景不能证明这句话已经修复。

## 性能结论与剩余工作

- 同一张截图对照：修复前 18.636 秒；修复后 19.607、16.710 秒。首个文字由 9.155 秒降至约 6.12 秒，thinking 输出从有变无；总耗时仍波动，不能宣称稳定的整体提速。
- 第一阶段 PDF 轮次保存按键回执 0.385 秒，后续识图 27.465 秒，并额外调用 shell 核对磁盘，整轮 69.216 秒。此前单字段轮次 31.529 秒，但任务、初值和截图不同，不作为严格 A/B 提速百分比。
- 上述性能不足随后通过用户批准的原生只读 PDF 回执处理，最终实现与对照结果见本页顶部。使用系统 [Apple widgetStringValue](https://developer.apple.com/documentation/pdfkit/pdfannotation/widgetstringvalue)，不依赖不可靠的 AXEdited 判断。
- FORMS 对已有值仍可合理 skip；主模型负责明确修改语义。不能保证任意中文表单、任意应用全部成功。
- 本批未重测所有接管/断线场景、Windows 完整产品 E2E 或发布安装包；不把本批局部结果扩展为六项全量验收完成。

## 自动检查与证据

以下最终有效运行退出码均为 0：

- Node 24 `--test runtime/tests/vision-routing.test.mjs runtime/tests/vision-routing-harness.test.mjs`：Windows、Mac 各 20/20。
- Node 24 provider 相关目标 46/46；`runtime/harness/test/computer-skill.test.mjs` 4/4。
- Mac `go test ./...`、`go vet ./...`（`tools/qwen-computer-use`）。
- 现有构建入口包装 `.local/mac-deep-20261119/build.cjs` 调用 `buildMacComputer(root,'arm64',{test:true})`：Go/Swift 合同检查、Swift/CoreML/PDF 8/8、release 原生构建通过。日志 `pdf-native-tests.log`。
- `python -X utf8 .local/mac-deep-20261119/verify-v2.py`：最终源码一致、中文评分、网页事件、PDF 落盘、只读哈希全部符合断言。第一阶段使用 `verify.py`；默认 Windows Python 编码读取中文 JSON 曾失败，显式 UTF-8 后通过，不是产品失败。
- `git diff --check`：通过（仅既有换行转换警告）。

本地证据：`.local/mac-deep-20261119/` 下 `final-identity.json`、`final-sessions.json`、`sessions/`、`web-events.jsonl`、`pdf-disk-ui-{before,after}.json`、`pdf-disk-en-after.json`、`disk-readonly-*.sha`、`verified-v2.json`、消融结果及测试日志。第一阶段 `forms-identity.json`、`final-pdf-{before,after}.json`、`verified.json` 同样保留。记录不含将失败场景改记成功的汇总。
