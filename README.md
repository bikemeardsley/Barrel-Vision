# Barrel Vision

A Chrome/Edge extension that puts **Baseball Savant contact-quality metrics right on your ESPN Fantasy
Baseball pages** — inline with ESPN's own stats, on roster/list views and in the player card. No more
tab-switching to Savant to read a player.

---

## What it looks like

Savant's advanced columns land next to ESPN's own stats, with the numbers tinted so the read is instant —
**red = better than your threshold, blue = worse,** stronger tint = further from it. Each player also picks
up handedness, weekly top-list ranks, and a day-of matchup rating (▲▲…▼▼).

![Barrel Vision advanced columns on an ESPN batters roster, with red/blue threshold tinting, handedness, and matchup symbols](docs/images/roster.png)

Pitchers get their own column set — xERA, ERAgap, **K% / BB% / K−BB%**, and opponent contact quality — with
the matchup symbol appearing on a starter's game day.

![Barrel Vision pitcher columns on an ESPN pitchers roster](docs/images/roster-pitchers.png)

Open a player card and the same metrics appear as a native-looking **Advanced Stats** table, plus a
collapsible **Savant percentile sliders** panel (the real value at each percentile, like Savant's own page)
and a link to the player's Savant page — for batters and pitchers alike.

![Barrel Vision Advanced Stats table and Savant percentile sliders in the ESPN player card, for a batter and a pitcher](docs/images/modal.png)

Everything is controlled from the **toolbar popup**: per-column **Show** and **Highlight** toggles with
your own thresholds, a master on/off switch, and the weekly rank settings. Changes apply live — no reload.

<p align="center">
  <img src="docs/images/popup.png" width="360" alt="Barrel Vision toolbar popup with per-column Show/Highlight toggles and thresholds">
</p>

---

## What it shows

**Batters** — barrel%, hard-hit%, xwOBA, the xwOBA−wOBA **gap**, avg EV, bat speed, squared-up%.
**Pitchers** — xERA, the ERA−xERA **gap**, **K% / BB% / K−BB%**, opponent xwOBA / barrel% / hard-hit%.

On top of the columns it also:

- **Tints ESPN's own OPS, ERA, and WHIP** with the same threshold colouring.
- Adds **batting/throwing handedness** next to each player ("Milwaukee Brewers • Righty").
- Adds **day-of matchup ratings** in the opponent column — a ▲▲…▼▼ symbol (green = good matchup, red =
  tough) from the batter's platoon edge vs the listed starter, or the park-adjusted opponent offense for
  pitchers.
- Shows **weekly top-list ranks** beside each player (e.g. "• PL #4"). Starting-pitcher ranks come from
  your choice of **Pitcher List, Razzball, or RotoBaller**; closer and hitter ranks come from Pitcher List.
- In the player card, condenses ESPN's columns (OBP+SLG → **OPS**, W+L → **QS**, computed as the true
  season Quality Starts), and adds the **Advanced Stats** table and **percentile sliders**.
- Can be turned **off entirely** from the popup switch or a right-click on the toolbar icon — the overlay
  disappears live and nothing is fetched while it's off.

Players are matched by name, so there's no setup. Unmatched players just show blank cells.

---

## Install

1. Download or clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the **`src/`** folder.
4. Open a `fantasy.espn.com/baseball/…` roster — the metric columns appear next to ESPN's stats. Set your
   thresholds from the toolbar popup.

---

## Privacy

Barrel Vision only reads player names from the page and fetches **public** baseball data (Baseball Savant,
the MLB StatsAPI, and the weekly rank sites). It has **no host access to ESPN**, no analytics, no remote
code, and no backend — nothing from your ESPN session is read or sent anywhere. Full details in
[PRIVACY.md](PRIVACY.md).

---

## License

[MIT](LICENSE) © Mike Beardsley. Not affiliated with ESPN, MLB, Pitcher List, Razzball, or RotoBaller.
"Baseball Savant" and "Statcast" are properties of MLB Advanced Media.
