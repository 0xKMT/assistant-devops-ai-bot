#!/bin/sh
# Creates a point-in-time archive of the persistent OpenClaw home volume.
# An empty/uninitialized volume is rejected unless --allow-empty is explicit.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
allow_empty=0
if [ "${1:-}" = "--allow-empty" ]; then allow_empty=1; fi

dc() {
  sh container/compose.sh --profile tools "$@"
}

mkdir -p container/backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="friday-home-${stamp}.tgz"

# Refuse to create a misleading empty backup during normal operation. Initial
# setup may opt into --allow-empty so the same orchestration stays idempotent.
if ! dc run --rm friday-cli sh -lc 'test -d /home/node/.openclaw'; then
  if [ "$allow_empty" -eq 1 ]; then
    echo "No prior OpenClaw state exists; backup skipped."
    exit 0
  fi
  echo "No OpenClaw state exists to back up." >&2
  exit 1
fi

# The tools container sees the same named home and backup volumes as the gateway,
# so archiving requires no host access to files inside the volume.
dc run --rm friday-cli tar -czf "/backup/$name" -C /home/node .
chmod 600 "container/backups/$name"
echo "Backup created: container/backups/$name"
