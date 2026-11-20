# 参与 CodeBuddy 开发

[简体中文](CONTRIBUTING.md) · [繁體中文](docs/contributing.zh-TW.md) · [English](docs/contributing.en.md)

更新：2026-11-20。

## 开始之前

先阅读 [README](README.md)、[AGENTS.md](AGENTS.md) 和涉及组件的局部规则。当前执行核心是 DeepSeek Harness，桌面是 Electron/TypeScript，Rust 只提供独立 MCP 工具；不要恢复旧 Rust Agent、Provider 或生成的旧 API 客户端。

通过本仓库 [Issues](https://github.com/erjinyi-bool/CodeBuddy-v1/issues) 提交可复现问题；安全问题按[安全说明](SECURITY.md)联系维护者。说明版本或 commit、系统、复现步骤、预期和实际行为，附脱敏日志。

## 修改与验证

- 使用匹配源码的依赖锁文件和 README 启动入口。依赖准备、工具载荷和安装包构建是不同步骤，不以旧产物验证新源码。
- 保留已有未提交改动；提交范围集中，不夹带本地会话、凭据、profile、缓存、截图或构建产物。
- 复用已有事实与协议，跨模块接口和权限语义调整先说明方案及迁移范围。
- 后端逻辑增加或更新有效回归；界面先跑组件测试，再核对真实交互；跨模块变化在实际应用验证关键流程。
- 只改文档时检查内容、相对链接与格式，无需重建产品。Rust 修改按仓库要求执行格式、相关测试及 Clippy。
- 用户可见文档保持简体、繁体和英文同步；源码中的界面文案遵循现有多语言提取与校验流程。

命令、环境和目录见 [README 的开发与测试](README.md#开发与测试)。自动化使用隔离数据目录，不触碰个人聊天或模型配置。

## 提交与审查

在 PR 中描述具体问题、最终行为、变更范围、实际命令和退出结果，并分别列出自动测试、真实交互与未验证项。截图不等于功能验收；构建成功也不等于安装包通过。合并前核对目标分支、依赖及来源许可。

保留 [Apache-2.0 许可证](LICENSE)、上游版权和[第三方声明](documentation/codebuddy/THIRD_PARTY_NOTICE.md)。导入第三方代码时记录版本、来源及许可证；不因文档更新修改原许可证。
