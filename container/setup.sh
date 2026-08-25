#!/bin/sh
# Coordinates image build, optional backend login and container bootstrap.
# Dry-run remains the default; --apply is forwarded only after validation.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
apply=0
login=0
backend=codex

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --login) login=1 ;;
    --backend)
      shift
      backend=${1:-}
      case "$backend" in codex|claude-code) ;; *) echo "Backend must be codex or claude-code." >&2; exit 2 ;; esac ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

dc() {
  sh container/compose.sh --profile tools "$@"
}

# Phase 1: initialize local operator files, validate Compose, build the image and
# run the same bootstrap in preview mode before checking backend consistency.
node scripts/container-init.mjs
dc config --quiet
dc build friday-gateway
if [ "$apply" -ne 1 ]; then
  dc run --rm friday-cli node \
    /opt/friday/source/scripts/container-bootstrap.mjs \
    --config /opt/friday/config/instance.json
fi

configured_backend=$(dc run --rm --entrypoint node friday-cli -e \
  "const c=require('/opt/friday/config/instance.json'); process.stdout.write(c.modelBackend.profile)" \
  | tail -n 1)
if [ "$configured_backend" != "$backend" ]; then
  echo "--backend $backend does not match instance profile $configured_backend." >&2
  exit 1
fi

# Phase 2 (optional): login writes only to the persistent Friday home volume.
if [ "$login" -eq 1 ]; then
  sh container/login.sh "$backend"
fi

# Preview is the default stopping point; everything below mutates runtime state.
if [ "$apply" -ne 1 ]; then
  echo "Container build and dry-run passed. Add --login --backend $backend --apply when ready."
  exit 0
fi

# Phase 3: fail before backup/apply unless every mounted secret has content.
if [ ! -s "container/secrets/gateway-token" ]; then
  echo "Missing secret value: container/secrets/gateway-token" >&2
  exit 1
fi
if ! sh container/render-secrets.sh --require-files; then
  exit 1
fi

# Phase 4: back up existing state, apply generated artifacts, start the gateway
# and require deep health checks before reporting success.
sh container/backup.sh --allow-empty
dc run --rm friday-cli node \
  /opt/friday/source/scripts/container-bootstrap.mjs \
  --config /opt/friday/config/instance.json \
  --apply
dc up -d friday-gateway
sh container/health.sh
echo "Friday Container Edition setup completed. Run docs/ACCEPTANCE.md before production use."
