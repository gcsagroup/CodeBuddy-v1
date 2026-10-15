# Harness 安装包与首响应分段验收（2026-10-15）

状态：开发进行中，安装后的真实验收尚未完成。用户已授权继续实现、构建、安装及实测；无提交/推送/新分支/依赖安装。

## 首响应调查

新增只读 Undici diagnostics_channel 时间点：请求建立、发送请求头、请求体发送完成、响应头、首思考、首正文、结束。不修改 fetch、重试、模型档位或流内容，不记录URL、正文、密钥。响应头前的等待同时含网络及服务端工作，客户端证据不能细分服务端排队与推理。

同一kimi-k3、high、55工具、52433字节且请求SHA一致的四次对照：Compat首正文7760/6470ms，原生Harness4330/3820ms；请求发出前分别5373/4298ms与2384/2050ms。这是各自冷启动的样本，含MCP发现与适配准备，不能当作热会话时延。前一轮真实窗口共享MCP复用后新页面955ms。此轮未复现一分钟等待，夜间32～116秒慢样本仍有效，不承诺稳定秒回。

新测试5/5通过（含原生网络重试、流中断后不重复副作用及隐私断言），exit0；回执harness-compare-fauCOL/receipt.json、compare-harness-phases.log、transport-phases-tests.log。

## 安装接线

采用Electron utilityProcess运行现有runtime/desktop-entry.mjs，单个服务供多个窗口共享；所有执行、调度、完成及压缩仍归Harness。随机回环密钥只在内存与子进程环境传递，退出先请求原生服务关闭；缺少包内运行时直接报错，不回退旧Agent。

复用现有Electron Forge/Squirrel；打包官方npm依赖、适配层、配方schema和当前已验MCP二进制到harness-distribution。安装ID CodeBuddyHarness，安装文件CodeBuddy-Harness-Setup.exe，默认数据~/.CodeBuddy-Harness。旧版及源码预览保留。全部资源记录SHA256；未打包任何用户profile或凭据。核心工具仍复用Rust MCP可执行文件，不表示执行核心仍是Rust旧Agent。

入口：已有Node24执行 node scripts/build-harness-windows.cjs。当前仅Windows工具二进制有pin，macOS仍需独立产物与验收。

依据：[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[Forge Squirrel](https://www.electronforge.io/config/makers/squirrel.windows)、[Undici diagnostics](https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md)。采用已有Electron内置Node；放弃额外附带Node安装依赖与ELECTRON_RUN_AS_NODE，保留原安全fuses。

## 已完成门禁与发现

服务测试2/2、TypeScript/lint exit0；发行测试36/36 exit0。真实Electron41.1.0/Node24.14.0 utility启动、健康检查、原生关闭exit0，utility-probe-final.log。初次测试清理快于日志关闭造成ENOENT，现等待输出结束后释放。旧发行源码正则检查已换成读取实际配置并增加资源篡改拒绝用例。

真实打包导致预览Vite监听out内EXE并出现EBUSY退出，已在renderer开发监听中排除out；生产界面未改，需补实际开发监听复验。旧预览退出后取得独占profile锁，将637会话及配置原样复制到全新~/.CodeBuddy-Harness/backend；SHA一致，日程暂停，原数据保留，installed-profile-copy.json。没有将隔离技能测试的配置覆盖用户配置。

最终安装路径、安装程序指纹、真实对话与工具/重启结果待补，不预报通过。

## 安装构建修复

第一次 make 进程未保留退出回执，不能计为通过。保留同批应用产物后用 Forge 官方 --skip-package 续做，NuGet 明确报 Windows 路径超过 260 字符（harness-installer-make-retry.log，exit 1）。原阶段包含完整 dsh CLI 依赖，未启用的 experimental-inspector 文件相对路径长达 190 字符。现在根据 ESM 导入及实际 profile 收集入口，并递归复制 dependencies、peerDependencies 和已存在的 optionalDependencies，保留嵌套版本、许可证和运行资源，排除开发依赖、类型声明和源码映射。依赖回归 1/1 exit0，覆盖嵌套版本、循环、peer、可选缺省及必需依赖缺失。首次收集遇到 runtime 父层共享的 bufferutil 等包，已修正暂存相对根目录，保留原 Node 解析布局。

Vite 监听复验通过：实际服务观察到源码夹具 add/change，out 夹具无事件，exit0（vite-watch-receipt.json）。未修改渲染界面。

## 10:46 实装回归与继续修复

1.43.2 安装程序已实际静默安装，exit0，注册到 LOCALAPPDATA/CodeBuddyHarness；安装文件 SHA256 B1CB66824E9B33AFE8BC8057E23FBF1989D86A866FF8CA904BF42110D6324772。安装后的 EXE、app.asar、Harness 清单与候选一致，但启动失败：适配层 schedules.mjs 直接引用的 dsh-schedule 被初版依赖扫描漏掉。因此此安装版不是可用交付，已保留失败安装包到 target/failed-harness-installer-1.43.2，关闭本次测试进程，用户配置未覆盖。

根因修复：扫描 runtime 顶层适配器的相对 Harness 包导入，包含日程和语音 WAV 校验；适配器自身也按运行依赖闭包暂存。新增 scripts/verify-harness-stage.mjs，在打包前启动完整 Compat 服务和原生 Harness 会话，旧阶段已红测失败（stage-service-red.log）。候选版本升到 1.43.3-harness1，下一步真实升级安装、对话及重启续聊。当前构建 exec98737，日志 harness-installer-complete-runtime.log；不重复启动。

另一个已修复的打包环境缺口：electron-winstaller vendor 内有 7z-x64.exe/dll，缺 Squirrel 所需 7z.exe/dll，最终封装报找不到进程。构建现使用 vendorDirectory 指向项目独立工具暂存，复用已有架构文件，依赖目录不变。已有 NuGet 的续做校验应用归档与 Harness 清单一致，关闭 ZIP 文件后从独立输入复制到 releaseDir。首次实装包由此成功生成。最新安装/依赖门禁 38/38 exit0，harness-package-final-gates.log。

## 11:10 首次发送并发缺陷

完整依赖修复后的 1.43.3-harness1 候选成功启动，真实界面显示保留的历史与设置。首次三模块请求却在模型请求前失败：Wait for the active conversation operation to finish。原生会话只有 session/model selection，没有 turn/start。这次属于 CodeBuddy 会话适配层缺陷。Git 侧栏工具与发送共用排他锁，工具先开始时发送被拒绝。

conversation-driver 现为发送保留下一次执行机会，等待已开始的直接工具收尾；后续轮询不抢占，取消等待不会发出模型请求，编辑/删除保护保留。回归先复现 2/2 失败，修复后相关测试 24/24 exit0；补充真实 Harness 工具维护和流式回复集成后，本组 11/11 exit0（conversation-native-admission-tests.log）。Harness 仍主导执行、调度和完成。

10:58 界面计时在压缩构建期间且涵盖输入操作，暂不作为空闲新会话耗时结论。正在重建含并发修复的安装包（harness-installer-admission.log），旧安装包及旧进程不作为新修复验收证据。

## 11:28 实装发现原生子进程宿主缺口

1.43.3-harness1 构建和实际升级均 exit0，安装包 SHA256 6E50845A9F833332D3F7379023066EF69AD1DC337995CDBFA28D58EB075BD226，安装 EXE/app.asar/清单/会话适配文件与候选一致。但不计可用交付：真实工具执行暴露 Electron utility 宿主的 process.execPath 指向 CodeBuddy.exe，Harness 的 Windows Job runner 因而提前退出，PowerShell/glob 失败。前一版只测健康和会话创建的门禁不足。

另一个环境因素是 Codex MSIX 将 LocalAppData 安装路径重定向到 LocalCache；工具大小及 SHA 一致，但绝对路径身份检查拒绝别名。现将可信包根目录先解析为物理路径，工具文件自身的校验保留。服务改由捆绑的现有 Node 24.18.0 启动，通过原生 IPC 管理就绪和关闭；Node 可执行文件及 LICENSE 纳入清单。不下载、不安装开发依赖，不改 Harness 的任务/子进程调度机制。参考 Node child_process 官方文档：https://nodejs.org/api/child_process.html 。候选版本 1.43.3-harness2。

服务测试 2/2、tsc --noEmit、相关 eslint 均 exit0。打包门禁升级为使用包内 Node 实际执行 PowerShell 和 glob；另用带目录别名的完整服务检查就绪、认证健康和关闭。构建日志 harness-installer-node-runtime.log；修复后安装验收待完成。失败安装包已保留 target/failed-harness-installer-1.43.3-harness1。

首次候选对话进入页约 0.99 秒、可见回复 13.87 秒；第二个新会话约 1.02 秒/8.09 秒，远程 MCP reused=true，准备 754ms，上游首数据 4629ms、正文 4815ms。admission-candidate-warm.json 因脚本读取隐藏旧会话失效，warm-v2.json 为有效样本。安装版 physical-greeting 的提示含“实际路径验收”，模型发起多次工具探测，不是纯问候耗时样本。

## 11:41 退出竞态与最后安装候选

包内 Node 的 PowerShell/glob 门禁通过（service-check-yqgoHJ/receipt.json），完整服务通过目录别名解析、认证健康和进程退出（node-service-8w730m/receipt.json）。真实候选界面经模型调用 time_now/pwsh，回执完成且命令实际输出 HARBOR-NODE-OK（node-candidate-tools.json/png）。纯“你好”约 1.31 秒进入会话、6.14 秒显示回复，原生准备 798ms，上游正文 2402ms（node-candidate-hello.json）。这些属于 harness2 候选，不能替代最终安装版。

关闭含 ACP 客户端的窗口仍到达 15 秒兜底，调查发现停止期间仍接受 WebSocket 重连。新增 server-shutdown.test.mjs 先复现红测，再在停止开始时拒绝新 HTTP/upgrade；与会话生命周期共 10/10 exit0（shutdown-regression.log）。版本升至 1.43.3-harness3，构建日志 harness-installer-final.log，exec17581；harness2 构建 exit0 但已被此修复替代，未作为交付安装。下一步真实升级、纯问候、三模块开发独立测试、压缩和重启续聊。

## 12:06 最终安装版实测

当前源码来自 D:\CodeBuddy-v1 的现有文件及未提交修改；此目录没有 .git，未创建分支、提交或推送。最终源码身份以发行清单 sourceDigest 为准。Harness 主导执行、调度、完成与压缩，桌面继续消费结构化事件。

构建与实际静默升级均 exit 0。安装后的 EXE、app.asar、清单、Node、server、conversation-driver 和 goose 工具七项哈希与候选一致。安装标识 CodeBuddyHarness，逻辑路径 `%LOCALAPPDATA%/CodeBuddyHarness/app-1.43.3-harness3/CodeBuddy.exe`。本机 Codex MSIX 将路径映射到 LocalCache，可信包根解析已覆盖这个差异。原 CodeBuddy CN 快捷方式哈希未变。用户配置和历史保留在 `~/.CodeBuddy-Harness/backend`；首次启动其他机器不会自动复制旧数据。

纯“你好”：1.698 秒进入会话，11.400 秒首个可见回复，13.643 秒稳定结束，多个可见增量。冷会话准备 5149ms，上游正文 2657ms；样本仍有冷启动等待，不能宣称响应秒回或上游延迟已消失。后续项目会话准备 948ms，远程 MCP reused=true。

真实安装版从输入框完成三个模块 money/tax/invoice，约 145.5 秒，使用时间工具、文件编辑、PowerShell 测试、任务清单和项目记忆候选。第一次模型测试 33/34，模型修正自身错误的浮点 sanity 断言后 34/34；宿主另行运行同样测试 34/34、独立外部合同 7/7，均 exit 0。Harness 原生日志 turn/end reason=completed。项目记忆仍为候选，未擅自激活。

从上下文面板点击“立即压缩”，真实原生 start/summary/end 成功；界面 23k/33k 更新为 17k/33k，最新估计 16925/32768。手打 /compact 后回车被原有斜杠菜单截获（未找到命令），验收使用现有压缩按钮，不计前者通过。原生压缩耗时约 26.35 秒。正常关闭回执 220ms；主进程、Node、四个 MCP 以及已记录子进程全部退出。安装版重启后从历史打开，确认已保存工作区，再继续验证原约束和实际工具。

证据：`.preview-evidence/harness-final-install.json`、`harness3-installed-identity.json`、`harness3-installed-hello.json`、`harness3-installed-project.json/png`、`harness3-installed-project-tests.log`、`harness3-installed-independent.log`、`harness3-installed-compaction.json`、`harness3-installed-native.json`、`harness3-installed-close.json`。

自动门禁（本批，非重复全套）：会话并发与原生生命周期 11/11、停止重连与生命周期 10/10、发行依赖等 40/40，均 exit 0；服务 Vitest 2/2、tsc --noEmit、相关 eslint exit 0。构建入口为既有 Node 24 执行 `scripts/build-harness-windows.cjs`；使用已有依赖，无依赖下载/安装。相关日志 conversation-native-admission-tests.log、shutdown-regression.log、harness-delivery-gates.log、bundled-node-service-tests.log、bundled-node-typecheck.log、bundled-node-lint.log、harness-installer-final.log。

修改边界：runtime/conversation-driver.mjs 修复侧栏工具占用期间的发送；runtime/server.mjs 在停止时拒绝重连；runtime/desktop-entry.mjs 与 ui/desktop/src/harnessService.ts 使用包内 Node 原生 IPC；scripts/stage-harness-distribution.cjs、harness-dependencies.cjs、verify-harness-stage.mjs、windows-installer-tools.cjs 和 build-harness-windows.cjs 修正依赖闭包、真实子进程门禁及安装封装；ui/desktop/forge.config.ts 独立安装标识；vite.renderer.config.mts 排除构建输出监听。对应回归随代码保存。

边界：这次是 Windows 安装后的真实多模块、手动压缩、重启续聊样本；不是 macOS 验收、连续多次自动压缩或小时级大型生产项目证明。之前的自动压缩/12 模块证据见夜间记录，不混作本次安装版新证据。


- Version: `1.43.3-harness3`
- Installer: `ui/desktop/out/make/squirrel.windows/x64/CodeBuddy-Harness-Setup.exe`
- SHA256: `9D4EA185DF6861188743CC6905E898E0FB360391A4D9F87EC1A7896AB708627E`
- Harness sourceDigest: `cd5443c4d6cb2c3d729596ac42895891531d7782793e6cf6774cf23a1a862c78`

## 12:10 重启续聊与最终计时

重启后原会话续聊约 28.0 秒完成：正确恢复 HARBOR-625、625 基点、运费不计税、10975；原生工具实际重跑测试 34/34，并输出新参数 invoiceTotal(10000,700,350)=11050。第二轮 turn/end completed；六个源码/测试文件 SHA256 全部保持不变。证据 harness3-installed-resume.json/png、harness3-installed-native.json、harness3-project-resume-hashes.json。

最后一个新会话纯问候：1.332 秒进入会话、8.054 秒首个可见回复、10.347 秒稳定结束；远程 MCP reused=true，准备 1433ms，上游正文 2534ms。证据 harness3-installed-warm.json。分钟级等待在本次两个安装版问候中未复现，但 8–11 秒首显仍有优化空间；准备、网络和渲染并非同一计时起点，未覆盖的差值尚未逐段证明，不能全部归因于上游。安装版保留运行，开发预览和旧版产物不作为本次通过证据。
