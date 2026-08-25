#!/bin/sh
# Verifies container state, HTTP liveness/readiness and deep OpenClaw config,
# model and Slack channel health from inside the running gateway.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
dc() {
  sh container/compose.sh --profile tools "$@"
}

dc ps friday-gateway
dc exec -T friday-gateway node -e \
  "fetch('http://127.0.0.1:18789/healthz').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(e=>{console.error(e);process.exit(1)})"
dc exec -T friday-gateway node -e \
  "fetch('http://127.0.0.1:18789/readyz').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(e=>{console.error(e);process.exit(1)})"
dc exec -T friday-gateway /opt/friday/bin/entrypoint node /app/openclaw.mjs config validate
dc exec -T friday-gateway /opt/friday/bin/entrypoint node /app/openclaw.mjs models status --check
dc exec -T friday-gateway /opt/friday/bin/entrypoint node /app/openclaw.mjs channels status --deep
echo "Friday container health checks passed."
