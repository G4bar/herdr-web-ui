### Added
- `POST /api/web-panel/open` shows a page in the browser's side panel: an agent, a script or
  `scripts/open-panel.sh <url> [label]` sends an http or https address and gets back how many open
  browser pages took it. Nothing is queued, so a page opened later does not show it. The panel's own
  rules still apply: an address it cannot frame opens in a new tab instead, and a hidden tab opens
  nothing.

### Changed
- With the app on https, a page served on the PC itself (`localhost:5173` and the like) now opens in
  the side panel over the app's own https instead of a new tab, for the local setup that serves that
  port the same way.
