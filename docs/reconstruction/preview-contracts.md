# 首版原界面 ACP 兼容合同

核对日期：2026-10-14。核对对象：`D:\Users\jiangrui\Desktop\CodeBuddy` 当前文件；未修改原项目。本文是实施用的接口清单，不代表完整功能已经迁移。

## 启动与认证

原 Electron `ui/desktop/src/backendStatus.ts` 依次调用：

1. `GET /status`，请求头 `X-Secret-Key: <secret>`，要求 2xx。
2. `GET /acp?token=<secret>`，没有 SSE Accept 请求头；认证通过要求 **406**。401/403 直接判失败。
3. Renderer 建立 `ws://127.0.0.1:<port>/acp?token=<secret>`，一条 WebSocket 消息对应一个 JSON-RPC 2.0 对象。

每条连接都会 `initialize`，控制通道有独立连接。请求形状：

```json
{"protocolVersion":1,"clientInfo":{"name":"codebuddy-desktop","version":"..."},"clientCapabilities":{"elicitation":{"form":{}},"_meta":{"goose":{"customNotifications":true,"projectContainers":1,"workspaceConfirmationRefresh":1,"recipeParameterRequests":true}}},"_meta":{"goose/useLoginShellPath":true}}
```

必要响应：`{protocolVersion,agentInfo:{name,version},agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},close:{}},promptCapabilities:{image:boolean,audio:boolean,embeddedContext:boolean}},authMethods:[]}`。能力声明必须与实际实现一致；客户端宣告能力不等于服务端已经支持。尤其不要在没有对应实现时宣告 `agentCapabilities._meta.goose.projectContainers:1` 或 `workspaceConfirmationRefresh:1`。

未知方法返回 JSON-RPC `-32601`，错误参数返回 `-32602`；不得以空成功伪装未迁移的行为。

## 原界面首次加载

以下扩展方法全加前缀 `_goose/unstable/`：

| 方法 | 请求 | 必要响应 / 语义 |
| --- | --- | --- |
| `defaults/read` | `{}` | `{providerId:string|null,modelId:string|null}` |
| `defaults/save` | `{providerId,modelId}` | `{}`；保存经过验证的选择 |
| `config/read-all` | `{}` | `{config:{},blockedMutationKeys:[]}`；不回传 secret |
| `config/read` | `{key,isSecret?}` | `{value?}` |
| `config/upsert` | `{key,value,isSecret?}` | `{}` |
| `preferences/read` | `{keys?:[]}` | `{revision:非负安全整数,values:[{key,value?,isMutable:boolean}]}` |
| `preferences/save` | `{expectedRevision,values:[{key,value}]}` | `{}`；递增 revision，冲突 `error.data={code:'preference_revision_conflict',expectedRevision,actualRevision}` |
| `config/extensions/list` | `{}` | `{extensions:[{extension,enabled,configKey?}],warnings?:[]}` |
| `config/extensions/add` | `{extension,enabled?}` | `{}`；仅持久化真实配置 |
| `config/extensions/set-enabled` | `{configKey,enabled}` | `{}` |
| `session/extensions/list` | `{sessionId}` | `{extensions:[]}` |
| `tools/list` | `{sessionId,extensionName?:null}` | `{tools:[{name,description,parameters:[],inputSchema,permission?}]}` |
| `slash-commands/list` | `{cwd?,sessionId?}` | `{availableCommands:[{name,description,_meta?:{commandType:'Builtin'|'Recipe'|'Skill'}}]}` |
| `agent-mentions/list` | `{cwd?,sessionId?}` | `{agents:[{name,description,sourceType,mention,sourcePath?}]}` |

原 `OnboardingGuard` 的实际边界：如果 defaults 没有 provider/model，前端自动请求 `providers/custom/discover-models`，地址固定为 `http://192.168.9.120:8001`、engine=`openai_compatible`、requiresAuth=false。只有发现恰好一个模型才继续 `custom/create` → `defaults/save`。零个、多个、服务不可用都会阻挡聊天界面。`/configure-providers` 路由没有这个 guard，首版启动入口可直接打开已有配置页，用户自己配置模型；不访问旧凭据、不自动请求 LAN、不注入假模型。

`ConfigureProvidersRoute` → `ProviderSettingsPage` → `ProviderGrid compactConnectionSetup` → `CustomProviderForm`。当前紧凑表单直接使用原有 provider presets，不请求 catalog/template。仅用户点击加载模型后才调用 `providers/custom/discover-models`；选择模型后 `providers/custom/create`，返回后刷新 provider inventory 并打开 `SwitchModelModal`，最后 `defaults/save`。保存 provider 前先发现模型，再对首选模型发 1 token、非流式 completion 验证，成功才持久化。

原 `ConfigContext` 首次挂载会自动同步 bundled extensions：list → add/remove/set-enabled → list。保存配置成功不证明插件功能已接入 Harness。

## 模型配置

`providers/list {providerIds?:[]}` 必须返回 `{entries:[...]}`。每个 entry 必需：

```json
{"providerId":"custom-id","providerName":"Provider name","description":"...","defaultModel":"model-id","configured":true,"providerType":"Custom","category":"model","configKeys":[],"setupSteps":[],"supportsRefresh":false,"refreshing":false,"models":[{"id":"model-id","name":"model-id"}],"stale":false}
```

模型可有 `contextLimit`、`reasoning`。SDK 对扩展响应执行 Zod 校验，缺字段会使整个响应失败。

| 方法（同上前缀） | 请求 / 响应 |
| --- | --- |
| `providers/supported-models/list` | `{providerId}` → `{providerId,models:string[]}` |
| `providers/custom/discover-models` | `{engine,apiUrl,requiresAuth?,providerId?,basePath?,apiKey?,headers?}` → `{models:string[]}` |
| `providers/custom/create` | `{engine,displayName,apiUrl,requiresAuth,apiKey?,models?,supportsStreaming?,headers?,catalogProviderId?,basePath?,preservesThinking?}` → `{providerId,status:{providerId,isConfigured},refresh:{started:[],skipped?:[]}}` |
| `providers/custom/read` | `{providerId}` → `{provider:{providerId,engine,displayName,apiUrl,requiresAuth,apiKeySet,preservesThinking,models?,supportsStreaming?,headers?,basePath?,apiKeyEnv?},editable:boolean,status:{providerId,isConfigured}}` |
| `providers/custom/update` | create 的字段加 `providerId` → 同 create 响应 |
| `providers/config/read` | `{providerId}` → `{fields:[{key,value?,isSet,isSecret,required}]}`；secret 通常仅给 isSet |
| `providers/config/save` | `{providerId,fields:[{key,value}],clearFields?:[]}` → `{status:{providerId,isConfigured},refresh:{started:[]}}` |
| `providers/config/status` | `{providerIds?:[]}` → `{statuses:[{providerId,isConfigured}]}` |

非紧凑配置入口的目录合同：`providers/catalog/list {format?:'openai'|'anthropic'}` → `{providers:[{providerId,name,format,apiUrl,modelCount,docUrl,envVar,enabled,disabledReason?}]}`；`providers/catalog/template {providerId}` → `{template:{providerId,name,format,apiUrl,models:[{id,name,contextLimit,capabilities:{toolCall,reasoning,attachment,temperature},deprecated}],supportsStreaming,envVar,docUrl}}`。这些目录数据应来自真实支持的配置，不是任意占位 provider。

活跃会话切模型使用标准 `session/set_config_option`：

```json
{"sessionId":"s","configId":"provider_model","value":"{\"providerId\":\"p\",\"modelId\":\"m\",\"thinkingEffort\":\"high\"}"}
```

响应为 `{configOptions:[{id:'provider',name:'Provider',type:'select',currentValue:'p',options:[{value:'p',name:'Provider'}]},{id:'model',name:'Model',type:'select',currentValue:'m',options:[{value:'m',name:'m'}]}]}`。provider/model 必须原子应用；失败不得留下只改 provider 的状态。

## 新会话与历史

`session/new` 请求：`{cwd,mcpServers:[],_meta:{client:'goose-desktop',enabledExtensions?,workspaceMode?:'code'|'codepro',projectId?,workspaceLeaseId?,workspaceBinding?:'unbound'|'root_container'|'writable_project',rootContainerPath?}}`。

响应：`{sessionId,modes?:{currentModeId,availableModes:[{id,name,description?}]},configOptions?,_meta?:{workingDir,recipe?,userRecipeValues?,extensionResults?}}`。

紧接着原界面一定请求 `_goose/unstable/session/info {sessionId}`，响应：

```json
{"session":{"sessionId":"s","cwd":"D:/workspace","title":"Session title","updatedAt":"2026-10-14T00:00:00Z","_meta":{"createdAt":"2026-10-14T00:00:00Z","messageCount":0,"providerId":"p","modelId":"m","sessionType":"user","workspaceBinding":"writable_project"}}}
```

`sessionType` 区分 `user`、`scheduled`、`code_pro`。可选 meta 有 `lastMessageAt,archivedAt,projectId,userSetName,hasRecipe,lastMessageSnippet,rootContainerPath`。`workspaceBinding:unbound` 会使原 UI 隐藏进程 cwd。

`session/list` 请求 `{cursor?,_meta:{types:['user','scheduled'],query?}}`；统一入口也可能包含 `code_pro`。响应 `{sessions:[SessionInfo],nextCursor?:string|null}`。原界面按类型筛选，不能忽略 types 后泄露到错误工作区视图。

历史加载顺序：`session/info` → `session/load {sessionId,cwd,mcpServers:[],_meta?:{workspaceLeaseId}}` → `session/info`。**load 响应前通过 session/update 回放消息、思考和工具结果**；load 响应与 new 的 metadata/modes 一致但无须新 sessionId。

会话管理：`session/delete {sessionId}`；`session/close {sessionId}`；`_goose/unstable/session/rename {sessionId,title}`；`.../archive {sessionId}`；`.../unarchive {sessionId}`。关闭不等于删除。

## 提示、流、工具、停止

`session/prompt` 请求 `{sessionId,prompt:[{type:'text',text}|{type:'image',data,mimeType}],_meta?:{'codeagentpro/source-message-id':<原用户消息id>}}`。其响应直到回合结束：`{stopReason:'end_turn'|'cancelled'|...}`。

增量通知：

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"实际增量"},"_meta":{"goose":{"messageId":"assistant-message-id","created":1791936000}}}}}
```

`sessionUpdate` 可为 `user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`。`created` 是 Unix 秒。思考和同次模型响应的文本保持同一 assistant messageId；只有真实上游思考增量才推 thought。历史 user chunk 使用原始 messageId，避免原 UI 重复消息。

当前冻结界面会在请求接受后才把本地用户消息加入会话，按 adapter 插入顺序显示，并不按时间或 UUID 排序。兼容层在会话准备完成后、助手事件前发送 `user_message_chunk`，沿用 `codeagentpro/source-message-id`；原 adapter 和本地接受回调都按这个 id 去重。否则在未发旧 CodePro run-admission 事件的普通 Harness 会话中，用户消息会直到 prompt 完成才追加，出现助手在前。修复无需改动旧历史 id 或时间；原样回放已存储的 user→assistant 事件即可。

Harness 的 `attemptId` 会在后续 prompt 重新使用，因此兼容层的新助手 id 使用每次 prompt 的独立 UUID 和 attemptId 组合，流式显示与持久化回放沿用同一个 id。早期预览已保存的跨用户轮次同 id 记录，在 `session/load` 时仅对后续发生碰撞的助手生成确定性别名；第一轮、无碰撞 id、时间和原始文件保持原样。对应 usage 仅在计数能明确逐轮对应时同步投影；缺少轮次信息的歧义 usage 不归属到其他消息。回归测试直接使用冻结 renderer adapter，验证两轮实时消息与重启回放均保持 user→assistant→user→assistant。

工具开始：

```json
{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"read_file","kind":"read","status":"in_progress","rawInput":{"path":"README.md"},"_meta":{"goose":{"messageId":"assistant-message-id","created":1791936000,"toolCall":{"toolName":"read_file","extensionName":"harness"}}}}
```

工具结束：

```json
{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"实际工具回执"}}],"rawOutput":{"optional":"structured result"}}
```

失败使用 `status:'failed'`。原 UI 只有 completed/failed 才生成 toolResponse。重复 toolCallId 的更新必须归属同一调用。

Token 使用由 `_goose/unstable/session/update` 发出：`{sessionId,update:{sessionUpdate:'usage_update',used,contextLimit,accumulatedInputTokens,accumulatedOutputTokens,accumulatedCost?}}`。普通 ACP `usage_update` 在当前 UI adapter 中忽略。

`session/cancel` 是 **notification** `{sessionId}`；必须在 prompt 仍未返回时可处理，且取消后原 prompt 返回 `stopReason:'cancelled'`。不允许等待 prompt 完成后再处理 cancel。

## 验证边界

`runtime/tests/acp-contract.test.mjs` 使用注入受控 driver，覆盖认证、初始化、provider/session 数据形状、增量映射、工具结果、历史回放、取消和错误。该验证只证明协议桥行为；真实 Harness、模型供应商、原 Electron 界面和 Windows/macOS 桌面能力需分别验收。

源码依据：`ui/desktop/src/backendStatus.ts`、`acp/acpConnection.ts`、`acp/sessions.ts`、`acp/prompt.ts`、`acp/providers.ts`、`acp/preferences.ts`、`acp/adapter/{messages,tools,shared}.ts`、`components/{ConfigContext,OnboardingGuard}.tsx`（OnboardingGuard 实际位于 onboarding 子目录）、`ui/sdk/src/generated/{types,zod,client}.gen.ts`、`crates/goose/src/acp/server.rs`。
