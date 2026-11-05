"""What the integration sets up with the frontend: files, the card, the panel and the repair."""

from __future__ import annotations

import gzip
import inspect
from pathlib import Path
import re
from typing import Any
from unittest.mock import AsyncMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.components import frontend, panel_custom
from homeassistant.config_entries import (
    SIGNAL_CONFIG_ENTRY_CHANGED,
    ConfigEntryChange,
    ConfigEntryDisabler,
    ConfigEntryState,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.setup import async_setup_component
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator

from custom_components.satellite_spotter import frontend as sat_frontend
from custom_components.satellite_spotter.celestrak import CatalogError
from custom_components.satellite_spotter.const import DOMAIN
from custom_components.satellite_spotter.frontend import (
    DATA_FRONTEND,
    FrontendState,
    _files_version,
    _loaded_entries,
    async_clear_stale_issue,
    async_update_panel,
)

from .common import DENVER, HONOLULU, NOW, add_location, set_options

PANEL = "satellite-spotter"
ISSUE = "catalog_stale"


def panel_of(hass: HomeAssistant) -> Any:
    return hass.data.get(frontend.DATA_PANELS, {}).get(PANEL)


def raise_issue(hass: HomeAssistant) -> None:
    ir.async_create_issue(
        hass,
        DOMAIN,
        ISSUE,
        is_fixable=False,
        severity=ir.IssueSeverity.WARNING,
        translation_key=ISSUE,
        translation_placeholders={"age": "20", "error": "no route"},
    )


def issue_there(hass: HomeAssistant) -> bool:
    return ir.async_get(hass).async_get_issue(DOMAIN, ISSUE) is not None


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


@pytest.fixture
async def integration(hass: HomeAssistant) -> None:
    """Start the integration with no locations at all."""
    assert await async_setup_component(hass, DOMAIN, {})
    await hass.async_block_till_done()


# Files.


async def test_modules_are_served_to_be_revalidated(
    hass: HomeAssistant, integration: None, hass_client: ClientSessionGenerator
) -> None:
    client = await hass_client()
    answer = await client.get("/satellite_spotter/frontend/sat-card.js")
    assert answer.status == 200
    assert "max-age" not in answer.headers.get("Cache-Control", "")


async def test_a_translation_of_the_page_is_served_to_be_revalidated(
    hass: HomeAssistant, integration: None, hass_client: ClientSessionGenerator
) -> None:
    client = await hass_client()
    answer = await client.get("/satellite_spotter/frontend/translations/de.json")
    assert answer.status == 200
    assert "max-age" not in answer.headers.get("Cache-Control", "")


async def test_maplibre_may_be_kept_as_its_folder_names_the_version(
    hass: HomeAssistant, integration: None, hass_client: ClientSessionGenerator
) -> None:
    client = await hass_client()
    answer = await client.get(
        "/satellite_spotter/frontend/vendor/maplibre-gl-6.11.2/maplibre-gl.css"
    )
    assert answer.status == 200
    assert "max-age" in answer.headers["Cache-Control"]
    assert "public" in answer.headers["Cache-Control"]


async def test_the_images_may_be_kept(
    hass: HomeAssistant, integration: None, hass_client: ClientSessionGenerator
) -> None:
    client = await hass_client()
    answer = await client.get("/satellite_spotter/frontend/img/black-marble-2016-2048.jpg")
    assert answer.status == 200
    assert "max-age" in answer.headers["Cache-Control"]


async def test_browsers_that_accept_them_get_the_precompressed_copies(
    hass: HomeAssistant, integration: None, hass_client: ClientSessionGenerator
) -> None:
    client = await hass_client()
    answer = await client.get(
        "/satellite_spotter/frontend/vendor/maplibre-gl-6.11.2/maplibre-gl.css",
        headers={"Accept-Encoding": "gzip"},
    )
    assert answer.status == 200
    assert answer.headers["Content-Encoding"] == "gzip"


async def test_a_module_the_release_compressed_is_served_compressed(
    hass: HomeAssistant,
    hass_client: ClientSessionGenerator,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "img").mkdir()
    (tmp_path / "vendor").mkdir()
    (tmp_path / "sat-card.js").write_text("// the card", encoding="utf-8")
    (tmp_path / "sat-card.js.gz").write_bytes(gzip.compress(b"// the card"))
    monkeypatch.setattr(sat_frontend, "FRONTEND_DIR", tmp_path)
    assert await async_setup_component(hass, "http", {})
    assert await async_setup_component(hass, DOMAIN, {})
    await hass.async_block_till_done()
    client = await hass_client()
    answer = await client.get(
        "/satellite_spotter/frontend/sat-card.js", headers={"Accept-Encoding": "gzip"}
    )
    assert answer.status == 200
    assert answer.headers["Content-Encoding"] == "gzip"
    assert await answer.text() == "// the card"
    # Still revalidated, as the modules are.
    assert "max-age" not in answer.headers.get("Cache-Control", "")


async def test_a_missing_file_is_not_found(
    hass: HomeAssistant, integration: None, hass_client: ClientSessionGenerator
) -> None:
    client = await hass_client()
    answer = await client.get("/satellite_spotter/frontend/no-such-file.js")
    assert answer.status == 404


async def test_the_card_is_loaded_on_every_dashboard_by_its_versioned_address(
    hass: HomeAssistant, integration: None
) -> None:
    version = hass.data[DATA_FRONTEND].version
    assert re.fullmatch(r"[0-9a-f]{12}", version)
    assert (
        f"/satellite_spotter/frontend/sat-card.js?v={version}"
        in hass.data[frontend.DATA_EXTRA_MODULE_URL].urls
    )


async def test_the_page_and_the_cards_can_talk_to_the_integration(
    hass: HomeAssistant, integration: None
) -> None:
    commands = hass.data["websocket_api"]
    for name in ("locations", "passes", "pass_track", "track", "positions", "catalog", "street"):
        assert f"satellite_spotter/{name}" in commands


async def test_the_frontend_is_set_up_with_or_without_a_location(
    hass: HomeAssistant, integration: None
) -> None:
    state = hass.data[DATA_FRONTEND]
    assert isinstance(state, FrontendState)
    assert state.panel_registered is False
    assert state.panel_conflict_logged is False
    assert state.catalog is None
    assert panel_of(hass) is None


async def test_the_version_is_of_the_files_in_the_folder(
    hass: HomeAssistant, integration: None
) -> None:
    assert hass.data[DATA_FRONTEND].version == await hass.async_add_executor_job(_files_version)


def _build_frontend(folder: Path) -> None:
    (folder / "translations").mkdir()
    (folder / "img").mkdir()
    (folder / "sat-card.js").write_text("card")
    (folder / "sat-panel.js").write_text("panel")
    (folder / "translations" / "de.json").write_text("{}")
    (folder / "img" / "earth.jpg").write_text("earth")
    (folder / ".DS_Store").write_text("junk")


def _version_of(folder: Path) -> str:
    with patch.object(sat_frontend, "FRONTEND_DIR", folder):
        return _files_version()


def test_the_version_changes_with_a_module(tmp_path: Path) -> None:
    _build_frontend(tmp_path)
    before = _version_of(tmp_path)
    assert _version_of(tmp_path) == before
    (tmp_path / "sat-panel.js").write_text("panel 2")
    assert _version_of(tmp_path) != before


def test_the_version_changes_with_a_translation(tmp_path: Path) -> None:
    _build_frontend(tmp_path)
    before = _version_of(tmp_path)
    (tmp_path / "translations" / "de.json").write_text('{"a": "b"}')
    assert _version_of(tmp_path) != before


def test_the_version_changes_with_a_new_file_or_a_new_name(tmp_path: Path) -> None:
    _build_frontend(tmp_path)
    before = _version_of(tmp_path)
    (tmp_path / "sat-panel.js").rename(tmp_path / "sat-renamed.js")
    assert _version_of(tmp_path) != before


def test_the_version_ignores_hidden_files_and_the_folders_never_revalidated(
    tmp_path: Path,
) -> None:
    _build_frontend(tmp_path)
    before = _version_of(tmp_path)
    (tmp_path / ".DS_Store").write_text("other junk")
    (tmp_path / "img" / "earth.jpg").write_text("another earth")
    assert _version_of(tmp_path) == before


# The panel.


async def test_a_location_brings_the_page_described_as_it_should_be(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    panel = panel_of(hass).to_response()
    version = hass.data[DATA_FRONTEND].version
    assert panel["component_name"] == "custom"
    assert panel["title"] == "Satellite Spotter"
    assert panel["icon"] == "mdi:satellite-variant"
    assert panel["url_path"] == PANEL
    assert panel["require_admin"] is False
    custom = panel["config"]["_panel_custom"]
    assert custom["name"] == "satellite-spotter-panel"
    assert custom["module_url"] == f"/satellite_spotter/frontend/sat-panel.js?v={version}"
    assert custom["embed_iframe"] is False
    assert panel["config"]["version"] == version
    assert hass.data[DATA_FRONTEND].panel_registered is True


@pytest.mark.skipif(
    "handle_safe_area" not in inspect.signature(panel_custom.async_register_panel).parameters,
    reason="Home Assistant before this option does not pad panels for the screen's safe areas",
)
async def test_the_page_handles_the_screens_safe_areas_itself(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    assert panel_of(hass).to_response()["config"]["_panel_custom"]["handle_safe_area"] is True


async def test_a_core_without_the_safe_area_option_is_not_passed_it(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    with (
        patch.object(sat_frontend, "_PANEL_HANDLES_SAFE_AREA", False),
        patch.object(panel_custom, "async_register_panel", AsyncMock()) as register,
    ):
        await add_location(hass)
    assert "handle_safe_area" not in register.call_args.kwargs


async def test_the_option_off_brings_no_page(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    await add_location(hass, options={"show_in_sidebar": False})
    assert panel_of(hass) is None


async def test_one_location_wanting_the_page_is_enough(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    await add_location(hass, HONOLULU, options={"show_in_sidebar": False})
    assert panel_of(hass) is None
    await add_location(hass, DENVER, title="Cabin", options={"show_in_sidebar": True})
    assert panel_of(hass) is not None


async def test_the_page_stays_until_no_location_wants_it(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU)
    cabin = await add_location(hass, DENVER, title="Cabin")
    await set_options(hass, home, {"show_in_sidebar": False})
    assert panel_of(hass) is not None
    await set_options(hass, cabin, {"show_in_sidebar": False})
    assert panel_of(hass) is None
    assert hass.data[DATA_FRONTEND].panel_registered is False
    await set_options(hass, home, {"show_in_sidebar": True})
    assert panel_of(hass) is not None
    assert hass.data[DATA_FRONTEND].panel_registered is True


async def test_the_page_stays_through_an_unload_as_the_location_is_still_enabled(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    await hass.config_entries.async_unload(init_integration.entry_id)
    await hass.async_block_till_done()
    assert panel_of(hass) is not None


async def test_a_location_retrying_setup_brings_the_page(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    assert panel_of(hass) is not None


async def test_disabling_a_loaded_location_takes_the_page_and_enabling_brings_it_back(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    await hass.config_entries.async_set_disabled_by(
        init_integration.entry_id, ConfigEntryDisabler.USER
    )
    await hass.async_block_till_done()
    assert panel_of(hass) is None
    await hass.config_entries.async_set_disabled_by(init_integration.entry_id, None)
    await hass.async_block_till_done()
    assert panel_of(hass) is not None


async def test_disabling_a_location_still_retrying_takes_the_page_and_the_repair(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    # frontend.py: this runs none of the integration's hooks, so the signal has to do it.
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass)
    raise_issue(hass)
    await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert panel_of(hass) is None
    assert not issue_there(hass)


async def test_a_disabled_location_wanting_the_page_does_not_count(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    await add_location(hass, HONOLULU, options={"show_in_sidebar": False})
    await add_location(hass, DENVER, title="Cabin", disabled_by=ConfigEntryDisabler.USER)
    assert panel_of(hass) is None


async def test_removing_the_last_location_wanting_the_page_takes_it(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU)
    await add_location(hass, DENVER, title="Cabin", options={"show_in_sidebar": False})
    await hass.config_entries.async_remove(home.entry_id)
    await hass.async_block_till_done()
    assert panel_of(hass) is None


async def test_an_entry_being_added_counts_before_it_is_listed(
    hass: HomeAssistant, integration: None
) -> None:
    new = MockConfigEntry(domain=DOMAIN, data=dict(HONOLULU))
    await async_update_panel(hass, adding=new)
    assert panel_of(hass) is not None


async def test_an_entry_already_listed_is_counted_once_and_wanting_is_what_matters(
    hass: HomeAssistant, integration: None
) -> None:
    listed = MockConfigEntry(domain=DOMAIN, data=dict(HONOLULU), options={"show_in_sidebar": False})
    listed.add_to_hass(hass)
    await async_update_panel(hass, adding=listed)
    assert panel_of(hass) is None


async def test_an_entry_being_removed_no_longer_counts_though_still_listed(
    hass: HomeAssistant, integration: None
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data=dict(HONOLULU))
    entry.add_to_hass(hass)
    await async_update_panel(hass, adding=entry)
    assert panel_of(hass) is not None
    await async_update_panel(hass, removing=entry)
    assert panel_of(hass) is None


async def test_before_the_frontend_is_set_up_there_is_nothing_to_do(hass: HomeAssistant) -> None:
    await async_update_panel(hass, adding=MockConfigEntry(domain=DOMAIN, data=dict(HONOLULU)))
    assert panel_of(hass) is None


async def test_updating_the_panel_twice_registers_it_once(
    hass: HomeAssistant, integration: None
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data=dict(HONOLULU))
    entry.add_to_hass(hass)
    with patch.object(
        panel_custom, "async_register_panel", wraps=panel_custom.async_register_panel
    ) as register:
        await async_update_panel(hass)
        await async_update_panel(hass)
    assert register.call_count == 1


async def test_with_no_page_there_is_nothing_to_remove(
    hass: HomeAssistant, integration: None
) -> None:
    with patch.object(frontend, "async_remove_panel") as remove:
        await async_update_panel(hass)
    remove.assert_not_called()


async def test_only_loaded_locations_count_as_loaded(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU)
    await add_location(hass, DENVER, title="Cabin", disabled_by=ConfigEntryDisabler.USER)
    assert _loaded_entries(hass) == [home]


# Someone else at the address.


async def _another_dashboard(hass: HomeAssistant) -> Any:
    await async_setup_component(hass, "frontend", {})
    frontend.async_register_built_in_panel(hass, "lovelace", frontend_url_path=PANEL)
    return panel_of(hass)


async def test_another_panel_at_the_address_is_left_alone_with_a_warning_once(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], caplog: pytest.LogCaptureFixture
) -> None:
    other = await _another_dashboard(hass)
    home = await add_location(hass, HONOLULU)
    cabin = await add_location(hass, DENVER, title="Cabin")
    assert home.state is ConfigEntryState.LOADED
    assert cabin.state is ConfigEntryState.LOADED
    assert panel_of(hass) is other
    assert caplog.text.count("is already used by another dashboard or panel") == 1
    state = hass.data[DATA_FRONTEND]
    assert state.panel_registered is False
    assert state.panel_conflict_logged is True


async def test_another_panel_at_the_address_stays_when_the_last_location_goes(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    other = await _another_dashboard(hass)
    entry = await add_location(hass)
    await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert panel_of(hass) is other


async def test_a_location_not_wanting_the_page_is_no_conflict(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], caplog: pytest.LogCaptureFixture
) -> None:
    await _another_dashboard(hass)
    await add_location(hass, options={"show_in_sidebar": False})
    assert "already used" not in caplog.text


async def test_home_assistant_refusing_the_page_is_a_warning_not_a_failure(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], caplog: pytest.LogCaptureFixture
) -> None:
    with patch.object(
        panel_custom, "async_register_panel", AsyncMock(side_effect=ValueError("no way"))
    ):
        entry = await add_location(hass)
    assert entry.state is ConfigEntryState.LOADED
    assert "Could not add the Satellite Spotter sidebar page: no way" in caplog.text
    assert hass.data[DATA_FRONTEND].panel_registered is False


async def test_the_page_can_be_added_later_after_being_refused(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    with patch.object(
        panel_custom, "async_register_panel", AsyncMock(side_effect=ValueError("no way"))
    ):
        entry = await add_location(hass)
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert panel_of(hass) is not None


# The repair issue.


async def test_the_repair_goes_when_no_enabled_location_is_left(
    hass: HomeAssistant, integration: None
) -> None:
    raise_issue(hass)
    async_clear_stale_issue(hass)
    assert not issue_there(hass)


async def test_the_repair_stays_while_an_enabled_location_is_left(
    hass: HomeAssistant, integration: None
) -> None:
    MockConfigEntry(domain=DOMAIN, data=dict(HONOLULU)).add_to_hass(hass)
    raise_issue(hass)
    async_clear_stale_issue(hass)
    assert issue_there(hass)


async def test_the_repair_goes_when_only_disabled_locations_are_left(
    hass: HomeAssistant, integration: None
) -> None:
    MockConfigEntry(
        domain=DOMAIN, data=dict(HONOLULU), disabled_by=ConfigEntryDisabler.USER
    ).add_to_hass(hass)
    raise_issue(hass)
    async_clear_stale_issue(hass)
    assert not issue_there(hass)


async def test_disabling_one_of_two_leaves_the_repair_and_disabling_both_clears_it(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU)
    cabin = await add_location(hass, DENVER, title="Cabin")
    raise_issue(hass)
    await hass.config_entries.async_set_disabled_by(home.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert issue_there(hass)
    assert panel_of(hass) is not None
    await hass.config_entries.async_set_disabled_by(cabin.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert not issue_there(hass)
    assert panel_of(hass) is None


async def test_another_integrations_entry_changing_touches_nothing(
    hass: HomeAssistant, integration: None
) -> None:
    raise_issue(hass)
    other = MockConfigEntry(domain="other", data={}, disabled_by=ConfigEntryDisabler.USER)
    with patch.object(sat_frontend, "async_update_panel", AsyncMock()) as update_panel:
        async_dispatcher_send(hass, SIGNAL_CONFIG_ENTRY_CHANGED, ConfigEntryChange.UPDATED, other)
        await hass.async_block_till_done()
    update_panel.assert_not_awaited()
    assert issue_there(hass)


async def test_an_enabled_location_changing_touches_nothing(
    hass: HomeAssistant, integration: None
) -> None:
    raise_issue(hass)
    entry = MockConfigEntry(domain=DOMAIN, data=dict(HONOLULU))
    with patch.object(sat_frontend, "async_update_panel", AsyncMock()) as update_panel:
        async_dispatcher_send(hass, SIGNAL_CONFIG_ENTRY_CHANGED, ConfigEntryChange.UPDATED, entry)
        await hass.async_block_till_done()
    update_panel.assert_not_awaited()
    assert issue_there(hass)
