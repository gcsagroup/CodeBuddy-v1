# 工具箱开关滚动跳顶修复

2026-09-14

原因：ToolboxView 每次刷新都进入整页加载状态，暂时移除全部工具卡片，滚动内容高度骤降，导致浏览器将位置夹到顶部；高级分组也会重新创建。

修复：加载提示仅用于首次加载。后续开关和刷新保留列表节点，只更新返回的数据；使用请求序号防止较早请求覆盖较新的工具状态。工具权限及配置保存接口不变。

专项验证：4 个测试文件、27 项通过，退出码 0。新增回归覆盖连续启用/关闭期间节点身份与展开状态保持，以及异步请求乱序返回。

原生桌面验收：使用独立配置启动 Electron，通过真实鼠标滚动到列表中下方，关闭并重新启用任务委派，位置不变；展开高级分组，在页面下方启用任务清单，位置及展开状态不变；Ctrl+R 后搜索任务清单，确认启用状态已保存；在搜索结果中关闭任务清单，搜索条件保留。测试前开关状态已恢复，用户原窗口未改动。

完整验证通过：227 个测试文件全部通过，2009 项通过、0 失败、4 跳过；类型检查、全前端 ESLint、修改文件 Prettier 和生产构建均退出 0。构建有第三方 use client 指令及较大分块警告，无构建失败。测试后源码哈希未变。

这是保留已加载列表的修复，未新增滚动位置持久化；主动重新加载页面仍按现有页面初始化行为处理。旧安装包未重新打包。

Evidence: `.cargo/evidence/toolbox-scroll-20260914/` (`source.json`, `native-evidence.json`, `gates.json`).

```text
# cwd: D:\CodeBuddy\ui\desktop
pnpm exec vitest run src/components/toolbox src/acp/toolbox.test.ts --maxWorkers=1
pnpm exec vitest run --maxWorkers=1
pnpm run typecheck
pnpm exec eslint "src/**/*.{ts,tsx}" --max-warnings 0 --no-warn-ignored
pnpm exec prettier --check src/components/toolbox/ToolboxView.tsx src/components/toolbox/ToolboxView.test.tsx
pnpm exec vite build --config vite.renderer.config.mts --outDir .vite/renderer/toolbox_acceptance
```
