"""Tests for the frontend files and the sidebar panel."""

from __future__ import annotations

import gzip
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components.frontend import (
    DATA_EXTRA_MODULE_URL,
    DATA_PANELS,
    EVENT_PANELS_UPDATED,
)
from homeassistant.components.http.static import CACHE_HEADER
from homeassistant.config_entries import ConfigEntryDisabler, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from pysatellitespotter import CatalogError
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events

from custom_components.satellite_spotter import frontend as sat_frontend
from custom_components.satellite_spotter.const import (
    CONF_ALERT_LEAD_MINUTES,
    CONF_SHOW_PANEL,
    DOMAIN,
    FRONTEND_URL,
    PANEL_URL_PATH,
)

from .common import DENVER, DENVER_ID, INTEGRATION, NOW, advance

FRONTEND = INTEGRATION / "frontend"
VENDOR = FRONTEND / "vendor/maplibre-gl-6.11.2"
VENDOR_FILES = (
    "maplibre-gl.mjs",
    "maplibre-gl-shared.mjs",
    "maplibre-gl-worker.mjs",
    "maplibre-gl.css",
)
# Every module at the top of the frontend folder: the other tracks add theirs.
MODULES = sorted(p.name for p in FRONTEND.glob("*.js"))


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    """Set the clock before the fixtures that sign in, so their tokens are valid then."""
    freezer.move_to(NOW)


def test_the_modules_are_there() -> None:
    """The card loader and the panel are where the registration says."""
    assert {"sat-card.js", "sat-panel.js"} <= set(MODULES)
    assert (FRONTEND / "translations/en.js").is_file()


async def test_frontend_files_are_served(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_client
) -> None:
    urls = hass.data[DATA_EXTRA_MODULE_URL].urls
    card = next(u for u in urls if u.startswith(f"{FRONTEND_URL}/sat-card.js?v="))
    version = card.rsplit("=", 1)[1]
    assert version == sat_frontend._files_version()

    client = await hass_client()
    for path in [card, *(f"{FRONTEND_URL}/{name}" for name in MODULES)]:
        resp = await client.get(path)
        assert resp.status == 200, path
        assert "javascript" in resp.content_type, path
        # Revalidated, so a new release shows at once.
        assert "Cache-Control" not in resp.headers, path
    for path in sorted((FRONTEND / "translations").iterdir()):
        resp = await client.get(f"{FRONTEND_URL}/translations/{path.name}")
        assert resp.status == 200, path.name
        assert resp.content_type in ("application/json", "text/javascript"), path.name
        assert "Cache-Control" not in resp.headers, path.name
    for name in VENDOR_FILES:
        resp = await client.get(f"{FRONTEND_URL}/vendor/maplibre-gl-6.11.2/{name}")
        assert resp.status == 200, name
    for width in (4096, 2048):
        resp = await client.get(f"{FRONTEND_URL}/img/black-marble-2016-{width}.jpg")
        assert resp.status == 200
        assert resp.content_type == "image/jpeg"


def test_files_version_covers_every_module_and_translation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A changed translation, module or data file must reach browsers as surely as any."""
    (tmp_path / "translations").mkdir()
    (tmp_path / "vendor").mkdir()
    (tmp_path / "sat-globe.js").write_text("// globe")
    (tmp_path / "translations" / "de.json").write_text('{"card": {"name": "Globus"}}')
    monkeypatch.setattr(sat_frontend, "FRONTEND_DIR", tmp_path)
    versions = {sat_frontend._files_version()}
    (tmp_path / "translations" / "de.json").write_text('{"card": {"name": "Satelliten"}}')
    versions.add(sat_frontend._files_version())
    (tmp_path / "sat-street.js").write_text("// a new module")
    versions.add(sat_frontend._files_version())
    (tmp_path / "sat-stars.js").write_text("export const STARS = [];")
    versions.add(sat_frontend._files_version())
    assert len(versions) == 4
    # Folders that are never revalidated (their names change instead) do not count.
    (tmp_path / "vendor" / "lib.mjs").write_text("// vendored")
    (tmp_path / ".DS_Store").write_bytes(b"\0")
    assert sat_frontend._files_version() in versions


@pytest.mark.parametrize("name", VENDOR_FILES)
def test_gzip_copies_match(name: str) -> None:
    assert gzip.decompress((VENDOR / f"{name}.gz").read_bytes()) == (VENDOR / name).read_bytes()


@pytest.mark.parametrize("name", VENDOR_FILES)
def test_brotli_copies_match(name: str) -> None:
    brotli = pytest.importorskip("brotli")
    assert brotli.decompress((VENDOR / f"{name}.br").read_bytes()) == (VENDOR / name).read_bytes()


def test_only_vendor_files_are_precompressed() -> None:
    """A compressed copy is served instead of its source, so it must never go stale."""
    copies = {p for p in FRONTEND.rglob("*") if p.suffix in (".gz", ".br")}
    assert copies == {VENDOR / f"{n}{s}" for n in VENDOR_FILES for s in (".gz", ".br")}


async def test_long_lived_files_are_cached_and_compressed(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_client
) -> None:
    client = await hass_client()
    resp = await client.get(
        f"{FRONTEND_URL}/vendor/maplibre-gl-6.11.2/maplibre-gl.mjs",
        headers={"Accept-Encoding": "gzip"},
    )
    assert resp.status == 200
    assert resp.headers["Content-Encoding"] == "gzip"
    assert resp.headers["Cache-Control"] == CACHE_HEADER
    assert "javascript" in resp.content_type
    assert await resp.read() == (VENDOR / "maplibre-gl.mjs").read_bytes()

    resp = await client.get(f"{FRONTEND_URL}/img/black-marble-2016-2048.jpg")
    assert resp.headers["Cache-Control"] == CACHE_HEADER
    resp = await client.get(f"{FRONTEND_URL}/sat-card.js")
    assert resp.status == 200
    assert "Cache-Control" not in resp.headers


async def test_sidebar_panel_follows_option(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    loaded = init_integration
    panel = hass.data[DATA_PANELS][PANEL_URL_PATH]
    assert panel.sidebar_title == "Satellite Spotter"
    assert panel.sidebar_icon == "mdi:satellite-variant"
    custom = panel.config["_panel_custom"]
    assert custom["name"] == "satellite-spotter-panel"
    assert custom["module_url"].startswith(f"{FRONTEND_URL}/sat-panel.js?v=")
    assert custom["embed_iframe"] is False
    # The panel pads itself for notches and the home indicator, where the
    # core lets it.
    expected = True if sat_frontend._PANEL_HANDLES_SAFE_AREA else None
    assert custom.get("handle_safe_area") is expected
    assert panel.require_admin is False

    # Reloading for any other change keeps the page, so nobody looking at it
    # is sent to the default dashboard.
    updates = async_capture_events(hass, EVENT_PANELS_UPDATED)
    hass.config_entries.async_update_entry(loaded, options={CONF_ALERT_LEAD_MINUTES: 20})
    await hass.async_block_till_done()
    hass.config_entries.async_update_entry(loaded, title="Back garden")
    await hass.async_block_till_done()
    assert loaded.state is ConfigEntryState.LOADED
    assert loaded.runtime_data.settings.alert_lead.total_seconds() == 20 * 60
    assert updates == []
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]

    hass.config_entries.async_update_entry(loaded, options={CONF_SHOW_PANEL: False})
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]

    hass.config_entries.async_update_entry(loaded, options={CONF_SHOW_PANEL: True})
    await hass.async_block_till_done()
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]

    # Disabling the location removes the page, enabling it brings it back.
    await hass.config_entries.async_set_disabled_by(loaded.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]
    await hass.config_entries.async_set_disabled_by(loaded.entry_id, None)
    await hass.async_block_till_done()
    assert loaded.state is ConfigEntryState.LOADED
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]

    await hass.config_entries.async_remove(loaded.entry_id)
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]


async def test_panel_while_setup_retries(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_pysatellitespotter: dict[str, AsyncMock],
    hass_ws_client,
) -> None:
    freezer.move_to(NOW)
    mock_pysatellitespotter["fetch_site_catalog"].side_effect = CatalogError("HTTP 500")
    mock_config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(mock_config_entry.entry_id)
    await hass.async_block_till_done()
    assert mock_config_entry.state is ConfigEntryState.SETUP_RETRY

    # The page is there, and says what it is waiting for.
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]
    client = await hass_ws_client(hass)
    for request in ({}, {"entry_id": mock_config_entry.entry_id}):
        await client.send_json_auto_id({"type": f"{DOMAIN}/passes", **request})
        msg = await client.receive_json()
        assert not msg["success"]
        assert msg["error"] == {"code": "not_ready", "message": "No satellite catalog: HTTP 500"}

    # Disabling a location that is not loaded runs none of its hooks; the
    # page still goes.
    await hass.config_entries.async_set_disabled_by(
        mock_config_entry.entry_id, ConfigEntryDisabler.USER
    )
    await hass.async_block_till_done()
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]
    await client.send_json_auto_id({"type": f"{DOMAIN}/passes"})
    msg = await client.receive_json()
    assert msg["error"] == {"code": "location_disabled", "message": "This location is disabled"}


async def test_disabled_location_says_so(
    hass: HomeAssistant, init_integration: MockConfigEntry, hass_ws_client
) -> None:
    """A card bound to a disabled location is told so, not to wait."""
    # (The locations are loaded before the websocket client signs in, so its
    # token is not issued "after" the frozen clock.)
    cabin = MockConfigEntry(domain=DOMAIN, title="Cabin", data=DENVER, unique_id=DENVER_ID)
    cabin.add_to_hass(hass)
    await hass.config_entries.async_setup(cabin.entry_id)
    await hass.async_block_till_done()
    assert init_integration.state is cabin.state is ConfigEntryState.LOADED
    await hass.config_entries.async_set_disabled_by(cabin.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()

    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/passes", "entry_id": cabin.entry_id})
    msg = await client.receive_json()
    assert msg["error"] == {"code": "location_disabled", "message": "This location is disabled"}

    # The card's retry recovers once the location is enabled again.
    await hass.config_entries.async_set_disabled_by(cabin.entry_id, None)
    await hass.async_block_till_done()
    await client.send_json_auto_id({"type": f"{DOMAIN}/passes", "entry_id": cabin.entry_id})
    msg = await client.receive_json()
    assert msg["success"]
    assert msg["result"]["location"]["title"] == "Cabin"


async def test_failed_setup_says_so(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_pysatellitespotter: dict[str, AsyncMock],
    hass_ws_client,
) -> None:
    """A location whose setup failed is told so, not to wait: waiting will not fix it."""
    freezer.move_to(NOW)
    mock_config_entry.add_to_hass(hass)
    # An unexpected error leaves no reason behind, only the log.
    with patch(
        "custom_components.satellite_spotter.SatelliteSpotterCoordinator",
        side_effect=RuntimeError("boom"),
    ):
        await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()
    assert mock_config_entry.state is ConfigEntryState.SETUP_ERROR

    client = await hass_ws_client(hass)
    for request in ({}, {"entry_id": mock_config_entry.entry_id}):
        await client.send_json_auto_id({"type": f"{DOMAIN}/passes", **request})
        msg = await client.receive_json()
        assert msg["error"] == {
            "code": "setup_failed",
            "message": "Setup failed; see the Home Assistant log",
        }

    # While another location is still on its way, a card that shows whichever
    # comes first waits for it.
    cabin = MockConfigEntry(domain=DOMAIN, title="Cabin", data=DENVER, unique_id=DENVER_ID)
    cabin.add_to_hass(hass)
    cabin.mock_state(hass, ConfigEntryState.SETUP_RETRY, "No satellite catalog: HTTP 500")
    await client.send_json_auto_id({"type": f"{DOMAIN}/passes"})
    msg = await client.receive_json()
    assert msg["error"] == {"code": "not_ready", "message": "No satellite catalog: HTTP 500"}


@pytest.mark.parametrize(
    ("state", "reason", "code", "message"),
    [
        (
            ConfigEntryState.MIGRATION_ERROR,
            None,
            "setup_failed",
            "Setup failed; see the Home Assistant log",
        ),
        (
            ConfigEntryState.FAILED_UNLOAD,
            "Unload failed",
            "setup_failed",
            "Unload failed; see the Home Assistant log",
        ),
        # Starting, or being reloaded.
        (ConfigEntryState.NOT_LOADED, None, "not_ready", "Starting up"),
        (ConfigEntryState.SETUP_IN_PROGRESS, None, "not_ready", "Starting up"),
        (ConfigEntryState.UNLOAD_IN_PROGRESS, None, "not_ready", "Starting up"),
    ],
)
async def test_waiting_only_for_locations_on_their_way(
    hass: HomeAssistant,
    mock_config_entry: MockConfigEntry,
    hass_ws_client,
    state: ConfigEntryState,
    reason: str | None,
    code: str,
    message: str,
) -> None:
    assert await async_setup_component(hass, DOMAIN, {})
    mock_config_entry.add_to_hass(hass)
    mock_config_entry.mock_state(hass, state, reason)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/passes"})
    msg = await client.receive_json()
    assert msg["error"] == {"code": code, "message": message}


async def test_existing_dashboard_keeps_its_address(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    mock_config_entry: MockConfigEntry,
    mock_pysatellitespotter: dict[str, AsyncMock],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A dashboard at /satellite-spotter must not stop the location from setting up."""
    hass_storage["lovelace_dashboards"] = {
        "version": 1,
        "minor_version": 1,
        "key": "lovelace_dashboards",
        "data": {
            "items": [
                {
                    "id": "satellites",
                    "url_path": PANEL_URL_PATH,
                    "title": "Satellites",
                    "icon": "mdi:satellite",
                    "show_in_sidebar": True,
                    "require_admin": False,
                    "mode": "storage",
                }
            ]
        },
    }
    assert await async_setup_component(hass, "lovelace", {})
    assert hass.data[DATA_PANELS][PANEL_URL_PATH].component_name == "lovelace"

    freezer.move_to(NOW)
    entry = mock_config_entry
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert hass.data[DATA_PANELS][PANEL_URL_PATH].component_name == "lovelace"
    assert caplog.text.count("is already used by another dashboard or panel") == 1

    # The location works: its sensors follow the first pass.
    first = entry.runtime_data.data.passes[0]
    await advance(hass, freezer, first.start.replace(microsecond=0) + (first.end - first.start) / 2)
    assert hass.states.get("binary_sensor.home_satellite_visible").state == "on"

    # Reloading and unloading leave the dashboard alone, without errors.
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED
    assert hass.data[DATA_PANELS][PANEL_URL_PATH].component_name == "lovelace"
    assert caplog.text.count("is already used by another dashboard or panel") == 1
