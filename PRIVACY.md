# Privacy Policy — Barrel Vision

_Last updated: 2026-06-23_

Barrel Vision is a browser extension that overlays Baseball Savant contact-quality metrics onto ESPN
Fantasy Baseball pages. It is designed to collect as little as possible.

## What the extension does

- **Reads player names from the ESPN page you are viewing**, locally in your browser, to match them
  against public baseball statistics. This text is used in-page only and is never transmitted anywhere.
- **Fetches public baseball data** with anonymous `GET` requests to:
  - `baseballsavant.mlb.com` (Statcast leaderboards, CSV)
  - `statsapi.mlb.com` (MLB roster + game logs, JSON)
- **Stores two things in your browser** via the extension storage API:
  - a **cache** of the fetched public stats (so it doesn't re-download constantly), and
  - your **highlight-threshold preferences** and the debug toggle.

## What the extension does NOT do

- It does **not** collect, transmit, sell, or share any personal information.
- It does **not** use analytics, trackers, cookies, ads, or any third-party telemetry.
- It does **not** read, store, or transmit anything from your ESPN account or session — no login
  details, no league data, nothing.
- It has **no backend server**. The only network requests are the two public MLB data endpoints above.
- It contains **no remote code** — all logic ships inside the extension package.

## Data storage & control

The cache and your preferences live only on your device (and, for preferences, in your browser's own
sync if you have browser sync enabled). You can clear them at any time by removing the extension or
clearing its storage from your browser's extension settings.

## Permissions

- `storage` — to hold the local cache and your preferences.
- Host access to `baseballsavant.mlb.com` and `statsapi.mlb.com` — to fetch the public stats shown in
  the overlay. The extension requests no access to ESPN or any other site's data.

## Contact

Questions: mike.beardsley24@gmail.com

Barrel Vision is not affiliated with, endorsed by, or sponsored by ESPN or MLB. "Baseball Savant" and
"Statcast" are properties of MLB Advanced Media.
