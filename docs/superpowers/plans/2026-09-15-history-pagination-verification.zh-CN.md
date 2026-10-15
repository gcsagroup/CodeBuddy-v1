# 历史分页与搜索限定验收

本轮未改产品逻辑，新增 3 项组件回归测试；相关 3 文件 23 项测试全部通过，TypeScript、ESLint、Prettier 均 exit 0。既有后端 history 11 项通过，未重复编译 Rust。

隔离 Electron 与真实 ACP 使用 105 条测试数据。逐张原生截图确认 105 条及 50/50/5 边界；切换关键词得到 Beta 50 条、Alpha 55 条；清空后可见原先不符合关键词的记录。打开 B-105、返回搜索 A-055 并打开正文成功；刷新后 Alpha 仍为 55 条。原有 8 条隔离会话数据哈希未变，验收窗口已关闭，启动器 exit 0。

原生切词未强制制造晚到传输；过期分页、旧关键词及工作区模式结果的隔离由 deferred promise 组件测试证明。滚动后 UIA 文字缓存未更新，所以分页证据采用实际截图。历史为全局列表，workspaceMode 是类型筛选，不是项目路径筛选。项目/日期筛选及归档/批量管理仍待后续审计。真实模型 NOT_RUN；未探测 120 或 107。

Evidence: `D:/CodeBuddy/.cargo/evidence/audit-fixes-20260914/history-pagination-native-summary.json`, `history-pagination-native-scan.json`, `history-pagination-focused.log`, `history-existing-preserved.json`.

Command (cwd `D:/CodeBuddy/ui/desktop`):

```text
pnpm exec vitest run src/components/sessions/SessionListView.search.test.tsx src/components/sessions/SessionListView.capabilities.test.tsx src/acp/__tests__/sessions.test.ts --maxWorkers=1
```
