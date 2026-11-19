# CUA local deployment assessment and API verification

Date: 2026-11-17. Source: `D:\CodeBuddy-v1`, `main@4c8afad978b6e893a3545c0859dd5b4824a91223`, with existing uncommitted changes. No branch switch, commit, packaging, or user model-setting changes were made.

## Decision

Retain the configured remote API at `http://192.168.9.101:8001`, model `CUA-S1-Qwen3.5-4B`. The primary model remains `deepseek-v4.1-flash:1017`; its reasoning setting was not changed. CUA provides image observations without desktop tools. The primary model judges the task and the existing MCP executes actions.

System RAM is sufficient to attempt Q4 CPU inference, but local inference was not completed. This does not prove that the hardware cannot run the model, nor does it establish a usable local deployment. GPU runtime detection and download throughput prevented qualification, so the user's authorized API alternative remains active.

## Verified hardware and artifacts

- Ryzen 7 4800H; approximately 31.37 GiB physical RAM, 10.38 GiB available at inspection.
- GTX 1650 Ti, 4,096 MiB VRAM, 519 MiB used; NVIDIA driver 457.49.
- Approximately 82.13 GiB free on D:.
- Installed Ollama 0.40.16, bundled llama-server 0.9.0-dev, commit `6c01da627`.
- [Requested model repository](https://huggingface.co/GCSA-AiLab/cua-s1-4b-0.2-GGUF-MLX/tree/main/GGUF), pinned revision `01b53a83a8d492000e83ce69835d4c21c6c09be7`.
- Q4_K_M: 2,741,242,176 bytes; matching F16 mmproj: 672,423,392 bytes; total 3.18 GiB. Runtime buffers and context storage require additional memory; artifact size alone does not establish full GPU fit.
- The multimodal LoRA is already merged, including visual weights. Use the repository's matching projector. MLX targets Apple Silicon; Windows should evaluate GGUF. The repository declares Apache-2.0; preserve licenses and attribution when distributing. Its simple image checks do not establish full quantized computer-use performance.

## Local qualification limits

Installed Ollama GPU discovery hit its watchdog timeout and selected CPU, reporting `total_vram=0 B`. [Official hardware documentation](https://docs.ollama.com/gpu) lists GTX 1650 Ti but requires NVIDIA driver 550 or newer; the installed driver does not meet this requirement. This is a current environment result, not a claim that this GPU can never work. No driver upgrade was performed.

The official download and a mirror range probe ran at approximately 0.1 MB/s. Full weights were not downloaded. Transfers were stopped and incomplete files retained as `.part`; these are neither loadable models nor checksum-verified artifacts. Ollama processes started by this assessment were stopped. Local cold start, peak memory, latency, and recognition quality remain unmeasured; no estimated values are presented as benchmark results.

Future local qualification requires the complete pinned files, SHA-256 verification, and the same screenshot comparisons before connecting through the existing provider mechanism. [llama.cpp's multimodal interface](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md) supports paired model/projector files and a compatible API; another agent core is unnecessary.

## Real remote calls

The current CodeBuddy VisionRouting and Harness processed fixed screenshots, with one uncached request and one identical-image reuse in the same turn per case:

| Screenshot | Initial call | Cache reuse |
| --- | ---: | ---: |
| Notepad | 9.79 s | 0.26 ms |
| Calculator | 17.68 s | 0.54 ms |
| Customer form | 8.58 s | 0.24 ms |

All three responses contained the expected key values; all three identical-image requests reused observations. This is not 100% overall visual accuracy, three fresh desktop task runs, or full Windows acceptance. Outputs still contain redundant details and unsupported inferences, which must not establish action completion. Cache timing excludes screenshot capture and primary-model judgment.

The remote inventory advertises CUA, vLLM, 65,536 context, and a W8A16 deployment path. The user identifies this deployment as derived from the supplied model. No weight checksum was exposed; remote W8A16 and local GGUF Q4 are not established as identical quantized files.

Node 24 ran distribution-model, vision-routing, vision-routing-harness, vision-routing-acp, and mcp-vision test targets: 39 passed, exit 0. `node .local/cua-local-20261117/verify-api.mjs` completed three real calls, exit 0.

Evidence: `D:\CodeBuddy-v1\.local\cua-local-20261117\` contains `remote-api-result.json`, `remote-api.log`, `routing-tests.log`, `ollama-discovery.log`, and `verify-api.mjs`. The API configuration already existed. No duplicate provider, user-setting overwrite, or local evidence commit was introduced.
