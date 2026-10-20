# 2026-10-20 远端与本地修改集成记录

[繁體中文](2026-10-20-remote-merge.zh-TW.md) · [English](2026-10-20-remote-merge.en.md)

## 来源与合并范围

在 `D:\CodeBuddy-v1` 的既有 `main` 上集成。原本地版本为 `732113504de3601ab087a609ce20827b814db2c2`；远端新增 24 个提交，快进到 `a95fcda661c1bdafbb6b0f81180ea116c72f6eec` 后恢复本地未提交修改，没有新建分支或 worktree。

保留远端的原生子 Agent、模型能力与思考参数、审批状态、工作区布局、对话展示和安装流程改动；同时保留本地的 MCP 会话恢复、图片/视频工具、桌面宠物、品牌资源、macOS 工具及凭据适配和打包改动。执行、调度、完成及上下文压缩仍由 Harness 负责。

12 个冲突文件已处理：所有权地图、内置工具清单、兼容服务、Harness 适配、MCP 桥接、工具发现、分发暂存脚本、桌面布局、模型设置及三种语言目录。关键处理是同时保留 MCP 配置失效与审批状态重置、子 Agent 模型设置与图片/视频设置，并把生成工具与原生子 Agent 工具一起保留在按需发现链路中。

修改了相关测试夹具以匹配当前原生协议：显式声明模型能力和输出预算；连续压缩夹具使用持久的助手事实，避免工具结果先被原生裁剪；技能拒绝场景使用明确的工具权限；前端夹具支持 ResizeObserver 和模型显示名称。修正 ComfyUI 地址控件的可访问名称翻译。

## 构建与验证

构建来源为 `a95fcda` 加本次集成的工作区修改。使用已有 Node 24.21.0 和本机 Rust 工具链；未安装依赖、未生成安装包。

| 验证 | 命令/范围 | 实际结果 |
| --- | --- | --- |
| 后端 | `node --test --test-concurrency=2 runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs`，再定向复测 roles、settings、library | 初跑 518 通过、11 失败、1 跳过；修正后 11 项均有通过证据，合计 529 项分批通过、1 跳过；定向复测退出 0，不是单次全绿运行 |
| 前端 | 48 个受影响 Vitest 文件，`--maxWorkers=1` | 初跑 536 通过、2 失败；修正后四文件 49 项复测退出 0，合计 538 个受影响用例有通过证据 |
| 入口/打包脚本 | `node --test --test-concurrency=1 scripts/*.test.cjs ui/desktop/scripts/macos-package.test.cjs` | 42 通过，退出 0 |
| Rust | `cargo test --offline -p goose-mcp --features rustls-tls --lib --jobs 1` | 69 通过、1 忽略，退出 0；忽略项调用公共天气服务 |
| Rust 静态检查 | `cargo fmt --check`；`cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings` | 均退出 0 |
| 工具构建 | `cargo build --offline -p goose-mcp --features rustls-tls --bin codebuddy-tools --jobs 1` | 退出 0，更新本地工具与校验值 |
| TypeScript/规范 | SDK 编译、桌面 `tsc --noEmit`、改动文件 ESLint、`git diff --check` | 均退出 0 |
| 翻译 | `i18n-check.js`；`i18n-validate-locale.js zh-CN zh-TW` | 退出 0，英文源及两种中文目录共 2868 条 |
| 可访问性 | 分发测试中 `renderer JSX has no hard-coded English UI labels` | 修复后 1 通过，退出 0 |

重建的 Windows `codebuddy-tools.exe`：21,777,920 字节，SHA-256 `c04d51c3d42b6fa75c5ef0523d9a69dbba568bc015c3275aa4322f5ff9d740f2`。来源和构建信息见 `runtime/tools/provenance.json`；二进制是本地产物，不纳入源码提交。其他机器应按 README 构建并核对对应工具来源。

## 真实桌面验证与边界

通过现有 `startPreview` 入口编译并启动当前 Electron，使用隔离 profile、本地受控模型和 MCP 服务。实际点击并验证：子 Agent 和图片/视频设置同时存在；ComfyUI 地址保存并写入状态；宠物显示/隐藏；发送消息调用 MCP health，收到 `MCP_HEALTH_OK | desktop-session-2 | execution=1`。原生会话 `314e7281-8bb6-426f-abd6-c0219ff653bf` 记录 `turn/end: completed`，health 成功执行一次。已观察最终回复截图，关闭本次测试窗口后启动器退出 0。

这证明当前桌面、适配层、Harness 与 MCP 的受控链路，不代表真实云端模型、GPU 图片/视频生成或 macOS 硬件验收。该夹具禁用内置开发工具，首次工具搜索被拒绝，随后直接调用 MCP 成功，因此这次桌面流程也不作为工具搜索成功证据。工具发现有独立后端回归覆盖。

## 尚存的检查问题

- 扩展运行旧 branding/distribution 套件时共有 11 项失败；本次引入的 ComfyUI 英文可访问名称已修复复测。剩余 10 项涉及旧 TLS、遥测页面、默认模型、控件静态断言及已移除的 Windows 构建/迁移脚本。未将整套历史门禁报为通过，也未为满足旧断言恢复旧核心。
- 全语言目录验证仍失败：远端基线中德语、西语等已有 96 个缺失键、23 个多余键，本地宠物页面又增加一个键；本次只完成英文与两种中文的一致性，不扩大为全语言翻译工作。
- 后端的 macOS Keychain 测试在 Windows 跳过；本轮没有 macOS 实机或安装包验收。最初全量前端运行无结果后停止，最终验证范围是上述 48 个受影响文件。

## 回滚与同事接入

提交前备份和本轮日志/截图在 `.preview-evidence/merge-20261020-091416/`，留在本机，不提交。备份包含原始文件压缩包、哈希清单与二进制补丁；`pre-merge-20261020-preserve-local` stash 保留。新增的 `tool-source-manifest.json` 对应合并后的工具源码，不与原始备份清单混用。

本记录随集成提交进入 `main`；推送结果和最终提交号以交付消息与 Git 远端为准。同事在自己的干净工作区更新 `main` 即可获得远端 24 个提交及本批本地功能，不需要重复应用备份 stash。本批没有改动用户生产 profile 或凭据，也没有上传本地验收 profile、缓存、日志和安装包。
