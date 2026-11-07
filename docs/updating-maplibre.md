# Updating MapLibre

[MapLibre GL JS](https://maplibre.org) draws the globe and the 3D street view. A copy ships with the
integration, in `custom_components/satellite_spotter/frontend/vendor/maplibre-gl-<version>/`.
Dependabot cannot see that folder, so it is updated by hand.

New versions come out about once a week, so there is no need to take each one. Every few months is
plenty, or sooner when [the release notes](https://github.com/maplibre/maplibre-gl-js/releases) show a
fix that matters here.

## 1. Read what changed

Read the notes of every version since the one in use. These parts matter most:

| In the notes | Why it matters here |
|---|---|
| The files the package ships | `sat-maplibre.js` loads them, and step 2 copies them |
| Custom layers or shaders | The orbit lines and satellites (`sat-space.js`) and the trees and street lights (`sat-street-props.js`) are custom layers |
| The camera, terrain or `jumpTo` | The 3D street view puts the camera at eye level, which MapLibre was not designed for (`sat-street-scene.js`) |
| The globe's size or reach near the poles | The zoom math in `sat-globe.js` mirrors it |
| The wording of its controls | `MAPLIBRE_TEXT` in `sat-maplibre.js` translates them, and a new text stays in English until it is added there |

The 3D street view also uses MapLibre's private code, which the notes do not cover:
`overrideNearFarZ`, `map._camera`, `_requestedCameraState` and `transform.worldSize`. Step 3 checks
those.

## 2. Replace the files

With the development environment active (see Development in the README), run this from the
repository's folder, with the version you want:

```bash
VERSION=6.16.0
VENDOR=custom_components/satellite_spotter/frontend/vendor
WORK=$(mktemp -d)
npm pack --ignore-scripts --pack-destination "$WORK" "maplibre-gl@$VERSION"
tar -xzf "$WORK/maplibre-gl-$VERSION.tgz" -C "$WORK"
rm -r "$VENDOR"/maplibre-gl-*
python -I - "$WORK/package" "$VENDOR/maplibre-gl-$VERSION" <<'EOF'
import gzip
from pathlib import Path
import re
import shutil
import sys

import brotli

package, out = map(Path, sys.argv[1:])
out.mkdir()
shutil.copy(package / "LICENSE.txt", out)
for name in ("maplibre-gl.mjs", "maplibre-gl-worker.mjs", "maplibre-gl.css"):
    data = re.sub(rb"//# sourceMappingURL=\S+\s*$", b"", (package / "dist" / name).read_bytes())
    (out / name).write_bytes(data)
    (out / f"{name}.gz").write_bytes(gzip.compress(data, 9, mtime=0))
    (out / f"{name}.br").write_bytes(brotli.compress(data, quality=11))
EOF
```

That does the following:

- `npm pack` checks the download against the hash the registry gives.
- Only these files are kept. The package's empty `maplibre-gl-shared.mjs` is left out, because MapLibre
  keeps it only for older copy steps.
- The last line of each script, a pointer to its source map, goes because the maps are not shipped.
- The `.gz` and `.br` copies are what Home Assistant sends to browsers that accept them.

Then edit `frontend/sat-maplibre.js`:

1. Change the folder in `MAPLIBRE_DIR`. This is the one place that names the version, and the tests read
   it from there.
2. Update the sizes in the comment at the top of the file, if they have moved much.

Browsers may keep these files for a month, because the folder's name carries the version. So never
change a file in that folder without renaming the folder.

## 3. Check it

```bash
pytest tests/test_frontend_files.py tests/test_frontend_setup.py
node --test "tests/js/*.test.mjs"
node tests/browser/run.mjs
```

Only the last command runs the real library, as the others use a stand-in for it. It takes about two
minutes and needs Chrome. It opens the real views with made-up tiles, and nothing leaves the machine.
When it fails, this is where to start:

| Check that fails | What it means | Where to look |
|---|---|---|
| `none of the integration's files is missing`, or `MapLibre's worker read the map's tiles` | The package's files have changed | Step 2, and what `sat-maplibre.js` loads |
| `the private near and far planes hold`, or `and outlast a move of the camera` | `overrideNearFarZ` has changed. Without it, hills beyond about 18 km are cut off | `overrideFarPlane` in `sat-street-scene.js` |
| `the camera is at the eye`, or `the sky stays on the map` | The camera's math has changed, so the sky no longer lines up with the buildings | `eyeCamera` in `sat-street-scene.js`, and `makeProjector` in `sat-planetarium.js` |
| `the trees' layer can read the size of the world` | `transform.worldSize` has moved | `PropsLayer` in `sat-street-props.js` |
| `the northern limb glows`, or `the southern limb glows` | The light's frame has changed, so the atmosphere glows on the wrong side | `sunLight` in `sat-globe.js` |
| `which grows no further there`, or `as the zoom limit of a camera following it assumes` | The globe's size near the poles has changed | `_trackZoomLimit` in `sat-globe.js` |
| `a tile fails` | How MapLibre asks again for a failed picture has changed. Naming one in `refreshTiles` makes it draw nothing, and it is checked through the private `style.tileManagers` | `_refreshFailedTiles` in `sat-globe.js` |
| `fullscreen` | The fullscreen control's own handling has changed, as a map built again has to take over from the last one | `_createMap` in `sat-globe.js` |

Then look for yourself, because tests cannot judge how it looks. In Home Assistant, open the panel and
check:

- The globe by day and by night, with its orbit line and satellites.
- **Follow the satellite** and **Fly along with the satellite**.
- The street view's **3D model**, by day and by night, with its buildings and trees.

## 4. Finish

Add a line to `CHANGELOG.md` saying what people get from the new version, and whether the download has
grown much. Commit and release as usual.

The license comes along as `LICENSE.txt`. If it is ever no longer BSD-3-Clause, update the credit in the
README and `engine` in `sat-street.js`.
