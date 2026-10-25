# 原生二进制兼容包 / Native binary compatibility packages

## 简体中文

此目录保留 `@aaif/goose-binary-*` 平台包声明。`ui/sdk/package.json` 的可选依赖及 `ui/sdk/src/resolve-binary.ts` 仍引用这些包，因此它们尚不属于无引用文件。当前 CodeBuddy 桌面使用 Harness，不通过这些包启动旧 Rust CLI。

旧 CLI 编译与上游 npm 发布脚本已移除。安装包使用[仓库说明](../../README.md)中的 Harness 构建入口。删除这些兼容包需要同时迁移 SDK 的公开 Node 入口、TUI 和工作区锁文件，不能单独删除目录。

## 繁體中文

本目錄保留平台套件宣告，仍由 SDK 可選依賴及原生二進位解析器引用。目前桌面使用 Harness。舊 CLI 編譯與上游 npm 發布腳本已移除。移除這些相容套件需同時遷移 SDK 公開 Node 入口、TUI 及工作區鎖定檔。

## English

These platform package manifests remain referenced by SDK optional dependencies and its native binary resolver. CodeBuddy Desktop uses Harness. Retired CLI compilation and upstream npm publishing scripts have been removed. Removing these compatibility packages requires coordinated migration of the SDK public Node entry point, TUI and workspace lockfile. Use the repository's Harness build instructions for desktop packaging.
