# Barrel Vision — ESPN Fantasy Baseball Savant Overlay

**Status:** MV3 extension **v0.10.0** — a faithful, buildless port of the v0.8.8 Tampermonkey userscript,
now with Pitcher List weekly ranks. Vanilla Manifest V3 (no framework, no bundler), fully auditable. The
service worker fetches + parses the Baseball Savant CSV leaderboards, the MLB StatsAPI roster, **and the
Pitcher List weekly SP + closer rankings**, caches the merged index in `chrome.storage.local`; the
content script injects contact-quality columns into ESPN's scrolling stats panel + the player-card modal,
with per-column threshold shading, **and a "• PL #N" rank inline after a pitcher's handedness**; the
toolbar popup edits thresholds (persisted to `chrome.storage.sync`) and re-shades live via
`storage.onChanged` (no reload), **and holds a manual-paste fallback for the Pitcher List ranks**. All
five Savant feeds + StatsAPI re-verified live against 2026 in-season data during the port (incl. the two
sign quirks); the Pitcher List parser was validated against the live 2026 articles. **In-browser visuals
(modal layout, shading, handedness + PL# placement, ESPN-blended styling) still need an eyeball on first
load against the live ESPN DOM.**
**Owner:** Mike Beardsley
**League/Team context:** Pitch Clock Strikeouts / Pocket Pancakes (10-team auction, H2H categories)
**Repo:** github.com/bikemeardsley/barrel-vision

---

## 1. Purpose

ESPN Fantasy Baseball shows surface stats (HR, SB, OPS, etc.) but none of the contact-quality
metrics used to actually evaluate hitters. The goal is to see those metrics — barrel rate,
hard-hit rate, xwOBA, the xwOBA–wOBA gap, maxEV — **inline, alongside the ESPN stats**, so the
read-on-a-player happens in one place instead of tab-switching to Baseball Savant.

This is intentionally a *lightweight overlay*, not an analytics warehouse. It surfaces metrics next
to players; it does not attempt to reproduce the full evaluation framework in
`fantasy_baseball_standards.md` (year-over-year trends, BABIP-vs-career, the Gap Validation Layer).
Those need stored, joined, multi-season data and belong in a heavier build if ever pursued (see §12).

---

## 2. Decision log

- **Userscript first, MV3 extension second.** A Tampermonkey/Violentmonkey userscript got a working
  overlay with no build step and fully-auditable code — important on an authenticated ESPN session.
  Once behavior was dialed in (v0.8.8), it was ported to MV3. The extension is also a **portfolio /
  resume piece**, so the MV3 version is clean, buildless, and minimally-permissioned.
- **MV3 port = a context split, not a rewrite (v0.9.0).** The userscript's `GM_*` powers map onto MV3
  contexts: `GM_xmlhttpRequest` → cross-origin fetch in the **service worker** (the only context that
  inherits the extension's `host_permissions` for CORS; since Chrome 85 a content script's fetch is
  bound to the page's origin and cannot reach Savant/StatsAPI). `GM_addStyle` → a `content_scripts`
  CSS file. `localStorage` cache → `chrome.storage.local`. The floating-gear settings → the toolbar
  popup, with prefs in `chrome.storage.sync` and live re-shading via `storage.onChanged` (dropping the
  userscript's reload-on-save). See §3.
- **One shared core, no bundler.** `src/shared/core.js` holds everything used in 2+ contexts (CONFIG,
  `normName`, formatters, `cellColor`, `handWord`, `defaultPrefs`) and assigns to `globalThis.BV`. It
  is loaded by the SW via `importScripts`, by the content script as the first entry in the
  `content_scripts` js list, and by the popup via `<script src>`. **HARD RULE:** CONFIG carries real
  functions (`fmt`/`derive`/`cellColor`), and functions are silently dropped by JSON serialization, so
  CONFIG is shared only by loading the file — it is never message-passed or stored. The wire/cache
  carry plain data only.
- **Minimal permissions.** `permissions: ["storage"]`; `host_permissions` only
  `baseballsavant.mlb.com` + `statsapi.mlb.com` (read-only, public, GET). **No espn.com host
  permission** — the content script is injected via `content_scripts.matches`, which needs none; only
  cross-origin fetch needs host permission, and that happens in the SW. No `tabs`, no `<all_urls>`, no
  remote code, no analytics.
- **Join strategy: normalized name match, not the SFBB ID crosswalk.** Matching ESPN players to Savant
  by normalized name (team as tiebreaker) drops an entire external dependency. Tradeoff: occasional
  fuzzy-match misses shown as blank cells. The exact-ID upgrade via the SFBB map is a drop-in if needed.
- **Gap is derived, not read from the published column.** The expected-stats `est_woba_minus_woba_diff`
  column is computed as `woba − est_woba` despite its name — the *opposite* sign to this project's
  convention (xwOBA − wOBA, positive = production lagging contact quality = buy-low). Reading it
  directly would invert the feed, surfacing traps as buys. The Gap column derives `est_woba − woba`.
  **Re-verified live during the port:** James Wood `woba .400 / est_woba .433`, published diff `−.033`.
- **Pitcher ERA gap also derived (`era − xera`).** The pitcher feed's `era_minus_xera_diff` *is*
  correctly signed (verified: Alcantara `4.18 / 3.85 / +.33`), but the script derives it anyway to stay
  robust and explicit (positive = ERA worse than xERA = unlucky = buy).
- **Bat-tracking wired in (not deferred).** Its schema differs: keys on `id` (not `player_id`), name in
  a `name` field (same "Last, First" text), `squared_up_per_swing` a 0–1 fraction (`×100` to display).
  Only ~210 qualified batters appear, so BatSpd/SqUp% are intentionally blank for part-timers (absence
  = "not enough swings to confirm," itself signal). Optional feed: if it fails the other columns render.
- **Pitchers via `type=pitcher`; handedness via MLB StatsAPI.** The pitcher feeds carry **no
  handedness** (same as batter feeds) but add `era/xera/era_minus_xera_diff`. Throwing/batting hand
  comes from one public no-key StatsAPI call (`sports/1/players`), keyed by normalized name.
- **Pitcher List ranks: automated parse, with a manual-paste fallback (v0.10.0).** PL publishes its
  weekly SP "The List" (Top 100) and reliever "Top 50 Closers" as *articles*, not an API — so this was a
  verify-first call. **Verified against the live 2026 articles:** both rankings are a clean,
  server-rendered `<table class="list">` (`td.rank` / `td.name>a` / `td.team` / `span.tier`), present in
  the **raw HTML with no JS** (so the SW `fetch` reaches them; no headless browser). So Path A
  (automated) over Path B (manual): resolve the latest week's URL via the category **RSS feed** (newest
  `<link>` first; the category HTML index is the fallback), then **regex-parse** the first list table —
  a classic service worker has **no `DOMParser`**. Join by the existing `normName` (PL's name + slug both
  normalize to the same key; accents/apostrophes strip cleanly). **Gotcha worth recording:** an early
  readability-style fetch *reformatted the prose into tidy markdown tables and invented columns/lists* —
  only the raw HTML showed the true structure, so verify against `curl`, not a summarizer. Two
  brittleness guards: a **graceful skip** (a short parse → render nothing, never wrong ranks) and a
  **manual-paste override** in the popup (Path B) for any week the markup changes.
- **PL data is a flat `pl` index, not a `pit` column.** Like `hand`, the PL ranks are a flat
  `normName → { sp?, rp?, slug, tier, team }` map read directly by the content script and rendered
  *inline after handedness* — not a shaded table column. This also keeps it off the CSV `mergeFeeds`
  path, whose `/^\s*</` guard would (correctly) reject HTML. Weekly (7-day) cache, mirroring the
  per-pitcher QS cache. **Only factual rank+name+team+tier are taken — never the prose write-ups**
  (those stay on PL's site; the modal links back to `…/player/{slug}/` for attribution + traffic).
- **Prebuilt extensions evaluated and rejected.** The Chrome Web Store "ESPN Fantasy Baseball Advanced
  Statistics" lacks barrel rate; "FantasyLink" injects *links*, not metric columns. Net: DIY.

---

## 3. MV3 architecture & data flow

```
┌─ content.js (runs on fantasy.espn.com) ─────────────┐
│  reads ESPN DOM (names), looks up by normalized name │
│  injects columns + shading; MutationObserver         │
│  reads prefs from storage.sync; recolors on change   │
└───────────────┬──────────────────────────────────────┘
                │ chrome.runtime.sendMessage({type:'GET_INDEX'})        (content CANNOT fetch cross-origin)
                ▼
┌─ background.js (service worker, classic) ───────────────────────────────────┐
│  check chrome.storage.local cache (12h TTL)                                  │
│  miss → fetch CSV (savant) + JSON (statsapi)  ── host_permissions grant CORS │
│         parseCsv → mergeFeeds (per-feed id map) → Gap derived est_woba−woba  │
│         re-key by normalized name → write {ts, indexes} to storage.local     │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ {ok, indexes:{bat,pit,hand,pl}, counts}   (pl = Pitcher List ranks, weekly)
                ▼
        content.js renders + shades; "• PL #N" after handedness; HUD shows match counts

┌─ popup.html/js (toolbar action) ────────────────────────────────────────────┐
│  edit per-column thresholds → chrome.storage.sync  → content re-shades live   │
│  "Refresh Savant data" → {type:'REFRESH'} → SW rebuilds + rewrites cache →    │
│     content's storage.onChanged(local) adopts the fresh index and re-scans    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Why the SW fetches:** in MV3 a content script's `fetch` is subject to the *page's* (espn.com) CORS
and does not inherit `host_permissions`; the service worker does. So all cross-origin work is in the SW.

**SW is stateless / ephemeral.** It is killed after ~30s idle, so the only persisted state is the
parsed index in `chrome.storage.local`. The message listener is registered synchronously at the top
level (so a wake-up message is never missed) and is a non-async function that returns `true` and calls
`sendResponse` later (the universally-compatible async-response pattern; promise-returning listeners are
Chrome 148+ only). The content script retries `GET_INDEX` a few times to cover the SW wake-up race.

**Live re-shading.** Every shaded cell carries `data-savant-key` + `data-savant-val`, and the Savant
columns are always injected (only *shading* depends on prefs), so a prefs change just re-runs
`recolorAll()` over `td[data-savant-key]` (broadened from the userscript's `td.savant-col` so it also
restains ESPN's in-place-shaded OPS/ERA/WHIP cells). No re-scan, no reload.

**Storage:**
- `chrome.storage.sync` — `prefs` (per-column enabled+threshold) and `debug` (HUD toggle). Small,
  roams across the user's Chrome. Writes are debounced (250ms) to respect sync rate limits.
- `chrome.storage.local` — `barrelVision:index:v1:{year}` → `{ts, indexes}`. ~<1MB, well under the
  10MB quota (no `unlimitedStorage`).

**Internal DOM naming.** Injected classes/attributes keep the `savant-` prefix (`savant-col`,
`savant-hand`, `savant-adv`, `data-savant-key`, etc.) — they *are* Savant metrics, and keeping the
prefix avoids churn. The product name everywhere user-facing is Barrel Vision.

---

## 4. Repo layout / file manifest

```
barrel-vision/
├── src/                         ← THIS folder is the unpacked-extension root (Load unpacked → select src/)
│   ├── manifest.json            MV3; permissions [storage]; host_permissions savant + statsapi
│   ├── background.js            service worker (classic): fetch + parseCsv + mergeFeeds + cache + messaging
│   ├── content.js               DOM injection, observer, HUD, storage.onChanged → recolorAll
│   ├── content.css              overlay styles (the GM_addStyle subset that applies on ESPN)
│   ├── popup.html / popup.js / popup.css   thresholds UI + Refresh + debug toggle → storage.sync
│   ├── shared/core.js           CONFIG + normName + formatters + cellColor + handWord (globalThis.BV)
│   └── icons/                   PNG icons (currently README only; manifest ships no icons key so it loads)
├── userscript/
│   └── espn-savant-overlay.user.js   origin artifact, v0.8.8 (not part of the build)
├── docs/
│   ├── PROJECT_BARREL_VISION.md      this document
│   └── fantasy_baseball_standards.md the evaluation framework the metrics serve
├── README.md
├── LICENSE
└── .gitignore
```

Consequence of manifest-in-`src/`: a Chrome Web Store zip must zip the **contents of `src/`**, not the
repo root.

---

## 5. Data sources (verified headers)

All public, same MLBAM id-space. The two batted-ball feeds key on `player_id` and carry a
`"last_name, first_name"` column; bat-tracking keys on `id` with a `name` column (same "Last, First"
text). Headers below are the *actual* headers (re-verified live 2026, `min=10`).

| Feed | URL (batter; `min` = min batted-ball events) | Verified columns used |
|---|---|---|
| Exit Velocity & Barrels | `…/leaderboard/statcast?type=batter&year={Y}&position=&team=&min={MIN}&csv=true` | `brl_percent`, `ev95percent`, `avg_hit_speed`, `max_hit_speed` |
| Expected Statistics | `…/leaderboard/expected_statistics?type=batter&year={Y}&position=&team=&filter=&min={MIN}&csv=true` | `woba`, `est_woba`, `est_woba_minus_woba_diff` |
| Bat-Tracking (validation) | `…/leaderboard/bat-tracking?…&type=batter&year={Y}&csv=true` | `id`, `name`, `avg_bat_speed` (mph), `squared_up_per_swing` (**0–1 fraction**) |
| Exit Velocity (pitcher) | `…/leaderboard/statcast?type=pitcher&…&min={MIN}&csv=true` | same as batter EV, now contact **allowed** |
| Expected Statistics (pitcher) | `…/leaderboard/expected_statistics?type=pitcher&…&min={MIN}&csv=true` | batter columns **plus** `era`, `xera`, `era_minus_xera_diff` |
| Handedness | `statsapi.mlb.com/api/v1/sports/1/players?season={Y}` (JSON) | `fullName`, `batSide.code`, `pitchHand.code` (L/R/S), `primaryPosition`, `nameSlug` |
| Pitcher List ranks | weekly **article** on `pitcherlist.com`, latest URL via category **RSS** (`…/the-list/feed/`, `…/reliever-ranks/feed/`) | first `<table class="list">`: `td.rank`, `td.name>a` (name + `/player/{slug}/`), `td.team`, `span.tier` |

The pitcher feeds key on `player_id` and carry **no handedness column** — throwing hand needs StatsAPI.
There is no pitcher equivalent of the bat-tracking feed, so pitchers get no BatSpd/SqUp%.

**Pitcher List (HTML, not CSV/JSON).** Unlike the structured Savant/StatsAPI endpoints, PL is a weekly
article. The ranking itself is a clean server-rendered table (verified live 2026: SP "The List" = 100
rows; reliever "Top 50 Closers" = the *first* `<table class="list">`, before the Holds/SV+HLD tables).
The SW resolves the newest article via the RSS feed, then **regex-parses** the first list table (no
`DOMParser` in a classic worker), carrying the tier forward (PL labels only each tier's leading row).
Joined by `normName`. Best-effort with a graceful skip + a popup manual-paste fallback; weekly (7-day)
cache. **Extraction is minimal by design — ranks/names/teams/tiers only, never the prose write-ups.**

### Verified data quirks — DO NOT "fix" these

- **xwOBA–wOBA gap sign.** Published `est_woba_minus_woba_diff` = `woba − est_woba` (opposite of the
  name). The Gap column **derives** `est_woba − woba` (positive = underperforming = buy-low). Live
  check: Wood `woba .400 / est_woba .433` → published `−.033`, our Gap `+.033`.
- **ERA gap.** `era_minus_xera_diff` is correctly signed; we still derive `era − xera`. Live check:
  Alcantara `era 4.18 / xera 3.85` → `+.33`.
- **bat-tracking scaling.** `squared_up_per_swing` is a 0–1 fraction, rendered `×100` via `pctFrac`.
- **Percent-scaling.** Savant percent columns are already percent-scaled; EV is mph.

`MIN` is deliberately low (10) so part-time players and waiver targets appear — that pool is where the
Barrel Hunting value lives. (Bat-tracking has its own swing-count qualification and ignores `min`.)

---

## 6. Columns

- **Hitters (`bat`):** Brl%, HH%, xwOBA, Gap (derived), avgEV, BatSpd, SqUp%.
- **Pitchers (`pit`):** xERA, ERAgap (derived), oxwOBA, oBrl%, oHH% (the `o`-prefixed = contact
  allowed, lower is better).
- **ESPN stats shaded in place** (not Savant columns): OPS (hitters), ERA + WHIP (pitchers), via
  `shadeListColumn()` on lists and the condensed modal cells.

Table-kind routing reads ESPN's group banner (`thead th[title="Pitchers"]` / `"Batters"`) so two-way
Ohtani renders hitter columns in the Batters block and pitcher columns in the Pitchers block.

---

## 7. Highlighting + preferences

Per-column threshold shading on every Savant cell: red = better than the user's threshold, blue =
worse, gradient by distance (`scale`), capped. `dir` per column (`high`/`low`). Defaults in
`CONFIG.preferences`; user overrides persist to `chrome.storage.sync` and are merged onto defaults at
load (so new columns appear for existing users). xERA / ERA / WHIP default **OFF** with thresholds
pre-filled. Edited in the **toolbar popup** (Hitters / Pitchers sections, enable + threshold per
column, Reset to defaults, **Refresh advanced data** [Savant + StatsAPI], debug toggle, and a
collapsible **Pitcher List ranks** section with *Fetch latest ranks* + a manual override). Changes apply
live — no Save button, no reload.

---

## 8. Player-card modal

`decorateModal()` runs off the same observer. Adds handedness inline after the team name
("Milwaukee Brewers • Righty"); **condenses** ESPN's own columns in place (OBP+SLG → one OPS for
hitters, W+L → QS for pitchers — relabel the first, hide the second); and builds a standalone
**Advanced Stats** table beneath ESPN's Stats table (`buildAdvancedTable()`) with its own section
title, headers, a single shaded Season row, and a **Savant Page** link (`savant-player/{nameSlug}`) —
styled with ESPN's Table classes so it reads native. **QS source (v0.9.1):** QS (Quality Starts) is not
a field on Savant *or* StatsAPI, so the service worker **computes** it from the pitcher's StatsAPI
gameLog — a start with ≥6 IP and ≤3 ER — keyed by MLBAM id (carried on the hand index), cached per
pitcher. This replaced the earlier roster-list scrape, which read whatever stat window the list filter
was on (Season / Last 7 / 15 / 30 / Projected) and could therefore show a non-season value on the card.
The modal fills the Season-row QS asynchronously (`GET_QS` message) so it isn't blocked.

---

## 9. Build, install & verify

**Buildless** — no `npm install`, no compile step. To run:

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the **`src/`** folder.
3. Open `fantasy.espn.com/baseball/...` (your team/roster). Columns should appear in the scrolling
   stats panel where ESPN's Research columns were.

**Verify checklist (the in-browser unknowns):**
- Columns land cleanly in the scroller with the "Advanced" banner roughly aligned; data columns align
  cell-for-cell even if the banner is a touch off (cosmetic).
- Sort / filter / paginate a roster: metrics follow the right player (no stale rows), TOTALS/empty
  rows stay untouched.
- Open a player card: handedness line, condensed OPS (or QS), Advanced Stats table + Savant Page link.
- Toolbar popup: toggle a column / change a threshold → the table re-shades live (reopen the tab if the
  popup is covering it). "Refresh Savant data" reports updated counts.
- Enable the debug readout: bottom-left badge shows `Savant: N hitters · M pitchers · matched X/Y rows`
  and `MLB API: N handedness found`.
- Service worker logs (`chrome://extensions` → Inspect views: service worker): no errors; any skipped
  optional feed is a `console.warn`, not a throw.

---

## 10. Roadmap

- **Phase 1 — Working userscript.** ✅ Done (v0.8.8). Seven hitter + five pitcher columns, handedness,
  modal, shading, settings.
- **Phase 2 — Trending showcase.** Pending. A discovery feed that beats ESPN's rostership-based
  "trending," surfacing players by contact-quality signal. Design in §11.
- **Phase 3 — MV3 browser extension.** ✅ Done (v0.9.0). Same data layer, packaged; settings in the
  toolbar popup; minimal permissions. The resume/portfolio artifact.
- **Phase 4 — Pitchers + handedness.** ✅ Done (shipped in the userscript, carried into MV3). Savant
  has no Stuff+/PLV/xFIP/K-BB% (those are Pitcher List / FanGraphs), so the overlay surfaces the
  useful Savant-only subset.

---

## 11. Trending showcase — design (Phase 2, future)

### Problem with ESPN's trending
ESPN's "trending players" is driven by **rostership % change** (adds/drops) — a crowd-popularity and
news-recency signal, lagging and reactive. We want to surface players by *underlying signal*, ideally
before the crowd.

### Honest constraint
Savant's clean CSV leaderboards are **season-aggregated** — no arbitrary date ranges. True recent-window
data comes only from the per-event `statcast_search` CSV (aggregate yourself) or from diffing stored
snapshots. So a real "hot right now" feed costs either stored state or a heavy fetch. The standards doc
warns short samples are noise, which argues for making the sample-stable feed the *primary* showcase.

### v1 — "Undervalued" feed (cheapest; zero new data)
Rank the pool by the derived xwOBA–wOBA gap, filtered to `barrel% ≥ 8`. Biggest positive gaps =
buy-low candidates. Render as a small injected panel: top ~15 with Brl% / xwOBA / Gap. Caveat to encode
in the UI copy: the gap is a *screen, not a verdict* — it points at who to look at; it does not say buy.

### v2 — "Heating up" feed (real trending; needs minimal state)
Persist each day's season snapshot keyed by date (`chrome.storage.local` / IndexedDB). Compute the
~14-day delta of season-cumulative barrel%/xwOBA/HH% as a cheap recent-form proxy. Rank by a composite
weighted per the doc's priority order, with a minimum-recent-BBE floor.

### v2/v3 confirmation layer (ties to the doc's Gap Validation)
A riser whose barrel/xwOBA spike is *backed by rising bat speed* is a real skill change; a spike on
flat bat speed is variance. A bat-speed-trend flag turns "who's hot" into "whose hotness is real" — a
direct implementation of the doc's "is-the-spike-real" test.

### Scoping to available players
Most useful filtered to free agents: (a) DOM-only — highlight ESPN's free-agent list in place; (b)
ownership-aware — pull ownership from ESPN's v3 API (`kona_player_info`) once the extension backend
warrants it.

---

## 12. Future option: the heavier build (parked)

If the full framework in `fantasy_baseball_standards.md` is ever wanted as a queryable surface
(year-over-year deltas, BABIP-vs-career, the Gap Validation Layer, BUY/MONITOR/FADE buckets), that is a
data-warehouse problem, not an overlay — a daily snapshot table with deterministic computation, plus
roster/ownership synced from ESPN's v3 fantasy API. Parked unless the lightweight overlay proves
insufficient.

---

## 13. Metric reference (what's pullable and why it matters)

| Hitter metric | Savant field (verified) | Status | Doc priority |
|---|---|---|---|
| xwOBA–wOBA gap | derived `est_woba − woba` | ✅ column (derived; published col is sign-flipped) | #1 signal |
| Barrel% | `brl_percent` | ✅ column | #2 (min 8%, target 12%+) |
| Exit velocity | `avg_hit_speed` / `max_hit_speed` | ✅ avgEV; maxEV available | #3 (EV90 preferred, not on free CSV) |
| Hard-Hit% | `ev95percent` | ✅ column | #5 (40%+ good, 45%+ elite) |
| Process+ | — | ✖ NBC Sports, not Savant | #4 |
| Bat speed | `avg_bat_speed` | ✅ column (bat-tracking) | validation layer |
| Squared-up% | `squared_up_per_swing` | ✅ column (per-swing) | validation layer |

| Pitcher metric | Savant field (verified) | Status | Doc priority |
|---|---|---|---|
| xERA | `xera` | ✅ column | run-prevention skill |
| ERA–xERA gap | derived `era − xera` | ✅ column (positive = unlucky = buy) | #3 (regression signal) |
| xwOBA allowed | `est_woba` | ✅ oxwOBA | contact suppression |
| Barrel% allowed | `brl_percent` | ✅ oBrl% | contact suppression |
| Hard-Hit% allowed | `ev95percent` | ✅ oHH% | contact suppression |
| Stuff+ / PLV / xFIP / K-BB% | — | ✖ the underlying metrics aren't free; but PL's *composite rank* (below) is | #1/#2 SP priorities |
| Pitcher List rank (SP + closer) | PL weekly article `td.rank` | ✅ inline "• PL #N" after handedness (SP "The List" / "Top 50 Closers") | analyst composite |
| Throwing hand | StatsAPI `pitchHand.code` | ✅ (StatsAPI, not Savant) | matchup context |

---

## 14. File manifest

- `src/` — the MV3 extension (manifest, service worker, content script + css, popup, shared core).
- `userscript/espn-savant-overlay.user.js` — the origin userscript (v0.8.8).
- `docs/PROJECT_BARREL_VISION.md` — this document.
- `docs/fantasy_baseball_standards.md` — the evaluation framework the metrics serve.

---

## 15. Changelog

- **v0.11.0 (master on/off + PL link tidy)** —
  - **Master on/off switch.** A new `chrome.storage.sync` `enabled` flag (absent = on) with two entry
    points that write the same key: an **iOS-style toggle at the right of the popup header**, and a
    **right-click item on the toolbar icon** ("Enable Barrel Vision", checkbox, `contexts:['action']`;
    adds the `contextMenus` permission). The icon shows a greyed **OFF** badge when off.
  - **Live teardown, no reload.** The content script honours `enabled` via `start()`/`stop()`: off →
    `teardown()` removes every injected cell/span, un-hides the ESPN columns we collapsed, and clears the
    shading on ESPN's own OPS/ERA/WHIP cells, then disconnects the `MutationObserver` (off is strictly
    lighter than on). At page load when off it never calls `GET_INDEX`, so nothing is fetched. Flipping
    back on re-runs the boot path. (An open player-card modal keeps its one-shot relabels until reopened.)
  - **All popup checkboxes are now Apple-style switches** (master, per-metric "On", debug) via a shared
    `.bv-switch` component, app-red when on.
  - **Pitcher List link moved onto the rank badge.** The separate "Pitcher List" link in the modal's
    Advanced Stats header is gone; the inline **"• PL #N"** badge is now itself an `<a>` to the player's
    PL page (`/player/{slug}/`) when a slug is known (auto-fetched lists; pasted overrides stay plain
    text), keeping the existing hover tooltip. The modal header keeps only the **Savant Page** link.
- **v0.10.0 (Pitcher List ranks)** —
  - **New source: Pitcher List weekly SP + closer rankings, surfaced inline as "• PL #N" after a
    pitcher's handedness** (pitchers only; list view + player-card modal). SP rank from "The List"
    (Top 100), closer rank from the reliever "Top 50 Closers." Both show `PL #N` with a tooltip naming
    the source list + tier (SP) / "closer rank" (RP).
  - **Path A (automated) chosen after verifying the live articles.** Both rankings are a clean,
    server-rendered `<table class="list">` present in the raw HTML — so the SW `fetch` reaches them with
    no headless browser. The SW resolves the newest weekly article via the category **RSS feed** (HTML
    index as fallback) and **regex-parses** the first list table (no `DOMParser` in a classic worker),
    carrying tiers forward. Joined by the existing `normName`.
  - **New flat `pl` index** (`normName → { sp?, rp?, slug, tier, team }`), like `hand` — read directly
    by the content script, *not* a shaded `pit` column, and off the CSV `mergeFeeds` path. **Weekly
    (7-day) cache** (`getPL`, mirroring the per-pitcher QS cache); the popup's **Refresh** force-refetches.
  - **Popup controls (decoupled from the Savant refresh):** the existing button is renamed **"Refresh
    advanced data"** (Savant + StatsAPI; leaves PL on its weekly cache). A new **"Refresh Pitcher List"**
    path (`REFRESH_PL` message → `refreshPL`) re-fetches *only* the PL ranks live and merges them into the
    cached index (Savant untouched, index `ts` preserved so the 12h Savant timer isn't reset). All popup
    buttons are neutral grey (no red accent).
  - **Manual override is per-week, not permanent.** Paste the article list or simple "1 Name" lines and
    **Save** — honored for `plCacheTtlDays` (7 days) from when it was saved, after which **auto-fetch
    resumes on its own** (no Clear needed); *Fetch latest ranks* / *Clear* pull live immediately
    (force bypasses the override). Plus a **graceful skip** (a short parse renders no PL# rather than
    wrong ranks).
  - **Etiquette:** only factual ranks/names/teams/tiers are extracted — never the prose write-ups; the
    modal links back to `pitcherlist.com/player/{slug}/` for attribution. One new host permission
    (`pitcherlist.com`); no Google/Sheets, no `<all_urls>`.
  - Debug HUD gains a `Pitcher List: N SP · M closers ranked` line.
- **v0.9.1** —
  - **QS is now computed from StatsAPI, not scraped from ESPN's list.** The roster-list scrape read the
    list's current stat-filter window, so a Last-7/15/30/Projected view could surface a non-season QS on
    the player card. The SW now computes season QS from the pitcher's StatsAPI gameLog (≥6 IP & ≤3 ER per
    start), keyed by MLBAM id (added to the hand index), cached per pitcher (`GET_QS` message). The
    `captureRosterQS` scrape and `rosterStats` cache were removed. Index cache bumped to `v2` (hand index
    now carries `id`).
  - **Popup polish:** the data button is grey like Reset (was red) and renamed "Refresh data". Added the
    official Buy Me a Coffee button in the popup header (`src/assets/bmc-button.png`, bundled locally so
    there's no runtime remote fetch) — a plain external link, so no added permissions.
  - **Debug readout** moved to the very bottom-left (`bottom: 10px`; the 48px offset cleared the
    userscript's gear, which no longer exists in the extension).
- **v0.9.0 (MV3 port)** —
  - Ported the v0.8.8 userscript to a buildless vanilla Manifest V3 extension.
  - `GM_xmlhttpRequest` → cross-origin fetch in the **service worker** (content scripts can't fetch
    Savant/StatsAPI cross-origin in MV3); content ↔ SW via `chrome.runtime` messaging.
  - `GM_addStyle` → `content_scripts` CSS (`content.css`).
  - `localStorage` cache → `chrome.storage.local` (12h TTL, year-scoped key).
  - Settings moved from the floating gear to the **toolbar popup**; prefs in `chrome.storage.sync`;
    `storage.onChanged` re-shades live — **the reload-on-save hack is gone**.
  - Added a **Refresh Savant data** button (clears + rebuilds the SW cache; open ESPN tabs adopt the
    fresh index live via the local-cache change event).
  - `recolorAll()` broadened to `td[data-savant-key]` so live re-shading also covers ESPN's in-place
    OPS/ERA/WHIP cells (the userscript relied on a reload for those).
  - One shared `core.js` (`globalThis.BV`) loaded into all three contexts; functions never cross a
    message or a storage write.
  - Minimal permissions: `["storage"]` + host permissions for savant + statsapi only (no espn.com).
  - All five Savant feeds + StatsAPI re-verified live (2026), including both sign quirks.
  - Behavior preserved: re-entrant decoration across ESPN row reuse; TOTALS/empty rows untouched;
    FantasyCast skips the list but still decorates the popup; threshold shading; debug HUD.

### Userscript history (pre-port, for provenance)

- **v0.8.8** — Re-entrant decoration (filter/sort no longer goes stale; rows keyed on
  `data-savant-name`, headers on a marker class); Save reloads the page; per-page toggles reverted to
  the simple "runs everywhere, FantasyCast skips the list but keeps the popup" rule.
- **v0.8.7** — ERA + WHIP shading (Pitchers); xERA/ERA/WHIP default OFF, pre-filled; checkboxes drawn
  by us (ESPN forces `appearance:none`); debug readout page-aware.
- **v0.8.6** — TOTALS/empty rows left out-of-the-box; Preferences restructured into Hitters/Pitchers
  sections; per-page run toggles (later reverted).
- **v0.8.4** — "Savant Page" link in the modal Advanced table; debug-readout toggle; two-row HUD.
- **v0.8.1** — Condensed modal columns + standalone Advanced Stats table; OPS shading.
- **v0.7.0** — Handedness from MLB StatsAPI.
- **v0.6.0** — Per-column threshold shading + settings modal.
- **v0.5.x** — Pitchers via `type=pitcher`; two-table injection into the scroller; observer debounce.
- **v0.3.0** — First working userscript: hitter columns against the live ESPN DOM.
