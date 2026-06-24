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
async function buildFresh() {
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
      hand[k] = { bats: p.batSide?.code || '', throws: p.pitchHand?.code || '', slug: p.nameSlug || '' };
    }
  } catch (e) { console.warn(`[Barrel Vision] StatsAPI handedness skipped: ${e.message}`); }

  return { bat, pit, hand };
}

function countsOf(indexes) {
  return {
    bat: BV.countIndex(indexes.bat),
    pit: BV.countIndex(indexes.pit),
    hand: Object.keys(indexes.hand || {}).length,
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
  const indexes = await buildFresh();
  await writeCache(key, indexes);
  return { indexes, counts: countsOf(indexes) };
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
});
