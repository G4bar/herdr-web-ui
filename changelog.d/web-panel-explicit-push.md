### Fixed
- A page an agent pushes with `POST /api/web-panel/open` now always opens in the side panel, whatever
  **Settings → Chat → Web links** says: that setting is about the links you click, and the push asked
  for the panel itself. A page the panel cannot frame, or a window too narrow for the panel, still
  opens in a new tab.
- Pushing the page the panel already shows now loads it again, so a page that changed since (a plan
  whose feedback was sent) is fetched again instead of the stale frame staying on screen.
