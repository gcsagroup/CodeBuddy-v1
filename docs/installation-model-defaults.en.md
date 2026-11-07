# Toolbox and installation model defaults

Fresh installations include **CodeBuddy LAN (Gemma-4)**, selected by default, and **CodeBuddy LAN · Qwen**. The Ollama Cloud distribution preset and shared-key import have been removed. Packaging explicitly excludes the legacy `runtime/distribution-credentials.json`, even if it remains in a local build checkout. Existing user-configured connections and credentials are preserved. Users can still add providers and enter their own credentials in Settings.

On 2026-11-06, `Qwen3.8-27B-FP4` and `Qwen3.8-27B-CyberSecurity` at `http://192.168.9.120:8001` were added. Both are available alongside Gemma-4 in the model picker on first launch without entering credentials. The default main and image-recognition model remain Gemma-4. Both Qwen models passed basic requests against the real service and actual conversations in the isolated desktop; this does not establish image or tool-calling support.

All tools are grouped into built-in capabilities, skills, and external MCP services. Computer control executes actions; the Desktop operation guide (computer-use) is a skill loaded by the model and does not enable those tools. Local Git manages workspace repositories, while GitHub connects remote repositories, issues, pull requests, and CI.

Fresh Windows/macOS desktop installations use the same Harness state initialization entry and runtime/default-model.json. The preset is gemma-4-26B-A4B-it-uncensored-FP8-W8A16 at http://192.168.9.101:8001, with the 65,536-token context reported by the service on 2026-10-22. Startup does not send user content or require the endpoint to be online.

The main model and auxiliary image recognition default to the same service. On 2026-10-23, an isolated red-and-blue image request returned the correct left/right colors, so the distribution preset enables image input. This verifies that image request only, not desktop control or other tools.

This LAN endpoint may be unreachable from other networks. Users can edit the service, add providers, and independently change the main model, image recognition model, and image capability setting in Settings → Models and runtime. Existing state.json files are preserved, including intentionally empty provider lists. Removing the preset does not cause it to be re-added on restart. The preset does not grant OS network permission.
