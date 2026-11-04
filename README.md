# Satellite Spotter for Home Assistant

[![GitHub release](https://img.shields.io/github/v/release/kedube/ha-satellite-spotter)](https://github.com/kedube/ha-satellite-spotter/releases)
![Home Assistant 2026.2+](https://img.shields.io/badge/Home%20Assistant-2026.2%2B-41BDF5.svg)

![The Satellite Spotter page: a bright pass of the ISS simulated over the night side of the Earth, with where to look and the passes of the next five days](docs/images/hero.jpg)

Know when to step outside and look up. Satellite Spotter predicts when satellites will be
**visible to the naked eye** from your home, and shows you where to look: on a 3D globe, on a
sky chart and from your own street.

It follows about 750 objects, including the International Space Station, Tiangong, Hubble, spent
rocket stages and trains of new Starlinks. Everything is worked out on your Home Assistant, five
days ahead, for each location you add.

## Features

- **Passes:** when, where to look, how high, how bright and how cloudy. Satellites crossing
  together count as one pass.
- **Sensors and a calendar** for automations, and a blueprint that notifies your phone before a
  pass.
- **A sidebar page** with the globe, pass simulations, a sky chart and the list of passes.
- **Street view:** the pass in a 360° photo of your street, darkened for the night, or in a 3D
  model of the neighbourhood, under the real stars. Buildings and trees hide the satellite where
  they really would.
- **Two dashboard cards:** the globe, and a lighter passes card that needs no 3D.
- **Nine languages:** English, Dutch, French, German, Italian, Polish, Brazilian Portuguese,
  Spanish and Swedish.

| Simulating a train of 22 Starlinks | The passes card |
|---|---|
| ![A Starlink train simulated on the globe](docs/images/simulation.jpg) | ![The passes card, counting down to the next pass and showing where to look during a pass](docs/images/passes-card.jpg) |
| **Street view from a photo** | **Street view from the 3D model** |
| ![A street photo in Amsterdam, darkened, with BlueWalker 3's path crossing behind a bare tree](docs/images/street-photo-amsterdam.jpg) | ![The ISS crossing the sky over a modelled street of houses, trees and street lights](docs/images/street-model.jpg) |

Street photo: Panoramax Test-NL (Amsterdam), CC BY-SA 4.0, from Panoramax. That screenshot is
under the same licence.

Only interested in the space station? [ISS Tracker](https://github.com/kedube/ha-iss-tracker) shows
its live position and its passes up to 30 days ahead, and can run alongside this.

## Install

You need Home Assistant 2026.2 or newer.

[![Open this repository in HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=kedube&repository=ha-satellite-spotter&category=integration)

1. Select the button above. Or, under **HACS → ⋮ → Custom repositories**, add
   `https://github.com/kedube/ha-satellite-spotter` with the type **Integration**.
2. Download **Satellite Spotter** and restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration → Satellite Spotter**.
4. Name the location, check it on the map and give its elevation; a rough value is fine. The name
   starts its entity ids: **Home** gives `sensor.home_next_pass`.

Use **Add location** for more places, such as a cabin; they share one catalogue download.
**Reconfigure** moves a location and keeps its entities.

To install without HACS, copy `custom_components/satellite_spotter` from the
[latest release](https://github.com/kedube/ha-satellite-spotter/releases/latest) into your
configuration's `custom_components` folder and restart. You won't get update notifications.

## Options

Select **Configure** on a location.

| Option | Default | What it does |
|---|---|---|
| Faintest magnitude | 3 | Lists only passes at least this bright, from -2 to 4. Lower numbers are brighter: 3 is about the faintest you can find from a suburb, and 1 keeps the easy ones. |
| Cloud cover forecast | On | Adds Open-Meteo's forecast to each pass. |
| Advance notice | 15 min | How long before a bright pass **Bright pass soon** turns on. |
| Show Satellite Spotter in the sidebar | On | Adds the page. The cards work either way. |
| Show the passes in the calendar | On | Adds the location's calendar. |
| Units | Automatic | Metric or imperial on the page and in the street view. |
| Photos from | Best available | Which service supplies street photos, or **No photos: the 3D model**. |
| Mapillary access token, Google Cloud API key | None | Add more street photos (see below). |

Street photos come from Panoramax with no key. Two services add more, though only administrators'
browsers receive their keys, so everyone else sees Panoramax's photos:

- **Mapillary** is free. Sign up at mapillary.com, then under **Dashboard → Developers** register
  an application and copy its **Client Token**.
- **Google Street View** needs a Google Cloud project with billing on and the **Map Tiles API**
  enabled, and Google charges beyond a free monthly allowance. Restrict the key to that API and to
  the addresses you open Home Assistant at.

## Entities

For a location named **Home**. In other languages, new entities take their ids from the translated
names.

| Entity | What it tells you |
|---|---|
| `sensor.home_next_pass` | When the next pass starts, or the one under way |
| `sensor.home_next_bright_pass` | The same for the next bright pass |
| `sensor.home_passes_next_24_hours` | How many passes are under way or start within a day; `passes` lists them |
| `binary_sensor.home_satellite_visible` | On during a pass |
| `binary_sensor.home_bright_pass_soon` | On from the advance notice until a bright pass ends |
| `calendar.home_satellite_passes` | Every pass for five days, with where to look |
| `sensor.home_catalog_updated` | When the catalogue was downloaded, and how old its orbits are |

The pass entities carry `satellite`, `norad_id`, `satellite_count`, `satellites`, `info_url`,
`pass_id`, `start`, `end`, `duration`, `brightest_time`, `magnitude`, `bright`, `before_sunset` and
`cloud_cover`, plus `_direction`, `_azimuth` and `_elevation` for `rise`, `brightest` and `set`.

## Notifications

[![Import the blueprint into your Home Assistant.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fkedube%2Fha-satellite-spotter%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fsatellite_spotter%2Fnotify_satellite_pass.yaml)

The blueprint notifies your phone before each pass in a location's calendar. By default it covers
bright passes only, ten minutes ahead, and skips skies more than 60% cloudy. Tapping the
notification opens the pass in the street view.

> **🛰️ ISS in 10 min**\
> At 20:31:02, look toward W: 21° above the horizon. Best view at 20:32:30: NW, 40° high, magnitude
> -2.5. Last visible at 20:34:55 toward NE, 10° high. Cloud cover near the pass: 12%.

For an automation of your own, use a calendar trigger, which fires for every pass:

```yaml
triggers:
  - trigger: calendar
    event: start
    offset: "-0:15:0"
    entity_id: calendar.home_satellite_passes
actions:
  - action: notify.mobile_app_your_phone
    data:
      title: "Pass in 15 minutes: {{ trigger.calendar_event.summary }}"
      message: "{{ trigger.calendar_event.description.split('\\n')[:-1] | join(' ') }}"
      data:
        # Opens the pass in the street view: url on iPhones, clickAction on Android.
        url: "/satellite-spotter?pass={{ trigger.calendar_event.uid }}&view=street"
        clickAction: "/satellite-spotter?pass={{ trigger.calendar_event.uid }}&view=street"
```

With several locations, add `&entry_id={{ config_entry_id('calendar.home_satellite_passes') }}` to
the links.

## Dashboard cards

Both are in the card picker, with visual editors.

- **Satellite globe** (`custom:satellite-spotter-card`): the page's globe, with the next pass and
  its countdown.
- **Satellite passes** (`custom:satellite-passes-card`): a countdown, a small sky chart and the
  next passes. It needs no 3D, so it suits wall tablets and old phones.

![The passes card and the globe card on a dashboard](docs/images/dashboard.jpg)

## How it works

1. **Catalogue.** Every 12 hours, once for all locations, the integration downloads orbital elements
   from CelesTrak (about 4.7 MB) and joins them with `brightness.csv`, a table that ships with it.
   It keeps objects that could reach magnitude 3 overhead. Starlinks are chosen by height instead:
   those below 350 km, which are new ones still climbing and old ones coming down.
2. **Position.** SGP4 places each satellite once a minute for five days, then second by second
   around anything that might be visible.
3. **Brightness.** Each satellite's magnitude at 1,000 km is adjusted for its distance, the angle
   between the Sun, the satellite and you, and the air in the way, which depends on your elevation.
   Starlinks use published models of their own.
4. **Visibility.** A satellite counts while it is at least 10° up, lit by the Sun, brighter than
   your **Faintest magnitude**, and bright enough for the sky at that moment.
5. **Passes.** Satellites that overlap or follow within a minute make one pass, and fewer than five
   Starlinks together are left out. A pass is **bright** when it beats magnitude 1, and the sky's
   limit by 3 magnitudes, after sunset.

Passes are predicted again every two hours. In between nothing polls: entities change at the
moments that matter.

### How far to trust it

- **Geometry** matches Skyfield with JPL's DE421 to within 0.005° on the sky and 0.04 km in
  distance, and the Sun to within 0.01°.
- **The method** follows See A Satellite Tonight. Given that site's catalogue and sea-level air,
  this code agreed with a Python port of it on 1,209 of 1,215 passes, over five days at nine places.
- **The list differs from that site's**, because the brightness values do. Over five days at eight
  cities it found 200 of the site's 357 passes outside Starlink trains, and 178 others: near the
  cutoff, a small difference decides whether a pass is listed. It listed all 36 of the site's
  bright passes, and labelled about seven in ten of them bright.
- **Starlink trains** matched in the next two days (3 of 3), but only 10 of 18 over five days,
  because their orbits change quickly.
- **Brightness is an estimate.** A satellite can look a magnitude or more brighter or fainter than
  predicted, and rocket stages flash as they tumble. The Moon and light pollution are not modelled.
- **Orbits drift** by seconds to minutes as elements age. The page marks a pass **Medium confidence**
  when its elements are more than 3 days from the pass, and **Low confidence** beyond a week.

## Privacy

Your coordinates and keys stay out of Home Assistant's log and diagnostics. Home Assistant makes the
first two requests below and fetches the place names. Your browser loads the rest while the page, a
card or the street view is open.

| What | Goes to | What it learns |
|---|---|---|
| Catalogue download | CelesTrak | Nothing about where you are |
| Cloud forecast (optional) | Open-Meteo | Each location's coordinates to about 10 m, every two hours |
| Globe imagery | NASA GIBS and EOX, or Esri if you choose it | The area on screen |
| Place names and street map | OpenStreetMap, through Home Assistant | The area on screen |
| 3D model | OpenFreeMap and Amazon Web Services, plus Esri for aerial photos | The area around your home |
| Street photos | Panoramax, plus Mapillary and Google if you add keys | Your home's position to about 10 m, which photo is shown and any key. Google also sees your Home Assistant's address |

## Troubleshooting

- **No passes.** Satellites show for a while after dusk and before dawn, when the Sun lights them but
  your sky is dark. Near midsummer, far from the equator, the sky barely darkens, so few are listed.
  A **Faintest magnitude** below 3 also hides passes.
- **"Satellite predictions are paused" in Repairs.** The orbital elements are over two weeks old and
  no fresh catalogue could be downloaded. Check that Home Assistant can reach `celestrak.org`.
  Predictions resume by themselves.
- **Setup says CelesTrak is not allowing another download yet.** CelesTrak refuses repeat downloads
  of the same data. Wait two hours.
- **The page or a card asks for WebGL 2.** Turn on hardware acceleration in your browser. The passes
  card needs no WebGL.
- **The street view shows the 3D model, or only the sky.** There is no 360° photo within 200 m, a
  service did not answer, or the device is too slow for the model. **Layers** and the title card say
  which.
- **The page is missing.** Every location has it switched off, or another dashboard already uses
  `/satellite-spotter`.
- **The old version still shows after an update.** Reload the page, or restart the Companion app.

## Development

```bash
python3.14 -m venv .venv && . .venv/bin/activate
pip install -r requirements_test.txt ruff==0.17.0 mypy==2.4.0
pytest
node --test "tests/js/*.test.mjs"
ruff check . && ruff format --check . && mypy
```

The tests need no network. The scripts in `scripts/` build the generated files
(`make_brightness_table.py`, `make_sky_data.py`, `make_brand.py`), cross-check the geometry
(`validate_against_skyfield.py`) and publish releases (`release.py`). Each explains itself at the
top.

To add a language, copy a JSON file in both `translations/` folders, translate the values, keep each
`{placeholder}`, and add the code to `LANGUAGES` in `frontend/sat-i18n.js`. The tests check the rest.

## Credits and references

Satellite Spotter is licensed under the GNU GPL v3; see `LICENSE`.

### The predictions

- **What the sky lets you see:** Weaver 1947,
  [The Visibility of Stars Without Optical Aid](https://doi.org/10.1086/125956), PASP 59, 232. This
  code departs from its curve on purpose: -4 rather than about -3.2 in full daylight, and stopping
  at 4 rather than 6.
- **How much the air dims a satellite:** Green 1992,
  [Magnitude Corrections for Atmospheric Extinction](http://www.icq.eps.harvard.edu/ICQExtinct.html),
  International Comet Quarterly 14, 55.
- **Starlink brightness:** Mallama et al. 2025,
  [Characterization of Starlink Direct-to-Cell Satellites In Brightness Mitigation Mode](https://arxiv.org/abs/2502.03651);
  Mallama et al. 2024,
  [The Brightness of Starlink Mini Satellites During Orbit-Raising](https://arxiv.org/abs/2405.12007).
- **Thresholds with no published source:** the horizon, the height sunlight must clear, the margin
  over the sky's limit, the departures from Weaver's curve, what counts as bright and which passes
  count as one are James Darpinian's choices for
  [See A Satellite Tonight](https://james.darpinian.com/satellites/), which does not make or support
  this integration.

### Data

| Used for | Source | Licence or terms |
|---|---|---|
| Orbits | [CelesTrak](https://celestrak.org), from US Space Force data on Space-Track and, for Starlinks, SpaceX's ephemerides | |
| Brightness (`brightness.csv` credits each value) | [Mike McCants's list](https://www.mmccants.org/), [SCORE](https://score.cps.iau.org) (IAU CPS), [Stellarium](https://stellarium.org), and [Heavens-Above](https://www.heavens-above.com/satinfo.aspx?satid=48274) for Tiangong | SCORE: CC BY 4.0. Stellarium: GPL |
| Checking those values | [GCAT](https://planet4589.org/space/gcat) by Jonathan McDowell; Mallama & Cole 2025, [arXiv:2507.00107](https://arxiv.org/abs/2507.00107) | GCAT: CC BY 4.0 |
| Cloud cover | [Open-Meteo](https://open-meteo.com) | CC BY 4.0, free for non-commercial use |
| Globe imagery | NASA Blue Marble and Black Marble via GIBS; [Sentinel-2 cloudless](https://s2maps.eu) by EOX IT Services (contains modified Copernicus Sentinel data 2025); Esri World Imagery (Esri, Vantor, Earthstar Geographics and the GIS User Community) | NASA: free with credit. EOX: CC BY-NC-SA 4.0, personal and non-commercial use. Esri: its terms of use |
| Maps and terrain | © OpenStreetMap contributors, via [OpenFreeMap](https://openfreemap.org) and Home Assistant; [Mapzen Terrain Tiles](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) on AWS Open Data | OpenStreetMap: ODbL |
| Street photos | [Panoramax](https://panoramax.fr), Mapillary, Google Street View | Panoramax: each photographer's licence, shown with the photo. Mapillary: CC BY-SA 4.0. Google: © Google, its terms |
| Stars and constellations | Yale Bright Star Catalogue, 5th ed. (Hoffleit & Warren 1991; VizieR V/50, CDS); IAU star names; [d3-celestial](https://github.com/ofrohn/d3-celestial) © 2015 Olaf Frohn, after the IAU and Sky & Telescope charts | IAU names: CC BY 4.0. d3-celestial: BSD-3-Clause. Charts: CC BY 3.0 |
| Compass correction | World Magnetic Model WMM2025, NOAA NCEI and the British Geological Survey | Public domain |

### The sky and the software

- **Sun, Moon and planets:** the Astronomical Almanac (Sun), Meeus 1998, *Astronomical Algorithms*
  (Moon), JPL's approximate planetary elements, and Mallama & Hilton 2018 (planet magnitudes).
- **Drawing the sky:** Lieske et al. 1977 (precession), Sæmundsson 1986 (refraction), Kasten &
  Young 1989 (air mass) and Ballesteros 2012 (star colours).
- **Software:** [`sgp4`](https://pypi.org/project/sgp4/) by Brandon Rhodes (MIT),
  [MapLibre GL JS](https://maplibre.org) (BSD-3-Clause), and the
  [Space Grotesk](https://github.com/floriankarsten/space-grotesk) typeface in the logo (SIL Open
  Font License 1.1).
