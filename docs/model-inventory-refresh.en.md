# Refreshing models at startup

After network consent, the runtime refreshes configured connections in the background with at most three concurrent connections, without gating window readiness. Manual refresh shares the same owner. Failures retain the last successful inventory; a valid empty list establishes that the connection currently offers no models.

A desktop banner distinguishes models missing from the provider list, reported capability changes, and refresh failures. Defaults, session models and user preferences remain unchanged. Users must manually replace unavailable selections. Unacknowledged changes survive restart; returning models lose their removal notice.

Comparison covers reported context capacity, output limits, image input, thinking options and tool support. The default model also uses existing capability discovery. The first successful baseline does not imply a change; missing metadata does not mean unsupported. Undisclosed replacements behind an unchanged model identity cannot be reliably detected.

`runtime/model-inventory.mjs` owns refresh, connection identity checks, baselines and notices. Optional `providers[].inventoryState` is established on the first successful refresh without bulk migration. `runtime/status` projects structured results for localized rendering. Acknowledgements bind to notice versions; late requests cannot overwrite a changed connection or write after shutdown.

Reference: [VS Code Language Model Chat Provider](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider). Only the separation between discovery and change notification was adopted; no implementation was copied and no dependency added.

## Thinking defaults

Switching models preserves each model's explicit preference. Without a preference, use the service's declared default level; when undeclared, show “Service default” and omit thinking controls. Offering Off does not make Off the default, and the lowest level is not selected automatically. “Off” identifies a real off setting; “Not adjustable” identifies unsupported controls.
