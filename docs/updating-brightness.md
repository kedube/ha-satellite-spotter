# Updating the brightness table

`custom_components/satellite_spotter/brightness.csv` says how bright each satellite is. Most of its
values come from the satellite list of Mini-MegaTORTORA (MMT-9), used with its team's permission.

## The weekly update

The **Brightness** workflow (`.github/workflows/brightness.yml`) runs every Wednesday. It downloads
MMT's list and what it needs from CelesTrak, updates the table, and proposes the result in a pull
request, which it keeps up to date until you merge or close it. A week with nothing new proposes
nothing.

To review one, read the summary in the pull request, then approve its CI and HACS runs from the
banner in the merge box and wait for them to pass. GitHub holds them because the workflow's own
token opened the pull request. Merged without approval, the two runs show as failed in the Actions
tab with no jobs: nothing was tested, and CI runs on main after the merge as usual.

A normal result adds a few objects and loses few or none:

```
1 objects added, 0 gone.
12 values changed, the largest by 0.31.
custom_components/satellite_spotter/brightness.csv: 723 objects, {'family': 43, 'mccants': 97, 'mmt': 554, 'override': 1, 'score': 28}
```

Merging releases nothing: the table reaches people with the next release (`scripts/release.py`
explains releases).

The workflow needs **Allow GitHub Actions to create and approve pull requests** turned on in the
repository's settings, under Actions, General. If a run fails, the table is left as it was and next
week's run tries again, or you can run it from the Actions tab. Please keep it weekly: that is what
MMT's team agreed to, and their server is not a strong one.

## How long a table lasts

There is no hurry to merge. A list misses what has been launched since it was saved, so a table ages
slowly at first:

| Age of the list | Sightings lost |
|---:|---:|
| 4 months | none |
| 6 months | 1.4% |
| 9 months | 3.7% |
| 12 months | 18% |
| 24 months | 29% |

That is from one simulated five-day window at eight places, so treat it as a guide. A single bright
new launch is a good reason to update sooner.

## Updating by hand

The same update, for when you want one sooner. Python's standard library and `curl` are enough to run
the command.

1. From the repository's folder, run:

   ```bash
   python3 -I scripts/make_brightness_table.py --update --download-mmt
   ```

2. Read the summary it prints, as above.
3. Run the tests, then commit and release as usual:

   ```bash
   pytest tests/test_brightness_table.py tests/test_celestrak.py
   ```

MMT's server only answers scripts that send a referer, which keeps scrapers out. Its team gave us the
one the script sends. To save the list yourself, select **Download list of satellites** on
<http://mmt.favor2.info/satellites> in a browser, or run the command below, then pass the file to the
update with `--mmt satellites_list.txt` in place of `--download-mmt`.

```bash
curl --referer http://mmt.favor2.info -o satellites_list.txt http://mmt.favor2.info/satellites/download
```

### What the update changes

The command downloads the orbit lists the integration uses and CelesTrak's catalogue. A Home
Assistant on the same connection may then be refused its next download of those lists, and it tries
again by itself two hours later.

| Object | What happens |
|---|---|
| On MMT's list | Takes the list's value |
| Has a value added by hand | Keeps it |
| BlueWalker or SpaceMobile with an observed value | Keeps it, because MMT has seen them too little |
| From McCants, SCORE or Stellarium | Keeps its value, because those sources are not read again |
| Launched since the last update or in the 30 days before it, not on the list | Takes the median of its family on the list, if there is one |
| New, with no value and no family | Left out until a full rebuild |
| CelesTrak no longer has an orbit for it | Removed, because the integration could not use it |

Debris never takes a family's value, and a value added to `scripts/brightness_overrides.csv` only
takes effect at a full rebuild.

### If it stops

The table is left as it was in each of these cases.

| Message | What to do |
|---|---|
| `Stopped, and the table is unchanged: no list from MMT` | MMT's server did not answer, or refused. Try again later. If it keeps answering 403, ask its team whether the referer has changed |
| `Stopped, and the table is unchanged`, with a 403 | CelesTrak refuses repeat downloads. Wait two hours and try again |
| `Stopped, and the table is unchanged`, for another reason | Check the network connection and that `curl` is installed |
| `This is not MMT's satellite list` | The wrong file, or an error page saved by the browser. Download it again |
| `Stopped: only N objects` | The result would lose over half the table, so something is wrong with the list or the download. Do not force it |
| `Stopped: N of M values would move` | Over a quarter of the table's values would move by more than a magnitude, so the list is more likely wrong than new. Look at it before going any further |

If nothing has changed, the command says so and leaves the file alone, including its date.

## A full rebuild

This reads every source again. It is worth doing about once a year, or when a new object has a value
in McCants's list or SCORE but not in MMT's. Keep the files in a folder outside the repository: SCORE's
raw file names observers and where they stood.

| Source | Where to get it | File to pass |
|---|---|---|
| MMT's list | As above | `satellites_list.txt` |
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

MMT's team gave permission by email in November 2026, including for a script to fetch the list about
once a week. They ask for attribution and these citations, which the table's header and the README
both carry in full:

- Karpov et al. 2016, "Massive photometry of low-altitude artificial satellites on
  Mini-Mega-TORTORA", Revista Mexicana de Astronomía y Astrofísica (Serie de Conferencias) Vol. 48,
  pp. 112-113, for the database.
- Beskin et al. 2017, "Wide-field optical monitoring with Mini-MegaTORTORA (MMT-9) multichannel high
  temporal resolution telescope", Astrophysical Bulletin, Volume 72, Issue 1, pp. 81-92, for the
  telescope.

The integration's attribution names Mini-MegaTORTORA and Karpov et al. 2016. The script writes the
table's header, and tests check all three, so keep them when changing any of this.
