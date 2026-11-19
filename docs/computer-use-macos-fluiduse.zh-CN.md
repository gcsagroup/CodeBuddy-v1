# Mac 本地表单匹配

[繁體中文](computer-use-macos-fluiduse.zh-TW.md) · [English](computer-use-macos-fluiduse.en.md)

后续同日性能批次更新了 Mac 原生写值焦点检查和开发产物；下方原验收记录保留为历史结果。当前产物身份、25 回合多提示词结果及未达成的性能目标见 [Mac 性能验收](mac-performance-2026-11-18.zh-CN.md)。

Mac 的 `get_app_state` 可接收 `form_entities`，内容为用户提供的 `label` 与 `value` 数组。Swift helper 从当前窗口的 Accessibility 控件取字段，使用 FluidUse 的 FormSchema 和 FluidAudio 的 CUA-S1-FORMS 在本机评分。原生工具返回字段索引、原值、推荐值、评分、截断情况及耗时。主模型决定是否执行，输入和回读沿用既有工具。每次观察独立匹配，旧观察的建议须与新状态重新核对。

FORMS 的建议不构成覆盖草稿或提交的授权。未知字段、同名字段和高分跳过均需主模型结合任务与控件解释。当前中文资料探测中，公司、工作邮箱等字段均得到跳过建议，尚无中文匹配准确率提升证据。FORMS 参与记录与最终字段正确率分别核对。

对于没有自身名称的 PDF 控件，评分层复用 FluidUse 的 `nearbyLabel`，从本次观察中的静态文字及几何位置提取候选标签。回执用 `matching_label` 和 `label_source=nearby_text_candidate` 标明来源，原始控件名称、索引及输入身份保持不变。主模型须核对周围文字，不能把候选标签当成系统提供的确定字段名称。

## 准备与构建

宿主统一转换控件树与 FORMS 建议的 `element_index`，确保它们引用同一观察中的同一个控件。建议无法绑定实际控件时降级为 `unavailable` 并清空建议，不保留可能指向别处的编号。

没有可编辑控件时返回 `status=no_fields`、`execution=not_run`，不加载模型、不宣称已评分。实际评分才返回 `scored`。模型缓存缺失等错误返回 `unavailable`，观察结果仍可供主模型判断。

Preview 的 Accessibility 标题可能包含页数，与截图接口标题不同。原生窗口映射先核对进程及几何，再用标题消除歧义；标题不同只接受唯一几何匹配，读取控件树时还核对反向映射。重叠窗口无法区分时拒绝输入，不按页数后缀或应用名做特判。标题是可本地化的展示文字，参考 [Apple kAXTitleAttribute](https://developer.apple.com/documentation/applicationservices/kaxtitleattribute)。

在已授权下载的 Mac 源码目录中准备锁定依赖。FluidUse 固定在 `b51f7adfbade197f0a9c802e34ba8a98cd4ecbc9`，FluidAudio 固定为 `0.15.8`，两者代码采用 Apache-2.0。更新依赖前评估兼容性并更新锁文件。

```bash
cd tools/qwen-computer-use/macos
swift package --disable-keychain resolve
cd ../../..
corepack pnpm --dir ui/desktop run test:macos-native
node scripts/prepare-harness-macos-tools.cjs --arch arm64
runtime/tools/bin/qwen-computer-runtime --prepare-forms
bash ./start-preview.sh
```

`--disable-keychain` 仅让 SwiftPM 获取公开依赖时跳过钥匙串凭据查询。正常开发和打包使用已解析依赖，禁止自动重新解析。`--prepare-forms` 是显式模型准备操作，需要下载授权。普通 `get_app_state` 不下载模型；本地模型缺失时返回 `formMatching.status=unavailable`，保留控件观察。模型采用上游 FluidAudio 用户缓存目录。

## 验收

Mac 默认 `view=fields`，使用原生控件索引和回读，不套用 Windows 的写入令牌。截图仍保留在原始回执；主模型需要视觉信息时显式请求 `view=full`，才进入既有 CUA 识图路径。动作后回到控件观察，避免对可直接读取的值重复识图。

从同批源码构建的 Mac CodeBuddy 对话发起，主模型使用已选定的 Ollama DeepSeek。对照时固定模型与思考强度，每轮恢复相同初始内容。

- 先验证实际应用子进程的窗口标题、字段原值和截图，SSH helper 的权限结果单独记录。
- 中文表单公司和工作邮箱 2/2 正确，账单邮箱和备注逐字保留，提交计数为 0。
- 两个均标为“邮箱”的字段无法区分时保留原值，并说明未填写项。
- 保存真实 FORMS 建议、主模型所选目标和输入后的实际回读。
- 用 Preview 可填写 PDF 验证原生应用链路，并检查切窗、接管、Esc 和断线后重新观察。

本文件描述实现与验收合同。最终产品通过状态以同批实机记录为准。

## 2026-11-18 实机验收记录

已将 Windows `D:\CodeBuddy-v1` 的 `main@4c8afad978b6e893a3545c0859dd5b4824a91223` 连同未提交源码同步到 Mac 既有工作区。2439 个文件按换行归一后的 SHA-256 一致；Mac 原有 Git HEAD 未切换，因此构建来源以文件清单为准，不能用 Mac HEAD 代替。未提交、未推送。验收使用 `start-preview.sh` 启动的开发运行版，未制作或替换安装包。

最终 Mac 产物 SHA-256：`qwen-computer-use=05679fcdf6dac2a887da375b1d6781dd56aa39cfc279d459cd75ab97ddb05316`，`qwen-computer-runtime=dcd8867a193f1ee49d2e28ffc71c1888fd52bcca8b95634d9a2961283b69ab4d`。主任务实调 Ollama `deepseek-v4.1-flash`，思考强度 `high`；标题生成是独立的 `off` 请求。需要整窗视觉观察时实调 `CUA-S1-Qwen3.5-4B` API。

| 场景 | 实际结果 |
| --- | --- |
| 英文旧路径 / 本地 FORMS 对照 | 相同初始值、主模型及思考强度；均填对 2/2、填错 0、漏填 0，原账单邮箱和备注保留，提交 0；整轮分别 33.024 秒 / 29.380 秒 |
| 本地推理参与 | 英文 Company 推荐 `Northwind Studio`，主模型采纳并回读一致；Work email 返回 `skip`，主模型按指令填写。6 份最终会话的评分回执中，建议编号均与各自控件树对应 |
| Preview 中文 PDF | 从 CodeBuddy 对话发起；公司、工作邮箱填对 2/2；账单邮箱与备注逐字保留；保存后用 PDFKit 读取磁盘文件核对四项 |
| Esc 与恢复 | 公司填完后 Esc 阻断后续点击；本轮不再派发电脑工具。新消息重新观察，只补填邮箱并保存，没有重写公司 |
| 断开与重连 | 定向结束本次测试的 native worker；宿主暂停后续动作、不自动重放；新消息重新取得控件状态后继续 |
| 人工切窗 | 待发送的邮箱输入被明确拒绝派发；返回新观察，重新聚焦后才输入，未写到另一应用 |
| 中文网页 | 松屿工坊与工作邮箱 2/2 正确；全程旧账单邮箱、备注保留，提交 0 |
| 两个同名邮箱 | 只填写青岚设备；两个邮箱及备注全程保留，明确报告工作邮箱未填，提交 0 |

自动验证：Mac Go `test ./...`、`vet ./...`、native contract、4 个真实 CoreML 测试、24 个 Mac 构建/打包测试、12 个 Harness 技能/视觉路由测试均通过。最后的证据核对脚本检查源码同步、实际表单事件、PDF 磁盘值、中断后的工具调用及控件编号一致性，16 项通过。日志、逐项回执和同步清单保存在本地 `.local/fluiduse-20261118/`，不纳入提交。

限制：中文字段在本批实际 FORMS 评分中仍全部建议跳过，中文填写正确来自主模型的语义判断，不能宣称 FORMS 提升了中文准确率。英文单组对照耗时不能推出稳定提速。上述通过范围限于这些真实夹具、当前 Mac 和当前构建；不代表任意应用或表单均能成功。

## 2026-11-18 补项与六项验收结论

此前记录没有覆盖上游 Plan 预览、未知字段、弹窗及完整写入后丢失回执，不能据此宣称六项全部完成。以下为补测后的结论。

| 约定项目 | 验收结果与证据 |
| --- | --- |
| 1. Mac 基线 | 通过。arm64、macOS 27.0.1、Swift 6.4.2；实际 CodeBuddy 子进程读取窗口、字段和当前值。锁定版本 FluidUse Demo 成功加载模型，Plan only 扫描 25 个元素、评分 24 个、产生 19 项计划；界面显示 planned，未执行填写或提交 |
| 2. 本地字段匹配 | 通过接入与行为验收。实际 CoreML 回执可对应真实控件；中文由主模型完成，同名邮箱保持原值。新增未知参考代码保持 `REF-KEEP-721`；不存在的“客户等级”明确报告未填，其他两项目标 2/2 正确 |
| 3. 对话到原生输入 | 通过。任务从 Mac CodeBuddy 界面发起，使用 Ollama DeepSeek/high；原生输入后回读，网页事件与可见结果一致，Preview PDF 的控件和磁盘值已核对 |
| 4. 草稿与中断 | 通过。保留原内容、人工切窗、Esc、弹窗均有实测；弹窗期间没有文字输入。公司完整写入后定向断开 native worker，报告结果未知并停止；新消息先重新观察，只补邮箱，不重写公司 |
| 5. 网页与原生应用 | 通过。上游锁定样例仅附加被动事件记录，在外部 Safari 中从 CodeBuddy 填对 First name、Last name、Email 3/3，其余 20 个字段/勾选保持初值，无提交；Preview 中文可填写 PDF 已从 CodeBuddy 跑通 |
| 6. 新旧对照与交付 | 通过约定测量。相同初值与主模型/high，旧路径 33.024 秒、本地匹配路径 29.380 秒；均 2/2、错 0、漏 0、提交 0。保留可运行 Mac 开发预览版、夹具生成器、指令和证据；未制作安装包 |

补测发现并修复了一个报告缺陷：执行器已收到输入但成功回执丢失时，主模型曾误报“未写入”。`runtime/desktop-coordinator.mjs` 的执行后暂停错误现在明确区分未知结果与操作前历史值；权限、暂停状态机、FORMS 和原生二进制不变。新增完整写入后丢回执的回归，`node --test runtime/tests/desktop-coordinator.test.mjs` 在 Windows/Mac 均 31/31，退出码 0。Mac 重启加载该修复后，真实对话第 6 轮正确报告结果未知，第 7 轮重新观察且只补邮箱，最终字段 2/2、原值保留、提交 0。

补项证据位于 `.local/fluiduse-20261118/supplement/`：`session-evidence.json`（198 条）、`events.jsonl`、`lost-receipt-fault.json`、`checks.json`（11 项通过）、`upstream-plan.log`、`model-invocations.json`、`build-identity.json`。第 4 轮部分写入故障和第 5 轮修复前误报均保留，排除于通过结论。最终运行时源码哈希为 `8372b5a78bf1a0140ff9f455113cdbf22defcc1f47f71aea3ed5e40fa11aa44e`，`restartRequired=false`；原生产物哈希与上文一致。未受此次报告修复影响的原生、匹配与正常流程证据复用；中断报告及恢复使用修复后的实测。

上游 Demo 的计划不等于全部建议正确：留言曾推荐网站地址，提交按钮曾推荐 click；Plan only 且未允许提交，因此没有执行。这个结果说明主模型核对仍然必要，不能将本次通过解释为 FORMS 能独立可靠地填任意表单。
