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

base=${OVIS_URL:-http://127.0.0.1:7317}
base=${base%/}

# The token the app asks for: this environment, else the plugin's own env files: `env` first, then
# `.env`, which wins, as scripts/plugin.ts reads them. Those files are KEY=value lines, never a
# script: read the one line instead of running it, so nothing they hold is printed or executed.
token=${OVIS_TOKEN:-}
if [ -z "$token" ]; then
  for dir in ${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/devswha.ovis ${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/devswha.herdr-web-ui; do
    for name in env .env; do
      [ -r "$dir/$name" ] || continue
      found=$(sed -n 's/^OVIS_TOKEN=//p' "$dir/$name" | head -n 1 | tr -d '\r')
      if [ -n "$found" ]; then token=$found; fi
    done
  done
  token=${token#\"}; token=${token%\"}
  token=${token#\'}; token=${token%\'}
fi
# one line of a header file: whitespace ends the line, and a quote or a backslash rewrites it, so a
# token like that is no token at all: ask nothing rather than send one that is not the app's
case $token in
  *[[:space:]\"\']* | *\\*) printf 'Panel not available. Open: %s\n' "$url"; exit 3 ;;
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
