# CodeBuddy common query tools proposal

Implementation update: the initial version is implemented and has passed Windows development-build conversation acceptance. See the [implementation and acceptance record](COMMON_QUERY_TOOLS_IMPLEMENTATION_20261012_EN.md). The original proposal and its historical status follow.

Date: 2026-10-12. Status: research and design, not implemented or accepted.
Source baseline: main c3a537517 plus existing dirty changes. This request adds documentation only.

## Recommendation

Reuse the existing goose platform registry, model tool loop, permission policy and receipts. Ship time, location resolution and weather queries first; keep existing search for other live information. The model selects useful queries; the host validates inputs and obtains data. Use local functions and HTTP adapters initially. Add MCP adapters when needed without exposing duplicate capabilities.

## Verified public patterns

| Project | Public evidence | Adoption |
| --- | --- | --- |
| Codex open core | clock.curr_time has a schema, UTC output and host time provider; tool assembly includes builtin, dynamic and MCP tools | Lightweight clock; shared registration and execution |
| Claude API | Structured client calls execute in the application; server tools execute at Anthropic. Official docs demonstrate get_weather | CodeBuddy executes model-neutral tools against weather APIs |
| Hermes Agent | Registry includes schemas, handlers, availability checks and toolsets; optional tool search reduces exposed schemas at the cost of cold-call round trips | Eagerly expose a small common set; reuse discovery for extensions |

These are public source/API patterns, not claims about private Claude desktop internals or universal availability. Hermes' weather documentation is an example, not proof of a shipped weather integration. Codex is Apache-2.0; Hermes is MIT. Reference the architecture rather than importing a runtime; preserve required notices for copied code. CodeBuddy is Apache-2.0. Weather service and data terms are separate.

## Existing integration gap

platform_extensions/mod.rs, tool_registry.rs and extension_manager.rs already provide registration, schemas, ReadOnly policy, network annotations and execution receipts. agents/moim.rs supplies local time with a UTC offset. However, agent.rs skips that context, clears tools and prohibits tool use on conversation_only turns. Adding tool implementations alone would leave ordinary questions unsupported. Introduce a limited read-only query capability for chat while respecting explicit no-tools requests. Time questions should not create development plans, delegate, scan projects or control the desktop.

## Initial tools

| Capability | Proposed tool | Source |
| --- | --- | --- |
| Time, date, weekday, timezone conversion | time_now(timezone?) | Local clock: UTC, local time, offset and timezone source |
| City and administrative area resolution | location_resolve(query) | Geocoding API, with ambiguity candidates |
| Current weather, temperature, feels-like, rain and short forecasts | weather_get(location?, query_kind, units?, days?) | Configured weather provider |
| Date arithmetic and unit conversion | Reuse existing computation initially | Add deterministic tools when failure evidence warrants |
| News, opening hours and other queries | Existing search | Traceable sources and network policy |

Refresh temporal context before model requests, outside the stable system prefix, with sampling time and provenance. Refresh after resume/compaction rather than reuse old summary time. Use time_now for precise seconds or refresh during long tasks. Remote runtimes should use the desktop client's timezone.

## Location semantics

An explicit location in the current request wins. Otherwise a confirmed default query city can be used and named in the answer. A default city is not proof of current physical location. Requests for physical location require approved device geolocation or a city supplied by the user. A timezone is not city evidence.

Start with manual city selection. Validate native Windows/Mac geolocation and denied permissions separately later. IP location is an optional approximate candidate, potentially affected by VPNs and proxies. Do not continuously acquire or store exact coordinates for ordinary queries. Persist location preferences through existing memory consent rules.

## Weather providers

- Open-Meteo is a prototype candidate. Its free endpoint is noncommercial and has no uptime guarantee; commercial use needs an appropriate service plan and attribution. Current conditions derive from 15-minute model data, not a local sensor. Server code is AGPLv3 and data CC BY 4.0; this proposal consumes the API only.
- QWeather supplies geocoding and structured current weather. It is a production candidate requiring credentials and review of service terms and quotas.
- Use one small provider interface and implement one adapter first. Decide using actual regional connectivity, coverage, terms and freshness tests; no provider speed or accuracy winner has been established.

## Execution contract

Expose the small query set directly to a tool-capable main model. Let the model interpret semantics rather than use keyword workflows. Read-only network access still obeys network settings. Respect explicit no-tools requests and restrictions on device information. Unsupported models should report the capability gap rather than silently use shell or desktop automation.

weather_get may resolve an unambiguous city internally to reduce model round trips; ambiguity returns needs_location. Independent cities can run concurrently. Only configured, available fallback providers may be used. Search-derived weather must retain search provenance.

Results include status, location, location_source, timezone, values and units, provider, fetched_at, provider-supplied valid_at/observed_at where available, cached, stale and source URLs. Unknown data times stay unknown; retrieval time is not observation time. Errors include needs_location, network_disabled, provider_unavailable, rate_limited and permission_denied. Missing values are not zero and weather is not guessed.

Proposed initial TTLs: weather five minutes, geocoding 24 hours, subject to tests and provider terms. Cache keys include provider, coordinates, units, language, query type and date interval. Failed refreshes must label stale data and its time. Do not cache the clock. Bound total request time and retries; respect Retry-After for 429 responses.

## UI and implementation slices

Add Common Queries in the toolbox. Settings provide default city, units, provider, credentials and location options. Reuse secure credential storage; keys never reach the model or logs. Keep compact activity rows, with city, time and sources in answers.

1. Refresh time in every mode and add a testable clock source and time_now.
2. Support limited chat queries, one weather provider, geocoding and settings using existing policy and tool execution.
3. Run actual Windows/Mac question flows, then extend geolocation or other utilities based on evidence.

## Acceptance gates

- Automated: midnight, timezones/DST, compaction/resume refresh, ambiguous cities, units, null values, timeouts, 429, offline mode, expired caches and denied tool/location use.
- Real product: time in new/old chats, active tasks and after restart; explicit-city and unknown-location weather; multi-city comparisons, ambiguity, provider failures, changes of city/units and explicit no-tools requests.
- Run Windows and Mac separately. Record model, raw calls, source, data times and elapsed time. Validate tool calling with at least one available main model; report other model compatibility separately.
- Validate weather location, timestamp, unit, provider and data type rather than requiring exact equality to a different website. Measure end-to-end latency and model round trips before tuning. No unmeasured timing commitment.

## Sources

- [Codex clock](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/current_time.rs) and [tool assembly](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs)
- [Claude tool use and weather example](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- [Hermes adding tools](https://hermes-agent.nousresearch.com/docs/developer-guide/adding-tools) and [tool search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search)
- [Open-Meteo API](https://open-meteo.com/en/docs) and [service terms](https://open-meteo.com/en/pricing)
- [QWeather current weather](https://dev.qweather.com/en/docs/api/weather/weather-current/) and [city lookup](https://dev.qweather.com/en/docs/api/geoapi/city-lookup/)
- [Codex license](https://github.com/openai/codex/blob/main/LICENSE), [Hermes license](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE)
