# CodeBuddy 名称统一与兼容读取

## 范围

来源：main / c3a537517a464053d090bc1983bafeddd00a79df 加本次未提交修改。统一产品名称、窗口／菜单／托盘、模型身份提示、15 种语言资源、包与安装标识、环境变量、启动与验收脚本、源码标识符、文件名、文档路径和 GitHub 链接。保留 upstream goose、CodePro 工作模式和第三方项目名称。已有 Windows PTY 打包修复保留。

## 已批准的兼容方案

- 新安装默认使用 `.CodeBuddy`；如果新目录尚不存在而 `.CodeAgentPro` 已存在，直接使用原目录。显式设置的新 HOME 优先，不复制、搬动或删除原数据。
- 旧 `CODEAGENTPRO_` 启动变量作为兼容别名；新 `CODEBUDDY_` 值优先，空值仍按原校验规则处理。
- 系统凭据命名空间、设置 revision 字段、历史证据指纹和未完成清理的隔离目录格式保持稳定。旧标识符仅用于兼容读取已有数据，不作为界面品牌。
- 读取已有提示文件、迁移记录、旧产品深层链接和 ACP metadata；新界面及新发出的链接使用 CodeBuddy。保留已有自定义模型选择与地址，原项目已有的配置字段规范化机制继续执行。
- Windows 安装名称改为 `CodeBuddy-Setup.exe`；macOS 为 `CodeBuddy.app`，bundle ID 为 `local.codebuddy.desktop`。新 bundle ID 的系统权限需由系统重新确认。已有正式安装和此前生成的安装包均未就地修改。

## 验收与交付

本文件的提交状态记录验收完成时的情况；后续提交和推送以 Git 历史为准。

证据位于本机 `target/brand-*.log`、`target/brand-*.exit`，完整改名清单和修改前备份位于 `target/brand-rename-manifest.json` / `target/brand-rename-backup.zip`，不纳入 Git。本次尚未提交或推送；旧安装包不代表本次源码。

### 已执行检查

以下命令在本次修改所在目录执行。前端工作目录为 `ui/desktop`，Rust 工作目录为仓库根目录。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `pnpm run typecheck` | 最终源码复测退出码 0 | `brand-typecheck-final.log` |
| `pnpm run i18n:compile` / `pnpm run i18n:check` | 退出码 0；15 种语言、2728 个消息标识校验通过 | `brand-i18n.log` / `brand-i18n-check.log` |
| `pnpm run test:distribution` | 最终 51/51 通过，退出码 0 | `brand-distribution-final.log` |
| Vitest，限定存储、链接、凭据启动、图标与加载组件等 9 个相关文件 | 87 通过、4 跳过，退出码 0 | `brand-vitest.log` |
| 任务续接与清理恢复组件，限定 3 个相关文件 | 28/28 通过，退出码 0；协议字段稳定后其中 2 个文件再验 21/21 通过 | `brand-acp-vitest.log` / `brand-acp-wire-final.log` |
| `pnpm run test:macos-package` | 在 Windows 执行的打包逻辑测试 15/15 通过，退出码 0；不是 Mac 真机验收 | `brand-mac-package-tests.log` |
| `pnpm run build-goose-sdk` | 退出码 0 | `brand-sdk.log` |
| `cargo fmt --all -- --check` | 最终退出码 0 | `brand-format-final.log` |
| `cargo test -p goose --test codebuddy_storage_paths --jobs 1 --locked --offline` | 最终源码 5/5 通过，退出码 0 | `brand-rust-final.log` |
| 源码、文件名及 Word 文档完整性检查 | 117 个重命名目标存在；旧文件名清零；三份汇报 DOCX 的 XML 无旧品牌且 ZIP 校验正常 | `brand-source-audit.json` |

最初分发测试发现本机生成的 Windows shim 仍为旧文案，按新的已跟踪源码同步后复测通过。旧缓存仍保留，新增隔离测试验证旧缓存复用、新缓存优先且不下载。最初格式检查也已修正并复测。对应失败日志保留，最终状态以本表及桌面验收段列出的证据为准。

开发后端的另一套编译配置曾触发全量编译，该次构建已主动中止，退出码 1；它不计入通过结果。直接 CLI 构建首次因终端未加载 LLVM 定位配置退出 101；使用项目现有 `resolveWindowsBuildEnvironment()` 初始化 Windows SDK 后，相同默认 debug profile 下的 `cargo build -p goose-cli --bin goose --jobs 1 --locked --offline` 成功，退出码 0，证据为 `brand-cli-build-final.log`。新二进制执行 `goose.exe --version` 返回 `1.43.0`，退出码 0；这是上游后端版本，桌面包版本仍为 `1.43.2`。

### Windows 真实桌面验收

执行 `node target/brand-native-smoke.cjs`，通过项目正式的 `pnpm run start-gui` 启动当前源码及本次编译的后端，退出码 0。证据为 `target/brand-native-smoke-accepted.log`、`target/brand-native-7JRhw5/result.json` 与同目录 `desktop.png`。

隔离配置只建立旧 `.CodeAgentPro` 目录并使用旧启动变量，实际窗口标题与界面显示 CodeBuddy；应用继续使用旧目录，保留数据标记、模型选择和端点，未创建新数据目录。通过真实 Electron 工作区接口读取并保存文件成功。模型配置按原有机制规范化字段，验证的是配置值保留。前两次夹具分别因关闭标准输入、断言旧字段位置而中断，修正夹具后复验通过。

边界：本轮没有执行模型任务或微信发送；Mac 真机尚未复验，新 Windows／Mac 安装包尚未重新生成。本轮源码尚未提交或推送。

### 兼容格式细节

旧 ACP 字段名继续作为稳定的发出格式，读取端同时接受新名称；这避免新前端与已有后端的任务续接失配。源码中保留的旧名称只用于兼容字段、数据目录、凭据、历史指纹及其测试或说明。旧链接可被应用解析，不代表系统已为新安装重新注册旧协议。Windows 已有便携 Node 缓存继续按版本标记复用。
