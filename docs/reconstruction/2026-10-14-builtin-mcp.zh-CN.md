# 内置工具通过 Harness MCP 接入

本批在 `D:\CodeBuddy-v1` 增加 `runtime/builtin-extensions.mjs`，保持 renderer 冻结。没有创建分支、提交或推送；此目录没有 Git 仓库。模型推理、会话、调度和工具许可仍由新版 Harness 及兼容层负责。旧程序只使用固定的独立 stdio MCP 入口，没有启动旧 Agent、旧 ACP server 或旧调度器。

## 接入合同

`builtinMcp(extension,{cwd,dataDir})` 与 `toTestExtension(...)` 为异步函数：对下列 `type: builtin` 返回官方 `dsh-mcp-client` 配置，对其他类型返回 `undefined`。`isBuiltinMcp` 检查是否属于本模块；`builtinToolNames(name)` 提供已核实固定产物的原工具名称。`listAvailableBuiltins()` 返回 `{configKey,enabled:false,available,reason?,extension}`，可用性只证明平台及文件校验，真实连接仍调用 `driver.testExtension`。

| 原界面扩展 | 固定入口 | 本批真实发现 |
| --- | --- | --- |
| `qwen_computer` | `qwen-computer-use.exe --foreground-input mcp` | 9 项：click、drag、get_app_state、list_apps、perform_secondary_action、press_key、scroll、set_value、type_text |
| `computercontroller` | `goose.exe mcp computercontroller` | 5 项：cache、docx_tool、pdf_tool、web_scrape、xlsx_tool |
| `autovisualiser` | `goose.exe mcp autovisualiser` | 8 项：render_chord、render_donut、render_map、render_mermaid、render_radar、render_sankey、render_treemap、show_chart |

模型使用的工具名为 `mcp__<扩展名>__<工具名>`，权限、启停、工具白名单由会话兼容层统一消费。扩展参数中附加的 command/args/env 不会改变内置固定入口。首次使用和文件身份变化时核对 SHA256，文件大小、身份及修改时间变化后重新检查。

## 目录与来源

两个文件均从原项目 `D:\Users\jiangrui\Desktop\CodeBuddy\ui\desktop\src\bin` 复制到新版 `runtime/tools/bin`，复制前后核对 SHA256。完整来源、时间、大小和许可证哈希见 `runtime/tools/provenance.json`。

- `goose.exe`：331,956,224 字节，SHA256 `8186e7eb25a45e93d4ba29a4b56a1230985a30d5a9b8a7843f571a683f1d8b13`。原 workspace 与根 LICENSE 声明 Apache-2.0，完整文本位于 `runtime/tools/licenses/goose-Apache-2.0.txt`。
- `qwen-computer-use.exe`：4,736,000 字节，SHA256 `5b08525ee3825d611a4ef643badbdf15dd55e95816e4f5f15fd06dbe30c5f9b8`。源目录包含 MIT 许可证，完整文本位于 `runtime/tools/licenses/qwen-computer-use-MIT.txt`。

这些是原项目已有工具产物，本批没有重新编译。源基线 revision 为 `964bbeb1587f1c5551ee17907e0b26632c4163ce` 并包含未提交改动；现有二进制与该源码的可重现构建对应尚未验证。上述宽松许可证允许以保留许可证及通知的方式复用工具；正式安装包仍需完成传递依赖的第三方通知清单。条款参考：[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)、[MIT](https://opensource.org/license/mit)。

旧 CLI 的日志、项目记录、用户配置、缓存及临时目录通过子进程环境指向 `dataDir/tool-runtime/<扩展名>`，不改宿主环境。`CODEBUDDY_HOME`、旧路径别名、HOME、USERPROFILE、APPDATA、LOCALAPPDATA、TEMP/TMP 和 XDG 路径均隔离。已关闭旧工具遥测。工具明确要求保存的文档仍写到工作区或用户指定输出位置；这些环境设置不是文件系统沙箱。

电脑动作保留原工具语义：`--foreground-input` 让输入前恢复已观察目标窗口，原 `OPEN_COMPUTER_USE_*` 配置保持继承。本批没有额外强制关闭启动、焦点或文字回退能力。单纯 initialize/tools/list 不派发桌面动作。

## 验证与边界

`node --test runtime/tests/builtin-extensions.test.mjs` 使用既有 Node.js 24，3 项通过、0 失败、退出码 0。临时目录测试包括产物/平台校验、固定命令、环境隔离及父进程环境不变；官方 Harness 实际启动 3 个服务，发现 22 个工具，并验证旧 CLI 日志和文档/图表缓存位于隔离目录。没有执行 tools/call，没有点击、键盘输入或关闭用户进程。

目前只包含 Windows x64 产物；macOS 明确报告待提供对应产物。此记录不代表文档编辑、电脑操作、真实模型或完整桌面 E2E 已通过，后续调用验证由主集成批次另记。
