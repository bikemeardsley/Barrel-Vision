/*
 * Barrel Vision - content script (runs on fantasy.espn.com/baseball/*)
 * ---------------------------------------------------------------------------
 * All DOM work: read ESPN's player tables + player-card modal, look players up
 * by normalized name, inject Savant metric columns, shade cells, and keep it all
 * correct across ESPN's filter/sort/pagination row-node reuse.
 *
 * It does NOT fetch anything (content scripts can't fetch Savant/StatsAPI
 * cross-origin in MV3). It asks the service worker for the parsed index via
 * chrome.runtime.sendMessage, reads prefs from chrome.storage.sync, and listens
 * to chrome.storage.onChanged to re-shade live (no reload-on-save).
 *
 * Loaded AFTER shared/core.js (see manifest content_scripts), so BV is available.
 * Internal DOM classes/attributes keep the `savant-` prefix (these are Savant
 * metrics); the product name is Barrel Vision.
 */
(function () {
  'use strict';

  // Running diagnostics surfaced in the HUD.
  const STATS = { loaded: null, found: 0, matched: 0, error: null };

  let PREFS = BV.defaultPrefs();   // replaced by stored prefs at boot; updated live via onChanged
  let showDebug = false;
  let INDEXES = null;              // {bat, pit, hand} from the service worker
  let mo = null;
  let scanTimer = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function scheduleScan(indexes) {
    if (scanTimer) return;          // a scan is already queued; coalesce this burst into it
    scanTimer = setTimeout(() => { scanTimer = null; scan(indexes); }, BV.CONFIG.scanDebounceMs);
  }

  // ---------------------------------------------------------------------------
  // Shading
  // ---------------------------------------------------------------------------
  // Re-shade already-injected cells in place after a prefs change (no table rebuild).
  // Selects ANY cell carrying data-savant-key - both our injected .savant-col cells AND ESPN's own
  // OPS/ERA/WHIP cells we shade in place - so a live prefs change restains all of them (this is what
  // lets us drop the userscript's reload-on-save).
  function recolorAll() {
    for (const td of document.querySelectorAll('td[data-savant-key]')) {
      const raw = parseFloat(td.dataset.savantVal);
      td.style.backgroundColor = BV.cellColor(PREFS, td.dataset.savantKey, Number.isFinite(raw) ? raw : NaN);
    }
  }

  // ---------------------------------------------------------------------------
  // Index lookup + cell values
  // ---------------------------------------------------------------------------
  function lookup(index, name, team) {
    const matches = index[BV.normName(name)];
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
  // cleanly): pctFrac columns are 0-1 fractions on disk but shown as percent, so scale them x100 here.
  function rawValueFor(col, row) {
    if (!row) return NaN;
    if (col.sourceCandidates) {
      for (const src of col.sourceCandidates) if (row[src] != null && row[src] !== '') {
        const n = BV.num(row[src]);
        return col.fmt === BV.pctFrac ? n * 100 : n;
      }
    }
    if (col.derive) return BV.num(col.derive(row));
    return NaN;
  }

  // ---------------------------------------------------------------------------
  // DOM injection
  // ---------------------------------------------------------------------------
  const FLAG = 'data-savant-done';

  // QS isn't in the player-card modal DOM and can't be computed from it. It IS a column on the roster
  // list, so we capture name -> QS while scanning the list and reuse it in the modal. Lives for the
  // SPA session; empty until a pitcher roster table has been scanned.
  const rosterStats = {}; // normName -> { qs }

  function rowPlayer(tr) {
    const nameEl = tr.querySelector(BV.CONFIG.selectors.playerName);
    if (!nameEl) return null;
    const name = (nameEl.textContent || '').trim();
    if (!name) return null;
    const teamEl = tr.querySelector(BV.CONFIG.selectors.playerTeam);
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
  function hideResearch(scroller) {
    if (!BV.CONFIG.hideResearchColumns) return;
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
    const cols = BV.CONFIG.columns[kind];
    const index = indexes[kind];
    const hand = indexes.hand || {};

    // data-idx -> player, from the left (name) table. Also append handedness to the position cell
    // ("MIL C, DH • Righty") - batSide for hitters, pitchHand for pitchers.
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
        const want = BV.normName(p.name);
        if (posCell.dataset.savantHandFor !== want) {
          posCell.querySelector('.savant-hand')?.remove();
          const h = hand[BV.normName(p.name)];
          const word = h && BV.handWord(kind === 'pit' ? h.throws : h.bats);
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

    // Capture QS from the pitcher list so the modal can reuse it.
    if (kind === 'pit') captureRosterQS(scroller, players);

    hideResearch(scroller);

    // Header: add an "Advanced" group banner + column sub-headers, mirroring ESPN's own header markup.
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

    // Body: append cells matched by data-idx, using ESPN's cell markup so font + alignment match.
    // Re-entrant: ESPN reuses the same <tr> nodes on sort/filter/paginate, so we key each row on the
    // player it currently holds (data-savant-name) and rebuild only when that changes.
    for (const tr of scroller.querySelectorAll('tbody tr')) {
      const idx = tr.getAttribute('data-idx');
      const p = idx != null ? players[idx] : null;
      const want = p ? BV.normName(p.name) : '';
      if (!p) {
        // TOTALS / empty-slot rows: leave them exactly as ESPN ships them. If a reused node turned
        // into a totals row, strip any cells we'd added before.
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
        td.style.backgroundColor = BV.cellColor(PREFS, col.key, raw);
        if (!row) td.title = 'No Savant match';
        tr.appendChild(td);
      }
      tr.dataset.savantName = want;
    }

    // Shade ESPN's existing OPS column on hitter lists; ERA + WHIP on pitcher lists.
    if (kind === 'bat') shadeListColumn(scroller, 'OPS', 'ops', players);
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
      const raw = BV.num((td.textContent || '').trim());
      td.dataset.savantKey = key;
      td.dataset.savantVal = Number.isFinite(raw) ? String(raw) : '';
      td.style.backgroundColor = BV.cellColor(PREFS, key, raw);
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
      if (v !== '') rosterStats[BV.normName(p.name)] = { qs: v };
    }
  }

  // OPS = OBP + SLG, formatted like a rate stat (".763" / "1.045"). Inputs are ESPN cell text.
  function opsFmt(obp, slg) {
    const o = BV.num(obp), s = BV.num(slg);
    if (!Number.isFinite(o) || !Number.isFinite(s)) return '';
    const v = o + s;
    return v < 1 ? v.toFixed(3).replace(/^0/, '') : v.toFixed(3);
  }

  // The player-card modal (opens on a player-name click) - a separate DOM target from the roster
  // tables. Adds handedness under the team name; one computed column (OPS for hitters / QS for
  // pitchers) on ESPN's Season + Last-7 rows; and a shaded Advanced Stats table beneath them.
  function decorateModal(indexes) {
    const modal = document.querySelector('.player-card-modal');
    if (!modal || modal.hasAttribute(FLAG)) return;

    const statsTable = modal.querySelector('.player-stats-table table.Table');
    if (!statsTable) return;                       // still rendering - don't flag, retry next mutation
    const headRow = statsTable.querySelector('thead tr');
    const bodyRows = [...statsTable.querySelectorAll('tbody tr')];
    if (!headRow || !bodyRows.length) return;

    const isPit = !!statsTable.querySelector('thead .stat-ip');
    const kind = isPit ? 'pit' : 'bat';

    const nameWrap = modal.querySelector('.player-name');
    const name = nameWrap ? [...nameWrap.querySelectorAll('div')].map(d => (d.textContent || '').trim()).filter(Boolean).join(' ') : '';

    // Handedness inline next to the team name, like the list: "Milwaukee Brewers • Righty".
    const hand = (indexes.hand || {})[BV.normName(name)];
    const teamEl = modal.querySelector('.player-teamname');
    if (teamEl && hand && !teamEl.parentNode.querySelector('.savant-hand')) {
      const word = BV.handWord(isPit ? hand.throws : hand.bats);
      if (word) {
        const span = document.createElement('span');
        span.className = 'savant-hand';
        span.textContent = `• ${word}`;
        teamEl.insertAdjacentElement('afterend', span);
      }
    }

    // Condense ESPN's own columns in place: OBP+SLG -> a single OPS (hitters); W+L -> QS (pitchers).
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
          const td = obp.closest('td'), raw = BV.num(ops);
          td.dataset.savantKey = 'ops'; td.dataset.savantVal = Number.isFinite(raw) ? String(raw) : '';
          td.style.backgroundColor = BV.cellColor(PREFS, 'ops', raw);
        }
        slg?.closest('td')?.classList.add('savant-hidden');
      }
    } else {
      relabel(headByStat('stat-w'), 'QS');
      headByStat('stat-l')?.classList.add('savant-hidden');
      const qs = (rosterStats[BV.normName(name)] || {}).qs || '';
      for (const tr of bodyRows) {
        const w = tr.querySelector('.stat-w'), l = tr.querySelector('.stat-l');
        if (w) w.textContent = (tr.getAttribute('data-idx') === '0') ? qs : ''; // QS is a season total
        l?.closest('td')?.classList.add('savant-hidden');
        // Shade ESPN's existing ERA + WHIP cells in place (off by default; user opts in via the popup).
        for (const [cls, key] of [['stat-era', 'era'], ['stat-whip', 'whip']]) {
          const cell = tr.querySelector('.' + cls);
          if (!cell) continue;
          const td = cell.closest('td'), raw = BV.num(cell.textContent);
          td.dataset.savantKey = key; td.dataset.savantVal = Number.isFinite(raw) ? String(raw) : '';
          td.style.backgroundColor = BV.cellColor(PREFS, key, raw);
        }
      }
    }

    buildAdvancedTable(modal, kind, lookup(indexes[kind], name), hand && hand.slug);

    modal.setAttribute(FLAG, '1');
  }

  // Build the standalone "Advanced Stats" table beneath ESPN's Stats table, styled with ESPN's own
  // Table classes so it reads as native. One Season row; cells shaded by the same preference logic.
  function buildAdvancedTable(modal, kind, row, slug) {
    const host = modal.querySelector('.player-stats-table');
    if (!host || host.parentNode.querySelector('.savant-adv')) return;
    const cols = BV.CONFIG.columns[kind];
    let head = '<th class="Table__TH"><div class="table--cell header"><span></span></div></th>';
    let body = '<td class="Table__TD savant-adv-rowlabel">Season</td>';
    for (const col of cols) {
      head += `<th class="Table__TH"><div class="table--cell tar header"><span>${col.label}</span></div></th>`;
      if (row) {
        const raw = rawValueFor(col, row), disp = valueFor(col, row) || '--', bg = BV.cellColor(PREFS, col.key, raw);
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
      // FantasyCast: skip the live-updating list (constant in-game churn) but still decorate the
      // player-card popup if the user clicks a name.
      if (!/\/fantasycast/i.test(location.pathname)) {
        for (const block of document.querySelectorAll('.ResponsiveTable--fixed-left')) {
          try { decorateBlock(block, indexes); } catch (_) { /* keep going */ }
        }
      }
      try { decorateModal(indexes); } catch (_) { /* modal is optional */ }
    } finally {
      updateHud();                                                  // write the HUD while still disconnected
      if (mo) mo.observe(document.body, { childList: true, subtree: true }); // then resume observing
    }
  }

  // ---------------------------------------------------------------------------
  // Diagnostic HUD
  // ---------------------------------------------------------------------------
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
    hudEl.innerHTML = `<div>${savant}</div>` + (api ? `<div>${api}</div>` : '');
    hudEl.dataset.state = STATS.error ? 'err' : (STATS.found === 0 && STATS.loaded != null ? 'warn' : 'ok');
  }

  // ---------------------------------------------------------------------------
  // Prefs (chrome.storage.sync) - merged onto defaults so new columns appear for existing users.
  // ---------------------------------------------------------------------------
  function mergePrefs(saved) {
    const base = BV.defaultPrefs();
    if (saved && typeof saved === 'object') {
      for (const k in base) if (saved[k]) base[k] = { ...base[k], ...saved[k] };
    }
    return base;
  }

  async function loadState() {
    try {
      const obj = await chrome.storage.sync.get([BV.STORAGE.prefs, BV.STORAGE.debug]);
      PREFS = mergePrefs(obj[BV.STORAGE.prefs]);
      showDebug = obj[BV.STORAGE.debug] === true;
    } catch (_) { /* defaults already set */ }
  }

  // ---------------------------------------------------------------------------
  // Messaging to the service worker (with a small retry for the SW wake-up race).
  // ---------------------------------------------------------------------------
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, resp => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(resp);
      });
    });
  }
  async function getIndex(tries = 4) {
    for (let i = 0; i < tries; i++) {
      try { return await sendMessage({ type: 'GET_INDEX' }); }
      catch (e) { if (i === tries - 1) throw e; await sleep(300); }   // "Receiving end does not exist" -> SW waking
    }
  }

  // ---------------------------------------------------------------------------
  // Live updates from storage: prefs/debug (sync) re-shade in place; a popup-triggered data refresh
  // (local cache rewrite) is adopted live.
  // ---------------------------------------------------------------------------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes[BV.STORAGE.prefs]) { PREFS = mergePrefs(changes[BV.STORAGE.prefs].newValue); recolorAll(); }
      if (changes[BV.STORAGE.debug]) { showDebug = changes[BV.STORAGE.debug].newValue === true; updateHud(); }
    } else if (area === 'local') {
      const ch = changes[BV.STORAGE.cacheKey(BV.CONFIG.year)];
      if (ch && ch.newValue && ch.newValue.indexes && INDEXES) {  // guard: only react after initial load
        INDEXES = ch.newValue.indexes;
        STATS.loaded = { bat: BV.countIndex(INDEXES.bat), pit: BV.countIndex(INDEXES.pit), hand: Object.keys(INDEXES.hand || {}).length };
        scan(INDEXES);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  (async () => {
    await loadState();
    updateHud();
    try {
      const resp = await getIndex();
      if (!resp || !resp.ok) throw new Error(resp && resp.error ? resp.error : 'no response from background');
      INDEXES = resp.indexes;
      STATS.loaded = resp.counts;
      scan(INDEXES);                                              // first scan runs with mo still null
      mo = new MutationObserver(() => scheduleScan(INDEXES));
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (err) {
      STATS.error = err.message;
      updateHud();
      console.error('[Barrel Vision]', err);
    }
  })();
})();
