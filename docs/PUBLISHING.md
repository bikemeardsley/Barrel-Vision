# Publishing Barrel Vision

How to get the extension off "Load unpacked" and into the stores. Edge is the primary target (you use
Edge), Chrome is the secondary one (bigger audience for the portfolio piece). **The same zip works for
both stores.**

---

## 0. Prerequisites (do once, before any store)

- [ ] **Icons — HARD BLOCKER.** Stores require them; the manifest currently ships none. Add
      `icon16/32/48/128.png` to `src/icons/` and the two manifest blocks per
      [`src/icons/README.md`](../src/icons/README.md). (Claude can generate clean placeholder PNGs via
      PowerShell `System.Drawing` if you want to unblock now and swap in a designed mark later.)
- [ ] **Bump to `1.0.0`** in `src/manifest.json` for the first public release (conventional; store
      versions must only ever increase).
- [ ] **Privacy policy URL.** [`PRIVACY.md`](../PRIVACY.md) is in the repo; both stores want a public
      URL. Easiest: enable GitHub Pages, or just link the raw file
      `https://github.com/bikemeardsley/Barrel-Vision/blob/main/PRIVACY.md`.
- [ ] **Listing copy.** Short description (≤132 chars) + a longer one (the README intro works), a
      category (Sports / Productivity), and the support email.
- [ ] **Screenshots.** 1280×800 or 640×400 PNG/JPG. Grab 2–3: columns on a roster, the player-card
      Advanced Stats table, the popup. (Chrome also wants a 440×280 small promo tile; optional but nice.)

---

## 1. Package the extension

Zip the **contents of `src/`** so `manifest.json` sits at the zip root (NOT the repo root).

```powershell
pwsh scripts/package.ps1        # writes barrel-vision-<version>.zip at the repo root
```

`*.zip` is gitignored, so the package never gets committed. Sanity-check: open the zip — the first
entry should be `manifest.json`, not a `src/` folder.

---

## 2. Microsoft Edge Add-ons (primary — free)

1. Go to **Microsoft Partner Center** → register for the **Edge program** (free, no fee).
   <https://partner.microsoft.com/dashboard/microsoftedge>
2. **Create new extension** → upload `barrel-vision-<version>.zip`.
3. Fill the **Properties** (category, privacy policy URL, this is not a paid extension).
4. **Store listing**: description, screenshots, logo (the 128px icon).
5. **Availability**: public, or **hidden/unlisted** if you only want to share the link (good for a
   portfolio demo without a fully public listing).
6. Submit. Review is typically a few business days.

> Edge also lets users install Chrome Web Store extensions via "Allow extensions from other stores," so
> publishing only to Chrome (step 3) still works for Edge users — but a native Edge listing is cleaner.

---

## 3. Chrome Web Store (secondary — $5 one-time)

1. Go to the **Chrome Web Store Developer Dashboard**, pay the **one-time $5** registration fee.
   <https://chrome.google.com/webstore/devconsole>
2. **Add new item** → upload the same zip.
3. **Store listing**: description, category, screenshots, promo tile.
4. **Privacy practices** tab (Chrome is strict here):
   - Single purpose: *"Overlay Baseball Savant contact-quality metrics onto ESPN Fantasy Baseball."*
   - Permission justifications: see §5.
   - Data usage: **does not collect or transmit user data** (only local cache + prefs).
   - Privacy policy URL.
5. **Visibility**: Public / Unlisted / Private (specific testers).
6. Submit. Review is usually hours-to-days; the narrow host permissions keep it light.

---

## 4. Versioning & release hygiene

- Store versions must strictly increase (`1.0.0` → `1.0.1` → …). Bump `manifest.json` every submission.
- Tag releases in git to match: `git tag v1.0.0 && git push --tags`.
- Keep the changelog in [`PROJECT_BARREL_VISION.md`](PROJECT_BARREL_VISION.md) §15 in sync.

---

## 5. Review gotchas (pre-empted)

| Reviewer concern | Our status |
|---|---|
| **Single purpose** (Chrome) | One clear job: Savant metrics on ESPN. ✓ |
| **Permission justification** | `storage` = cache fetched stats + save thresholds. `host_permissions` (baseballsavant, statsapi) = fetch the public CSV/JSON the overlay displays. No espn.com host permission. ✓ |
| **Remote code** (both ban it) | None — all JS is in the package; nothing is `eval`'d or fetched-and-run. ✓ |
| **Data collection** | None transmitted; cache + prefs are local (`chrome.storage`). ✓ |
| **Trademarks** (ESPN / MLB / Savant) | Used descriptively ("for ESPN Fantasy Baseball", "Baseball Savant data"); the listing/README carry a "not affiliated with ESPN or MLB" disclaimer. Keep the icon original (no ESPN/MLB logos). ✓ |
| **Minimum functionality** | Substantive feature set (columns, shading, modal, handedness, QS). ✓ |

---

## 6. After approval

- Add store badges/links to [`README.md`](../README.md).
- For a resume/portfolio: the Edge or Chrome listing URL is the demoable artifact; link it from the
  personal site alongside the repo.

---

## TL;DR

1. Add icons → bump to 1.0.0 → host `PRIVACY.md`.
2. `pwsh scripts/package.ps1`.
3. Upload the zip to **Edge Add-ons** (free) and/or **Chrome Web Store** ($5).
4. Fill listing + permission justifications + privacy → submit → wait for review.
