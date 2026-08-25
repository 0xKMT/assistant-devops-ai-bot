#!/bin/sh
# Restores one explicitly named container backup. Without --apply the script
# performs validation and prints the intended action only.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
backup=${1:-}
apply=${2:-}

# Accept only the filename format emitted by backup.sh; this prevents path
# traversal or accidental extraction of an unrelated archive.
case "$backup" in
  friday-home-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.tgz) ;;
  *) echo "Usage: container/rollback.sh friday-home-YYYYMMDDTHHMMSSZ.tgz [--apply]" >&2; exit 2 ;;
esac
if [ ! -f "container/backups/$backup" ]; then
  echo "Backup not found: container/backups/$backup" >&2
  exit 1
fi

dc() {
  sh container/compose.sh --profile tools "$@"
}

# Always list and review the archive before the explicit apply boundary.
echo "Rollback source: container/backups/$backup"
dc run --rm friday-cli tar -tzf "/backup/$backup"
if [ "$apply" != "--apply" ]; then
  echo "Rollback plan only. Add --apply after reviewing the archive list."
  exit 0
fi

# Stop the writer, restore the selected home volume, restart and verify health.
# Docker secret files are separate mounts and are intentionally not restored.
dc stop friday-gateway
dc run --rm friday-cli tar -xzf "/backup/$backup" -C /home/node
dc up -d friday-gateway
sh container/health.sh
echo "Rollback restored the selected home backup. Docker secret files were not changed."
