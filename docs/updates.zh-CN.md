# 应用内更新

[繁體中文](updates.zh-TW.md) · [English](updates.en.md)

## 用户流程

1. 安装支持更新的版本（本批交付目标为 1.43.13）。旧版 1.43.9 关闭了更新入口，首次需要手动覆盖安装；1.43.12 仅作内部升级夹具。
2. 在账号设置连接自己的 GitHub 账号，该账号需要读取私有仓库 `erjinyi-bool/CodeBuddy-v1` 的权限。
3. 在常规设置的更新区选择正式版或预览版，点击检查、下载，再点击重启更新。正式版频道忽略 GitHub 的预发布版本。
4. 保存编辑中的文件，结束任务并关闭终端后重启。更新只替换应用，沿用原安装路径、数据目录、聊天、配置与工作区。不要先卸载或删除数据目录。

检查和下载复用本机 GitHub CLI 登录，凭据只在主进程内短暂使用；不写入更新清单、安装包、日志或渲染界面，也不使用 GitHub MCP Token。账号变更后应重新检查更新。下载中断可重试，首版不支持断点续传。

## 发布合同

Windows 使用当前 Inno EXE；Mac 使用由同一签名身份签名的 `.app` ZIP。DMG 仍用于首次安装，不能作为自动更新载荷。Apple Development 仅用于此次内部验证；正式站外分发需 Developer ID Application 与公证。Intel 需要单独的 x64 构建，arm64 包不会发给 Intel 设备。

每次更新必须增加 `ui/desktop/package.json` 的语义版本。发布标签使用 `codebuddy-<版本>` 或 `codebuddy-<版本>-<批次>`。同一 Release 上传平台包和 `codebuddy-update.json`，通过已有 Node 生成清单：

```text
node scripts/create-update-manifest.cjs 1.43.13 codebuddy-update.json win32:x64:CodeBuddy-1.43.13.exe darwin:arm64:CodeBuddy-1.43.13.zip
```

先保持草稿，完整上传并核对远端文件大小与 SHA-256 后再发布。缺少清单的历史 Release 不参与更新；替换已发布包应使用新版本和新 Release。预览测试发布为 prerelease，正式验收后才发布正式频道。仓库凭据和共享模型 Key 都不放入安装包。

Electron 主进程负责账号核验、版本、下载和完整性状态；Harness 拒绝在请求或任务执行中关闭，先持久化再退出。Windows 由等待原进程退出的助手调用 Inno，并确认安装版本；Mac 由 Electron/Squirrel 校验签名并替换应用。下载取消不会安装，安装前再次校验缓存。Windows 失败详情保存在 Electron 数据目录的 `updates` 下；下次启动显示失败提示。首版没有自动降级/业务数据迁移回滚机制。

实现、自动化测试与真实升级验收应分别记录；组件通过不代表旧版安装升级已经通过。验收需比较升级前后的聊天、配置及加密凭据，并确认实际运行版本和资源来自本批构建。

参考：[Electron 更新](https://www.electronjs.org/docs/latest/tutorial/updates)、[Inno 安装参数](https://jrsoftware.org/ishelp/topic_setupcmdline.htm)、[Apple 本机网络 ATS](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)。沿用已有组件，没有引入新的更新框架。

Windows 更新助手会先确认自身启动，再确认接手安装，应用收到回执后才退出。早期内部预览存在助手启动缺陷，已撤回；这些版本需要手动覆盖安装本版。验收使用含助手修复的内部 1.43.12 夹具升级到 1.43.13。Mac 自动升级验收按用户要求暂停，本批更新清单仅发布 Windows x64。

使用前需安装 GitHub CLI，并使用有仓库读取权限的个人账号登录。Windows 更新助手使用系统 PowerShell 自带模块，避免继承 PowerShell 7 模块路径导致校验失败；助手在应用退出前验证安装包，在安装前再次校验。
