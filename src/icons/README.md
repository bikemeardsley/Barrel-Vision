# Icons

The manifest ships toolbar/store icons (concept: a bat barrel squaring up a baseball,
over the red/blue stat bar). Chrome does not accept SVG for action icons, so four PNGs
are shipped and referenced from `manifest.json`:

- `icon16.png`  (16×16)
- `icon32.png`  (32×32)
- `icon48.png`  (48×48)
- `icon128.png` (128×128)

`icon-source.svg` is the 128×128 vector source — edit it and re-export the PNGs if the
mark ever changes.

Both the top-level `"icons"` block and `"action".default_icon` in `manifest.json` point at
these four files:

```json
"icons": {
  "16": "icons/icon16.png",
  "32": "icons/icon32.png",
  "48": "icons/icon48.png",
  "128": "icons/icon128.png"
},
```

```json
"action": {
  "default_popup": "popup.html",
  "default_title": "Barrel Vision - thresholds & data",
  "default_icon": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

Design note: the overlay's accent is `#d62e2e` (the "hot"/red shade), echoed in the stat
bar at the bottom of the mark.
