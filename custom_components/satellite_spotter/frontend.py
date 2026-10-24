"""Dashboard cards, sidebar panel and the websocket API they use.

Every payload is built by a pure function of the predictions (the ``*_payload``
functions), so the tests and the development fixtures use the same code as
the websocket commands. Times are Unix seconds (integers when whole), angles
degrees with azimuths clockwise from north, magnitudes to one decimal.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta
from functools import partial
import hashlib
import inspect
import logging
import math
from pathlib import Path
from typing import TYPE_CHECKING, Any

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import (
    SIGNAL_CONFIG_ENTRY_CHANGED,
    ConfigEntry,
    ConfigEntryChange,
    ConfigEntryState,
)
from homeassistant.const import CONF_ELEVATION, CONF_LATITUDE, CONF_LONGITUDE
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv, issue_registry as ir
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.json import json_bytes
from homeassistant.util import dt as dt_util
from homeassistant.util.hass_dict import HassKey
import numpy as np
from pysatellitespotter import LookAngle, Satellite, Transit
from sgp4.api import Satrec
import voluptuous as vol

from . import track
from .catalog import CatalogManager
from .const import (
    CARD_MODULE,
    CONF_SHOW_PANEL,
    DEFAULT_SHOW_PANEL,
    DOMAIN,
    FRONTEND_URL,
    ISSUE_CATALOG_STALE,
    MAX_TRANSITS,
    MIN_ELEVATION,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_MODULE,
    PANEL_TITLE,
    PANEL_URL_PATH,
    PASS_TRACK_MAX_STEP,
    PASS_TRACK_MEMBERS,
    PASS_TRACK_STEP,
    PASS_TRACK_SUN_STEP,
    POSITIONS_MAX_SAMPLES,
    POSITIONS_MAX_SPAN,
    POSITIONS_MAX_STEP,
    POSITIONS_MIN_STEP,
    POSITIONS_SPAN,
    POSITIONS_STEP,
    PREDICTION_DAYS,
    TRACK_EPOCH_RANGE,
    TRACK_MAX_POINTS,
    TRACK_MAX_SPAN,
    TRACK_MAX_STEP,
    TRACK_STEP,
)
from .coordinator import PredictionSettings, SatellitePass, SatelliteSpotterCoordinator
from .entity import compass, confidence, info_url, magnitude, pass_title, satellite_kind
from .street import street_payload

if TYPE_CHECKING:
    from . import SatelliteSpotterConfigEntry

_LOGGER = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).parent / "frontend"
DATA_FRONTEND: HassKey[FrontendState] = HassKey(f"{DOMAIN}_frontend")

# Websocket error codes, besides Home Assistant's own.
ERR_UNKNOWN_LOCATION = "unknown_location"
ERR_LOCATION_DISABLED = "location_disabled"
ERR_NOT_READY = "not_ready"
ERR_SETUP_FAILED = "setup_failed"
ERR_STALE_CATALOG = "stale_catalog"
ERR_UNKNOWN_PASS = "unknown_pass"
ERR_UNKNOWN_SATELLITE = "unknown_satellite"

WAITING = "Waiting for the satellite catalog"

# Locations that waiting will not bring back: their setup (or a migration, or
# an unload) failed, and only a reload or a restart can help.
_FAILED_STATES = (
    ConfigEntryState.SETUP_ERROR,
    ConfigEntryState.MIGRATION_ERROR,
    ConfigEntryState.FAILED_UNLOAD,
)

# Home Assistant pads custom panels for the screen's safe areas (notches, home
# indicator) unless they opt out; the panel handles them itself. Cores older
# than the option do not pad.
_PANEL_HANDLES_SAFE_AREA = (
    "handle_safe_area" in inspect.signature(panel_custom.async_register_panel).parameters
)


class FrontendState:
    """What has been registered with the frontend in this run."""

    def __init__(self, version: str) -> None:
        """Initialise."""
        self.version = version
        self.panel_registered = False
        self.panel_conflict_logged = False
        # The catalog payload, built once per catalog version.
        self.catalog: tuple[int, dict[str, Any]] | None = None


def _files_version() -> str:
    """Short hash of the frontend files, so browsers fetch new versions after updates.

    Every file at the top of the frontend folder (the modules, which pass the
    version on to the modules they import) and the translations. MapLibre and
    the images live in folders that are never revalidated: their names change
    instead.
    """
    digest = hashlib.sha256()
    files = [p for p in FRONTEND_DIR.iterdir() if p.is_file() and not p.name.startswith(".")]
    for path in sorted([*files, *FRONTEND_DIR.glob("translations/*")]):
        digest.update(path.relative_to(FRONTEND_DIR).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


async def async_setup_frontend(hass: HomeAssistant) -> None:
    """Serve the frontend files and register the cards and the websocket API."""
    version = await hass.async_add_executor_job(_files_version)
    hass.data[DATA_FRONTEND] = FrontendState(version)
    # The modules are revalidated rather than cached forever; the entry modules
    # carry the version so a new release is picked up straight away. MapLibre
    # (its folder names the version) and the images never change, so browsers
    # may keep them. Both folders also hold pre-compressed copies, which are
    # served to browsers that accept them.
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(FRONTEND_URL, str(FRONTEND_DIR), cache_headers=False),
            StaticPathConfig(
                f"{FRONTEND_URL}/vendor", str(FRONTEND_DIR / "vendor"), cache_headers=True
            ),
            StaticPathConfig(f"{FRONTEND_URL}/img", str(FRONTEND_DIR / "img"), cache_headers=True),
        ]
    )
    frontend.add_extra_js_url(hass, f"{FRONTEND_URL}/{CARD_MODULE}?v={version}")
    for command in (
        ws_locations,
        ws_passes,
        ws_pass_track,
        ws_track,
        ws_positions,
        ws_catalog,
        ws_street,
    ):
        websocket_api.async_register_command(hass, command)

    @callback
    def _async_entry_changed(change: ConfigEntryChange, entry: ConfigEntry) -> None:
        # Disabling a location that is not loaded (one still retrying setup,
        # say) runs none of the integration's hooks, so look at the panel and
        # the repair issue here.
        if entry.domain == DOMAIN and entry.disabled_by is not None:
            hass.async_create_task(async_update_panel(hass))
            async_clear_stale_issue(hass)

    async_dispatcher_connect(hass, SIGNAL_CONFIG_ENTRY_CHANGED, _async_entry_changed)


@callback
def async_clear_stale_issue(hass: HomeAssistant) -> None:
    """Drop the paused-predictions repair once no enabled location is left to fix."""
    if not any(e.disabled_by is None for e in hass.config_entries.async_entries(DOMAIN)):
        ir.async_delete_issue(hass, DOMAIN, ISSUE_CATALOG_STALE)


def _loaded_entries(hass: HomeAssistant) -> list[ConfigEntry]:
    return [
        e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED
    ]


def _panel_wanted(entry: ConfigEntry) -> bool:
    return bool(entry.options.get(CONF_SHOW_PANEL, DEFAULT_SHOW_PANEL))


async def async_update_panel(
    hass: HomeAssistant,
    *,
    adding: ConfigEntry | None = None,
    removing: ConfigEntry | None = None,
) -> None:
    """Show the sidebar panel while any enabled location has it switched on.

    Enabled rather than loaded, so that reloading a location (after an options
    change, say) does not take the page away from anyone looking at it.
    ``adding`` is an entry being set up and ``removing`` one being deleted.
    Never raises, and never touches a panel this integration did not add.
    """
    state = hass.data.get(DATA_FRONTEND)
    if state is None:
        return
    entries = [
        e
        for e in hass.config_entries.async_entries(DOMAIN)
        if e.disabled_by is None and e is not removing
    ]
    if adding is not None and adding not in entries:
        entries.append(adding)
    wanted = any(_panel_wanted(e) for e in entries)

    if wanted and not state.panel_registered:
        if PANEL_URL_PATH in hass.data.get(frontend.DATA_PANELS, {}):
            # A dashboard (or another integration) already uses the address.
            if not state.panel_conflict_logged:
                state.panel_conflict_logged = True
                _LOGGER.warning(
                    "/%s is already used by another dashboard or panel, so the %s "
                    "sidebar page was not added. The dashboard cards still work",
                    PANEL_URL_PATH,
                    PANEL_TITLE,
                )
            return
        extra: dict[str, Any] = {"handle_safe_area": True} if _PANEL_HANDLES_SAFE_AREA else {}
        try:
            await panel_custom.async_register_panel(
                hass,
                frontend_url_path=PANEL_URL_PATH,
                webcomponent_name=PANEL_ELEMENT,
                sidebar_title=PANEL_TITLE,
                sidebar_icon=PANEL_ICON,
                module_url=f"{FRONTEND_URL}/{PANEL_MODULE}?v={state.version}",
                embed_iframe=False,
                require_admin=False,
                config={"version": state.version},
                **extra,
            )
        except ValueError as err:
            _LOGGER.warning("Could not add the %s sidebar page: %s", PANEL_TITLE, err)
            return
        state.panel_registered = True
    elif not wanted and state.panel_registered:
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
        state.panel_registered = False


def _coordinator(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> SatelliteSpotterCoordinator | None:
    """Return the loaded location a request is for, or send an error saying why there is none."""
    entries: list[SatelliteSpotterConfigEntry] = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        connection.send_error(
            msg["id"], websocket_api.ERR_NOT_FOUND, "No Satellite Spotter location is set up"
        )
        return None
    if (entry_id := msg.get("entry_id")) is not None:
        entries = [e for e in entries if e.entry_id == entry_id]
        if not entries:
            connection.send_error(
                msg["id"], ERR_UNKNOWN_LOCATION, "This Satellite Spotter location no longer exists"
            )
            return None
    for entry in entries:
        if entry.state is ConfigEntryState.LOADED:
            return entry.runtime_data
    enabled = [e for e in entries if e.disabled_by is None]
    if not enabled:
        # Not something waiting will fix.
        connection.send_error(msg["id"], ERR_LOCATION_DISABLED, "This location is disabled")
    elif starting := [e for e in enabled if e.state not in _FAILED_STATES]:
        connection.send_error(msg["id"], ERR_NOT_READY, starting[0].reason or "Starting up")
    else:
        # Nor is this. An unexpected error leaves no reason; the log has it.
        reason = enabled[0].reason or "Setup failed"
        connection.send_error(msg["id"], ERR_SETUP_FAILED, f"{reason}; see the Home Assistant log")
    return None


def _predictions(
    coordinator: SatelliteSpotterCoordinator,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> bool:
    """Whether there are predictions to answer from; sends the error when not."""
    if (paused := coordinator.paused_reason(dt_util.utcnow())) is not None:
        code = ERR_NOT_READY if coordinator.data is None else ERR_STALE_CATALOG
        connection.send_error(msg["id"], code, paused)
        return False
    return True


# --- Payloads ----------------------------------------------------------------


def unix(t: datetime | float) -> int | float:
    """Unix time to the millisecond; whole seconds stay integers to keep payloads small."""
    seconds = round(t.timestamp() if isinstance(t, datetime) else float(t), 3)
    return int(seconds) if seconds.is_integer() else seconds


def _number(value: float | None, digits: int) -> float | None:
    """Round a value, never to -0.0; None stays None."""
    return None if value is None or not math.isfinite(value) else round(value, digits) + 0.0


def look_json(angle: LookAngle) -> dict[str, Any]:
    """Where to look: azimuth, elevation and compass direction."""
    return {
        "azimuth": _number(angle.azimuth, 1),
        "elevation": _number(angle.elevation, 1),
        "direction": compass(angle.azimuth),
    }


def peak_json(point: track.SkyPoint) -> dict[str, Any]:
    """Describe the highest point of a visible window."""
    return {
        "time": unix(point.time),
        "azimuth": _number(point.azimuth, 1),
        "elevation": _number(point.elevation, 1),
        "direction": compass(point.azimuth),
    }


def transit_json(t: Transit, shape: track.TransitShape) -> dict[str, Any]:
    """One satellite's visible pass."""
    sat = t.satellite
    return {
        "norad_id": sat.norad_id,
        "name": sat.name,
        "kind": satellite_kind(sat.norad_id, sat.name),
        "start": unix(t.start),
        "end": unix(t.end),
        "magnitude": magnitude(t.min_magnitude),
        "brightest_time": unix(t.brightest_time),
        "rise": look_json(t.rise),
        "brightest": look_json(t.brightest),
        "set": look_json(t.set),
        "peak": peak_json(shape.peak),
        "start_reason": shape.start_reason,
        "end_reason": shape.end_reason,
        "intrinsic_magnitude": _number(sat.magnitude, 1),
        "model": sat.model,
        "prediction": sat.prediction,
        "period_s": round(track.period_s(sat)),
        "info_url": info_url(sat.norad_id, sat.name),
        "confidence": confidence(t.start, sat),
    }


def is_train(p: SatellitePass) -> bool:
    """Whether a pass is a Starlink train: more than five satellites behind a Starlink."""
    primary = p.primary.satellite
    return p.group.satellite_count > 5 and (
        satellite_kind(primary.norad_id, primary.name) == "starlink"
    )


def pass_json(p: SatellitePass) -> dict[str, Any]:
    """Describe a pass, with its satellites (up to MAX_TRANSITS)."""
    primary = p.primary.satellite
    kind = satellite_kind(primary.norad_id, primary.name)
    count = p.group.satellite_count
    return {
        "id": p.id,
        "title": pass_title(p),
        "kind": kind,
        "start": unix(p.start),
        "end": unix(p.end),
        "duration": round((p.end - p.start).total_seconds()),
        "magnitude": magnitude(p.group.min_magnitude),
        "bright": p.bright,
        "before_sunset": p.group.before_sunset,
        "limiting_magnitude": _number(p.group.limiting_magnitude, 1),
        "cloud_cover": p.cloud_cover,
        "satellite_count": count,
        "train": is_train(p),
        "peak": peak_json(p.peak),
        "transits": [
            transit_json(t, shape)
            for t, shape in zip(p.group.transits[:MAX_TRANSITS], p.shapes, strict=False)
        ],
    }


def passes_payload(
    passes: Iterable[SatellitePass] | None,
    *,
    now: datetime,
    location: dict[str, Any],
    settings: PredictionSettings,
    catalog: dict[str, Any],
    computed_at: datetime | None,
    paused: str | None = None,
    paused_days: int | None = None,
    paused_error: str | None = None,
) -> dict[str, Any]:
    """Everything the pass list, mission card and sky chart need for a location.

    While predictions are paused there are no passes; ``paused`` says why,
    and ``paused_days``/``paused_error`` give the numbers for a translated
    message when the orbit data is too old.
    """
    lead = settings.alert_lead.total_seconds() / 60
    return {
        "generated_at": int(now.timestamp()),
        # Precise, so the page can allow for a browser clock that is off.
        "server_time": round(now.timestamp(), 3),
        "computed_at": None if computed_at is None else unix(computed_at),
        "paused": paused,
        "paused_days": paused_days,
        "paused_error": paused_error,
        "location": location,
        "settings": {
            "max_magnitude": settings.max_magnitude,
            "cloud_cover": settings.cloud_cover,
            "alert_lead_minutes": int(lead) if lead.is_integer() else lead,
            "units": settings.units,
            "days": PREDICTION_DAYS,
            "min_elevation": MIN_ELEVATION,
        },
        "catalog": catalog,
        "passes": [] if paused is not None or passes is None else [pass_json(p) for p in passes],
    }


def location_json(coordinator: SatelliteSpotterCoordinator) -> dict[str, Any]:
    """Where a location is (the page draws it; the websocket is authenticated)."""
    entry = coordinator.config_entry
    return {
        "entry_id": entry.entry_id,
        "title": entry.title,
        "latitude": entry.data[CONF_LATITUDE],
        "longitude": entry.data[CONF_LONGITUDE],
        "elevation": entry.data.get(CONF_ELEVATION, 0.0),
    }


def catalog_json(catalog: CatalogManager, now: datetime) -> dict[str, Any]:
    """Which catalog is current, so the page knows when to fetch it again."""
    age = catalog.median_epoch_age(now)
    return {
        "updated": None if catalog.updated is None else unix(catalog.updated),
        "version": catalog.version,
        "satellites": len(catalog.satellites or ()),
        "median_epoch_age_days": None if age is None else round(age.total_seconds() / 86400, 2),
    }


def build_passes_payload(coordinator: SatelliteSpotterCoordinator, now: datetime) -> dict[str, Any]:
    """Build the passes payload of a location from its current predictions."""
    data = coordinator.data
    paused = coordinator.paused_reason(now)
    stale = coordinator.stale_age(now) if paused is not None else None
    return passes_payload(
        None if data is None else data.passes,
        now=now,
        location=location_json(coordinator),
        settings=coordinator.settings,
        catalog=catalog_json(coordinator.catalog, now),
        computed_at=None if data is None else data.computed_at,
        paused=paused,
        # Paused because the orbit data is too old: the page words that
        # itself, in the user's language, from these.
        paused_days=None if stale is None else stale.days,
        paused_error=None if stale is None else coordinator.catalog.last_error,
    )


def pass_track_payload(
    p: SatellitePass, observer: track.Observer, step: float, max_magnitude: float
) -> dict[str, Any]:
    """Trace a pass's satellites across the sky, horizon to horizon, and the Sun meanwhile.

    Every satellite gets rows of its own, except in a Starlink train: there
    the Starlinks after the first PASS_TRACK_MEMBERS follow the first one's
    path, ``offset_s`` later, as trains do (runs in the executor).
    """
    first = p.primary.brightest_time.timestamp()
    train = is_train(p)
    transits: list[dict[str, Any]] = []
    for i, t in enumerate(p.group.transits[:MAX_TRANSITS]):
        sat = t.satellite
        kind = satellite_kind(sat.norad_id, sat.name)
        start, end = t.start.timestamp(), t.end.timestamp()
        item: dict[str, Any] = {
            "norad_id": sat.norad_id,
            "name": sat.name,
            "kind": kind,
            "offset_s": round(t.brightest_time.timestamp() - first),
            "horizon_rise": None,
            "horizon_set": None,
            "visible_start": unix(start),
            "visible_end": unix(end),
            "rows": None,
        }
        if train and i >= PASS_TRACK_MEMBERS and kind == "starlink" and transits[0]["rows"]:
            # Drawn as the first one's path, offset_s later: so are its horizons.
            offset = t.brightest_time.timestamp() - first
            item["horizon_rise"] = unix(transits[0]["horizon_rise"] + offset)
            item["horizon_set"] = unix(transits[0]["horizon_set"] + offset)
        elif (sky := track.pass_track(sat, observer, start, end, step, max_magnitude)) is not None:
            item.update(horizon_rise=sky.horizon_rise, horizon_set=sky.horizon_set, rows=sky.rows)
        else:
            # SGP4 cannot place it (or it never clears the horizon here).
            item["horizon_rise"], item["horizon_set"] = item["visible_start"], item["visible_end"]
        transits.append(item)
    rise = min(x["horizon_rise"] for x in transits)
    set_ = max(x["horizon_set"] for x in transits)
    return {
        "pass_id": p.id,
        "step": step,
        "sun": track.sun_rows(observer, rise, set_, PASS_TRACK_SUN_STEP),
        "transits": transits,
    }


def track_step(start: datetime, end: datetime, step: float) -> float:
    """Return the requested spacing, widened so a track stays within TRACK_MAX_POINTS."""
    span = (end - start).total_seconds()
    return max(step, math.ceil(span / (TRACK_MAX_POINTS - 1)))


def track_payload(sat: Satellite, start: datetime, end: datetime, step: float) -> dict[str, Any]:
    """One satellite's ground track: rows [t, lat, lon, alt_km, lit] (runs in the executor)."""
    ts = start.timestamp() + np.arange(0.0, (end - start).total_seconds() + 1e-6, step)
    return {"norad_id": sat.norad_id, "step": step, "track": track.ground_rows(sat.satrec(), ts)}


def positions_payload(
    satellites: Sequence[Satellite],
    satrecs: Sequence[Satrec],
    *,
    start: int,
    span: int,
    step: int,
    version: int,
) -> dict[str, Any]:
    """Every catalog satellite at start, start + step, ... start + span (runs in the executor).

    Per satellite, one flat list [lat, lon, alt_km, lat, lon, alt_km, ...]
    (2 decimals, whole km) and a string of 0/1 for sunlit. Satellites SGP4
    cannot place at some of these times are left out.
    """
    ts = start + np.arange(0, span + 1, step, dtype=float)
    pos = track.positions(satrecs, ts)
    lat, lon = np.round(pos.latitude, 2), np.round(pos.longitude, 2)
    alt = np.rint(pos.altitude_km)
    ids: list[int] = []
    rows: list[list[float | int]] = []
    lit: list[str] = []
    for i in np.flatnonzero(pos.ok).tolist():
        ids.append(satellites[i].norad_id)
        rows.append(
            [
                v
                for triple in zip(
                    lat[i].tolist(), lon[i].tolist(), alt[i].astype(int).tolist(), strict=True
                )
                for v in triple
            ]
        )
        lit.append((pos.lit[i].astype(np.uint8) + ord("0")).tobytes().decode())
    return {
        "start": start,
        "step": step,
        "count": len(ts),
        "catalog_version": version,
        "ids": ids,
        "pos": rows,
        "lit": lit,
    }


def positions_json(
    satellites: Sequence[Satellite], satrecs: Sequence[Satrec], **window: int
) -> bytes:
    """Encode the positions payload as sent, to keep for other pages (runs in the executor).

    A fraction of the memory its lists take. Copied into bytes of their own
    size, as orjson leaves spare room after what it writes, up to as much again.
    """
    return b"".join((json_bytes(positions_payload(satellites, satrecs, **window)), b""))


def catalog_payload(
    satellites: Sequence[Satellite], updated: datetime | None, version: int
) -> dict[str, Any]:
    """Describe every satellite of the catalog, as the globe needs it."""
    items = []
    for sat in satellites:
        perigee, apogee = track.apsides_km(sat)
        items.append(
            {
                "norad_id": sat.norad_id,
                "name": sat.name,
                "kind": satellite_kind(sat.norad_id, sat.name),
                "magnitude": _number(sat.magnitude, 1),
                "model": sat.model,
                "epoch": unix(sat.epoch),
                "period_s": round(track.period_s(sat)),
                "perigee_km": round(perigee),
                "apogee_km": round(apogee),
                "inclination": _number(float(sat.omm.get("INCLINATION", "nan")), 1),
                "info_url": info_url(sat.norad_id, sat.name),
            }
        )
    return {
        "updated": None if updated is None else unix(updated),
        "version": version,
        "satellites": items,
    }


# --- Commands ----------------------------------------------------------------


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/locations"})
@callback
def ws_locations(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """List the loaded locations."""
    connection.send_result(
        msg["id"],
        [
            {"entry_id": e.entry_id, "title": e.title, "show_in_sidebar": _panel_wanted(e)}
            for e in _loaded_entries(hass)
        ],
    )


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/passes", vol.Optional("entry_id"): str}
)
@callback
def ws_passes(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Send the predicted passes of a location (from the latest prediction run)."""
    if (coordinator := _coordinator(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], build_passes_payload(coordinator, dt_util.utcnow()))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/pass_track",
        vol.Optional("entry_id"): str,
        vol.Required("pass_id"): str,
        vol.Optional("step", default=PASS_TRACK_STEP): vol.All(
            vol.Coerce(float), vol.Range(min=1, max=PASS_TRACK_MAX_STEP)
        ),
    }
)
@websocket_api.async_response
async def ws_pass_track(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Send a pass across the sky and the ground, for the simulation and the street view."""
    if (coordinator := _coordinator(hass, connection, msg)) is None:
        return
    if not _predictions(coordinator, connection, msg):
        return
    assert coordinator.data is not None
    if (p := coordinator.data.find(msg["pass_id"])) is None:
        connection.send_error(
            msg["id"], ERR_UNKNOWN_PASS, "This pass is not among the predicted passes"
        )
        return
    payload = await hass.async_add_executor_job(
        pass_track_payload,
        p,
        coordinator.observer,
        msg["step"],
        coordinator.settings.max_magnitude,
    )
    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/track",
        vol.Optional("entry_id"): str,
        vol.Required("norad_id"): vol.Coerce(int),
        vol.Required("start"): cv.datetime,
        vol.Required("end"): cv.datetime,
        vol.Optional("step", default=TRACK_STEP): vol.All(
            vol.Coerce(float), vol.Range(min=1, max=TRACK_MAX_STEP)
        ),
    }
)
@websocket_api.async_response
async def ws_track(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """One satellite's ground track over any stretch of time (its orbit, an approach)."""
    if (coordinator := _coordinator(hass, connection, msg)) is None:
        return
    try:
        start = dt_util.as_utc(msg["start"])
        end = dt_util.as_utc(msg["end"])
    except OverflowError:
        connection.send_error(
            msg["id"], websocket_api.ERR_INVALID_FORMAT, "start and end must be valid times"
        )
        return
    # A difference of two valid times cannot overflow, unlike start + span.
    if not timedelta(0) < end - start <= TRACK_MAX_SPAN:
        connection.send_error(
            msg["id"],
            websocket_api.ERR_INVALID_FORMAT,
            f"end must be after start and at most {TRACK_MAX_SPAN.days} days later",
        )
        return
    if not _predictions(coordinator, connection, msg):
        return
    assert coordinator.data is not None
    norad_id = msg["norad_id"]
    sat = coordinator.data.satellites.get(norad_id) or coordinator.catalog.by_id().get(norad_id)
    if sat is None:
        connection.send_error(
            msg["id"], ERR_UNKNOWN_SATELLITE, f"Satellite {norad_id} is not in the catalog"
        )
        return
    # Near the elements' epoch, or near now (the passes are predicted from
    # now, whatever the elements' age).
    now = dt_util.utcnow()
    low, high = min(sat.epoch, now) - TRACK_EPOCH_RANGE, max(sat.epoch, now) + TRACK_EPOCH_RANGE
    if not (low <= start and end <= high):
        connection.send_error(
            msg["id"],
            websocket_api.ERR_INVALID_FORMAT,
            f"start and end must be within {TRACK_EPOCH_RANGE.days} days of now or of the "
            "satellite's orbital elements",
        )
        return
    payload = await hass.async_add_executor_job(
        track_payload, sat, start, end, track_step(start, end, msg["step"])
    )
    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/positions",
        vol.Optional("entry_id"): str,
        vol.Optional("start"): cv.datetime,
        vol.Optional("span", default=POSITIONS_SPAN): vol.All(
            vol.Coerce(int), vol.Range(min=0, max=POSITIONS_MAX_SPAN)
        ),
        vol.Optional("step", default=POSITIONS_STEP): vol.All(
            vol.Coerce(int), vol.Range(min=POSITIONS_MIN_STEP, max=POSITIONS_MAX_STEP)
        ),
    }
)
@websocket_api.async_response
async def ws_positions(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Where every catalog satellite is over the next minutes (the globe's cloud)."""
    if (coordinator := _coordinator(hass, connection, msg)) is None:
        return
    now = dt_util.utcnow()
    try:
        when = dt_util.as_utc(msg["start"]) if "start" in msg else now
    except OverflowError:
        when = None
    if when is None or abs(when - now) > TRACK_EPOCH_RANGE:
        connection.send_error(
            msg["id"],
            websocket_api.ERR_INVALID_FORMAT,
            f"start must be within {TRACK_EPOCH_RANGE.days} days of now",
        )
        return
    span, step = msg["span"], msg["step"]
    if span > (POSITIONS_MAX_SAMPLES - 1) * step:
        connection.send_error(
            msg["id"],
            websocket_api.ERR_INVALID_FORMAT,
            f"span must be at most {POSITIONS_MAX_SAMPLES - 1} times step",
        )
        return
    if not _predictions(coordinator, connection, msg):
        return
    catalog = coordinator.catalog
    # Aligned to the step, so every page asking around now shares the result.
    start = math.floor(when.timestamp() / step) * step
    key = ("positions", catalog.version, start, span, step)
    if (payload := catalog.cached(key)) is None:
        satellites, version = catalog.satellites or [], catalog.version
        payload = await hass.async_add_executor_job(
            partial(
                positions_json,
                satellites,
                catalog.satrecs(),
                start=start,
                span=span,
                step=step,
                version=version,
            )
        )
        if catalog.version == version:
            catalog.remember(key, payload)
    connection.send_message(websocket_api.messages.construct_result_message(msg["id"], payload))


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/catalog", vol.Optional("entry_id"): str}
)
@callback
def ws_catalog(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Every catalog satellite: name, kind, brightness and orbit (once per catalog version)."""
    if (coordinator := _coordinator(hass, connection, msg)) is None:
        return
    catalog = coordinator.catalog
    state = hass.data[DATA_FRONTEND]
    if state.catalog is None or state.catalog[0] != catalog.version:
        state.catalog = (
            catalog.version,
            catalog_payload(catalog.satellites or [], catalog.updated, catalog.version),
        )
    connection.send_result(msg["id"], state.catalog[1])


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/street", vol.Optional("entry_id"): str}
)
@callback
def ws_street(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Where a location's street photos come from, with the keys: the browser fetches them."""
    if (coordinator := _coordinator(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], street_payload(coordinator.config_entry.options))
