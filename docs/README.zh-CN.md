# CodeBuddy 文档索引

[简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [English](README.en.md)

当前执行核心为 DeepSeek Harness，桌面为 Electron/TypeScript，Rust 仅用于独立 MCP 工具。版本以桌面 package.json 为准；测试结论必须对应具体源码和产物。

## 开发入口

- [安装、依赖、启动、构建与测试](../README.md)
- [模块职责与事实权威](../documentation/codebuddy/CODEPRO_FACT_AUTHORITY_ZH_CN.md)
- [Harness 适配说明](../runtime/harness/README.zh-CN.md)
- [脚本入口](../scripts/README.md)
- [第三方来源与许可证](../documentation/codebuddy/THIRD_PARTY_NOTICE.md)

## 功能与平台

- [存储目录](storage-layout.zh-CN.md)
- [安装默认模型](installation-model-defaults.zh-CN.md)
- [Windows 安装界面](windows-installer-ui.zh-CN.md)
- [macOS 构建](macos.zh-CN.md)
- [macOS 安装与卸载](macos-installation.zh-CN.md)
- [浏览器控制](browser-control.zh-CN.md)
- [电脑控制路由](computer-use-routing.zh-CN.md)
- [会话文件](conversation-files.zh-CN.md)
- [桌面宠物](desktop-pets.zh-CN.md)
- [长期目标](long-term-goals.zh-CN.md)
- [图片生成](image-generation.zh-CN.md)
- [视频生成](video-generation.zh-CN.md)

## 交接与历史

- [2026-10-23 合并交接](reconstruction/2026-10-23-merge-handoff.zh-CN.md)
- [逐提交修改原因](reconstruction/2026-10-23-commit-rationale.zh-CN.md)
- [当批桌面交付记录](reconstruction/2026-10-23-desktop-delivery.zh-CN.md)

旧 Rust Agent 计划、早期重构验收流水和上游文档网站已从当前文件树移除。它们保留在 Git 历史中，不再作为当前实现说明。用 `git log --all -- <path>` 查找旧路径，再用 `git show <commit>:<path>` 读取内容。

本地未提交的设计草稿、验收数据、依赖及构建产物不属于此次清理范围。历史测试报告不证明当前版本已经验收。
