# UniFFI examples

These examples exercise the in-process Goose SDK UniFFI bindings from Python and Kotlin.

## Prerequisites

```bash
source bin/activate-hermit
```

The Python example uses `examples/local_mock.json`, an anonymous loopback-only
OpenAI-compatible fixture. Start a local mock server on `127.0.0.1:8000` before
running it. The example neither reads an API key nor contacts a real provider.

The Kotlin/JVM Maven smoke test uses the same anonymous loopback fixture. It
does not read a provider key or contact an external inference endpoint.

## Generate bindings

Regenerate the Python bindings before running the Python example:

```bash
just --justfile crates/goose-sdk/justfile _generate python
```

This writes generated bindings and the debug native library under `crates/goose-sdk/generated/`.

## Python provider example

```bash
DYLD_LIBRARY_PATH=target/debug LD_LIBRARY_PATH=target/debug \
  uv run --script crates/goose-sdk/examples/uniffi/provider.py \
  crates/goose-sdk/examples/local_mock.json
```

## Kotlin/JVM Maven smoke test

Build the local Maven artifact and run the downstream smoke test app:

```bash
just --justfile crates/goose-sdk/justfile maven-package
cd crates/goose-sdk/examples/uniffi/kotlin
gradle --no-daemon run --args='../../local_mock.json'
```

Or run the same flow through the goose-sdk justfile:

```bash
just --justfile crates/goose-sdk/justfile kotlin
```

The Kotlin example consumes the local Maven artifact `io.github.aaif-goose:gdk` from `mavenLocal()` and imports the generated package namespace `io.github.aaif_goose`.

On newer JDKs, the example enables native access with `--enable-native-access=ALL-UNNAMED` because the SDK uses JNA to load the bundled native library.
