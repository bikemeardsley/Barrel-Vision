# Privacy Policy — Barrel Vision

_Last updated: 2026-06-25_

Barrel Vision is a browser extension that overlays Baseball Savant contact-quality metrics onto ESPN
Fantasy Baseball pages. It is designed to collect as little as possible.

## What the extension does

- **Reads player names from the ESPN page you are viewing**, locally in your browser, to match them
  against public baseball statistics. This text is used in-page only and is never transmitted anywhere.
- **Fetches public baseball data** with anonymous `GET` requests to:
  - `baseballsavant.mlb.com` (Statcast leaderboards, CSV)
  - `statsapi.mlb.com` (MLB roster, handedness, and pitcher game logs for Quality Starts, JSON)
  - `pitcherlist.com` (the public weekly starting-pitcher, reliever, and hitter ranking articles — only
    the factual rank/name/team/tier are read; the written analysis is not stored)
  - `razzball.com` and `rotoballer.com` (optional alternative sources for the weekly starting-pitcher
    ranks — fetched only when you select that source in the popup; again, only the rank/name/team)
- **Stores its data in your browser** via the extension storage API:
  - a **local cache** of the fetched public stats and rankings (so it doesn't re-download constantly), and
  - your **highlight-threshold preferences**, the **on/off** state, and the debug toggle.

## What the extension does NOT do

- It does **not** collect, transmit, sell, or share any personal information.
- It does **not** use analytics, trackers, cookies, ads, or any third-party telemetry.
- It does **not** read, store, or transmit anything from your ESPN account or session — no login
  details, no league data, nothing.
- It does **not** track your browsing. The on/off toolbar icon is lit only on ESPN Fantasy Baseball
  pages; Chrome evaluates that rule internally (via `declarativeContent`), so the extension never
  receives your tab URLs or history.
- It has **no backend server**. The only network requests are the public data sources above.
- It contains **no remote code** — all logic ships inside the extension package.

## Data storage & control

The cache, rankings, and your preferences live only on your device (and, for preferences and the on/off
state, in your browser's own sync if you have browser sync enabled). You can clear them at any time by
removing the extension or clearing its storage from your browser's extension settings.

## Permissions

- `storage` — to hold the local cache and your preferences.
- `declarativeContent` — to light up the toolbar icon only on ESPN Fantasy Baseball pages, without the
  extension ever reading your tab URLs.
- `contextMenus` — to add the right-click "Enable Barrel Vision" on/off toggle to the toolbar icon.
- Host access to `baseballsavant.mlb.com`, `statsapi.mlb.com`, `pitcherlist.com`, `razzball.com`, and
  `rotoballer.com` — to fetch the public stats and rankings shown in the overlay (Razzball and RotoBaller
  only when chosen as the starting-pitcher rank source). The extension requests no access to ESPN or any
  other site's data.

## Contact

Questions: mike.beardsley24@gmail.com

Barrel Vision is not affiliated with, endorsed by, or sponsored by ESPN, MLB, Pitcher List, Razzball, or
RotoBaller. "Baseball Savant" and "Statcast" are properties of MLB Advanced Media.
