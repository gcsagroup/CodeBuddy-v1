# 默认局域网模型初始化

日期：2026-09-14。状态：自动化及真实 Electron 失败恢复、已有配置保护验收通过；真实模型成功路径因服务停机待验收。

默认服务为 `http://192.168.9.120:8001`。用户已确认服务主动停止，数天后恢复；不再探测，也不换用旧服务。

新用户在模型发现、提供商创建、默认值保存与界面状态刷新完成后进入聊天。失败或单次操作超过60秒显示可重试状态和服务地址。空或多模型列表均不任意选取；唯一有效模型自动使用，多模型仍待确认部署默认 ID。沿用无认证配置，没有嵌入密钥；真实服务认证方式尚未确认。

完整或残缺已有默认值都保留；发现及创建完成后重新读取，避免覆盖期间选定的默认值。这不保证跨进程事务；最后读取与保存之间的竞态需后端条件写入才能完全消除。创建复用后端相同配置幂等性。超时仅停止前端后续流程，已发出的后端操作可能完成，不能将超时视为确定未写入。

## 公开方案比较

[Codex 配置参考](https://developers.openai.com/codex/config-reference/) 分别指定模型、提供商及服务地址；本方案采用明确模型选择、用户配置优先，不推断 Codex 私有初始化行为。[OpenAI 模型列表](https://platform.openai.com/docs/api-reference/models/list) 未定义首项为默认模型，因此不沿用任意选首项。只参考公开接口，未复制第三方代码或新增依赖。

## 验证及剩余关卡

在 `D:\CodeBuddy\ui\desktop` 执行 `pnpm exec vitest run src/components/onboarding/OnboardingGuard.test.tsx src/components/ModelAndProviderContext.test.tsx --maxWorkers=1`：18通过、0失败（含4项模型上下文测试）；typecheck、限定 ESLint、限定 Prettier 通过。16种语言同步及 i18n 全量检查通过。完整命令和退出码见 `.cargo/evidence/default-lan-onboarding-20260914/gates.json`。

已从隔离空白配置启动源码 Electron 和新构建后端，真实鼠标验证地址、错误和重试，键盘刷新后仍可重试。隔离测试配置 `openai/fixture-preserved` 再次启动后进入主界面，刷新后配置未被覆盖。证据为 `native-initial.*`、`native-retry-*`、`native-reload.txt`、`native-existing-config-result.json`。这些只证明失败恢复与已有配置保护；真实模型发消息、成功初始化持久化和流式回复仍待服务恢复。安装包尚未生成。

补充验证：桌面全量 pnpm run test:run exit 0，227个测试文件、2016通过、4跳过、0失败。Vite renderer生产构建 exit 0。完整日志和结果位于 .cargo/evidence/default-lan-onboarding-20260914/。
