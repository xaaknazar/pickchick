# Static restaurant map - 12 October 2026

Map for «Наши рестораны» (M05) in the owner-approved redesign
(`docs/design/mobile-redesign-2026-10-12/README.md`, section 2). By the owner's
decision there is no map SDK yet: the screen shows this static image and draws
the restaurant pin on top of it in React Native.

- `abay-plaza.webp`: 1179×960 px, i.e. 393×320 pt @3x, lossy WebP (~50 KB).
  Centred on Abay Plaza `43.226274, 76.860865` (coordinates from the 2GIS card,
  also stored in `config/restaurant-locations.json`); the restaurant sits at
  196.5×158 pt so the pin stays clear of the controls and the sheet.
- `abay-plaza.json`: generation metadata. `originWorldPixel`, `zoom` and
  `pointsPerTilePixel` let `apps/mobile/src/restaurant-map.ts` project any
  configured restaurant onto the image (also after `contentFit="cover"`).
- `pin-logo-closed.png`: greyscale copy of the supplied logo
  (`design/prototype/assets/mockup/logo.png`) for a closed restaurant's pin.
  The open pin uses the original logo.

## Source and licence

Map data © OpenStreetMap contributors, available under the Open Database
Licence (ODbL, https://www.openstreetmap.org/copyright). The image is derived
from the standard OpenStreetMap raster tiles (tile.openstreetmap.org, zoom 16,
a dozen tiles requested once on 12 October 2026 with a descriptive User-Agent
and cached locally, per the OSMF tile usage policy). The tiles were stitched,
cropped, scaled 1.83× and recoloured from luma onto the app's navy palette
(`#04143A`-`#123068`, light labels); the top 90 pt fade into `#04143A` under
the status bar and map controls, as in the approved mockup.

The app must keep the visible «© OpenStreetMap» attribution on the map
(bottom-left, linked to the copyright page). Do not reuse the image without it.

## Re-generate

```sh
python3 scripts/mobile/render-static-map.py           # needs Pillow and network
python3 scripts/mobile/render-static-map.py --offline # reuse cached tiles only
```

Options: `--lat/--lon`, `--zoom`, `--anchor-y`, `--points-per-tile-pixel`,
`--quality`, `--cache` (default `~/.cache/pickchick-osm-tiles`). Keep the tile
count small and never script bulk downloads from tile.openstreetmap.org.
Check `tests/mobile/restaurant-map.test.mjs` and the M05 screenshots after a
re-run. A future map SDK (2GIS MapGL or `react-native-maps`) replaces this
folder; that choice is still open with the owner.
