/*
 * Barrel Vision - unit tests for the pure shared helpers (src/shared/core.js).
 * ---------------------------------------------------------------------------
 * The extension is buildless and has no runtime dependencies; this is a tiny
 * dependency-free harness over the one file that holds pure, context-independent
 * logic. Run with:  npm test   (i.e. `node --test tests/`)
 *
 * The point is to LOCK the counterintuitive bits the project doc warns must never
 * get "corrected":
 *   - the xwOBA-wOBA Gap is DERIVED as est_woba - woba (the published column is the
 *     opposite sign) - so the Gap must come out POSITIVE for an underperformer;
 *   - the ERA gap is era - xera (positive = unlucky = buy);
 *   - team wOBA uses real linear weights with uBB = BB - IBB and SF+HBP in the
 *     denominator (not OPS, not a naive "4 bases per HR");
 *   - the park-neutral / shading / name-join math.
 * core.js attaches its API to module.exports (CommonJS) OR globalThis (browser); we
 * accept either so the same file powers the worker, content script, popup AND this test.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const loaded = require('../src/shared/core.js');
const BV = loaded.BV || globalThis.BV;

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} not within ${eps} of ${b}`);

// Resolve a column's derive fn by key (the sign-quirk logic lives on the column, not the BV root).
const col = (kind, key) => BV.CONFIG.columns[kind].find(c => c.key === key);

// ---------------------------------------------------------------------------
test('normName - the ESPN<->Savant join key', async (t) => {
  await t.test('strips accents', () => {
    assert.equal(BV.normName('José Ramírez'), 'jose ramirez');
    assert.equal(BV.normName('Teóscar Hernández'), 'teoscar hernandez');
  });
  await t.test('strips suffixes (jr/sr/ii/iii/iv/v)', () => {
    assert.equal(BV.normName('Vladimir Guerrero Jr.'), 'vladimir guerrero');
    assert.equal(BV.normName('Cal Ripken Jr'), 'cal ripken');
    assert.equal(BV.normName('Ken Griffey III'), 'ken griffey');   // iii must win over the ii alternative
  });
  await t.test('does NOT strip a suffix token embedded in a real name (word boundary)', () => {
    assert.equal(BV.normName('Ivan Herrera'), 'ivan herrera');     // "iv" inside "Ivan" must survive
    assert.equal(BV.normName('Vinnie Pasquantino'), 'vinnie pasquantino');
  });
  await t.test('drops punctuation and collapses whitespace', () => {
    assert.equal(BV.normName("Logan O'Hoppe"), 'logan o hoppe');
    assert.equal(BV.normName('J.T. Realmuto'), 'j t realmuto');
    assert.equal(BV.normName('  Mike   Trout  '), 'mike trout');
  });
  await t.test('empty / nullish input is the empty string (never throws)', () => {
    assert.equal(BV.normName(null), '');
    assert.equal(BV.normName(undefined), '');
    assert.equal(BV.normName(''), '');
  });
});

// ---------------------------------------------------------------------------
test('cellSignal - the shading primitive (signed distance from threshold)', async (t) => {
  const high = { barrel: { enabled: true, threshold: 8, dir: 'high', scale: 6 } };
  const low = { oxwoba: { enabled: true, threshold: 0.310, dir: 'low', scale: 0.060 } };

  await t.test('returns null when shading is off / impossible', () => {
    assert.equal(BV.cellSignal({}, 'barrel', 14), null);                                   // no pref
    assert.equal(BV.cellSignal({ barrel: { enabled: false, threshold: 8, dir: 'high', scale: 6 } }, 'barrel', 14), null);
    assert.equal(BV.cellSignal({ barrel: { enabled: true, threshold: null, dir: 'high', scale: 6 } }, 'barrel', 14), null);
    assert.equal(BV.cellSignal(high, 'barrel', NaN), null);                                // non-finite value
    assert.equal(BV.cellSignal(high, 'barrel', 8), null);                                  // exactly at threshold -> t===0
  });
  await t.test('high-dir: above threshold is "better" (red), below is worse (blue)', () => {
    const a = BV.cellSignal(high, 'barrel', 14); near(a.t, 1); assert.equal(a.better, true);   // +6/6 = 1
    const b = BV.cellSignal(high, 'barrel', 11); near(b.t, 0.5); assert.equal(b.better, true);
    const c = BV.cellSignal(high, 'barrel', 5); near(c.t, -0.5); assert.equal(c.better, false);
    assert.equal(BV.cellSignal(high, 'barrel', 100).t, 1);                                 // clamped to +1
    assert.equal(BV.cellSignal(high, 'barrel', -100).t, -1);                               // clamped to -1
  });
  await t.test('low-dir: the sign is flipped so lower = "better"', () => {
    const good = BV.cellSignal(low, 'oxwoba', 0.250); near(good.t, 1); assert.equal(good.better, true);
    const bad = BV.cellSignal(low, 'oxwoba', 0.370); near(bad.t, -1); assert.equal(bad.better, false);
  });
});

// ---------------------------------------------------------------------------
test('Gap = est_woba - woba (DERIVED; published column is the opposite sign)', async (t) => {
  const gap = col('bat', 'gap');
  await t.test('the doc tell: Wood woba .400 / est_woba .433 -> Gap is POSITIVE +.033', () => {
    const v = gap.derive({ est_woba: '0.433', woba: '0.400' });
    assert.ok(v > 0, 'underperformer Gap must be positive (buy-low), not the published woba-est sign');
    near(v, 0.033, 1e-9);
    assert.equal(gap.fmt(v), '+.033');
  });
  await t.test('falls back to xwoba when est_woba is absent', () => {
    near(gap.derive({ xwoba: '0.433', woba: '0.400' }), 0.033, 1e-9);
  });
  await t.test('gap3 formats sign + drops the leading zero, with a unicode minus', () => {
    assert.equal(BV.gap3(0.033), '+.033');
    assert.equal(BV.gap3(-0.033), '−.033');   // U+2212, not ASCII '-'
    assert.equal(BV.gap3(0), '+.000');
    assert.equal(BV.gap3('x'), '');
  });
});

// ---------------------------------------------------------------------------
test('ERA gap = era - xera (positive = unlucky = buy)', async (t) => {
  const eragap = col('pit', 'eragap');
  await t.test('the doc tell: Alcantara era 4.18 / xera 3.85 -> +0.33', () => {
    const v = eragap.derive({ era: '4.18', xera: '3.85' });
    near(v, 0.33, 1e-9);
    assert.equal(eragap.fmt(v), '+0.33');
  });
  await t.test('gapEra keeps two decimals and a unicode minus', () => {
    assert.equal(BV.gapEra(-0.33), '−0.33');
    assert.equal(BV.gapEra(0), '+0.00');
  });
});

// ---------------------------------------------------------------------------
test('teamWoba - real linear weights, uBB = BB - IBB, den = AB + uBB + SF + HBP', async (t) => {
  await t.test('NaN guards', () => {
    assert.ok(Number.isNaN(BV.teamWoba(null)));
    assert.ok(Number.isNaN(BV.teamWoba({})));                                  // den 0 -> NaN
    assert.ok(Number.isNaN(BV.teamWoba({ atBats: 0, hits: 0 })));
  });
  await t.test('concrete value (computed by hand with the weights in core.js)', () => {
    // ab5000 bb500 ibb30 hbp50 h1300 2b260 3b20 hr200 sf40
    //   1B = 1300-260-20-200 = 820 ; uBB = 470 ; den = 5000+500-30+40+50 = 5560
    //   num = .690*470 + .722*50 + .884*820 + 1.257*260 + 1.593*20 + 2.058*200 = 1855.56
    //   wOBA = 1855.56 / 5560 = 0.333734   (update this number only if WOBA_WEIGHTS changes)
    const stat = { atBats: 5000, baseOnBalls: 500, intentionalWalks: 30, hitByPitch: 50,
      hits: 1300, doubles: 260, triples: 20, homeRuns: 200, sacFlies: 40 };
    near(BV.teamWoba(stat), 0.333734, 1e-5);
  });
  await t.test('accepts string components (StatsAPI sometimes serializes numbers as strings)', () => {
    const a = BV.teamWoba({ atBats: 400, baseOnBalls: 100, hits: 100 });
    const b = BV.teamWoba({ atBats: '400', baseOnBalls: '100', hits: '100' });
    near(a, b, 1e-12);
  });
  await t.test('IBB is subtracted from the walks (numerator AND denominator)', () => {
    const base = { atBats: 400, baseOnBalls: 100, hits: 100 };               // 100 singles, 100 walks
    const allIntentional = { ...base, intentionalWalks: 100 };               // uBB now 0
    assert.ok(BV.teamWoba(base) > BV.teamWoba(allIntentional));
  });
  await t.test('more home runs -> higher wOBA (weights are ordered correctly)', () => {
    const few = { atBats: 500, hits: 120, homeRuns: 10 };
    const many = { atBats: 500, hits: 120, homeRuns: 40 };
    assert.ok(BV.teamWoba(many) > BV.teamWoba(few));
  });
});

// ---------------------------------------------------------------------------
test('park factors - parkWobaMult / parkNeutralizeWoba', async (t) => {
  await t.test('neutral park (100) is the identity', () => {
    near(BV.parkWobaMult(100), 1);
    near(BV.parkNeutralizeWoba(0.320, 100), 0.320);
  });
  await t.test('an unknown/non-finite park factor defaults to neutral', () => {
    near(BV.parkWobaMult(undefined), 1);
    near(BV.parkWobaMult(NaN), 1);
  });
  await t.test('wOBA is half as park-elastic as runs (the .5 damping)', () => {
    near(BV.parkWobaMult(112), 1.06);    // 1 + (1.12-1)*0.5
    near(BV.parkWobaMult(96), 0.98);
  });
  await t.test('neutralizing a hitter park lowers the line; a pitcher park raises it', () => {
    near(BV.parkNeutralizeWoba(0.340, 112), 0.340 / 1.03, 1e-12);     // Coors -> lower true talent
    assert.ok(BV.parkNeutralizeWoba(0.340, 112) < 0.340);
    assert.ok(BV.parkNeutralizeWoba(0.340, 96) > 0.340);             // pitcher park -> higher true talent
  });
});

// ---------------------------------------------------------------------------
test('pitchRates - K% / BB% from the StatsAPI season line', async (t) => {
  await t.test('null when there are no batters faced (a rate on nothing is meaningless)', () => {
    assert.equal(BV.pitchRates(null), null);
    assert.equal(BV.pitchRates({ strikeOuts: 5, baseOnBalls: 2, battersFaced: 0 }), null);
    assert.equal(BV.pitchRates({ strikeOuts: 5, baseOnBalls: 2 }), null);
  });
  await t.test('Misiorowski 2026: 138 K / 23 BB / 353 TBF -> 39.1% / 6.5%', () => {
    const r = BV.pitchRates({ strikeOuts: 138, baseOnBalls: 23, battersFaced: 353 });
    near(r.kPct, 39.0934844, 1e-4);
    near(r.bbPct, 6.5155807, 1e-4);
  });
  await t.test('accepts string components', () => {
    const r = BV.pitchRates({ strikeOuts: '138', baseOnBalls: '23', battersFaced: '353' });
    near(r.kPct, 39.0934844, 1e-4);
  });
  await t.test('K-BB% column derives kPct - bbPct', () => {
    const kbb = col('pit', 'kbb');
    near(kbb.derive({ kPct: 39.0934844, bbPct: 6.5155807 }), 32.5779, 1e-3);
    assert.equal(kbb.fmt(kbb.derive({ kPct: 28.5, bbPct: 6.5 })), '22.0%');
  });
});

// ---------------------------------------------------------------------------
test('mergePrefs - adopts user fields (threshold/enabled/show); scale & dir always from defaults', async (t) => {
  await t.test('a saved scale/dir is IGNORED so default shading-tuning reaches existing users', () => {
    // The popup persists the whole pref object, so a returning user could carry a stale scale; the merge
    // must drop it (this is what makes a default scale change - e.g. the K% vividness fix - actually land).
    const merged = BV.mergePrefs({ kpct: { scale: 999, dir: 'low', threshold: 30, enabled: false, show: false } });
    const def = BV.defaultPrefs().kpct;
    assert.equal(merged.kpct.scale, def.scale);   // default scale, NOT 999
    assert.equal(merged.kpct.dir, def.dir);       // default dir, NOT 'low'
    assert.equal(merged.kpct.threshold, 30);      // user threshold adopted
    assert.equal(merged.kpct.enabled, false);     // user highlight adopted
    assert.equal(merged.kpct.show, false);        // user show adopted
  });
  await t.test('keys absent from saved keep their defaults (new columns appear for existing users)', () => {
    const merged = BV.mergePrefs({ barrel: { threshold: 10 } });
    assert.deepEqual(merged.kpct, BV.defaultPrefs().kpct);   // untouched
    assert.equal(merged.barrel.threshold, 10);
  });
  await t.test('nullish / non-object saved is safe and returns clean defaults', () => {
    assert.deepEqual(BV.mergePrefs(null), BV.defaultPrefs());
    assert.deepEqual(BV.mergePrefs({ barrel: null }), BV.defaultPrefs());
  });
});
