# Serena runtime payload

The generated serena directory contains Serena's last MIT revision 74c38a65f03fc0764d7ee4b3016ef6a07572ed64 and its Python dependencies for the bundled Python interpreter. The upstream package identifies itself as 1.7.1.dev0. Preserve dependency license notices when distributing. Build a platform-specific payload before packaging. Never copy Windows native wheels into a macOS package.

简体：serena 目录为对应内置 Python 平台生成的工具依赖。保留上游许可，打包前按目标平台准备。
繁體：serena 目錄為對應內建 Python 平台產生的工具依賴。保留上游授權，封裝前按目標平台準備。

Windows source preparation uses scripts/prepare-serena-runtime.ps1 -SourceDirectory PATH with the verified source revision. The generated dependency directory is excluded from Git and included by the existing runtime/assets distribution copy.
