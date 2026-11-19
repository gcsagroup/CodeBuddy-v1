# Windows 原生控件优化验收

主模型 deepseek-v4.1-flash:1017、思考强度 max 保持不变。CUA-S1-Qwen3.5-4B 继续通过 API 只识图，不调用操作工具。未打安装包、未提交、未推送。

## 改动与原因

- 字段视图原来在找到可写框后提前返回，丢掉已读取的正文、按钮和焦点，迫使主模型再次完整识图。现在保留完整控件上下文，写入仍使用快照绑定候选。
- 一次 full 观察原来会让后续每次动作都继续识图；现在同一 Windows 窗口的动作回执恢复控件优先，缺失视觉信息仍可显式 full。
- 修复自身编辑使窗口标题变化后无法保存：延续成功动作返回的同一 PID/HWND 精确标题，原用户范围不变；外部改名、输入冲突、换窗口不继承。
- 中间轮虽已正确保存、识图降到 0，主模型仍递归搜索文件。补充保存状态核验规则，避免已确认保存后再搜索用户目录。未降低模型或思考强度。

## 实测口径

每项旧版与最终版各一次固定对照；另有两项预先冻结、未提交给旧版的新任务。全部串行真实桌面运行。前后保持相同 UI 初始文本和字段值，隔离副本；最终记事本重跑通过 UI 恢复未保存内容，结果另核对实际保存时间和完整文本。执行秒为 Harness turn/start 至 turn/end；服务秒为后端接收至完成，包含准备，不含界面发送及渲染。

正确性由保存文件、原生表单事件和摘要文件独立判断，不把模型自述当 PASS。对照成功率与保留任务成功率均为小样本，不等于模型泛化准确率。旧版记事本保存成功后一次多余按键被标题范围拒绝，保留在调用记录；结果核对通过。

## 失败和限制

1. 最初记事本轮与原生测试争用桌面锁，计时无效；同时发现未保存标题阻断保存，已修复并单测。
2. 只给文件名的探索轮，主模型误把它当完整标题并尝试委派，已停止；没有把它计入成功。最终规则禁止通过委派绕过拒绝，但本轮未宣称解决全部文件名语义定位。
3. 中间版记事本 226.708 秒，正文保存正确，但重复磁盘搜索被停止；保留原始记录，不能算最终 PASS。
4. 旧式原生控件仍有状态未通过当前控件接口返回，最终工单保留必要识图；主模型的多步交互仍占主要剩余时间。本轮未覆盖所有 Windows 软件。

## 验证

原生 go test ./...：退出 0，34.451 秒；go vet ./...、go build：退出 0。宿主、路由、产物身份测试 20/20，路由集成 4/4；最终 skill 再测 3/3，全部退出 0。启动入口 .\start-preview.ps1。没有在桌面计时期间运行占用输入锁的原生回归。

控件视图的依据见 [Microsoft UI Automation tree](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-tree-overview)；复用现有控件读取，不新增依赖。

补充：新工单首次任务用了一次过期字段编号，被快照校验拒绝后重新读取并成功完成；57.716 秒包含这次恢复，不能称为零错误调用。当前识图仍用于回执未包含的复选框等状态，不代表这些控件在 Windows 层必然无法读取。主模型调用次数未整体下降（对照记事本 14→14、工单 16→18），剩余优化空间主要是操作选择和状态回读。

## Changed files / 改动文件

`tools/qwen-computer-use/main.go`, `observation_test.go`, `README{.zh-CN,.en,}.md`; `runtime/harness/skills/computer-use/SKILL.md`; `runtime/builtin-artifacts.mjs`, `runtime/tools/provenance.json` and rebuilt native binary. Existing unrelated dirty changes were preserved.

## Commands / 验证命令

```text
cd tools/qwen-computer-use
go test ./...
go vet ./...
go build -o ../../target/debug/qwen-computer-use.exe .
# repository root; installed Node 24
node --test runtime/harness/test/computer-skill.test.mjs runtime/tests/vision-routing.test.mjs runtime/tests/builtin-artifacts.test.mjs
node --test runtime/tests/vision-routing-harness.test.mjs
node --test runtime/harness/test/computer-skill.test.mjs
.\start-preview.ps1
```

All checks exited 0; the preview is a running development process, not an installer.

| Case | Execution s | Service s | Main calls | CUA calls | Result |
|---|---:|---:|---:|---:|---|
| before-notepad | 155.255 | 169.677 | 14 | 6 | PASS |
| after-notepad | 69.988 | 74.681 | 14 | 0 | PASS |
| before-native | 109.867 | 121.627 | 16 | 7 | PASS |
| after-native | 83.882 | 87.897 | 18 | 3 | PASS |
| holdout-notepad | 103.728 | 108.540 | 15 | 0 | PASS |
| holdout-native | 57.716 | 62.708 | 11 | 2 | PASS |

## Evidence / 证据

- `before-notepad`: `afe62e13-bef7-44cf-a401-e25d1b5514c1`; `before-notepad-verified.json` / `before-notepad-timings.json`.
- `after-notepad`: `b4fb1440-1c59-468c-b8bf-08acfac7a90a`; `after-notepad-verified.json` / `after-notepad-timings.json`.
- `before-native`: `177b5f97-0732-412b-b136-cc362974c813`; `before-native-verified.json` / `before-native-timings.json`.
- `after-native`: `a25f3a4b-d1e3-43c6-aa62-9dd4bf3aad2d`; `after-native-verified.json` / `after-native-timings.json`.
- `holdout-notepad`: `cd028729-efed-49cd-8845-a82403324cf1`; `holdout-notepad-verified.json` / `holdout-notepad-timings.json`.
- `holdout-native`: `86ff4dee-bf3f-4b74-b2ed-93c9bbcd0b6a`; `holdout-native-verified.json` / `holdout-native-timings.json`.

Source: `D:\CodeBuddy-v1`, main@4c8afad978b6e893a3545c0859dd5b4824a91223 with uncommitted changes. Native `0.2.3-local.22`, SHA256 `c83699118497c15d7bf09284142266d85e02116c436dcb219238bfb3737ef827`.

Artifacts: `.local/windows-controls-20261118/` (results.csv/json, comparison.png, accuracy.png, manifest.json, run-notes.json, logs and per-session receipts).
