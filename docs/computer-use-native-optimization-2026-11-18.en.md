# Windows native-control optimization acceptance

The main model remains deepseek-v4.1-flash:1017 with max reasoning. CUA-S1-Qwen3.5-4B remains a remote API image-only observer with no action tools. No installer, commit or push.

Field views retain already-read document, button and focus evidence. An explicit full observation no longer makes all subsequent same-window actions visual. Successful same-PID/HWND receipts carry changed captions without broadening the original title scope; external renames, conflicts and new windows cannot inherit that continuation. Confirmed GUI saves no longer invite redundant recursive disk verification.

One controlled before/after run per task, plus two predeclared held-out tasks. Real desktop runs were serialized. Initial UI values were matched; the final Notepad rerun restored unsaved content through the UI and separately checked save time and complete disk text. Execution is the Harness turn; Service adds backend preparation, excluding UI dispatch/render. Files and form events establish results, not model claims. Small-sample task correctness is not general model accuracy.

Failures retained: an initial round overlapped native input-lock tests and has invalid timing; a filename-only exploratory prompt was misbound as an exact window title and delegated before being stopped (not claimed fully resolved); an intermediate 226.708-second Notepad run saved correctly but recursively searched disk and was stopped. Legacy controls still require some image interpretation. No claim of universal Windows coverage.

go test ./... (34.451s), go vet, go build exited 0. Host/routing/artifact tests 20/20, routing integration 4/4, final skill tests 3/3. Launched through .\start-preview.ps1.

The held-out form used one stale field token, was rejected, reobserved and recovered; its 57.716s includes that retry. Missing state in current receipts does not establish that Windows cannot expose it. Main-model request counts did not decrease overall (14→14, 16→18); action choice and state readback remain optimization opportunities.

## Changed files / 改动文件

`tools/qwen-computer-use/main.go`, `observation_test.go`, `README{.zh-CN,.en,}.md`; `runtime/harness/skills/computer-use/SKILL.md`; `runtime/builtin-artifacts.mjs`, `runtime/tools/provenance.json` and rebuilt native binary. Existing unrelated dirty changes were preserved.

## Commands / 验证命令

```text
cd tools/qwen-computer-use
go test ./...
go vet ./...
go build -o ../../target/debug/qwen-computer-use.exe .
# repository root; installed Node 24
node --test runtime/harness/test/computer-skill.test.mjs runtime/tests/vision-routing.test.mjs runtime/tests/builtin-artifacts.test.mjs
node --test runtime/tests/vision-routing-harness.test.mjs
node --test runtime/harness/test/computer-skill.test.mjs
.\start-preview.ps1
```

All checks exited 0; the preview is a running development process, not an installer.

| Case | Execution s | Service s | Main calls | CUA calls | Result |
|---|---:|---:|---:|---:|---|
| before-notepad | 155.255 | 169.677 | 14 | 6 | PASS |
| after-notepad | 69.988 | 74.681 | 14 | 0 | PASS |
| before-native | 109.867 | 121.627 | 16 | 7 | PASS |
| after-native | 83.882 | 87.897 | 18 | 3 | PASS |
| holdout-notepad | 103.728 | 108.540 | 15 | 0 | PASS |
| holdout-native | 57.716 | 62.708 | 11 | 2 | PASS |

## Evidence / 证据

- `before-notepad`: `afe62e13-bef7-44cf-a401-e25d1b5514c1`; `before-notepad-verified.json` / `before-notepad-timings.json`.
- `after-notepad`: `b4fb1440-1c59-468c-b8bf-08acfac7a90a`; `after-notepad-verified.json` / `after-notepad-timings.json`.
- `before-native`: `177b5f97-0732-412b-b136-cc362974c813`; `before-native-verified.json` / `before-native-timings.json`.
- `after-native`: `a25f3a4b-d1e3-43c6-aa62-9dd4bf3aad2d`; `after-native-verified.json` / `after-native-timings.json`.
- `holdout-notepad`: `cd028729-efed-49cd-8845-a82403324cf1`; `holdout-notepad-verified.json` / `holdout-notepad-timings.json`.
- `holdout-native`: `86ff4dee-bf3f-4b74-b2ed-93c9bbcd0b6a`; `holdout-native-verified.json` / `holdout-native-timings.json`.

Source: `D:\CodeBuddy-v1`, main@4c8afad978b6e893a3545c0859dd5b4824a91223 with uncommitted changes. Native `0.2.3-local.22`, SHA256 `c83699118497c15d7bf09284142266d85e02116c436dcb219238bfb3737ef827`.

Artifacts: `.local/windows-controls-20261118/` (results.csv/json, comparison.png, accuracy.png, manifest.json, run-notes.json, logs and per-session receipts).
