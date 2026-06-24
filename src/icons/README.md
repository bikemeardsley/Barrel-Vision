# Icons

The manifest currently ships **without** an `icons` block, so Chrome shows its default
extension icon and the extension loads with no errors. (Referencing a PNG that doesn't
exist would make "Load unpacked" fail, so the keys are left out until the files are here.)

## To add the toolbar/store icon

1. Drop four PNGs in this folder (PNG only — Chrome does not accept SVG for action icons):

   - `icon16.png`  (16×16)
   - `icon32.png`  (32×32)
   - `icon48.png`  (48×48)
   - `icon128.png` (128×128)

2. Add these two blocks to `src/manifest.json`:

   ```json
   "icons": {
     "16": "icons/icon16.png",
     "32": "icons/icon32.png",
     "48": "icons/icon48.png",
     "128": "icons/icon128.png"
   },
   ```

   …and inside the existing `"action"` block:

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

Design note: the overlay's accent is `#d62e2e` (the "hot"/red shade). A simple barrel or
baseball mark on that red reads well at 16px.
