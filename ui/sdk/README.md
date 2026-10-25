# @aaif/goose-sdk

## 简体中文

CodeBuddy 桌面使用的 ACP TypeScript 客户端、类型及 Zod 校验器。兼容协议保存在 `schema/`，通过 `generate-schema.ts` 生成 `src/generated/`；不再从旧 Rust Agent 导出协议。

在此目录使用已有依赖执行：

- `pnpm run build`：生成协议类型并编译 TypeScript。
- `pnpm run build:ts`：仅编译已有源码。
- `pnpm test` 与 `pnpm run typecheck:test`：SDK 测试及测试代码类型检查。

桌面启动和安装包构建见[仓库说明](../../README.md)。`@aaif/goose-sdk/node` 的原生二进制解析器及 `ui/goose-binary` 可选工作区包仍用于兼容；它们不代表当前 CodeBuddy 以旧 Rust CLI 启动。旧 CLI 构建和上游 npm 发布流程已移除。

## 繁體中文

本套件提供 CodeBuddy 桌面使用的 ACP 客戶端、型別與 Zod 校驗器。`generate-schema.ts` 從 `schema/` 產生型別，不依賴舊 Rust Agent。於本目錄以既有依賴執行上述建構與測試命令。原生二進位解析器及可選工作區套件仍保留相容性；桌面啟動使用 Harness，舊 CLI 建構與上游 npm 發布流程已移除。

## English

This package provides the ACP TypeScript client, types and Zod validators used by CodeBuddy Desktop. `generate-schema.ts` reads compatibility contracts from `schema/` and writes `src/generated/`; it does not build the retired Rust Agent. Run the build and test commands above from this directory with existing dependencies. The `@aaif/goose-sdk/node` binary resolver and optional workspace packages remain for compatibility. CodeBuddy Desktop starts Harness. Retired CLI build and upstream npm publishing instructions have been removed.
