# Updating the brightness table

`custom_components/satellite_spotter/brightness.csv` says how bright each satellite is. Most of its
values come from the satellite list of Mini-MegaTORTORA (MMT-9). That list has to be downloaded by
hand, so the table needs updating by hand too.

## How often

About every four months. A list misses what has been launched since it was saved, so it ages slowly
at first:

| Age of the list | Sightings lost |
|---:|---:|
| 4 months | none |
| 6 months | 1.4% |
| 9 months | 3.7% |
| 12 months | 18% |
| 24 months | 29% |

That is from one simulated five-day window at eight places, so treat it as a guide. A single bright
new launch is a good reason to update sooner.

## The usual update

You only need MMT's list. Python's standard library and `curl` are enough to run the command.

1. Open <http://mmt.favor2.info/satellites> in your browser and select **Download list of
   satellites**. Do this by hand: the site's `robots.txt` asks automated tools to stay away.
2. From the repository's folder, run:

   ```bash
   python3 -I scripts/make_brightness_table.py --update --mmt ~/Downloads/satellites_list.txt
   ```

3. Read the summary it prints. A normal result adds a few objects and loses few or none:

   ```
   1 objects added, 0 gone.
   .../brightness.csv: 723 objects, {'family': 43, 'mccants': 97, 'mmt': 554, 'override': 1, 'score': 28}
   ```

4. Run the tests, then commit and release as usual (`scripts/release.py` explains releases):

   ```bash
   pytest tests/test_brightness_table.py tests/test_celestrak.py
   ```

### What the update changes

The command downloads CelesTrak's catalogue and the orbit lists the integration uses. It never
contacts MMT. A Home Assistant on the same connection may then be refused its next download of those
lists, and it tries again by itself two hours later.

| Object | What happens |
|---|---|
| On MMT's list | Takes the list's value |
| Has a value added by hand | Keeps it |
| BlueWalker or SpaceMobile with an observed value | Keeps it, because MMT has seen them too little |
| From McCants, SCORE or Stellarium | Keeps its value, because those sources are not read again |
| Launched since the last build, not on the list | Takes the median of its family on the list, if there is one |
| New, with no value and no family | Left out until a full rebuild |
| CelesTrak no longer has an orbit for it | Removed, because the integration could not use it |

Debris never takes a family's value, and a value added to `scripts/brightness_overrides.csv` only
takes effect at a full rebuild.

### If it stops

The table is left as it was in each of these cases.

| Message | What to do |
|---|---|
| `Stopped, and the table is unchanged`, with a 403 | CelesTrak refuses repeat downloads. Wait two hours and try again |
| `Stopped, and the table is unchanged`, for another reason | Check the network connection and that `curl` is installed |
| `This is not MMT's satellite list` | The wrong file, or an error page saved by the browser. Download it again |
| `Stopped: only N objects` | The result would lose over half the table, so something is wrong with the list or the download. Do not force it |

## A full rebuild

This reads every source again. It is worth doing about once a year, or when a new object has a value
in McCants's list or SCORE but not in MMT's. Keep the files in a folder outside the repository: SCORE's
raw file names observers and where they stood.

| Source | Where to get it | File to pass |
|---|---|---|
| MMT's list | By hand, as above | `satellites_list.txt` |
| Mike McCants's list | <https://www.mmccants.org/programs/qsmag.zip> | `quicksat.mag`, inside the zip |
| SCORE observations | The all-observations download on <https://score.cps.iau.org> | `satellite_observations_all.csv`, inside the zip |
| Stellarium's list | <https://raw.githubusercontent.com/Stellarium/stellarium/master/plugins/Satellites/resources/satellites.json> | `satellites.json` |
| GCAT | <https://planet4589.org/space/gcat/tsv/cat/satcat.tsv> and <https://planet4589.org/space/gcat/tsv/cat/satcat100k.tsv> | `satcat.tsv` and `satcat100k.tsv` |
| CelesTrak's catalogue | <https://celestrak.org/pub/satcat.csv> | `satcat.csv` |
| CelesTrak's orbit lists | See below | `visual.csv`, `rocket_bodies.csv` and `active.csv` |

Download everything but MMT's list and SCORE's zip like this. CelesTrak refuses a repeat of the same
request within two hours, so run this once:

```bash
curl -O https://www.mmccants.org/programs/qsmag.zip && unzip qsmag.zip
curl -O https://raw.githubusercontent.com/Stellarium/stellarium/master/plugins/Satellites/resources/satellites.json
curl -O https://planet4589.org/space/gcat/tsv/cat/satcat.tsv
curl -O https://planet4589.org/space/gcat/tsv/cat/satcat100k.tsv
curl -O https://celestrak.org/pub/satcat.csv
GP=https://celestrak.org/NORAD/elements/gp.php
curl -o visual.csv "$GP?GROUP=visual&FORMAT=csv"
curl -o rocket_bodies.csv "$GP?NAME=R/B&FORMAT=csv"
curl -o active.csv "$GP?GROUP=active&FORMAT=csv"
```

The orbit lists must match `QUERIES` in `celestrak.py`, and the tests check that the script's copy of
those queries still does. Then run this from the repository's folder, with `$SRC` as the folder that
holds the files:

```bash
python3 -I scripts/make_brightness_table.py \
    --mmt "$SRC/satellites_list.txt" \
    --qsmag "$SRC/quicksat.mag" \
    --score "$SRC/satellite_observations_all.csv" \
    --stellarium "$SRC/satellites.json" \
    --gcat "$SRC/satcat.tsv" --gcat "$SRC/satcat100k.tsv" \
    --satcat "$SRC/satcat.csv" \
    --elements "$SRC/visual.csv" \
    --elements "$SRC/rocket_bodies.csv" \
    --elements "$SRC/active.csv"
```

The top of `scripts/make_brightness_table.py` explains the order in which the sources are used.

## Credit

The table's header, the README and the integration's attribution all carry the citation MMT asks for
(Karpov et al. 2016) and its acknowledgement (Mini-MegaTORTORA belongs to Kazan Federal University).
The script writes the table's header, and a test checks it, so keep them when changing any of this.
