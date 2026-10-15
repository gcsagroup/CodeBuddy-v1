# CodePro 安全执行与验证规格

## 目标

让普通用户在不理解 Git 的情况下使用 CodePro。普通聊天不会启动开发流程；开发任务
默认直接操作用户当前项目，避免复制大型项目，同时保留权限确认、测试和独立审查。

## 本轮范围

1. 自动区分普通聊天、只读分析、明确修改和意图不明请求。
2. 普通聊天与只读分析不写文件；明确修改才启动多 Agent。
3. Git 和非 Git 项目都直接使用当前目录，不复制项目，也不自动执行 `git init`。
4. 完成后提供修改文件、测试证据、审查结论和实际项目路径。
5. 直接模式串行执行写入任务，避免多个 Worker 同时覆盖真实文件。
6. 由宿主强制执行 Planner → Coder → Tester → Reviewer，并在合法审查拒绝后
   最多自动执行两轮 Coder 定向返工、Tester 复验和 Reviewer 复审。

云端沙箱、强 Windows 进程沙箱和自动运行所有类型项目的可视化预览不属于本轮范围。

## 执行规则

- 普通聊天：直接使用普通对话流程。
- 只读分析：使用普通对话流程，不创建 CodePro 工作区。
- 明确修改：直接使用当前项目目录。
- 意图不明：交给语义模型结合会话和项目上下文判断；只有关键产品选择缺失时才询问。
- Git 与非 Git 项目：任务开始时建立运行级临时证据基线，只收集本次运行之后的
  差异，不改变用户真实暂存区，也不在项目中创建 `.git`。

## 安全边界

### 必须

- 非 Git 项目不能被静默执行 `git init`。
- 所有普通文件写入必须限制在当前项目内；工作区外写入交给权限层确认。
- 直接模式不得修改用户 Git 暂存区、切换分支或丢弃未提交修改。
- 多个编码任务必须串行写入当前项目。
- 测试报告必须包含实际命令和退出结果；没有证据不能声称验证通过。
- 每个 Coder 必须存在下游 Tester；模型漏排时由宿主自动补齐。
- Reviewer 缺少 Patch 或真实成功测试证据时必须由宿主直接拒绝。
- Reviewer 合法拒绝后最多进入两轮返工和复验，不允许无限循环；达到上限后交给用户决定。
- Planner 只能缩小宿主按任务类型分配的行动预算，不能扩大初始预算或硬上限。
- 除普通对话外，硬上限前必须保留最后 5 轮用于结构化收尾；进入收尾区后不再暴露执行工具。
- 只读、项目测试、简单修改和 Bug 修复只有在出现成功工具证据后才允许自动扩展一次；
  聚焦测试和复杂功能不自动扩展。
- Coder 或 Tester 连续两次以相同规范化工具名和 canonical JSON 参数发生宿主错误时，只暂停当前
  Worker；参数指纹只驻留内存，不进入日志、状态或用户报告。
- 超时、行动上限和循环保护必须保存为可恢复检查点；恢复不得重新获得已经使用的扩展或备用尝试。
- 用户取消必须保留已完成证据和重试入口；Windows 命令取消必须终止完整子进程树。
- 项目测试命令非零退出属于“项目测试失败”，预算、超时和循环暂停属于“Agent 未完成”，两者不得
  通过自然语言猜测或相互覆盖。

### 需要用户确认

- 删除大量文件或执行不可恢复操作。
- 修改当前项目以外的路径。
- 提权、系统级安装、发布、部署或推送远程仓库。

### 禁止

- 自动复制整个用户项目到隐藏工作区。
- 自动上传本地项目。
- 执行 `git reset --hard` 或静默覆盖用户已有修改。
- 在验证失败时显示“修复成功”。
- 因为用户发送普通问候而运行 Planner、Worker 或 Reviewer。

### 代码模式与嵌套工具权限

- `list_functions` 和 `get_function_details` 由宿主固定为 `ReadOnly`；`execute_bash` 和
  `execute_typescript` 固定为 `HighRisk`；未知 `code_execution` 工具固定为 `Forbidden`。
- 固定权限只由宿主扩展身份和解析后的真实工具名决定。模型参数、工具描述、annotation、全局
  AlwaysAllow、伪造 task/session ID 和 Prompt injection 都不能降低权限。
- TypeScript 沙箱只注册宿主已经固定判定为 `ReadOnly` 的回调；WorkspaceWrite、ExternalWrite、
  HighRisk、Forbidden、legacy、Builtin 和未知来源均不进入回调目录。
- 外部 Stdio/HTTP MCP 固定为 `ExternalWrite`，不得通过代码模式嵌套调度绕过普通权限检查。
- 后续若要支持脚本组合写操作，必须使用宿主签发且逐调用消费的授权令牌，不得恢复直接调用
  `ExtensionManager::dispatch_tool_call` 的无检查旁路。

### Git 推送预检

- `git_push_preview` 是只读、幂等、非 open-world 工具；不自动 fetch、不读取文件正文、不修改 index。
- 预检只接受经过宿主长度与字符集校验的 remote 和 branch；不接受 URL、force、删除分支或任意 refspec。
- 待推提交、摘要和路径必须按精确目标 `refs/remotes/<remote>/<branch>..HEAD` 计算；目标分支不存在时按 first push 的 `HEAD` 计算。
- 远端目标从本地 Git 配置读取，返回前必须删除 URL 用户信息；参数、结果、错误和审计不得包含用户名、Token 或密码。
- 真正 `git_push` 必须携带 64 字符小写十六进制 `preflight_id`，在网络写入前重新预检并逐字匹配。
- 敏感路径、目标分支不是当前分支、detached HEAD、缺失/错误/陈旧预检均必须 fail-closed；不提供绕过开关。
- `git_push` 继续属于 `ExternalWrite`、破坏性、非幂等和 open-world，必须经过阶段 7 的权限、审计、防重、取消、超时和输出上限链。
 
### Git 受限 Clone

- `git_clone_preview` 是只读、幂等、非 open-world 工具，只做本地输入、路径和目标存在性校验，不探测公网仓库。
- 远端源只允许无 userinfo、端口、query、fragment 的 `https://github.com/owner/repository[.git]`；本地源必须是规范化后仍位于工作区内的 Git 根目录。
- destination 只能是尚不存在的可移植直接子目录；禁止路径分隔、多级路径、Windows 设备名、`.git` 和 `.codepro-*`。
- `git_clone` 必须携带匹配当前工作区、规范化源、目标、分支和阻断状态的 64 字符小写十六进制 `preflight_id`；执行前必须重新预检。
- clone 子进程不得继承系统/用户 Git 配置、Git 注入变量或代理变量；必须禁用交互凭据、hooks、submodule、tag、本地优化和 hardlink，并限制协议为 `https:file`。
- 内容先写入宿主生成的唯一 `.codepro-clone-<uuid>`，成功后原子改名；失败、取消、超时或目标竞态只能清理经父目录、前缀和 UUID 三重验证的临时目标。
- `git_clone` 属于 `ExternalWrite`、破坏性、非幂等和 open-world，继续经过阶段 7 的权限、审计、防重、取消、超时和输出上限链。

### Git 结构化冲突检测

- `git_conflicts` 固定为只读、幂等、非 open-world 工具，不接受路径、ref 或解决策略参数。
- 冲突条目只能来自固定 `git ls-files --unmerged --stage -z`；路径按 NUL 边界解析，stage 去重排序，不解析本地化自然语言。
- 结果只包含相对路径、稳定冲突码/语义、stage 集合、操作类型、总数和截断标志；不得返回文件正文、Diff、blob ID、marker 内容或绝对 git-dir。
- 最多返回 500 个冲突路径；异常 stage 组合返回 `unknown`，不得 panic 或猜测解决方案。
- merge/rebase/cherry-pick/revert 状态只通过 Git 解析的绝对 git-dir 下固定 marker 是否存在判断；检测不得修改 index、工作树或 marker。
- 冲突检测结果不构成写入授权；add、checkout、continue、abort、ours/theirs 或自动合并必须由后续独立写工具和权限流程实现。

### Git lease 绑定强制推送

- `git_force_push_preview` 固定为 ReadOnly；`git_force_push` 固定为 HighRisk。Auto、Approve、SmartApprove、annotations、Prompt injection 和任何作用域的 AlwaysAllow 都不能跳过当次确认。
- 预检只允许当前非 detached 分支推向已配置 remote 的同名分支，并要求本地存在对应 remote-tracking ref；remote 不接受 URL。
- 预检绑定规范工作区、remote、branch、HEAD、expected remote OID、双向提交摘要、路径、阻断原因和 64 字符 `preflight_id`；执行前必须重新读取并逐字匹配。
- 执行参数中的 HEAD、expected remote OID 和双向提交数是用户可见确认摘要，必须与最新预检一致；权限卡片不得显示 `preflight_id` 或复制未允许参数。
- 唯一允许的命令形态是 `git push --force-with-lease=refs/heads/<branch>:<expected_oid> <remote> HEAD:refs/heads/<branch>`；裸 force、空 lease、任意 refspec、URL、tag、mirror 和删除 ref 一律禁止。
- 缺 tracking、无远端独有提交、敏感路径、目标不一致、陈旧状态或陈旧 lease 必须 fail-closed；失败不得改变远端目标或用户 index。
- 远端删除当前不注册工具。两种 expected-OID lease 删除形式均被当前 Git 拒绝，因此不得降级为无 lease 删除；通用 rebase/reset/filter/replace/reflog 历史重写仍不在工具目录。

### GitHub 设备登录与安全凭据

- 生产端点固定为 GitHub 官方 HTTPS Device Flow 与 `GET https://api.github.com/user`，禁止重定向；测试端点只允许 loopback。
- ACP/桌面边界只允许 flow ID、一次性用户码、固定验证地址、到期/重试时间和账户元数据；device code、access token、refresh token、HTTP body 与 keyring 原始错误不得进入响应、日志、聊天或 UI。
- GitHub 凭据只写入专用系统 keyring `CodeBuddy_GitHub/oauth-user-token`；系统安全存储不可用、功能未编译或数据畸形时必须 fail-closed，禁止回退 `secrets.yaml`、localStorage、普通文件或内存长期存储。
- GitHub 返回体必须受 HTTPS、无重定向、20 秒超时、32 KiB 上限、内容类型和字段白名单约束；Debug/错误显示必须脱敏。
- 轮询只能使用后端返回的剩余等待时间；`slow_down` 至少增加 5 秒，并在 GitHub 返回合法新 `interval` 时采用更安全的较大值，最大 60 秒。
- 取消、到期、拒绝、成功、断开、页面卸载和晚于卸载返回的启动响应都必须终止活动 flow；同一进程只保留一个活动 flow。
- 只有验证 `GET /user` 成功且系统 keyring 写入成功后才能向前端返回 `connected`；保存失败不得产生成功假象。
- 设置页只能打开常量 `https://github.com/login/device`，任意服务端 URL 或未知响应字段不得进入可点击链接或渲染区。

### GitHub Pull Request 预检与创建

- 只支持当前已推送分支向同一规范 `github.com/owner/repository` 仓库的目标分支创建 PR；fork、Reviewer、评论、合并和 CI 必须由后续独立能力处理。
- preview 必须要求绝对有效 Git 目录、clean、非 detached、同名 upstream、规范 GitHub HTTPS/SSH remote、HEAD 与 remote-tracking SHA 一致、合法且存在的 base，并返回有界提交/文件摘要。
- 版本化 `preflight_id` 必须绑定规范仓库根、owner/repository、remote、head/base 分支与 SHA、标题、正文、draft、maintainer 选项和摘要；create 必须持生命周期锁重新预检并逐字匹配。
- preview/create 只能从后端系统 keyring 读取活动凭据；access token、响应正文和原始 keyring/网络错误不得进入 ACP、日志、聊天、截图或 UI。
- 生产 API 固定为 `https://api.github.com`，禁止重定向，限制连接/总超时、响应 Content-Type 和 64 KiB 大小；测试端点只允许 loopback。
- 创建前必须查询并拒绝重复 open PR；创建 POST 只允许执行一次且不得自动重试。GitHub 响应只能接受精确 owner/repository/number 的 HTTPS 页面地址及与预检一致的 title/head/base/draft。
- CodePro 每次创建都必须显示标题、head→base 和提交/文件摘要并取得显式确认；字段或项目变化必须立即使旧预检失效，迟到异步结果不得回写新项目。
- 成功按钮再次校验固定 `github.com/<owner>/<repository>/pull/<number>` 地址后才能调用外部打开；服务端返回的任意其他 URL 不得变为可点击内容。

### GitHub Actions 只读状态

- `_goose/unstable/github/ci/status` 固定为只读方法，只接受绝对 `workingDir`；不得隐式开放 rerun、cancel、workflow dispatch、日志或制品下载。
- 查询目标必须是当前非 detached 分支、同名 upstream、规范 GitHub remote 且本地 HEAD 与 remote-tracking SHA 完全一致；dirty 工作树仅作为提示返回，不冒充已进入 CI。
- 唯一网络形态为固定 `api.github.com` 上按精确 `head_sha` 过滤的 workflow runs GET；禁止重定向和自动重试，限制连接/总超时、JSON media type、128 KiB 响应和最多 50 条 run。
- 每条 run 必须与目标 branch/SHA 一致，正整数 ID、名称、事件和时间字段均有界，页面地址必须精确匹配 `github.com/<owner>/<repository>/actions/runs/<id>`；未知远端枚举只能映射为稳定 `unknown`。
- 聚合摘要不得把未知状态猜成运行中或成功；无记录、运行中、成功、失败、取消、中性和未知必须保持可区分。
- Token 只能由后端从系统 keyring 读取；ACP/UI 错误只返回稳定 code 和固定脱密消息，不得包含 Token、GitHub 原始 body、日志、制品地址或绝对仓库路径。
- CodePro 右栏仅在首次进入/项目变化时读取一次并允许用户手动刷新，不做隐藏轮询；刷新防重复，项目变化使迟到响应失效。
- 外部打开前 UI 必须再次验证精确 GitHub run 地址；任意其他 URL 只能作为不可点击数据处理。

### GitHub Actions 失败任务重跑

- 只允许当前 exact pushed HEAD 上 `status=completed` 且 `conclusion=failure/timed_out` 的 workflow run；success、cancelled、neutral、unknown、仍运行或不存在的 run 必须在 POST 前拒绝。
- preview 必须绑定规范仓库根摘要、owner/repository、分支、HEAD SHA、run ID、attempt、status、conclusion 和 updatedAt；execute 必须持生命周期锁重新读取本地与远端状态并逐字匹配版本化 `preflight_id`。
- 唯一写入形态为固定 GitHub API 的 `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`，body 固定 `enable_debug_logging=false`；只接受 201，禁重定向、自动重试、轮询、完整重跑、cancel 和 dispatch。
- 外部 POST 前必须先写脱密审计并取得持久 idempotency claim。并发、重复、进程重启后的 success 或 uncertain claim 不得产生第二次 POST。
- 3xx/4xx 视为确定拒绝，可原子释放尚未执行的 claim；5xx、网络错误、201 后的持久化或审计异常均视为结果不确定，必须阻止相同 preflight 重发并提示用户先到 GitHub 核实。
- Token、Authorization、原始请求/响应 body、绝对仓库路径、凭据存储错误和 journal 路径不得进入 ACP、UI、聊天、普通日志或审计正文；公共 receipt 只允许仓库、分支、SHA、run URL/ID、previous attempt、audit ID 和接受时间。
- CodePro 必须先 preview 再显示逐次确认框，明确仓库、workflow、run、attempt、分支、SHA 和 Actions minutes 成本；取消零写、busy 防双击、项目变化丢弃旧响应。
- 成功只允许手动触发一次状态刷新；结果不确定时关闭旧确认上下文，不刷新成成功、不自动重试。320/768/1440px 与键盘操作必须可用。

### GitHub Actions 标准取消

- 只允许当前 exact pushed HEAD 上 `status=queued/in_progress` 且 ID 为正整数的 workflow run；waiting/requested/pending/completed/unknown、缺失或状态变化必须在 POST 前拒绝。
- preview 必须绑定规范仓库根摘要、owner/repository、分支、HEAD SHA、run ID、attempt、status、conclusion 和 updatedAt；execute 必须持共享 CI 生命周期锁重新预检并逐字匹配版本化 `preflight_id`。
- 唯一写入形态为固定 GitHub API 的空 body `POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel`；只接受 202，禁重定向、自动重试、轮询、force-cancel 和 dispatch。
- 外部 POST 前必须完成脱密审计并取得 `github::cancel_workflow_run` 持久 claim；并发、重复、重启后的 success 或 uncertain claim 不得产生第二次 POST。
- 3xx/4xx（含 409）为确定拒绝并允许安全释放 claim；5xx、网络错误、202 后持久化或审计异常均为结果不确定，必须阻止相同 preflight 重发并提示先到 GitHub 核实。
- Token、Authorization、原始 body、绝对仓库路径、凭据存储错误和 journal 路径不得进入 ACP、UI、聊天、日志或审计正文；公共 receipt 仅允许仓库、分支、SHA、run URL/ID、attempt、audit ID 和接受时间。
- CodePro 必须先 preview 再逐次确认，展示 repo/workflow/run/attempt/branch/SHA 与标准取消语义；关闭确认零写，busy 防双击，项目变化丢弃旧响应。
- 成功只刷新一次；结果不确定时不刷新、不自动重试。force-cancel、workflow dispatch、日志正文、制品元数据和制品下载必须保持独立能力；其中 workflow dispatch 与制品元数据由后续小节单独约束，其余仍未实现。

### GitHub Actions Workflow Dispatch

- 仅允许当前 exact pushed default-branch HEAD 上由本地 `HEAD` blob 声明、GitHub catalog 标记 active 且 path 精确匹配的 `workflow_dispatch`；第一版不接受任意 ref、tag、path 或 `repository_dispatch`。
- 后端按冻结 Schema 校验 `boolean/choice/number/environment/string`，最多 25 项、单值 4096 字符、canonical inputs 65,535 字节；未知、重复、越界或畸形输入 fail-closed。
- preview 绑定规范仓库根、owner/repository、默认分支、HEAD SHA、workflow ID/name/path、Schema 与 typed inputs；execute 持共享 CI 生命周期锁重新计算并逐字匹配。
- 唯一写入为数字 workflow ID 的固定 `/dispatches` POST，body 只含默认分支与已验证 inputs；只认 200 和精确 run receipt，禁重定向、自动重试和轮询。
- POST 前必须先写 `github::dispatch_workflow` 脱密审计并取得持久 claim；审计、ACP、UI、错误与回执不得包含 Token、输入值、绝对路径或原始请求/响应 body。
- 3xx/4xx 确定拒绝可释放 claim；5xx、transport、无效 200 receipt 或持久化异常均为 uncertain，跨重启禁止同一 preflight 再次发送。
- CodePro 按 Schema 呈现控件并逐次确认；确认只显示 repo/workflow/path/ref/SHA 与输入键/类型/来源。关闭零写、防双击，项目或输入变化丢弃 preview，成功单刷新，uncertain 禁重试。

### GitHub Actions 制品元数据

- `_goose/unstable/github/ci/artifacts` 仅允许读取当前 exact pushed HEAD 状态结果中已知正整数 run ID 的制品元数据；未知、陈旧或不在首个有界 status 页中的 run 必须在 artifacts 请求前 fail-closed。
- 唯一网络形态为固定 GitHub API `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts?per_page=100&page=1`；只认 200 JSON，禁止重定向、自动重试、轮询和下载，并限制响应为 256 KiB、最多 100 项且 `total_count` 必须精确等于返回数量。
- 私有解析必须校验 artifact ID/name/size、RFC3339 创建/更新/到期时间、可选小写 SHA-256 digest、唯一 ID/name、精确 API/archive URL，以及内嵌 workflow run 的 repository/branch/head SHA；异常或未知字段 fail-closed。
- 公共 ACP/SDK 响应只允许仓库、分支、HEAD、dirty 提示、精简 run 字段、总数和 artifact 的 ID/name/size/expired/created/expires/digest；不得暴露 archive/API URL、Location、node ID、workflow_run 原始对象、Token、workingDir、绝对仓库路径或原始 body。
- CodePro 每个 run 卡片默认零请求，只有用户点击才加载；同步 busy ref 防双击，项目、run、attempt 或 HEAD 变化必须清空并使迟到响应失效。不做隐藏轮询，不提供打开或下载按钮。
- UI 必须再次核对 repository/branch/HEAD/run 和 artifact 有界字段，只显示名称、大小、创建/到期和过期状态；空列表与通用脱密错误明确可见，长名称在窄屏换行且不得制造下载 URL。
- artifact archive 下载与 workflow/job 日志正文需要处理 302 短时签名 URL、跨域、ZIP/内容大小、解压路径和正文脱密，必须由 U-74 独立设计，不得由元数据方法隐式扩展。

## 验收标准

- 发送“你好”时不写文件，也不生成空 Patch 审查报告。
- 发送“分析一下这个项目”时不写文件。
- 发送“帮我修复这个 bug”时进入 CodePro 修改流程。
- 修改直接出现在当前项目，不创建 `D:\CodeBuddy-Workspaces` 副本。
- 非 Git 普通项目可以直接修改，原目录不出现 `.git`。
- 用户可以查看修改文件、测试证据、审查结果和当前项目路径。
- 收集 Git Patch 前后，用户真实 index 内容保持一致。
- 项目在 CodePro 启动前已有的修改不能被错误计入本次运行 Patch。
- Reviewer 拒绝时根据结构化合同产生定向返工 Coder 与复验 Tester；两轮后仍失败则明确报告并交给用户决定。
- 七类任务预算、一次扩展、硬上限、5 轮收尾保留和动态超时均由宿主策略决定并可持久化恢复。
- 达到预算或重复失败上限时报告已完成内容、具体证据、未完成内容和继续方式，不继续寻找工具。
- 取消长时间 Windows 命令后无后代进程残留；应用重启后会话显示已停止和重试，不显示虚假运行态。
- Git 预检前后 index 内容一致；只有匹配当前目标分支和仓库状态且无阻断原因的预检 ID 才能进入非 force push。
- Clone 预检不联网；只有匹配当前工作区/源/目标/分支且目标仍不存在的预检 ID 才能进入原子 clone，失败后不得残留 `.codepro-clone-*`。
- 真实 merge 冲突检测必须返回稳定 `UU/both_modified/[1,2,3]`，不包含冲突正文或绝对状态路径，检测前后 unmerged index 完全一致。
- Force push 只能在最新 preview、完整 expected-OID lease、用户当次确认和确认摘要逐字匹配时执行；陈旧 lease 必须拒绝且远端与 index 保持可证明状态。
- Pull Request 只能在 clean、已推送、同仓库分支的最新 preview、匹配 preflight、无重复 open PR 和用户当次确认后创建；字段/项目变化、陈旧预检、异常响应或未知链接必须在 POST 前后 fail-closed。
- CI 状态只能代表精确已推送 HEAD；dirty、未推送、detached、异常响应、未知链接或凭据不可用时必须明确提示或 fail-closed，不能显示虚假通过。
- CI 失败任务重跑只能在最新 exact-HEAD preview、eligible run、匹配 preflight、持久防重成功和用户当次确认后发送一次；确定拒绝与不确定结果必须严格区分，不确定结果不得自动重发。
- CI 制品元数据只能由用户点击读取 exact pushed-HEAD 已知 run，并保持 metadata-only；任何下载地址、日志正文、Token 或绝对本地路径都不能进入公共响应或界面。

## 聊天正文活动卡片合同

- 新执行以结构化 `ActivityEvent v1` 为状态真相；旧自然语言消息只走隔离兼容路径。
- 同一 `run_id + event_id` 的开始/终态合并，终态不得被迟到运行态降级。
- 已由活动事件表示的纯 ToolRequest/ToolResponse 传输消息不再重复渲染；没有对应活动事件的 Code 工具消息保持原行为。
- 只有相邻、同运行且明确成功或失败的文件读取可分组；未知、取消、停止、中断和跳过不能显示成“已完成”。
- `write/edit` 产生 `file_changed`，失败事件保留具体规范化路径；待写入内容不进入活动日志。
- 默认摘要只显示动作、目标和状态；展开详情可显示路径、参数、耗时、退出码、Diff 与最多 50 行/4000 字符的输出。
- 活动消息使用 `MessageMetadata::user_only()` 且 `include_in_model_context=false`，不得进入 Agent 可见上下文。

## 右侧任务栏合同

- 右栏只读取当前用户轮次的实时任务、结构化 `ActivityEvent` 和迁移期完成报告，不得回退展示旧轮次任务。
- 文件页签同时收集 `file_read` 与 `file_changed`；同一生命周期终态缺字段时保留先前已验证的路径。
- 任务导航先按当前 `data-session-id` 限定会话，再以数据属性精确比较任务 ID，不把任务 ID 拼接为选择器。
- 右栏只显示任务、角色、状态、进度和有界结果摘要；命令输出、Diff 与完整证据保留在聊天正文。
- 本地偏好只允许持久化展开布尔值和 320–480px 宽度，不保存任务正文、路径、报告、文件内容或凭据。
- 无偏好时默认显示 36px 可发现入口；`>=1200px` 使用内联面板，`800–1199px` 使用覆盖层，`<800px` 使用抽屉。

## 统一消息操作合同

- Code 与 CodePro 使用同一动作显示策略：流式期间隐藏；完成正文可复制和重试；结构化终态即使无正文也保留一组动作；不可重试终态只复制。
- 普通最终答案重试必须以源用户消息创建 ACP fork 并自动重发，保留当前会话的旧答案、工具动作和失败证据；不得借重试调用原地 truncate。
- CodePro 检查点继续、原请求回放和失败验证重试只读取结构化 `RetryStrategy` 和来源 ID，不匹配本地化报告文案。
- 用户消息默认 Ctrl/Cmd+Enter 通过 fork 重发；只有用户显式选择“原地编辑”才允许 truncate，且仍受空闲/权限等待取消边界约束。
- 无最终文本复制摘要只扫描源用户消息到终态之间、同一 `run_id` 的有效 `ActivityEvent`，合并同一事件生命周期并限制为 3 个动作、5 个路径、2000 字符。
- 复制摘要只包含状态、动作类型、安全路径、退出码计数、文件变更计数和继续方式；不得消费或复制 `technical_details`、完整命令、工具参数/结果、文件正文或用户消息正文。
- 用户编辑、输入、取消和按键不得记录消息正文；刷新后的 `TurnTerminalRecord v1` 必须恢复相同动作规则。

## 测试策略

- Rust 单元测试：意图分类、任务 DAG 自动补齐 Tester、角色证据门禁和 Reviewer
  返工分支。
- Rust 文件系统集成测试：Git/非 Git 统一运行基线、本次 Patch、生成目录排除及
  不创建项目内 `.git`。
- Vitest：直接修改任务报告和历史隔离报告兼容。
- 最终检查：`cargo fmt --all -- --check`、CodePro 定向 Rust 测试、CodePro 定向
  Vitest、桌面 TypeScript 类型检查。
