# 时间与天气 Harness 接线与验收

对象：D:\CodeBuddy-v1 当前文件，无.git、无新分支/提交/推送/安装；前端源码未变。原源码基线964bbeb1587f1c5551ee17907e0b26632c4163ce及未提交修改保留。当前源码身份见 `.preview-evidence/overnight-source-commonqueries.json`。

## 问题与修复

原设置页能保存 CODEBUDDY_COMMON_QUERIES，但新版缺少 time_now、location_resolve、weather_get。现复用原 Rust CommonQueriesClient 的时钟、验证、Open-Meteo请求、缓存、取消、限流及来源回执，通过独立 stdio MCP 暴露。Harness 主导执行、审批和完成；不启动旧 Agent 或复制调度器。

配置仍由 runtime store 持有，每次通过宿主 MCP `_meta["codebuddy/common-query-settings"]` 传入五个经过验证的非敏感字段。模型工具参数没有联网开关控制权，其他服务器不接收这份配置。缺失/非法元数据明确失败；已撤除初版文件镜像，避免双写不一致。时区保存归一化为 IANA 名称，拒绝仅 JavaScript 支持的数值偏移。

完整链路发现 config/upsert/remove 原来无条件清空会话初始化。回归先红后绿；现在仅查询设置通过调用时读取而保留已有连接，其他配置保持原失效机制。三会话共享HTTP MCP的独立回归证明配置隔离、实时更新及仅一次握手。

沿用锁定 rmcp 1.8.0，显式启用既有 server feature，无新增包、版本或锁文件变化。[官方 Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)。旧工具沿用Apache-2.0，SDK MIT。Windows x64默认启用，缺少产物的平台保持禁用；macOS尚待实机与产物验收。

## 实际验证

- `cargo fmt --package goose --package goose-cli --package goose-mcp`：exit0。
- 使用既有Windows构建环境解析器执行 `cargo test --offline --locked -p goose --lib common_queries --jobs 1`：12通过、1项原有公网测试忽略，exit0，common-query-metadata-rust.log。
- `cargo clippy --offline --locked -p goose -p goose-mcp -p goose-cli --lib --jobs 1 -- -D warnings`：exit0，common-query-clippy.log。
- `cargo build --offline --locked -p goose-cli --bin goose --jobs 1`：exit0，common-query-goose-build.log。工具pin更新为goose-0a286375/goose.exe，332407808字节，SHA256 `0a286375a8d30f0acbbf38f40275372a13a613dc5b5ad50fae5d0de6b23fa602`；旧产物保留。
- 原生MCP接线4/4；最终 `node --test --test-concurrency=1 runtime/tests/*.test.mjs runtime/harness/test/*.test.mjs scripts/*.test.cjs`：360/360、零跳过、exit0、261.7秒，overnight-commonqueries-final.log。前端原组件3/3的有效证据复用，未改前端、不冒充全前端复测。
- 真实Electron+已配置Kimi会话3149b4e4-d124-4d1f-8fe6-6f5f0a7a3323：约899ms创建页面；上海时间与禁止联网回执；同会话设置UTC后实际UTC回执；开启联网后解析广州（广东），使用实际坐标23.11667/113.25获取Open-Meteo当前天气。三轮均原生harness_turn完成，网络禁用是工具错误而非误判整轮中断。
- 五次工具调用；查询MCP初始化日志仅一次，进程37856从05:21:02持续复用。第二次time_now参数为timezone:null，按既有可选字段语义读取设置；初始要求严格空对象的验收断言已修正，未改产品以迎合样本。非法+01:00保存被拒绝，原有效配置不变；专用设置已恢复默认值。工具箱真实发现三工具、历史重载保留；工具清单选择器需要限定可见对话框及完整MCP名称，早先定位超时属于脚本问题。

界面、工具与原生完成回执在 `.preview-evidence/real-skills-4e2BOF/foundations-ui-receipt.json` 的commonQueries及commonqueries-*.png。当前隔离预览runtime7580/desktop19932、exec69369，CDP9395；用户runtime20048未动。早先旧预览exec5859已exit0。此报告只证明上述查询及回归范围，不代表全部首版功能、macOS或安装包通过。

实际代码改动：`runtime/common-query-settings.mjs`、`runtime/compat.mjs`、`runtime/settings.mjs`、`runtime/builtin-extensions.mjs`、`runtime/tool-policy.mjs`、`runtime/harness/index.mjs`、`runtime/harness/mcp-bridge.mjs`、`crates/goose/Cargo.toml`、`crates/goose/src/agents/platform_extensions/common_queries.rs`、`crates/goose-mcp/src/mcp_server_runner.rs`、`crates/goose-cli/src/cli.rs`；tests/settings-runtime、tests/builtin-extensions、harness/test/mcp-metadata及工具provenance。
