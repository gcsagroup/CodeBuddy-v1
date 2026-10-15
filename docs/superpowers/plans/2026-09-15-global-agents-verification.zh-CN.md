# 全局与子目录 AGENTS.md 验证（2026-09-15）

隔离 Electron 窗口保存全局 `AGENTS.md` 后重新打开仍保留内容；已有项目 `AGENTS.md` 可被发现。只读分析实际调用 `read_document` 读取 `nested/readme.txt` 后，下一次模型请求的 system 消息依次包含 `GLOBAL_RED`、`PROJECT_BLUE`、`SUBDIR_GREEN`，各出现一次。工具仍受只读范围限制；同一工具 ID 的 SQLite 请求和回执均为 success，桌面工具卡显示“工具调用已完成”。

`D:\CodeBuddy`：子目录提示顺序、原有只读回归各 1/1 通过。新增回归先确认子目录后丢失产品身份（RED 0/1，exit 101）；明确保存本轮记忆与语言片段并重用项目附注、身份及分析规范后，集成测试 GREEN 1/1，合成记忆／语言／项目测试 1/1。严格 Clippy 和 CLI 构建 exit 0。`D:\CodeBuddy\ui\desktop`：前端全量 235 文件、2069 通过、4 跳过，exit 0；lint:check exit 0。最终二进制 SHA256：`0761DD644F327229B42F20246116A258F68FB508648C1E89EE21786B79662B0A`。

桌面验收使用 `D:\CodeProAcceptance\default-lan-onboarding-20260914` 内的隔离配置与本机脚本 provider；此前工具卡未知状态源于 provider 夹具跨回合重复 toolCallId，改为唯一 ID 后新回合显示 success，未修改产品 UI。最终隔离新会话的读取前和读取后 system 请求均保留产品身份、只读分析、报告规范、繁体语言和项目附注，子目录规则只在读取后加入。证据：`.cargo/evidence/audit-fixes-20260914/read-only-subdir-addenda-native-final.json`、`global-instructions-real-request.jsonl` 的 105–110 条；旧版 v2 记录保留供追溯。真实 LAN 模型 `192.168.9.120:8001` 已停止，完整模型理解验收仍为 `NOT_RUN`。
