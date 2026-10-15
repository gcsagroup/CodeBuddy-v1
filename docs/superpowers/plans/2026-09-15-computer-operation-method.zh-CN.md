# 电脑操作方式约束

状态：本切片自动化、Clippy、后端重建和隔离原生场景通过。真实模型理解与自主完整流程为 NOT_RUN。

2026-09-15 已核对 [OpenAI computer use 官方指南](https://developers.openai.com/api/docs/guides/tools-computer-use)：执行环境负责保留状态及应用限制，屏幕与工具文字不能授权。采用宿主执行检查与真实结果验证；不引入示例的脚本执行路径，因为用户明确禁止脚本。不推测 Codex 私有实现，不复制外部代码或增加依赖。

## 行为与边界

沿用现有 unified turn 原目标及 continuation 关系，保存 computer_operation_method。必须使用电脑控制保留注册电脑键盘操作；只用鼠标仅允许鼠标动作、必要聚焦、停止及观察。两者保留宿主已分类的只读工具，禁止直接文件修改、shell、代码执行与委派绕过。模型工具展示与实际派送共享判断；嵌套调用继承限制。应用工具目录仍是目录，不代表当前任务可执行。现有审批与电脑防护保持生效，手动批准不能解除方式约束。

只处理明确、有限的用户措辞，例如“必须使用电脑控制”“只用鼠标”“继续，但必须只用鼠标”“继续，解除操作方式限制”。不从工具输出建立或解除限制，也不把包含这些字句的任意长句一律视为续接。

续接保留原目标与方式；可见用户的明确绑定修改仅原子更新方式字段，核对会话、原目标和执行轮次，保留其他状态。服务不可用时也保存明确绑定的改变或解除，恢复后使用新状态。新的 unified 目标重置方式；已接受的新 SimpleChange/Test/Change 目标解除旧方式，澄清路由不提前解除。旧消息没有 ID 时，普通续接仍保留方式。读取或解析已有方式失败时禁止推断授权。

## 自动化证据

有效 RED 是公开入口实际把隔离文件 original 改成 guarded。测试预算不足为夹具错误；实现期间的续接状态丢失及 Platform developer 读取误隐藏均保留失败证据。两个旧后端构建被主动中断，均未完成，不计通过或测试失败。

最终冻结源码：方式测试 8 通过、SimpleChange 39 通过、preflight 13 通过、unified 10 通过；fmt、Clippy、后端构建 exit 0。前一实现检查点的 ExtensionManager 65、tool_task 33、analysis 1、ACP 59+55 通过；工具上下文错误过滤器匹配 0 项记 NOT_RUN，改用真实测试模块后 12 通过。过滤器存在重叠，不合计独立测试总数。

公开入口测试使用脚本化 provider 验证拒绝、服务失败期间解除及重新限制、恢复后的真实文件内容。新目标解除由宿主路由测试覆盖；原子更新测试覆盖晚到轮次、旧目标和其他会话拒绝，工具文字和嵌套派送不能绕过。测试夹具不证明真实模型理解。

证据目录：.cargo/evidence/audit-fixes-20260914/。method-final-gates.json 保存每条命令、cwd、时间、exit code；method-source-frozen.json 与 method-frozen-verification.json 核对 7 个源码文件。最终二进制 SHA256：E865D59C515942E2244A3B31D996F71A509591A7DDDF809052453E801FD3256E。

## 隔离原生验收

真实 Electron 窗口及本次 goose.exe，以独立 CodePro 持久状态夹具执行实际 ACP 工具调用。read_document 返回 original；键盘、输入和直接写入在审批前返回方式特定的 policy_denied，焦点与界面文字未变，实际文件保持 original。未限定名的 write 拒绝回执沿用 unknown::tool 审计哨兵，原请求及拒绝原因保留在证据中。

第一次鼠标调用被既有“桌面观察过期”保护拒绝，未输入；刷新观察后点击历史记录，回执 worked，真实界面新出现“导入链接”按钮。该次拒绝属于已纠正的验收前置状态，不是产品回归。随后释放 ACP 会话，在真实界面加载并刷新原任务；原目标、mouse_only 状态及抽查的另一会话状态保持不变。自有窗口和后端已关闭。

详见 method-native-summary.json、method-native-call-02/03/04/05/09/13.json、method-native-mouse-result.png、method-native-reloaded.png。本轮没有真实模型的新目标解除原生流程；此项证据来自自动化。模型为隔离 fixture-preserved，未探测停用的 120 或替换为 107。
