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
  function colMeta() {
    const meta = {};
    for (const c of BV.CONFIG.columns.bat) meta[c.key] = { label: c.label, group: 'Hitters' };
    meta.ops = { label: 'OPS', group: 'Hitters' };
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

  function metricRow(key) {
    const p = PREFS[key] || {};
    const dirLabel = p.dir === 'low' ? 'lower = better' : 'higher = better';
    return `<tr data-key="${key}">
        <td class="bv-m-lab">${meta[key].label}</td>
        <td class="bv-m-onc"><input type="checkbox" class="bv-m-en" ${p.enabled ? 'checked' : ''}></td>
        <td><input type="text" class="bv-m-th" value="${fmtTh(key, p.threshold)}" ${p.enabled ? '' : 'readonly'}></td>
        <td class="bv-m-dir">${dirLabel}</td>
      </tr>`;
  }
  const section = (title, keys) =>
    `<tr class="bv-sec"><td colspan="4">${title}</td></tr>` + keys.map(metricRow).join('');

  function render() {
    const hitterKeys = Object.keys(meta).filter(k => meta[k].group === 'Hitters');
    const pitcherKeys = Object.keys(meta).filter(k => meta[k].group === 'Pitchers');
    document.getElementById('bv-tbody').innerHTML = section('Hitters', hitterKeys) + section('Pitchers', pitcherKeys);
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
    if (e.target.classList.contains('bv-m-en')) {
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

  async function refreshPl(msg, label, btn) {
    if (btn) btn.disabled = true;
    try {
      const resp = await sendMessage(msg);
      if (resp && resp.ok) {
        const c = resp.counts || {};
        setStatus(`${label} — ${c.plSp || 0} SP · ${c.plRp || 0} closers ranked.`);
      } else {
        setStatus('Pitcher List refresh failed: ' + ((resp && resp.error) || 'unknown error'));
      }
    } catch (e) { setStatus('Pitcher List refresh failed: ' + e.message); }
    finally { if (btn) btn.disabled = false; }
  }

  document.getElementById('bv-pl-fetch').addEventListener('click', e => {
    setStatus('Fetching latest Pitcher List ranks…');
    refreshPl({ type: 'REFRESH_PL', force: true }, 'Pitcher List refreshed', e.currentTarget);
  });

  document.getElementById('bv-pl-save').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const sp = document.getElementById('bv-pl-sp').value.trim();
    const rp = document.getElementById('bv-pl-rp').value.trim();
    if (!sp && !rp) { setStatus('Paste at least one list, or use Fetch latest ranks to pull from the web.'); return; }
    setStatus('Saving override…');
    try { await chrome.storage.local.set({ [plOverrideKey()]: { sp, rp, ts: Date.now() } }); } catch (_) {}
    // force:false so the SW honors the override we just saved (this week only; auto-fetch resumes after).
    refreshPl({ type: 'REFRESH_PL', force: false }, 'Override saved (this week)', btn);
  });

  document.getElementById('bv-pl-clear').addEventListener('click', async e => {
    const btn = e.currentTarget;
    document.getElementById('bv-pl-sp').value = '';
    document.getElementById('bv-pl-rp').value = '';
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
      const obj = await chrome.storage.sync.get([BV.STORAGE.prefs, BV.STORAGE.debug]);
      PREFS = mergePrefs(obj[BV.STORAGE.prefs]);
      document.getElementById('bv-debug').checked = obj[BV.STORAGE.debug] === true;
    } catch (_) { /* defaults already set */ }
    try {
      const o = (await chrome.storage.local.get(plOverrideKey()))[plOverrideKey()];
      if (o) {
        document.getElementById('bv-pl-sp').value = o.sp || '';
        document.getElementById('bv-pl-rp').value = o.rp || '';
      }
    } catch (_) { /* no override saved */ }
    render();
  })();
})();
