# 多项目工作区

新建对话选择工作区时，通过创建弹窗添加多个本地文件夹。第一个是主目录，创建前可改选；名称默认跟随主目录，也可自定义。其余目录可填写说明并选择允许修改或仅供参考。移除只解除关联，不删除文件。

侧栏项目悬浮卡展示所有目录、主目录和只读标记，并提供编辑入口。编辑可调整名称、关联目录、说明和访问方式。已有对话保持原主目录和目录快照，新对话采用修改后的配置。主目录作为现有项目身份，保存后不通过编辑器改名或迁移磁盘目录。

## 权威与边界

- `WorkspaceService` 持有目录成员、访问方式、版本及真实目录身份。Compat 创建会话时保存 `projectFoldersSnapshot`，旧会话在首次使用或工作区修改前冻结当前配置。前端不决定执行权限。
- 文件工具与终端消费相同目录配置；子任务通过已验证的原生父子关系继承根会话快照。目录失效或替换时报错，不自动换目录。
- 含仅参考目录时不能启用完全访问。权限菜单提示限制，Compat 限制可用模式，执行入口拒绝绕过。工具审批不解除该限制。
- Windows 复用锁定 Harness 的 ACL、受限令牌、Job 和控制管道。多目录使用随目录组合变化的 capability SID，避免旧授权被新组合复用。继续保留原生沙箱的 partial enforcement 标记，不承诺完整隔离网络或外部 MCP。
- macOS Seatbelt 增加关联写目录及参考目录显式写拒绝；Bubblewrap 增加对应挂载。其他无法表达多目录策略的 runner 拒绝启动，不能退回无沙箱。跨平台真实验收须分别执行。

## 参考与验证

参考 [Codex Projects](https://learn.chatgpt.com/docs/projects) 的多文件夹、主目录与可复用项目交互，以及 [Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/utils/cli/src/shared_options.rs) 的 cwd 与额外目录分离。仅借鉴公开设计，不复制实现或推断私有权限机制；未新增依赖。

回归：`runtime/tests/project-folders.test.mjs`、`multi-project-sandbox.test.mjs`，桌面 `ProjectCreator.test.tsx`、`NavigationPanel.test.tsx`、`SessionPermissionSummary.test.tsx`。真实验收使用当前源码与独立 profile；组件测试不能替代桌面及模型工具回执。
