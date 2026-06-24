// ==UserScript==
// @name         ESPN Fantasy Baseball — Savant Overlay
// @namespace    bikemeardsley
// @version      0.8.8
// @description  Adds Baseball Savant contact-quality metrics next to ESPN players (hitters + pitchers), styled to match ESPN's tables. Per-column threshold highlighting (incl. OPS), handedness from MLB StatsAPI, and an Advanced Stats table in the player-card modal.
// @match        https://fantasy.espn.com/baseball/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      baseballsavant.mlb.com
// @connect      statsapi.mlb.com
// @run-at       document-idle
// ==/UserScript==
//
// NOTE: this is the ORIGIN ARTIFACT for the Barrel Vision MV3 extension (see ../src).
// It is kept for provenance and is not part of the built extension. The MV3 port
// preserves all of its behavior and the same verified data quirks.

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG — the two things you may need to tune are flagged FRAGILE.
  // ─────────────────────────────────────────────────────────────────────────
  const CONFIG = {
    year: new Date().getFullYear(),
    cacheTtlHours: 12,           // re-fetch Savant at most twice a day
    minBattedBalls: 10,          // keep part-time guys (Barrel Hunting targets), not just qualifiers
    showHud: true,              // bottom-right diagnostic badge; set false once tuned
    hideResearchColumns: true,   // hide ESPN's low-value Research cols (PR15 / %ROST / +/-) to make room
    scanDebounceMs: 400,         // coalesce MutationObserver bursts — ESPN's live scores mutate constantly

    // FRAGILE #1 — Savant CSV endpoints.
    // Open each URL in your browser once to confirm it returns CSV (not HTML).
    // If a column name below doesn't match the CSV header, fix it in COLUMNS.sourceCandidates.
    savant: {
      // Exit Velocity & Barrels leaderboard -> barrel%, hard-hit%, EV, maxEV
      // Verified headers: brl_percent, ev95percent, max_hit_speed (all percent-scaled; key = player_id)
      exitVelo: (year, min) =>
        `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${year}&position=&team=&min=${min}&csv=true`,
      // Expected Stats leaderboard -> wOBA, xwOBA (est_woba), xBA, xSLG
      // Verified headers: woba, est_woba, est_woba_minus_woba_diff (key = player_id)
      // GOTCHA: the published est_woba_minus_woba_diff is (woba - est_woba) despite its name —
      // the OPPOSITE sign to the standards-doc convention (xwOBA - wOBA, positive = underperforming).
      // The Gap column therefore DERIVES est_woba - woba and ignores the published column. Do not
      // "fix" the Gap column by switching back to the published header; it will invert the feed.
      expected: (year, min) =>
        `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=&filter=&min=${min}&csv=true`,
      // Bat-Tracking leaderboard -> avg_bat_speed, squared_up_per_swing (validation layer).
      // Schema DIFFERS from the two feeds above: id (not player_id), name (not "last_name, first_name",
      // but same "Last, First" text), squared_up_per_swing is a 0-1 fraction (not percent-scaled).
      // Only ~210 qualified batters appear, so these columns are blank for part-time players.
      batTracking: (year) =>
        `https://baseballsavant.mlb.com/leaderboard/bat-tracking?attackZone=&batSide=&pitchHand=&pitchType=&seasonStart=&seasonEnd=&type=batter&year=${year}&csv=true`,
      // Pitcher versions of the two batted-ball feeds (type=pitcher). Same schema as the batter
      // versions PLUS era/xera/era_minus_xera_diff on expected-stats. Columns now mean contact ALLOWED.
      // Verified: NO handedness column (same as batter feeds) — throwing hand needs MLB StatsAPI.
      // era_minus_xera_diff is correctly signed (era - xera); est_woba_minus_woba_diff is still flipped.
      exitVeloPit: (year, min) =>
        `https://baseballsavant.mlb.com/leaderboard/statcast?type=pitcher&year=${year}&position=&team=&min=${min}&csv=true`,
      expectedPit: (year, min) =>
        `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${year}&position=&team=&filter=&min=${min}&csv=true`,
    },

    // MLB StatsAPI — public, no key. The sports/1/players roster dump carries batSide.code /
    // pitchHand.code (L/R/S) and primaryPosition — the only source of handedness (Savant has none).
    // Verified against a saved response: all 1250 players have batSide.code + pitchHand.code, no gaps.
    mlbStats: (year) => `https://statsapi.mlb.com/api/v1/sports/1/players?season=${year}`,

    // FRAGILE #2 — ESPN's player-table DOM. Class names are obfuscated and shift
    // when ESPN reships their frontend. Tune these against the live page via DevTools.
    selectors: {
      table: 'table',
      // Column-label row is the LAST thead tr — ESPN's first thead tr is a group banner
      // ("Batters · June 22" / "Pitchers · June 22"), so last-child keeps headers aligned.
      headerRow: 'thead tr:last-child',
      bodyRow: 'tbody tr',
      // Player name is the first <a> inside .player-column__athlete. Excluding .playerinfo__news
      // skips the news-icon link; reading the anchor (not the parent div) avoids picking up the
      // lineup-order number ESPN injects as a sibling <strong>. Verified against live roster DOM.
      playerName: '.player-column__athlete a:not(.playerinfo__news)',
      // Team abbrev — tiebreaker only, and currently inert (Savant leaderboard CSVs carry no team).
      playerTeam: '.playerinfo__playerteam',
    },

    // Columns to add, split by table kind. label = header; sourceCandidates = possible CSV headers
    // (first match wins); fmt = render; derive = optional computed value. ESPN renders Batters and
    // Pitchers as separate table blocks, so each gets its own column set (see decorateTable).
    columns: {
      bat: [
        { key: 'barrel', label: 'Brl%',   sourceCandidates: ['brl_percent', 'barrel_batted_rate'], fmt: pct },
        { key: 'hh',     label: 'HH%',    sourceCandidates: ['ev95percent', 'hard_hit_percent'],   fmt: pct },
        { key: 'xwoba',  label: 'xwOBA',  sourceCandidates: ['est_woba', 'xwoba'],                  fmt: dec3 },
        // Gap = xwOBA - wOBA per the standards-doc convention (positive = production lagging contact
        // quality = buy-low screen). DERIVED, not read from the published est_woba_minus_woba_diff
        // column, which carries the opposite sign. See the CONFIG.savant.expected note.
        { key: 'gap',    label: 'Gap',    derive: r => num(r.est_woba ?? r.xwoba) - num(r.woba),    fmt: gap3 },
        { key: 'avgev',  label: 'avgEV',  sourceCandidates: ['avg_hit_speed', 'avg_ev'],             fmt: dec1 },
        // Validation layer from the bat-tracking feed. Blank for players not on that leaderboard.
        { key: 'bat',    label: 'BatSpd', sourceCandidates: ['avg_bat_speed'],                      fmt: dec1 },
        { key: 'squp',   label: 'SqUp%',  sourceCandidates: ['squared_up_per_swing'],               fmt: pctFrac },
      ],
      // Pitcher columns come from the type=pitcher leaderboards. xERA + the ERA-xERA gap are the
      // doc's pitching regression signal (Section 3); the o-prefixed columns are contact-quality
      // ALLOWED (opponent), where lower is better. No handedness column exists in these feeds — that
      // needs MLB StatsAPI (see project doc Phase 4). No bat-tracking equivalent for pitchers.
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

    // Per-column highlight thresholds. dir = which direction is "better" (gets the red/hot shade);
    // scale = how far past the threshold (in DISPLAY units) reaches full saturation; enabled:false or
    // threshold:null turns shading off for that column. Compared in the units each column shows (so
    // SqUp% is in percent, xwOBA in .xxx). Starting points — tune in the gear menu (saved per browser).
    preferences: {
      // Hitters — higher is better.
      barrel: { enabled: true, threshold: 8,     dir: 'high', scale: 6 },
      hh:     { enabled: true, threshold: 40,    dir: 'high', scale: 12 },
      xwoba:  { enabled: true, threshold: 0.320, dir: 'high', scale: 0.060 },
      gap:    { enabled: true, threshold: 0,     dir: 'high', scale: 0.040 },
      avgev:  { enabled: true, threshold: 90,    dir: 'high', scale: 5 },
      bat:    { enabled: true, threshold: 72,    dir: 'high', scale: 5 },
      squp:   { enabled: true, threshold: 25,    dir: 'high', scale: 8 },
      // ESPN OPS — the one basic counting/rate stat worth shading. Used on the list's OPS column and
      // the condensed OPS column in the modal. Not a Savant metric, hence outside CONFIG.columns.
      ops:    { enabled: true, threshold: 0.800, dir: 'high', scale: 0.150 },
      // Pitchers — contact ALLOWED + xERA, so lower is better. ERAgap is the exception: positive
      // means ERA is worse than xERA (unlucky → improvement coming), so higher is the "good" side.
      // xERA / ERA / WHIP default OFF — sensible starting thresholds are pre-filled, but the user opts in.
      xera:   { enabled: false, threshold: 4.00,  dir: 'low',  scale: 1.5 },
      eragap: { enabled: true,  threshold: 0,     dir: 'high', scale: 1.5 },
      oxwoba: { enabled: true,  threshold: 0.310, dir: 'low',  scale: 0.060 },
      obrl:   { enabled: true,  threshold: 8,     dir: 'low',  scale: 6 },
      ohh:    { enabled: true,  threshold: 40,    dir: 'low',  scale: 12 },
      // ESPN ERA + WHIP — basic pitcher rate stats shaded in place (like OPS for hitters). Lower = better.
      era:    { enabled: false, threshold: 4.00,  dir: 'low',  scale: 1.5 },
      whip:   { enabled: false, threshold: 1.20,  dir: 'low',  scale: 0.30 },
    },
  };

  // Running diagnostics surfaced in the HUD.
  const STATS = { loaded: null, found: 0, matched: 0, error: null };

  // Observer + debounce state (declared here so scan() and boot share the same `mo`).
  let mo = null;
  let scanTimer = null;
  function scheduleScan(indexes) {
    if (scanTimer) return;                  // a scan is already queued; coalesce this burst into it
    scanTimer = setTimeout(() => { scanTimer = null; scan(indexes); }, CONFIG.scanDebounceMs);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Highlight preferences — defaults live in CONFIG; user edits persist to localStorage.
  // ─────────────────────────────────────────────────────────────────────────
  const PREFS_KEY = 'savantOverlayPrefs:v1';
  function defaultPrefs() { return JSON.parse(JSON.stringify(CONFIG.preferences)); } // clone so Reset stays clean
  function loadPrefs() {
    const base = defaultPrefs();
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY));
      if (saved && typeof saved === 'object') {
        for (const k in base) if (saved[k]) base[k] = { ...base[k], ...saved[k] };
      }
    } catch (_) {}
    return base;
  }
  function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) {} }
  let PREFS = loadPrefs();

  // Debug readout (the corner status box) is off by default; toggled in Preferences, persisted here.
  const DEBUG_KEY = 'savantOverlayDebug:v1';
  let showDebug = false;
  try { showDebug = localStorage.getItem(DEBUG_KEY) === '1'; } catch (_) {}
  function saveDebug() { try { localStorage.setItem(DEBUG_KEY, showDebug ? '1' : '0'); } catch (_) {} }

  // Savant-style shading: better-than-threshold = red (hot), worse = blue (cold), with a gradient by
  // distance from the threshold (per-column scale), capped at full saturation. Returns a CSS color, or
  // '' when shading is off (disabled / null threshold / value at threshold / no numeric value).
  function cellColor(key, raw) {
    const p = PREFS[key];
    if (!p || !p.enabled || p.threshold == null || !Number.isFinite(raw)) return '';
    let delta = raw - p.threshold;
    if (p.dir === 'low') delta = -delta;             // flip so +delta always means "better"
    const t = Math.max(-1, Math.min(1, delta / (p.scale || 1)));
    if (t === 0) return '';
    const a = (0.12 + 0.42 * Math.abs(t)).toFixed(3); // 0.12 floor so a tiny edge still reads
    return t > 0 ? `rgba(214,46,46,${a})` : `rgba(36,92,204,${a})`; // red = better, blue = worse
  }

  // Re-shade already-injected cells in place (used after a prefs save, no table rebuild needed).
  function recolorAll() {
    for (const td of document.querySelectorAll('td.savant-col[data-savant-key]')) {
      const raw = parseFloat(td.dataset.savantVal);
      td.style.backgroundColor = cellColor(td.dataset.savantKey, Number.isFinite(raw) ? raw : NaN);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Formatting helpers
  // ─────────────────────────────────────────────────────────────────────────
  function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; }
  function pct(v) { const n = num(v); return Number.isFinite(n) ? `${n.toFixed(1)}%` : ''; }
  function pctFrac(v) { const n = num(v); return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : ''; } // 0-1 fraction -> percent (bat-tracking)
  function dec3(v) { const n = num(v); return Number.isFinite(n) ? n.toFixed(3).replace(/^0/, '') : ''; }
  function dec2(v) { const n = num(v); return Number.isFinite(n) ? n.toFixed(2) : ''; }                      // ERA scale (3.87)
  function dec1(v) { const n = num(v); return Number.isFinite(n) ? n.toFixed(1) : ''; }
  function gap3(v) { const n = num(v); if (!Number.isFinite(n)) return ''; const s = n >= 0 ? '+' : '−'; return `${s}${Math.abs(n).toFixed(3).replace(/^0/, '')}`; }
  function gapEra(v) { const n = num(v); if (!Number.isFinite(n)) return ''; const s = n >= 0 ? '+' : '−'; return `${s}${Math.abs(n).toFixed(2)}`; } // ERA-scale signed gap

  // ─────────────────────────────────────────────────────────────────────────
  // Name normalization — the join key. Strips accents/punctuation/suffixes.
  // ─────────────────────────────────────────────────────────────────────────
  function normName(raw) {
    return (raw || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // accents
      .toLowerCase()
      .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')        // suffixes
      .replace(/[^a-z ]/g, ' ')                          // punctuation
      .replace(/\s+/g, ' ')
      .trim();
  }

  // MLB StatsAPI hand codes: L = Left, R = Right, S = Switch. Used for both batSide and pitchHand.
  function handWord(code) { return code === 'L' ? 'Lefty' : code === 'R' ? 'Righty' : code === 'S' ? 'Switch' : ''; }

  // ─────────────────────────────────────────────────────────────────────────
  // Minimal CSV parser (handles quoted fields containing commas).
  // ─────────────────────────────────────────────────────────────────────────
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift().map(h => h.trim());
    return rows
      .filter(r => r.length === header.length)
      .map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  }

  function rowName(r) {
    // Batted-ball/expected feeds use "last_name, first_name"; the bat-tracking feed uses "name"
    // in the same "Last, First" text. Treat any comma-bearing value as Last, First and flip it.
    const lastFirst = r['last_name, first_name'] || (r.name && r.name.includes(',') ? r.name : '');
    if (lastFirst) {
      const [last, first] = lastFirst.split(',').map(s => (s || '').trim());
      return `${first} ${last}`;
    }
    if (r.first_name || r.last_name) return `${r.first_name || ''} ${r.last_name || ''}`.trim();
    return r.name || r.player_name || '';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fetch + cache
  // ─────────────────────────────────────────────────────────────────────────
  function fetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload: res => (res.status >= 200 && res.status < 300)
          ? resolve(res.responseText)
          : reject(new Error(`HTTP ${res.status}`)),
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  const CACHE_KEY = `savantOverlay:v4:${CONFIG.year}`; // v4 = hand index also carries the Savant slug

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && (Date.now() - c.ts) < CONFIG.cacheTtlHours * 3600e3) return c.indexes;
    } catch (_) {}
    return null;
  }

  // Merge a list of feeds (each: {label, url, idField, optional}) into a name-keyed index.
  async function mergeFeeds(feeds) {
    const byId = {};
    for (const feed of feeds) {
      let text;
      try {
        text = await fetchText(feed.url);
        if (/^\s*</.test(text)) throw new Error('got HTML, not CSV');
      } catch (e) {
        if (feed.optional) { console.warn(`[Savant Overlay] ${feed.label} skipped: ${e.message}`); continue; }
        throw new Error(`${feed.label} fetch: ${e.message}`);
      }
      for (const r of parseCsv(text)) {
        const id = r[feed.idField]; if (!id) continue;
        byId[id] = { ...byId[id], ...r, _name: byId[id]?._name || rowName(r) };
      }
    }
    // Re-key by normalized name; keep arrays so the team tiebreaker can act.
    const byName = {};
    for (const id in byId) {
      const k = normName(byId[id]._name);
      if (!k) continue;
      (byName[k] ||= []).push(byId[id]);
    }
    return byName;
  }

  async function buildIndex() {
    const cached = readCache();
    if (cached) return cached;

    const Y = CONFIG.year, M = CONFIG.minBattedBalls;

    // Batter index: two required batted-ball feeds + the optional bat-tracking validation layer
    // (keys on `id`, not `player_id`; if it fails the other columns still render).
    const bat = await mergeFeeds([
      { label: 'exit-velo',      url: CONFIG.savant.exitVelo(Y, M), idField: 'player_id' },
      { label: 'expected-stats', url: CONFIG.savant.expected(Y, M), idField: 'player_id' },
      { label: 'bat-tracking',   url: CONFIG.savant.batTracking(Y), idField: 'id', optional: true },
    ]);

    // Pitcher index: the type=pitcher versions of the two batted-ball feeds (contact ALLOWED + xERA).
    // Optional as a block — if pitcher feeds fail, batter columns still render; pitcher rows go blank.
    let pit = {};
    try {
      pit = await mergeFeeds([
        { label: 'exit-velo-pit',      url: CONFIG.savant.exitVeloPit(Y, M), idField: 'player_id' },
        { label: 'expected-stats-pit', url: CONFIG.savant.expectedPit(Y, M), idField: 'player_id' },
      ]);
    } catch (e) { console.warn(`[Savant Overlay] pitcher feeds skipped: ${e.message}`); }

    // Handedness index from MLB StatsAPI, keyed by normalized name -> { bats, throws } (L/R/S codes).
    // Optional: if it fails, handedness simply doesn't render and everything else is unaffected.
    let hand = {};
    try {
      const json = JSON.parse(await fetchText(CONFIG.mlbStats(Y)));
      for (const p of (json.people || [])) {
        const k = normName(p.fullName || p.firstLastName || `${p.firstName || ''} ${p.lastName || ''}`);
        if (!k) continue;
        hand[k] = { bats: p.batSide?.code || '', throws: p.pitchHand?.code || '', slug: p.nameSlug || '' };
      }
    } catch (e) { console.warn(`[Savant Overlay] StatsAPI handedness skipped: ${e.message}`); }

    const indexes = { bat, pit, hand };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), indexes })); } catch (_) {}
    return indexes;
  }

  function lookup(index, name, team) {
    const matches = index[normName(name)];
    if (!matches || !matches.length) return null;
    if (matches.length === 1) return matches[0];
    if (team) {
      const t = team.toUpperCase();
      const hit = matches.find(m => (m.team || m.team_name || '').toUpperCase().includes(t) || t.includes((m.team || '').toUpperCase()));
      if (hit) return hit;
    }
    return matches[0];
  }

  function valueFor(col, row) {
    if (col.sourceCandidates) {
      for (const src of col.sourceCandidates) if (row[src] != null && row[src] !== '') return col.fmt(row[src]);
    }
    if (col.derive) return col.fmt(col.derive(row));
    return '';
  }

  // Numeric value behind a cell, in the SAME display units the cell shows (so thresholds compare
  // cleanly): pctFrac columns are 0-1 fractions on disk but shown as percent, so scale them ×100 here.
  function rawValueFor(col, row) {
    if (!row) return NaN;
    if (col.sourceCandidates) {
      for (const src of col.sourceCandidates) if (row[src] != null && row[src] !== '') {
        const n = num(row[src]);
        return col.fmt === pctFrac ? n * 100 : n;
      }
    }
    if (col.derive) return num(col.derive(row));
    return NaN;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOM injection
  // ─────────────────────────────────────────────────────────────────────────
  const FLAG = 'data-savant-done';

  // QS isn't in the player-card modal DOM and can't be computed from it (no full game log there).
  // It IS a column on the roster list, so we capture name -> QS while scanning the list and reuse it
  // in the modal. Lives for the SPA session; empty until a pitcher roster table has been scanned.
  const rosterStats = {}; // normName -> { qs }

  function rowPlayer(tr) {
    const nameEl = tr.querySelector(CONFIG.selectors.playerName);
    if (!nameEl) return null;
    const name = (nameEl.textContent || '').trim();
    if (!name) return null;
    const teamEl = tr.querySelector(CONFIG.selectors.playerTeam);
    const team = teamEl ? (teamEl.textContent || '').trim() : '';
    return { name, team };
  }

  // Detect Batters vs Pitchers from the left table's group banner. Defaults to batter if unlabeled.
  function tableKind(table) {
    if (table.querySelector('thead th[title="Pitchers"]')) return 'pit';
    if (table.querySelector('thead th[title="Batters"]')) return 'bat';
    const head = table.querySelector('thead');
    if (head && /pitch/i.test(head.textContent) && !/batt/i.test(head.textContent)) return 'pit';
    return 'bat';
  }

  // Hide ESPN's low-value Research columns (PR15 / %ROST / +/-) to make room for ours.
  // Identified by the semantic child-div classes ESPN puts on those cells, plus the group banner.
  function hideResearch(scroller) {
    if (!CONFIG.hideResearchColumns) return;
    scroller.querySelectorAll('thead th[title="Research"]').forEach(th => th.classList.add('savant-hidden'));
    for (const cell of scroller.querySelectorAll('th, td')) {
      if (cell.querySelector('.player-rater, .own, .poc')) cell.classList.add('savant-hidden');
    }
  }

  // ESPN renders each roster block as a fixed-left table (names) + a horizontally-scrolling table
  // (stats), rows aligned by data-idx. We read names from the left table and inject our columns into
  // the SCROLLER (so they sit with the stats, not on top of the frozen-left panel).
  function decorateBlock(block, indexes) {
    const leftTable = block.querySelector('table.Table--fixed-left') || block.querySelector('table');
    const scroller = block.querySelector('.Table__Scroller table');
    if (!leftTable || !scroller) return;

    const kind = tableKind(leftTable);
    const cols = CONFIG.columns[kind];
    const index = indexes[kind];
    const hand = indexes.hand || {};

    // data-idx -> player, from the left (name) table. Also append handedness to the position cell
    // ("MIL C, DH • Righty") — batSide for hitters, pitchHand for pitchers (so two-way guys resolve
    // by the block they're in). Done here, while we already have the left rows in hand.
    const players = {};
    for (const tr of leftTable.querySelectorAll('tbody tr')) {
      const idx = tr.getAttribute('data-idx');
      if (idx == null) continue;
      const p = rowPlayer(tr);
      if (!p) continue;
      players[idx] = p;
      const posCell = tr.querySelector('.player-column__position');
      if (posCell) {
        // Refresh handedness if this row now shows a different player than we last tagged it for
        // (ESPN reuses row nodes when you sort/filter/paginate, so a stale span would be wrong).
        const want = normName(p.name);
        if (posCell.dataset.savantHandFor !== want) {
          posCell.querySelector('.savant-hand')?.remove();
          const h = hand[normName(p.name)];
          const word = h && handWord(kind === 'pit' ? h.throws : h.bats);
          if (word) {
            const span = document.createElement('span');
            span.className = 'savant-hand';
            span.textContent = `• ${word}`;
            posCell.appendChild(span);
          }
          posCell.dataset.savantHandFor = want;
        }
      }
    }

    // Capture QS from the pitcher list so the modal can reuse it (see rosterStats note above).
    if (kind === 'pit') captureRosterQS(scroller, players);

    hideResearch(scroller);

    // Header: add an "Advanced" group banner + column sub-headers, mirroring ESPN's own header markup
    // (Table__TH + table--cell header) so the block blends in instead of reading as a bolted-on add-on.
    // Keyed on a marker class (not a one-time flag) so it self-heals if a re-render strips our cells.
    const theadRows = [...scroller.querySelectorAll('thead tr')];
    const groupRow = theadRows[0];
    const subRow = theadRows[theadRows.length - 1];
    if (subRow && !subRow.querySelector('.savant-col-th')) {
      if (groupRow && groupRow !== subRow && !groupRow.querySelector('.savant-adv-group')) {
        const gth = document.createElement('th');
        gth.className = 'Table__TH savant-adv-group';
        gth.colSpan = cols.length;
        gth.innerHTML = `<div class="table--cell header" style="text-align:center"><span>Advanced</span></div>`;
        groupRow.appendChild(gth);
      }
      for (const col of cols) {
        const th = document.createElement('th');
        th.className = 'Table__TH savant-col-th';
        th.innerHTML = `<div class="table--cell tar header"><span>${col.label}</span></div>`;
        subRow.appendChild(th);
      }
    }

    // Body: append cells matched by data-idx, using ESPN's cell markup so font + right-alignment match.
    // Shading goes on the td; the inner table--cell div stays transparent. Re-entrant: ESPN reuses the
    // same <tr> nodes when you sort/filter/paginate, so we key each row on the player it currently holds
    // (data-savant-name) and rebuild our cells only when that changes — otherwise stale metrics linger.
    for (const tr of scroller.querySelectorAll('tbody tr')) {
      const idx = tr.getAttribute('data-idx');
      const p = idx != null ? players[idx] : null;
      const want = p ? normName(p.name) : '';
      if (!p) {
        // TOTALS / empty-slot rows: leave them exactly as ESPN ships them. If a reused node turned into
        // a totals row, strip any cells we'd added before.
        if (tr.dataset.savantName) { tr.querySelectorAll('.savant-col').forEach(td => td.remove()); }
        tr.dataset.savantName = '';
        continue;
      }
      const row = lookup(index, p.name, p.team);
      STATS.found++; if (row) STATS.matched++;                 // counted every scan (STATS reset per scan)
      if (tr.dataset.savantName === want && tr.querySelector('.savant-col')) continue; // already current
      tr.querySelectorAll('.savant-col').forEach(td => td.remove());                    // clear stale cells
      for (const col of cols) {
        const td = document.createElement('td');
        td.className = 'Table__TD savant-col';
        const raw = row ? rawValueFor(col, row) : NaN;
        const disp = (row ? valueFor(col, row) : '') || '--';
        td.innerHTML = `<div class="table--cell tar">${disp}</div>`;
        td.dataset.savantKey = col.key;                                    // keys for recolorAll()
        td.dataset.savantVal = Number.isFinite(raw) ? String(raw) : '';
        td.style.backgroundColor = cellColor(col.key, raw);
        if (!row) td.title = 'No Savant match';
        tr.appendChild(td);
      }
      tr.dataset.savantName = want;
    }

    // Shade ESPN's existing OPS column on hitter lists — the one basic stat worth a preference gradient.
    if (kind === 'bat') shadeListColumn(scroller, 'OPS', 'ops', players);
    // Same idea for pitchers: shade the existing ERA + WHIP columns in place.
    if (kind === 'pit') { shadeListColumn(scroller, 'ERA', 'era', players); shadeListColumn(scroller, 'WHIP', 'whip', players); }
  }

  // Shade an existing ESPN column (found by its header label) using a preference key. Re-applied each
  // scan so live in-game value changes restain correctly; tags the cell so recolorAll() catches it too.
  // Skips TOTALS / empty rows (no player) so they stay out-of-the-box.
  function shadeListColumn(scroller, label, key, players) {
    const heads = [...scroller.querySelectorAll('thead tr:last-child th')];
    const i = heads.findIndex(th => (th.textContent || '').trim() === label);
    if (i < 0) return;
    for (const tr of scroller.querySelectorAll('tbody tr')) {
      const idx = tr.getAttribute('data-idx');
      if (!idx || !players[idx]) continue;                                  // skip TOTALS / empty rows
      const td = tr.children[i];
      if (!td) continue;
      const raw = num((td.textContent || '').trim());
      td.dataset.savantKey = key;
      td.dataset.savantVal = Number.isFinite(raw) ? String(raw) : '';
      td.style.backgroundColor = cellColor(key, raw);
    }
  }

  // Find the QS column in a pitcher scroller by its header label, then stash each row's value by name.
  function captureRosterQS(scroller, players) {
    const heads = [...scroller.querySelectorAll('thead tr:last-child th')];
    const qsIdx = heads.findIndex(th => (th.textContent || '').trim() === 'QS');
    if (qsIdx < 0) return;
    for (const tr of scroller.querySelectorAll('tbody tr')) {
      const idx = tr.getAttribute('data-idx');
      const p = idx != null ? players[idx] : null;
      if (!p) continue;
      const cell = tr.children[qsIdx];
      const v = cell ? (cell.textContent || '').trim() : '';
      if (v !== '') rosterStats[normName(p.name)] = { qs: v };
    }
  }

  // OPS = OBP + SLG, formatted like a rate stat (".763" / "1.045"). Inputs are ESPN cell text.
  function opsFmt(obp, slg) {
    const o = num(obp), s = num(slg);
    if (!Number.isFinite(o) || !Number.isFinite(s)) return '';
    const v = o + s;
    return v < 1 ? v.toFixed(3).replace(/^0/, '') : v.toFixed(3);
  }

  // The player-card modal (opens on a player-name click) — a separate DOM target from the roster
  // tables. Adds: handedness under the team name; one computed column (OPS for hitters / QS for
  // pitchers) on ESPN's Season + Last-7 rows; and a single shaded "Savant" row beneath them. The
  // Savant metrics don't share ESPN's column meanings, so each Savant cell is self-labeled (stat over
  // value) rather than relying on the AB/R/H… header above it. Re-run safe: the modal is flagged once
  // its Stats table is in place (we bail without flagging if it hasn't rendered yet, so a later
  // mutation retries). QS comes from the roster-list capture; blank if no pitcher list was scanned.
  function decorateModal(indexes) {
    const modal = document.querySelector('.player-card-modal');
    if (!modal || modal.hasAttribute(FLAG)) return;

    const statsTable = modal.querySelector('.player-stats-table table.Table');
    if (!statsTable) return;                       // still rendering — don't flag, retry next mutation
    const headRow = statsTable.querySelector('thead tr');
    const bodyRows = [...statsTable.querySelectorAll('tbody tr')];
    if (!headRow || !bodyRows.length) return;

    const isPit = !!statsTable.querySelector('thead .stat-ip');
    const kind = isPit ? 'pit' : 'bat';

    const nameWrap = modal.querySelector('.player-name');
    const name = nameWrap ? [...nameWrap.querySelectorAll('div')].map(d => (d.textContent || '').trim()).filter(Boolean).join(' ') : '';

    // Handedness inline next to the team name, like the list: "Milwaukee Brewers • Righty".
    const hand = (indexes.hand || {})[normName(name)];
    const teamEl = modal.querySelector('.player-teamname');
    if (teamEl && hand && !teamEl.parentNode.querySelector('.savant-hand')) {
      const word = handWord(isPit ? hand.throws : hand.bats);
      if (word) {
        const span = document.createElement('span');
        span.className = 'savant-hand';
        span.textContent = `• ${word}`;
        teamEl.insertAdjacentElement('afterend', span);
      }
    }

    // Condense ESPN's own columns in place: OBP+SLG -> a single OPS (hitters); W+L -> QS (pitchers).
    // Relabel the first column, hide the second — keeps the table narrow instead of growing it.
    const headCells = [...headRow.querySelectorAll('th')];
    const headByStat = cls => headCells.find(th => th.querySelector('.' + cls));
    const relabel = (th, text) => { const s = th && th.querySelector('span'); if (s) s.textContent = text; };
    if (!isPit) {
      relabel(headByStat('stat-obp'), 'OPS');
      headByStat('stat-slg')?.classList.add('savant-hidden');
      for (const tr of bodyRows) {
        const obp = tr.querySelector('.stat-obp'), slg = tr.querySelector('.stat-slg');
        const ops = opsFmt(obp?.textContent, slg?.textContent);
        if (obp) {
          obp.textContent = ops;
          const td = obp.closest('td'), raw = num(ops);
          td.dataset.savantKey = 'ops'; td.dataset.savantVal = Number.isFinite(raw) ? String(raw) : '';
          td.style.backgroundColor = cellColor('ops', raw);
        }
        slg?.closest('td')?.classList.add('savant-hidden');
      }
    } else {
      relabel(headByStat('stat-w'), 'QS');
      headByStat('stat-l')?.classList.add('savant-hidden');
      const qs = (rosterStats[normName(name)] || {}).qs || '';
      for (const tr of bodyRows) {
        const w = tr.querySelector('.stat-w'), l = tr.querySelector('.stat-l');
        if (w) w.textContent = (tr.getAttribute('data-idx') === '0') ? qs : ''; // QS is a season total
        l?.closest('td')?.classList.add('savant-hidden');
        // Shade ESPN's existing ERA + WHIP cells in place (off by default; user opts in via Preferences).
        for (const [cls, key] of [['stat-era', 'era'], ['stat-whip', 'whip']]) {
          const cell = tr.querySelector('.' + cls);
          if (!cell) continue;
          const td = cell.closest('td'), raw = num(cell.textContent);
          td.dataset.savantKey = key; td.dataset.savantVal = Number.isFinite(raw) ? String(raw) : '';
          td.style.backgroundColor = cellColor(key, raw);
        }
      }
    }

    // Advanced Stats — its own labeled table (section title + column headers + one Season row) placed
    // under ESPN's Stats table, so the Savant metrics get real headers instead of borrowing ESPN's.
    buildAdvancedTable(modal, kind, lookup(indexes[kind], name), hand && hand.slug);

    modal.setAttribute(FLAG, '1');
  }

  // Build the standalone "Advanced Stats" table beneath ESPN's Stats table, styled with ESPN's own
  // Table classes so it reads as native. One Season row; cells shaded by the same preference logic.
  function buildAdvancedTable(modal, kind, row, slug) {
    const host = modal.querySelector('.player-stats-table');
    if (!host || host.parentNode.querySelector('.savant-adv')) return;
    const cols = CONFIG.columns[kind];
    let head = '<th class="Table__TH"><div class="table--cell header"><span></span></div></th>';
    let body = '<td class="Table__TD savant-adv-rowlabel">Season</td>';
    for (const col of cols) {
      head += `<th class="Table__TH"><div class="table--cell tar header"><span>${col.label}</span></div></th>`;
      if (row) {
        const raw = rawValueFor(col, row), disp = valueFor(col, row) || '--', bg = cellColor(col.key, raw);
        body += `<td class="Table__TD savant-col" data-savant-key="${col.key}" data-savant-val="${Number.isFinite(raw) ? raw : ''}" style="background-color:${bg}"><div class="table--cell tar">${disp}</div></td>`;
      } else {
        body += '<td class="Table__TD"><div class="table--cell tar">--</div></td>';
      }
    }
    // Savant-page link, styled like ESPN's "Complete Stats" link to the right of the Stats header.
    const link = slug
      ? `<a class="AnchorLink header_link" tabindex="0" rel="noopener" target="_blank" href="https://baseballsavant.mlb.com/savant-player/${slug}">Savant Page</a>`
      : '';
    const wrap = document.createElement('div');
    wrap.className = 'savant-adv';
    wrap.innerHTML =
      `<div class="Card__Header__Title__Wrapper savant-adv-title"><h3 class="Card__Header__Title Card__Header__Title--no-theme"><div class="flex justify-between items-center">Advanced Stats${link}</div></h3></div>` +
      `<div class="ResponsiveTable"><div class="Table__ScrollerWrapper"><div>` +
      `<table class="Table"><thead class="Table__THEAD"><tr class="Table__TR Table__even">${head}</tr></thead>` +
      `<tbody class="Table__TBODY"><tr class="Table__TR Table__TR--sm Table__odd">${body}</tr></tbody></table>` +
      `</div></div></div>`;
    host.insertAdjacentElement('afterend', wrap);
  }

  // Disconnect the observer while we mutate, so our own appends don't re-trigger a scan (feedback loop).
  function scan(indexes) {
    if (mo) mo.disconnect();
    try {
      STATS.found = 0; STATS.matched = 0;                 // recount the current view from scratch each scan
      // FantasyCast: skip the live-updating list (constant in-game churn, nothing useful to overlay there)
      // but still decorate the player-card popup if the user clicks a name.
      if (!/\/fantasycast/i.test(location.pathname)) {
        for (const block of document.querySelectorAll('.ResponsiveTable--fixed-left')) {
          try { decorateBlock(block, indexes); } catch (_) { /* keep going */ }
        }
      }
      try { decorateModal(indexes); } catch (_) { /* modal is optional */ }
    } finally {
      updateHud();                                                  // write the HUD while still disconnected…
      if (mo) mo.observe(document.body, { childList: true, subtree: true }); // …then resume observing
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Diagnostic HUD
  // ─────────────────────────────────────────────────────────────────────────
  let hudEl = null;
  function updateHud() {
    // Debug readout shows when enabled; hidden on FantasyCast since the list isn't scanned there.
    if (!showDebug || /\/fantasycast/i.test(location.pathname)) { if (hudEl) hudEl.style.display = 'none'; return; }
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.id = 'savant-hud';
      document.body.appendChild(hudEl);
    }
    hudEl.style.display = '';
    let savant, api = '';
    if (STATS.error) {
      savant = `⚠ Savant: ${STATS.error}`;
    } else if (STATS.loaded == null) {
      savant = 'Savant: loading…';
    } else {
      savant = `Savant: ${STATS.loaded.bat} hitters · ${STATS.loaded.pit} pitchers · matched ${STATS.matched}/${STATS.found} rows`;
      if (STATS.found === 0) savant += ' · ⚠ no player rows (selector?)';
      api = `MLB API: ${STATS.loaded.hand} handedness found`;
    }
    // One row per source: Savant feeds, then the MLB StatsAPI (handedness).
    hudEl.innerHTML = `<div>${savant}</div>` + (api ? `<div>${api}</div>` : '');
    hudEl.dataset.state = STATS.error ? 'err' : (STATS.found === 0 && STATS.loaded != null ? 'warn' : 'ok');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Settings modal — edit per-column highlight thresholds (gear button, bottom-left)
  // ─────────────────────────────────────────────────────────────────────────
  function colMeta() {
    // key -> {label, group}, built from the column defs so labels never drift out of sync.
    const meta = {};
    for (const c of CONFIG.columns.bat) meta[c.key] = { label: c.label, group: 'Hitters' };
    meta.ops = { label: 'OPS', group: 'Hitters' }; // ESPN OPS — shaded but not a Savant column
    for (const c of CONFIG.columns.pit) if (!meta[c.key]) meta[c.key] = { label: c.label, group: 'Pitchers' };
    meta.era = { label: 'ERA', group: 'Pitchers' };   // ESPN ERA — shaded in place, not a Savant column
    meta.whip = { label: 'WHIP', group: 'Pitchers' };  // ESPN WHIP — shaded in place
    return meta;
  }

  function buildSettingsUI() {
    if (document.getElementById('savant-gear')) return;

    const gear = document.createElement('button');
    gear.id = 'savant-gear';
    gear.type = 'button';
    gear.title = 'Preferences';
    gear.textContent = '⚙';
    document.body.appendChild(gear);

    const overlay = document.createElement('div');
    overlay.id = 'savant-modal';
    overlay.hidden = true;

    const meta = colMeta();
    // Show each threshold the same way its column shows data: pct -> "8.0%", dec3 -> ".320" / "1.200",
    // gap3 -> "+.012", etc. squp's stored threshold is already in percent units (not the 0-1 fraction
    // the data is stored as), so it formats with pct, not pctFrac. ops uses dec3 (.800 / 1.200).
    const FMT = {};
    for (const c of CONFIG.columns.bat) FMT[c.key] = c.fmt;
    for (const c of CONFIG.columns.pit) if (!FMT[c.key]) FMT[c.key] = c.fmt;
    FMT.squp = pct;
    FMT.ops = dec3;
    FMT.era = dec2;
    FMT.whip = dec2;
    const fmtTh = (key, v) => (v == null ? '' : (FMT[key] || dec3)(v));
    // Lenient parse back to a number: tolerate %, +, the unicode minus, and a bare leading dot.
    const parseTh = s => {
      const c = String(s).replace(/−/g, '-').replace(/[^0-9.+\-]/g, '');
      const n = parseFloat(c);
      return Number.isFinite(n) ? n : null;
    };
    // One metric row. No group column anymore — grouping is shown via section header rows instead.
    // Toggle off => threshold input is readonly (greyed) but its VALUE is kept, so re-enabling restores it.
    const metricRow = key => {
      const p = PREFS[key] || {};
      const dirLabel = p.dir === 'low' ? 'lower = better' : 'higher = better';
      return `<tr data-key="${key}">
          <td class="savant-m-lab">${meta[key].label}</td>
          <td class="savant-m-onc"><input type="checkbox" class="savant-m-en" ${p.enabled ? 'checked' : ''}></td>
          <td><input type="text" class="savant-m-th" value="${fmtTh(key, p.threshold)}" ${p.enabled ? '' : 'readonly'}></td>
          <td class="savant-m-dir">${dirLabel}</td>
        </tr>`;
    };
    const hitterKeys = Object.keys(meta).filter(k => meta[k].group === 'Hitters');
    const pitcherKeys = Object.keys(meta).filter(k => meta[k].group === 'Pitchers');
    const section = (title, keys) =>
      `<tr class="savant-sec"><td colspan="4">${title}</td></tr>` + keys.map(metricRow).join('');
    const rowsHtml = section('Hitters', hitterKeys) + section('Pitchers', pitcherKeys);

    overlay.innerHTML = `<div class="savant-modal-box">
        <div class="savant-modal-head"><span>Preferences</span><button type="button" id="savant-modal-x">×</button></div>
        <p class="savant-modal-note">Red = better than your threshold, blue = worse, deeper shade = further away.
          Clear the threshold or uncheck a row to turn off shading for that column (unchecking keeps the value).
          Values compare in the units shown in each column (SqUp% in %, xwOBA as .xxx).</p>
        <table class="savant-modal-table">
          <thead><tr><th>Column</th><th>On</th><th>Threshold</th><th>Direction</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="savant-modal-foot">
          <label class="savant-debug-toggle"><input type="checkbox" id="savant-debug-cb"> Show debug readout</label>
          <div class="savant-foot-btns">
            <button type="button" id="savant-modal-reset">Reset to defaults</button>
            <button type="button" id="savant-modal-save">Save</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Live: toggling a row's checkbox greys/un-greys its threshold input without touching the value.
    overlay.querySelector('.savant-modal-table').addEventListener('change', e => {
      if (e.target.classList.contains('savant-m-en')) {
        const th = e.target.closest('tr').querySelector('.savant-m-th');
        if (th) th.readOnly = !e.target.checked;
      }
    });

    const close = () => { overlay.hidden = true; };
    gear.addEventListener('click', () => {
      overlay.querySelector('#savant-debug-cb').checked = showDebug;       // reflect current state on open
      overlay.hidden = false;
    });
    overlay.querySelector('#savant-modal-x').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); }); // click backdrop to dismiss

    overlay.querySelector('#savant-modal-save').addEventListener('click', () => {
      for (const tr of overlay.querySelectorAll('.savant-modal-table tbody tr[data-key]')) {
        const key = tr.getAttribute('data-key');
        const en = tr.querySelector('.savant-m-en').checked;
        const th = parseTh(tr.querySelector('.savant-m-th').value);        // value kept even when disabled
        PREFS[key] = { ...PREFS[key], enabled: en, threshold: th };
      }
      savePrefs(PREFS);
      showDebug = overlay.querySelector('#savant-debug-cb').checked;
      saveDebug();
      close();
      location.reload();   // hard refresh so the list re-decorates cleanly with the new settings
    });

    overlay.querySelector('#savant-modal-reset').addEventListener('click', () => {
      PREFS = defaultPrefs();
      savePrefs(PREFS);
      for (const tr of overlay.querySelectorAll('.savant-modal-table tbody tr[data-key]')) {
        const key = tr.getAttribute('data-key');
        const p = PREFS[key] || {};
        const en = tr.querySelector('.savant-m-en');
        const th = tr.querySelector('.savant-m-th');
        en.checked = !!p.enabled;
        th.value = fmtTh(key, p.threshold);
        th.readOnly = !p.enabled;
      }
      recolorAll();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    .savant-col { background: transparent; font-variant-numeric: tabular-nums; }
    .savant-hidden { display: none !important; }
    #savant-hud { position: fixed; bottom: 48px; left: 10px; z-index: 99999; font: 12px/1.4 -apple-system, system-ui, sans-serif;
      padding: 6px 10px; border-radius: 6px; background: #1d1f23; color: #e6e6e6; box-shadow: 0 2px 8px rgba(0,0,0,.3); opacity: .92; }
    #savant-hud[data-state="err"]  { background: #5b1a1a; }
    #savant-hud[data-state="warn"] { background: #5b4a16; }
    #savant-gear { position: fixed; bottom: 10px; left: 10px; z-index: 99999; width: 30px; height: 30px; padding: 0;
      border: 0; border-radius: 50%; cursor: pointer; font-size: 15px; line-height: 30px; text-align: center;
      background: #1d1f23; color: #e6e6e6; box-shadow: 0 2px 8px rgba(0,0,0,.3); opacity: .92; }
    #savant-gear:hover { opacity: 1; }
    #savant-modal { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
    #savant-modal[hidden] { display: none; }
    .savant-modal-box { width: 470px; max-width: 92vw; max-height: 86vh; overflow: auto; background: #fff; color: #1d1f23;
      border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.4); font: 13px/1.45 -apple-system, system-ui, sans-serif; }
    .savant-modal-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid #e6e6e6; font-weight: 700; font-size: 15px; }
    #savant-modal-x { border: 0; background: none; font-size: 16px; cursor: pointer; color: #777; }
    .savant-modal-note { margin: 12px 16px; color: #555; font-size: 12px; }
    .savant-modal-table { width: 100%; border-collapse: collapse; }
    .savant-modal-table th, .savant-modal-table td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #f0f0f0; }
    .savant-modal-table th { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: #888; }
    .savant-m-lab { font-weight: 600; }
    .savant-m-dir { color: #888; font-size: 11px; }
    .savant-m-th { width: 80px; padding: 3px 6px; }
    .savant-m-th[readonly] { background: #f0f0f0; color: #999; cursor: not-allowed; }
    /* Section header rows replacing the old group column. */
    .savant-sec td { background: #f5f6f8; font-weight: 700; font-size: 11px; text-transform: uppercase;
      letter-spacing: .5px; color: #555; padding: 7px 10px; }
    .savant-m-onc { width: 1%; white-space: nowrap; text-align: center; }
    /* Draw our own checkbox. ESPN forces appearance:none on native inputs, leaving a borderless
       white box that vanishes against the white modal — so we style the box ourselves and add a
       check via ::after. !important to win against ESPN's resets. */
    .savant-modal-box input[type="checkbox"] {
      appearance: none !important; -webkit-appearance: none !important; -moz-appearance: none !important;
      box-sizing: border-box !important; width: 16px !important; height: 16px !important;
      min-width: 16px !important; min-height: 16px !important; margin: 0 !important; padding: 0 !important;
      border: 1.5px solid #9aa3b0 !important; border-radius: 3px !important; background: #fff !important;
      opacity: 1 !important; visibility: visible !important; position: relative !important;
      display: inline-block !important; vertical-align: middle !important; flex: none !important;
      cursor: pointer; box-shadow: none !important; }
    .savant-modal-box input[type="checkbox"]:checked {
      background: #d62e2e !important; border-color: #d62e2e !important; }
    .savant-modal-box input[type="checkbox"]:checked::after {
      content: "" !important; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
    .savant-modal-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 14px 16px; border-top: 1px solid #e6e6e6; }
    .savant-debug-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #555; cursor: pointer; }
    .savant-foot-btns { display: flex; gap: 10px; }
    .savant-modal-foot button { padding: 7px 14px; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; font-size: 13px; }
    #savant-modal-save { background: #d62e2e; color: #fff; border-color: #d62e2e; font-weight: 600; }
    #savant-modal-reset { background: #fff; color: #555; }
    .savant-hand { margin-left: 5px; color: #8a94a6; font-weight: 700; }
    .savant-adv { margin-top: 8px; }
    .savant-adv-title { margin: 12px 0 6px; }
    .savant-adv-rowlabel { font-weight: 600; white-space: nowrap; }
  `);

  buildSettingsUI(); // render the gear + Preferences modal FIRST — no data dependency, always available
  updateHud();
  buildIndex().then(indexes => {
    const count = idx => Object.values(idx).reduce((a, arr) => a + arr.length, 0);
    STATS.loaded = { bat: count(indexes.bat), pit: count(indexes.pit), hand: Object.keys(indexes.hand || {}).length };
    scan(indexes); // first scan runs with mo still null, then we attach the observer below
    mo = new MutationObserver(() => scheduleScan(indexes));
    mo.observe(document.body, { childList: true, subtree: true });
  }).catch(err => {
    STATS.error = err.message;
    updateHud();
    console.error('[Savant Overlay]', err);
  });
})();
