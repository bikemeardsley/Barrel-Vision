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
  // Batted-ball/expected feeds use "last_name, first_name"; bat-tracking uses "name" in the same
  // "Last, First" text. Treat any comma-bearing value as Last, First and flip it.
  const lastFirst = r['last_name, first_name'] || (r.name && r.name.includes(',') ? r.name : '');
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

  // Handedness from MLB StatsAPI, keyed by normalized name -> { bats, throws, slug } (L/R/S codes).
  // Optional: if it fails, handedness simply doesn't render and everything else is unaffected.
  // NOTE: a flat name->object map (NOT arrays like the Savant feeds) - the content script reads it directly.
  let hand = {};
  try {
    const json = JSON.parse(await fetchText(BV.CONFIG.mlbStats(Y)));
    for (const p of (json.people || [])) {
      const k = BV.normName(p.fullName || p.firstLastName || `${p.firstName || ''} ${p.lastName || ''}`);
      if (!k) continue;
      hand[k] = { bats: p.batSide?.code || '', throws: p.pitchHand?.code || '', slug: p.nameSlug || '', id: p.id || '' };
    }
  } catch (e) { console.warn(`[Barrel Vision] StatsAPI handedness skipped: ${e.message}`); }

  // Pitcher List weekly ranks, keyed by normalized name -> { sp?, rp?, slug, tier, team } (a flat
  // name->object map like `hand`, NOT arrays - the content script reads it directly and renders it
  // inline after handedness). Best-effort: any failure leaves `pl` partial/empty; nothing else breaks.
  // PL has its own weekly cache/override, so a normal/advanced rebuild does NOT force it (forcePl is
  // only true via the dedicated "Refresh Pitcher List" path); it still auto-fetches when its cache expires.
  let pl = {};
  try { pl = await getPL(forcePl); }
  catch (e) { console.warn(`[Barrel Vision] Pitcher List skipped: ${e.message}`); }

  return { bat, pit, hand, pl };
}

function countsOf(indexes) {
  const pl = indexes.pl || {};
  const plVals = Object.values(pl);
  return {
    bat: BV.countIndex(indexes.bat),
    pit: BV.countIndex(indexes.pit),
    hand: Object.keys(indexes.hand || {}).length,
    plSp: plVals.filter(v => v && v.sp != null).length,
    plRp: plVals.filter(v => v && v.rp != null).length,
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
// inningsPitched is a string like "6.1" (6 and 1/3) - parse the fractional part as thirds.
// ---------------------------------------------------------------------------
function ipToNum(s) { const [w, f] = String(s).split('.'); return (+w || 0) + ((+f || 0) / 3); }

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
    if (ipToNum(st.inningsPitched) >= 6 && +st.earnedRuns <= 3) qs++;
  }
  map[id] = { qs, ts: Date.now() };
  try { await chrome.storage.local.set({ [key]: map }); } catch (_) {}
  return qs;
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

// Fetch + parse one weekly list. Graceful skip: a short parse (markup changed) returns [] so we
// render NO rank rather than wrong/partial ranks.
async function fetchPlList(feedUrl, indexUrl, articleRe, minRows, label) {
  let url;
  try { url = await latestArticleUrl(feedUrl, indexUrl, articleRe); }
  catch (e) { console.warn(`[Barrel Vision] PL ${label} URL resolve failed: ${e.message}`); return []; }
  let html;
  try { html = await fetchText(url); }
  catch (e) { console.warn(`[Barrel Vision] PL ${label} article fetch failed: ${e.message}`); return []; }
  const rows = parsePlList(html);
  if (rows.length < minRows) {
    console.warn(`[Barrel Vision] PL ${label} parse yielded ${rows.length} rows (< ${minRows}) - skipping`);
    return [];
  }
  return rows;
}

// Merge SP + closer rows into a flat normName -> { sp?, rp?, slug, tier, team } map.
function buildPlMap(spRows, rpRows) {
  const pl = {};
  const add = (rows, key) => {
    for (const r of rows) {
      const k = BV.normName(r.name);
      if (!k || r.rank == null) continue;
      const cur = pl[k] || {};
      pl[k] = { ...cur, [key]: r.rank, slug: cur.slug || r.slug || '', tier: cur.tier || r.tier || '', team: cur.team || r.team || '' };
    }
  };
  add(spRows, 'sp');
  add(rpRows, 'rp');
  return pl;
}

async function getPL(force) {
  const Y = BV.CONFIG.year;
  const overKey = BV.STORAGE.plOverride(Y);
  const cacheK = BV.STORAGE.plKey(Y);
  const ttl = BV.CONFIG.plCacheTtlDays * 86400e3;

  // `force` (the manual "Refresh Pitcher List" button / Clear) pulls live data, bypassing BOTH the
  // override and the weekly cache. A normal/advanced rebuild (force=false) prefers a fresh override,
  // then a fresh weekly cache, then a live fetch.
  if (!force) {
    // 1) Manual override (Path B) - honored for ONE WEEK from when it was saved, then auto-fetch
    //    resumes on its own (no Clear needed): the paste is treated as "this week only".
    try {
      const o = (await chrome.storage.local.get(overKey))[overKey];
      if (o && (o.sp || o.rp) && (Date.now() - (o.ts || 0)) < ttl) {
        const sp = o.sp ? parsePlText(o.sp) : [];
        const rp = o.rp ? parsePlText(o.rp) : [];
        if (sp.length || rp.length) return buildPlMap(sp, rp);
      }
    } catch (_) {}

    // 2) Weekly cache (7-day TTL).
    try {
      const c = (await chrome.storage.local.get(cacheK))[cacheK];
      if (c && (Date.now() - c.ts) < ttl) return c.pl || {};
    } catch (_) {}
  }

  // 3) Fetch + parse this week's articles.
  const P = BV.CONFIG.pitcherList;
  const spRows = await fetchPlList(P.spFeed, P.spIndex, /https:\/\/pitcherlist\.com\/top-100-starting-pitchers[a-z0-9-]*\//i, 50, 'SP');
  const rpRows = await fetchPlList(P.rpFeed, P.rpIndex, /https:\/\/pitcherlist\.com\/fantasy-reliever-rankings[a-z0-9-]*\//i, 20, 'closers');
  const pl = buildPlMap(spRows, rpRows);
  try { await chrome.storage.local.set({ [cacheK]: { ts: Date.now(), pl } }); } catch (_) {}
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

chrome.runtime.onInstalled.addListener(applyActionRules);
chrome.runtime.onStartup.addListener(applyActionRules);
