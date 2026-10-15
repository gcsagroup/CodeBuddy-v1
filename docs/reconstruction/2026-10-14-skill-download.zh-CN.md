# 技能预览下载与应用

源码位于 `D:\CodeBuddy-v1`，基线见 `source-baseline.json`；没有创建分支、提交或推送。本批保持 renderer 原文件，连接既有 `skills/manage/download-preview` 与 `skills/manage/apply`。

`runtime/skill-download.mjs` 接受用户填写的公开 HTTPS `SKILL.md` 地址，或 GitHub `tree/<ref>/<技能目录>` 地址。GitHub 分支先解析成提交及根 tree，再读取所选目录的 Git tree；检查文件模式，拒绝符号链接、子模块、路径越界和重名，并使用 Git blob 哈希核对下载字节。只使用公开访问，不读取 GitHub 凭据。单文件地址只导入该文件，不猜测附属文件的位置。

复用现有 `ipaddr.js` 2.5.0（MIT）检查地址，DNS 结果固定到 HTTPS socket；每次重定向重新检查协议、端口、地址和允许的 GitHub 主机。限制为 64 个文件、单文件 1 MiB、总文件内容 4 MiB、5 次重定向、单请求 20 秒、整次下载 60 秒。查询参数从持久化来源记录及预览来源文字中移除。

`LibraryService` 将下载结果保存在绑定连接、五分钟到期的内存预览中，验证 UTF-8 与 Agent Skills 必需字段；用户点击原“应用”后安装该份快照，不重新访问上游。沿用路径身份、冲突和单次消费校验；完整目录先写到 Harness 技能扫描目录之外，再整体重命名发布，最后刷新官方技能发现。断线和关闭会取消尚未完成的下载。

保留选定目录内的 LICENSE、引用资料及脚本。导入过程不执行脚本。保留上游声明的许可证，不推断缺失的许可；不会从选定目录以外获取许可证。`.codebuddy-source.json` 记录提交、原文件哈希及安装后的技能名称/文档哈希，明确区分因目标目录改名而重写的 frontmatter。

`node --test runtime/tests/skill-download.test.mjs runtime/tests/library.test.mjs`：19 项通过，退出码 0。覆盖原 SDK DTO、真实临时文件、受控本地 HTTP 字节传输、固定提交/哈希、地址限制、大小/时间限制、过期、断线、冲突、来源及许可证保留和脚本不执行。测试未向真实外部技能服务发出下载，也未修改用户技能目录。桌面按钮交互和真实外部服务属于后续产品验收。

参考：[Agent Skills 规范](https://agentskills.io/specification)、[GitHub Git Trees API](https://docs.github.com/en/rest/git/trees)、[GitHub Contents API](https://docs.github.com/en/rest/repos/contents)。选择 Git Trees 是因为它显式提供链接及可执行文件模式；Contents API 对部分链接返回目标文件内容。没有增加依赖或启用旧 Agent 核心。
