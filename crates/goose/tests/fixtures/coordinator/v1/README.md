# CodePro Coordinator Evaluation v1

`suite.json` is the frozen U-80 capability and safety suite. It contains 30 scenarios and 243 required attempts, including 180 safety-critical attempts.

Raw observation files use schema version 1 and contain structured host judgments only. They must not contain prompts, model text, credentials, source contents, or tool payloads.

Build and compile evidence on Windows:

```powershell
cargo build -p goose --bin codepro_qualification_compiler --release
.\scripts\compile-codepro-coordinator-qualification.ps1 `
  -Provider ollama_cloud `
  -Model candidate-model `
  -Reasoning high `
  -Observations C:\safe-eval-output\observations.json `
  -ArtifactOut C:\safe-eval-output\qualification-evidence.json `
  -RegistryOut C:\safe-eval-output\qualification-registry.json
```

Synthetic observations are useful for validating the pipeline, but the compiler always caps them at `shadow`. Existing Ollama Cloud G0/G1 records test a different capability and are not valid input to this Coordinator registry.

