# CodeBuddy Windows 研究版实施计划

## 目标

在 Goose 桌面端之上制作一个可维护的 CodeBuddy Windows 研究发行版：保留稳定的
后端与 ACP 接口，只修改用户可见的发行身份；推荐 Ollama Cloud，保留本地 Ollama；
默认关闭遥测与上游更新；提供可重复的构建、使用和测试手册。

## 已完成阶段

- [x] 明确研究版范围、安全边界和验收标准。
- [x] 增加发行契约测试和统一发行配置。
- [x] 完成 Windows 产品名、包名、协议、图标和主要用户界面品牌改造。
- [x] 复用并推荐 Ollama Cloud，保留动态模型选择和秘密配置流程。
- [x] 关闭遥测 UI、后端遥测和未配置仓库时的自动更新。
- [x] 增加 Windows 一键构建脚本。
- [x] 编写中文使用、测试和第三方声明文档。
- [x] 完成不依赖完整工具链的发行契约、JSON、脚本和语法检查。

## 待完成验证阶段

- [x] 在 `D:\CodeBuddy` 的 NTFS 工作树完成冻结锁文件依赖安装、SDK、发行测试、typecheck、lint、i18n 和全部桌面单元测试。
- [x] 确认 pnpm 锁文件包含 Electron `node-gyp` 依赖，并完成 Electron、esbuild 和 electron-winstaller 所需二进制准备。
- [x] 使用已安装的 Rust/Visual C++ 工具链通过 fmt、CodePro 定向测试、`goose` lib 测试和可移植 debug build。
- [x] 当前源码的全 workspace Clippy、release build、Windows 应用、Squirrel 安装器和 ZIP 静态校验。
- [x] 使用用户已在本机配置的 Ollama Cloud 完成在线聊天和重启保持配置测试。
- [ ] 完成安装/卸载、真实 Credential Manager 迁移、Ollama Cloud G1 v2 和授权工具调用测试。

## 依赖关系

```text
完整前端依赖 ──> 前端质量门 ──┐
Rust + C++ 工具链 ─> 后端构建 ├─> Electron 打包 ─> 打包态冒烟测试
用户 Ollama Cloud 密钥 ─────────┘                └─> 在线模型验证
```

## 不在本研究版范围

- Windows 代码签名、Microsoft Store 或公开发布；
- 独立更新服务；
- 强隔离 Windows 沙箱或网络隔离声明；
- 未经真实证据的模型资格、性能或生产就绪声明；
- 将底层 Goose/ACP 公共类型机械重命名。

## CodePro 安全执行与验证增量

依赖顺序：

```text
意图识别
  └─> 当前项目直接修改（Git / 非 Git）
        └─> 增量证据与敏感文件门禁
              └─> Tester → Reviewer → 撤销包
```

每个增量必须先增加失败测试，再实现并复测；本轮不提交 Git。

- [x] 意图识别：聊天与只读分析不写文件，明确开发请求直接进入闭环。
- [x] 直接模式：Git 和非 Git 都修改当前目录，不复制项目、不自动 `git init`。
- [x] 证据验证：每个增量保存真实 Patch、测试命令、退出码和有界输出。
- [x] 生命周期：持久化 DAG、暂停/继续，并生成带冲突保护的本轮撤销包。
- [x] 完成 CodePro 定向 Rust/Vitest、fmt、ESLint 和桌面类型检查。
