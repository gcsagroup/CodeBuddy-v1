# 旧资料的离线迁移

本批源码为 `D:\CodeBuddy-v1` 当前文件，基线见 `source-baseline.json`；没有创建分支、提交或推送。原项目和旧用户资料仅作读取。实现位于 `runtime/legacy-migration.mjs`、`runtime/profile-lock.mjs`，入口为 `scripts/migrate-legacy-profile.mjs`。

## 使用和集成

先运行只读清单：`node scripts/migrate-legacy-profile.mjs --source <旧profile绝对路径> --target <新版backend绝对路径>`。写入必须另外提供 `--apply --offline`，并先关闭目标新版。迁移与服务端共用 `acquireProfileLock(dataDir)` 的 SQLite 独占事务；进程退出自动释放。迁移还检查旧启动回执中进程是否存活，以覆盖尚未采用锁的预览版本。`--offline` 不会绕过存活进程或锁检查。

`inspectLegacyProfile` 返回数量和兼容边界，不打印聊天正文或配置值。`migrateLegacyProfile` 使用 Node 内置 SQLite backup 生成独立一致快照，并执行 quick_check。原库及 WAL 通过只读连接读取。只向 state.json 添加原 UI 可见的 user/code_pro 会话元数据，带 `readonlyHistory:true` 与 `legacyHistory:{archiveId,sessionId}`。消息保留在 `legacy/<archiveId>/sessions.db`；`loadLegacyConversation(dataDir,reference)` 按需读取一个会话，复用已有历史校验及 UI 投影器。隐藏/子 Agent 会话仍保留于归档，未加入原 UI 列表；旧执行和权限不会恢复。

配置仅补缺失项，保留新版默认模型、已有提供商和凭据。可兼容的自定义提供商定义迁入后，旧钥匙串密钥需要重新填写；既有明文自定义 header 通过新版凭据保护保存。新增 MCP 配置默认停用；未知旧内置扩展明确列出。旧日程由现有 ScheduleService 创建，全部暂停、未验证，清空运行标记和旧运行会话，不重放任务。

记忆原文件完整保留于归档。旧项目标识采用 Blake3，新版采用 Harness 存储域；未确认映射时不猜项目归属。通过 `--project-map <JSON文件>` 提供 `{ "旧32位identity": "项目绝对目录" }` 后，经 ProjectMemory 与官方 driver.memory 迁入项目记忆，保留 active/candidate/disabled、有效期和置信度。原 user 范围记录单独列出待审，不扩展新版项目边界。已导入记录采用稳定 ID，重跑跳过；跨模块中途退出可以再次执行，报告明确未处理项，没有宣称跨文件原子回滚。

## 验证

`node --test runtime/tests/legacy-migration.test.mjs`：10 项通过，退出码 0。使用真实隔离 SQLite/WAL、临时目录、原 DTO 投影和官方 Harness 记忆重启，覆盖只读清单、快照独立、按需读取、新版配置保留、凭据落盘保护、日程暂停、记忆映射/状态、幂等重跑、进程锁及进程退出释放、源/目标重叠和符号链接拒绝。

真实服务端 WebSocket ACP 回归另外确认 load/export 按需读取、旧隐藏消息不投影、state 不回写正文，历史查看无 Agent 执行调用；prompt 拒绝恢复旧任务。运行中服务拒绝迁入，关闭后幂等重跑成功。

对 `C:\Users\jiangrui\.CodeAgentPro\profiles\local` 实际执行的是 dry-run，退出码 0：789 个会话，原 UI 可见 616 个；22021 条消息，数据库 235692032 字节；9 个自定义提供商、24 个扩展配置、11 份记忆文件共 14 条记录、1 个日程。本批没有执行用户资料 apply，也没有完成桌面历史查看验收。未映射记忆、旧密钥和不支持的旧扩展需根据迁移报告处理。

后续只读身份匹配已完成：`runtime/legacy-memory-mapping.mjs` 按旧 Rust 的 canonical 路径（含 Windows `\\?\` 前缀）、斜杠转化、小写及 Blake3 前 32 位规则，从原 projects.json 与 session working_dir 中匹配全部 11 个身份。5 个目录仍存在，共 3 条可迁入记录；其余 6 个目录已删除，共 11 条保留归档和已核对的历史路径。报告与可用映射分别位于 `.preview-data/validation/legacy-memory-mapping-report.json`、`legacy-memory-project-map.json`。新增 2 项格式和匹配测试通过，退出码 0；只读报告不含记忆正文。

参考：[SQLite Online Backup API](https://www.sqlite.org/backup.html)、[Node SQLite API](https://nodejs.org/api/sqlite.html)、[noble-hashes](https://github.com/paulmillr/noble-hashes)。复用既有 Node 24 SQLite、YAML、凭据保护和 Harness。单次身份核对在独立临时目录获取 `@noble/hashes` 2.0.1（MIT），核验固定 npm SHA512 与 Blake3 空串标准向量，不执行包脚本；产品依赖与锁文件没有变更。
