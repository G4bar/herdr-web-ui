### Added
- `POST /api/web-panel/open` asks the browser to show a page in its side panel: an agent, a script or
  `scripts/open-panel.sh <url> [label]` sends an http or https address and gets back how many browser
  pages have this app open and took it. It is a request, not a promise: nothing is queued for a page
  that opens later, an address the panel cannot frame opens in a new tab, a hidden tab opens nothing,
  and only a page of the PC the app runs on is shown. The script passes the token on stdin, so it
  never appears on the command line.

### Changed
- With the app on https, a page served on the PC itself (`localhost:5173` and the like) now opens in
  the side panel over the app's own https, when that host serves the port too, instead of a new tab.
  The app's own port is not such a page, and an app reached at a loopback address keeps to a tab.
