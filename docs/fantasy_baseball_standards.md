# Fantasy Baseball Standards & Strategy Guide
## League: Pitch Clock Strikeouts | Team: Pocket Pancakes
**Last Updated:** June 7, 2026

---

## 1. HITTER EVALUATION FRAMEWORKS

There are two distinct approaches for evaluating hitters depending on the goal. Both use Statcast data but answer different questions.

### 1A. ANCHOR IDENTIFICATION — "Who are the best players to build around?"

**Purpose:** Identify elite, proven hitters worth paying up for in auction or protecting in trades. These are roster cornerstones — high-floor, high-ceiling players who anchor multiple hitting categories.

**What to look for:**
- **Multi-category contributors** — Players who impact 3+ of R/HR/RBI/SB/OPS simultaneously. Witt Jr. (5-cat), Vlad (R/HR/RBI/OPS), Rooker (HR/RBI/OPS) were all anchors for this reason.
- **Elite Statcast percentile rankings** — 80th+ percentile in exit velocity, barrel rate, and xwOBA confirms the production is skill-based, not luck-driven.
- **Consistent track record** — Minimum 2 seasons of above-average production (wRC+ 115+), or 1 elite season (wRC+ 130+) backed by underlying Statcast metrics that support sustainability.
- **Lineup and team context** — Batting 2-5 in a productive lineup multiplies R and RBI value. A great hitter on a bad team loses category juice.

**Draft application:** Stars & scrubs means paying $35-50 for 2-3 of these guys. Don't try to Barrel Hunt your anchors — pay market price for proven elite talent and find edges everywhere else.

### 1B. BARREL HUNTING — "Who is undervalued relative to their contact quality?"

**Purpose:** Find hitters whose Statcast contact quality metrics significantly outpace projection system outputs, signaling regression upside the market hasn't priced in. This is where you find $1-7 draft steals and waiver wire gems.

**Primary Metrics (in priority order):**
1. **xwOBA vs. wOBA gap** — The single best indicator of batted ball luck. A positive gap (xwOBA > wOBA) suggests underperformance relative to contact quality. **A gap is a screen, not a verdict — always run it through the Gap Validation Layer below before acting.**
2. **Barrel Rate (Barrel%)** — Minimum threshold: 8%+ with upside targets at 12%+. Measures frequency of ideal exit velocity + launch angle combinations.
3. **Exit Velocity (EV90 preferred over avg EV)** — 90th percentile exit velocity is more stable year-to-year than max EV and better predicts power output.
4. **Process+ (NBC Sports)** — Composite score normalizing contact quality. 110+ is above average, 120+ is elite.
5. **Hard Hit Rate (HH%)** — Secondary/confirming metric. 40%+ is good, 45%+ is elite.

**What Barrel Hunting is NOT:**
- Chasing hot starts or 1-game box scores (a 2-HR Opening Day is noise, not signal)
- Ignoring plate discipline — chase rate is a critical filter (see Section 2)
- Blindly trusting one data source — cross-reference minimum of 3 sources before committing
- A substitute for anchor identification — Barrel Hunting fills around the anchors, it doesn't replace them

### Year-Over-Year Trend Validation

Always compare a player's current Statcast profile against their prior season before committing. A single-season snapshot can be misleading — a player whose barrel rate dropped significantly year-over-year (e.g., Ramos: 14.5% → 8.8%) is a caution flag even if the current number still meets the minimum 8% threshold. Declining contact quality suggests a mechanical or approach change that may not reverse. Pre-draft source consensus ("all sources positive") must still be validated against raw Statcast year-over-year trends. If barrel rate, HH%, or xwOBA have declined meaningfully from the prior year, downgrade from BUY to MONITOR regardless of what consensus rankings say.

### Gap Validation Layer — Decompose a Gap Before Acting On It

The xwOBA–wOBA gap is a **screen, not a verdict.** It tells you where to look; it does not tell you whether to act. A gap closes only to the degree it is *unexplained* — prior-year xwOBA predicts next-year wOBA at only ~.22 r² (barely better than prior-year wOBA itself), so regression is **never automatic.** Before treating a positive gap as a BUY (or a negative gap as a SELL), run it through these validators to determine whether the gap is **luck (reverts)** or **structure / a bad input (persists):**

1. **BABIP vs. career — the luck/structure test.** Positive gap + a *depressed* BABIP = real bad luck, reverts (true buy). Positive gap + a *career-normal* BABIP = the gap is structural and will not close. (Nimmo 2026 tell: BABIP near his career norm meant the low results weren't misfortune.)
2. **ISO and HR/FB vs. xSLG — the does-the-quality-convert test.** Barrels/EV up while ISO and HR/FB sit at career lows means the hard contact isn't producing extra-base hits — the *xwOBA itself* is overstating the player. Distrust the expected number, not the actual one.
3. **Bat speed + squared-up% — the is-the-spike-real test (best single addition).** A barrel/EV jump backed by *rising* bat speed is a genuine skill change. A barrel spike on flat-or-declining bat speed (especially age 32+) is variance that won't hold. (Caglianone's validated 2026 breakout came with a bat-speed jump; Nimmo's barrel spike did not.)
4. **maxEV — barrel quality, not just rate.** Very stable year-to-year; a maxEV decline flags that a surface barrel rate is fragile. Two equal barrel rates aren't equal if one's ceiling is 110 mph and the other's is 102.
5. **Pull-air% (pulled fly-ball rate) — the structural lever (generalizes the Paredes rule).** High pull-air% explains *permanent* negative gaps — those hitters beat xwOBA structurally, so do not sell them on the gap alone. Low pull-air% with a positive gap means the "expected" hits are going to catchable spots — do not buy the gap.

**Operating rule:** A positive gap is a BUY only when paired with (a) a BABIP depressed relative to career AND (b) intact-or-rising power signals (ISO, bat speed, maxEV). A positive gap with a *normal* BABIP and *sagging* power is a trap — the xwOBA is the unreliable number, not the wOBA. Judge a **near-zero gap** on the results themselves: it means the production is real, whether good (keep) or bad (fade the surface line). Watch out for the inverse case too — decent EV/barrel headline numbers paired with a *low* xwOBA (e.g., Massey 2026: 91 EV / 9.5% barrel but .285 xwOBA) signal a ground-ball-heavy profile where quality doesn't compound; that is not a Barrel Hunting buy.

---

## 2. PLATE DISCIPLINE FILTER (HITTERS)

**Why this matters:** Chase rate is one of the strongest indicators of offensive sustainability. A player with elite contact quality but terrible discipline is exploitable by good pitching (see: Canzone's 2025 postseason collapse when teams attacked his chase tendencies).

**Key Discipline Metrics:**
- **O-Swing% (Chase Rate):** League average ~30%. Above 35% = red flag. Above 40% = strong fade unless other metrics are overwhelming.
- **Z-Contact%:** League average ~82%. Below 78% = concern even with good power metrics.
- **Whiff Rate:** League average ~25%. Trending improvement year-over-year is a positive signal.
- **K%:** Context-dependent, but 25%+ requires barrel metrics to be truly elite to justify.

**Decision Framework:**
- Elite barrels + good discipline = **BUY** (e.g., Vaughn, Stewart)
- Elite barrels + bad discipline = **MONITOR** — only buy if discipline is trending better year-over-year
- Average barrels + good discipline = **HOLD** — useful but not a Barrel Hunting target
- Average barrels + bad discipline = **FADE**

---

## 3. PITCHING EVALUATION

Pitching evaluation uses fundamentally different data than hitting. The goal is identifying arms that will deliver Ks, QS, and strong ratios (ERA/WHIP) at a price the market undervalues.

### SP Evaluation Metrics (in priority order)
1. **Stuff+ / PLV (Pitcher List Value)** — Measures raw pitch quality independent of results. High Stuff+ with mediocre ERA suggests positive regression incoming.
2. **K rate (K/9 or K%)** — Direct driver of the K category. 25%+ K rate is the target for rotation-worthy arms.
3. **xERA / xFIP vs. ERA gap** — The pitching equivalent of the xwOBA gap. If xERA is significantly lower than ERA, the pitcher has been unlucky and is due for improvement.
4. **QS rate / Innings per start** — Measures durability and the ability to go 6+ IP. Pitchers averaging fewer than 5.5 IP/start are QS risks regardless of talent.
5. **WHIP components (BB rate + BABIP)** — Low walk rate (sub-7% BB%) is the most stable predictor of sustained WHIP quality. High BABIP with low xBA signals regression toward better results.
6. **Pitch mix and velocity trends** — New pitch additions (e.g., Nelson's cutter), velocity gains, or increased usage of a dominant secondary pitch signal breakout potential.

### RP/Closer Evaluation
- **Role certainty is king** — In saves-only leagues, a mediocre pitcher with a locked closer role beats a great pitcher in a committee. Verify roles via Pitcher List RP rankings before adding.
- **Save opportunity %** — Pitcher List assigns save chance percentages per team. Target closers with 60%+ of their team's save chances.
- **Team context** — Closers on good teams get more save opportunities. A closer on a 95-win team is worth more than a closer on a 70-win team.
- **Don't chase committee situations** — If a bullpen has multiple relievers splitting saves at 25-30% each, avoid unless one is clearly emerging.

### Pitching Sources
- **Pitcher List (The List + RP Rankings)** — Primary source for SP rankings and closer role confirmation
- **Baseball Savant** — Stuff+, pitch movement, velocity, spin rate data
- **FanGraphs** — xERA, xFIP, K-BB%, SIERA for regression analysis
- **Brooks Baseball / Pitch Info** — Pitch mix changes, velocity trends over time

---

## 4. DATA SOURCES — PRIORITY HIERARCHY

### Tier 1: Primary Decision Drivers
| Source | What We Use It For | URL |
|--------|-------------------|-----|
| **LeagueDon** | xwOBA gaps, wOBA projections, buy/sell signals, Field Notes | leaguedonation.com/field-notes |
| **Baseball Savant (Statcast)** | Barrel%, EV90, xwOBA, Hard Hit%, Stuff+, percentile rankings, bat speed, squared-up%, maxEV, pull% | baseballsavant.mlb.com |
| **Pitcher List** | SP rankings (The List), RP closer rankings, rotation confirmation | pitcherlist.com |

### Tier 2: Cross-Reference & Confirmation
| Source | What We Use It For |
|--------|-------------------|
| **FanGraphs** | Auction values, plate discipline stats (O-Swing%, Z-Contact%), projections (Steamer/ZiPS), xERA/xFIP, BABIP, ISO, HR/FB, RotoGraphs xwOBA gainers/decliners columns |
| **NBC Sports** | Process+ scores, hitter targets, SP rankings |
| **Gerbil Sports** | Sleeper identification, cheat sheet cross-reference |

### Tier 3: Situational Intelligence & Discovery
| Source | What We Use It For |
|--------|-------------------|
| **RotoBaller** | Best source for up-to-date situational information — pitcher injury updates, role changes, breakout candidate lists. Use as a discovery tool to generate names, then validate with Tier 1 hard data. Not a pure data source. |
| **Razzball** | Streaming recommendations, weekly matchup analysis |
| **Reddit (r/fantasybaseball)** | Sleeper thread consensus, community sentiment check |
| **Mr. Cheatsheet** | Auction value aggregation across experts |

**Rule:** Never make a roster move based on a single source. Minimum 2 Tier 1 sources or 1 Tier 1 + 2 Tier 2 sources must align before committing.

---

## 5. DRAFT RULES

### Auction Strategy: Stars & Scrubs
- Anchor the roster with 2-3 elite hitters ($35-50 range), fill everywhere else cheap ($1-7)
- **Budget buffer target:** End draft with $5-10 unspent, never more than $10
- **Spending power check:** After every 5 picks, calculate remaining budget minus remaining roster spots. If $15+ over plan, upgrade aggressively mid-draft (not late-draft).

### Hard Rules
1. **No two SPs from the same MLB team.** SP + RP from same team is OK.
2. **No drafting IL-starting players with expectations to contribute.** IL stashes are only acceptable as $1 end-of-draft fliers with known return timelines. Plan around healthy players; treat IL returns as bonus upside.
3. **Go cheap at C.** Catcher pool is historically deep. Don't overpay when $5-8 gets you 90% of the production of a $15+ catcher.
4. **3 closers for SV category.** Target $3-5 each. Consolidate down to 2 mid-season when roles clarify.
5. **All bench spots = hitters** with multi-position flexibility (covers off-days, injuries).
6. **Check ESPN positional eligibility** before every bid — ESPN only adds eligibility, never removes.

### Nomination Strategy
- **Early:** Nominate hype players / fan-favorite tax candidates as decoys to drain budgets
- **Mid:** Nominate big-name closers to force spending
- **Late:** Nominate your $1 targets when budgets are thin

---

## 6. IN-SEASON MANAGEMENT RULES

### Waiver Wire / FAAB
- **Total FAAB budget:** $50 for the season
- **Spending guidance:** Most adds should be $0 claims. Budget $1-3 for solid adds, $5-10 for high-impact pickups. $10+ is reserved for rare opportunities — use judgment based on player impact and league competition for the add.
- **Daily waivers at 11PM ET** — 4 adds per matchup max
- Use tiered waiver priority system (queue multiple moves in order of importance)

### IL Strategy
- IL slots are a **high-leverage roster construction tool**, not a last resort
- Stash elite players with known return timelines (e.g., Steele, Volpe in 2026)
- Keep at least 1 IL slot open for flexibility during the first month of the season
- When a stashed player returns, evaluate the weakest roster spot for the cut — don't force it

### Trade Principles
- **When the other manager initiates, you hold leverage** — don't over-concede
- Evaluate trades on category impact, not player-for-player name value
- **Trade deadline awareness:** Aug 3, 2026. Start exploring sell-high candidates by mid-July.

### Category Balance Monitoring
- Review category strengths and weaknesses weekly against the rest of the league
- Identify structural weak categories early and address through waiver adds, streaming, or trades
- Don't let one category drag the team while overperforming in others — H2H is about winning the most categories, not dominating a few
- Two SPs from the same MLB team is acceptable for bench/streaming arms (schedule correlation is manageable), but not for co-anchors

---

## 7. LESSONS LEARNED

### 2026 Draft
- Stars & scrubs works in a 10-team auction — the $1-5 player pool is deep enough to fill rosters
- Brewers tax and Twins tax are real but manageable — budget for slight inflation on players from popular teams in your league
- LeagueDon's xwOBA gap data was the most reliable signal for identifying undervalued hitters
- Murakami at $5 was a steal driven by NPB-to-MLB skepticism — international player transitions can create Barrel Hunting opportunities
- Drafting Adell at $5 didn't work out (not on final roster) — Barrel Hunting targets still need a clear path to playing time
- Machado upgrade plan worked — having pre-planned tiers of upgrades if budget allowed was key to staying disciplined mid-draft

### 2026 Early Season
- Don't panic-drop closers after one bad outing (Jax → Sewald swap may have been premature — Jax was ranked higher by Pitcher List at the time)
- Verify closer role status via Pitcher List RP rankings before making RP moves — not all "closers" on waivers are actually closing
- Opening Day stats are noise — 4 PA tells you nothing about a player's season-long value
- Steele IL stash over Burnes was the right call — shorter recovery timeline = sooner impact
- Ramos was a draft target based on pre-draft consensus but his barrel rate had declined from 14.5% to 8.8% year-over-year — a red flag we didn't catch until the in-season Statcast deep dive. Laureano (13.8% barrel, 49.1% HH%) was a clear upgrade available on waivers for $0. Lesson: always validate draft targets against year-over-year Statcast trends, not just source consensus.
- **The xwOBA–wOBA gap is a screen, not a verdict — validate it before acting (added Gap Validation Layer, Section 1B).** Nimmo (2026) showed a +.052 gap that was a mirage: the .375 xwOBA was inflated by a career-high barrel rate with no ISO/HR-FB support at age 33, sitting on a career-normal BABIP. The likely path was the xwOBA falling toward the wOBA, not the wOBA rising — i.e., regression pointing the *wrong* way. A persistent positive gap from a chronic underperformer is partly structural and won't fully close. Marsh was the better add (modest overperformance on legitimately good EV/HH = a real, if lower-ceiling, contributor). Dubón, Hamilton, and Massey all failed on the bat: Dubón and Hamilton carry ≈0 gaps confirming their below-average wOBAs are real (Hamilton's value is SB-only, which is not a team need), and Massey overperforms a low .285 xwOBA on a grounder-heavy profile.

---

## 8. CATEGORY SCORING REFERENCE

### Hitting (5 categories)
| Category | What Drives It | Roster Construction Note |
|----------|---------------|------------------------|
| R | Lineup position, OBP, team offense quality | Favors hitters on good teams batting 1-5 |
| HR | Raw power, barrel rate, launch angle | Core Barrel Hunting metric |
| RBI | Lineup position, team offense, RISP ability | Favors hitters batting 3-5 on good teams |
| SB | Sprint speed, green light, opportunity | Target 1-2 high-SB contributors, don't overpay. NOTE: SB is no longer the team's weakest category — do not default-weight waiver/trade decisions toward steals. |
| OPS | OBP + SLG combined | Barrel Hunting directly supports this |

### Pitching (5 categories)
| Category | What Drives It | Roster Construction Note |
|----------|---------------|------------------------|
| K | Strikeout rate, innings pitched | Address via SP selection if identified as a team weakness |
| QS | Durability, run prevention, going 6+ IP | Favors workhorses who consistently go deep into games |
| SV | Closer role, team win environment | 2-3 dedicated closers, don't chase committees |
| ERA | Run prevention, BABIP luck, HR/FB rate | Monitor xERA for regression signals |
| WHIP | BB rate, hit prevention | Pairs well with low-walk SP targets |

---

*This is a living document. Update after each season and during major in-season decision points.*
