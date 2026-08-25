#!/bin/sh
# Renders the ignored account-secret Compose override immediately before every
# Compose command so secret mounts always match the instance configuration.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

sh container/render-secrets.sh

exec docker compose --env-file container/.env \
  -f compose.yaml \
  -f build/container-secrets.compose.yaml \
  "$@"
