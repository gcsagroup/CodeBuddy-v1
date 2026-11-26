# ADR-002：Windows 沙箱准备的隔离、期限与失败恢复

## 状态与范围

2026-11-25，按用户修复及分阶段独立对抗审查授权实施。Harness 继续拥有执行、权限模式、取消和工具回执；CodeBuddy 隔离同步权限准备，并保持会话 TEMP 的宿主生命期。没有升级依赖、扩大权限、增加 ACP 协议或持久化缓存。

开发基线为 fc940ffacc94cf19b1feaa04aa4dc918f9ce2eef，修复分支为 codex/fix-windows-sandbox-recovery-20261125；精确提交以 Git 为准。**推送前审查撤回增量标签缓存，当前每条 workspace-write shell 准备均执行有预算的完整标签检查。** 早期缓存与一次全扫性能证据不再代表最终实现。

## 问题与事实 owner

安装版工具在13:32:52.524发出，13:49:35.108才返回120000ms超时。等待中的原生栈位于 SetNamedSecurityInfoW 的权限继承处理；停止、排队输入及导出一同等待。模型选择命令，宿主必须处理选错命令或权限准备失去响应的情况，并及时返回可纠错的事实。

锁定 DSH 0.2.1-alpha.2 的 confine → runnerArgv → materializeAclGrant 包含同步原生调用。只读原生实验在锁保持1500ms时，100ms定时器到1578.7ms才运行，IPC到1580.0ms响应，证实原生 DSH 也有控制面阻塞风险；这不代表重新证明原始17分钟事故的每个阶段。

WorkspaceLabelAccess.cs 是 CodeBuddy 的已有适配，并非 DSH 原生组件。它只为当前账号拥有且可写的已有对象补缺失标签，保留固定句柄、链接排除、所有者、保护DACL、相关拒绝和显式标签边界。原生 Harness 继续持有能力SID、授权、受限runner与进程事实。

## 决定

1. **隔离同步准备。** 按工作区及模式使用最多4个逻辑槽；每槽同一时刻只保留一代物理进程，父级最多排队16条请求。用户进程由 Harness 在宿主侧启动，不属于准备 Job。独立项目及同项目只读准备不等待写权限准备。
2. **队列与物理代际分开。** 同步认领槽并入队，防止已选中的空闲进程被并发请求驱逐。活动请求取消、期限到达或进程失败只结算该请求；未派发请求保留FIFO、原取消信号和原单调期限，等旧 child 真正 close 后再启动新代。已派发请求不自动重放。根目录身份改变拒绝旧目标队列，新显式请求可重新准备。
3. **有界且可取消。** 准备默认120秒，排队、进程获取和标签检查均计入；原生工具更短预算及调用者取消优先。派发和成功IPC交接重新检查同一单调期限，不能仅依赖timer先运行。取消先协作退出，留最多2秒恢复当前对象DACL，再关闭准备Job。标签helper使用剩余预算并保留清理窗口，系统调用不能返回时由Job兜底。预算不是权限事务回滚保证。
4. **完整检查，不使用标签基线。** 每次workspace-write shell准备都重新遍历工作区；只读及文件读取工具不进入该标签遍历。检查在对象边界与互斥等待中检查预算/取消。Win32 32/33共享冲突只计为partial并跳过该对象，不让一个锁定文件阻断无关命令；下次完整检查自然重试。没有deferred路径缓存、监听进程、名称事件、自动重试命令或排除目录名单。根目录身份在授权前及标签检查后以设备号/文件号核验，替换或消失丢弃原生Provider与资源键。
5. **对象边界保持原义。** 不跟随重解析点，跳过多链接、其他所有者、保护DACL、相关显式拒绝及已有完整性标签。缺失标签的临时WRITE_OWNER仅用于当前对象，随后恢复DACL及继承状态；标签无继承位。目录互斥按当前账号、卷序号、目录文件ID建立，父锁持有到后代完成，使独立目录并行、重叠目录串行。最终路径缓冲按实际路径长度分配并有界重试，避免每对象32768字符分配，不改变匹配规则。
6. **真实失败可纠错。** 准备失败保留原生SANDBOX_UNAVAILABLE，给出阶段、实际等待时间、用户命令未启动及可选文件工具；准备可能已修改权限，不能说无副作用。原生tool先到期且尚无payload handle时，仅在原生分支补充命令未启动的stderr，保留其timeout形状。编码探针与同一startup Promise的退出合同见ADR-003。日志每5秒记录请求、阶段及耗时，不记录命令、输入或凭据。
7. **TEMP按宿主寿命持有。** 独立资源进程使用官方AclWriteGrant、tempWriteSid和规范工作区校验，按原生会话/工作区键复用随机私有目录与SID。准备进程回收不撤销它们。稳定Host记录每一代原生subprocess owner，先封存启动/终端分配并等待受管范围退出，再清理TEMP；单独重载sandbox不停止全局命令。失败或硬回收保留旧授权，新代不认领旧目录。私有SDK接缝核验源码指纹。
8. **资源自身也有期限。** 同键申请合并，取消等待者不影响其他等待者或已有能力；未完成申请最多16个，资源操作看门狗默认120秒，旧代真实退出前不创建新代。Job设置失败、异步spawn失败、ChildError、IPC发送失败和资源看门狗统一先封存当前代；逻辑失败和kill请求都不是退出证明，只有对应child.close释放下一代启动资格。Node可能在建立stdio前异步报告启动失败，因此诊断流允许缺省，error/close处理仍必须接收；IPC失败后保留旧grant供原消费者使用，不继续把失联进程当作可用owner。普通TEMP清理沿用该资源操作期限，避免原2.5秒兜底杀掉正常递归删除；异常abandon仍2.5秒。桌面已有15秒外层退出兜底保持不变。无法确认退出会记录，不能据此声称目录已删除。
9. **消费已有工具预算。** 显式profile补载官方dsh-tool-call-timeout-policy，消费glob/grep/web_fetch已有30秒定义，通过原exec.signal取消并等待下游收束，返回TOOL_TIMEOUT。调用者先取消保留原分类；未定义工具级预算的pwsh仍由逐调用期限/后台作业管理。预审批和排队仍归原owner。协作取消不能保证系统IO在精确30秒前退出。

## 为什么撤回增量缓存

独立真实受限进程先证明仅名称监听会漏掉只读属性解除、DACL保护解除和显式标签删除。连续ATTRIBUTES/SECURITY监听与有界已知硬链接复查能补这些情况，但仍存在更根本的反例：

- 完成初始化，排空自身通知，原文件真实可写；
- 外部程序在工作区外新建硬链接，只通过外部别名清除标签，然后删除别名；
- 工作区内没有通知，缓存仍认为当前；新准备后的真实受限写被拒绝；
- 同一个helper完整检查Changed=1后，相同原生argv立即可写。

目录通知不是卷级对象变更事实，记录已知跳过对象也无法覆盖基线后才出现的树外别名。临时关闭SECURITY、忽略自身事件、周期TTL、增加更多路径例外都不能恢复原覆盖。因此删除观察器、基线/dirty/deferred/recheck缓存、定点选择API及宿主文件变更IPC，不留默认关闭的第二套机制。

NTFS USN需要卷/日志能力、权限、日志丢失和非NTFS回退等完整设计，本批不临时引入。当前选择保留正确性，并用隔离及期限保证模型有纠错机会。它没有根治大树首次或后续写权限准备的成本。

## 拒绝的其他方案与限制

仅调大预算或限制模型命令不能解除控制面阻塞；一个永久全局worker不能隔离不同项目；硬杀helper不能保证临时DACL的finally；以调用引用计数回收TEMP会误伤后台命令。均不采用。

给历史低标签添加继承位无法区分用户策略与旧补丁来源，可能覆盖原本跳过的子项；不采用。整体升级DSH、切换Codex MXC或照搬Claude的WSL2路径需要独立平台迁移与验收，本批不实施。

大项目每次写权限准备仍可能耗尽120秒；这次交付解决控制面冻结、晚到执行、取消误伤、队列回收和错误恢复，不承诺任意项目快速初始化。操作与外部程序并发时没有文件系统事务快照。Job强杀不能承诺DACL回滚；异常随机TEMP授权可能残留，新代不复用。

## 验证与交付边界

相关自动回归均在含改动的当前worktree后台执行，来源身份与回执另存本地报告。测试不替代桌面/安装包或真实模型验收。

- windows-sandbox-control：真实Compat/ACP与原生锁，120秒准备超时、控制请求/导出仍响应、取消后同轮改用文件工具。
- responsiveness/lifecycle：跨项目隔离、活动取消保留另会话FIFO、同步容量回收、原期限、根替换、进程/TEMP代际、正常慢清理及Host排空；TLA+发现的启动失败窗口由一次原生Job设置故障注入、真实spawn/kill/close回归固定，旧close前不创建下一owner，之后恢复；另覆盖Node无PID/stdio的异步error，以及真实IPC EOF、受控推迟退出后的主动退役和旧grant保留。
- label-eligibility/preparation：只读绕过、根身份、所有真实状态转换反例（包括基线后新树外别名），Unicode锁定文件/多对象锁定不阻断无关命令，解锁后下一全查恢复。
- label-deadline/concurrency/allocation/workspace-label：取消/期限后DACL还原、独立/重叠目录锁、路径长度分配、长Unicode路径、受保护/链接/工作区外边界和真实Host文件写后受限修改。
- codec/tool timeout/staging：见ADR-003与相应原生工具回执；UI停止状态单独验证。

此前大夹具与真实模型/Aegis只读证据保留其原source hash，不挪用为撤回缓存后的最终源码验收。没有修改Aegis权限或发布安装包，也不把模型自述当通过。

## 官方参考

- [DSH sandbox职责](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md)、[原生Provider](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/src/index.ts)
- [Node事件循环](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)
- [SetNamedSecurityInfoW继承传播](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [卷号/文件ID](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle)、[最终路径缓冲](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
- [目录通知及丢失](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)、[硬链接及别名属性](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions)、[Change Journals](https://learn.microsoft.com/en-us/windows/win32/fileio/change-journals)
- [Codex MXC边界](https://github.com/openai/codex/blob/main/codex-rs/mxc-sandbox/README.md)、[Claude sandbox平台](https://code.claude.com/docs/en/sandboxing)
