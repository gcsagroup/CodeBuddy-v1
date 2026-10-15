# MCP 工具发现问题记录（2026-10-13）

[繁體中文](MCP_DISCOVERY_20261013_ZH_TW.md) · [English](MCP_DISCOVERY_20261013_EN.md)

## 实际复现

`http://192.168.9.120:8889/mcp` 握手成功，返回 150 个工具；这些工具均未声明 `readOnlyHint`。通过应用后端实际调用 `server_health`，返回 `healthy`。

使用隔离配置与实际桌面 ACP 后端测试：

| 操作 | 对话中的 HexStrike 工具数量 |
| --- | ---: |
| 先创建对话，再把扩展加入全局默认配置 | 0 |
| 添加扩展后新建对话 | 150 |
| 为原对话明确启用该扩展 | 150 |

另外，原 `search_available_extensions` 只搜索全局停用项，漏掉全局已启用但当前对话尚未加载的扩展；加载后也只列扩展名，没有工具清单。这是独立复现的同类问题，尚未锁定截图对应的具体会话。

## 修复范围

1. 扩展发现以当前对话的实际加载状态对照配置，包含尚未加载的默认启用项。
2. 现有只读发现工具同时返回已加载扩展的工具名称。工具清单与本轮可执行工具分开；不会把无标注工具当成只读，也不额外授予执行权限。
3. 只读分析工具加载器说明其列表是经过筛选的执行集合，查询 MCP 清单应使用扩展发现工具。
4. 扩展弹窗说明默认配置只用于新对话，以及已有对话的启用入口；测试连接不会自动加载到对话。前一项长错误导致布局溢出的修复继续保留。

## 验证状态

- 自动化：MCP 发现回归 1 项、只读分析 11 项、扩展弹窗 16 项通过；TypeScript、ESLint、i18n 编译/检查通过，命令退出码均为 0。
- 真实服务与桌面 ACP 后端：修复后的 `target/debug/goose.exe` 完成新增扩展、新旧对话加载、150 个工具名对照与 `server_health` 检查。
- 真实 Gemma 模型：已绑定隔离工作区的测试对话实际调用 `load_analysis_tools` 和 `extensionmanager__search_available_extensions`，两次工具调用均成功，回答正确列出 `hexstrike__server_health` 与 `hexstrike__execute_command`。未执行扫描或命令工具。
- 证据：`target/mcp-discovery-acp-i0gDma/result.json`、`responses.jsonl`，结果文件记录二进制 SHA256。
- 浏览器组件夹具在 1280×900、800×700、390×844 下通过布局、错误提示、底部按钮可达性验证。
- 完整 Electron 交互、Mac 真机及本批安装包尚未验收。测试夹具早期未绑定工作区的结果已作废，不计通过。

证据：原版本复现 `target/mcp-discovery-acp-DSeWKQ/result.json`；浏览器布局 `target/mcp-error-ui-20261013/browser-results.json`；编译与测试日志 `target/mcp-discovery-20261013/`。

## 合并与交付说明

- 当前 `main`，基线 `964bbeb1587f1c5551ee17907e0b26632c4163ce`，加未提交改动。
- 后端涉及 `crates/goose/src/agents/extension_manager.rs`、`platform_extensions/ext_manager.rs`、`analysis_tools.rs`。
- 前端涉及 `ui/desktop/src/components/settings/extensions/modal/ExtensionModal.tsx` 与语言资源。
- 不迁移配置，不自动为已有对话加载扩展，不修改权限规则。
- 尚未提交、推送或生成本批新安装包。源码变更不会自动更新 Windows/Mac 已安装程序。
- 浏览器组件夹具验收不等于完整 Electron 流程或 Mac 真机验收。

补充 UI 文件清单：新增 `ExtensionError.tsx`；修改 `ExtensionModal.tsx`、`ExtensionModal.test.tsx`、`EnvVarsSection.tsx`、`HeadersSection.tsx` 及 16 份语言资源。报错以醒目的摘要呈现，原始详情折叠并换行，弹窗正文滚动、底部按钮固定；原始 HTML 作为文本显示。

## 最终合并构建复测

包含 [Gemma 与合同修复](GEMMA_CONTRACT_20261013_ZH_CN.md) 的最终后端再次通过 ACP 联网测试，命令及二进制哈希见该文档。证据：`target/mcp-discovery-acp-DuSQFu/`。HexStrike 返回 150 个工具定义，旧对话加载前为 0、显式加载后为 150，新对话为 150；`server_health` 调用成功。Gemma 实际调用 `load_analysis_tools` 和 `extensionmanager: search available extensions`，两次工具回执均为 completed，随后准确报告 `server_health` 与 `execute_command`。未执行命令或扫描类工具，150 个定义不代表 150 个实际操作全部验收。
