# Kotlin/JVM GDK smoke test

This is a small downstream Kotlin/JVM app that consumes the Maven artifact
`io.github.aaif-goose:gdk` from `mavenLocal()`.

From the repository root, first build and publish the Maven artifact locally:

```bash
source bin/activate-hermit
just --justfile crates/goose-sdk/justfile maven-package
```

Then run the smoke test:

```bash
cd crates/goose-sdk/examples/uniffi/kotlin
gradle --no-daemon run --args='../../local_mock.json'
```

Start an anonymous OpenAI-compatible mock server on `127.0.0.1:8000` first.
The example loads `../../local_mock.json`; it reads no API key and cannot contact
a real inference provider. The expected output is the mock's streamed response
followed by optional usage metadata. The important native-packaging failure to
watch for is `UnsatisfiedLinkError` or a missing library resource.

The example sets `--enable-native-access=ALL-UNNAMED` because JNA loads the
bundled Goose native library. Newer JDKs warn when native access is not enabled
explicitly, and future JDKs may require it.
