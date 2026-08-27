#!/usr/bin/env bash
set -euo pipefail

dockerfile="${1:-docker/Dockerfile}"
test -f "$dockerfile"
grep -q '^ARG RAILWAY_SERVICE_NAME=web$' "$dockerfile"
grep -q '^FROM base AS web$' "$dockerfile"
grep -q '^FROM base AS worker$' "$dockerfile"
grep -q '^FROM base AS scanner$' "$dockerfile"
grep -q '^FROM base AS gateway$' "$dockerfile"
grep -q '^FROM \${RAILWAY_SERVICE_NAME} AS final$' "$dockerfile"
printf '%s\n' "tracked Railway Dockerfile target selection: PASS"
