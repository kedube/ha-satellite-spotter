"""Constants for the Satellite Spotter integration."""

from __future__ import annotations

from datetime import timedelta
import json
from pathlib import Path
from typing import Final

DOMAIN: Final = "satellite_spotter"
# The release number lives only in manifest.json (scripts/release.py raises it).
VERSION: Final[str] = json.loads((Path(__file__).parent / "manifest.json").read_text())["version"]
USER_AGENT: Final = (
    f"HomeAssistant-SatelliteSpotter/{VERSION} (+https://github.com/kedube/ha-satellite-spotter)"
)

# Mini-MegaTORTORA's team asks for attribution and citation. The full references are in the
# README and at the top of brightness.csv.
ATTRIBUTION: Final = (
    "Orbits: CelesTrak. Brightness: Mini-MegaTORTORA (Karpov et al. 2016), Mike McCants, "
    "SCORE (IAU CPS) and Stellarium. Clouds: Open-Meteo"
)

CONF_BRIGHTNESS_CUTOFF: Final = "brightness_cutoff"
CONF_CLOUD_FORECAST: Final = "cloud_forecast"
CONF_ALERT_LEAD_MINUTES: Final = "alert_lead_minutes"
CONF_SHOW_PANEL: Final = "show_in_sidebar"
CONF_SHOW_CALENDAR: Final = "show_in_calendar"
CONF_UNITS: Final = "units"
# The street view's photos: an options section with where they come from and
# the keys of the services that need one.
CONF_STREET_VIEW: Final = "street_view"
CONF_STREET_SOURCE: Final = "street_source"
CONF_MAPILLARY_TOKEN: Final = "mapillary_token"
CONF_GOOGLE_API_KEY: Final = "google_api_key"

# About the faintest a satellite can be and still be found from a suburb.
# Lower numbers are brighter.
DEFAULT_BRIGHTNESS_CUTOFF: Final = 2.25
# The options slider for it, in magnitudes.
CUTOFF_MIN: Final = -1
CUTOFF_MAX: Final = 4
CUTOFF_STEP: Final = 0.25
DEFAULT_CLOUD_FORECAST: Final = True
DEFAULT_ALERT_LEAD_MINUTES: Final = 15
DEFAULT_SHOW_PANEL: Final = True
DEFAULT_SHOW_CALENDAR: Final = True
# Distances and speeds on the globe; auto follows Home Assistant's unit system.
UNITS: Final = ("auto", "metric", "imperial")
DEFAULT_UNITS: Final = "auto"
# Where the street view's photos come from: auto takes the best near home from
# every service there is a key for (Panoramax needs none); model shows no
# photos, only the 3D model.
STREET_SOURCES: Final = ("auto", "google", "mapillary", "panoramax", "model")
DEFAULT_STREET_SOURCE: Final = "auto"

# The catalog of the brightest satellites (about 970), downloaded once for
# every location, from CelesTrak (celestrak.py).
CATALOG_DOWNLOAD_EVERY: Final = timedelta(hours=12)
# When CelesTrak could not be reached, try again this much later: soon while
# there is no catalog at all (Home Assistant often starts before the network is
# up), less eagerly while a cached one still predicts well.
CATALOG_RETRY: Final = timedelta(minutes=30)
CATALOG_UNREACHABLE_RETRY: Final = timedelta(minutes=5)
# When CelesTrak answered with anything but orbital data. Its data changes at
# most this often, and it can block an address that keeps asking after a refusal,
# so nothing shortens this wait: not a restart, not someone adding a location, not
# removing the last location and adding it back.
CATALOG_REFUSED_RETRY: Final = timedelta(hours=2)
# A download stamped further ahead than this means the clock was set back since.
# Refresh rather than wait for the clock to catch up, after the wait above, as
# that download may have been moments ago.
CATALOG_CLOCK_SLACK: Final = timedelta(hours=2)
# Orbital elements older than this (the median over the catalog) give
# misleading predictions, so they are paused and a repair issue explains why.
CATALOG_MAX_AGE: Final = timedelta(days=14)
ISSUE_CATALOG_STALE: Final = "catalog_stale"
# Its wording (and the error's) when the catalog downloads but CelesTrak's data is as old.
CATALOG_STALE_UPSTREAM: Final = "catalog_stale_upstream"

STORAGE_KEY: Final = f"{DOMAIN}.catalog"
STORAGE_VERSION: Final = 2
# The catalog is about half a megabyte; batch the write after a download.
STORAGE_SAVE_DELAY: Final = 15

# Each location looks at the clouds and at whether a catalog is due this often.
REFRESH_EVERY: Final = timedelta(hours=1)
# Passes depend on the orbits, which change with the catalog, so the search (seconds of work on a
# small computer) runs for each new catalog, and this often if none comes, to keep the window
# rolling.
SEARCH_EVERY: Final = CATALOG_DOWNLOAD_EVERY
# A forecast that could not be refreshed is still better than none for this long.
FORECAST_MAX_AGE: Final = timedelta(hours=6)
# Passes are predicted for the next PREDICTION_DAYS from a few minutes ago, so a
# pass under way is still reported.
PREDICTION_DAYS: Final = 5
PREDICTION_LOOKBACK: Final = timedelta(minutes=5)
# How often the live position is worked out, and while its satellite is showing.
LIVE_EVERY: Final = timedelta(seconds=60)
LIVE_EVERY_DURING_PASS: Final = timedelta(seconds=10)
# The location form's limits: from below the shore of the Dead Sea to above the top of Everest.
ELEVATION_MIN_M: Final = -450
ELEVATION_MAX_M: Final = 8900
# Satellites lower than this count as hidden.
MIN_ELEVATION: Final = 10
# How far ahead the count of passes looks.
UPCOMING_WINDOW: Final = timedelta(hours=24)
MAX_UPCOMING_PASSES: Final = 20
MAX_GROUP_NAMES: Final = 15
# A Starlink train can bring dozens of satellites; the payloads list this many.
MAX_SIGHTINGS: Final = 60

# Rough guide to how far the timing of a prediction can be trusted, by how far
# the pass is from the epoch of the satellite's orbital elements. Drag and
# manoeuvres make far-off predictions drift by minutes. A rule of thumb, not a
# formal error bound.
CONFIDENCE_HIGH_DAYS: Final = 3
CONFIDENCE_MEDIUM_DAYS: Final = 7

# The calendar's entity key: the option that switches it decides whether it is kept.
CALENDAR_KEY: Final = "visible_passes"
POSITION_KEY: Final = "satellite_position"

# Frontend: the dashboard cards, the sidebar panel and the files they load.
FRONTEND_URL: Final = f"/{DOMAIN}/frontend"
PANEL_URL_PATH: Final = "satellite-spotter"
PANEL_TITLE: Final = "Satellite Spotter"
PANEL_ICON: Final = "mdi:satellite-variant"
PANEL_ELEMENT: Final = "satellite-spotter-panel"
PANEL_MODULE: Final = "sat-panel.js"
CARD_MODULE: Final = "sat-card.js"

# Websocket limits. A pass track samples a few seconds apart from horizon to
# horizon; past the first members of a big group, every PASS_TRACK_MAX_STEP.
PASS_TRACK_STEP: Final = 2
PASS_TRACK_MAX_STEP: Final = 10
PASS_TRACK_MEMBERS: Final = 6
PASS_TRACK_SUN_STEP: Final = 30
# A refresh can shift a pass by a few seconds (new orbital elements); an old
# pass id still finds it.
PASS_ID_TOLERANCE: Final = timedelta(seconds=120)
# Ground tracks of one satellite (its orbit, the approach before a pass).
TRACK_STEP: Final = 30
TRACK_MAX_STEP: Final = 900
TRACK_MAX_SPAN: Final = timedelta(days=7)
TRACK_MAX_POINTS: Final = 6000
# Tracks far from both the elements' epoch and now are meaningless, and SGP4
# often returns positions for them without complaint.
TRACK_EPOCH_RANGE: Final = CATALOG_MAX_AGE + TRACK_MAX_SPAN + timedelta(days=1)
# Positions of every catalog satellite, for the globe's cloud of satellites.
POSITIONS_SPAN: Final = 600
POSITIONS_MAX_SPAN: Final = 3600
POSITIONS_STEP: Final = 60
POSITIONS_MIN_STEP: Final = 10
POSITIONS_MAX_STEP: Final = 300
# Each time sampled adds the whole catalog to the reply (kept for other
# pages), so a request has at most this many: an hour at the default step,
# the most the globe asks for.
POSITIONS_MAX_SAMPLES: Final = 61
POSITIONS_CACHE_SIZE: Final = 8
