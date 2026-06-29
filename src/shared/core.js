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
  // Pitcher-matchup math (opponent-offense quality). Pure + shared: the SW builds
  // the per-team base (park-neutral team wOBA + league z), the content script folds
  // in the DAY's park per game. Per the methodology review:
  //   - base metric = team wOBA (correct linear weights), not OPS - and self-computed
  //     from the StatsAPI hitting components we already fetch (no new source).
  //   - the base is PARK-NEUTRALIZED so today's park can be applied separately without
  //     double-counting (a Coors-inflated raw line shouldn't read as elite talent).
  //   - colour is driven by a continuous z-score, not the ordinal 1-30 rank (the rank
  //     is kept only as the label, OPRK-style) - this kills the "bunched middle" distortion.
  // ---------------------------------------------------------------------------

  // FanGraphs wOBA linear weights (representative recent-season set; ~stable YoY to ±.01,
  // and for RANK-ORDERING 30 teams the exact vintage is immaterial). uBB = BB - IBB.
  const WOBA_WEIGHTS = { bb: 0.690, hbp: 0.722, b1: 0.884, b2: 1.257, b3: 1.593, hr: 2.058 };

  // Team wOBA from a StatsAPI hitting `stat` object (teams/stats?group=hitting). Returns NaN
  // if the components are missing. den = AB + BB - IBB + SF + HBP (the standard wOBA PA base).
  function teamWoba(stat) {
    if (!stat) return NaN;
    const n = k => { const v = parseFloat(stat[k]); return Number.isFinite(v) ? v : 0; };
    const bb = n('baseOnBalls'), ibb = n('intentionalWalks'), hbp = n('hitByPitch');
    const h = n('hits'), d = n('doubles'), t = n('triples'), hr = n('homeRuns');
    const ab = n('atBats'), sf = n('sacFlies');
    const b1 = h - d - t - hr, ubb = bb - ibb;             // singles, unintentional walks
    const den = ab + bb - ibb + sf + hbp;
    if (!(den > 0)) return NaN;
    const W = WOBA_WEIGHTS;
    return (W.bb * ubb + W.hbp * hbp + W.b1 * b1 + W.b2 * d + W.b3 * t + W.hr * hr) / den;
  }

  // Multi-year regressed RUN park factors, 100 = neutral (FanGraphs-style, compressed toward 100;
  // APPROXIMATE - meant to be eyeballed/updated, not authoritative). Keyed by StatsAPI abbreviation.
  // 2025-26 temporary parks flagged: ATH = Sutter Health Park (Sacramento, hot/hitter-friendly),
  // TB = Steinbrenner Field (Tampa, small/hitter-friendly). Missing team -> neutral (100).
  const PARK_FACTORS = {
    COL: 112, BOS: 107, CIN: 105, KC: 104, AZ: 103, ATH: 103, PHI: 102, TEX: 102, BAL: 101,
    LAA: 101, ATL: 101, CHC: 101, TB: 101, CWS: 100, WSH: 100, TOR: 100, MIN: 100, HOU: 100,
    NYY: 100, MIL: 99, STL: 99, PIT: 99, NYM: 99, LAD: 99, CLE: 99, DET: 98, MIA: 98,
    SF: 97, SD: 96, SEA: 96,
  };

  // wOBA is ~half as park-elastic as runs, so a RUN park factor overstates the wOBA effect.
  // PARK_WOBA_ELASTICITY damps the run factor into a wOBA multiplier; HOME_GAME_SHARE (~half the
  // schedule at home) is how much of a season line a team's home park actually colours.
  const PARK_WOBA_ELASTICITY = 0.5, HOME_GAME_SHARE = 0.5;
  // Full-park wOBA multiplier for a single game at a park with run factor `pf` (100 = 1.000).
  function parkWobaMult(pf) {
    const p = Number.isFinite(pf) ? pf : 100;
    return 1 + (p / 100 - 1) * PARK_WOBA_ELASTICITY;
  }
  // Strip a team's HOME park from its season line: divide by the season-weighted home multiplier.
  function parkNeutralizeWoba(rawWoba, homePf) {
    return rawWoba / (1 + (parkWobaMult(homePf) - 1) * HOME_GAME_SHARE);
  }

  // ---------------------------------------------------------------------------
  // Pitcher command/strikeout rates (K% / BB% / K-BB%) - the doc's #2 (K rate) and
  // #5 (BB rate) SP priorities, neither of which is a Savant field. Self-computed
  // from the StatsAPI SEASON pitching line (the same API family we already use for QS
  // + team wOBA, so no new source): K% = SO/TBF, BB% = BB/TBF, on batters-faced (the
  // pitcher's PA), matching the FanGraphs definition. Returns null if TBF is missing
  // (a rate on no batters is meaningless), so the columns stay blank rather than 0%.
  // Values are returned already percent-scaled (e.g. 28.5), so the pct formatter shows
  // them directly and thresholds compare in percent units. K-BB% is DERIVED in the
  // column (kPct - bbPct) for the same reason the gap columns are: one obvious formula,
  // computed in one place.
  function pitchRates(stat) {
    if (!stat) return null;
    const so = num(stat.strikeOuts), bb = num(stat.baseOnBalls), tbf = num(stat.battersFaced);
    if (!(tbf > 0)) return null;
    return { kPct: 100 * so / tbf, bbPct: 100 * bb / tbf };
  }

  // ---------------------------------------------------------------------------
  // Matchup analyzer - weekly category PROJECTION math (pure + shared). The boxscore
  // page shows a live 2-row category table; these helpers project each team's WEEKLY
  // total per category from the CURRENT roster (DOM-scraped) x public StatsAPI rates,
  // bottom-up so trades/adds/drops are reflected automatically. RATE cats
  // (OPS/ERA/WHIP) are volume-weighted from summed component COUNTS - never averaged -
  // exactly like teamWoba.
  // ---------------------------------------------------------------------------

  // StatsAPI inningsPitched is a thirds STRING: '6.1' = 6 1/3, '6.2' = 6 2/3, '6.0' = 6.
  // (Promoted from background.js so the QS, ERA and WHIP volume math share one parser.)
  function ipToNum(s) { const [w, f] = String(s == null ? '' : s).split('.'); return (+w || 0) + ((+f || 0) / 3); }

  // Normalize a StatsAPI hitting `stat` object to the component vector the projection uses (missing -> 0).
  // `g` = gamesPlayed is the per-game denominator for the counting-cat rates.
  function hitComponents(stat) {
    if (!stat) return null;
    const n = k => { const v = parseFloat(stat[k]); return Number.isFinite(v) ? v : 0; };
    return {
      g: n('gamesPlayed'), pa: n('plateAppearances'), ab: n('atBats'), h: n('hits'),
      dbl: n('doubles'), tpl: n('triples'), hr: n('homeRuns'), bb: n('baseOnBalls'),
      hbp: n('hitByPitch'), sf: n('sacFlies'), r: n('runs'), rbi: n('rbi'), sb: n('stolenBases'),
    };
  }

  // Normalize a StatsAPI pitching `stat` object to the component vector (missing -> 0). `ip` parsed from
  // thirds notation; `gs` (gamesStarted) / `app` (gamesPitched) are the per-start / per-appearance denoms.
  function pitComponents(stat) {
    if (!stat) return null;
    const n = k => { const v = parseFloat(stat[k]); return Number.isFinite(v) ? v : 0; };
    return {
      ip: ipToNum(stat.inningsPitched), er: n('earnedRuns'), h: n('hits'), bb: n('baseOnBalls'),
      k: n('strikeOuts'), gs: n('gamesStarted'), app: n('gamesPitched'), sv: n('saves'),
      w: n('wins'), hld: n('holds'),
    };
  }

  // Is a scheduled game still PROJECTABLE (not yet started)? StatsAPI status.abstractGameState is
  // Preview (not started) / Live (in progress) / Final (done). Only Preview games are projected forward -
  // Live/Final production is already in ESPN's scraped live totals, so projecting them would double-count.
  function isRemainingGame(abstractGameState) { return abstractGameState === 'Preview'; }

  // Blend a season rate with a recent-form rate, down-weighting recent when its sample is thin:
  //   wEff  = w * recentDenom / (recentDenom + shrinkK)   (so a 3-game hot streak can't dominate)
  //   blend = wEff*recent + (1-wEff)*season
  // Falls back gracefully: only-season -> season; only-recent (IL returnee) -> recent; neither -> NaN.
  function blendRate(seasonRate, recentRate, w, recentDenom, shrinkK) {
    const s = Number.isFinite(seasonRate) ? seasonRate : NaN;
    const r = Number.isFinite(recentRate) ? recentRate : NaN;
    if (!Number.isFinite(s) && !Number.isFinite(r)) return NaN;
    if (!Number.isFinite(r)) return s;
    if (!Number.isFinite(s)) return r;
    const d = Number.isFinite(recentDenom) ? recentDenom : 0;
    const k = Number.isFinite(shrinkK) ? shrinkK : 0;
    const denom = d + k;
    const wEff = denom > 0 ? (w || 0) * (d / denom) : 0;
    return wEff * r + (1 - wEff) * s;
  }

  // Team OPS from SUMMED hitting components (volume-weighted; never average per-player OPS). Mirrors the
  // teamWoba discipline: OBP = (H+BB+HBP)/(AB+BB+HBP+SF), SLG = TB/AB, OPS = OBP+SLG. NaN if no AB/PA base.
  function aggOPS(c) {
    if (!c) return NaN;
    const ab = +c.ab || 0, h = +c.h || 0, dbl = +c.dbl || 0, tpl = +c.tpl || 0, hr = +c.hr || 0,
          bb = +c.bb || 0, hbp = +c.hbp || 0, sf = +c.sf || 0;
    const obpDen = ab + bb + hbp + sf;
    if (!(ab > 0) || !(obpDen > 0)) return NaN;
    const tb = (h - dbl - tpl - hr) + 2 * dbl + 3 * tpl + 4 * hr;     // 1B*1 + 2B*2 + 3B*3 + HR*4
    return (h + bb + hbp) / obpDen + tb / ab;
  }

  // Volume-weighted pitching rate cats from summed components (never average per-pitcher ERA/WHIP).
  function aggEra(er, ip) { return ip > 0 ? 9 * (+er || 0) / ip : NaN; }
  function aggWhip(bb, h, ip) { return ip > 0 ? ((+bb || 0) + (+h || 0)) / ip : NaN; }

  // Project a hitter's component COUNTS over `games` games, blending season + recent per-game rates.
  // Used twice: games = remaining-this-week (counting cats: live + projected-remaining) and games =
  // whole-week (OPS: pool projected components, then aggOPS). opts: { w, shrinkK }.
  const HIT_KEYS = ['pa', 'ab', 'h', 'dbl', 'tpl', 'hr', 'bb', 'hbp', 'sf', 'r', 'rbi', 'sb'];
  function projHit(season, recent, games, opts) {
    const w = opts && Number.isFinite(opts.w) ? opts.w : 0.40;
    const k = opts && Number.isFinite(opts.shrinkK) ? opts.shrinkK : 10;   // games
    const g = Math.max(0, +games || 0);
    const rg = recent && recent.g > 0 ? recent.g : 0;
    const out = {};
    for (const key of HIT_KEYS) {
      const sr = season && season.g > 0 ? season[key] / season.g : NaN;
      const rr = rg > 0 ? recent[key] / rg : NaN;
      const rate = blendRate(sr, rr, w, rg, k);
      out[key] = Number.isFinite(rate) ? rate * g : 0;
    }
    return out;
  }

  // Project a starting pitcher's component COUNTS over `starts` starts (per-start rates, season+recent
  // blended, shrunk by recent starts). Returns { k, ip, er, h, bb }. QS is derived separately from the
  // gameLog (>=6 IP & <=3 ER per start); SV is role-based - both are phase-2.
  const START_KEYS = ['k', 'ip', 'er', 'h', 'bb'];
  function projStarter(season, recent, starts, opts) {
    const w = opts && Number.isFinite(opts.w) ? opts.w : 0.40;
    const k = opts && Number.isFinite(opts.shrinkK) ? opts.shrinkK : 4;    // starts
    const n = Math.max(0, +starts || 0);
    const rgs = recent && recent.gs > 0 ? recent.gs : 0;
    const out = {};
    for (const key of START_KEYS) {
      const sr = season && season.gs > 0 ? season[key] / season.gs : NaN;
      const rr = rgs > 0 ? recent[key] / rgs : NaN;
      const rate = blendRate(sr, rr, w, rgs, k);
      out[key] = Number.isFinite(rate) ? rate * n : 0;
    }
    return out;
  }

  // Project a pitcher's component COUNTS over `outings` outings, using per-start (denomKey 'gs') or
  // per-appearance (denomKey 'app') blended rates. Returns { k, ip, er, h, bb, w, sv, hld }.
  const PIT_KEYS = ['k', 'ip', 'er', 'h', 'bb', 'w', 'sv', 'hld'];
  function projPitcher(season, recent, outings, denomKey, opts) {
    const w = opts && Number.isFinite(opts.w) ? opts.w : 0.40;
    const k = opts && Number.isFinite(opts.shrinkK) ? opts.shrinkK : (denomKey === 'gs' ? 4 : 12);
    const n = Math.max(0, +outings || 0);
    const sd = season && season[denomKey] > 0 ? season[denomKey] : 0;
    const rd = recent && recent[denomKey] > 0 ? recent[denomKey] : 0;
    const out = {};
    for (const key of PIT_KEYS) {
      const sr = sd > 0 ? season[key] / sd : NaN;
      const rr = rd > 0 ? recent[key] / rd : NaN;
      const rate = blendRate(sr, rr, w, rd, k);
      out[key] = Number.isFinite(rate) ? rate * n : 0;
    }
    return out;
  }

  // Aggregate a team's STABLE FULL-WEEK projection from per-player inputs (pure; the content script supplies
  // the players + their full-week games/starts/appearances from the DOM + schedule, so the whole pipeline -
  // not just per-player math - is testable here). This is a whole-week total (NOT live + remaining): the
  // projected number stays comparable to the actual at week's end, and a future version can fold in
  // in-week progress + show shift arrows.
  //   hitters:  [{ season, recent, games }]                                    games = team games this week
  //   pitchers: [{ season, recent, starts, apps, isSP, isCloser, qsRate }]     starts/apps = full-week outings
  // Returns:
  //   count - full-week counting totals { R,HR,RBI,SB, K,QS,W,SV,HLD } (SVHD = SV + HLD)
  //   rate  - full-week rate cats { AVG,OBP,SLG,OPS, ERA,WHIP } (volume-weighted from pooled components)
  //   batG / gs / app - context (hitter-games, projected starts, projected relief appearances).
  function projectTeam(hitters, pitchers, opts) {
    const count = { R: 0, HR: 0, RBI: 0, SB: 0, K: 0, QS: 0, W: 0, SV: 0, HLD: 0 };
    const hpool = { ab: 0, h: 0, dbl: 0, tpl: 0, hr: 0, bb: 0, hbp: 0, sf: 0 };
    const ppool = { ip: 0, er: 0, bb: 0, h: 0 };
    let batG = 0, gs = 0, app = 0;
    for (const p of (hitters || [])) {
      const pw = projHit(p.season, p.recent, p.games, opts);
      count.R += pw.r; count.HR += pw.hr; count.RBI += pw.rbi; count.SB += pw.sb;
      for (const k in hpool) hpool[k] += pw[k] || 0;
      batG += Math.max(0, +p.games || 0);
    }
    for (const p of (pitchers || [])) {
      const outings = p.isSP ? (+p.starts || 0) : (+p.apps || 0);
      const pp = projPitcher(p.season, p.recent, outings, p.isSP ? 'gs' : 'app', opts);
      count.K += pp.k;
      ppool.ip += pp.ip; ppool.er += pp.er; ppool.bb += pp.bb; ppool.h += pp.h;
      if (p.isSP) {
        gs += (+p.starts || 0);
        count.W += pp.w;
        count.QS += (Number.isFinite(p.qsRate) ? p.qsRate : 0) * (+p.starts || 0);
      } else {
        app += (+p.apps || 0);
        count.HLD += pp.hld;
        if (p.isCloser) count.SV += pp.sv;
      }
    }
    const ab = hpool.ab, obpDen = ab + hpool.bb + hpool.hbp + hpool.sf;
    const tb = (hpool.h - hpool.dbl - hpool.tpl - hpool.hr) + 2 * hpool.dbl + 3 * hpool.tpl + 4 * hpool.hr;
    const rate = {
      OPS: aggOPS(hpool),
      AVG: ab > 0 ? hpool.h / ab : NaN,
      OBP: obpDen > 0 ? (hpool.h + hpool.bb + hpool.hbp) / obpDen : NaN,
      SLG: ab > 0 ? tb / ab : NaN,
      ERA: aggEra(ppool.er, ppool.ip),
      WHIP: aggWhip(ppool.bb, ppool.h, ppool.ip),
    };
    return { count, rate, batG, gs, app };
  }

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

    // -----------------------------------------------------------------------
    // Matchup analyzer (boxscore page) - the H2H scoring categories the weekly
    // projection can cover (a superset; each league selects its own subset in the
    // popup). group = roster side; type count|rate; dir = which way WINS the cat
    // (high = more is better, low = ERA/WHIP); scale = the weekly MARGIN (display
    // units) that reads as a comfortable category win - drives the win/loss board
    // tint via cellSignal; field = the StatsAPI counting field; est = the projection
    // is estimate-heavy (pitching cats: they hinge on a start-count / role model and
    // confirmed probables, so the board marks them with ~). derive = a cat composed
    // from others (SVHD = SV + HLD). cal = a per-category calibration multiplier (default 1) applied to the
    // projection in the content layer, from back-testing vs actual weekly totals: hitting power runs a touch
    // hot (R/HR), ERA/WHIP project ~10-13% optimistic (streamer/spot-start blow-ups the model can't see),
    // and saves over-project (closer appearance estimate). Uniform per cat, so it sharpens the displayed
    // number + accuracy without changing which team is projected to win the cat. Re-tune as the log grows.
    cats: {
      // Hitting
      R:    { label: 'R',    group: 'bat', type: 'count', dir: 'high', scale: 8,     field: 'runs',        cal: 0.92 },
      HR:   { label: 'HR',   group: 'bat', type: 'count', dir: 'high', scale: 4,     field: 'homeRuns',    cal: 0.91 },
      RBI:  { label: 'RBI',  group: 'bat', type: 'count', dir: 'high', scale: 8,     field: 'rbi' },
      SB:   { label: 'SB',   group: 'bat', type: 'count', dir: 'high', scale: 3,     field: 'stolenBases' },
      AVG:  { label: 'AVG',  group: 'bat', type: 'rate',  dir: 'high', scale: 0.020 },
      OBP:  { label: 'OBP',  group: 'bat', type: 'rate',  dir: 'high', scale: 0.025 },
      SLG:  { label: 'SLG',  group: 'bat', type: 'rate',  dir: 'high', scale: 0.040 },
      OPS:  { label: 'OPS',  group: 'bat', type: 'rate',  dir: 'high', scale: 0.030 },
      // Pitching (est: start-count / role estimates)
      K:    { label: 'K',    group: 'pit', type: 'count', dir: 'high', scale: 12,    field: 'strikeOuts', est: true },
      QS:   { label: 'QS',   group: 'pit', type: 'count', dir: 'high', scale: 2,                          est: true },
      W:    { label: 'W',    group: 'pit', type: 'count', dir: 'high', scale: 2,     field: 'wins',       est: true },
      SV:   { label: 'SV',   group: 'pit', type: 'count', dir: 'high', scale: 2,     field: 'saves',      est: true, cal: 0.84 },
      HLD:  { label: 'HLD',  group: 'pit', type: 'count', dir: 'high', scale: 3,     field: 'holds',      est: true },
      SVHD: { label: 'SVHD', group: 'pit', type: 'count', dir: 'high', scale: 3,     derive: 'sv+hld',    est: true },
      ERA:  { label: 'ERA',  group: 'pit', type: 'rate',  dir: 'low',  scale: 0.60,                       est: true, cal: 1.13 },
      WHIP: { label: 'WHIP', group: 'pit', type: 'rate',  dir: 'low',  scale: 0.12,                       est: true, cal: 1.10 },
    },

    // Default league format (user-editable in the popup). Defaults to the developer's league: H2H
    // categories, weekly Mon-Sun matchups, these 10 cats. weekStartDow: 1 = Monday (JS Date.getDay).
    leagueFormatDefault: {
      scoring: 'h2h_categories',
      period: 'weekly',
      weekStartDow: 1,
      cats: ['R', 'HR', 'RBI', 'SB', 'OPS', 'K', 'QS', 'SV', 'ERA', 'WHIP'],
    },

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
    //  - team hitting: the wOBA COMPONENTS (BB/IBB/HBP/H/2B/3B/HR/AB/SF) to self-compute park-neutral team
    //    wOBA and rank offenses (a pitcher facing a weak offense = good matchup). See BV.teamWoba.
    //  - per-batter splits vs LHP / vs RHP (OPS + PA): the batter's production vs the day's opposing hand.
    mlbTeams:       (year) => `https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${year}`,
    mlbTeamHitting: (year) => `https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=hitting&season=${year}&sportIds=1`,
    mlbStatsSplits: (id, year) => `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr&season=${year}&gameType=R`,

    // Per-pitcher game log (regular season). QS (Quality Starts) is NOT a field on Savant or StatsAPI
    // — it is computed from this feed: a start with >=6 IP and <=3 ER. Authoritative season value,
    // independent of ESPN's list-filter window (the old roster-list scrape got this wrong when the
    // list was filtered to Last 7/15/30/Projected).
    mlbStatsGameLog: (id, year) => `https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=${year}&gameType=R`,

    // Bulk SEASON pitching line for EVERY pitcher (one call, ~700 rows), used to derive K% / BB% / K-BB%
    // (BV.pitchRates) and join them onto the pitcher index by MLBAM id (player_id == person.id). Same
    // statsapi host already permitted - no new source. `playerPool=all` + a high limit returns the whole
    // pool (incl. relievers); each split carries player.id and stat.{strikeOuts,baseOnBalls,battersFaced}.
    mlbPitching: (year) => `https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&season=${year}&sportId=1&playerPool=all&limit=2000&gameType=R`,

    // Matchup analyzer (boxscore page) - bulk component lines + the week's schedule. Public StatsAPI, no
    // key; the SEASON pitching bulk reuses mlbPitching above (it already carries K/IP/ER/BB/H/SV/GS).
    // playerPool=all + a high limit returns the whole pool; byDateRange is the recent-form window (~30d);
    // schedule?hydrate=probablePitcher gives games-per-team + near-term starters (probables post only
    // ~2-4 days out, so back-half-of-week starts are estimated content-side, not from this feed). All
    // verified live 2026. dates are YYYY-MM-DD.
    mlbHitting:       (year) => `https://statsapi.mlb.com/api/v1/stats?stats=season&group=hitting&season=${year}&sportId=1&playerPool=all&limit=2000&gameType=R`,
    mlbHittingRange:  (year, start, end) => `https://statsapi.mlb.com/api/v1/stats?stats=byDateRange&group=hitting&season=${year}&sportId=1&playerPool=all&limit=2000&startDate=${start}&endDate=${end}&gameType=R`,
    mlbPitchingRange: (year, start, end) => `https://statsapi.mlb.com/api/v1/stats?stats=byDateRange&group=pitching&season=${year}&sportId=1&playerPool=all&limit=2000&startDate=${start}&endDate=${end}&gameType=R`,
    mlbSchedule:      (start, end) => `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${start}&endDate=${end}&hydrate=probablePitcher`,

    // Closers + hitters ALWAYS come from Pitcher List (the selectable SP sources below publish STARTERS
    // only): reliever "Top 50 Closers" and the "Top 150 Hitters" list. Weekly ARTICLES (no API), each a
    // clean server-rendered <table class="list"> (verified live 2026: td.rank / td.name>a / td.team /
    // span.tier - one parser handles both). The latest week's article is resolved via the category RSS
    // feed (newest <link> first; the category HTML index is the fallback). Only factual
    // rank+name+slug+team+tier are taken - never the prose write-ups (those stay on PL's site; see
    // PROJECT doc §5/§2). Parsing lives in background.js. (The SP "The List" feed/index live in
    // spSources.pitcherList below - SP is the one list that can come from a different source.)
    pitcherList: {
      rpFeed:   'https://pitcherlist.com/category/fantasy/relief-pitchers/reliever-ranks/feed/',
      hitFeed:  'https://pitcherlist.com/category/fantasy/hitters-fantasy/hitter-list/feed/',
      rpIndex:  'https://pitcherlist.com/category/fantasy/relief-pitchers/reliever-ranks/',
      hitIndex: 'https://pitcherlist.com/category/fantasy/hitters-fantasy/hitter-list/',
    },

    // Starting-pitcher rank SOURCES - the SP rank is user-selectable (popup dropdown; STORAGE.spSource).
    // Closers + hitters always stay Pitcher List (above); the others publish SP-only weekly lists. Plain
    // DATA only (HARD RULE: no functions/RegExp in shared CONFIG): `articleRe` is a STRING the service
    // worker rebuilds with new RegExp(articleRe, articleReFlags); `playerUrl` is a "{slug}" template (or
    // null when the source's ranking table carries no per-player link). Each weekly ranking is a
    // server-rendered HTML table the SW regex-parses (verified live 2026); the latest week's article is
    // resolved via the category RSS feed (newest link first; the category HTML index is the fallback).
    // `minRows` is the trust floor -> a short/broken parse renders NO SP rank rather than wrong ranks.
    //   pitcherList - SP "The List" (Top 100): <table class="list">, names linked to /player/{slug}/.
    //   razzball    - "Top 100 Starting Pitchers": the LARGEST plain <table> (rank|name|team|notes); the
    //                 author's ~20-row "Pitching WAR" chart is the smaller decoy. Names unlinked -> no URL.
    //   rotoBaller  - "SP Rankings for Week N": the table with the MOST player links (rank|tier|player|…);
    //                 a small "prospects to stash" table is the decoy. Players link to /mlb/player/{id}/{name}.
    spSources: {
      pitcherList: {
        id: 'pitcherList', label: 'Pitcher List', abbr: 'PL',
        spFeed:    'https://pitcherlist.com/category/fantasy/starting-pitchers/the-list/feed/',
        spIndex:   'https://pitcherlist.com/category/fantasy/starting-pitchers/the-list/',
        articleRe: 'https://pitcherlist\\.com/top-100-starting-pitchers[a-z0-9-]*/', articleReFlags: 'i',
        minRows: 50, parser: 'pl', playerUrl: 'https://pitcherlist.com/player/{slug}/',
      },
      razzball: {
        id: 'razzball', label: 'Razzball', abbr: 'RZ',
        spFeed:    'https://razzball.com/category/top-100-starting-pitchers/feed/',
        spIndex:   'https://razzball.com/category/top-100-starting-pitchers/',
        articleRe: 'https://razzball\\.com/top-100-starting-pitchers[a-z0-9-]*/', articleReFlags: 'i',
        minRows: 50, parser: 'razzball', playerUrl: null,
      },
      rotoBaller: {
        id: 'rotoBaller', label: 'RotoBaller', abbr: 'RB',
        spFeed:    'https://www.rotoballer.com/category/mlb/fantasy-baseball-advice-analysis/mlb-rankings/feed',
        spIndex:   'https://www.rotoballer.com/category/mlb/fantasy-baseball-advice-analysis/mlb-rankings/',
        articleRe: 'https://www\\.rotoballer\\.com/fantasy-baseball-starting-pitcher-rankings-for-week-\\d+-\\d{4}/\\d+', articleReFlags: 'i',
        minRows: 40, parser: 'roto', playerUrl: 'https://www.rotoballer.com{slug}',
      },
    },
    spSourceDefault: 'pitcherList',

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
        // K% / BB% / K-BB% from the StatsAPI season line (BV.pitchRates joins kPct/bbPct onto the index
        // by player_id - NOT a Savant field). K rate is the doc's #2 SP priority, BB rate #5; K-BB% is the
        // single most stable command signal, so it's the highlighted default. K-BB% is DERIVED (kPct-bbPct).
        { key: 'kpct',   label: 'K%',     sourceCandidates: ['kPct'],                                fmt: pct },
        { key: 'bbpct',  label: 'BB%',    sourceCandidates: ['bbPct'],                               fmt: pct },
        { key: 'kbb',    label: 'K-BB%',  derive: r => num(r.kPct) - num(r.bbPct),                   fmt: pct },
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
      // K% / BB% / K-BB% (StatsAPI-derived). K% higher = better (doc target 25%+, the shading line), BB%
      // lower = better (doc: sub-7% is the stable WHIP predictor), K-BB% higher = better (~15%+ good, 20%+ elite).
      // Scales are tight on purpose so a clearly-good value saturates: at scale 4, a 28% K (+3 over the 25
      // line) reaches ~3/4 strength and 29%+ is full; K-BB% maxes at ~20% (scale 5). A gentle scale washed
      // good arms out into the same pale tint as average ones.
      kpct:   { show: true, enabled: true,  threshold: 25,    dir: 'high', scale: 4 },
      bbpct:  { show: true, enabled: true,  threshold: 7,     dir: 'low',  scale: 3 },
      kbb:    { show: true, enabled: true,  threshold: 15,    dir: 'high', scale: 5 },
      oxwoba: { show: true, enabled: true,  threshold: 0.310, dir: 'low',  scale: 0.060 },
      // oBrl% / oHH% (contact ALLOWED) default to Show OFF - oxwOBA already captures contact suppression,
      // and hiding these two keeps room for the K%/BB%/K-BB% command columns. Highlight stays on, so a
      // user who turns Show back on still gets the shading. (Existing saved prefs override this default;
      // Reset to defaults, or toggle Show off, to adopt it.)
      obrl:   { show: false, enabled: true, threshold: 8,     dir: 'low',  scale: 6 },
      ohh:    { show: false, enabled: true, threshold: 40,    dir: 'low',  scale: 12 },
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

  // Merge saved prefs onto a fresh copy of the defaults, adopting ONLY the user-editable fields
  // (threshold / enabled / show). `scale` and `dir` are internal shading tuning the popup never exposes,
  // so they ALWAYS come from the current defaults - otherwise a default scale/dir change would silently
  // fail to reach existing users, whose saved prefs (the popup persists the WHOLE object) would pin the
  // old values. Keys absent from `saved` keep their defaults, so new columns appear for existing users.
  const USER_PREF_FIELDS = ['threshold', 'enabled', 'show'];
  function mergePrefs(saved) {
    const base = defaultPrefs();
    if (saved && typeof saved === 'object') {
      for (const k in base) {
        const s = saved[k];
        if (!s || typeof s !== 'object') continue;
        for (const f of USER_PREF_FIELDS) if (f in s) base[k][f] = s[f];
      }
    }
    return base;
  }

  // Default Pitcher List display toggles, merged with any saved subset (so new lists default sensibly).
  function defaultPlPrefs() { return { ...CONFIG.plPrefs }; }
  function mergePlPrefs(saved) { return { ...CONFIG.plPrefs, ...(saved && typeof saved === 'object' ? saved : {}) }; }

  // League format (matchup analyzer). Deep-clone the default; merge a saved subset, keeping only known
  // category keys (an unknown/empty cats list falls back to the default 10) so a stale save can't break
  // the board. Mirrors the defaultPrefs/mergePrefs discipline.
  function defaultLeagueFormat() { return JSON.parse(JSON.stringify(CONFIG.leagueFormatDefault)); }
  function mergeLeagueFormat(saved) {
    const base = defaultLeagueFormat();
    if (saved && typeof saved === 'object') {
      if (typeof saved.scoring === 'string') base.scoring = saved.scoring;
      if (typeof saved.period === 'string') base.period = saved.period;
      if (Number.isInteger(saved.weekStartDow)) base.weekStartDow = saved.weekStartDow;
      if (Array.isArray(saved.cats)) {
        const known = saved.cats.filter(k => CONFIG.cats[k]);
        if (known.length) base.cats = known;
      }
    }
    return base;
  }
  // Resolve a format's selected categories to ordered cat objects ({ key, ...CONFIG.cats[key] }).
  function catList(format) {
    const keys = (format && Array.isArray(format.cats) ? format.cats : CONFIG.leagueFormatDefault.cats)
      .filter(k => CONFIG.cats[k]);
    return keys.map(k => ({ key: k, ...CONFIG.cats[k] }));
  }
  // Board tint signal: signed normalized margin (self - opp) for a cat, via the same cellSignal engine the
  // column shading uses (red = this side projected to win, blue = lose, |t| = margin confidence). dir:'low'
  // cats (ERA/WHIP) flip the sign inside cellSignal. Returns { t, better } or null (missing value / exact tie).
  function matchupSignal(cat, selfVal, oppVal) {
    if (!cat || !Number.isFinite(selfVal) || !Number.isFinite(oppVal)) return null;
    const pref = { x: { enabled: true, threshold: 0, dir: cat.dir, scale: cat.scale } };
    return cellSignal(pref, 'x', selfVal - oppVal);
  }
  // Resolve which rank to display for a record given the toggles + row kind. Returns
  // { rank, list:'sp'|'rp'|'h', src, slug, tier } or null when nothing should show. The SP rank carries
  // its own source (rec.spSrc/spSlug/spTier) so the badge can label + link it correctly; closers and
  // hitters are always Pitcher List. Master off -> always null.
  function plPick(rec, kind, pl) {
    if (!rec || !pl || pl.on === false) return null;
    if (kind === 'bat') return (pl.h !== false && rec.h != null)
      ? { rank: rec.h, list: 'h', src: 'pitcherList', slug: rec.slug, tier: rec.tier } : null;
    if (pl.sp !== false && rec.sp != null)
      return { rank: rec.sp, list: 'sp', src: rec.spSrc || 'pitcherList', slug: rec.spSlug, tier: rec.spTier };
    if (pl.rp !== false && rec.rp != null)
      return { rank: rec.rp, list: 'rp', src: 'pitcherList', slug: rec.slug, tier: rec.tier };
    return null;
  }

  // SP rank sources (user-selectable). The registry (CONFIG.spSources) is plain data; these resolve and
  // validate a chosen id, falling back to the default (Pitcher List) on an unknown/absent id.
  function spSourceList() { return Object.values(CONFIG.spSources).map(s => ({ id: s.id, label: s.label })); }
  function validSpSource(id) { return !!(id && CONFIG.spSources[id]); }
  function spSourceCfg(id) { return CONFIG.spSources[id] || CONFIG.spSources[CONFIG.spSourceDefault]; }

  // Count helper for the loaded-rows diagnostic: each index value is an array of records.
  function countIndex(idx) { return Object.values(idx || {}).reduce((a, arr) => a + arr.length, 0); }

  // Storage keys (chrome.storage). Cache key is versioned + year-scoped.
  const STORAGE = {
    prefs: 'prefs',                 // chrome.storage.sync
    leagueFormat: 'leagueFormat',   // chrome.storage.sync (matchup-analyzer league config: scoring/period/cats)
    matchupOn: 'matchupOn',         // chrome.storage.sync (matchup analyzer on/off; absent = on)
    plPrefs: 'plPrefs',             // chrome.storage.sync (Pitcher List display toggles: {on,sp,rp,h})
    debug: 'debug',                 // chrome.storage.sync
    enabled: 'enabled',             // chrome.storage.sync (master on/off for the WHOLE extension; absent = on)
    // Advanced Stats feature on/off (injected Savant columns + ESPN OPS/ERA/WHIP cell highlighting +
    // handedness + the per-row matchup symbols + the player-card Advanced table/sliders). Independent of
    // `enabled` (the whole-extension switch) and of the Top-list-ranks / Matchup-analyzer feature toggles,
    // so a user can keep ranks/matchup while turning the advanced overlay off. Absent = on. The on-page
    // "Show Advanced Stats · Barrel Vision" toggle and the popup's Advanced Stats tab both write this key.
    advancedOn: 'advancedOn',       // chrome.storage.sync (advanced-stats overlay on/off; absent = on)
    spSource: 'spSource',           // chrome.storage.sync (selected SP rank source id; absent = pitcherList)
    // v7: pitcher records now carry kPct/bbPct (StatsAPI K%/BB%, joined by player_id) for the K%/BB%/K-BB%
    //     columns; a v6 cache lacks them, so bump to rebuild rather than show blanks until the 12h TTL.
    // v6: the SP entry of the `pl` index is now source-tagged (spSrc/spSlug/spTier) so a non-PL starters
    //     source can be selected; closers + hitters stay Pitcher List.
    // v5: pitcher matchup now grades park-neutral team wOBA (was OPS); teamOff entries carry
    //     { woba, nwoba, pf, rank, z } and a sibling `teamOffMeta` { mean, sd, total } is added.
    // v4: added team-offense (`teamOff`/`teamAbbr`) + the player's team id on the hand index (matchups).
    // v3: added the Savant percentile index (`pct`) for the player-card sliders.
    // v2: the hand index also carries the player's MLBAM id (used to compute QS).
    cacheKey: (year) => `barrelVision:index:v7:${year}`,      // chrome.storage.local
    qsKey: (year) => `barrelVision:qs:v1:${year}`,            // chrome.storage.local (per-pitcher QS cache)
    splitsKey: (year) => `barrelVision:splits:v1:${year}`,    // chrome.storage.local (per-batter platoon splits)
    // v2: the weekly cache now carries the SP source id (`src`) so switching source forces a refetch.
    plKey: (year) => `barrelVision:pl:v2:${year}`,            // chrome.storage.local (weekly SP/PL cache)
    plOverride: (year) => `barrelVision:plOverride:v1:${year}`, // chrome.storage.local (manual-paste fallback)
    // Per-list rank source health (rows parsed, source, mode, when) for the popup's "ranks last updated"
    // line - written by getPL on every resolution (fetch/override/cache) so a graceful skip is visible.
    plHealth: (year) => `barrelVision:plHealth:v1:${year}`,   // chrome.storage.local
    // Matchup analyzer: season+recent component lines (12h, year-scoped) and the week schedule/probables
    // (3h, window-scoped - probables + played/remaining move through the day).
    matchupStatsKey: (year) => `barrelVision:mxstats:v1:${year}`,  // chrome.storage.local
    matchupSchedKey: (year) => `barrelVision:mxsched:v1:${year}`,  // chrome.storage.local
    // Projection accuracy log (local only, no backend): per league+week+team it stores a daily projection
    // snapshot (projByDay) + the latest LIVE actual. Powers the daily up/down shift arrows, lets us measure
    // projection error over a few weeks to tune the model, and doubles as a cross-page projection cache.
    matchupLog:      (year) => `barrelVision:mxlog:v1:${year}`,    // chrome.storage.local
  };

  root.BV = {
    CONFIG, STORAGE,
    num, pct, pctFrac, dec3, dec2, dec1, gap3, gapEra,
    normName, handWord, cellSignal, cellColor, defaultPrefs, mergePrefs,
    defaultPlPrefs, mergePlPrefs, plPick, countIndex,
    spSourceList, validSpSource, spSourceCfg,
    teamWoba, parkWobaMult, parkNeutralizeWoba, PARK_FACTORS, pitchRates,
    ipToNum, isRemainingGame, hitComponents, pitComponents, blendRate, aggOPS, aggEra, aggWhip,
    projHit, projStarter, projPitcher, projectTeam,
    defaultLeagueFormat, mergeLeagueFormat, catList, matchupSignal,
  };
})(typeof self !== 'undefined' ? self : this);
