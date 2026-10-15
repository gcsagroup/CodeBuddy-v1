# 常用查询工具实现与验收

> 2026-10-13 提交整理：本次纳入常用查询源码、回答预算修复和配套验收记录。下文“尚未提交”描述的是 2026-10-12 验收时状态。提交前重新执行前端组件测试（25 项通过）、cargo fmt --all --check 和 git diff --check（均退出 0）；前端复跑使用 Node 22.23.2 并有项目要求 Node 24 的警告，原 Node 24 验收记录见下文。后端回归与 Clippy 复用下列已完成记录；本日尝试复跑因触发依赖重编译而主动中止，不计为新通过。

[繁體中文](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_ZH_TW.md) · [简体中文](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_ZH_CN.md) · [English](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_EN.md)

来源：CodeBuddy main `50dfeb1be` 上的本批修改。状态：首版实现完成，Windows 开发版真实问答验收通过；尚未提交、推送或生成安装包。

## 天气查询回答中断修复

首轮验收没有覆盖用户随后发现的边界：会话 `20261012_2` 在 18:15 连续三次地点解析无结果，第四轮天气查询已成功，但旧聊天策略总共只允许四轮，第五轮生成答案前触发执行上限。这是查询执行器的收尾缺陷，不是上下文容量用完，也不证明天气接口失败。

修复沿用宿主 action budget：最多四轮查询，然后预留无工具回答；仅当模型在回答阶段请求工具而被拒绝时，再允许一次回答纠正，总上限六轮，不自动扩展。用户配置更低的上限仍优先。普通聊天进入预留回答时不发布“执行耗尽”；真正耗尽仍记录。开发任务的暂停与完成核验保持原行为。

地点服务无结果时给出覆盖范围说明；模型应避免无新证据的拼写／语言变体重试。查询已明确的上级城市可以作为参考，但必须说明是城市级结果，不能充当目标行政区的精确预报；不确定所属城市则追问。没有新增地名特判、自动坐标猜测或第二套调度器。

本次自动回归 34 项通过：执行器缺陷回放 1 项（含正常回答和拒绝工具后的纠正两种场景）、`action_budget` 20 项、`common_queries` 11 项、原只读任务收尾及明确禁止工具各 1 项。Clippy 退出 0。执行器回放使用真实本地时钟工具的三次参数错误加一次成功，验证通用查询调度、证据传递、落库及回答阶段不派发工具；它不充当天气联网或真实模型验收。日志：`target/common-query-budget-test.log`、`common-query-budget-policy-test.log`、`common-query-tools-regression.log`、`common-query-readonly-regression.log`、`common-query-no-tools-regression.log`、`common-query-budget-clippy.log`。首版通过仅指下方原有用例，不包含此后发现的边界。

新版后端构建完成，SHA-256：`b457e199d3cceb1450fbada591590ce5d5ffd3274bab18ce218627513ac86eba`。`cargo fmt --all --check` 退出 0。首次真实界面补测启动曾因另一个开发实例占用前端目录而报 EPERM；用户授权后正常关闭该窗口，以 README 的 `pnpm run start-gui` 成功重启隔离验收配置。

20:02–20:04，真实 Electron 会话 `20261012_4` 使用 `custom_1 / deepseek-v4-pro:0813` 完成两轮：原始“现在广州市天河区未来几天会不会下雨”问题走地点未找到 → 广州解析成功 → 天气成功，共 3 次工具调用，回答明确是城市级参考；上海三日降雨追问共 2 次调用，也完成回答。两次天气回执均为本轮 `cached=false, stale=false`，回答的降雨概率与原始数据逐项一致，执行上限事件为 0。这两轮验证实际查询与回答；四轮查询后收尾的强制边界由上述自动执行器回放验证。

旧会话 `20261012_2` 直接重问时模型复用了旧天气数据，该轮不计为新鲜查询通过；模型选择是否重查历史数据仍有局限。验收证据为 `target/common-query-acceptance/budget-fix-verified-results.json`、`20261012_4.json`、`budget-fix-final-ui.txt` 和同名截图；原故障保存在 `query-budget-original-repro.json`。本次尚未提交／推送，也未生成安装包。

## 行为

- 每次主模型请求重新取得主机时间，包括普通聊天及压缩／恢复后的请求。投影不写入历史；明确禁止工具的回合保持原有受限上下文。
- `time_now` 返回 UTC、当地时间、日期、星期、IANA 时区来源及采样时间，支持夏令时。时区不作为实际位置证据。
- `location_resolve` 返回城市／行政区候选及坐标。同名地点交由模型询问用户。
- `weather_get` 查询当前天气或含今天的 1–7 日预报；省略地点时使用已设置的默认查询城市，未设置就返回 `needs_location`。
- 普通聊天只开放这三种已启用的查询，沿原权限和回执机制派发，不开放工作区修改或桌面控制。语义分类器按问题目的选择聊天路径，没有新增关键词路由。

设置 → 常规 →“时间与天气”可以配置城市、两位国家代码、IANA 时区、摄氏／华氏及允许联网。设置沿现有 ACP config 边界保存，后端验证参数；每次工具调用重新读取。工具箱显示“常用查询”。没有 GPS／IP 自动定位或后台跟踪。

## 数据与失败处理

首版使用 [Open-Meteo API](https://open-meteo.com/en/docs) 及[城市解析 API](https://open-meteo.com/en/docs/geocoding-api)。[免费服务限非商业用途](https://open-meteo.com/en/terms)，商业发行需接入符合用途的付费方案／供应商。此版没有付费 API 凭据配置。

结果包含模型天气数据及原始单位、来源、数据有效时间与查询时间。缺值保留 null，不将查询时间称为观测时间。城市缓存 24 小时，天气缓存 5 分钟，最多 256 条；预报跨当地日期重新查询。刷新失败可以返回一小时内的旧天气，但保留 status=stale、原时间和刷新错误。关闭联网在读取缓存前生效。HTTP 请求限 12 秒，整个工具限 25 秒，取消即中止等待；429 记录 Retry-After 冷却时间，不立即重试。

时间与天气值由主机／供应商产生，模型负责理解、选择查询和解释结果，模型文字不是执行证据。远端后端留空时区时使用该主机时区，需明确设置显示时区。

## 验证与边界

验证记录在本机 `target/common-query-*.log` 和 `target/common-query-acceptance/`，不提交含设置或凭据的验收目录。自动化、实际供应商 API、桌面产品问答分别记录；Windows 成功不代表 macOS 原生验收通过。详细结果如下。

合并时包含 Rust 工具／注册／聊天上下文／语义分类、ACP 配置校验、桌面设置及语言文件；`chrono-tz` 已存在于锁文件，现在作为 goose 的直接依赖。旧设置缺失该字段时采用默认值，旧会话不迁移。

### 2026-10-12 实测结果

以下命令退出码均为 0；Rust 命令在仓库根目录执行，前端命令在 ui/desktop 执行，使用已有 Node 24.18.0、pnpm 11.9.0。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 工具与权限边界 | `cargo test --offline -p goose --lib common_queries --jobs 1` | 10 通过，联网用例另行执行 |
| 动态上下文／缓存 | `cargo test --offline -p goose --lib agents::moim --jobs 1` | 9 通过，含上行重叠的 1 项 |
| 注册表 | `cargo test --offline -p goose --lib platform_extensions::tool_registry --jobs 1` | 3 通过 |
| 语义分类合同 | `cargo test --offline -p goose --lib semantic_prompt_routes_read_only_capability_use_without_coder --jobs 1` | 1 通过 |
| 真实天气 API | `cargo test --offline -p goose --lib common_queries_live_provider --jobs 1 -- --ignored --nocapture` | 1 通过 |
| Rust 检查 | `cargo clippy --offline -p goose --lib --jobs 1 -- -D warnings`；`cargo fmt --all` | 通过 |
| 前端组件 | `pnpm run test:run src/components/settings/app/CommonQuerySettings.test.tsx src/components/toolbox/ToolboxView.test.tsx` | 25 通过／2 文件 |
| 前端质量 | `pnpm run typecheck`；`pnpm run i18n:check`；相关 TS 文件 ESLint | 通过，2742 个语言消息键 |

Windows 使用 `pnpm run start-gui` 启动本批源码，正常操作原生 Electron 设置和聊天界面，核对 ACP 导出的原始工具回执。模型为 `custom_1 / deepseek-v4-pro:0813`，隔离配置中的会话为 `20261012_1`、`20261012_2`。

- 新会话正确回答时间／日期／星期（17:08、2026-10-12、星期一）。未知地区先追问城市。
- 广州当前天气及三日预报：32.6°C，数据时间 17:00，回答保留来源及天气模型属性。
- 美国 Springfield 返回多个候选后追问，没有擅选城市查天气。
- 默认城市、国家、时区、华氏设置保存后刷新页面仍保留；新会话省略城市／单位，返回广州 90.3°F，并说明是默认设置而非定位。
- 关闭联网后天气返回 `network_disabled`，没有把缓存当成新数据；纽约时钟仍返回 UTC−04:00。
- 明确禁止工具的回合导出记录为零调用。重新启用联网、切回摄氏后，广州／上海比较返回各自温度、数据时间与来源。
- 界面“立即压缩”完成后再次问时间，回答刷新至 17:41，正确保留刚才比较广州／上海的上下文。

证据位于 `target/common-query-acceptance/`，包括会话 JSON、可见文字、截图与 `verified-results.json`。后端 SHA-256：`68ad7724c89b9b161d790cb224572f7787e436e08f04ac577c430649b6f5786f`。天气数字仅代表验收时刻。

未验收：Mac 真机、完整应用重启、长任务中途查询、安装包。本版未接付费天气源、系统／IP 自动定位、远程客户端时区自动传递；远程后端需显式设置显示时区。免费服务只适用于非商业用途，商业发布前需处理供应商接入与授权。这些限制不计为已完成。
