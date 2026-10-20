# Harness 分发门禁与语言目录修复

[繁體中文](2026-10-20-harness-distribution-gates.zh-TW.md) · [English](2026-10-20-harness-distribution-gates.en.md)

## 本次改动

在 `main` 的 `6eb8f7e` 上修复上一批剩余的 10 项旧测试。没有恢复旧 Rust Agent、Provider、Coordinator、TLS 服务或 PowerShell 构建入口，也没有修改当前产品执行机制。

| 旧检查 | 当前验证对象 |
| --- | --- |
| TLS 就绪及证书指纹 | 打包后的 Harness IPC 就绪；拒绝非 loopback/非 HTTP 地址；私密随机连接密钥不写入启动回执 |
| 遥测环境变量 | 当前分发开关、默认关闭的引导页状态及提交条件 |
| Rust Ollama 默认模型文件 | 新 Harness profile 没有预置服务和强制模型，等待用户配置 |
| 旧模型按钮变量名 | 当前本地化的模型按钮可访问名称与提示；现有组件交互回归 |
| PowerShell 构建质量门禁 | SDK、语言编译、Harness 暂存验证、Forge 的调用顺序；验证失败阻止打包 |
| 旧 x64 应用查找函数 | 当前 `--make-only` 只接受准确 x64 目录及匹配 manifest；旧目录、其他架构和错配候选均不通过 |
| 旧 Squirrel 安装器查找函数 | 当前最终化流程读取准确 x64 归档、拒绝无效归档并保护已有安装器 |
| 构建转发测试账号 SID | 当前构建只生成产物；未知 `--install` 参数被拒绝，不启动安装或账号生命周期操作 |
| 旧 Rust release 后端要求 | 没有经过验证的 Harness stage 时，直接 Forge 打包被拒绝；旧后端变量不能绕过检查 |
| 旧存储迁移进程取消 | 当前 Harness 关闭只请求一次，等待服务退出；无响应时有 15 秒终止兜底 |

运行完整 `test:distribution` 时另发现一项旧 Coordinator 夹具已被删除。该项改为执行已有 `runtime/tests/harness-authority-acp.test.mjs`，覆盖原生完成、真实连接失败、工具失败回执以及历史验证不能证明新工作完成等合同。

测试复用现有代码。新增 `ui/desktop/scripts/test-helpers/harness-fixtures.cjs` 使用独立临时目录，拦截构建子进程与服务进程；不会真正构建安装器、安装软件或修改用户 profile。核心测试仍放在现有运行时测试目录，未创建另一套完成判定。

## 语言目录

德语、西语、法语、印地语、印尼语、意大利语、日语、韩语、马来语、葡语、俄语、土耳其语、越南语各补齐 97 个缺失键、清理 23 个废弃键，保留其余 2771 条已有描述及译文。键集合与本次基线英文目录一致，ICU 参数不变。

新增键使用英文源文，延续原有 `defaultMessage` 回退行为；没有把英文复制视为完成本地化翻译。英文和两种中文不需要本次修改。源文提取、描述对象格式、键集合、ICU 参数及编译检查均保留，没有放宽校验来掩盖缺口。

## 验证与交付边界

使用现有 Node 24.21.0；以下命令退出 0：

- 桌面 `test:distribution` 对应的五个脚本，以 `node --test --test-concurrency=1` 执行：51 项通过、0 失败、0 跳过，其中 Harness 合同子进程执行现有 13 项后端回归。
- `node --test --test-concurrency=1 scripts/*.test.cjs ui/desktop/scripts/macos-package.test.cjs`：42 项通过。
- 桌面 Vitest：`src/i18n/i18n.test.ts` 和 `src/components/settings/models/bottom_bar/ModelsBottomBar.test.tsx`：29 项通过。
- `node ui/desktop/scripts/i18n-check.js`；`node ui/desktop/scripts/i18n-validate-locale.js`：英文源和 15 个翻译目录一致，每个目录 2868 条。
- `node ui/desktop/scripts/i18n-compile.js`：16 个语言目录编译完成。

本次是测试合同及语言数据维护，没有修改产品运行逻辑；不把上述自动化检查称为真实模型、真实桌面或安装包验收。未安装依赖、未构建安装包、未修改 Rust，因此不重复 Rust 构建。日志在本机 `.preview-evidence/distribution-gates-20261020/`，不提交。

同事更新本批提交后，沿用 README 中的 Harness 构建入口，不使用这些旧测试曾引用的历史脚本。最终提交和推送状态以交付消息及远端 Git 为准。

验证期间另一任务开始修改媒体预览及英文、中文源目录，本批不吸收这些未提交内容。提交前使用原有语言校验脚本再次读取 Git 暂存版本，15 个翻译目录、2868 个键通过；该结果针对本批提交树，不代表另一任务尚在开发的组合工作区已完成验收。
