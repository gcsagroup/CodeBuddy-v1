# CodeBuddy GitHub `main` 开发预览说明（2026-08-07）

## 发布性质

本次更新是公开源码开发预览，不是 Windows Beta、RC 或正式 Release。仓库不提供经过代码签名和完整安装生命周期验收的公开安装器，不建议直接用于没有备份的生产项目。

## 候选范围

- 源码起点：`881b4314446ea4235f9aa3d828d257db1bf3ee85`
- 远程旧 `main`：`fc77d1cb6eec65677465f62b41d30c872d4ccf65`
- 发布方式：普通 fast-forward push，禁止强制推送
- 包含：已经提交到候选历史的 CodeBuddy 桌面、Agent、报告、权限、Git/GitHub、测试和文档改动
- 不包含：本机主工作区的未提交内容、未整合的长期功能分支、构建缓存、用户数据和安装器资产

候选历史相对远程旧 `main` 规模较大，因此本次目标是建立可公开审查和后续收敛的源码基线，而不是宣称所有功能都已达到发布质量。

## 当前验证记录

| 检查 | 状态 | 说明 |
| --- | --- | --- |
| 远程祖先关系 | `PASS` | 远程旧 `main` 是候选源码起点的祖先，可使用普通 fast-forward |
| Git 大对象检查 | `PASS` | 候选新增历史没有大于 50 MiB 的 blob，也没有新增构建产物或二进制包路径 |
| 独立秘密扫描 | `PASS_WITH_TRIAGE` | Gitleaks 8.30.1 全历史扫描原始退出码为 1，共 64 项候选命中；命中已按公开上游、文档示例和测试夹具分类，未发现未关闭的真实凭据。扫描期间 Git 的 `astextplain` 因缺少 `docx2txt.exe` 输出环境告警，但未改变扫描结果 |
| 许可证与上游声明 | `PASS` | Apache-2.0 `LICENSE`、README 上游归属和 CodeBuddy 第三方声明一致 |
| 候选差异空白检查 | `PRE_EXISTING_FAILURE` | `git diff --check origin/main...HEAD` 发现候选历史已有文档/脚本末尾空白；本次未扩大范围，`cargo fmt --all -- --check` 通过 |
| Rust 编译与 CodePro 聚焦测试 | `PASS` | `cargo check -p goose --tests` 退出码 0；runtime 14、task graph 5、event log 8、result convergence 2，共 29 项通过 |
| Desktop 与 SDK 门禁 | `PASS` | Desktop typecheck、lint:check、Vitest 132 文件/977 通过（4 skipped）；SDK lint 及 5 项测试通过。Desktop 首次 typecheck 缺少生成的 zh-CN 资源，先运行 i18n compile 后通过 |
| Windows 安装、升级、回滚与卸载 | `NOT_RUN` | 不属于本次源码预览关闭条件，仍是 Windows Beta 门禁 |
| 真实 Provider/MCP 全矩阵 | `NOT_RUN` | 本次不宣称全部组合已资格化 |

`NOT_RUN` 不表示通过。上述状态将在同一发布 worktree 实际执行后更新；任何未解释的新项目回归都会阻止推送。

### 安全扫描明细

- 扫描器：Gitleaks `8.30.1`
- 官方资产：`gitleaks_8.30.1_windows_x64.zip`
- 资产 SHA-256：`d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`
- 校验方式：下载同一官方 Release 的 checksums 文件，归档实际 SHA-256 与清单逐字匹配后才执行
- 候选范围扫描：152 个提交、约 4.41 MB；2 个候选命中
- HEAD 历史扫描：5249 个提交、约 113.06 MB；63 个候选命中
- 当前树与两层归档扫描：约 129.61 MB；30 个候选命中
- 候选新增路径检查：446 个路径；敏感文件名 0，构建/安装二进制路径 0，大于 50 MiB 的新增 blob 0

候选新增的两个命中分别来自：

1. 一份验证报告中的 `secret-safe` 审计说明文字，被 `generic-api-key` 规则识别；该行没有长 Token、URL、Windows 用户路径或提交哈希。
2. `messageActionsModel.test.ts` 中用于验证脱敏展示的合成 Bearer Token，被 `curl-auth-header` 规则识别；只存在于组件测试夹具。

其余 HEAD 历史和当前树命中属于已经公开的上游或测试/文档材料：ACP transport 合成密钥、TLS PEM 格式说明与测试私钥、GCP mock service account、localhost curl 示例、提示词中的攻击样例、作者 LinkedIn URL以及工作流键名。扫描报告全程使用 `--redact=100`；本说明不记录匹配值。

依赖与锁文件检查：

- `pnpm audit --prod --audit-level high`：退出码 0，未报告已知漏洞。
- `cargo metadata --locked --no-deps --format-version 1`：退出码 0，Cargo 锁文件可解析。
- 推送前复扫：Gitleaks `detect --source . --redact=100 --no-banner` 扫描 5410 个提交、约 122.64 MB，退出码 1，64 项命中均落在上述公开上游/测试/文档模式；未将匹配值写入报告。
- `cargo-deny`：当前工具链未安装，因此记录为 `NOT_RUN`，不冒充许可证或漏洞扫描通过；本次没有新增依赖变更。

## 已知限制

1. CodeBuddy 仍是研发预览，不是强隔离安全沙箱。
2. 默认运行路径与新的 durable control plane 仍处于迁移和资格化阶段。
3. Windows 安装器可以构建不等于已经完成干净账户安装、升级、回滚和卸载验证。
4. Provider、模型和外部 MCP 的完整支持矩阵尚未形成当前候选证据。
5. 并行 Agent、完整 worktree 生命周期、长期记忆、通用电脑/浏览器控制和企业能力不属于本次预览承诺。
6. 第一次使用应选择临时仓库、测试分支或有可靠备份的目录，并在每次写入后检查 `git diff`。

## 回滚

推送前将创建远程分支 `backup/main-before-windows-preview-2026-08-07`，固定指向旧 `main`：

```text
fc77d1cb6eec65677465f62b41d30c872d4ccf65
```

如果公开后发现阻断问题，优先通过新的 revert 提交恢复主分支，保留可审计历史。远程回滚分支只作为精确定位旧基线的安全引用，不代表额外发布版本。

## 下一阶段

本次源码基线建立后，优先完成：固定一个默认 Provider、跑通安装态的小型改代码闭环、验证取消与重启恢复、完成干净 Windows 安装生命周期，再决定是否标记 Windows Beta。
