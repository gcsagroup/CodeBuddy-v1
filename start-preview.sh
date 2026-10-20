#!/bin/bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"
exec "${CODEBUDDY_NODE:-node}" "$repo_root/scripts/start-harness-preview.cjs"
