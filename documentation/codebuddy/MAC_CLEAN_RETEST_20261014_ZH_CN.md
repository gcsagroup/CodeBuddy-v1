# Mac 清理、重新安装与电脑控制重测（2026-10-14）

## 授权与范围

用户明确要求删除远程 Mac 内 CodeBuddy、旧 CodeAgentPro 的全部相关内容后重新安装测试，并在澄清源码、文档、备份和钥匙串范围后再次确认全部清除。目标为 `erjinyi@192.168.9.106`，macOS 27.0.1 / arm64。Windows 仓库、Mac 上其他应用和项目、共享目录、系统统一日志及系统备份未清除。

## 已完成

- 按精确清单清理 42 个路径：29 个用户安装副本所在路径、专属配置/缓存/会话/日志、默认测试工作区、桌面及废纸篓旧包、验收夹具，以及 `/Users/erjinyi/Desktop/work/CodeBuddy-macos-20261001` 源码/Git/构建/备份目录。没有按名字对整盘批量删除。
- 停止所属进程，卸载两个安装盘。对 `local.codebuddy.desktop`、`local.codeagentpro.desktop` 执行 `tccutil reset All`，退出 0；清除各自偏好及 Dock 最近应用项，注销旧 LaunchServices 记录。删除后补查并清除 31 条残留主应用/helper 注册，最终残留为 0。
- 删除精确钥匙串条目：`codeagentpro / secrets`、`CodeBuddy Safe Storage / CodeBuddy Key`、`CodeAgentPro Safe Storage / CodeAgentPro Key`，均退出 0；未读取密钥值。首次启动后仅新建 CodeBuddy Safe Storage；`goose / secrets`、旧模型凭据及旧 CodeAgentPro Safe Storage 均不存在。
- 删除前将新候选包和验证记录保存到 Windows。Mac 空白状态：旧文件存在性查询为 0、旧进程为 0、安装盘为 0、两代默认资料目录不存在。系统可用空间约从 174 GiB 增至 261 GiB；这不是安全擦除或系统级全部痕迹清除声明。
- 从候选 DMG 安装到 `/Applications/CodeBuddy.app`，严格签名验证、安装前后四个关键文件哈希一致，退出 0。安装盘退出并删除传入的 DMG；Mac 仅保留新安装及其新建数据。
- 13:08 首次启动：主进程 PID `73796`、后端 PID `73800`，执行文件均来自新安装。日志为 `~/.CodeBuddy/state/electron-app/logs/main.log`，包含 `storageDecision: InitializeNew` 和 `React ready event received`。新数据库会话数为 0，界面显示没有最近聊天；旧 `~/.CodeAgentPro` 和远程源码目录不存在。

## 构建来源与验证

Windows：`main / 964bbeb1587f1c5551ee17907e0b26632c4163ce + dirty`；远程既有 Git 基底：`c3a537517a464053d090bc1983bafeddd00a79df + dirty`。清理前 2054 个构建输入逐文件归一化哈希一致。沿用原构建环境 Node 24.10.0 / pnpm 11.9.0，复用已交付 release 后端，重新构建 Go/Swift 电脑控制层及桌面包；未重复构建 Rust，未安装依赖。

| 命令/检查 | 结果 |
| --- | --- |
| `node --test scripts/macos-package.test.cjs` | 15 通过，退出 0 |
| `pnpm run bundle:mac --arch arm64 --backend <既有 release/goose>` | 退出 0；内含 Go 测试、Swift 合同测试、原生编译、签名及 DMG 校验 |
| `pnpm run test:macos-install` | 安装冒烟通过，退出 0 |
| 清理、残留注销、新包安装 | 退出 0；见逐项回执 |
| 新安装真实启动、空白资料 | 已核实界面、进程、日志和数据库 |
| Kimi K3 观察/识图、焦点/输入、权限恢复 | 未执行完成，待解锁及重新配置模型 |

首次构建 SSH 包装器在三阶段成功后因输入末尾 CR 返回 1；三阶段独立退出码均为 0。清理脚本先遇到注销后 bundle ID 无法解析，以及对已注销路径重复注销，均在删除阶段之前停止；调整为先重置权限、再只注销仍注册项后，清理完整退出 0。保留原始失败记录，未将其写成产品测试失败。

候选版本为 1.43.2 / arm64 / ad-hoc，未公证。DMG SHA256：`6d4f51e36b221da6501f239e731dfef2f5cc7370acc66df19cf5be0f51189c30`。安装后 goose SHA256：`fdabb89890c7a00ac36e04735ea08c29f98b35dd431aac8b3582b1149538af49`；原生运行层 SHA256：`4e2b259f1f0c630ca8e0196c579b020b372b1bfa0c5c87002a561daa0e995187`。

## 当前阻塞与续测

13:10 系统明确返回 `CGSSessionScreenIsLocked=Yes`，RustDesk 画面停留在 13:08。停止 UI 操作并请用户解锁；旧画面不作为后续验收依据。旧模型密钥已删除，需用户在应用内重新配置 Ollama，真实模型统一使用 `kimi-k3`。系统隐私授权及登录密码由用户亲自处理。

续测顺序：确认画面实时 → 配置 Ollama/Kimi K3 → 从唯一安装路径请求观察 → 核对新录屏/辅助功能授权 → 独立只读窗口观察 → 独立夹具焦点/输入 → 缺权限恢复。未发送任何外部消息；当前不得宣称电脑控制产品 E2E 通过。

本轮无产品源码修改、无提交或推送。清单、日志、阶段退出码、哈希与候选包：`target/mac-clean-retest-20261014/`（仅本地，不提交）。
