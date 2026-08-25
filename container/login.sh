#!/bin/sh
# Runs the interactive model login in the persistent Friday home volume while
# ensuring the requested backend matches the rendered instance configuration.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
backend=${1:-}
case "$backend" in codex|claude-code) ;; *) echo "Usage: container/login.sh codex|claude-code" >&2; exit 2 ;; esac

dc() {
  sh container/compose.sh --profile tools "$@"
}

configured_backend=$(dc run --rm --entrypoint node friday-cli -e \
  "const c=require('/opt/friday/config/instance.json'); process.stdout.write(c.modelBackend.profile)" \
  | tail -n 1)
if [ "$configured_backend" != "$backend" ]; then
  echo "Requested backend $backend does not match instance profile $configured_backend." >&2
  exit 1
fi

if ! dc run --rm friday-cli gh auth status >/dev/null 2>&1; then
  dc run --rm friday-cli gh auth login
fi

primary_model=$(dc run --rm --entrypoint node friday-cli -e \
  "const c=require('/opt/friday/config/instance.json'); process.stdout.write(c.modelBackend.primaryModel)" \
  | tail -n 1)

if [ "$backend" = codex ]; then
  dc run --rm friday-cli node /app/openclaw.mjs plugins enable openai
  dc run --rm friday-cli node /app/openclaw.mjs models auth login --provider openai --set-default
else
  dc run --rm friday-cli claude auth login
  dc run --rm friday-cli claude auth status --text
  dc run --rm friday-cli node /app/openclaw.mjs plugins enable anthropic
  dc run --rm friday-cli node /app/openclaw.mjs models auth login --provider anthropic --method cli --set-default
fi

dc run --rm friday-cli node /app/openclaw.mjs models set "$primary_model"
dc run --rm friday-cli node /app/openclaw.mjs models status --check
echo "GitHub and $backend authentication completed in the persistent Friday home volume."
