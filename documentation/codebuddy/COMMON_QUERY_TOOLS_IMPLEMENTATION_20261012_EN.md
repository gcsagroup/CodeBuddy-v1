# Common query tools: implementation and acceptance

> Submission preparation, 2026-10-13: this change includes common queries, answer-budget repair and acceptance records. Statements below about not being committed describe the 2026-10-12 acceptance state. Pre-commit checks reran 25 frontend tests, cargo fmt --all --check and git diff --check successfully. The frontend rerun used Node 22.23.2 and emitted the Node 24 engine warning; earlier Node 24 validation is recorded below. Completed backend regression and Clippy evidence was reused. A new backend rerun triggered dependency recompilation and was deliberately interrupted; it is not counted as a new pass.

[繁體中文](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_ZH_TW.md) · [简体中文](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_ZH_CN.md) · [English](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_EN.md)

Source: this change on CodeBuddy main `50dfeb1be`. Initial implementation complete; Windows development-build conversations accepted. Not committed, pushed or packaged yet.

## Weather answer interruption fix

The initial acceptance cases missed a boundary later reported by the user. At 18:15, session `20261012_2` received three empty location results and a successful fourth weather query. The old conversation policy allowed only four total turns and stopped before the fifth-turn answer. This was an executor finalization defect, not context exhaustion or evidence of weather API failure.

The existing host action budget now permits four query rounds and reserves a tool-free answer. One additional answer correction is available only after a prohibited finalization tool request, within a total cap of six; there is no automatic extension. Lower user-configured caps still win. Entering a normal conversation answer no longer emits execution exhaustion; actual exhaustion still does. Development-task pause and completion checks retain their behavior.

Empty location results advise against spelling/language retries without new evidence. A known parent city's forecast may be offered as explicitly labeled city-level reference, never as an exact district forecast. Uncertain parent locations require clarification. No place-specific routing or guessed coordinates were added.

34 automated regressions passed: 1 executor replay (normal answer and rejected-tool correction scenarios), 20 action_budget tests, 11 common_queries tests, and one each for existing read-only finalization and explicit no-tools behavior. Clippy exited 0. The replay dispatches the real local clock tool with three invalid arguments followed by one successful query, checking evidence delivery, persistence and denied finalization tool execution. It does not substitute for live weather/model acceptance. Logs are in target/common-query-*.log. Earlier passes apply only to the original cases below.

The updated backend was built with SHA-256 `b457e199d3cceb1450fbada591590ce5d5ffd3274bab18ce218627513ac86eba`; formatting exited 0. The initial startup hit EPERM while another development instance occupied the frontend directory. After user-authorized normal closure, the README pnpm run start-gui entry successfully reopened the isolated acceptance profile.

At 20:02–20:04, real Electron session `20261012_4`, using custom_1 / deepseek-v4-pro:0813, answered the original Tianhe question with 3 tool calls (district not found → Guangzhou resolved → weather succeeded) and an explicit city-level qualification. A Shanghai three-day follow-up completed with 2 calls. Both weather receipts were newly fetched, cached=false and stale=false; every stated rain probability matched the raw result, with zero execution-limit events. The forced four-query finalization boundary is covered by the automated executor replay above.

A direct re-ask in the older session reused historical weather and is excluded from fresh-query acceptance; model decisions to refresh historical data remain a limitation. Evidence: target/common-query-acceptance/budget-fix-verified-results.json, 20261012_4.json, budget-fix-final-ui.txt and screenshots. Original failure evidence: query-budget-original-repro.json. No commit, push or installer was produced.

## Behavior

- Refresh host clock context for each main model request, including ordinary chat and requests after compaction/resume. The projection is not persisted. Explicit no-tools turns retain their restricted context.
- `time_now` returns UTC, local time, date, weekday, IANA timezone provenance and sampling time, including DST conversion. Timezone is not evidence of physical location.
- `location_resolve` returns city/district candidates and coordinates. The model asks the user to resolve ambiguous places.
- `weather_get` provides current conditions or a 1–7 day forecast including today. Omitted location uses the configured default query city; without one it returns `needs_location`.
- Ordinary chat offers only these enabled query tools through existing permissions and receipts. Workspace writes and desktop control are excluded. The semantic router recognizes everyday query intent without a new keyword dispatcher.

Settings → General → Time and weather configures city, two-letter country code, IANA timezone, Celsius/Fahrenheit and online access. Settings use the existing ACP config boundary with backend validation and are reread per query. The toolbox displays Common queries. No GPS/IP location detection or background tracking is implemented.

## Data and failures

The first adapter uses [Open-Meteo](https://open-meteo.com/en/docs) and its [geocoding API](https://open-meteo.com/en/docs/geocoding-api). Its [free service is non-commercial](https://open-meteo.com/en/terms); commercial distribution requires an appropriate paid plan/provider. Paid API credential settings are not part of this version.

Results retain model weather data, original units, source, validity time and fetch time. Missing values remain null; fetch time is not an observation time. Geocoding caches for 24 hours, weather for 5 minutes, with at most 256 entries. Daily forecasts refresh across local midnight. Refresh failures may return weather cached for under one hour with status=stale, the original timestamps and the refresh error. Network disablement precedes cache reads. HTTP requests have a 12-second timeout and the entire tool a 25-second deadline. Cancellation stops waiting; 429 Retry-After establishes a cooldown without immediate retries.

The host/provider owns values; the model chooses queries and explains results. Model statements are not execution receipts. A remote backend with no configured display timezone uses its own timezone; select the intended timezone explicitly.

## Verification and boundaries

Local evidence: `target/common-query-*.log` and `target/common-query-acceptance/`. Acceptance profiles and credentials are excluded from Git. Automated tests, real provider API checks and desktop conversations are recorded separately. Windows results do not establish native macOS acceptance. Detailed results follow below.

Merge the Rust tools/registry/chat context/router, ACP settings validation, desktop settings and locale changes together. `chrono-tz` already existed in the lockfile and is now a direct goose dependency. Missing settings use defaults; old conversations require no migration.

### Acceptance results, 2026-10-12

Exact commands are listed in the [Simplified Chinese checklist](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_ZH_CN.md#2026-10-12-实测结果). All exited 0. Cargo ran at the repository root; frontend checks ran in ui/desktop using existing Node 24.18.0 and pnpm 11.9.0.

| Check | Result |
| --- | --- |
| common_queries tools and permissions | 10 passed; live API test run separately |
| agents::moim context and cache | 9 passed, including one overlapping test |
| tool_registry / semantic routing contract | 3 / 1 passed respectively |
| Real Open-Meteo API | 1 passed; Guangzhou current and three-day forecast |
| cargo fmt and applicable Clippy | Passed; Clippy used -D warnings |
| Frontend components | 25 passed across 2 files |
| Typecheck, localization, relevant ESLint | Passed; 2742 localization message keys |

Windows ran this source with `pnpm run start-gui`. Normal native Electron interactions exercised settings and chat; exported ACP tool receipts were checked. Model: custom_1 / deepseek-v4-pro:0813. Isolated-profile sessions: 20261012_1 and 20261012_2.

- New chat answered time, date and weekday correctly (17:08, Monday 2026-10-12); unknown location prompted for a city.
- Guangzhou current weather and three-day forecast returned 32.6°C at 17:00, with source and weather-model provenance preserved.
- Multiple US Springfield candidates triggered clarification without choosing a weather location.
- City, country, timezone and Fahrenheit preferences survived page reload. A new chat with omitted city/unit returned Guangzhou at 90.3°F and distinguished the configured default from detected location.
- Disabling network returned network_disabled for weather, without presenting cached weather as fresh. New York local clock queries still returned UTC−04:00.
- An explicit no-tools turn contained zero tool calls. Restoring network/Celsius enabled a Guangzhou–Shanghai comparison with separate values, source and data times.
- After actual UI compaction completed, a new time question returned 17:41 and correctly retained the two previously compared cities.

Evidence: target/common-query-acceptance/, including session JSON, visible text, screenshots and verified-results.json. Backend SHA-256: `68ad7724c89b9b161d790cb224572f7787e436e08f04ac577c430649b6f5786f`. Weather figures describe the acceptance time only.

Not validated: native macOS, full application restart, queries during long-running tasks, installers. Paid weather providers, automatic system/IP location and automatic remote-client timezone forwarding are not implemented; explicitly configure the timezone for a remote backend. The free service is non-commercial; commercial distribution needs an appropriate provider arrangement. These boundaries are not counted as complete.
