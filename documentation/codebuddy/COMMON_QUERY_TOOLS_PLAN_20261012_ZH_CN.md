# CodeBuddy 常用查询工具设计方案

实施更新：首版已开发并完成 Windows 开发版问答验收，详见[实现与验收记录](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_ZH_CN.md)。以下保留最初提案及其当时状态。

日期：2026-10-12。状态：研究与设计提案，尚未实现、未宣称验收通过。
本机基准：main `c3a537517` 加现有未提交修改。本次只新增方案文档。

## 建议结论

沿用 CodeBuddy 的 goose 平台工具注册、模型调用、权限与回执机制。首版内置时间、城市解析、天气查询；已有搜索作补充。模型决定需要哪些数据，宿主验证参数并取得真实结果。使用直接本机／HTTP 接口减少部署步骤；需要扩展时再增加 MCP adapter，同一能力避免重复暴露。

## 公开方案比较

| 对象 | 已核实的公开设计 | 本案采用方式 |
| --- | --- | --- |
| Codex 开源 core | clock.curr_time 有 schema、UTC 返回和宿主 time provider；工具组装也接内置、动态工具与 MCP | 轻量时钟工具；统一注册和执行 |
| Claude API | 模型产生结构化 client tool 调用，应用执行并返回结果；server tool 由 Anthropic 执行。官方以 get_weather 示范 | CodeBuddy 自己执行，适配可用模型，天气数据由供应商 API 提供 |
| Hermes Agent | registry 登记 schema、handler、可用性检查及 toolset；大量工具可按需加载，但会增加首次调用往返 | 少量高频工具直接提供；扩展工具沿用已有发现机制 |

这是公开源码／API 设计，不代表已知 Claude 桌面内部实现或所有版本均提供相同工具。Hermes 文档中的 weather 是教学示例，不作为已出货天气工具的证明。Codex 为 Apache-2.0，Hermes 为 MIT；参考模式，避免搬入整套 runtime。引用代码须保留适用声明。项目目前 Apache-2.0，天气服务与数据授权另行确认。

## 当前缺口

现有 `platform_extensions/mod.rs`、`tool_registry.rs`、`extension_manager.rs` 已具备注册、schema、ReadOnly 权限、网络属性及回执。`agents/moim.rs` 已产生带 UTC offset 的时间，但 `agent.rs` 的 conversation_only 路径跳过上下文、清空工具并要求直接回答。单独接入工具仍不足：普通聊天也要支持有限的常用只读查询，并保留用户明确禁止工具的语义。查时间由主 Agent 完成，无需开发计划、子 Agent、项目扫描或桌面操作。

## 首版范围

| 能力 | 建议工具 | 数据来源 |
| --- | --- | --- |
| 时间、日期、星期、指定时区 | time_now(timezone?) | 本机时钟；返回 UTC、当地时间、offset、时区来源 |
| 城市、行政区及坐标 | location_resolve(query) | 地理编码 API；同名候选供选择 |
| 当前天气、温度、体感、降雨及短期预报 | weather_get(location?, query_kind, units?, days?) | 指定天气供应商；地点已明确时直接查一次 |
| 日期计算、单位换算 | 首期沿用已有计算能力 | 有实际错误证据再添加确定性工具 |
| 新闻、营业时间等长尾问题 | 已有搜索 | 来源可追溯，尊重联网设置 |

每轮模型请求前刷新时间，放在动态上下文尾部，明示取样时间和来源，避免每秒改动稳定 system prompt。恢复和压缩后重新取得。精确到秒或长任务中刷新时调用 time_now。后端在另一台主机时，以桌面客户端时区为准。

## 位置与隐私

本轮明确城市优先；未指定时可使用已确认的默认查询城市，回答标明城市。“默认查询城市”不等于“目前所在位置”。询问实际所在地时，使用获授权的系统定位或请用户提供城市；系统时区不作为城市证据。

首版默认手动选择城市。系统定位另做 Windows／Mac 权限及拒绝验收。IP 定位只作可选粗略候选，VPN／代理可能使其偏离。不为普通问答持续取得或保存精确坐标；保存位置偏好遵守已有记忆确认规则。

## 天气供应商

- Open-Meteo 可用于隔离原型。免费端点限定非商业使用且无 uptime 保证；商用需相应方案及 attribution。current conditions 基于 15 分钟天气模型数据，不称为现场传感器读值。服务代码 AGPLv3，数据 CC BY 4.0；本案只串 API。
- QWeather 提供城市解析和结构化当前天气，可作正式供应商候选；需账号凭据并核对服务用途与额度。
- 一个小型 weather provider interface，首版只实现一个 adapter。依据国内／海外网络、覆盖、条款和新鲜度实测选型；目前没有供应商速度或准确性验收结论。

## 调用与结果规则

少量工具直接提供给支持 tool use 的主模型；模型理解语义，避免关键字流程。只读联网查询遵循网络设置；明确禁止工具时不调用，禁止读取设备信息也需尊重。模型不支持工具时提示能力限制，不偷偷换终端或桌面。

weather_get 可在城市唯一时由宿主完成解析，减少模型往返；有歧义返回 needs_location。独立城市可并行查询。供应商故障时只使用已设置、可用的备援；搜索结果标记为搜索来源。

结果包含 status、location、location_source、timezone、数值与单位、provider、fetched_at、供应商若提供的 valid_at/observed_at、cached、stale 与来源链接。无数据时间则保留 unknown，查询时间不充当观测时间。错误包括 needs_location、network_disabled、provider_unavailable、rate_limited、permission_denied；不把缺值写成 0，不猜天气。

初始建议缓存：天气 5 分钟、城市解析 24 小时，属于待测参数。按供应商、坐标、单位、语言、查询类型及日期区间分键，遵守供应商条款。过期后刷新失败须标记旧数据时间；时间不缓存。设总超时及有限重试，429 按 Retry-After，不无限切换。

## 界面和实施

工具箱增加“常用查询”，设置包含默认城市、单位、供应商、凭据和定位选项；凭据沿用现有安全存储，密钥不进入模型或日志。聊天沿用紧凑活动行，结果附城市、时间和来源。

1. 修补全模式时间上下文，加入可测试时钟来源和 time_now。
2. 建立受限聊天查询能力，接一个天气供应商、城市解析和设置；复用权限、注册与 Agent loop。
3. Windows／Mac 真实问答验收后，再根据错误证据扩展定位和其他工具。

## 验收

- 自动化覆盖跨午夜、时区／夏令时、压缩和恢复后刷新、同名城市、单位、缺值、超时、429、断网、缓存过期、禁止工具或定位。
- 真产品覆盖新／旧会话、任务中、重启后问时间；指定城市／未知地区天气，多城市比较，错误候选、服务故障、切换城市和单位、明确禁止工具。
- Windows／Mac 分别执行，记录模型、原始调用、来源、数据时间和耗时；至少一个可用主模型验证工具调用，其他模型单独报告兼容性。
- 温度不与另一网站逐字比对：核对城市、时间、单位、供应商和数据类型。先测端到端延迟与模型往返数，再调整缓存／并行；不承诺未测秒数。

## 参考来源

- [Codex 时钟](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/current_time.rs)与[工具组装](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs)
- [Claude 官方工具机制与天气示例](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- [Hermes 新增工具](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-tools)与[按需工具探索](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search)
- [Open-Meteo API](https://open-meteo.com/en/docs)与[服务授权](https://open-meteo.com/en/pricing)
- [QWeather 当前天气](https://dev.qweather.com/en/docs/api/weather/weather-current/)与[城市解析](https://dev.qweather.com/en/docs/api/geoapi/city-lookup/)
- [Codex 授权](https://github.com/openai/codex/blob/main/LICENSE)、[Hermes 授权](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)
