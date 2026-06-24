# Barrel Vision

A lightweight Chrome extension that overlays **Baseball Savant contact-quality metrics** directly onto
**ESPN Fantasy Baseball** — inline with ESPN's own stats, on roster/list views and in the player-card
popup. No more tab-switching to Savant to read a player.

Built as a **buildless, vanilla Manifest V3** extension (no framework, no bundler) — fully auditable,
which matters because it runs on an authenticated ESPN session. It is a faithful port of a working
Tampermonkey userscript (kept in [`userscript/`](userscript/) as the origin artifact).

> Scope: a *lightweight overlay*, not an analytics warehouse. It surfaces current-season metrics next
> to players. The deeper evaluation framework these metrics serve lives in
> [`docs/fantasy_baseball_standards.md`](docs/fantasy_baseball_standards.md).

---

## What it shows

**Hitters:** barrel%, hard-hit%, xwOBA, the **xwOBA−wOBA gap** (derived), avg EV, bat speed, squared-up%.
**Pitchers:** xERA, the **ERA−xERA gap** (derived), opponent xwOBA, opponent barrel%, opponent hard-hit%.

It also:
- **Shades** ESPN's own OPS (hitters) and ERA/WHIP (pitchers) with the same threshold gradient.
- Adds **batting/throwing handedness** from the MLB StatsAPI ("Milwaukee Brewers • Righty").
- In the player card, **condenses** columns (OBP+SLG → OPS, W+L → QS) and adds an **Advanced Stats**
  table plus a **Savant Page** link.
- Highlights every metric cell: **red = better than your threshold, blue = worse**, deeper shade =
  further from the threshold.

Players are joined by **normalized name** (accents/suffixes/punctuation stripped), so there's no
external ID crosswalk to maintain. Unmatched players show blank cells.

---

## Install (developer / unpacked)

This is buildless — there is nothing to compile.

1. Clone or download this repo.
2. Open `chrome://extensions` and enable **Developer mode** (top right).
3. Click **Load unpacked** and select the **`src/`** folder (the extension root — `manifest.json` lives
   there).
4. Visit `https://fantasy.espn.com/baseball/…` and open your team/roster. The metric columns appear in
   the scrolling stats panel.

Set your highlight thresholds from the **toolbar popup** (click the Barrel Vision icon). Changes apply
live — no reload.

> Toolbar icon: the manifest ships **without** an `icons` block so it loads cleanly with Chrome's
> default icon. To add a designed icon, drop PNGs in [`src/icons/`](src/icons/) and follow
> [`src/icons/README.md`](src/icons/README.md).

---

## How it works (architecture)

```
content.js (espn.com)  ──GET_INDEX──▶  background.js (service worker)
   reads ESPN DOM, injects               check storage.local cache (12h TTL)
   columns + shading, observer           miss → fetch Savant CSV + StatsAPI JSON
   reads prefs from storage.sync         parse → merge feeds → derive Gap
   recolors live on storage change       cache to storage.local
       ◀──────── {indexes, counts} ──────┘

popup.html/js  ── thresholds → storage.sync → content re-shades live
               ── "Refresh Savant data" → SW rebuild → live adopt
```

- **The service worker does all cross-origin fetching.** In MV3 a content script's `fetch` is bound to
  the page's (espn.com) origin for CORS and can't reach Savant/StatsAPI; the background worker holds the
  `host_permissions` that grant it. Content ↔ worker communicate via `chrome.runtime` messages.
- **One shared core** ([`src/shared/core.js`](src/shared/core.js)) holds the config + pure helpers used
  by all three contexts (worker, content script, popup), loaded via `importScripts` / the content-script
  list / a `<script>` tag respectively.
- **Live re-shading** uses `chrome.storage.onChanged`: every shaded cell carries its key + raw value, so
  a prefs change just restains in place — no reload (the userscript reloaded on save).

Full design notes, data-flow diagram, and the decision log are in
[`docs/PROJECT_BARREL_VISION.md`](docs/PROJECT_BARREL_VISION.md).

---

## Permissions & privacy

Minimal by design:

| Permission | Why |
|---|---|
| `storage` | cache the parsed Savant/StatsAPI data (local) and your threshold prefs (sync) |
| `host_permissions: baseballsavant.mlb.com` | fetch the public Savant CSV leaderboards |
| `host_permissions: statsapi.mlb.com` | fetch the public MLB StatsAPI roster (handedness) |

- **No host permission for espn.com** — the content script is injected via `content_scripts.matches`,
  which needs none.
- No `tabs`, no `<all_urls>`, no remote code, no analytics, no network calls beyond two public read-only
  GET endpoints. Nothing from your ESPN session is sent anywhere.

---

## Data sources & verified quirks

Five public Baseball Savant CSV leaderboards + one MLB StatsAPI JSON call. Headers were verified
against the live feeds (2026 in-season). Two counterintuitive quirks are handled deliberately and
annotated in the code so they don't get "corrected" later:

- **The published `est_woba_minus_woba_diff` has the opposite sign to its name** (it's `woba − est_woba`).
  Barrel Vision **derives** the gap as `est_woba − woba` (positive = underperforming = buy-low). Reading
  the published column would invert the feed.
- **bat-tracking `squared_up_per_swing` is a 0–1 fraction** (×100 for display) and keys on `id`/`name`,
  unlike the other feeds.

See [`docs/PROJECT_BARREL_VISION.md` §5](docs/PROJECT_BARREL_VISION.md) for the full table.

---

## Repo layout

```
src/         the MV3 extension (load this folder unpacked)
userscript/  the origin Tampermonkey userscript (v0.8.8), kept for provenance
docs/        project design doc + the fantasy evaluation framework
```

---

## Status

`v0.9.0` — data layer and DOM logic ported and verified; **in-browser visuals** (modal layout, shading,
handedness placement, ESPN-blended styling) want an eyeball on first load against the live ESPN DOM. See
the verify checklist in [`docs/PROJECT_BARREL_VISION.md` §9](docs/PROJECT_BARREL_VISION.md).

## License

[MIT](LICENSE) © Mike Beardsley. Not affiliated with ESPN or MLB. "Baseball Savant" and "Statcast" are
properties of MLB Advanced Media.
