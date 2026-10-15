# 配方表单断线与重连修复

范围：D:\CodeBuddy-v1 当前未提交源码，无 Git 元数据。Harness 的执行、完成和上下文机制不变。修改 acpConnection.ts、recipeParamRequests.ts 与两个相关测试；未创建分支、提交、推送或安装依赖。

真实复现：隔离预览5320仅切断正在询问配方参数的一个WebSocket，后端结束请求并回收空目录；旧界面仍显示可提交的表单。新增自动化先红：2失败/11通过，覆盖连接关闭与系统恢复更换连接。

修复：每条ACP连接拥有AbortController；表单消费所属连接的signal。自然断线、控制连接重置、系统恢复更换连接及初始化失败都会清理自己的表单，主/控制连接互不干扰。已提交或取消时移除监听；已失效连接的新回调直接取消。未新增协议或持久化字段，不重放旧提交。

自动验证：四文件40/40，exit0（recipe-disconnect-green.log）；TypeScript和目标ESLint最终exit0。初次lint缺少AbortSignal全局声明，改用已有AbortController的signal类型，不修改lint配置。真实复验：断线立即关闭表单，重新点击配方运行后，会话883f0412-04ba-45a8-a95b-4df839cc7afc准确回复RECONNECTED随机标记，零工具，Harness completed/harness_turn。会话总数31→32，仅新增成功的一次，断线尝试未产生持久化会话。

故障仅由本地验收wrapper在精确配方连接调用terminate，未注入页面状态、未改用户网络或原运行时20048。实际完成截图recipe-disconnect-recovery-completed.png，回执real-skills-4e2BOF/recipe-disconnect-ui-receipt.json，故障日志recipe-disconnect-events.jsonl。旧表单截图保留。Vite重载会按已有配方启动参数重新打开新表单，首次重复点击被该模态挡住是验收定位问题。

测试wrapper现已退出；原预览60726和故障预览76282由Ctrl+C停止，shell退出1（人为中断，不计测试通过）。恢复普通观测启动器，runtime3720/desktop12528/exec56226，CDP9395。后端源码未变，复用上一切片367/367，不重复跑；主用户20048保留，4测试日程暂停。系统恢复路径已做连接单测，本次真实UI注入的是网络断线，未做整机睡眠。
