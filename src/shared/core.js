/*
 * Barrel Vision - shared core
 * ---------------------------------------------------------------------------
 * Pure, context-independent logic shared by all three extension contexts:
 *   - the service worker  (background.js, via importScripts('shared/core.js'))
 *   - the content script  (listed BEFORE content.js in manifest content_scripts)
 *   - the popup page       (loaded via <script src="shared/core.js"> before popup.js)
 *
 * Everything here is attached to a single global namespace, `globalThis.BV`, so
 * each context reconstructs the live functions locally.
 *
 * HARD RULE (MV3): functions never cross a chrome.runtime message or a
 * chrome.storage write - both use JSON serialization, which silently drops
 * functions. CONFIG carries real functions (fmt / derive / cellColor), so it is
 * shared ONLY by loading this file into each context - it is never message-passed
 * or stored. The wire and the cache carry plain data records only.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Formatting helpers - referenced by CONFIG.columns[].fmt, so defined first.
  // ---------------------------------------------------------------------------
  function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; }
  function pct(v) { const n = num(v); return Number.isFinite(n) ? `${n.toFixed(1)}%` : ''; }
  // 0-1 fraction -> percent (bat-tracking squared_up_per_swing is a fraction, not percent-scaled).
  function pctFrac(v) { const n = num(v); return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : ''; }
  function dec3(v) { const n = num(v); return Number.isFinite(n) ? n.toFixed(3).replace(/^0/, '') : ''; }
  function dec2(v) { const n = num(v); return Number.isFinite(n) ? n.toFixed(2) : ''; }   // ERA scale (3.87)
  function dec1(v) { const n = num(v); return Number.isFinite(n) ? n.toFixed(1) : ''; }
  function gap3(v) { const n = num(v); if (!Number.isFinite(n)) return ''; const s = n >= 0 ? '+' : '−'; return `${s}${Math.abs(n).toFixed(3).replace(/^0/, '')}`; }
  function gapEra(v) { const n = num(v); if (!Number.isFinite(n)) return ''; const s = n >= 0 ? '+' : '−'; return `${s}${Math.abs(n).toFixed(2)}`; } // ERA-scale signed gap

  // ---------------------------------------------------------------------------
  // Name normalization - the join key between ESPN DOM names and Savant feeds.
  // Strips accents / punctuation / suffixes. Used in BOTH the SW (to key the
  // index) and the content script (to normalize DOM names before lookup), so it
  // lives here to stay in sync across contexts.
  // ---------------------------------------------------------------------------
  function normName(raw) {
    return (raw || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents (combining diacritical marks)
      .toLowerCase()
      .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')         // suffixes
      .replace(/[^a-z ]/g, ' ')                           // punctuation
      .replace(/\s+/g, ' ')
      .trim();
  }

  // MLB StatsAPI hand codes: L = Left, R = Right, S = Switch. Used for batSide + pitchHand.
  function handWord(code) { return code === 'L' ? 'Lefty' : code === 'R' ? 'Righty' : code === 'S' ? 'Switch' : ''; }

  // ---------------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------------
  const CONFIG = {
    year: new Date().getFullYear(),
    cacheTtlHours: 12,           // re-fetch Savant at most twice a day
    plCacheTtlDays: 7,           // Pitcher List rankings are weekly - fetch at most once a week
    minBattedBalls: 10,          // keep part-time guys (Barrel Hunting targets), not just qualifiers
    scanDebounceMs: 400,         // coalesce MutationObserver bursts - ESPN's live scores mutate constantly
    hideResearchColumns: true,   // hide ESPN's low-value Research cols (PR15 / %ROST / +/-) to make room

    // Savant CSV endpoints. All five verified to return CSV with the headers below
    // (re-verified live against 2026 in-season data during the MV3 port).
    savant: {
      // Exit Velocity & Barrels -> barrel%, hard-hit%, EV, maxEV.
      // Verified headers: brl_percent, ev95percent, avg_hit_speed, max_hit_speed (key = player_id).
      exitVelo: (year, min) =>
        `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${year}&position=&team=&min=${min}&csv=true`,
      // Expected Stats -> wOBA, xwOBA (est_woba).
      // GOTCHA (verified live: Wood woba .400 / est_woba .433 / published diff -.033): the published
      // est_woba_minus_woba_diff is (woba - est_woba), the OPPOSITE sign to this project's convention
      // (xwOBA - wOBA, positive = underperforming). The Gap column DERIVES est_woba - woba and ignores
      // the published column. Do NOT "fix" the Gap by switching to the published header - it inverts the feed.
      expected: (year, min) =>
        `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&filter=&min=${min}&csv=true`,
      // Bat-Tracking -> avg_bat_speed, squared_up_per_swing (validation layer).
      // Schema DIFFERS: id (not player_id), name (not "last_name, first_name", but same "Last, First"
      // text), squared_up_per_swing is a 0-1 FRACTION (not percent-scaled). Only ~210 qualified batters
      // appear, so these columns are blank for part-time players.
      batTracking: (year) =>
        `https://baseballsavant.mlb.com/leaderboard/bat-tracking?attackZone=&batSide=&pitchHand=&pitchType=&seasonStart=&seasonEnd=&type=batter&year=${year}&csv=true`,
      // Pitcher versions (type=pitcher). Same schema as the batter feeds PLUS era/xera/era_minus_xera_diff
      // on expected-stats. Columns now mean contact ALLOWED. NO handedness column (needs MLB StatsAPI).
      // era_minus_xera_diff is correctly signed (era - xera; verified Alcantara 4.18/3.85/+.33); est_woba_minus_woba_diff is still flipped.
      exitVeloPit: (year, min) =>
        `https://baseballsavant.mlb.com/leaderboard/statcast?type=pitcher&year=${year}&position=&team=&min=${min}&csv=true`,
      expectedPit: (year, min) =>
        `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${year}&position=&team=&filter=&min=${min}&csv=true`,
      // Percentile Rankings -> the 0-100 percentiles behind Savant's player-page sliders. ONE CSV per
      // type, keyed by player_id; name is in `player_name` ("Last, First" - rowName flips it). Columns
      // are percentiles (100 = elite, already oriented good-is-high for BOTH batters and pitchers, so a
      // pitcher's low xwOBA-allowed shows as a HIGH percentile). Non-qualifiers come back blank.
      percentile:    (year) => `https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=batter&year=${year}&csv=true`,
      percentilePit: (year) => `https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=pitcher&year=${year}&csv=true`,
    },

    // MLB StatsAPI - public, no key. The only source of handedness (Savant carries none).
    // sports/1/players carries batSide.code / pitchHand.code (L/R/S), primaryPosition, nameSlug,
    // currentTeam.id (used to resolve the opposing probable pitcher by team + last name, for matchups).
    mlbStats: (year) => `https://statsapi.mlb.com/api/v1/sports/1/players?season=${year}`,

    // Matchup ratings (day-of): team identity + offense, and per-batter platoon splits.
    //  - teams: id <-> abbreviation (map ESPN's opponent abbrev -> StatsAPI team id).
    //  - team hitting: per-team OPS, to rank offenses (a pitcher facing a weak offense = good matchup).
    //  - per-batter splits vs LHP / vs RHP (OPS + PA): the batter's production vs the day's opposing hand.
    mlbTeams:       (year) => `https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${year}`,
    mlbTeamHitting: (year) => `https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=hitting&season=${year}&sportIds=1`,
    mlbStatsSplits: (id, year) => `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr&season=${year}&gameType=R`,

    // Per-pitcher game log (regular season). QS (Quality Starts) is NOT a field on Savant or StatsAPI
    // — it is computed from this feed: a start with >=6 IP and <=3 ER. Authoritative season value,
    // independent of ESPN's list-filter window (the old roster-list scrape got this wrong when the
    // list was filtered to Last 7/15/30/Projected).
    mlbStatsGameLog: (id, year) => `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=${year}&gameType=R`,

    // Pitcher List weekly rankings - SP "The List" (Top 100), reliever "Top 50 Closers", and the
    // "Top 150 Hitters" list. Published as weekly ARTICLES (no API), but each ranking is a clean,
    // server-rendered <table class="list"> (verified live 2026: td.rank / td.name>a / td.team /
    // span.tier - the hitter list uses the SAME markup, so one parser handles all three). We resolve the
    // latest week's article via the category RSS feed (newest <link> first; the category HTML index is
    // the fallback if the feed shape changes), then regex-parse the FIRST list table. Only factual
    // rank+name+slug+team+tier are taken - never the prose write-ups (those stay on PL's site; see
    // PROJECT doc §5/§2). Parsing + the article-URL regexes live in background.js.
    pitcherList: {
      spFeed:   'https://pitcherlist.com/category/fantasy/starting-pitchers/the-list/feed/',
      rpFeed:   'https://pitcherlist.com/category/fantasy/relief-pitchers/reliever-ranks/feed/',
      hitFeed:  'https://pitcherlist.com/category/fantasy/hitters-fantasy/hitter-list/feed/',
      spIndex:  'https://pitcherlist.com/category/fantasy/starting-pitchers/the-list/',
      rpIndex:  'https://pitcherlist.com/category/fantasy/relief-pitchers/reliever-ranks/',
      hitIndex: 'https://pitcherlist.com/category/fantasy/hitters-fantasy/hitter-list/',
    },

    // ESPN's player-table DOM. Class names are obfuscated and shift when ESPN reships their frontend.
    selectors: {
      // Column-label row is the LAST thead tr - ESPN's first thead tr is a group banner.
      headerRow: 'thead tr:last-child',
      // Player name is the first <a> inside .player-column__athlete, excluding the news-icon link;
      // reading the anchor (not the parent) avoids the lineup-order number ESPN injects as a sibling.
      playerName: '.player-column__athlete a:not(.playerinfo__news)',
      // Team abbrev - tiebreaker only (Savant leaderboard CSVs carry no team, so currently inert).
      playerTeam: '.playerinfo__playerteam',
    },

    // Columns to add, split by table kind. label = header; sourceCandidates = possible CSV headers
    // (first match wins); fmt = render; derive = optional computed value.
    columns: {
      bat: [
        { key: 'barrel', label: 'Brl%',   sourceCandidates: ['brl_percent', 'barrel_batted_rate'], fmt: pct },
        { key: 'hh',     label: 'HH%',    sourceCandidates: ['ev95percent', 'hard_hit_percent'],   fmt: pct },
        { key: 'xwoba',  label: 'xwOBA',  sourceCandidates: ['est_woba', 'xwoba'],                  fmt: dec3 },
        // Gap = xwOBA - wOBA (positive = production lagging contact quality = buy-low screen). DERIVED,
        // not read from the sign-flipped published est_woba_minus_woba_diff. See CONFIG.savant.expected.
        { key: 'gap',    label: 'Gap',    derive: r => num(r.est_woba ?? r.xwoba) - num(r.woba),    fmt: gap3 },
        { key: 'avgev',  label: 'avgEV',  sourceCandidates: ['avg_hit_speed', 'avg_ev'],            fmt: dec1 },
        // Validation layer from the bat-tracking feed. Blank for players not on that leaderboard.
        { key: 'bat',    label: 'BatSpd', sourceCandidates: ['avg_bat_speed'],                      fmt: dec1 },
        { key: 'squp',   label: 'SqUp%',  sourceCandidates: ['squared_up_per_swing'],               fmt: pctFrac },
      ],
      // Pitcher columns from type=pitcher leaderboards: contact ALLOWED (lower is better) + xERA.
      pit: [
        { key: 'xera',   label: 'xERA',   sourceCandidates: ['xera'],                               fmt: dec2 },
        // ERA gap = ERA - xERA (positive = unlucky, ERA worse than skill = improvement coming = buy).
        // era_minus_xera_diff is correctly signed here, but we derive to stay robust and explicit.
        { key: 'eragap', label: 'ERAgap', derive: r => num(r.era) - num(r.xera),                    fmt: gapEra },
        { key: 'oxwoba', label: 'oxwOBA', sourceCandidates: ['est_woba'],                            fmt: dec3 },
        { key: 'obrl',   label: 'oBrl%',  sourceCandidates: ['brl_percent', 'barrel_batted_rate'],  fmt: pct },
        { key: 'ohh',    label: 'oHH%',   sourceCandidates: ['ev95percent', 'hard_hit_percent'],    fmt: pct },
      ],
    },

    // Per-column preferences. Two independent toggles per column:
    //   show     - is the column displayed at all (popup "Show"). For our injected Savant columns this
    //              gates injection; ESPN's own columns (ops/era/whip) are always shown (read-only in the
    //              popup) since we don't add/remove ESPN's columns - the flag is there for UI symmetry.
    //   enabled  - is the column HIGHLIGHTED (popup "Highlight"; the old "On"). The shading logic reads
    //              this, so the name is unchanged for back-compat with saved prefs.
    // dir = which direction is "better" (gets the red/hot shade); scale = how far past the threshold (in
    // DISPLAY units) reaches full saturation; threshold:null also turns shading off. Compared in the
    // units each column shows.
    preferences: {
      // Hitters - higher is better.
      barrel: { show: true, enabled: true, threshold: 8,     dir: 'high', scale: 6 },
      hh:     { show: true, enabled: true, threshold: 40,    dir: 'high', scale: 12 },
      xwoba:  { show: true, enabled: true, threshold: 0.320, dir: 'high', scale: 0.060 },
      gap:    { show: true, enabled: true, threshold: 0,     dir: 'high', scale: 0.040 },
      avgev:  { show: true, enabled: true, threshold: 90,    dir: 'high', scale: 5 },
      bat:    { show: true, enabled: true, threshold: 72,    dir: 'high', scale: 5 },
      squp:   { show: true, enabled: true, threshold: 25,    dir: 'high', scale: 8 },
      // ESPN OPS - shaded in place on the list + condensed modal column. Not a Savant metric (show is
      // read-only on in the popup).
      ops:    { show: true, enabled: true, threshold: 0.800, dir: 'high', scale: 0.150 },
      // Pitchers - contact ALLOWED + xERA, so lower is better. ERAgap is the exception: positive =
      // ERA worse than xERA (unlucky -> improvement coming), so higher is the "good" side.
      xera:   { show: true, enabled: false, threshold: 4.00,  dir: 'low',  scale: 1.5 },
      eragap: { show: true, enabled: true,  threshold: 0,     dir: 'high', scale: 1.5 },
      oxwoba: { show: true, enabled: true,  threshold: 0.310, dir: 'low',  scale: 0.060 },
      obrl:   { show: true, enabled: true,  threshold: 8,     dir: 'low',  scale: 6 },
      ohh:    { show: true, enabled: true,  threshold: 40,    dir: 'low',  scale: 12 },
      // ESPN ERA + WHIP - basic pitcher rate stats shaded in place. Lower = better. Highlight default OFF
      // (show is read-only on in the popup).
      era:    { show: true, enabled: false, threshold: 4.00,  dir: 'low',  scale: 1.5 },
      whip:   { show: true, enabled: false, threshold: 1.20,  dir: 'low',  scale: 0.30 },
      // Handedness display rows (not columns - they have only a `show` flag). handBat = the batter's
      // batSide on batter rows; handPit = the pitcher's throwing hand on pitcher rows. Rendered as the
      // first "Show" row of each popup section; the content script gates the "• Righty/Lefty" span on them.
      handBat: { show: true },
      handPit: { show: true },
    },

    // Pitcher List rank display toggles (separate from the per-column prefs above). `on` is the master;
    // sp/rp/h are the individual lists. A list shows only if `on` AND its own flag are true. Stored under
    // its own sync key (STORAGE.plPrefs) so the per-column merge logic doesn't touch it.
    plPrefs: { on: true, sp: true, rp: true, h: true },

    // Savant percentile sliders (player-card modal only). Like Savant's player page, each row shows the
    // ACTUAL stat value with the bar positioned at the player's percentile. So each entry pairs:
    //   pct  - the column in the percentile-rankings CSV (0-100) -> the bar POSITION
    //   src  - the raw-value column(s) in the bat/pit index (first match wins) -> the VALUE shown
    //   fmt  - how to render that value (.xxx / x.x% / mph, matching the Advanced Stats table)
    // Curated to the metrics we already carry a real value for (the raw leaderboards are fetched anyway,
    // so this adds no network). Plate-discipline (K/BB/whiff/chase), sprint speed and fastball velo are
    // omitted for now - they're percentile-only in our data; adding them needs extra value feeds.
    percentiles: {
      bat: [
        { label: 'xwOBA',       pct: 'xwoba',            src: ['est_woba'],                         fmt: dec3 },
        { label: 'xBA',         pct: 'xba',              src: ['est_ba'],                           fmt: dec3 },
        { label: 'xSLG',        pct: 'xslg',             src: ['est_slg'],                          fmt: dec3 },
        { label: 'Barrel%',     pct: 'brl_percent',      src: ['brl_percent', 'barrel_batted_rate'], fmt: pct },
        { label: 'Hard-Hit%',   pct: 'hard_hit_percent', src: ['ev95percent', 'hard_hit_percent'],  fmt: pct },
        { label: 'Avg EV',      pct: 'exit_velocity',    src: ['avg_hit_speed', 'avg_ev'],          fmt: dec1 },
        { label: 'Bat Speed',   pct: 'bat_speed',        src: ['avg_bat_speed'],                    fmt: dec1 },
        { label: 'Squared-Up%', pct: 'squared_up_rate',  src: ['squared_up_per_swing'],             fmt: pctFrac },
      ],
      pit: [
        { label: 'xERA',      pct: 'xera',             src: ['xera'],                             fmt: dec2 },
        { label: 'xwOBA',     pct: 'xwoba',            src: ['est_woba'],                         fmt: dec3 },
        { label: 'xBA',       pct: 'xba',              src: ['est_ba'],                           fmt: dec3 },
        { label: 'xSLG',      pct: 'xslg',             src: ['est_slg'],                          fmt: dec3 },
        { label: 'Barrel%',   pct: 'brl_percent',      src: ['brl_percent', 'barrel_batted_rate'], fmt: pct },
        { label: 'Hard-Hit%', pct: 'hard_hit_percent', src: ['ev95percent', 'hard_hit_percent'],  fmt: pct },
        { label: 'Avg EV',    pct: 'exit_velocity',    src: ['avg_hit_speed', 'avg_ev'],          fmt: dec1 },
      ],
    },
  };

  // ---------------------------------------------------------------------------
  // Shading - pure given prefs. The PRIMITIVE is cellSignal(): it returns the
  // signed, normalized distance from the threshold, or null when shading is off.
  // Everything visual (the data-bar / stripe / fill in content.js) is derived
  // from this, so the "is it shaded and how strongly" logic lives in exactly one
  // place. prefs is passed in (content + popup each hold their own copy) so this
  // stays pure and shareable.
  //   t      : -1..+1, signed magnitude (sign already flipped for dir:'low' cols)
  //   better : t > 0  -> on the "good" side of the threshold (red/hot); else blue/cold
  // ---------------------------------------------------------------------------
  function cellSignal(prefs, key, raw) {
    const p = prefs && prefs[key];
    if (!p || !p.enabled || p.threshold == null || !Number.isFinite(raw)) return null;
    let delta = raw - p.threshold;
    if (p.dir === 'low') delta = -delta;               // flip so +delta always means "better"
    const t = Math.max(-1, Math.min(1, delta / (p.scale || 1)));
    return t === 0 ? null : { t, better: t > 0 };
  }

  // Legacy full-cell fill colour, derived from cellSignal. Still used by the 'fill'
  // shading style (content.js SHADE_STYLE) and kept as a stable helper.
  function cellColor(prefs, key, raw) {
    const s = cellSignal(prefs, key, raw);
    if (!s) return '';
    const a = (0.12 + 0.42 * Math.abs(s.t)).toFixed(3);  // 0.12 floor so a tiny edge still reads
    return s.better ? `rgba(214,46,46,${a})` : `rgba(36,92,204,${a})`; // red = better, blue = worse
  }

  // Deep clone of the default thresholds (so Reset stays clean and saved prefs merge onto a fresh base).
  function defaultPrefs() { return JSON.parse(JSON.stringify(CONFIG.preferences)); }

  // Default Pitcher List display toggles, merged with any saved subset (so new lists default sensibly).
  function defaultPlPrefs() { return { ...CONFIG.plPrefs }; }
  function mergePlPrefs(saved) { return { ...CONFIG.plPrefs, ...(saved && typeof saved === 'object' ? saved : {}) }; }
  // Resolve which PL rank to display for a record given the toggles + row kind. Returns
  // { rank, list:'sp'|'rp'|'h' } or null when nothing should show. Master off -> always null.
  function plPick(rec, kind, pl) {
    if (!rec || !pl || pl.on === false) return null;
    if (kind === 'bat') return (pl.h !== false && rec.h != null) ? { rank: rec.h, list: 'h' } : null;
    if (pl.sp !== false && rec.sp != null) return { rank: rec.sp, list: 'sp' };
    if (pl.rp !== false && rec.rp != null) return { rank: rec.rp, list: 'rp' };
    return null;
  }

  // Count helper for the loaded-rows diagnostic: each index value is an array of records.
  function countIndex(idx) { return Object.values(idx || {}).reduce((a, arr) => a + arr.length, 0); }

  // Storage keys (chrome.storage). Cache key is versioned + year-scoped.
  const STORAGE = {
    prefs: 'prefs',                 // chrome.storage.sync
    plPrefs: 'plPrefs',             // chrome.storage.sync (Pitcher List display toggles: {on,sp,rp,h})
    debug: 'debug',                 // chrome.storage.sync
    enabled: 'enabled',             // chrome.storage.sync (master on/off; absent = on)
    // v4: added team-offense (`teamOff`/`teamAbbr`) + the player's team id on the hand index (matchups).
    // v3: added the Savant percentile index (`pct`) for the player-card sliders.
    // v2: the hand index also carries the player's MLBAM id (used to compute QS).
    cacheKey: (year) => `barrelVision:index:v4:${year}`,      // chrome.storage.local
    qsKey: (year) => `barrelVision:qs:v1:${year}`,            // chrome.storage.local (per-pitcher QS cache)
    splitsKey: (year) => `barrelVision:splits:v1:${year}`,    // chrome.storage.local (per-batter platoon splits)
    plKey: (year) => `barrelVision:pl:v1:${year}`,            // chrome.storage.local (weekly Pitcher List cache)
    plOverride: (year) => `barrelVision:plOverride:v1:${year}`, // chrome.storage.local (manual-paste fallback)
  };

  root.BV = {
    CONFIG, STORAGE,
    num, pct, pctFrac, dec3, dec2, dec1, gap3, gapEra,
    normName, handWord, cellSignal, cellColor, defaultPrefs,
    defaultPlPrefs, mergePlPrefs, plPick, countIndex,
  };
})(typeof self !== 'undefined' ? self : this);
