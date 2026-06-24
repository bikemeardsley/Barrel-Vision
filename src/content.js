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
  let PL_PREFS = BV.defaultPlPrefs(); // Pitcher List display toggles {on,sp,rp,h}; updated live
  let HAND_BY_TEAM_LAST = {};      // `${teamId}|${lastName}` -> hand record (resolve ESPN's last-name-only probable pitcher)
  const SPLITS = {};               // batter MLBAM id -> { l:{ops,pa}, r:{ops,pa} } (matchup splits, content-side cache)
  // ESPN opponent abbrev -> StatsAPI abbrev, for the few that differ (StatsAPI is authoritative here).
  const ESPN_ABBR_ALIAS = { CHW: 'CWS', ARI: 'AZ', OAK: 'ATH', SFG: 'SF', TBR: 'TB', KCR: 'KC', SDP: 'SD', WSN: 'WSH' };
  let prevShowSig = '';           // signature of which columns are shown - to detect show-set changes live
  let prevHandSig = '';           // signature of the handedness display toggles - same idea
  let showDebug = false;
  let ENABLED = true;             // master on/off (chrome.storage.sync 'enabled'); absent = on
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
  // Shading STYLE. The default 'bar' is an underline data-bar: the number stays on a clear cell
  // (always legible) and a solid red/blue bar along the bottom edge encodes the read, its WIDTH growing
  // with distance from the threshold. 'stripe' is a left-edge accent (kept as an easy alternative);
  // 'fill' is the original full-cell wash. Swap this one constant to change every shaded cell at once.
  const SHADE_STYLE = 'tint';                // 'tint' | 'text' | 'bubble' | 'stripe' | 'bar' | 'fill'
  const HOT = '214,46,46', COLD = '36,92,204';

  // 'text' style colour: the NUMBER itself, red (better) / blue (worse), deeper the further past the
  // threshold. Lerps from a light end (near the threshold) to a deep end (far) - never so light it's hard
  // to read, never so dark the colour is lost.
  function textColor(better, mag) {
    const lo = better ? [206, 99, 99] : [120, 150, 214];
    const hi = better ? [171, 18, 18] : [22, 58, 156];
    const t = Math.max(0.25, mag);            // floor so a small edge still reads tinted
    return `rgb(${lo.map((v, i) => Math.round(v + (hi[i] - v) * t)).join(',')})`;
  }

  // Inline background CSS (object) for the gradient-based styles. 'text'/'bubble' are handled separately
  // in paintCell, so they aren't produced here.
  function shadeDecls(sig) {
    const rgb = sig.better ? HOT : COLD;
    const mag = Math.abs(sig.t);
    if (SHADE_STYLE === 'fill') {
      const a = (0.12 + 0.42 * mag).toFixed(3);
      return { backgroundColor: `rgba(${rgb},${a})` };
    }
    if (SHADE_STYLE === 'bar') {       // left-anchored bottom data-bar, width = magnitude (15% floor)
      const w = Math.round(Math.max(0.15, mag) * 100);
      return {
        backgroundImage: `linear-gradient(rgb(${rgb}),rgb(${rgb}))`,
        backgroundRepeat: 'no-repeat', backgroundPosition: 'left bottom', backgroundSize: `${w}% 3px`,
      };
    }
    // 'stripe': left-edge accent, opacity = magnitude.
    const a = (0.5 + 0.5 * mag).toFixed(2);
    return {
      backgroundImage: `linear-gradient(rgba(${rgb},${a}),rgba(${rgb},${a}))`,
      backgroundRepeat: 'no-repeat', backgroundPosition: 'left center', backgroundSize: '3px 68%',
    };
  }

  // The element holding the number (our injected cells + ESPN's own cells both wrap text in .table--cell).
  function cellText(td) { return td.querySelector('.table--cell') || td; }

  // Remove any shade we've painted: inline background (gradient styles), the 'bubble' class + custom
  // props, and the 'text' colour. Lets a disabled column / a re-shade start from a clean cell.
  function clearShade(td) {
    td.style.backgroundColor = '';
    td.style.backgroundImage = '';
    td.classList.remove('savant-bubble');
    td.style.removeProperty('--bv-bub-c');
    td.style.removeProperty('--bv-bub-w');
    td.style.removeProperty('--bv-bub-o');
    const el = cellText(td);
    el.style.removeProperty('color');
    el.style.removeProperty('font-weight');
  }

  // Paint (or clear) a cell node. 'tint' (default) tints the number AND adds a faint cell wash; 'text'
  // is the number only; 'bubble' draws a coloured oval via a CSS pseudo-element; the others set an inline
  // background. Always clears first.
  function paintCell(td, key, raw) {
    clearShade(td);
    const sig = BV.cellSignal(PREFS, key, raw);
    if (!sig) return;
    const mag = Math.abs(sig.t);
    if (SHADE_STYLE === 'tint' || SHADE_STYLE === 'text') {
      const el = cellText(td);
      el.style.setProperty('color', textColor(sig.better, mag), 'important');  // beat ESPN's own colour
      el.style.setProperty('font-weight', '700', 'important');
      if (SHADE_STYLE === 'tint') {                       // faint wash, far lighter than the old 'fill'
        const a = (0.06 + 0.14 * mag).toFixed(3);
        td.style.backgroundColor = `rgba(${sig.better ? HOT : COLD},${a})`;
      }
      return;
    }
    if (SHADE_STYLE === 'bubble') {
      td.classList.add('savant-bubble');
      td.style.setProperty('--bv-bub-c', `rgb(${sig.better ? HOT : COLD})`);
      td.style.setProperty('--bv-bub-w', `${Math.round(12 + 10 * mag)}px`);
      td.style.setProperty('--bv-bub-o', (0.4 + 0.6 * mag).toFixed(2));
      return;
    }
    Object.assign(td.style, shadeDecls(sig));
  }

  // Re-shade already-injected cells in place after a prefs change (no table rebuild). Selects ANY cell
  // carrying data-savant-key - both our injected .savant-col cells AND ESPN's own OPS/ERA/WHIP cells we
  // shade in place - so a live prefs change restains all of them (this is what lets us drop the
  // userscript's reload-on-save).
  function recolorAll() {
    for (const td of document.querySelectorAll('td[data-savant-key]')) {
      const raw = parseFloat(td.dataset.savantVal);
      paintCell(td, td.dataset.savantKey, Number.isFinite(raw) ? raw : NaN);
    }
  }

  // Column visibility (popup "Show"). Default shown if the pref is missing.
  function isShown(key) { const p = PREFS[key]; return !p || p.show !== false; }
  // Visible subset of a kind's injected Savant columns.
  function shownCols(kind) { return BV.CONFIG.columns[kind].filter(c => isShown(c.key)); }
  // Signature of the shown-set across all injected columns - so a live prefs change can tell a "Show"
  // toggle (needs column re-injection) apart from a Highlight/threshold tweak (just a recolor).
  function showSig(prefs) {
    return [...BV.CONFIG.columns.bat, ...BV.CONFIG.columns.pit]
      .map(c => (prefs[c.key] && prefs[c.key].show !== false) ? '1' : '0').join('');
  }

  // Handedness display ("• Righty/Lefty"): batBat row gates batter rows, handPit gates pitcher rows.
  function handShown(kind) { const p = PREFS[kind === 'pit' ? 'handPit' : 'handBat']; return !p || p.show !== false; }
  function handSig(prefs) {
    return ((prefs.handBat && prefs.handBat.show !== false) ? '1' : '0') +
           ((prefs.handPit && prefs.handPit.show !== false) ? '1' : '0');
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

  // Build the inline rank badge ("• PL #N" / "• RZ #N" / "• RB #N") from a pick (BV.plPick already
  // resolved the rank + which SOURCE produced it + slug + tier). Pitchers use the SP rank (from the
  // user-selected source: Pitcher List, Razzball or RotoBaller); hitters use PL's "Top 150 Hitters" rank;
  // closers use PL's "Top 50 Closers". The source + tier is named in the tooltip; the leading bullet
  // stays plain text and only the "{ABBR} #N" part becomes a blue link, and only when asLink is set AND
  // the source has a per-player URL for this slug (the player-card overlay; lists pass asLink=false).
  function plBadge(r, asLink, kind) {
    const pick = BV.plPick(r, kind, PL_PREFS);   // honours the master + per-list display toggles
    if (!pick) return null;
    const src = BV.spSourceCfg(pick.src);                          // abbr / label / playerUrl for this source
    const showTier = pick.list !== 'rp' && pick.tier;             // closers carry no tier in the tooltip
    const tierTip = showTier ? ` (Tier ${String(pick.tier).replace(/^T/, '')})` : '';
    const listName = pick.list === 'h' ? 'hitter rank' : pick.list === 'sp' ? 'SP rank' : 'closer rank';
    const span = document.createElement('span');
    span.className = 'savant-pl';
    span.title = `${src.label} — ${listName}${tierTip}`;
    span.append('• ');                                  // bullet is plain text, never underlined
    const label = `${src.abbr} #${pick.rank}`;
    let href = (src.playerUrl && pick.slug) ? src.playerUrl.replace('{slug}', pick.slug) : '';
    if (!href && pick.list === 'sp' && r.spListUrl) href = r.spListUrl;   // no player page (Razzball) -> this week's list
    if (asLink && href) {
      const a = document.createElement('a');
      a.className = 'savant-pl-link';
      a.textContent = label;
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      span.appendChild(a);
    } else {
      span.append(label);
    }
    return span;
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
    const cols = shownCols(kind);            // only the columns the user has "Show" on for
    const index = indexes[kind];
    const hand = indexes.hand || {};
    const pl = indexes.pl || {};

    // data-idx -> player, from the left (name) table. Also append handedness to the position cell
    // ("MIL C, DH • Righty") - batSide for hitters, pitchHand for pitchers.
    const players = {};
    const needSplits = [];                  // batter rows whose matchup grade is waiting on a splits fetch
    for (const tr of leftTable.querySelectorAll('tbody tr')) {
      const idx = tr.getAttribute('data-idx');
      if (idx == null) continue;
      const p = rowPlayer(tr);
      if (!p) continue;
      players[idx] = p;
      decorateMatchup(tr, kind, p, indexes, needSplits);   // R/L append + A–F grade, by the OPP
      const posCell = tr.querySelector('.player-column__position');
      if (posCell) {
        // Refresh handedness if this row now shows a different player than we last tagged it for
        // (ESPN reuses row nodes when you sort/filter/paginate, so a stale span would be wrong).
        const want = BV.normName(p.name);
        if (posCell.dataset.savantHandFor !== want) {
          posCell.querySelector('.savant-hand')?.remove();
          posCell.querySelector('.savant-pl')?.remove();
          const h = hand[BV.normName(p.name)];
          const word = h && BV.handWord(kind === 'pit' ? h.throws : h.bats);
          if (word && handShown(kind)) {
            const span = document.createElement('span');
            span.className = 'savant-hand';
            span.textContent = `• ${word}`;
            posCell.appendChild(span);
          }
          // Pitcher List rank, inline right after handedness (SP/closer rank on pitcher rows, "Top 150
          // Hitters" rank on batter rows). Rebuilt in this same row-reuse guard, so it can't go stale
          // when ESPN recycles the <tr> on sort/filter/paginate.
          const plSpan = plBadge(pl[want], false, kind);
          if (plSpan) posCell.appendChild(plSpan);
          posCell.dataset.savantHandFor = want;
        }
      }
    }
    if (needSplits.length) fillSplits(needSplits);          // async: fill the batter-grade placeholders

    hideResearch(scroller);

    // Header: add an "Advanced" group banner + column sub-headers, mirroring ESPN's own header markup.
    // Keyed on a marker class (not a one-time flag) so it self-heals if a re-render strips our cells.
    const theadRows = [...scroller.querySelectorAll('thead tr')];
    const groupRow = theadRows[0];
    const subRow = theadRows[theadRows.length - 1];
    if (cols.length && subRow && !subRow.querySelector('.savant-col-th')) {
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
        paintCell(td, col.key, raw);
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
      paintCell(td, key, raw);
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
    const plRec = (indexes.pl || {})[BV.normName(name)];
    const teamEl = modal.querySelector('.player-teamname');
    if (teamEl && hand && handShown(kind) && !teamEl.parentNode.querySelector('.savant-hand')) {
      const word = BV.handWord(isPit ? hand.throws : hand.bats);
      if (word) {
        const span = document.createElement('span');
        span.className = 'savant-hand';
        span.textContent = `• ${word}`;
        teamEl.insertAdjacentElement('afterend', span);
      }
    }

    // Pitcher List rank, inline right after handedness - SP/closer rank for pitchers, hitter rank for
    // batters. Same badge as the list view; here "PL #N" links to the player's PL page.
    if (teamEl && !teamEl.parentNode.querySelector('.savant-pl')) {
      const plSpan = plBadge(plRec, true, kind);
      if (plSpan) (teamEl.parentNode.querySelector('.savant-hand') || teamEl).insertAdjacentElement('afterend', plSpan);
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
          paintCell(td, 'ops', raw);
        }
        slg?.closest('td')?.classList.add('savant-hidden');
      }
    } else {
      relabel(headByStat('stat-w'), 'QS');
      headByStat('stat-l')?.classList.add('savant-hidden');
      let seasonW = null;
      for (const tr of bodyRows) {
        const w = tr.querySelector('.stat-w'), l = tr.querySelector('.stat-l');
        // QS is a season total: keep the Season row's W cell (filled async below), blank the others.
        if (w) { if (tr.getAttribute('data-idx') === '0') seasonW = w; else w.textContent = ''; }
        l?.closest('td')?.classList.add('savant-hidden');
        // Shade ESPN's existing ERA + WHIP cells in place (off by default; user opts in via the popup).
        for (const [cls, key] of [['stat-era', 'era'], ['stat-whip', 'whip']]) {
          const cell = tr.querySelector('.' + cls);
          if (!cell) continue;
          const td = cell.closest('td'), raw = BV.num(cell.textContent);
          td.dataset.savantKey = key; td.dataset.savantVal = Number.isFinite(raw) ? String(raw) : '';
          paintCell(td, key, raw);
        }
      }
      // QS isn't a Savant or StatsAPI field - the SW computes it from the pitcher's StatsAPI gameLog
      // (>=6 IP & <=3 ER per start), keyed by MLBAM id (carried on the hand index). Authoritative
      // season value, independent of ESPN's list-filter window. Filled async so the modal isn't blocked.
      if (seasonW) {
        const pid = hand && hand.id;
        if (pid) {
          seasonW.textContent = '…';
          sendMessage({ type: 'GET_QS', id: pid })
            .then(r => { seasonW.textContent = (r && r.ok && r.qs != null) ? String(r.qs) : ''; })
            .catch(() => { seasonW.textContent = ''; });
        } else {
          seasonW.textContent = '';
        }
      }
    }

    buildAdvancedTable(modal, kind, lookup(indexes[kind], name), hand && hand.slug);
    buildSliders(modal, kind, lookup((indexes.pct && indexes.pct[kind]) || {}, name), lookup(indexes[kind], name));

    modal.setAttribute(FLAG, '1');
  }

  // Build the standalone "Advanced Stats" table beneath ESPN's Stats table, styled with ESPN's own
  // Table classes so it reads as native. One Season row; cells shaded by the same preference logic.
  function buildAdvancedTable(modal, kind, row, slug) {
    const host = modal.querySelector('.player-stats-table');
    if (!host || host.parentNode.querySelector('.savant-adv')) return;
    const cols = shownCols(kind);                   // respect the popup "Show" toggles
    if (!cols.length) return;                        // all Savant columns hidden -> no table
    let head = '<th class="Table__TH"><div class="table--cell header"><span></span></div></th>';
    let body = '<td class="Table__TD savant-adv-rowlabel">Season</td>';
    for (const col of cols) {
      head += `<th class="Table__TH"><div class="table--cell tar header"><span>${col.label}</span></div></th>`;
      if (row) {
        const raw = rawValueFor(col, row), disp = valueFor(col, row) || '--';
        body += `<td class="Table__TD savant-col" data-savant-key="${col.key}" data-savant-val="${Number.isFinite(raw) ? raw : ''}"><div class="table--cell tar">${disp}</div></td>`;
      } else {
        body += '<td class="Table__TD"><div class="table--cell tar">--</div></td>';
      }
    }
    // Savant-page link, styled like ESPN's "Complete Stats" link to the right of the Stats header.
    // The Pitcher List link lives on the "• PL #N" rank badge by the player's name (see plBadge), so
    // there's no separate PL link here.
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
    // Shade the value cells through the same node painter the lists use (so 'bubble' etc. apply here too).
    for (const td of wrap.querySelectorAll('td.savant-col[data-savant-key]')) {
      const raw = parseFloat(td.dataset.savantVal);
      paintCell(td, td.dataset.savantKey, Number.isFinite(raw) ? raw : NaN);
    }
    host.insertAdjacentElement('afterend', wrap);
  }

  // Savant's slider scale: 100 = red (elite), 50 = neutral grey, 0 = blue (poor). 3-stop interpolation
  // so a mid-pack percentile reads neutral rather than faint-red.
  function pctColor(p) {
    const grey = [150, 150, 150], red = [214, 46, 46], blue = [36, 92, 204];
    const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
    return p >= 50 ? mix(grey, red, (p - 50) / 50) : mix(grey, blue, (50 - p) / 50);
  }

  // Collapsible "Savant percentile sliders" section in the player card, inserted beneath the Advanced
  // Stats table (so the modal stays short until expanded - it sits between Advanced Stats and ESPN's
  // next-start box). Mirrors Savant's player page: each row shows the ACTUAL stat value with the bar
  // positioned at the player's percentile (pctRow = positions, rawRow = the values from the leaderboards
  // we already fetch). Built once per modal open (guarded like buildAdvancedTable).
  function buildSliders(modal, kind, pctRow, rawRow) {
    const anchor = modal.querySelector('.savant-adv') || modal.querySelector('.player-stats-table');
    if (!anchor || anchor.parentNode.querySelector('.savant-sliders')) return;
    const defs = (BV.CONFIG.percentiles && BV.CONFIG.percentiles[kind]) || [];
    if (!defs.length) return;

    const rows = [];
    for (const d of defs) {
      const pv = pctRow ? BV.num(pctRow[d.pct]) : NaN;
      if (!Number.isFinite(pv)) continue;                            // no percentile -> Savant shows no bar
      let val = '';
      if (rawRow && d.src) {
        for (const s of d.src) if (rawRow[s] != null && rawRow[s] !== '') { val = d.fmt(rawRow[s]); break; }
      }
      if (!val) continue;                                            // values-only, per request (no bare ranks)
      rows.push({ label: d.label, pct: Math.max(0, Math.min(100, Math.round(pv))), val });
    }

    const details = document.createElement('details');
    details.className = 'savant-sliders';
    if (!rows.length) {
      details.innerHTML = '<summary>Savant percentile sliders</summary>' +
        '<div class="savant-sliders-empty">No Statcast percentile data for this player yet.</div>';
      anchor.insertAdjacentElement('afterend', details);
      return;
    }
    const bars = rows.map(r => {
      const c = pctColor(r.pct);
      return '<div class="savant-slider-row">' +
        `<span class="savant-slider-lab">${r.label}</span>` +
        '<span class="savant-slider-track">' +
          `<span class="savant-slider-fill" style="width:${r.pct}%;background:${c}"></span>` +
          `<span class="savant-slider-dot" style="left:${r.pct}%;background:${c}" title="${r.pct}th percentile"></span>` +
        '</span>' +
        `<span class="savant-slider-val">${r.val}</span>` +
      '</div>';
    }).join('');
    details.innerHTML = `<summary>Savant percentile sliders</summary><div class="savant-sliders-body">${bars}</div>`;
    anchor.insertAdjacentElement('afterend', details);
  }

  // ---------------------------------------------------------------------------
  // Matchup ratings (day-of). Keyed off ESPN's own opponent cell: the opponent team abbrev + that day's
  // probable pitcher (last name). For BATTERS we grade their season wOBA vs the opposing starter's hand and
  // append the hand as " L"/" R"; for PITCHERS we grade the opponent team's park-neutral offense, folding
  // in today's park. Shown as a small colour-graded chip inline by the OPP, like ESPN's OPRK (number =
  // season talent rank; colour = continuous z-score on the day's park, not the ordinal rank).
  // ---------------------------------------------------------------------------
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // Matchup colour, green → gold → red (g: 0 = worst, red .. 1 = best, green). Red is the app red
  // (#d62e2e) so it sits with the rest of the page; gold + green are strong enough to read on white.
  const MU_RED = [214, 46, 46], MU_GOLD = [216, 160, 16], MU_GREEN = [26, 143, 79];
  function matchupColorFromG(g) {
    g = clamp01(g);
    const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
    return g < 0.5 ? mix(MU_RED, MU_GOLD, g / 0.5) : mix(MU_GOLD, MU_GREEN, (g - 0.5) / 0.5);
  }
  // Batter matchup as a 6-tier symbol over g (sixths), grouped by colour: green (good), gold (mid), red
  // (bad). ▲▲ elite · ▲ good · ⟋ lean-good · ⟍ lean-tough · ▼ tough · ▼▼ very tough.
  function matchupSymbol(g) {
    g = clamp01(g);
    const green = `rgb(${MU_GREEN})`, gold = `rgb(${MU_GOLD})`, red = `rgb(${MU_RED})`;
    if (g >= 0.833) return { sym: '▲▲', color: green, label: 'elite' };
    if (g >= 0.667) return { sym: '▲',  color: green, label: 'good' };
    if (g >= 0.5)   return { sym: '⟋',  color: gold,  label: 'lean good' };
    if (g >= 0.333) return { sym: '⟍',  color: gold,  label: 'lean tough' };
    if (g >= 0.167) return { sym: '▼',  color: red,   label: 'tough' };
    return { sym: '▼▼', color: red, label: 'very tough' };
  }

  // --- Batter matchup model (odds-ratio / log5) -------------------------------------------------------
  // Per the research: combine the batter's expected wOBA-vs-today's-hand with the opposing starter's
  // xwOBA-allowed MULTIPLICATIVELY (odds-ratio), not as a linear blend. This makes batter & pitcher
  // symmetric and shrinks the platoon term to the small, heavily-regressed tiebreaker it should be.
  const LG_WOBA = 0.315;                                     // league wOBA baseline
  const clampW = w => Math.max(0.05, Math.min(0.95, w));

  // Regressed platoon delta (wOBA) applied on top of the batter's overall wOBA. Individual vs-hand OPS
  // splits are regressed HARD toward the league platoon split (The Book: ~2200 PA RHB / ~1000 PA LHB) and
  // converted OPS->~wOBA. f_adv conserves the batter's season average. Switch hitters: no delta (their
  // overall line is already platoon-optimised). With no split data it falls back to the league platoon.
  function platoonDelta(rec, bats, oppHand) {
    if (bats !== 'L' && bats !== 'R') return 0;
    const isLHB = bats === 'L';
    const adv = oppHand === (isLHB ? 'R' : 'L');             // platoon advantage = facing the opposite hand
    const sLg = isLHB ? 0.027 : 0.017, K = isLHB ? 1000 : 2200;
    const advSide = rec && (isLHB ? rec.r : rec.l);
    const disSide = rec && (isLHB ? rec.l : rec.r);
    let sObs = sLg, n = 0, fAdv = isLHB ? 0.72 : 0.27;
    if (advSide && disSide && Number.isFinite(advSide.ops) && Number.isFinite(disSide.ops)) {
      sObs = (advSide.ops - disSide.ops) * 0.45;            // OPS delta -> approx wOBA delta
      n = Math.min(advSide.pa || 0, disSide.pa || 0);
      const aPa = advSide.pa || 0, dPa = disSide.pa || 0;
      if (aPa + dPa > 0) fAdv = aPa / (aPa + dPa);
    }
    const sReg = (sObs * n + sLg * K) / (n + K);
    return adv ? (1 - fAdv) * sReg : -fAdv * sReg;
  }

  // Goodness 0..1 for a batter facing the day's starter. rec = vs-L/R OPS splits (optional refinement),
  // batRec = batter's bat-index row (overall wOBA), pitRec = opposing starter's pit-index row (xwOBA allowed).
  function batterMatchupG(rec, oppHand, pitRec, batRec, bats) {
    const wOverall = batRec ? BV.num(batRec.woba) : NaN;
    if (!Number.isFinite(wOverall)) return null;            // no batter wOBA -> no grade
    const B = clampW(wOverall + platoonDelta(rec, bats, oppHand));
    const xw = pitRec ? BV.num(pitRec.est_woba) : NaN;
    const P = clampW(Number.isFinite(xw) ? xw : LG_WOBA);   // neutral pitcher if unknown
    const base = (B * P) / LG_WOBA;                          // odds-ratio (unbiased form)
    const exp = base / (base + ((1 - B) * (1 - P)) / (1 - LG_WOBA));
    return { g: clamp01((exp - 0.255) / (0.375 - 0.255)), exp, B, P };
  }

  // Pitcher goodness 0..1 from the opponent-offense z-score (continuous, NOT the ordinal rank - this is
  // what kills the "bunched middle" colour distortion). z = +ve means a strong offense (tough = red = low
  // g); z = -ve means a weak offense (easy = green = high g). Clamped to ±2 SD per the methodology review.
  function pitcherZG(z) {
    const C = 2;
    return clamp01((C - clamp(z, -C, C)) / (2 * C));
  }

  // Matchup tooltip shared by the symbol + its async refinement.
  function muTitle(label, m, hand) {
    return `Matchup: ${label} - exp wOBA ${BV.dec3(m.exp)} (bat ${BV.dec3(m.B)} vs ${hand}HP, opp xwOBA ${BV.dec3(m.P)})`;
  }

  // Build the team+last-name index from the hand index, so ESPN's last-name-only probable pitcher
  // ("(Drohan)") resolves within the opponent team. First record wins on the rare same-team collision.
  function buildHandByTeamLast(hand) {
    const m = {};
    for (const k in (hand || {})) {
      const rec = hand[k];
      if (!rec || !rec.team) continue;
      const last = k.split(' ').pop();
      if (last && !(`${rec.team}|${last}` in m)) m[`${rec.team}|${last}`] = { throws: rec.throws, k };
    }
    return m;
  }

  function teamIdFromAbbr(abbr, teamAbbr) {
    if (!abbr || !teamAbbr) return null;
    const a = abbr.toUpperCase();
    return teamAbbr[a] || teamAbbr[ESPN_ABBR_ALIAS[a]] || null;
  }
  // ESPN's opponent abbrev. Prefer the team link's href (clean, e.g. ".../name/CIN") so the away "@" in
  // the visible "@CIN" doesn't break the lookup; fall back to the abbrev text with non-letters stripped.
  function oppAbbrFromRow(tr) {
    const a = tr.querySelector('.opp a[href*="/name/"]');
    const m = a && (a.getAttribute('href') || '').match(/\/name\/([a-z]+)/i);
    if (m) return m[1].toUpperCase();
    const el = tr.querySelector('.opp .pro-team-abbrev');
    return el ? (el.textContent || '').replace(/[^a-z]/gi, '').toUpperCase() : '';
  }
  // The probable-pitcher anchor in the `.game-status` cell ("(Drohan)").
  function pitcherAnchor(gs) { return gs.querySelector('.truncate a') || gs.querySelector('a:last-child'); }
  // Its last name ("(Drohan)" / "(Drohan • L)" -> "drohan"); strips the "• L" hand we may have inserted.
  function pitcherLastFromGs(gs) {
    const a = pitcherAnchor(gs);
    const m = (a && a.textContent || '').match(/\(([^)]+)\)/);
    if (!m) return '';
    return BV.normName(m[1].replace(/\s*[•·]\s*[LRS]\s*$/i, '')).split(' ').pop() || '';
  }
  // Whether a pitcher row gets a matchup grade. SPs only on their start day (ESPN's "PP" probable badge);
  // relievers/closers always. A SP+RP-eligible arm that's ALSO on Pitcher List's SP "The List" is treated
  // as a starter (not a closer), so it needs the PP badge too.
  function pitcherShowsMatchup(tr, plRec) {
    const ind = tr.querySelector('.player-column__athlete .playerinfo__start-indicator');
    if (ind && /\bPP\b/i.test(ind.textContent || '')) return true;
    const posEl = tr.querySelector('.playerinfo__playerpos');
    const pos = posEl ? (posEl.textContent || '').toUpperCase() : '';
    const isSP = /\bSP\b/.test(pos), isRP = /\bRP\b/.test(pos);
    const onStarterList = !!(plRec && plRec.sp != null);
    if (isSP && (!isRP || onStarterList)) return false;       // pure SP, or a SP+RP who's really a starter
    return true;                                               // RP/closer or swingman -> any day
  }

  // The OPP cell's inline wrapper, made an inline-flex so our matchup mark middle-aligns with the abbrev.
  function oppHost(tr) {
    const opp = tr.querySelector('.opp');
    if (!opp) return null;
    const host = opp.querySelector('div') || opp;
    host.style.display = 'inline-flex';
    host.style.alignItems = 'center';
    host.style.gap = '5px';
    return host;
  }

  // Render the matchup for one roster row (guarded by a signature so it rebuilds only when the player or
  // the opponent/probable changes). The guard + our spans live on the <tr>; both the batter symbol and the
  // pitcher rank render in the OPP cell (the opposing pitcher's hand goes in the STATUS cell's parens).
  // Batter splits arrive async, so those cells are queued.
  function decorateMatchup(tr, kind, p, indexes, needSplits) {
    const gs = tr.querySelector('.game-status');
    if (!gs) return;
    const oppAbbr = oppAbbrFromRow(tr);
    const want = BV.normName(p.name);
    const plRec = (indexes.pl || {})[want];
    const pitcherLast = kind === 'bat' ? pitcherLastFromGs(gs) : '';
    const pitShow = kind === 'pit' ? pitcherShowsMatchup(tr, plRec) : false;
    const sig = `${want}|${kind}|${oppAbbr}|${pitcherLast}|${pitShow ? 1 : 0}`;
    if (tr.dataset.savantMuFor === sig) return;                 // already current
    tr.querySelectorAll('.savant-mu').forEach(e => e.remove());
    tr.dataset.savantMuFor = sig;

    const oppTeamId = teamIdFromAbbr(oppAbbr, indexes.teamAbbr);
    if (kind === 'bat') {
      const entry = (oppTeamId && pitcherLast) ? HAND_BY_TEAM_LAST[`${oppTeamId}|${pitcherLast}`] : null;
      const oppHand = entry && entry.throws;                   // 'L' / 'R'
      if (!oppHand) return;
      setOppHandInParens(gs, oppHand);                         // "(Drohan)" -> "(Drohan • L)" in STATUS
      const hRec = indexes.hand[want] || {};
      const batId = hRec.id, bats = hRec.bats;
      const batRec = (indexes.bat[want] || [])[0];            // batter's overall wOBA lives here
      const pitRec = entry ? (indexes.pit[entry.k] || [])[0] : null;   // opposing starter's xwOBA allowed
      // Render immediately with the league platoon (no split needed); refine once the batter's split loads.
      const splits = batId ? SPLITS[batId] : null;
      const span = renderOppSymbol(tr, batterMatchupG(splits, oppHand, pitRec, batRec, bats), oppHand);
      if (span && batId && !splits) needSplits.push({ id: batId, span, oppHand, pitRec, batRec, bats });
    } else {
      if (!pitShow) return;                                    // SP only on its start day; RP/closers always
      const off = (oppTeamId && indexes.teamOff) ? indexes.teamOff[oppTeamId] : null;
      const meta = indexes.teamOffMeta;
      if (!off || !meta || !(meta.sd > 0)) return;
      // Fold in TODAY's park: the game is at the HOME team's park (the rostered pitcher's own park when
      // home, the opponent's when away - read off ESPN's "@" prefix). Multiply the opponent's park-neutral
      // wOBA by the day's park multiplier, then re-z against the league to drive the colour. The 1-30 LABEL
      // stays the season talent rank (OPRK convention); only the colour reflects the park.
      const pitTeamId = (indexes.hand[want] || {}).team;
      const homeTeamId = isRowAway(tr) ? oppTeamId : pitTeamId;
      const homeOff = homeTeamId && indexes.teamOff[homeTeamId];
      const todayPf = homeOff ? homeOff.pf : 100;
      const adjWoba = off.nwoba * BV.parkWobaMult(todayPf);
      const adjZ = (adjWoba - meta.mean) / meta.sd;
      renderOppRank(tr, off.rank, pitcherZG(adjZ), oppRankTitle(off, meta, todayPf, adjZ));
    }
  }

  // Pitcher matchup tooltip: the season talent rank (label) + the park-adjusted read (colour). Concise -
  // "#rank/30 (1 = toughest) · wOBA · [park] · read (z)". The park term shows only when it's not neutral.
  function oppRankTitle(off, meta, pf, adjZ) {
    const park = pf !== 100 ? ` · park ×${BV.parkWobaMult(pf).toFixed(2)}` : '';
    const read = adjZ >= 0.5 ? 'tough' : adjZ <= -0.5 ? 'soft' : 'average';
    return `Opp offense #${off.rank}/${meta.total} (1 = toughest) · wOBA ${BV.dec3(off.nwoba)}`
         + `${park} · ${read} (z ${adjZ >= 0 ? '+' : ''}${adjZ.toFixed(1)})`;
  }
  // Is the rostered player AWAY today? ESPN shows the opponent as "@CIN" (away) vs "CIN" (home) in .opp.
  function isRowAway(tr) {
    const opp = tr.querySelector('.opp');
    return !!opp && /@/.test(opp.textContent || '');
  }

  // Insert the opposing pitcher's hand inside ESPN's "(name)" -> "(name • L)" (the bullet keeps the L/R
  // from looking like a last initial). Marked for teardown; skipped if a hand is already present.
  function setOppHandInParens(gs, hand) {
    const a = pitcherAnchor(gs);
    if (!a) return;
    const t = a.textContent || '';
    if (/\([^)]*[•·]\s*[LRS]\)/.test(t)) return;               // already has a hand
    const next = t.replace(/\(\s*([^)]*?)\s*\)/, `($1 • ${hand})`);
    if (next !== t) { a.textContent = next; a.classList.add('savant-oppl'); }
  }

  // Batter matchup symbol (▲▲ … ▼▼) in the OPP cell, right after the team abbrev (e.g. "MIL ▲"). Returns
  // the span so the async splits refinement can update it in place.
  function renderOppSymbol(tr, m, hand) {
    if (!m) return null;
    const host = oppHost(tr);
    if (!host) return null;
    const s = matchupSymbol(m.g);
    const span = document.createElement('span');
    span.className = 'savant-mu savant-mu-sym';
    span.textContent = s.sym;
    span.style.color = s.color;
    span.title = muTitle(s.label, m, hand);
    host.appendChild(span);
    return span;
  }

  // Pitcher opponent-offense rank, as a small badge in the OPP cell right after the team abbrev ("MIL 24").
  function renderOppRank(tr, rank, g, title) {
    const host = oppHost(tr);
    if (!host) return;
    const color = matchupColorFromG(g);
    const span = document.createElement('span');
    span.className = 'savant-mu savant-oprk';
    span.textContent = String(rank);
    span.style.color = color;
    span.style.background = color.replace('rgb(', 'rgba(').replace(')', ',0.18)');
    span.title = title;
    host.appendChild(span);
  }

  // Batch-fetch the queued batter splits from the SW, then fill (or drop) the placeholders.
  async function fillSplits(needSplits) {
    const ids = [...new Set(needSplits.map(n => n.id))];
    let resp;
    try { resp = await sendMessage({ type: 'GET_SPLITS', ids }); }
    catch (_) { return; }
    if (!resp || !resp.ok || !resp.splits) return;
    for (const id in resp.splits) if (resp.splits[id]) SPLITS[id] = resp.splits[id];   // cache real recs only
    for (const n of needSplits) {
      if (!n.span || !n.span.isConnected) continue;
      const m = batterMatchupG(SPLITS[n.id] || null, n.oppHand, n.pitRec, n.batRec, n.bats);
      if (!m) continue;                                        // keep the league-platoon symbol we already drew
      const s = matchupSymbol(m.g);
      n.span.textContent = s.sym; n.span.style.color = s.color; n.span.title = muTitle(s.label, m, n.oppHand);
    }
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
    // Debug readout shows when the overlay is on and debug is enabled; hidden when the extension is
    // toggled off, and on FantasyCast (the list isn't scanned there).
    if (!ENABLED || !showDebug || /\/fantasycast/i.test(location.pathname)) { if (hudEl) hudEl.style.display = 'none'; return; }
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.id = 'savant-hud';
      document.body.appendChild(hudEl);
    }
    hudEl.style.display = '';
    let savant, api = '', pl = '', pct = '';
    if (STATS.error) {
      savant = `⚠ Savant: ${STATS.error}`;
    } else if (STATS.loaded == null) {
      savant = 'Loading…';
    } else {
      savant = `Savant: ${STATS.loaded.bat} hitters · ${STATS.loaded.pit} pitchers · matched ${STATS.matched}/${STATS.found} rows`;
      if (STATS.found === 0) savant += ' · ⚠ no player rows (selector?)';
      api = `MLB API: ${STATS.loaded.hand} handedness found`;
      const spLabel = BV.spSourceCfg(STATS.loaded.plSpSrc || BV.CONFIG.spSourceDefault).label;
      pl = `Ranks: ${STATS.loaded.plSp || 0} SP (${spLabel}) · ${STATS.loaded.plRp || 0} closers · ${STATS.loaded.plHit || 0} batters (Pitcher List)`;
      pct = `Savant percentiles: ${STATS.loaded.pctBat || 0} batters · ${STATS.loaded.pctPit || 0} pitchers`;
    }
    hudEl.innerHTML = `<div>${savant}</div>` + (api ? `<div>${api}</div>` : '') + (pl ? `<div>${pl}</div>` : '') + (pct ? `<div>${pct}</div>` : '');
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
      const obj = await chrome.storage.sync.get([BV.STORAGE.prefs, BV.STORAGE.plPrefs, BV.STORAGE.debug, BV.STORAGE.enabled]);
      PREFS = mergePrefs(obj[BV.STORAGE.prefs]);
      PL_PREFS = BV.mergePlPrefs(obj[BV.STORAGE.plPrefs]);
      prevShowSig = showSig(PREFS);
      prevHandSig = handSig(PREFS);
      showDebug = obj[BV.STORAGE.debug] === true;
      ENABLED = obj[BV.STORAGE.enabled] !== false;     // default on (absent / true), off only if explicitly false
    } catch (_) { /* defaults already set */ }
  }

  // Clear the injected list columns so the next scan re-injects the current visible set. Scoped to the
  // roster lists (the modal's Advanced table / sliders reflect Show on next open - re-running
  // decorateModal on an already-decorated modal would corrupt ESPN's one-shot OPS/QS relabels).
  function clearInjectedColumns() {
    for (const block of document.querySelectorAll('.ResponsiveTable--fixed-left')) {
      block.querySelectorAll('.savant-col, .savant-col-th, .savant-adv-group').forEach(el => el.remove());
      block.querySelectorAll('[data-savant-name]').forEach(el => { delete el.dataset.savantName; });
    }
  }

  // Clear the per-row hand/PL guard so the next scan rebuilds handedness + the PL badge (both live in the
  // same guarded block) under the current handedness + Pitcher List toggles.
  function clearHandMarkers() {
    document.querySelectorAll('[data-savant-hand-for]').forEach(el => { delete el.dataset.savantHandFor; });
  }

  // ---------------------------------------------------------------------------
  // Master on/off teardown - undo every DOM change in place so flipping the switch
  // takes effect live (no page reload). The inverse of one scan(): remove the cells
  // and spans we injected, un-hide ESPN columns we collapsed, and clear the shading
  // we painted onto ESPN's own OPS/ERA/WHIP cells. We also drop our per-row markers
  // so a later re-enable re-decorates from a clean slate. The open player-card modal
  // keeps its FLAG (so we don't re-run the one-shot relabels on it); it self-heals
  // when reopened. After teardown, stop() disconnects the observer so we do NO further
  // work while off - off is strictly lighter than on, not heavier.
  // ---------------------------------------------------------------------------
  function teardown() {
    document.querySelectorAll('.savant-col, .savant-col-th, .savant-adv-group, .savant-hand, .savant-pl, .savant-adv, .savant-sliders, .savant-mu')
      .forEach(el => el.remove());
    document.querySelectorAll('.savant-hidden').forEach(el => el.classList.remove('savant-hidden'));
    for (const td of document.querySelectorAll('td[data-savant-key]')) {     // ESPN's own shaded cells
      clearShade(td);                                                        // inline bg + bubble class/props
      delete td.dataset.savantKey;
      delete td.dataset.savantVal;
    }
    document.querySelectorAll('[data-savant-name]').forEach(el => { delete el.dataset.savantName; });
    document.querySelectorAll('[data-savant-hand-for]').forEach(el => { delete el.dataset.savantHandFor; });
    document.querySelectorAll('[data-savant-mu-for]').forEach(el => { delete el.dataset.savantMuFor; });
    document.querySelectorAll('a.savant-oppl').forEach(a => {                 // revert "(Drohan • L)" -> "(Drohan)"
      a.textContent = (a.textContent || '').replace(/\(\s*([^)]*?)\s*[•·]\s*[LRS]\)/, '($1)');
      a.classList.remove('savant-oppl');
    });
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
      if (changes[BV.STORAGE.enabled]) {                          // master switch flipped (popup or icon menu)
        ENABLED = changes[BV.STORAGE.enabled].newValue !== false;
        if (ENABLED) start(); else stop();
        return;                                                   // start()/stop() handle the rest
      }
      if (changes[BV.STORAGE.prefs]) {
        PREFS = mergePrefs(changes[BV.STORAGE.prefs].newValue);
        const cSig = showSig(PREFS), hSig = handSig(PREFS);
        const colsChanged = cSig !== prevShowSig, handChanged = hSig !== prevHandSig;
        prevShowSig = cSig; prevHandSig = hSig;
        if (colsChanged || handChanged) {        // a Show / Handedness toggle changed -> re-inject
          if (colsChanged) clearInjectedColumns();
          if (handChanged) clearHandMarkers();
          if (INDEXES) scan(INDEXES);
        } else {
          recolorAll();                          // just a Highlight/threshold tweak
        }
      }
      if (changes[BV.STORAGE.plPrefs]) {          // PL display toggles -> rebuild the inline badges
        PL_PREFS = BV.mergePlPrefs(changes[BV.STORAGE.plPrefs].newValue);
        clearHandMarkers();
        if (INDEXES) scan(INDEXES);
      }
      if (changes[BV.STORAGE.debug]) { showDebug = changes[BV.STORAGE.debug].newValue === true; updateHud(); }
    } else if (area === 'local') {
      const ch = changes[BV.STORAGE.cacheKey(BV.CONFIG.year)];
      if (ch && ch.newValue && ch.newValue.indexes && INDEXES) {  // guard: only react after initial load
        INDEXES = ch.newValue.indexes;
        HAND_BY_TEAM_LAST = buildHandByTeamLast(INDEXES.hand);
        const plv = Object.values(INDEXES.pl || {});
        const pctIdx = INDEXES.pct || {};
        STATS.loaded = {
          bat: BV.countIndex(INDEXES.bat), pit: BV.countIndex(INDEXES.pit),
          pctBat: BV.countIndex(pctIdx.bat), pctPit: BV.countIndex(pctIdx.pit),
          hand: Object.keys(INDEXES.hand || {}).length,
          plSp: plv.filter(v => v && v.sp != null).length, plRp: plv.filter(v => v && v.rp != null).length,
          plHit: plv.filter(v => v && v.h != null).length,
          plSpSrc: (plv.find(v => v && v.sp != null && v.spSrc) || {}).spSrc || BV.CONFIG.spSourceDefault,
        };
        clearHandMarkers();                    // force decorateBlock to rebuild badges (new SP source/abbr)
        scan(INDEXES);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Start / stop - the overlay's lifecycle, gated by the master switch. start() is
  // the boot path (fetch the index, first scan, begin observing); it's idempotent
  // (a live re-enable just re-runs it). stop() disconnects the observer and tears
  // the overlay down. When off we never call getIndex(), so the service worker is
  // never woken and nothing is fetched.
  // ---------------------------------------------------------------------------
  async function start() {
    if (mo) return;                                              // already running
    STATS.error = null;
    updateHud();
    try {
      const resp = await getIndex();
      if (!resp || !resp.ok) throw new Error(resp && resp.error ? resp.error : 'no response from background');
      INDEXES = resp.indexes;
      HAND_BY_TEAM_LAST = buildHandByTeamLast(INDEXES.hand);      // for resolving opposing probable pitchers
      STATS.loaded = resp.counts;
      scan(INDEXES);                                              // first scan runs with mo still null
      mo = new MutationObserver(() => scheduleScan(INDEXES));
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (err) {
      STATS.error = err.message;
      updateHud();
      console.error('[Barrel Vision]', err);
    }
  }

  function stop() {
    if (mo) { mo.disconnect(); mo = null; }
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    teardown();
    updateHud();                                                  // hides the HUD (ENABLED is false)
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  (async () => {
    await loadState();
    if (ENABLED) start(); else updateHud();                      // off: do nothing (no fetch, no observer)
  })();
})();
