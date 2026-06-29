/*
 * Barrel Vision - background service worker (classic, NOT a module)
 * ---------------------------------------------------------------------------
 * The only context that can fetch baseballsavant.mlb.com / statsapi.mlb.com
 * cross-origin: since Chrome 85 a content script's fetch is bound to the page's
 * (espn.com) origin for CORS and does NOT inherit the extension's
 * host_permissions, but the service worker DOES. So the content script
 * message-passes here; this worker fetches + parses + caches + replies.
 *
 * Classic worker (no "type":"module" in the manifest) so importScripts works.
 * Stateless: the only persisted state is the parsed index in chrome.storage.local
 * (the SW is killed after ~30s idle - never trust its in-memory state).
 */
importScripts('shared/core.js'); // provides globalThis.BV (CONFIG, normName, countIndex, ...)

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Minimal CSV parser (handles quoted fields containing commas).
// ---------------------------------------------------------------------------
function parseCsv(text) {
  text = text.replace(/^﻿/, '');           // strip BOM (Savant CSVs lead with one)
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
  // Batted-ball/expected feeds use "last_name, first_name"; bat-tracking uses "name", percentile-rankings
  // uses "player_name" - both in the same "Last, First" text. Treat any comma-bearing value as Last,
  // First and flip it (Savant is consistent: a comma in a name field always means "Last, First").
  const lastFirst = r['last_name, first_name']
    || (r.name && r.name.includes(',') ? r.name : '')
    || (r.player_name && r.player_name.includes(',') ? r.player_name : '');
  if (lastFirst) {
    const [last, first] = lastFirst.split(',').map(s => (s || '').trim());
    return `${first} ${last}`;
  }
  if (r.first_name || r.last_name) return `${r.first_name || ''} ${r.last_name || ''}`.trim();
  return r.name || r.player_name || '';
}

// Merge a list of feeds (each: {label, url, idField, optional}) into a name-keyed index.
// Records are merged on MLBAM id first (per-feed key map: bat-tracking uses `id`, the others
// `player_id`), then re-keyed by normalized name into arrays so the team tiebreaker can act.
async function mergeFeeds(feeds) {
  const byId = {};
  for (const feed of feeds) {
    let text;
    try {
      text = await fetchText(feed.url);
      if (/^\s*</.test(text)) throw new Error('got HTML, not CSV');
    } catch (e) {
      if (feed.optional) { console.warn(`[Barrel Vision] ${feed.label} skipped: ${e.message}`); continue; }
      throw new Error(`${feed.label} fetch: ${e.message}`);
    }
    for (const r of parseCsv(text)) {
      const id = r[feed.idField]; if (!id) continue;
      byId[id] = { ...byId[id], ...r, _name: byId[id]?._name || rowName(r) };
    }
  }
  const byName = {};
  for (const id in byId) {
    const k = BV.normName(byId[id]._name);
    if (!k) continue;
    (byName[k] ||= []).push(byId[id]);
  }
  return byName;
}

// ---------------------------------------------------------------------------
// Index build
// ---------------------------------------------------------------------------
async function buildFresh(forcePl) {
  const Y = BV.CONFIG.year, M = BV.CONFIG.minBattedBalls, S = BV.CONFIG.savant;

  // Batter index: two required batted-ball feeds + the optional bat-tracking validation layer
  // (keys on `id`, not `player_id`; if it fails the other columns still render).
  const bat = await mergeFeeds([
    { label: 'exit-velo',      url: S.exitVelo(Y, M), idField: 'player_id' },
    { label: 'expected-stats', url: S.expected(Y, M), idField: 'player_id' },
    { label: 'bat-tracking',   url: S.batTracking(Y), idField: 'id', optional: true },
  ]);

  // Pitcher index: type=pitcher versions of the two batted-ball feeds (contact ALLOWED + xERA).
  // Optional as a block - if pitcher feeds fail, batter columns still render; pitcher rows go blank.
  let pit = {};
  try {
    pit = await mergeFeeds([
      { label: 'exit-velo-pit',      url: S.exitVeloPit(Y, M), idField: 'player_id' },
      { label: 'expected-stats-pit', url: S.expectedPit(Y, M), idField: 'player_id' },
    ]);
  } catch (e) { console.warn(`[Barrel Vision] pitcher feeds skipped: ${e.message}`); }

  // K% / BB% (doc SP priorities #2 + #5) from the StatsAPI season pitching line, joined onto the pitcher
  // records by MLBAM id (Savant's player_id == StatsAPI person.id). ONE bulk call - no per-pitcher fetch -
  // and best-effort: a failure just leaves the K%/BB%/K-BB% columns blank, everything else unaffected.
  // K-BB% is derived in the column from kPct/bbPct (see CONFIG.columns.pit / BV.pitchRates).
  try {
    const pj = JSON.parse(await fetchText(BV.CONFIG.mlbPitching(Y)));
    const splits = (pj.stats && pj.stats[0] && pj.stats[0].splits) || [];
    const rates = {};
    for (const s of splits) {
      const id = s.player && s.player.id;
      const r = BV.pitchRates(s.stat);
      if (id != null && r) rates[id] = r;                          // keyed by MLBAM id (string-coerced)
    }
    for (const arr of Object.values(pit)) for (const rec of arr) {
      const r = rates[rec.player_id];
      if (r) { rec.kPct = r.kPct; rec.bbPct = r.bbPct; }
    }
  } catch (e) { console.warn(`[Barrel Vision] pitcher K%/BB% skipped: ${e.message}`); }

  // Savant percentile rankings (the 0-100 values behind the player-page sliders) - one CSV per type,
  // kept in a SEPARATE index (NOT merged into bat/pit: the percentile CSV reuses column names like
  // brl_percent that would clobber the raw values in those feeds). Each is optional on its own; a
  // failure just means that type's sliders don't render. name->[record] like the other Savant indexes.
  const pct = { bat: {}, pit: {} };
  try { pct.bat = await mergeFeeds([{ label: 'percentile-bat', url: S.percentile(Y), idField: 'player_id' }]); }
  catch (e) { console.warn(`[Barrel Vision] batter percentiles skipped: ${e.message}`); }
  try { pct.pit = await mergeFeeds([{ label: 'percentile-pit', url: S.percentilePit(Y), idField: 'player_id' }]); }
  catch (e) { console.warn(`[Barrel Vision] pitcher percentiles skipped: ${e.message}`); }

  // Handedness from MLB StatsAPI, keyed by normalized name -> { bats, throws, slug } (L/R/S codes).
  // Optional: if it fails, handedness simply doesn't render and everything else is unaffected.
  // NOTE: a flat name->object map (NOT arrays like the Savant feeds) - the content script reads it directly.
  let hand = {};
  try {
    const json = JSON.parse(await fetchText(BV.CONFIG.mlbStats(Y)));
    for (const p of (json.people || [])) {
      const k = BV.normName(p.fullName || p.firstLastName || `${p.firstName || ''} ${p.lastName || ''}`);
      if (!k) continue;
      // team (currentTeam.id) lets the content script resolve the opposing probable pitcher by team +
      // last name (ESPN shows the pitcher's last name only) for the matchup ratings.
      hand[k] = { bats: p.batSide?.code || '', throws: p.pitchHand?.code || '', slug: p.nameSlug || '', id: p.id || '', team: p.currentTeam?.id || '' };
    }
  } catch (e) { console.warn(`[Barrel Vision] StatsAPI handedness skipped: ${e.message}`); }

  // Team offense for the pitcher matchup: grade all 30 teams by PARK-NEUTRAL team wOBA (rank 1 = best
  // offense = the TOUGHEST matchup). wOBA is self-computed from the StatsAPI hitting components (no new
  // source) with correct linear weights, then home-park-neutralized so the content script can fold in
  // today's park separately without double-counting (see CONFIG.teamWoba / parkNeutralizeWoba). Each
  // entry carries { woba (raw), nwoba (park-neutral), pf (home run-PF), rank, z }; `teamOffMeta` holds
  // the league mean/sd of nwoba so the content script can re-z each game on its day's park. teamAbbr
  // maps StatsAPI abbreviation -> id (ESPN opponent abbrev -> team). Best-effort: a failure hides grades.
  let teamOff = {}, teamAbbr = {}, teamOffMeta = null;
  try {
    const teams = (JSON.parse(await fetchText(BV.CONFIG.mlbTeams(Y))).teams) || [];
    const idToAbbr = {};
    for (const t of teams) if (t.id && t.abbreviation) {
      const A = t.abbreviation.toUpperCase();
      teamAbbr[A] = t.id; idToAbbr[t.id] = A;
    }
    const hit = JSON.parse(await fetchText(BV.CONFIG.mlbTeamHitting(Y)));
    const rows = ((hit.stats && hit.stats[0] && hit.stats[0].splits) || [])
      .map(s => {
        const id = s.team && s.team.id;
        const woba = BV.teamWoba(s.stat);
        const pf = (BV.PARK_FACTORS[idToAbbr[id]] ?? 100);          // home park run factor (neutral if unknown)
        return { id, woba, pf, nwoba: BV.parkNeutralizeWoba(woba, pf) };
      })
      .filter(r => r.id && Number.isFinite(r.nwoba))
      .sort((a, b) => b.nwoba - a.nwoba);                           // highest park-neutral wOBA first -> rank 1
    const vals = rows.map(r => r.nwoba);
    const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length || 1)) || 1;
    rows.forEach((r, i) => {
      teamOff[r.id] = { woba: r.woba, nwoba: r.nwoba, pf: r.pf, rank: i + 1, z: (r.nwoba - mean) / sd };
    });
    teamOffMeta = { mean, sd, total: rows.length };
  } catch (e) { console.warn(`[Barrel Vision] team offense skipped: ${e.message}`); }

  // Pitcher List weekly ranks, keyed by normalized name -> { sp?, rp?, slug, tier, team } (a flat
  // name->object map like `hand`, NOT arrays - the content script reads it directly and renders it
  // inline after handedness). Best-effort: any failure leaves `pl` partial/empty; nothing else breaks.
  // PL has its own weekly cache/override, so a normal/advanced rebuild does NOT force it (forcePl is
  // only true via the dedicated "Refresh Pitcher List" path); it still auto-fetches when its cache expires.
  let pl = {};
  try { pl = await getPL(forcePl); }
  catch (e) { console.warn(`[Barrel Vision] Pitcher List skipped: ${e.message}`); }

  return { bat, pit, pct, hand, pl, teamOff, teamAbbr, teamOffMeta };
}

function countsOf(indexes) {
  const pl = indexes.pl || {};
  const plVals = Object.values(pl);
  const pct = indexes.pct || {};
  return {
    bat: BV.countIndex(indexes.bat),
    pit: BV.countIndex(indexes.pit),
    pctBat: BV.countIndex(pct.bat),
    pctPit: BV.countIndex(pct.pit),
    hand: Object.keys(indexes.hand || {}).length,
    plSp: plVals.filter(v => v && v.sp != null).length,
    plRp: plVals.filter(v => v && v.rp != null).length,
    plHit: plVals.filter(v => v && v.h != null).length,
    plSpSrc: (plVals.find(v => v && v.sp != null && v.spSrc) || {}).spSrc || BV.CONFIG.spSourceDefault,
  };
}

// ---------------------------------------------------------------------------
// Cache (chrome.storage.local, 12h TTL, year-scoped key)
// ---------------------------------------------------------------------------
async function loadFromCache(key) {
  try {
    const obj = await chrome.storage.local.get(key);
    const c = obj[key];
    if (c && (Date.now() - c.ts) < BV.CONFIG.cacheTtlHours * 3600e3) return c.indexes;
  } catch (_) {}
  return null;
}

async function writeCache(key, indexes) {
  // Plain data only (functions would be dropped by serialization anyway). Writing here is also what
  // notifies any open ESPN tab of a refresh: the content script listens for this local-area change.
  try { await chrome.storage.local.set({ [key]: { ts: Date.now(), indexes } }); } catch (_) {}
}

// Return the index, from cache if fresh (unless `force`), else build + cache it.
async function ensureIndex(force) {
  const key = BV.STORAGE.cacheKey(BV.CONFIG.year);
  if (!force) {
    const cached = await loadFromCache(key);
    if (cached) return { indexes: cached, counts: countsOf(cached) };
  }
  const indexes = await buildFresh();   // refreshes Savant + StatsAPI; PL stays on its own weekly cache
  await writeCache(key, indexes);
  return { indexes, counts: countsOf(indexes) };
}

// ---------------------------------------------------------------------------
// Quality Starts - computed per pitcher from the StatsAPI gameLog (>=6 IP & <=3 ER per start).
// QS is not a field on Savant or StatsAPI; this is the only authoritative source. Cached per id.
// inningsPitched is a string like "6.1" (6 and 1/3) - BV.ipToNum (core.js) parses the fraction as thirds.
// ---------------------------------------------------------------------------
async function getQS(id) {
  const key = BV.STORAGE.qsKey(BV.CONFIG.year);
  let map = {};
  try { const o = await chrome.storage.local.get(key); map = o[key] || {}; } catch (_) {}
  const hit = map[id];
  if (hit && (Date.now() - hit.ts) < BV.CONFIG.cacheTtlHours * 3600e3) return hit.qs;

  const json = JSON.parse(await fetchText(BV.CONFIG.mlbStatsGameLog(id, BV.CONFIG.year)));
  const splits = (json.stats && json.stats[0] && json.stats[0].splits) || [];
  let qs = 0;
  for (const x of splits) {
    const st = x.stat || {};
    if (+st.gamesStarted !== 1) continue;                          // QS requires the pitcher started
    if (BV.ipToNum(st.inningsPitched) >= 6 && +st.earnedRuns <= 3) qs++;
  }
  map[id] = { qs, ts: Date.now() };
  try { await chrome.storage.local.set({ [key]: map }); } catch (_) {}
  return qs;
}

// QS + GS per rostered starter for the matchup analyzer, both counted up to `asOf` so the QS rate uses the
// SAME window as the projection's stat line (a back-test mustn't mix a to-date QS count with an as-of GS
// denominator). Returns { id: { qs, gs } }. Fetched fresh from the gameLog (asOf varies); failures omitted.
async function getQSRates(ids, asOf) {
  const out = {};
  await Promise.all([...new Set(ids || [])].map(async (id) => {
    try {
      const json = JSON.parse(await fetchText(BV.CONFIG.mlbStatsGameLog(id, BV.CONFIG.year)));
      const splits = (json.stats && json.stats[0] && json.stats[0].splits) || [];
      let qs = 0, gs = 0;
      for (const x of splits) {
        if (asOf && x.date && x.date >= asOf) continue;            // exclude the projected week's own + later starts
        const st = x.stat || {};
        if (+st.gamesStarted !== 1) continue;
        gs++;
        if (BV.ipToNum(st.inningsPitched) >= 6 && +st.earnedRuns <= 3) qs++;
      }
      out[id] = { qs, gs };
    } catch (_) { /* leave out -> content falls back to no QS for this SP */ }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Per-batter platoon splits (vs LHP / vs RHP) for the matchup ratings. One StatsAPI call per batter,
// cached 24h (splits move slowly day to day). Batched: the content script sends the ids of the batters
// currently on screen; we return { id: { l:{ops,pa}, r:{ops,pa} } } for all, fetching only cache misses.
// ---------------------------------------------------------------------------
async function getSplits(ids) {
  const key = BV.STORAGE.splitsKey(BV.CONFIG.year);
  let map = {};
  try { const o = await chrome.storage.local.get(key); map = o[key] || {}; } catch (_) {}
  const now = Date.now(), ttl = BV.CONFIG.cacheTtlHours * 2 * 3600e3;   // 24h (2x the Savant 12h window)
  const out = {}, need = [];
  for (const id of (ids || [])) {
    const hit = map[id];
    if (hit && (now - hit.ts) < ttl) out[id] = hit.v;
    else if (id) need.push(id);
  }
  await Promise.all(need.map(async (id) => {
    try {
      const j = JSON.parse(await fetchText(BV.CONFIG.mlbStatsSplits(id, BV.CONFIG.year)));
      const splits = (j.stats && j.stats[0] && j.stats[0].splits) || [];
      const rec = { l: null, r: null };
      for (const s of splits) {
        const code = s.split && s.split.code;
        const ops = parseFloat(s.stat && s.stat.ops);
        const pa = +((s.stat && s.stat.plateAppearances) || 0);
        if (!Number.isFinite(ops)) continue;
        if (code === 'vl') rec.l = { ops, pa };
        else if (code === 'vr') rec.r = { ops, pa };
      }
      map[id] = { v: rec, ts: now };
      out[id] = rec;
    } catch (_) { out[id] = null; }                 // leave failures uncached so we retry next time
  }));
  try { await chrome.storage.local.set({ [key]: map }); } catch (_) {}
  return out;
}

// ---------------------------------------------------------------------------
// Matchup analyzer (boxscore page) - weekly category PROJECTION inputs. Five public StatsAPI calls:
// bulk SEASON + last-30 hitting and pitching component lines (keyed by MLBAM id; the content script joins
// them to the roster via the hand index's `id`), plus the week's schedule + probable pitchers. The
// projection MATH lives in core.js (BV.projHit / BV.projStarter / BV.aggOPS); this only fetches + shapes
// the raw inputs, bottom-up from the CURRENT roster so trades/adds/drops are reflected for free. Season +
// recent stats cache 12h (year-scoped); schedule/probables cache 3h (window-scoped - they move through
// the day). Best-effort throughout: a failed feed leaves that input empty, never the whole board.
// ---------------------------------------------------------------------------
function ymd(d) { return d.toISOString().slice(0, 10); }

// Sum two component vectors (multi-team season stints share the same numeric keys).
function sumComp(a, b) { const o = { ...a }; for (const k in b) o[k] = (+o[k] || 0) + (+b[k] || 0); return o; }

// Bulk StatsAPI stats call -> { mlbamId: componentVector }. Sums genuine multi-stint splits and skips the
// occasional exact-duplicate split (a byDateRange quirk) by (id, team) so a player is never double-counted.
async function bulkComponents(url, toComp) {
  const j = JSON.parse(await fetchText(url));
  const splits = (j.stats && j.stats[0] && j.stats[0].splits) || [];
  const out = {}, seen = {};
  for (const s of splits) {
    const id = s.player && s.player.id;
    if (id == null) continue;
    const tid = (s.team && s.team.id) != null ? s.team.id : 'x';
    const dk = `${id}:${tid}`;
    if (seen[dk]) continue;                       // exact-duplicate split -> skip (don't double-count)
    seen[dk] = 1;
    const c = toComp(s.stat);
    if (!c) continue;
    out[id] = out[id] ? sumComp(out[id], c) : c;
  }
  return out;
}

// The week's schedule -> games-per-team + probable-start counts. For the STABLE FULL-WEEK projection we
// count ALL of a team's games this week (teamGames.total) and how many games each pitcher is the announced
// probable for (probStarts[id], across the whole window - used to detect a two-start week; a rostered SP
// defaults to >=1 start regardless). `remaining` (Preview-only) is kept for a future in-week-progress
// adjustment. Doubleheaders are separate entries, so counting entries (not dates) counts both games.
async function buildSchedule(start, end, today) {
  const j = JSON.parse(await fetchText(BV.CONFIG.mlbSchedule(start, end)));
  const teamGames = {}, probStarts = {};
  for (const day of (j.dates || [])) {
    for (const g of (day.games || [])) {
      if (g.gameType && g.gameType !== 'R') continue;
      const remaining = BV.isRemainingGame((g.status && g.status.abstractGameState) || '');
      for (const side of ['home', 'away']) {
        const t = g.teams && g.teams[side];
        const id = t && t.team && t.team.id;
        if (id == null) continue;
        const tg = teamGames[id] || (teamGames[id] = { total: 0, remaining: 0 });
        tg.total++;
        if (remaining) tg.remaining++;
        const prob = t.probablePitcher;
        if (prob && prob.id != null) probStarts[prob.id] = (probStarts[prob.id] || 0) + 1;
      }
    }
  }
  return { teamGames, probStarts };
}

// `asOf` is the stats CUTOFF date (YYYY-MM-DD): today for the live/current week, or the day before a PAST
// week started for back-testing. A past week reconstructs the season line "as of" then via byDateRange
// (so the projection uses only what was knowable going in); the current week keeps the live season bulk +
// caches it. Past weeks are fetched fresh (not persisted) so a 13-week back-test sweep doesn't bloat storage.
const addDaysYmd = (s, n) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

async function getMatchupData(start, end, asOf) {
  const Y = BV.CONFIG.year;
  const todayStr = ymd(new Date());
  asOf = asOf || todayStr;
  const isCurrent = asOf >= todayStr;                          // current/future -> live season line + cache
  const recentStart = addDaysYmd(asOf, -30);
  const seasonHitUrl = isCurrent ? BV.CONFIG.mlbHitting(Y) : BV.CONFIG.mlbHittingRange(Y, `${Y}-03-01`, asOf);
  const seasonPitUrl = isCurrent ? BV.CONFIG.mlbPitching(Y) : BV.CONFIG.mlbPitchingRange(Y, `${Y}-03-01`, asOf);

  // 1) Season-as-of + recent-as-of component maps. Current week: 12h cache (year key). Past week: fresh.
  const sKey = BV.STORAGE.matchupStatsKey(Y);
  let stats = null;
  if (isCurrent) { try { const o = await chrome.storage.local.get(sKey); const c = o[sKey]; if (c && (Date.now() - c.ts) < BV.CONFIG.cacheTtlHours * 3600e3) stats = c.v; } catch (_) {} }
  if (!stats) {
    const safe = async (p) => { try { return await p; } catch (e) { console.warn(`[Barrel Vision] matchup feed skipped: ${e.message}`); return {}; } };
    const [batS, batR, pitS, pitR] = await Promise.all([
      safe(bulkComponents(seasonHitUrl, BV.hitComponents)),
      safe(bulkComponents(BV.CONFIG.mlbHittingRange(Y, recentStart, asOf), BV.hitComponents)),
      safe(bulkComponents(seasonPitUrl, BV.pitComponents)),
      safe(bulkComponents(BV.CONFIG.mlbPitchingRange(Y, recentStart, asOf), BV.pitComponents)),
    ]);
    const bat = {}, pit = {};
    for (const id in batS) (bat[id] = bat[id] || {}).s = batS[id];
    for (const id in batR) (bat[id] = bat[id] || {}).r = batR[id];
    for (const id in pitS) (pit[id] = pit[id] || {}).s = pitS[id];
    for (const id in pitR) (pit[id] = pit[id] || {}).r = pitR[id];
    stats = { bat, pit };
    if (isCurrent) { try { await chrome.storage.local.set({ [sKey]: { ts: Date.now(), v: stats } }); } catch (_) {} }
  }
  // 2) Schedule + probables for [start..end] (probables = the actual starters for a completed past week).
  const schedKey = BV.STORAGE.matchupSchedKey(Y);
  const win = `${start}|${end}`;
  let sched = null;
  try { const o = await chrome.storage.local.get(schedKey); const c = o[schedKey]; if (c && c.win === win && (Date.now() - c.ts) < 3 * 3600e3) sched = c.v; } catch (_) {}
  if (!sched) {
    try { sched = await buildSchedule(start, end, asOf); }
    catch (e) { console.warn(`[Barrel Vision] schedule skipped: ${e.message}`); sched = { teamGames: {}, probStarts: {} }; }
    try { await chrome.storage.local.set({ [schedKey]: { ts: Date.now(), win, v: sched } }); } catch (_) {}
  }
  return { bat: stats.bat, pit: stats.pit, teamGames: sched.teamGames, probStarts: sched.probStarts };
}

// ---------------------------------------------------------------------------
// Pitcher List weekly rankings (SP "The List" + reliever "Top 50 Closers").
// Published as weekly ARTICLES, but the ranking is a clean server-rendered
// <table class="list"> (verified live). A classic service worker has NO
// DOMParser, so we regex-parse the HTML string. We take ONLY rank+name+slug+
// team+tier - never the prose write-ups. Weekly (7-day) cache, mirroring getQS;
// a manual paste (popup) overrides the auto-fetch. See PROJECT doc §5/§2.
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#x27;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .trim();
}

// Parse the FIRST <table class="list"> into [{rank, name, slug, team, tier}]. In BOTH articles the
// first such table is the ranking we want (SP: The List; RP: Top 50 Closers, BEFORE the Holds/SV+HLD
// tables). Auxiliary DataTables on the page carry different classes, so they're skipped.
function parsePlList(html) {
  const tbl = (html || '').match(/<table class="list">([\s\S]*?)<\/table>/);
  if (!tbl) return [];
  const out = [];
  let lastTier = '';   // PL labels only each tier's LEADING row (span.tier); tiers are monotonic, so
  for (const seg of tbl[1].split('<tr')) {   // carry the last-seen tier forward to every player in it.
    const rank = seg.match(/class="rank">\s*(\d+)\s*</);
    if (!rank) continue;
    const nm = seg.match(/class="name">\s*<a[^>]*href="[^"]*\/player\/([^/"]+)\/"[^>]*>([^<]+)<\/a>/);
    if (!nm) continue;
    const team = seg.match(/class="team">\s*([^<]*?)\s*</);
    const tier = seg.match(/class="tier">\s*(T\d+)\s*</);
    if (tier) lastTier = tier[1];
    out.push({
      rank: +rank[1],
      slug: nm[1],
      name: decodeEntities(nm[2]),
      team: team ? decodeEntities(team[1]).toUpperCase() : '',
      tier: tier ? tier[1] : lastTier,
    });
  }
  return out;
}

// Parse a manually-pasted list (popup fallback): either pasted article HTML, or simple lines like
// "1 Mason Miller", "1. Mason Miller (SD)", "12) Tarik Skubal (DET) - analysis...". No slug from text.
function parsePlText(text) {
  if (/<td class="rank"|<table class="list"/.test(text || '')) return parsePlList(text);
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^#?(\d+)[.):]?\s+(.+)$/);
    if (!m) continue;
    let rest = m[2];
    const teamM = rest.match(/\(([A-Za-z]{2,3})\)/);
    const team = teamM ? teamM[1].toUpperCase() : '';
    rest = rest.replace(/\s+[-–—]\s+.*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim(); // drop trailing analysis + (TEAM)
    if (!rest) continue;
    out.push({ rank: +m[1], name: decodeEntities(rest), slug: '', team, tier: '' });
  }
  return out;
}

// Razzball "Top 100 Starting Pitchers": the ranking is a plain <table> (no class) of rank|name|team|notes
// rows. The author also prints a smaller "Pitching WAR" chart sharing the same first three columns, so we
// scan ALL tables and keep the LARGEST by row count (verified live 2026: ranking = 100 rows, WAR chart =
// 20). Names are plain text (no per-player link in the ranking table), so slug stays ''. Only
// rank+name+team are taken - never the NOTES write-ups. Returns [{rank,name,slug:'',team,tier:''}].
function tagText(s) { return decodeEntities((s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()); }
function parseRazzballList(html) {
  let best = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/g;
  let t;
  while ((t = tableRe.exec(html || '')) !== null) {
    const rows = [];
    for (const seg of t[1].split('<tr')) {
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let c;
      while ((c = cellRe.exec(seg)) !== null) cells.push(tagText(c[1]));
      if (cells.length < 3 || !/^\d+$/.test(cells[0]) || !cells[1]) continue;   // header / non-rank rows
      rows.push({ rank: +cells[0], name: cells[1], slug: '', team: cells[2].toUpperCase(), tier: '' });
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

// RotoBaller "SP Rankings for Week N": the ranking is the table with the MOST player links (rank | tier |
// <a class="rbPlayer" href="/mlb/player/{id}/{name}">Name</a> | …). A small "prospects to stash" table is
// the decoy, so we keep the table with the most rbPlayer rows. We take rank + name + the player href (the
// slug for the player link), never the $/PV/Trend columns; there is no team column on this table -> team
// ''. Returns [{rank,name,slug,team:'',tier:''}] (slug = the captured /mlb/player/… path).
function parseRotoList(html) {
  let best = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/g;
  let t;
  while ((t = tableRe.exec(html || '')) !== null) {
    const rows = [];
    for (const seg of t[1].split('<tr')) {
      const a = seg.match(/<a[^>]*class="[^"]*rbPlayer[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const rankM = seg.match(/<td[^>]*>\s*(\d+)\s*<\/td>/);   // first pure-integer cell = rank (tier is 2nd)
      if (!rankM) continue;
      const name = tagText(a[2]);
      if (!name) continue;
      rows.push({ rank: +rankM[1], name, slug: a[1], team: '', tier: '' });
    }
    if (rows.length > best.length) best = rows;
  }
  return best;
}

// SP-list parser dispatch (keyed by CONFIG.spSources[id].parser). Closers + hitters always use parsePlList.
const SP_PARSERS = { pl: parsePlList, razzball: parseRazzballList, roto: parseRotoList };

// Resolve the latest weekly article URL. RSS first (reverse-chronological: the first article-shaped
// <link> is the newest week); the category HTML index is the fallback if the feed shape changes.
async function latestArticleUrl(feedUrl, indexUrl, articleRe) {
  try {
    const xml = await fetchText(feedUrl);
    const m = xml.match(articleRe);
    if (m) return m[0];
  } catch (_) { /* fall through to the HTML index */ }
  const html = await fetchText(indexUrl);
  const m = html.match(articleRe);
  if (!m) throw new Error('no article link found in feed or index');
  return m[0];
}

// Fetch + parse one weekly list with the given site parser. Graceful skip: a short parse (markup
// changed, or the source is JS-gated and the table isn't in the raw HTML) returns [] so we render NO
// rank rather than wrong/partial ranks. `parser` defaults to the Pitcher List table parser.
async function fetchList(feedUrl, indexUrl, articleRe, minRows, label, parser) {
  const parse = parser || parsePlList;
  let url;
  try { url = await latestArticleUrl(feedUrl, indexUrl, articleRe); }
  catch (e) { console.warn(`[Barrel Vision] ${label} URL resolve failed: ${e.message}`); return { rows: [], url: '' }; }
  let html;
  try { html = await fetchText(url); }
  catch (e) { console.warn(`[Barrel Vision] ${label} article fetch failed: ${e.message}`); return { rows: [], url }; }
  const rows = parse(html);
  if (rows.length < minRows) {
    console.warn(`[Barrel Vision] ${label} parse yielded ${rows.length} rows (< ${minRows}) - skipping`);
    return { rows: [], url };
  }
  return { rows, url };   // url = the resolved weekly article (used as the badge link for sources with no player page)
}

// Merge SP + closer + hitter rows into a flat normName -> record map. The SP entry is tagged with its
// source (spSrc/spSlug/spTier) so the badge can label + link it; closers + hitters are always Pitcher
// List (rp/h + the generic slug/tier/team). When the SP source IS Pitcher List, the SP slug/tier also
// populate the generic slug/tier (byte-identical to the pre-multi-source behaviour for PL pitchers).
function buildPlMap(spRows, rpRows, hitRows, srcId, spListUrl) {
  const pl = {};
  const isPL = srcId === 'pitcherList';
  for (const r of spRows || []) {
    const k = BV.normName(r.name);
    if (!k || r.rank == null) continue;
    const cur = pl[k] || {};
    pl[k] = { ...cur, sp: r.rank, spSrc: srcId, spSlug: r.slug || '', spTier: isPL ? (r.tier || '') : '',
      spListUrl: spListUrl || '',   // fallback badge link (this week's list article) for player-page-less sources
      slug: cur.slug || (isPL ? (r.slug || '') : ''), tier: cur.tier || (isPL ? (r.tier || '') : ''),
      team: cur.team || r.team || '' };
  }
  const add = (rows, key) => {
    for (const r of rows || []) {
      const k = BV.normName(r.name);
      if (!k || r.rank == null) continue;
      const cur = pl[k] || {};
      pl[k] = { ...cur, [key]: r.rank, slug: cur.slug || r.slug || '', tier: cur.tier || r.tier || '', team: cur.team || r.team || '' };
    }
  };
  add(rpRows, 'rp');
  add(hitRows, 'h');     // hitter rank from the "Top 150 Hitters" list (shown on batter rows)
  return pl;
}

// The selected starting-pitcher rank source id (sync; validated, defaults to Pitcher List).
async function getSelectedSpSource() {
  try {
    const id = (await chrome.storage.sync.get(BV.STORAGE.spSource))[BV.STORAGE.spSource];
    if (BV.validSpSource(id)) return id;
  } catch (_) {}
  return BV.CONFIG.spSourceDefault;
}

// ---------------------------------------------------------------------------
// Rank source health - a small per-list summary (rows parsed, source, mode, when) the popup shows as a
// "ranks last updated" line, so a graceful skip (a site changed its page -> 0 rows rendered) is VISIBLE
// instead of silent. Plain data only; persisted to its own local key on every getPL resolution.
//   n      : rows that will render (0 = a skip/empty; for fetch this is post-minRows-gate)
//   ok     : n > 0
//   source : the human label of the list's source (SP = the selected source; closers/hitters = PL)
//   url    : the resolved weekly article (when known)
// ---------------------------------------------------------------------------
function plListHealth(n, source, url) { return { n, ok: n > 0, source, url: url || '' }; }

function plHealthFromFetch(srcId, sp, rp, hit, fetchedAt) {
  const lbl = BV.spSourceCfg(srcId).label;
  return {
    fetchedAt, mode: 'fetched', spSource: srcId,
    lists: {
      sp: plListHealth(sp.rows.length, lbl, sp.url),
      rp: plListHealth(rp.rows.length, 'Pitcher List', rp.url),
      h:  plListHealth(hit.rows.length, 'Pitcher List', hit.url),
    },
  };
}

function plHealthFromOverride(srcId, sp, rp, hit, fetchedAt, spListUrl) {
  return {
    fetchedAt, mode: 'override', spSource: srcId,
    lists: {
      sp: plListHealth(sp.length, BV.spSourceCfg(srcId).label, spListUrl),
      rp: plListHealth(rp.length, 'Pitcher List', ''),
      h:  plListHealth(hit.length, 'Pitcher List', ''),
    },
  };
}

// Serving from the weekly cache: reuse the health stored when it was fetched (just relabel the mode);
// fall back to deriving counts from the cached pl map for an older cache written before health existed.
function plHealthFromCache(c) {
  if (c.health) return { ...c.health, mode: 'cached' };
  const vals = Object.values(c.pl || {});
  const cnt = f => vals.filter(f).length;
  const lbl = BV.spSourceCfg(c.src).label;
  return {
    fetchedAt: c.ts, mode: 'cached', spSource: c.src,
    lists: {
      sp: plListHealth(cnt(v => v && v.sp != null), lbl, ''),
      rp: plListHealth(cnt(v => v && v.rp != null), 'Pitcher List', ''),
      h:  plListHealth(cnt(v => v && v.h != null), 'Pitcher List', ''),
    },
  };
}

async function writePlHealth(year, health) {
  try { await chrome.storage.local.set({ [BV.STORAGE.plHealth(year)]: health }); } catch (_) {}
}

async function getPL(force) {
  const Y = BV.CONFIG.year;
  const overKey = BV.STORAGE.plOverride(Y);
  const cacheK = BV.STORAGE.plKey(Y);
  const ttl = BV.CONFIG.plCacheTtlDays * 86400e3;
  const srcId = await getSelectedSpSource();
  const src = BV.spSourceCfg(srcId);

  // `force` (the manual "Refresh" button / Clear) pulls live data, bypassing BOTH the override and the
  // weekly cache. A normal/advanced rebuild (force=false) prefers a fresh override, then a fresh weekly
  // cache built for the SELECTED source, then a live fetch.
  if (!force) {
    // 1) Manual override (Path B) - honored for ONE WEEK from when it was saved. The starters paste
    //    applies only when it was saved for the currently-selected source; closers + hitters are always
    //    Pitcher List, so an rp/hit paste always applies. Treated as "this week only" (auto-fetch resumes).
    try {
      const o = (await chrome.storage.local.get(overKey))[overKey];
      if (o && (Date.now() - (o.ts || 0)) < ttl) {
        const sp  = (o.sp && (o.spSrc || 'pitcherList') === srcId) ? parsePlText(o.sp) : [];
        const rp  = o.rp  ? parsePlText(o.rp)  : [];
        const hit = o.hit ? parsePlText(o.hit) : [];
        // A pasted list has no per-player slug; for a player-page-less source (Razzball) link the badge
        // to that source's category page (latest list at the top) so it's still clickable.
        if (sp.length || rp.length || hit.length) {
          const spListUrl = src.playerUrl ? '' : src.spIndex;
          await writePlHealth(Y, plHealthFromOverride(srcId, sp, rp, hit, o.ts || Date.now(), spListUrl));
          return buildPlMap(sp, rp, hit, srcId, spListUrl);
        }
      }
    } catch (_) {}

    // 2) Weekly cache (7-day TTL) - only when it was built for the selected source (a source switch is a
    //    cache miss, so it refetches rather than serving the other source's ranks).
    try {
      const c = (await chrome.storage.local.get(cacheK))[cacheK];
      if (c && c.src === srcId && (Date.now() - c.ts) < ttl) {
        await writePlHealth(Y, plHealthFromCache(c));
        return c.pl || {};
      }
    } catch (_) {}
  }

  // 3) Fetch + parse this week's articles. Starters from the selected source; closers + hitters from PL.
  const P = BV.CONFIG.pitcherList;
  const spRe = new RegExp(src.articleRe, src.articleReFlags || 'i');
  const spRes  = await fetchList(src.spFeed, src.spIndex, spRe, src.minRows, `SP (${src.label})`, SP_PARSERS[src.parser] || parsePlList);
  const rpRes  = await fetchList(P.rpFeed,  P.rpIndex,  /https:\/\/pitcherlist\.com\/fantasy-reliever-rankings[a-z0-9-]*\//i, 20, 'PL closers', parsePlList);
  const hitRes = await fetchList(P.hitFeed, P.hitIndex, /https:\/\/pitcherlist\.com\/top-150-hitters-for-fantasy-baseball[a-z0-9-]*\//i, 50, 'PL batters', parsePlList);
  // When the SP source has no per-player page (e.g. Razzball), link its badges to THIS week's resolved
  // list article instead of a player page; sources with a playerUrl (PL, RotoBaller) link per-player.
  const spListUrl = src.playerUrl ? '' : (spRes.url || '');
  const pl = buildPlMap(spRes.rows, rpRes.rows, hitRes.rows, srcId, spListUrl);
  const now = Date.now();
  const health = plHealthFromFetch(srcId, spRes, rpRes, hitRes, now);
  // Store health IN the weekly cache too, so a later cache-hit can report the same per-list counts/urls.
  try { await chrome.storage.local.set({ [cacheK]: { ts: now, src: srcId, pl, health } }); } catch (_) {}
  await writePlHealth(Y, health);
  return pl;
}

// Refresh ONLY the Pitcher List ranks and merge them into the current index, leaving the Savant /
// StatsAPI data untouched (so the manual "Refresh Pitcher List" button doesn't refetch everything).
// Reuses the cached bat/pit/hand and preserves the index ts so the 12h Savant timer isn't reset.
async function refreshPL(force) {
  const key = BV.STORAGE.cacheKey(BV.CONFIG.year);
  let cached = null;
  try { cached = (await chrome.storage.local.get(key))[key]; } catch (_) {}
  let indexes, ts;
  if (cached && cached.indexes) {
    indexes = { ...cached.indexes, pl: await getPL(force) };
    ts = cached.ts;                       // keep Savant's 12h freshness window intact; only PL changed
  } else {
    indexes = await buildFresh(force);    // nothing cached yet -> full build (forces PL when asked)
    ts = Date.now();
  }
  try { await chrome.storage.local.set({ [key]: { ts, indexes } }); } catch (_) {}
  return { counts: countsOf(indexes) };
}

// ---------------------------------------------------------------------------
// Messaging - listener registered SYNCHRONOUSLY at top level so a wake-up
// message is never missed. Non-async listener that returns `true` to hold the
// channel open for the async sendResponse (the universally-compatible pattern;
// promise-returning listeners are Chrome 148+ only).
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'GET_INDEX') {
    ensureIndex(false)
      .then(({ indexes, counts }) => sendResponse({ ok: true, indexes, counts }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'REFRESH') {
    ensureIndex(true)
      .then(({ counts }) => sendResponse({ ok: true, counts }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // PL-only refresh. force:true (manual "Refresh Pitcher List" / Clear) pulls live, bypassing the
  // override; force:false (Save) honors the just-saved override. Either way, Savant data is untouched.
  if (msg.type === 'REFRESH_PL') {
    refreshPL(msg.force !== false)
      .then(({ counts }) => sendResponse({ ok: true, counts }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_QS') {
    getQS(msg.id)
      .then(qs => sendResponse({ ok: true, qs }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_SPLITS') {
    getSplits(msg.ids)
      .then(splits => sendResponse({ ok: true, splits }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_MATCHUP_DATA') {
    getMatchupData(msg.start, msg.end, msg.asOf)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_QS_BATCH') {
    getQSRates(msg.ids, msg.asOf)
      .then(qs => sendResponse({ ok: true, qs }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Toolbar icon: greyed everywhere, "lit" only on the sites the overlay runs on.
// Uses declarativeContent so CHROME evaluates the URL rule internally - the
// extension never receives tab URLs/history (no "tabs" permission; more private
// than reading tab.url ourselves).
//
// SINGLE SOURCE OF TRUTH for "which sites": the manifest's content_scripts.matches.
// To support more sites later, add the pattern there (where you'd add it to inject
// anyway) - this rule is derived from it, so nothing else needs editing here.
// ---------------------------------------------------------------------------
function matchPatternToRegex(p) {
  if (p === '<all_urls>') return '^https?://.*$';
  const m = p.match(/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/);
  if (!m) return '^$';                                       // unrecognized -> matches nothing
  const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');  // escape regex specials (NOT '*')
  const scheme = m[1] === '*' ? 'https?' : m[1];
  const host = m[2];
  const h = host === '*' ? '[^/]+'
          : host.startsWith('*.') ? '([^/]+\\.)?' + esc(host.slice(2))
          : esc(host);
  const path = esc(m[3]).replace(/\*/g, '.*');               // '*' glob -> '.*'
  return '^' + scheme + '://' + h + path + '$';
}

function applyActionRules() {
  // Without the permission, leave the icon usable everywhere (so settings stay reachable).
  if (!chrome.declarativeContent) { chrome.action.enable(); return; }
  chrome.action.disable();                                   // greyed by default; rule re-enables on match
  const matches = (chrome.runtime.getManifest().content_scripts || []).flatMap(cs => cs.matches || []);
  const conditions = matches.map(p =>
    new chrome.declarativeContent.PageStateMatcher({ pageUrl: { urlMatches: matchPatternToRegex(p) } })
  );
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      { conditions, actions: [new chrome.declarativeContent.ShowAction()] },
    ]);
  });
}

// ---------------------------------------------------------------------------
// Master on/off - a right-click item on the toolbar icon, mirroring the popup's
// switch (both write chrome.storage.sync 'enabled'; the content script reacts live).
// A checkbox-type item shows the current state; we keep its checkmark in sync when
// the switch is flipped from the popup. A greyed "OFF" badge gives at-a-glance state.
// ---------------------------------------------------------------------------
const MENU_ID = 'bv-toggle';

async function isEnabled() {
  try { const o = await chrome.storage.sync.get(BV.STORAGE.enabled); return o[BV.STORAGE.enabled] !== false; }
  catch (_) { return true; }
}

function setBadge(enabled) {
  try {
    chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
    if (!enabled) chrome.action.setBadgeBackgroundColor({ color: '#888' });
  } catch (_) {}
}

async function setupContextMenu() {
  const enabled = await isEnabled();
  setBadge(enabled);
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {                         // removeAll first so re-install can't dup the id
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Enable Barrel Vision',
      type: 'checkbox',
      checked: enabled,
      contexts: ['action'],                                    // right-click on the toolbar icon
    });
  });
}

chrome.contextMenus?.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  chrome.storage.sync.set({ [BV.STORAGE.enabled]: info.checked }); // checkbox items report the NEW state
});

// Keep the menu checkmark + badge in sync if the switch is flipped elsewhere (the popup).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[BV.STORAGE.enabled]) return;
  const enabled = changes[BV.STORAGE.enabled].newValue !== false;
  setBadge(enabled);
  try { chrome.contextMenus?.update(MENU_ID, { checked: enabled }); } catch (_) {}
});

function onLifecycle() { applyActionRules(); setupContextMenu(); }
chrome.runtime.onInstalled.addListener(onLifecycle);
chrome.runtime.onStartup.addListener(onLifecycle);
