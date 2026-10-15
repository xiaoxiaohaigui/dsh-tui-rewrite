#!/usr/bin/env bash
# One entry point for the headless verification.
#
#   bash test-harness/run.sh [session.v4.jsonl.zstd]
#
# Builds the resolution fixture (idempotent) then runs the suites. The fixture is
# what lets a bare `@deepseek-ai/...` import resolve from the plugin's real path,
# exactly as a package manager would lay it out.
#
# Nothing here proves the profile BOOTS the row into a live app: that is the
# on-device check recorded in docs/explore/phase0-results.md.
set -euo pipefail
cd "$(dirname "$0")/.."
echo '### resolution fixture'
node test-harness/build-fixture.mjs
echo
echo '### suites'
node --test "test-harness/test/*.test.mjs"
