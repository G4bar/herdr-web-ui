#!/usr/bin/env bash
# Ask the herdr web UI to show a page in its browser side panel.
#   scripts/open-panel.sh <url> [label]
# Prints one line and exits 0 when a browser took the page, 3 when none did (no app open, no server,
# or a refused request) and 2 when the arguments are wrong. The URL is always printed, so a caller
# can fall back to a plain link.
set -euo pipefail

usage() {
  printf '%s\n' "usage: $(basename "$0") <url> [label]" >&2
  exit 2
}

[ $# -ge 1 ] || usage
[ $# -le 2 ] || usage
url=$1
label=${2:-}

base=${HERDR_WEB_URL:-http://127.0.0.1:7317}
base=${base%/}

# The token the app asks for: this environment, else the plugin's own env file, read in a subshell
# so nothing it holds is ever printed.
token=${HERDR_WEB_TOKEN:-}
if [ -z "$token" ]; then
  config=${XDG_CONFIG_HOME:-$HOME/.config}
  env_file=$config/herdr/plugins/config/devswha.herdr-web-ui/env
  if [ -r "$env_file" ]; then
    # shellcheck source=/dev/null
    token=$(set -a; . "$env_file" >/dev/null 2>&1; printf '%s' "${HERDR_WEB_TOKEN:-}")
  fi
fi

# a URL holds no quote or backslash the server would accept, but keep the body valid JSON anyway
url_json=${url//\\/\\\\}
url_json=${url_json//\"/\\\"}
body="{\"url\":\"$url_json\""
if [ -n "$label" ]; then
  label_json=${label//\\/\\\\}
  label_json=${label_json//\"/\\\"}
  body=$body",\"label\":\"$label_json\""
fi
body=$body"}"

# No Origin and no Sec-Fetch-Site: a script, not a browser (the server allows that on this route only).
response=$(curl -sS --max-time 3 -X POST "$base/api/web-panel/open" \
  -H "authorization: Bearer $token" -H "content-type: application/json" \
  --data "$body" 2>/dev/null) || response=""

case $response in
  *'"delivered":0'*) ;;
  *'"delivered":'*) printf 'Opened in panel: %s\n' "$url"; exit 0 ;;
esac
printf 'Panel not available. Open: %s\n' "$url"
exit 3
