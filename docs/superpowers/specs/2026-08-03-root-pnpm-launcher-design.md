# CodeBuddy 根目录 pnpm 启动代理设计

## 目标

允许用户在 `D:\CodeBuddy` 根目录直接执行 `pnpm install`、`pnpm run start-gui` 和 `pnpm run start-gui-debug`，不再要求用户理解前端位于 `ui/desktop`。

## 设计

- 在仓库根目录增加一个私有、不可发布的 `package.json`。
- 根目录只提供启动代理，不移动 `ui/pnpm-workspace.yaml`、`ui/pnpm-lock.yaml` 或任何前端依赖。
- `install` 通过根脚本转发到 `ui` 工作区的冻结锁文件安装。
- `start-gui` 和 `start-gui-debug` 通过 `pnpm --dir ui/desktop run ...` 调用现有桌面脚本。
- 保留现有 `just run-ui` 和从 `ui/desktop` 启动的方式，确保向后兼容。

## 错误处理

- 如果 `ui/desktop/package.json` 缺失，pnpm 会明确报告目标目录没有清单，而不是在根目录产生误导性错误。
- 依赖安装以 `ui/pnpm-lock.yaml` 为唯一锁文件来源，不在根目录创建第二套依赖图。

## 测试

- 自动测试根 `package.json` 为私有包。
- 自动测试三个代理脚本都指向 `ui` 或 `ui/desktop`。
- 运行根目录 `pnpm run` 验证脚本可以被发现。
- 运行代理配置测试和 `git diff --check`。

## 非目标

- 不迁移 pnpm 工作区到仓库根目录。
- 不修改 Electron、Rust 后端或打包流程。
- 不自动启动长期运行的桌面进程作为单元测试。
