# CodeBuddy 第三方软件与修改声明

CodeBuddy Windows 研究版基于 Goose 源码修改。上游源码依据仓库根目录
`LICENSE` 中的 Apache License 2.0 提供。

## 上游来源与历史锚点

- 官方上游：`https://github.com/aaif-goose/goose.git`
- 本发行版导入基线：`18740b095f48757fed88466ec1785a804bedc53d`
- CodeBuddy 首个导入提交：`18679fd4c3583ccf1675bc481d6e26b32de2d81a`

仓库使用不改文件树的 `ours` 合并把现有 CodeBuddy 历史连接到上述 Goose 基线，
因此可以用 `git log --graph --all` 和 `git diff 18740b095f48..HEAD` 审查来源与修改。
新克隆若需要同步后续上游更新，可配置：

```powershell
git remote add upstream https://github.com/aaif-goose/goose.git
git fetch upstream main --no-tags --filter=blob:none
```

同步上游属于单独的迁移工作，必须先在专用分支审查冲突和回归测试，不应直接把
`upstream/main` 合并到发布分支。

## 本发行版的主要修改

- 将 Windows 桌面发行身份、图标和自定义协议改为 CodeBuddy；
- 在首次配置中推荐仓库已有的 Ollama Cloud 提供商；
- 默认关闭遥测界面、后端遥测和未配置独立发布仓库时的自动更新；
- 增加 CodeBuddy Windows 构建脚本、发行契约测试及中文使用/测试文档。

## 再分发要求

分发源代码或二进制产物时，应同时保留：

1. 仓库根目录的 `LICENSE`；
2. 上游已有的版权、许可和 NOTICE 文件（如有）；
3. 本修改声明；
4. 依赖组件各自要求的许可证文本与归属信息。

“CodeBuddy”名称和图标用于区分本地研究发行版，不表示 Goose 上游或 Ollama
对本项目提供官方认可、认证或支持。
