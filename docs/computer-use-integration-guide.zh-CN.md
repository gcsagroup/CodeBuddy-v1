# CodeBuddy Computer Use 使用与接入指南

本文保留 2026-11-16 的上游使用说明与初始接入设计，研究基线为 Windows 工作区 `main@13e7b962a` 加当时已有的未提交修改。第 1～3 节是上游独立使用方法，第 4～6 节是最初实施方案，不应再当作当前尚未开发的清单。

**当前执行范围（2026-11-18）：** 按用户后续决定，Windows 使用平时的主模型判断，`CUA-S1-Qwen3.5-4B` 通过已配置 API 只做图像观察，能够从控件读取的内容优先直读。浏览器使用当前观察绑定的动作候选，原生输入继续由现有 MCP 执行；没有另建一套桌面执行器。下文 B 批的“让 CUA 选择动作”已经被这一决定替代，Mac/FluidUse 延期，本地权重内置与安装包暂不交付。实现、测试、真实桌面结果和仍有的性能限制分别记录在当批验收报告中；历史测试不自动证明当前版本通过。

**本批验收结果：** [简体中文](computer-use-acceptance-2026-11-18.zh-CN.md) · [繁體中文](computer-use-acceptance-2026-11-18.zh-TW.md) · [English](computer-use-acceptance-2026-11-18.en.md)。同一 Windows 候选版的 17 个验收轮次通过各自合同，包含首次执行的公开表单、原生应用与故障注入。复杂原生任务仍偏慢，前台恢复需要明确人工交接；不能将该结果解读为任意任务无错误或全部无人值守。

## 从哪里开始

| 你想先看到什么 | 先做哪一步 | 所需环境 | 能得到什么 |
| --- | --- | --- | --- |
| Windows 上看浏览器如何选对按钮 | 第 1.1 节 Jev 浏览器检查 | Git、uv、Python 3.12+、可连接的 Chrome | 在本地测试页验证节点移动、遮挡和状态失效，无需模型密钥 |
| 看模型怎么输出一个可执行选项 | 第 2.1 节 CUA 模拟选择，再做第 2.2 节真模型 | 模拟可用普通开发机，原精度真模型需要较多内存 | 同一份观察产生一个可校验的候选 ID，单独运行不会点击桌面 |
| Mac 上实际看到自动填表 | 第 3 节 FluidUse | Apple Silicon Mac、macOS 14+、Swift 6 工具链 | 在样例表单中先看计划，再观察字段被填入 |
| 改进 CodeBuddy 本身 | 第 4～6 节，第一批先做内置浏览器 | 当前 CodeBuddy 开发环境、现有会话模型 | 在同一套任务上与现有路径比较，再决定是否引入 4B 或 Mac 专用模型 |

本机通过 `nvidia-smi` 读到 GTX 1650 Ti、4096 MiB 显存，系统报告约 31.4 GiB 物理内存。CUA 上游记录其 16 位底模权重约 9.32 GB，并建议预留至少 16 GB 可用内存。这台机器适合先测浏览器和模拟选择；如测真模型，可在有足够空闲内存的 CPU 上做单次验证，或改用内存充足的推理机。总内存、空闲内存和显存要分别看。量化版与此处的官方权重、精度和时延需要分别验证。[CUA 硬件说明](https://github.com/trycua/cua/tree/main/libs/cua-s1#hardware)

下列安装命令均供读者在独立的实验目录执行。克隆、同步依赖或首次加载模型会联网，并占用磁盘。每次实验建议记录所在仓库的 `git rev-parse HEAD`；下文另列出了 CUA 两份权重各自的固定 revision。

## 1. Jev Ultrafast：在浏览器里观察、选动作、执行

Jev 把当前页面表示为一张带编号的控件表，记录角色、名称、值及各控件支持的动作。举例说，出发地输入框可以输入文字，列表里的城市选项可以点击，禁用按钮不该成为点击目标。原实验把操作和各类目标放在一次 TypeSafe 请求里预测，只采用与所选操作匹配的目标；需要生成输入内容时才调用文本模型。原仓库保留着可观察这个过程的演示，维护者已将 ultrafast 模式并入 Browser Use 主项目。复现实验优先使用原仓库和它的锁文件。[原项目](https://github.com/browser-use/jev-ultrafast) · [动作循环](https://github.com/browser-use/jev-ultrafast/blob/main/jev_ultrafast/agent.py) · [后续主项目](https://github.com/browser-use/browser-use)

### 1.1 Windows 上先做不调用模型的验证

在已有 Git、uv 和 Chrome 的机器上，从独立实验目录打开 PowerShell。依赖同步需要联网；同步完成后的单元测试与本地页面检查不调用计费模型。

```powershell
git clone https://github.com/browser-use/jev-ultrafast.git
Set-Location jev-ultrafast
git rev-parse HEAD
uv sync --frozen --python 3.12
uv run --frozen pytest
uv run --frozen browser-harness --doctor
uv run --frozen python scripts/check_guards.py
```

先看 `pytest` 是否通过，再看 doctor 能否找到并连接测试用 Chrome。若 Chrome 出现远程调试确认，按上游提示在测试浏览器中允许。最后一条会打开本地测试页面，覆盖移动控件、遮挡和页面失效等场景。检查结果能证明浏览器执行保护工作；要验证模型能否选对目标，还要做下一步。[环境依赖](https://github.com/browser-use/jev-ultrafast/blob/main/pyproject.toml) · [浏览器检查源码](https://github.com/browser-use/jev-ultrafast/blob/main/scripts/check_guards.py)

### 1.2 运行带模型的可视化演示

1. 在该仓库根目录执行下面的命令。用编辑器打开生成的 `.env`。填入 TypeSafe 的 `TYPESAFE_API_KEY` 和文本提供方的 `TEXT_MODEL_API_KEY`。默认示例的文本提供方是 OpenRouter，更换时需一并调整 `TEXT_MODEL_BASE_URL`、`TEXT_MODEL` 及提供方支持的推理选项。两个密钥对应不同职责。

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

2. 保存后运行 `uv run --frozen --env-file .env jev`，在浏览器打开 `http://127.0.0.1:8766`。先点 **Start demo**，用 **Choose next** 查看模型选择与概率，再用 **Run automatically** 观察完整任务。服务运行期间保留终端，结束时用 Ctrl+C 停止。
3. 检查每一步的页面编号、所选操作、对应元素和动作后的页面变化。演示界面里的编号覆盖层用于解释结果，默认选择循环读取结构化页面状态。原演示会把参与决策的页面状态发给配置的提供方，试用时选公开页面或测试数据。在线示例会产生 API 调用。
4. 想换任务，可运行下面的一次性命令。验收看最终打开的文章标题和正文，记录完整任务耗时。上游展示的航班演示时间只对应它的示例、网络及服务配置。[官方用法](https://github.com/browser-use/jev-ultrafast#try-the-original-demo) · [环境变量样例](https://github.com/browser-use/jev-ultrafast/blob/main/.env.example)

   ```powershell
   uv run --frozen --env-file .env python examples/run.py --url "https://en.wikipedia.org/wiki/Main_Page" --goal "Find and open the Wikipedia article about Gödel's incompleteness theorems."
   ```

**接入价值。** CodeBuddy 可直接借用动态候选、动作与目标相容、执行前检查页面是否变化这三个设计。希望使用托管 Jev 时，还要处理页面数据出站、服务凭据和调用成本。第一阶段用现有会话模型选择相同的候选，就能单独测出改进动作表示本身带来的收益。原仓库代码采用 MIT 许可。[许可证](https://github.com/browser-use/jev-ultrafast/blob/main/LICENSE)

## 2. CUA-S1-4B-0.2：让模型从当前候选里选一步

Hugging Face 提供的是两套基于 `Qwen/Qwen3.5-4B` 的 LoRA 适配器。文本版使用目标、界面描述和候选，多模态版还需要与候选属于同一观察的截图。运行完整示例需要三样东西：上游 `trycua/cua` 中的选择程序、Qwen 底模、CUA 适配器目录。单独下载 LoRA 或把仓库名填进聊天模型设置，无法完成这条推理链。[适配器模型卡](https://huggingface.co/cua-ai/cua-s1-4b-0.2) · [Qwen 底模](https://huggingface.co/Qwen/Qwen3.5-4B) · [推理说明](https://github.com/trycua/cua/tree/main/libs/cua-s1)

### 2.1 先验证输入输出，不下载模型

从另一个独立实验目录打开 PowerShell。以下使用上游自带的正向样例；模拟选择器会挑第一个普通动作，适合验证输入输出格式。

```powershell
git clone https://github.com/trycua/cua.git
Set-Location cua
git rev-parse HEAD
Push-Location libs/cua-driver/examples/jev-use
uv run --frozen verify_decision_cli.py --model mock
Pop-Location
```

看输出中的 `model`、`kind`、`selected_id`。该样例的预期是 `mock`、`selected`、`submit-form`。这里的 “submit” 是测试数据中的候选名字，验证器只比较返回值。想看原始输入，可打开 `libs/cua-driver/examples/jev-use/fixtures/jev-choice-request-v1.json`。其中 `goal` 是目标，`capture_id` 标识观察，`regions` 描述屏幕区域，`candidates` 列出可选动作，`history` 携带此前操作。候选中包括 `reobserve` 和 `abstain`。[输入样例](https://github.com/trycua/cua/blob/main/libs/cua-driver/examples/jev-use/fixtures/jev-choice-request-v1.json) · [模拟选择器说明](https://github.com/trycua/cua/blob/main/libs/cua-driver/examples/jev-use/decision-models.md)

### 2.2 准备真实推理环境和权重

下面采用上游文档的 Bash 环境布局，可在具备相应资源的 Linux 主机或 Apple Silicon Mac 上操作；从上一步的 **cua 仓库根目录**开始。Python 选 3.12。Windows 原生环境的虚拟环境可执行文件在 `.venv\Scripts\` 下，环境变量用 PowerShell 的 `$env:变量名` 设置。上游没有给出 Windows CUDA 实测数据，因此建议先在推理机验证，再决定 Windows 的分发方式。

```bash
uv sync --frozen --project libs/cua-s1/python --python 3.12 --extra four-b --extra pdf --group test
S1_PY="$PWD/libs/cua-s1/python/.venv/bin/python"
S1_HF="$PWD/libs/cua-s1/python/.venv/bin/hf"
S1_MODELS="$HOME/cua-s1-models"
S1_VERIFY="$PWD/libs/cua-driver/examples/jev-use/verify_decision_cli.py"
S1_FIXTURES="$PWD/libs/cua-driver/examples/jev-use/fixtures"
mkdir -p "$S1_MODELS"

"$S1_HF" download Qwen/Qwen3.5-4B \
  --revision 851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a \
  --local-dir "$S1_MODELS/Qwen3.5-4B"
"$S1_HF" download cua-ai/cua-s1-4b-0.2 \
  --revision 16818868b0cc7813808aae4e87b417657046ab79 \
  --local-dir "$S1_MODELS/cua-s1-4b-0.2"

export S1_BASE_MODEL_PATH="$S1_MODELS/Qwen3.5-4B"
export S1_ADAPTER_PATH="$S1_MODELS/cua-s1-4b-0.2"
export S1_DEVICE=cpu
export S1_DTYPE=bfloat16
export S1_MODALITY=text
```

如果只想估算下载量，可先在两条 `hf download` 后分别加 `--dry-run`。适配器路径指向同时包含 `text/` 和 `multimodal/` 的根目录，选择器按模式选子目录。CPU 的 `bfloat16` 取自上游 CPU 说明，实际支持和耗时取决于处理器与 PyTorch。在 Apple Silicon 上测 GPU 时，把设备和精度改为 `export S1_DEVICE=mps S1_DTYPE=float16`；显存充足且 PyTorch 能识别 CUDA 的推理机才选择 `cuda` 及相应精度。[锁定版本、设备与精度说明](https://github.com/trycua/cua/tree/main/libs/cua-s1#hardware)

### 2.3 比较正例、拒选和截图模式

保持上一步同一个 Bash 终端，在 cua 根目录运行：

```bash
# 文本正例
"$S1_PY" "$S1_VERIFY" --model s1
# 文本反例
"$S1_PY" "$S1_VERIFY" --model s1 --fixture negative --expected-id abstain
# 截图正例：验证器会把图片与样例的 capture_id 绑定
"$S1_PY" "$S1_VERIFY" --model s1 --screenshot "$S1_FIXTURES/jev-choice-request-v1.png"
# 直接查看完整的文本决策 JSON
"$S1_PY" libs/cua-driver/examples/jev-use/python/choose_decision.py --model s1 \
  < "$S1_FIXTURES/jev-choice-request-v1.json"
```

| 返回值 | 调用方应如何处理 |
| --- | --- |
| `selected` | 检查 `capture_id` 与当前观察相同、`selected_id` 属于该次候选，再交回宿主校验。此时鼠标尚未动作。 |
| `reobserve` | 重新取当前目标的观察，生成新候选。释放旧候选与旧截图的绑定。 |
| `abstain` | 本次不派发。由 Harness 使用已有信息继续判断；只有确实缺少用户选择时再询问。 |
| `error`、无响应或非法返回 | 记录具体原因。模型不可用时可走原有路径，任何结果未知的已派发动作都先核对现场。 |

正例的预期 ID 是 `submit-form`，反例预期为 `abstain`；验证器还检查返回的观察 ID 和候选集合。当前官方 chooser 单次最多 **26 个候选**，包含两个保留项时，普通动作最多 24 个。大型表单要先按当前子任务选取相关区域；正确目标不在区域内时扩大观察或交回主模型。简单截取前 24 项会把候选召回失败误判成模型选错。[选择器合同](https://github.com/trycua/cua/blob/main/libs/cua-driver/examples/jev-use/decision-models.md) · [验证器](https://github.com/trycua/cua/blob/main/libs/cua-driver/examples/jev-use/verify_decision_cli.py)

**如何判断是否值得接入。** 上游六类 GUI 模拟环境共有 18 个留出回合，文本版完成 17 个，多模态版完成 13 个；部分环境未纳入。优先把文本版与现有会话模型放在相同的中文页面上比较。多模态测试需提供真正有意义的编号区域和匹配截图；没有候选的画布局部仍需要已有视觉路径或单独解决目标定位。生产原型应复用常驻模型进程，将模型加载、热推理和整个任务三种耗时分别计量。CUA 源码采用 MIT，适配器与 Qwen 底模各自标注 Apache-2.0，分发时分别保留相应声明。[评测范围](https://github.com/trycua/cua/tree/main/libs/cua-bench-s1#agentic-rl) · [部署与权重](https://github.com/trycua/cua/tree/main/libs/cua-s1)

## 3. FluidUse：在 Apple Silicon Mac 上本地填表

FluidUse 通过 macOS Accessibility API 读取原生应用控件，也能直接读取嵌入的 WKWebView。它的 `CUA-S1-FORMS` 是约 70.6 万参数的小模型。你提供字段和值，例如“公司 → 海风测试”“工作邮箱 → qa@example.test”，模型给每个控件的填入、勾选、点击、跳过等选项打分。上游也支持 laya 等其他决策模型；跑通填表只需 FORMS。Swift 包声明 macOS 14+，仓库使用 Swift 6 工具链，Core ML 端侧推理面向 Apple Silicon。[项目说明](https://github.com/FluidInference/FluidUse) · [Swift 包声明](https://github.com/FluidInference/FluidUse/blob/main/Package.swift) · [表单模型](https://huggingface.co/FluidInference/cua-s1-forms-coreml)

### 3.1 用上游自带样例操作一遍

在 Mac 的终端、独立实验目录执行：

```bash
uname -m
sw_vers -productVersion
swift --version
git clone https://github.com/FluidInference/FluidUse.git
cd FluidUse
git rev-parse HEAD
swift run -c release FluidUseDemo
```

1. 确认架构为 `arm64`，版本符合要求。首次构建会解析 Swift 包，点击 **Load model** 后等待模型可用。开发机需能获取依赖与模型资源。
2. 点 **Sample profile** 载入示例资料，选择 **Embedded web page**，点 **Sample form** 打开仓库自带页面。先用这个页面验证资料解析与模型决策，两者正常后再试外部应用。
3. 保持 **Allow submit click** 关闭。点 **Plan only**，检查各控件的标签、拟填入的资料、候选排序以及跳过项。特别留意工作邮箱和私人邮箱、姓名和公司之间是否混淆。
4. 确认样例无误后点 **Fill form**，回读页面字段，核对值、勾选状态和仍为空的字段。界面能查看决策和耗时；模型推理耗时、窗口读取和逐项输入耗时分别记录。
5. 想测真正的原生窗口，选 **Sample PDF in Preview**，使用 Demo 打开的样例副本。选对应的 Preview 窗口，点 **Observe window**，核对标题和字段，再重复计划与填写。macOS 如要求辅助功能权限，按系统提示为实际启动 Demo 的终端或应用授权。内嵌网页成功与外部窗口输入成功分别记录。[界面控件](https://github.com/FluidInference/FluidUse/blob/main/Sources/FluidUseDemo/ContentView.swift) · [样例与执行逻辑](https://github.com/FluidInference/FluidUse/blob/main/Sources/FluidUseDemo/DemoModel.swift)

### 3.2 对接自有表单时怎样准备资料

用 **Open document…** 导入按“标签: 值”分行的文本资料，或使用上游支持的 PDF。例如先把下面三行保存为 UTF-8 文本，用虚构数据分别测试英文和中文控件。观察导入后出现的实体列表，确认没有错拆或漏项。模型的输入是这些已提取的值；开放式备注需要使用用户指定的原文或单独提供答案。

```text
Name: Lin Chen
Company: 海风测试
Email: qa@example.test
```

工程侧可复用这条调用顺序：`CuaS1FormsManager.load()` 加载模型，`FormSchema.renderOptions(entities:)` 把资料变成选项，`FormSchema.renderContext(formTitle:element:)` 描述当前字段，`score(context:options:)` 评分，`FormSchema.decode(optionIndex:entityCount:)` 还原动作与资料索引。接入 CodeBuddy 时仅消费匹配结果，写入仍交给已有原生工具。已有非空值时应先判断此任务是否要求覆盖。上游指出 FORMS 对训练标签以外的字段可能高置信度选择跳过，因此验收要对照用户要求逐项查漏。[字段编码与解码](https://github.com/FluidInference/FluidUse/blob/main/Sources/FluidUse/FormSchema.swift) · [模型适用范围](https://github.com/trycua/cua/tree/main/libs/cua-s1)

Swift 项目代码采用 Apache-2.0，CUA-S1-FORMS 模型采用 MIT。对先支持 Windows 的版本，可直接复用“从用户资料匹配字段”的设计；Mac 的 Swift 包与 Accessibility 驱动在 Mac 实机上单独评估。[项目与模型许可](https://github.com/FluidInference/FluidUse#license)

## 4. CodeBuddy 接入设计

### 4.1 哪些能力已经存在

| 当前组件 | 已有行为 | 本方案需要增加的部分 |
| --- | --- | --- |
| 内置浏览器 `browser_control` | Electron 用 CDP 读取辅助功能树。观察含节点编号、角色、名称、值及部分控件状态，一次最多返回 400 个节点并标记截断。点击已有节点限制与遮挡检查，输入后回执标记已派发、待验证。 | 从观察构造当前子目标可用的动作清单。决策返回时校验页面、目标语义和最新控件状态。优先做这一端。[浏览器执行源码](../ui/desktop/src/workspace-panel/browserControl.ts) |
| 原生桌面 `qwen_computer` | 内部快照有精确窗口、输入版本、控件索引、角色、矩形和动作。MCP 结果通常对外提供树文本及可用截图；有图时结构化观察另含窗口摘要。 | 需要结构化候选时，在快照持有者内部生成，或评审后添加可选的结构化数据。现有客户端仍能读取老结果，缺少新字段时走原流程。[原生快照](../tools/qwen-computer-use/main.go) · [元素索引](../tools/qwen-computer-use/snapshot_indices.go) |
| Harness、桌面控制和工具回执 | 技能按需加载；宿主处理工具授权和桌面控制权，MCP 桥保留真实回执。Esc、输入冲突、前台窗口变化均已有处理路径。 | 选择器只返回建议，实际工具调用仍受原有权限和接管逻辑约束。桌面失去控制权时丢弃迟到的选择结果。浏览器面板沿用自己的会话和页面生命周期。[技能入口](../runtime/harness/computer-skill.mjs) · [MCP 回执](../runtime/harness/mcp-bridge.mjs) · [桌面控制合同](../tools/qwen-computer-use/README.zh-CN.md) |

### 4.2 一次真实操作如何走完

用同一条任务作为开发和验收输入：**“在测试客户表单里把公司填为海风测试，工作邮箱填为 qa@example.test，保留原备注，停在提交前。”** 建议先在隔离测试页上准备公司、工作邮箱、账单邮箱、已有备注、提交按钮五个控件。

| 步骤 | 谁负责 | 在这个例子里做什么 |
| --- | --- | --- |
| 理解任务 | 当前会话模型和 Harness | 确认要写公司与工作邮箱，引用用户提供的两个值，保留备注。提交动作不属于当前任务。 |
| 观察 | 浏览器控制器或原生工具 | 取当前标签页或精确窗口的最新状态，记录工作邮箱与账单邮箱各自的节点和所属表单。 |
| 构造候选 | 观察与执行所在的组件 | 把可执行的“向此控件填公司名”“向此控件填邮箱”等动作绑定到本次观察。文本值引用宿主持有的原值；提供重新观察和弃权选项。 |
| 选择下一步 | 当前会话模型，或配置的 CUA；Mac 表单也可用 FORMS 提供字段匹配 | 返回当前观察中的一个候选。若同名邮箱无法区分，保留歧义，无依据时选择重新观察或弃权。 |
| 校验与派发 | 原控制器和 Harness | 校验权限、观察是否过期、控件身份及状态。原生桌面额外核对当前窗口和控制权。只派发选中的一步。 |
| 动作后核对 | 原工具及 Harness | 回读写入的字段。页面重绘就基于新观察继续。两个目标字段值正确、备注仍为原文且未提交，才报告完成。 |

举例说明运行时的数据关系：在观察 A 中，宿主可以把临时候选 `fill-work-email` 映射到“当前 CRM 标签页、节点 23、输入工作邮箱、取用户资料中的 email”。模型仅返回观察 A 和候选 ID。若等待模型期间节点 23 的标签变成“账单邮箱”，旧映射应失效，即使节点编号没有变。新候选基于新观察构造。这个 ID 是设计示例，当前 CodeBuddy 没有提供这个配置项或工具。

### 4.3 三者如何组合，以及如何退出

- **网页结构清晰时**，使用 Jev 的方式构造可执行候选。第一版让会话模型选择；启用 CUA 对照时，由 CUA 单独选择同一批候选。比较两条路径时应记录各自收到的输入，避免一个模型看到正确字段而另一个看不到。
- **Mac 用户提供了一组表单资料时**，让 FORMS 针对字段匹配一个已有值，只把建议转成现有原生工具能执行的操作。原生控件索引、窗口绑定和输入权限仍由 CodeBuddy 持有。若不支持某个字段，回到当前会话模型处理该字段。
- **页面只有画布、控件树不完整时**，先确定同一张截图上能否产生可信目标区域。CUA 多模态可以在已有区域中选择；范围、坐标系或目标不明时，退回现有视觉流程重新观察。截图内容只进入用户已配置并获准的推理路径。
- **模型超时或进程退出时**，区分“尚未派发”和“已派发但结果未知”。前者可重新观察后切回原模型，后者先回读现场。接管、取消、服务恢复后均不能重放可能已生效的写入。关闭实验选择器后，新任务从原有路径开始；首版无需迁移会话历史。

## 5. 分批实施与验收记录

| 批次 | 实施范围 | 怎样验收 | 决定下一步所需的证据 |
| --- | --- | --- | --- |
| A．内置浏览器 | 同一会话模型，比较现有路径与动态候选。先做填表、搜索筛选、动态下拉。 | 跑浏览器控制组件测试，再在实际 Electron 工作区浏览器打开相同夹具。校验最终值、选项、原备注和提交次数。 | 成功率和误操作没有退化；按任务记录主模型调用次数、端到端时延。明确收益主要来自哪类任务。 |
| B．CUA 文本与多模态 | 用 A 留出的观察和人工标注先做离线比较，再对表现合适的任务做实时实验。推理与桌面输入分进程。 | 选错、弃权、正确候选缺失分别计数。冷启动单记，热推理单记，再看真实用户等待时间。 | 确认目标硬件能承受峰值内存与尾延迟。稳定胜过 A 的任务类别才进入默认路径评估。 |
| C．Windows 原生与 Mac 填表 | 准备原生结构化候选的最小变更；Mac 另测 FORMS 的中英文匹配。涉及公开合同变更时先确认迁移边界。 | Windows 和 Mac 分别用真实窗口跑完整任务。覆盖焦点切换、人工输入、Esc、弹窗关闭和同名字段。 | 实机结果分别归档。错窗口输入、覆盖无关草稿、停止后继续输入、未知提交后重发，任一出现都要先定位。 |

**建议的最小测试集**

| 场景 | 刻意设置的难点 | 可观察的通过条件 |
| --- | --- | --- |
| 中文 CRM 草稿 | 工作邮箱与账单邮箱并存，备注已有内容 | 公司与工作邮箱精确匹配，账单邮箱和备注保持原值，提交计数为 0 |
| 异步搜索 | 输入后出现延迟建议，页面重绘，旧编号仍可能存在 | 选中当前正确建议，结果页回显相同对象 |
| 动态下拉或遮挡 | 选项禁用，或点击前出现遮罩 | 没有点击被挡控件，重新观察后只执行可用动作 |
| 无有效候选 | 正确字段在折叠区，或初始候选超出 26 项 | 观察扩大或明确弃权，记录正确候选最初是否缺失 |
| 原生窗口接管 | 推理进行时切换到其他窗口或按 Esc | 迟到响应不导致新输入，无关窗口内容未改变 |
| 写入后连接中断 | 工具可能已输入，回执未完整到达 | 恢复后先核对字段或提交记录；无重复写入、无重复提交 |

建议每次留一行结果：应用及构建 revision、任务编号、模型及权重 revision、模式、成功/失败、正确候选是否出现、误派发数、模型调用数、冷启动、单次推理与整任务耗时、最终页面或窗口证据。统计延迟时附样本量；少量试跑先列各次结果。截图和详细日志仅用测试数据。现有相关回归入口包括[浏览器控制测试](../ui/desktop/src/workspace-panel/browserControl.test.ts)、[真实 Electron 测试](../ui/desktop/tests/e2e/workspace-browser.electron.spec.ts)和[桌面控制测试](../runtime/tests/desktop-control.test.mjs)。开发版按仓库 README 的 Windows 入口 `.\start-preview.ps1` 启动，核对当前构建来源后再做产品验收。[Windows 启动说明](../README.md)

## 6. 常见卡点

| 现象 | 先检查什么 | 处理方式 |
| --- | --- | --- |
| Jev 单元测试通过，演示没有打开页面 | Chrome 连接与远程调试授权 | 先跑 doctor，再跑本地页面检查。两者正常后才排查 API key。 |
| Jev 会点击，在输入文字时出现鉴权错误 | 文本提供方的 key、端点、模型名是否配套 | 单独核对 `TEXT_MODEL_*`。不要在反馈日志中打印密钥。 |
| CUA 提示目录不存在或找不到适配器 | 底模目录和适配器根目录是否分开，目标模式子目录是否有配置与权重 | 使用上游固定 revision 下载，核对本地路径。选择器只读本地权重。 |
| CUA 报 `option_limit`，或始终选不到目标 | 当次候选数、保留选项、正确控件是否进入候选 | 缩小到有依据的表单区域，记录遗漏并重新观察。提高置信度阈值无法找回遗漏目标。 |
| 多模态响应与画面不符 | 截图的观察 ID、窗口身份、缩放和区域框 | 用同次观察生成截图与区域。先在固定图片样例上验证，再调实时采集。 |
| FluidUse 样例网页成功，外部窗口无字段 | 当前目标窗口、辅助功能授权、目标应用实际暴露的控件 | 先用 Preview 样例定位权限和 AX 链路，再复测目标应用。 |
| 动作回执成功，业务结果没变 | 回执是派发还是已核验，页面是否异步更新 | 回读目标字段、选中项或业务记录，根据证据决定下一步。 |

**首版交付建议：** 在当前 Windows 开发机先完成批次 A，同时跑通 CUA 的模拟选择合同。得到真实的中文页面观察和对照结果后，再投入 4B 推理部署。Mac 有可用实机时，可独立运行 FluidUse 样例并测试字段匹配，两条工作不互相阻塞。
