# Default LAN model initialization

Date: 2026-09-14. Automated checks and native Electron failure recovery and existing-default preservation passed. Successful real-model setup remains blocked by the stopped service.

The default endpoint is `http://192.168.9.120:8001`. The user confirmed the service was deliberately stopped and will return in a few days. Do not probe again or substitute the old service.

Fresh users enter chat after discovery, provider creation, persistence and context refresh. Failures and individual operations exceeding 60 seconds expose Retry and the endpoint. Empty or ambiguous catalogs never select an arbitrary first model. A single valid model is selected automatically; multiple models require a confirmed deployment model ID. Existing unauthenticated configuration is retained without embedding keys; actual service authentication remains unverified.

Complete and partial existing defaults are preserved. Defaults are reread after discovery and creation to protect choices made during setup. This is not a cross-process transaction: the final read/save race requires backend conditional persistence for a complete guarantee. Provider creation reuses backend idempotence for identical configuration. Timeout stops subsequent frontend steps; an already dispatched backend operation may still finish, so timeout does not prove absence of writes.

## Public comparison

[Codex configuration](https://developers.openai.com/codex/config-reference/) distinguishes model, provider and base URL. Adopt explicit selection and user configuration precedence without inferring private Codex initialization internals. The [OpenAI models list](https://platform.openai.com/docs/api-reference/models/list) does not define the first entry as a default, so arbitrary first-model selection is rejected. No third-party code or dependency was adopted.

## Validation and remaining gates

From `D:\CodeBuddy\ui\desktop`, `pnpm exec vitest run src/components/onboarding/OnboardingGuard.test.tsx src/components/ModelAndProviderContext.test.tsx --maxWorkers=1` passed 18 tests (including 4 model context tests) with zero failures. Typecheck, scoped ESLint and scoped Prettier passed. All 16 locales are synchronized and the full i18n check passed. Exact commands and exit codes are recorded in `.cargo/evidence/default-lan-onboarding-20260914/gates.json`.

Started source Electron with the rebuilt backend and isolated empty configuration. Native mouse interaction verified the endpoint, error and Retry; keyboard reload retained a recoverable state. Restarting with isolated `openai/fixture-preserved` defaults opened the application, and reload preserved those values. Evidence: `native-initial.*`, `native-retry-*`, `native-reload.txt`, and `native-existing-config-result.json`. These checks establish failure recovery and existing-default preservation only. Actual messages, successful setup persistence and streaming await service restoration. No installer has been produced.

Additional validation: full desktop pnpm run test:run exited 0: 227 files, 2016 passed, 4 skipped, no failures. The production Vite renderer build exited 0. Logs and result records are in .cargo/evidence/default-lan-onboarding-20260914/.
