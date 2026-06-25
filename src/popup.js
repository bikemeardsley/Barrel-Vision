/*
 * Barrel Vision - popup (toolbar action)
 * ---------------------------------------------------------------------------
 * The preferences UI, moved out of the userscript's floating gear into the
 * extension toolbar popup. Edits write to chrome.storage.sync; the content
 * script listens via chrome.storage.onChanged and re-shades live - so there is
 * no Save button and no page reload (the userscript reloaded on save).
 *
 * Loaded after shared/core.js, so BV (CONFIG, formatters, defaultPrefs) is
 * available. This is our own page, so native checkboxes/inputs work normally -
 * none of the appearance:none overrides the userscript needed to fight ESPN's CSS.
 */
(function () {
  'use strict';

  let PREFS = BV.defaultPrefs();
  let writeTimer = null;

  // key -> {label, group}. ops/era/whip are ESPN stats we shade in place, not Savant columns.
  // "Batters" matches ESPN's own section name.
  function colMeta() {
    const meta = {};
    for (const c of BV.CONFIG.columns.bat) meta[c.key] = { label: c.label, group: 'Batters' };
    meta.ops = { label: 'OPS', group: 'Batters' };
    for (const c of BV.CONFIG.columns.pit) if (!meta[c.key]) meta[c.key] = { label: c.label, group: 'Pitchers' };
    meta.era = { label: 'ERA', group: 'Pitchers' };
    meta.whip = { label: 'WHIP', group: 'Pitchers' };
    return meta;
  }

  // Show/parse each threshold in the units its column displays. squp's stored threshold is already in
  // percent units (not the 0-1 fraction the data uses), so it formats with pct, not pctFrac.
  const FMT = {};
  for (const c of BV.CONFIG.columns.bat) FMT[c.key] = c.fmt;
  for (const c of BV.CONFIG.columns.pit) if (!FMT[c.key]) FMT[c.key] = c.fmt;
  FMT.squp = BV.pct;
  FMT.ops = BV.dec3;
  FMT.era = BV.dec2;
  FMT.whip = BV.dec2;
  const fmtTh = (key, v) => (v == null ? '' : (FMT[key] || BV.dec3)(v));

  // Lenient parse back to a number: tolerate %, +, the unicode minus, and a bare leading dot.
  function parseTh(s) {
    const c = String(s).replace(/−/g, '-').replace(/[^0-9.+\-]/g, '');
    const n = parseFloat(c);
    return Number.isFinite(n) ? n : null;
  }

  function mergePrefs(saved) {
    const base = BV.defaultPrefs();
    if (saved && typeof saved === 'object') {
      for (const k in base) if (saved[k]) base[k] = { ...base[k], ...saved[k] };
    }
    return base;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const meta = colMeta();

  // ESPN's own columns - always shown (we don't add/remove ESPN's columns), so "Show" is read-only on.
  const ESPN_KEYS = new Set(['ops', 'era', 'whip']);

  // One-line explanation per stat, shown as a tooltip when you hover the stat name in its preferences row.
  // Popup-only UI copy, so it lives here - core.js holds only what 2+ contexts share. Keyed by pref key.
  // Thresholds named here match the defaults in CONFIG.preferences; sign quirks match the derive comments.
  const DESCRIPTIONS = {
    // Batters (higher = better)
    barrel: 'Barrel rate — batted balls hit at the ideal exit-velocity/launch-angle combo. The core power signal: 8% is a useful floor, 12%+ a target.',
    hh:     'Hard-hit rate — share of batted balls at 95+ mph exit velocity. A confirming power metric: 40%+ is good, 45%+ elite.',
    xwoba:  'Expected wOBA — what the hitter’s contact quality (plus walks and strikeouts) should produce, stripped of batted-ball luck.',
    gap:    'xwOBA minus wOBA. Positive = results lagging contact quality (a buy-low screen, not a verdict). Derived here; Savant’s published column is the opposite sign.',
    avgev:  'Average exit velocity (mph) on batted balls. (EV90, the steadier measure, isn’t on Savant’s free CSV.)',
    bat:    'Average bat speed (mph), from Statcast bat tracking. A barrel/EV jump backed by rising bat speed is a real skill change. Blank for low swing samples.',
    squp:   'Squared-up rate — how often a swing reaches near the maximum exit velocity it could (contact efficiency, independent of launch angle). Part of the “is the spike real” check.',
    ops:    'On-base plus slugging — ESPN’s own column, shaded here (not a Savant stat). Higher is better.',
    // Pitchers (xERA & opponent-contact lower = better; ERAgap, K%, K-BB% higher = better)
    xera:   'Expected ERA from the quality of contact allowed — a steadier run-prevention estimate than ERA itself. Lower is better.',
    eragap: 'ERA minus xERA. Positive = ERA worse than the skill estimate (unlucky → improvement likely = buy). Derived.',
    kpct:   'Strikeout rate — strikeouts per batter faced. The K-category driver; 25%+ is the rotation-worthy target. From the MLB StatsAPI season line.',
    bbpct:  'Walk rate — walks per batter faced. The most stable WHIP predictor; sub-7% is the target. Lower is better. From the MLB StatsAPI season line.',
    kbb:    'K% minus BB% — the single most stable command signal. ~15%+ good, 20%+ elite. Derived.',
    oxwoba: 'Opponent xwOBA — expected wOBA a pitcher allows given the contact quality (plus walks and strikeouts) against him. Lower is better (contact suppression).',
    obrl:   'Opponent barrel rate — barrels allowed per batted ball. Lower is better.',
    ohh:    'Opponent hard-hit rate — 95+ mph contact allowed. Lower is better.',
    era:    'Earned run average — ESPN’s own column, shaded here. Lower is better.',
    whip:   'Walks + hits per inning pitched — ESPN’s own column, shaded here. Lower is better.',
    // Handedness display rows
    handBat: 'Shows the batter’s side (Righty / Lefty / Switch) next to their position, from the MLB StatsAPI.',
    handPit: 'Shows the pitcher’s throwing hand next to their position, from the MLB StatsAPI.',
  };

  // Escape a description for safe use in a title="" attribute (the rows are built via innerHTML).
  const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Label cell; when the stat has an explanation it goes in the cell's title= (hover the name to see it).
  function labelCell(key, label) {
    const d = DESCRIPTIONS[key];
    return d
      ? `<td class="bv-m-lab" title="${escAttr(d)}">${label}</td>`
      : `<td class="bv-m-lab">${label}</td>`;
  }

  function metricRow(key) {
    const p = PREFS[key] || {};
    const dirLabel = p.dir === 'low' ? 'lower = better' : 'higher = better';
    const isEspn = ESPN_KEYS.has(key);
    const shown = isEspn ? true : (p.show !== false);
    return `<tr data-key="${key}">
        ${labelCell(key, meta[key].label)}
        <td class="bv-m-onc"><label class="bv-switch"><input type="checkbox" class="bv-m-show" ${shown ? 'checked' : ''} ${isEspn ? 'disabled' : ''}><span class="bv-slider"></span></label></td>
        <td><input type="text" class="bv-m-th" value="${fmtTh(key, p.threshold)}" ${p.enabled ? '' : 'readonly'}></td>
        <td class="bv-m-onc"><label class="bv-switch"><input type="checkbox" class="bv-m-en" ${p.enabled ? 'checked' : ''}><span class="bv-slider"></span></label></td>
        <td class="bv-m-dir">${dirLabel}</td>
      </tr>`;
  }
  // A "Show"-only row (no threshold/highlight/direction) - used for the handedness display toggles.
  function showOnlyRow(key, label) {
    const shown = (PREFS[key] || {}).show !== false;
    return `<tr data-key="${key}">
        ${labelCell(key, label)}
        <td class="bv-m-onc"><label class="bv-switch"><input type="checkbox" class="bv-m-show" ${shown ? 'checked' : ''}><span class="bv-slider"></span></label></td>
        <td></td><td></td><td class="bv-m-dir"></td>
      </tr>`;
  }

  // Each section leads with a Handedness "Show" toggle, then its metric rows.
  const section = (title, keys, handKey) =>
    `<tr class="bv-sec"><td colspan="5">${title}</td></tr>` +
    showOnlyRow(handKey, 'Handedness') +
    keys.map(metricRow).join('');

  function render() {
    const batterKeys = Object.keys(meta).filter(k => meta[k].group === 'Batters');
    const pitcherKeys = Object.keys(meta).filter(k => meta[k].group === 'Pitchers');
    document.getElementById('bv-tbody').innerHTML =
      section('Batters', batterKeys, 'handBat') + section('Pitchers', pitcherKeys, 'handPit');
  }

  // ---------------------------------------------------------------------------
  // Persistence (debounced so we don't trip storage.sync write-rate limits)
  // ---------------------------------------------------------------------------
  function scheduleWrite() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => { chrome.storage.sync.set({ [BV.STORAGE.prefs]: PREFS }); }, 250);
  }

  function setStatus(msg) { document.getElementById('bv-status').textContent = msg || ''; }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, resp => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message)); else resolve(resp);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Wire up (all handlers via addEventListener - CSP forbids inline handlers)
  // ---------------------------------------------------------------------------
  document.getElementById('bv-table').addEventListener('change', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const key = tr.getAttribute('data-key');
    if (e.target.classList.contains('bv-m-show')) {    // column visibility (ESPN cols are disabled)
      PREFS[key] = { ...PREFS[key], show: e.target.checked };
      scheduleWrite();
    } else if (e.target.classList.contains('bv-m-en')) { // highlight on/off
      const en = e.target.checked;
      const th = tr.querySelector('.bv-m-th');
      if (th) th.readOnly = !en;                       // grey/un-grey without touching the value
      PREFS[key] = { ...PREFS[key], enabled: en };
      scheduleWrite();
    } else if (e.target.classList.contains('bv-m-th')) {
      PREFS[key] = { ...PREFS[key], threshold: parseTh(e.target.value) };
      scheduleWrite();
    }
  });

  // Master on/off. Writes chrome.storage.sync 'enabled'; the content script (live) and the toolbar
  // right-click menu both listen for this key, so flipping it here updates everywhere at once.
  function setMasterLabel(on) { document.getElementById('bv-master-lab').textContent = on ? 'On' : 'Off'; }
  document.getElementById('bv-enabled').addEventListener('change', e => {
    setMasterLabel(e.target.checked);
    chrome.storage.sync.set({ [BV.STORAGE.enabled]: e.target.checked });
  });

  document.getElementById('bv-debug').addEventListener('change', e => {
    chrome.storage.sync.set({ [BV.STORAGE.debug]: e.target.checked });
  });

  document.getElementById('bv-reset').addEventListener('click', () => {
    PREFS = BV.defaultPrefs();
    chrome.storage.sync.set({ [BV.STORAGE.prefs]: PREFS });
    render();
    setStatus('Reset to defaults.');
  });

  document.getElementById('bv-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('bv-refresh');
    btn.disabled = true;
    setStatus('Refreshing data…');
    try {
      const resp = await sendMessage({ type: 'REFRESH' });
      if (resp && resp.ok) {
        const c = resp.counts;
        setStatus(`Updated: ${c.bat} hitters · ${c.pit} pitchers · ${c.hand} handedness.`);
      } else {
        setStatus('Refresh failed: ' + ((resp && resp.error) || 'unknown error'));
      }
    } catch (e) {
      setStatus('Refresh failed: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Pitcher List ranks: a PL-only refresh (REFRESH_PL) that leaves the Savant /
  // StatsAPI data untouched. "Fetch latest ranks" and "Clear" pull live
  // (force:true); "Save override" stores the pasted lists and applies them for
  // the current week (force:false → the SW honors the just-saved override). The
  // SW rewrites the index cache so open ESPN tabs adopt the change live.
  // ---------------------------------------------------------------------------
  const plOverrideKey = () => BV.STORAGE.plOverride(BV.CONFIG.year);
  const plHealthKey = () => BV.STORAGE.plHealth(BV.CONFIG.year);

  // Compact "x ago" for the health line. Coarse on purpose (ranks update weekly): minutes/hours/days.
  function relTime(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  // Render the source-health line from a stored health blob (rows parsed per list + when last updated).
  // A list that failed to parse (ok=false → a graceful skip) shows ⚠ and tints the whole line amber, so
  // a silently-skipped week is visible. The SW (getPL) writes the blob on every fetch/override/cache hit.
  function renderPlHealth(health) {
    const el = document.getElementById('bv-pl-health');
    if (!el) return;
    if (!health || !health.lists) { el.textContent = ''; el.className = 'bv-pl-health'; return; }
    const abbr = BV.spSourceCfg(health.spSource).abbr;
    const L = health.lists;
    const seg = (lab, h, suffix) => !h ? '' : `<b>${lab}</b>${suffix || ''} ${h.ok ? h.n : '⚠'}`;
    const parts = [seg('Starters', L.sp, ` (${abbr})`), seg('Closers', L.rp), seg('Batters', L.h)].filter(Boolean);
    const mode = health.mode === 'override' ? 'manual override' : health.mode === 'cached' ? 'cached' : 'fetched';
    const warn = ['sp', 'rp', 'h'].some(k => L[k] && !L[k].ok);
    el.className = 'bv-pl-health' + (warn ? ' bv-pl-health-warn' : '');
    el.innerHTML = parts.join(' · ') +
      ` <span class="bv-pl-health-when">— ${mode}${health.fetchedAt ? ' ' + relTime(health.fetchedAt) : ''}</span>`;
  }

  async function loadPlHealth() {
    try { renderPlHealth((await chrome.storage.local.get(plHealthKey()))[plHealthKey()]); }
    catch (_) { renderPlHealth(null); }
  }

  // PL display toggles (master + per-list). The master shows/hides the section body and the inline
  // badges; per-list toggles gate each list. Content script reacts live via chrome.storage.onChanged.
  let PL_PREFS = BV.defaultPlPrefs();
  function writePlPrefs() { chrome.storage.sync.set({ [BV.STORAGE.plPrefs]: PL_PREFS }); }
  function applyPlBody() {
    const on = PL_PREFS.on !== false;
    document.getElementById('bv-pl-body').classList.toggle('bv-hidden', !on);
    document.getElementById('bv-pl-on-lab').textContent = on ? 'On' : 'Off';
  }
  document.getElementById('bv-pl-on').addEventListener('change', e => {
    PL_PREFS = { ...PL_PREFS, on: e.target.checked };
    applyPlBody();
    writePlPrefs();
  });
  for (const [id, key] of [['bv-pl-on-sp', 'sp'], ['bv-pl-on-rp', 'rp'], ['bv-pl-on-hit', 'h']]) {
    document.getElementById(id).addEventListener('change', e => {
      PL_PREFS = { ...PL_PREFS, [key]: e.target.checked };
      writePlPrefs();
    });
  }

  // Starters rank source (Pitcher List / Razzball / RotoBaller). Closers + batters always stay Pitcher
  // List. Persisted to sync (STORAGE.spSource; read by the SW's getPL). Options come from the registry so
  // adding a source needs no popup change. Switching triggers a PL-only refresh (the SW treats a source
  // change as a cache miss and refetches the new source); open ESPN tabs adopt the rebuilt index live.
  let SP_SOURCE = BV.CONFIG.spSourceDefault;
  const spSel = document.getElementById('bv-sp-source');
  for (const s of BV.spSourceList()) {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.label;
    spSel.appendChild(opt);
  }
  const spLabel = () => BV.spSourceCfg(SP_SOURCE).label;
  function applySpSourceLabel() {
    document.getElementById('bv-pl-sp-lab').textContent = `Override — starters (${spLabel()})`;
  }
  spSel.addEventListener('change', e => {
    SP_SOURCE = BV.validSpSource(e.target.value) ? e.target.value : BV.CONFIG.spSourceDefault;
    chrome.storage.sync.set({ [BV.STORAGE.spSource]: SP_SOURCE });
    applySpSourceLabel();
    setStatus(`Switching starters to ${spLabel()}…`);
    // force:false: the SW honors an override saved for this source, else refetches it (source = cache miss).
    refreshPl({ type: 'REFRESH_PL', force: false }, `Starters: ${spLabel()}`, spSel);
  });

  async function refreshPl(msg, label, btn) {
    if (btn) btn.disabled = true;
    try {
      const resp = await sendMessage(msg);
      if (resp && resp.ok) {
        const c = resp.counts || {};
        const src = BV.spSourceCfg(c.plSpSrc || SP_SOURCE).label;
        setStatus(`${label} — ${c.plSp || 0} SP (${src}) · ${c.plRp || 0} closers · ${c.plHit || 0} batters ranked.`);
      } else {
        setStatus('Rank refresh failed: ' + ((resp && resp.error) || 'unknown error'));
      }
    } catch (e) { setStatus('Rank refresh failed: ' + e.message); }
    finally { if (btn) btn.disabled = false; loadPlHealth(); }   // re-read the health the SW just wrote
  }

  document.getElementById('bv-pl-fetch').addEventListener('click', e => {
    setStatus(`Fetching latest ranks (${spLabel()} starters)…`);
    refreshPl({ type: 'REFRESH_PL', force: true }, 'Ranks refreshed', e.currentTarget);
  });

  document.getElementById('bv-pl-save').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const sp = document.getElementById('bv-pl-sp').value.trim();
    const rp = document.getElementById('bv-pl-rp').value.trim();
    const hit = document.getElementById('bv-pl-hit').value.trim();
    if (!sp && !rp && !hit) { setStatus('Paste at least one list, or use Fetch latest ranks to pull from the web.'); return; }
    setStatus('Saving override…');
    // spSrc tags the starters paste with the selected source: the SW applies it only while that source is
    // selected (rp/hit are always Pitcher List, so they apply regardless).
    try { await chrome.storage.local.set({ [plOverrideKey()]: { sp, rp, hit, spSrc: SP_SOURCE, ts: Date.now() } }); } catch (_) {}
    // force:false so the SW honors the override we just saved (this week only; auto-fetch resumes after).
    refreshPl({ type: 'REFRESH_PL', force: false }, 'Override saved (this week)', btn);
  });

  document.getElementById('bv-pl-clear').addEventListener('click', async e => {
    const btn = e.currentTarget;
    document.getElementById('bv-pl-sp').value = '';
    document.getElementById('bv-pl-rp').value = '';
    document.getElementById('bv-pl-hit').value = '';
    setStatus('Clearing override…');
    try { await chrome.storage.local.remove(plOverrideKey()); } catch (_) {}
    refreshPl({ type: 'REFRESH_PL', force: true }, 'Override cleared, fetched latest', btn);
  });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  (async () => {
    document.getElementById('bv-ver').textContent = 'v' + chrome.runtime.getManifest().version;
    try {
      const obj = await chrome.storage.sync.get([BV.STORAGE.prefs, BV.STORAGE.plPrefs, BV.STORAGE.debug, BV.STORAGE.enabled, BV.STORAGE.spSource]);
      PREFS = mergePrefs(obj[BV.STORAGE.prefs]);
      document.getElementById('bv-debug').checked = obj[BV.STORAGE.debug] === true;
      const on = obj[BV.STORAGE.enabled] !== false;            // default on
      document.getElementById('bv-enabled').checked = on;
      setMasterLabel(on);
      PL_PREFS = BV.mergePlPrefs(obj[BV.STORAGE.plPrefs]);
      document.getElementById('bv-pl-on').checked = PL_PREFS.on !== false;
      document.getElementById('bv-pl-on-sp').checked = PL_PREFS.sp !== false;
      document.getElementById('bv-pl-on-rp').checked = PL_PREFS.rp !== false;
      document.getElementById('bv-pl-on-hit').checked = PL_PREFS.h !== false;
      SP_SOURCE = BV.validSpSource(obj[BV.STORAGE.spSource]) ? obj[BV.STORAGE.spSource] : BV.CONFIG.spSourceDefault;
      spSel.value = SP_SOURCE;
      applySpSourceLabel();
      applyPlBody();
    } catch (_) { /* defaults already set */ }
    try {
      const o = (await chrome.storage.local.get(plOverrideKey()))[plOverrideKey()];
      if (o) {
        document.getElementById('bv-pl-sp').value = o.sp || '';
        document.getElementById('bv-pl-rp').value = o.rp || '';
        document.getElementById('bv-pl-hit').value = o.hit || '';
      }
    } catch (_) { /* no override saved */ }
    loadPlHealth();   // show the last fetch's per-list rows + freshness (empty until the first fetch)
    render();
  })();
})();
