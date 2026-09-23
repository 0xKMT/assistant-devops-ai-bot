#!/bin/sh
# Maps Docker secret files into the gateway process environment, then replaces
# the shell with tini so signals and child-process reaping work correctly.
set -eu

load_secret() {
  name="$1"
  file="$2"
  if [ -r "$file" ]; then
    value=$(cat "$file")
    if [ -n "$value" ]; then export "$name=$value"; fi
  fi
}

# Values exist only in the process environment; secret files are never copied
# into the image or Friday source tree.
load_secret FRIDAY_GATEWAY_TOKEN /run/secrets/friday_gateway_token
for account in $(jq -r '.slack.accounts[].accountId' /opt/friday/config/instance.json); do
  stem=$(printf '%s' "$account" | tr '[:upper:]-' '[:lower:]_')
  bot_env=$(jq -r --arg id "$account" '.slack.accounts[] | select(.accountId == $id) | .botTokenEnv' /opt/friday/config/instance.json)
  app_env=$(jq -r --arg id "$account" '.slack.accounts[] | select(.accountId == $id) | .appTokenEnv' /opt/friday/config/instance.json)
  load_secret "$bot_env" "/run/secrets/friday_slack_${stem}_bot_token"
  load_secret "$app_env" "/run/secrets/friday_slack_${stem}_app_token"
done
jira_env=$(jq -r '.jira.apiTokenEnv' /opt/friday/config/instance.json)
load_secret "$jira_env" /run/secrets/friday_jira_api_token

if [ "${FRIDAY_OBSERVABILITY:-0}" = "1" ]; then
  node /opt/friday/source/scripts/render-observability-config.mjs \
    /home/node/.openclaw/openclaw.json /tmp/openclaw-observability.json
  export OPENCLAW_CONFIG_PATH=/tmp/openclaw-observability.json
fi

exec tini -s -- "$@"
