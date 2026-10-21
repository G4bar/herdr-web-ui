#!/usr/bin/env bash
# Ask the herdr web UI to show a page in its browser side panel.
#   scripts/open-panel.sh <url> [label]
# Prints one line and exits 0 when a browser page has the app open and took the page, 3 when none did
# (no page open, no server, or a refused request) and 2 when the arguments are wrong. It asks; a page
# still decides (a page the panel cannot frame opens in a new tab, a hidden tab opens nothing), so the
# URL is always printed and a caller can fall back to a plain link.
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

# The token the app asks for: this environment, else the plugin's own env file. That file is
# KEY=value lines, never a script: read the one line instead of running it, so nothing it holds is
# printed or executed.
token=${HERDR_WEB_TOKEN:-}
if [ -z "$token" ]; then
  config=${XDG_CONFIG_HOME:-$HOME/.config}
  env_file=$config/herdr/plugins/config/devswha.herdr-web-ui/env
  if [ -r "$env_file" ]; then
    token=$(sed -n 's/^HERDR_WEB_TOKEN=//p' "$env_file" | head -n 1 | tr -d '\r')
    token=${token#\"}; token=${token%\"}
    token=${token#\'}; token=${token%\'}
  fi
fi
# one line of a header file: whitespace or a quote would end the line or start another one
case $token in
  *[[:space:]\"\']*) token="" ;;
esac

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

# The token goes in on stdin, never on the command line: `-H "authorization: Bearer …"` would show
# it in `ps` to every other process of this PC while the request is pending. No Origin and no
# Sec-Fetch-Site either: this is a script, not a browser.
response=$(printf 'header = "authorization: Bearer %s"\n' "$token" | curl -sS --max-time 3 -K - \
  -X POST "$base/api/web-panel/open" -H "content-type: application/json" \
  --data "$body" 2>/dev/null) || response=""

case $response in
  *'"delivered":0'*) ;;
  *'"delivered":'*) printf 'Sent to the panel: %s\n' "$url"; exit 0 ;;
esac
printf 'Panel not available. Open: %s\n' "$url"
exit 3
