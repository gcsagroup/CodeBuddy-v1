# Supported Harness product entry points. Legacy Rust Agent build/release recipes were retired.
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

default:
    @just --list

run-ui:
    node scripts/start-harness-preview.cjs

run-ui-only: run-ui

run-ui-windows: run-ui

run-server:
    node runtime/server.mjs

build-tools:
    cargo build --offline -p goose-mcp --features rustls-tls --bin codebuddy-tools --jobs 1

test-tools:
    cargo test --offline -p goose-mcp --features rustls-tls --jobs 1
    cargo clippy --offline -p goose-mcp --features rustls-tls --all-targets --jobs 1 -- -D warnings

check-everything:
    cargo fmt --all --check
    just test-tools
    node --test runtime/harness/test/*.test.mjs runtime/tests/*.test.mjs

generate-acp-types:
    cd ui/sdk && node --import tsx generate-schema.ts
    cd ui/sdk && node ../node_modules/prettier/bin/prettier.cjs --write src/generated

check-acp-schema: generate-acp-types
    git diff --exit-code -- ui/sdk/src/generated

build-sdk:
    cd ui/sdk && node ../node_modules/typescript/bin/tsc

make-ui-windows:
    node scripts/build-harness-windows.cjs
