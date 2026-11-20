# Serena runtime payload

The generated serena directory contains Serena's last MIT revision 74c38a65f03fc0764d7ee4b3016ef6a07572ed64 and its Python dependencies for the bundled Python interpreter. The upstream package identifies itself as 1.7.1.dev0. Preserve dependency license notices when distributing. Build a platform-specific payload before packaging. Never copy Windows native wheels into a macOS package.

简体：serena 目录为对应内置 Python 平台生成的工具依赖。保留上游许可，打包前按目标平台准备。
繁體：serena 目錄為對應內建 Python 平台產生的工具依賴。保留上游授權，封裝前按目標平台準備。

Windows source preparation uses scripts/prepare-serena-runtime.ps1 -SourceDirectory PATH with the verified source revision. The generated dependency directory is excluded from Git and included by the existing runtime/assets distribution copy.

## 简体中文

在获得下载授权后，在目标系统上使用干净的固定版本源码运行：

```text
node scripts/prepare-serena-runtime.cjs SOURCE_DIRECTORY [INSTALLER]
```

Windows 默认使用已有的 `uv`，macOS 默认使用已有的 `pip3`；可通过第二个参数指定其路径。脚本只为项目内置 Python 安装依赖到 `runtime/assets/serena`，不修改系统 Python；目录已存在时停止，需先明确备份对象。检查源码 revision、MIT 许可证、Python 平台和安装版本后，写入载荷内的 `.codebuddy-runtime.json`。打包使用该文件核对本机平台与固定来源，并生成对应的平台清单，不修改共享源码。旧 Windows 载荷仍可使用原清单；缺少载荷或平台不匹配时，打包失败，不静默省略代码查询能力。

获得依赖下载授权后，再运行 `node scripts/prepare-pyright-runtime.cjs`，按 `pyright-runtime.json` 的固定版本和 SHA512 下载微软 Pyright 1.1.403（MIT）。该目录也不提交 Git。Python 符号查询通过 Serena 的 `ls_specific_settings.python.ls_base_cmd` 使用包内 Node 和语言服务；只更新 CodeBuddy 工具状态目录中的配置，不要求系统安装 uv、Node 或另一套 Python。其他语言服务不在这次 Python 载荷的覆盖范围内。缺少或替换了语言服务载荷会阻止打包。

## 繁體中文

獲得下載授權後，在目標系統上對乾淨的固定版本原始碼執行上述命令。Windows 預設使用現有 `uv`，macOS 使用現有 `pip3`，第二個參數可指定路徑。依賴只安裝到專案的 `runtime/assets/serena`，使用內建 Python，不變更系統 Python。目錄已存在時停止，先明確備份對象。驗證 revision、MIT 授權、Python 平台與安裝版本後，在載荷內寫入 `.codebuddy-runtime.json`。封裝核對原生平台與固定來源，產生平台清單而不改寫共用原始碼。舊 Windows 載荷仍相容原清單；載荷缺少或平台錯誤會阻止封裝。

取得依賴下載授權後，執行 `node scripts/prepare-pyright-runtime.cjs`，依 `pyright-runtime.json` 的固定版本與 SHA512 準備微軟 Pyright 1.1.403（MIT），不提交產生的目錄。Python 符號查詢使用 Serena 的 `ls_specific_settings.python.ls_base_cmd` 呼叫包內 Node 與語言服務；只更新 CodeBuddy 工具狀態目錄的設定，不要求系統安裝 uv、Node 或另一套 Python。其他語言服務不屬於此 Python 載荷的範圍。缺少或替換語言服務載荷會阻止封裝。

## English

After download approval, run the command above against a clean checkout of the pinned revision on the target host. It uses existing `uv` on Windows or `pip3` on macOS; the second argument can specify the installer path. Dependencies target the bundled Python and the project-local `runtime/assets/serena`, leaving system Python unchanged. An existing payload is preserved; explicitly back it up before replacement. After checking the source revision, MIT license, Python target and installed version, preparation writes `.codebuddy-runtime.json` inside the payload. Packaging verifies that native identity against the pinned source and writes the target manifest without editing shared source. Legacy Windows payloads remain compatible with the tracked manifest. Missing or incompatible payloads stop packaging instead of silently omitting code intelligence.

After dependency download approval, run `node scripts/prepare-pyright-runtime.cjs` to prepare Microsoft Pyright 1.1.403 (MIT), using the pinned version and SHA512 in `pyright-runtime.json`. Keep the generated directory out of Git. Python symbol queries use Serena's supported `ls_specific_settings.python.ls_base_cmd` with bundled Node and the language server. Only CodeBuddy's tool-state configuration is updated; system uv, Node and another Python are unnecessary. Other language servers are outside this Python payload's scope. Missing or substituted language-server payloads block packaging.
