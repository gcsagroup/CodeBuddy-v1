# Windows Computer Use 最终实施与验收记录

2026-11-17。对应[原接入方案](computer-use-integration-guide.zh-CN.md)，按用户后续决定收敛为 Windows：日常主模型做判断，CUA 只识图；Mac、CUA 动作决策和安装包不在本批范围。约定矩阵的 **22 个真实产品执行轮次全部达到各自完成条件**，其中异常场景以安全停止或正确恢复为通过条件，不把中止填写算成填写成功。

繁體：[驗收記錄](computer-use-acceptance-2026-11-17.zh-TW.md)；English: [acceptance record](computer-use-acceptance-2026-11-17.en.md)。

## 构建来源

- `D:/CodeBuddy-v1`，交付核对的 HEAD 为 `main@4c8afad97` 加未提交修改。此前记录的 `a071a6ba4` 是历史控制器基线；其后已有 19:09 的设置 UI 提交，早于最终启动，不包含本批 runtime/native/browser controller 变更。本轮没有创建分支、提交、推送或制作安装包，保留其他 dirty work。验收身份以以下实际加载的哈希为准。
- 使用 `./start-preview.ps1`，最终启动时间 2026-11-17 20:00:59（北京时间），运行时 PID 36356，Electron 主进程 PID 30680。主进程于 20:01:31.057 启动，晚于 bundle 写入时间 20:01:31.010；已用展开候选实际出现确认加载新代码。最终矩阵全部在这次重启后执行。
- Runtime SHA256：`24b4546fcec0272119a858e98d3e5347b45d1ad978ef801ee54c1a20022ad81b`。
- 原生工具 SHA256：`496acac575f93c69c804e3e4cbd7b220ccf799aa1b485fd25f527b3239bbd107`。
- 浏览器控制器源码 SHA256：`a5d2454ec1d343bc947604659ec66e6e5ae96ef63d5b66576e5065b555061c79`；Electron bundle SHA256：`5fe2a65e00521cf0ebb7a2a83148c32750313c9702ffe3a2b62861a20454bb4c`。
- 主模型 `deepseek-v4.1-flash:1017`，极致思考保持不变；实际 CUA 观察会话均无动作工具。模型服务权重 revision、远端硬件及峰值内存未核实，显示名不是权重校验。

## 实现和修复

1. Windows 默认读取控件和字段；计算器等按钮应用也走控件路径。只有主模型明确请求完整视觉观察时才调用 CUA。原始回执保留。
2. 字段 token 绑定观察和窗口；旧式 WinForms EDIT 支持受保护的整框替换，派发检查焦点、遮挡、字段原值和人工接管。公司与工作邮箱分别核对，保留账单邮箱及备注。
3. 相同图片按轮次、窗口、进程、模型和内容复用识图；取消与目标变化会使结果失效。缓存不能纠正错误识图。
4. 浏览器候选每页 24 项，绑定 observationId，输入引用 textValues 原值；支持分页、重新观察和弃权。补齐 `DisclosureTriangle` 展开按钮。
5. 候选动作在准备前和实际派发前两次核对语义与控件状态，修复“获得焦点时字段改名”的竞态。派发尝试前消费候选，未知结果不能直接重放。
6. 小 JSON 写入批量化、统计局部更新、局部创建会话；工具可见性读取复用 Harness 注册表，避免注册通知深拷贝全部 schema。权限仍按最新作用域判定。

本轮直接修改 `runtime/browser-tool.mjs`、`ui/desktop/src/workspace-panel/browserControl.ts` 及其单元/Electron 测试，新增 `examples/computer-use/candidate-boundaries.html`。前期已实现的相关改动还包括 `runtime/{settings,store,compat,vision-routing}.mjs`、Harness 工具发现/技能/图像桥接，以及 `tools/qwen-computer-use/{main.go,runtime.ps1,desktop-input.cs}`。本报告更新三种语言版本；本地夹具与证据默认不提交。

## 自动验证

以下结果与主模型产品验收分开统计。命令使用已有 Node 24、Go 和仓库依赖，没有新增安装。

| 命令或目标 | 结果 |
| --- | --- |
| `node --test runtime/tests/browser-tool.test.mjs` | 4 项通过，退出 0，28.367 秒 |
| `vitest run src/workspace-panel/browserControl.test.ts` | 9 项通过，退出 0，2.11 秒 |
| `playwright test tests/e2e/workspace-browser.electron.spec.ts` | 真实 Electron 集成 1 项通过，退出 0，13.4 秒；包含字段改名、折叠、分页、遮挡、只读和禁用边界 |
| `tsc --noEmit` | 退出 0；之后的一行展开角色补充亦由 Electron 测试编译并通过 |
| `go test ./...`（tools/qwen-computer-use） | 最终原生工具对应测试通过，退出 0，32.888 秒；`go vet ./...` 与构建退出 0 |
| 已完成且源码未再改变的相关回归 | settings/store 27、history 15、vision 16、MCP vision 9、computer skill 3、工具作用域 6、agent profile 4 项通过 |

日志位于 `.local/computer-use-next/` 与 `ui/desktop/.local/`。未运行安装包验收，也没有用其他 checkout 代替当前源码。

## 原生应用耗时与正确性

每轮由实际 CodeBuddy 新会话执行原指令，隔离夹具从空白开始；记事本不改正文、不执行替换、不保存；计算器从 0 和空历史计算 37×24。比较值是执行开始至本轮结束的秒数。

| 任务 | 优化前秒 | 最终秒/均值 | 减少 | 最终检查 |
| --- | --- | --- | --- | --- |
| CRM | 92.133 | 31.696 | 65.6% | 15/15 (3 runs) |
| Notepad | 65.706 | 31.606 | 51.9% | 4/4 |
| Calculator | 162.433 | 46.964 | 71.1% | 2/2 |

CRM 三轮明细：

| 轮次 | 执行秒 | 接收至完成秒 | 主模型请求 | 主模型秒 | CUA 次数 | CUA 秒 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 28.409 | 35.988 | 8 | 18.968 | 0 | 0.000 |
| 2 | 40.444 | 48.202 | 8 | 21.921 | 1 | 5.810 |
| 3 | 26.234 | 34.410 | 7 | 17.852 | 0 | 0.000 |

CRM 平均执行 31.696 秒，含准备等待 39.533 秒。耗时分解均值：主模型 19.580 秒、CUA 1.937 秒、其余工具 9.402 秒、其他 0.777 秒。第二轮主模型在写对后主动请求 full，产生额外识图，完整保留这个慢样本。

优化前是同指令单样本，最终 CRM 为三样本，其余原生任务为单样本；不同时间段的网络、模型及系统波动无法消除，不能宣称稳定 SLA。检查通过率指预先约定的目标值、保留值和未提交条件，不是通用识图准确率。

## 浏览器新旧对照

先比较同一最终开发版中的旧 `node/text` 兼容方式 O 与 `observationId/candidateId/textValues` 方式 N。顺序 O1、N1、N2、O2、O3、N3；每轮新会话、同一个含 450 条历史记录的空白表单。实际动作参数与独立控件回读均核对。

| 方式 | 执行秒 | 接收至完成秒 | 主模型请求 | 主模型秒 | 工具次数 | 检查 |
| --- | --- | --- | --- | --- | --- | --- |
| N1 | 35.231 | 47.270 | 9 | 27.630 | 8 | 5/5 |
| N2 | 37.881 | 46.723 | 9 | 33.171 | 7 | 5/5 |
| N3 | 30.080 | 39.688 | 9 | 25.798 | 7 | 5/5 |
| O1 | 35.645 | 43.977 | 7 | 30.369 | 6 | 5/5 |
| O2 | 26.681 | 35.896 | 10 | 21.551 | 8 | 5/5 |
| O3 | 29.168 | 40.205 | 8 | 22.888 | 7 | 5/5 |

O 平均 30.498 秒；N 平均 34.397 秒。含准备等待分别 40.026、44.560 秒。这里不能把“旧调用方式”描述成“旧版本整机”；两者都运行在最终版。

异步搜索均输入“海风”，只选择“海风测试”，页面回显核对一致：

| 方式 | 执行秒 | 检查 |
| --- | --- | --- |
| O | 23.147 | 3/3 |
| N | 46.804 | 3/3 |

搜索 N 额外调用一次截图识别，CUA 实际耗时 20.460 秒，主模型 17.312 秒。观察回执已包含状态名“已选客户”和“海风测试”，但节点被展平，缺少状态区域与文本的父子关系；可能促使模型再做视觉复核，这是基于回执的推断。保留控制树的必要语义关系是下一步可测的优化方向，本批尚未实施，未计为已取得的收益。

另做真正历史控制器对照：从 `a071a6ba4` 读取旧源码，与当前控制器在隔离真实 Electron 中运行短表单/450 项表单，各 3 轮，共 12 轮全部正确。两种字段改名竞态，旧控制器均误写，当前候选路径均拒绝且值保持为空。此机制测试不调用主模型，不能作为用户任务端到端耗时；原始结果见 [控制器对照](../.local/computer-use-next/browser-baseline/results.json)。**旧 node 兼容调用仍不具备候选语义绑定，不能把候选路径的安全收益推广到全部旧调用。**

## 同版异常实测

| 场景 | 实际结果 |
| --- | --- |
| 切换焦点 | 首次观察结束 53ms 后、下一次输入前切到计算器；4 次输入尝试均拒绝，没有派发，CRM 与计算器保持不变。安全停止通过，填写未完成。模型重复尝试的时间计入。 |
| Esc | 公司已写入，邮箱写入等待期间按 Esc；邮箱动作返回 DESKTOP_STOPPED，该轮无后续桌面调用，邮箱仍空，保留字段不变。 |
| Esc 后继续 | 新轮次先列窗口、重新观察，只填写剩余邮箱，未重写公司；5 项字段条件及恢复顺序核对通过，14.407 秒。 |
| 根窗口关闭 | 在 Raise 后状态回读期间关闭隔离 CRM；之后精确窗口查找返回不存在，主模型停止，没有尝试写入其他窗口。 |
| 写入后连接中断 | 公司已经实际写入、回执未返回时终止该会话自己的 MCP 进程；收到 Connection closed 后重新观察，只写邮箱，没有重复写公司，最终 5 项通过。 |
| 替换面板关闭 | 识别/回读期间关闭记事本替换面板；迟到观察未导致输入，不重开面板，正文及文件哈希不变。模型 3 次 full 观察产生额外延迟，95.752 秒，属于安全停止测试。 |
| 候选分页与折叠 | 初页没有正确展开候选，翻页找到并展开；填写正确，禁用、只读、遮挡字段和无关按钮计数均不变。8 项检查及 5 项独立回读通过。 |

每项均有真实主模型工具回执、注入时间与独立状态。异常停止不是业务成功，以上没有把“模型声称完成”直接当验收事实。

## 公开网站实际测试

- [Selenium 官方 Web form](https://www.selenium.dev/selenium/web/web-form.html)：文本框、textarea、原生下拉 Two、默认复选框；保留已选复选框、只读和禁用字段，不提交、不填密码、不上传。41.776 秒，9 项检查通过，CUA 0 次。
- [Playwright TodoMVC 测试页](https://demo.playwright.dev/todomvc/)：空列表添加两条测试事项，仅完成 A，核对 Active/Completed/All 三种视图，不删除。63.293 秒，7 项检查通过，CUA 0 次。

网页是独立测试页面，实际结果由嵌入式浏览器工具和可见页面交叉核对；没有用 DOM 注入制造通过。

## 还能优化什么

当前明显瓶颈是主模型多轮请求、额外 full 观察和发生接管后重复尝试。普通表单无需识图，但主模型偶尔仍会主动复核。下一步应针对不必要观察的原因和结果呈现做对照，保留模型判断权与宿主安全检查；不能通过删掉焦点/语义校验或隐藏失败样本来追求快。候选机制本轮的明确收益是边界正确性，速度按上面的实测数值解释。

CUA 曾有一次早期把记事本读成文件管理器，错误亦进入缓存；该记录保留。另三张固定截图读对不代表通用可靠性。真实模型权重、服务冷启动与远端峰值内存未测，属于部署能力边界；原方案的 CUA 动作决策实验已被用户“主模型判断、CUA 只识图”取代。

19:27 启动的旧 Electron 进程未加载 19:28 的新 bundle，发现后明确作废其统一复测资格。中间结果和错误校准日志保留在 `.local/computer-use-next/intermediate-1927/` 等位置。最终统计只使用 20:01 重启后的会话，不择优替换慢轮次；测试脚本路径/断言修正不冒充产品缺陷。

## 证据与复核

- [统一验收检查](../.local/computer-use-next/final-acceptance-gate.json)：核对 22 个轮次的构建时间、主模型、完成回执、状态检查和源码哈希。
- [数据图](../.local/computer-use-next/Windows最终统一复测对比.png) · [逐轮 CSV](../.local/computer-use-next/Windows最终逐轮数据.csv) · [耗时分解](../.local/computer-use-next/final-product-timings.json)。
- [启动来源](../.local/computer-use-next/launch-unified.json) · [实际加载的主进程](../.local/computer-use-next/loaded-main-identity.json)。
- [表单第 1 轮](../.local/computer-use-next/unified1-metrics.json) · [第 2 轮](../.local/computer-use-next/unified2-metrics.json) · [第 3 轮](../.local/computer-use-next/unified3-metrics.json)。
- [记事本回读](../.local/computer-use-next/notepad-unified.json) · [计算器回读](../.local/computer-use-next/calculator-unified.json) · [浏览器对照](../.local/computer-use-next/browser-main-comparison.json) · [搜索对照](../.local/computer-use-next/search-final-comparison.json)。
- 异常证据：`.local/computer-use-next/final-{focus,escape,resume,close,disconnect,pane}-verification.json`；公开页面证据：`public-S1-verification.json`、`public-T1-verification.json`；原始会话：`unified-<session>-<turn>.json`。

| session / turn | 执行秒 | 主模型请求 | CUA 次数 | 工具次数 |
| --- | --- | --- | --- | --- |
| 784242d9-7749-4468-9b0f-1c2d29600adb / 1 | 84.702 | 13 | 1 | 13 |
| ebc58103-f500-4e61-b778-d9aab2f568dc / 1 | 37.649 | 9 | 1 | 7 |
| ebc58103-f500-4e61-b778-d9aab2f568dc / 2 | 14.407 | 4 | 0 | 3 |
| 131b145d-5af3-4560-b391-32e15e32c675 / 1 | 42.009 | 8 | 2 | 6 |
| 29a7b3d9-8edb-45a4-aad2-6809a36fddfd / 1 | 66.016 | 12 | 2 | 10 |
| c1dc7027-66f2-49e5-8133-930f2dd703f8 / 1 | 95.752 | 8 | 3 | 6 |
| 1f28fe04-f0f0-4538-a602-ac817604663d / 1 | 35.748 | 0 | 0 | 9 |
| 8eb4fb5f-7ebe-425b-a810-ad1a15bfe9f5 / 1 | 41.776 | 8 | 0 | 11 |
| 9d237d3b-3b4f-42ad-8290-2c2c596d7e5b / 1 | 63.293 | 20 | 0 | 18 |
| 35f30ef0-dbd6-4a7d-84de-beb1755ec46d / 1 | 28.409 | 8 | 0 | 6 |
| 5c397166-432b-4d02-8072-bba552524fbe / 1 | 40.444 | 8 | 1 | 7 |
| 5f10003a-bfe2-43ac-8a94-3a4a1cf09a00 / 1 | 26.234 | 7 | 0 | 6 |
| b2c3b7a7-0def-4997-874d-86bb921426e0 / 1 | 31.606 | 8 | 0 | 6 |
| bd5cdd1f-7790-4c13-bbe9-a653e7f67793 / 1 | 46.964 | 12 | 0 | 10 |
| 19af5992-cbfd-4f3b-8af5-a553ca04ba4a / 1 | 35.231 | 9 | 0 | 8 |
| e9b7de3a-33e4-40d8-9e8b-f684035be41a / 1 | 37.881 | 9 | 0 | 7 |
| 7e0e0f2b-98ac-422e-98a8-0262657b0fcd / 1 | 30.080 | 9 | 0 | 7 |
| e9ab3135-1b00-4908-a355-78a1b795af62 / 1 | 35.645 | 7 | 0 | 6 |
| debc2ac0-8ed1-495e-b017-5ba21818bd42 / 1 | 26.681 | 10 | 0 | 8 |
| cfae921b-6b33-4876-92af-afa19c081713 / 1 | 29.168 | 8 | 0 | 7 |
| 3c4a8190-dad5-478c-85e3-4d86b82d0377 / 1 | 23.147 | 9 | 0 | 7 |
| b852a055-c392-405d-8f49-ee8e5f9421d8 / 1 | 46.804 | 9 | 1 | 8 |

开发版可继续从仓库根目录运行 `./start-preview.ps1`。本批 Windows 约定验收完成；Mac、安装包和任意软件的普适成功率未在此作承诺。
