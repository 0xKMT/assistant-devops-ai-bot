#!/bin/sh
# Resolves the same local instance-config path that Compose uses, then renders
# the ignored per-account Docker-secret mapping. It never reads token values.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

instance_config=${FRIDAY_INSTANCE_CONFIG:-}
if [ -z "$instance_config" ] && [ -f container/.env ]; then
  instance_config=$(awk -F= '/^FRIDAY_INSTANCE_CONFIG=/{sub(/^[^=]*=/, ""); sub(/\r$/, ""); print; exit}' container/.env)
fi
: "${instance_config:=config/instance.container.json}"

exec node scripts/render-container-secrets.mjs \
  --config "$instance_config" \
  --output build/container-secrets.compose.yaml \
  "$@"
