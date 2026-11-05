"""Predictions kept up to date through Home Assistant: refreshes, wake-ups and repairs."""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta
import logging
from unittest.mock import AsyncMock, MagicMock, patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import UpdateFailed
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.catalog import CatalogManager, async_shared_catalog
from custom_components.satellite_spotter.celestrak import CatalogError, DownloadRefused
from custom_components.satellite_spotter.const import CONF_ALERT_LEAD_MINUTES, DOMAIN
from custom_components.satellite_spotter.coordinator import (
    ListedPass,
    Predictions,
    PredictionSettings,
    SatelliteSpotterCoordinator,
    predict_passes,
    scrub,
)
from custom_components.satellite_spotter.predict import Satellite
from custom_components.satellite_spotter.track import Observer
from custom_components.satellite_spotter.weather import CloudCoverError, CloudForecast

from .common import (
    DENVER,
    HONOLULU,
    NOW,
    add_location,
    advance,
    aged,
    bright_pass,
    cloud_percent,
    dim_pass,
    forecast_of,
    listed,
    satellites,
    set_options,
    sighting,
    with_epoch,
)

SECOND = timedelta(seconds=1)
ISSUE = "catalog_stale"
LOGGER_NAME = "custom_components.satellite_spotter.coordinator"


def predictions_of(*passes: ListedPass) -> Predictions:
    return Predictions(
        passes=list(passes),
        searched_at=NOW,
        catalog_version=1,
        satellites={},
        cloud_forecast=None,
    )


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


# Which pass is which, moment by moment.


def test_the_next_pass_is_the_one_under_way_until_it_ends() -> None:
    first = dim_pass(NOW + timedelta(hours=1))
    second = dim_pass(NOW + timedelta(hours=2))
    data = predictions_of(first, second)
    assert data.next_visible_pass(NOW) is first
    assert data.next_visible_pass(first.start) is first
    assert data.next_visible_pass(first.end - SECOND) is first
    assert data.next_visible_pass(first.end) is second
    assert data.next_visible_pass(second.end) is None


def test_the_next_bright_pass_skips_the_rest() -> None:
    dim = dim_pass(NOW + timedelta(hours=1))
    bright = bright_pass(NOW + timedelta(hours=2))
    later_dim = dim_pass(NOW + timedelta(hours=3))
    data = predictions_of(dim, bright, later_dim)
    assert data.next_bright_pass(NOW) is bright
    assert data.next_bright_pass(bright.end - SECOND) is bright
    assert data.next_bright_pass(bright.end) is None


def test_under_way_is_from_the_start_up_to_the_end() -> None:
    p = dim_pass(NOW + timedelta(hours=1))
    data = predictions_of(p)
    assert data.under_way(p.start - SECOND) is None
    assert data.under_way(p.start) is p
    assert data.under_way(p.end - SECOND) is p
    assert data.under_way(p.end) is None


def test_upcoming_has_what_is_under_way_and_what_starts_within_the_window() -> None:
    over = dim_pass(NOW - timedelta(minutes=30))
    under_way = dim_pass(NOW - timedelta(minutes=1))
    last_in = dim_pass(NOW + timedelta(hours=24))
    first_out = dim_pass(NOW + timedelta(hours=24) + SECOND)
    data = predictions_of(over, under_way, last_in, first_out)
    assert data.upcoming(NOW) == [under_way, last_in]


def test_upcoming_drops_a_pass_the_moment_it_ends() -> None:
    p = dim_pass(NOW)
    data = predictions_of(p)
    assert data.upcoming(p.end - SECOND) == [p]
    assert data.upcoming(p.end) == []


def test_upcoming_takes_another_window() -> None:
    p = dim_pass(NOW + timedelta(hours=1))
    data = predictions_of(p)
    assert data.upcoming(NOW, timedelta(hours=1)) == [p]
    assert data.upcoming(NOW, timedelta(hours=1) - SECOND) == []


def test_the_changes_of_a_bright_pass_come_in_order() -> None:
    p = bright_pass(NOW + timedelta(days=2))
    lead = timedelta(minutes=15)
    data = predictions_of(p)
    assert data.next_change(NOW, lead) == p.start - timedelta(hours=24)
    assert data.next_change(p.start - timedelta(hours=24), lead) == p.start - lead
    assert data.next_change(p.start - lead, lead) == p.start
    assert data.next_change(p.start, lead) == p.end
    assert data.next_change(p.end, lead) is None


def test_a_dim_pass_has_a_notice_to_wake_for_too() -> None:
    p = dim_pass(NOW + timedelta(hours=1))
    data = predictions_of(p)
    assert data.next_change(NOW, timedelta(minutes=15)) == p.start - timedelta(minutes=15)


def test_no_passes_means_no_changes() -> None:
    assert predictions_of().next_change(NOW, timedelta(minutes=15)) is None


def test_the_notice_counts_from_the_bright_satellite_not_the_start_of_the_pass() -> None:
    # CHANGELOG 1.10: in a big group the bright satellite can appear long after the start.
    start = NOW + timedelta(hours=2)
    early = sighting(start, 600, name="DEBRIS", norad_id=1, peak_magnitude=1.8)
    bright = sighting(start + timedelta(minutes=8), 100, peak_magnitude=-2.0)
    p = listed(early, bright)
    assert p.start == start
    assert p.lead.satellite.name == "ISS"
    assert p.notice_at(timedelta(minutes=15)) == start + timedelta(minutes=8 - 15)
    data = predictions_of(p)
    assert data.next_change(NOW, timedelta(minutes=15)) == start - timedelta(minutes=7)


def test_find_takes_the_exact_id() -> None:
    p = dim_pass(NOW)
    assert predictions_of(p).find(p.id) is p


@pytest.mark.parametrize(
    ("offset", "found"),
    [(-120, True), (120, True), (-121, False), (121, False), (1, True)],
)
def test_find_forgives_an_old_id_by_up_to_two_minutes(offset: int, found: bool) -> None:
    # A refresh can shift a pass by a few seconds; PASS_ID_TOLERANCE is 120 seconds.
    p = dim_pass(NOW)
    answer = predictions_of(p).find(str(int(p.start.timestamp()) + offset))
    assert answer is (p if found else None)


def test_find_takes_the_nearest_of_two() -> None:
    first = dim_pass(NOW)
    second = dim_pass(NOW + timedelta(seconds=100))
    data = predictions_of(first, second)
    assert data.find(str(int(NOW.timestamp()) + 30)) is first
    assert data.find(str(int(NOW.timestamp()) + 70)) is second


@pytest.mark.parametrize("nonsense", ["abc", "", "1.5", "1" + "0" * 400])
def test_find_makes_nothing_of_nonsense(nonsense: str) -> None:
    assert predictions_of(dim_pass(NOW)).find(nonsense) is None


def test_find_finds_nothing_among_nothing() -> None:
    assert predictions_of().find(str(int(NOW.timestamp()))) is None


def test_the_index_is_by_id() -> None:
    p = dim_pass(NOW)
    assert predictions_of(p).by_id == {p.id: p}


# Settings.


def test_settings_default_as_documented() -> None:
    # README, Options.
    settings = PredictionSettings.from_options({})
    assert settings == PredictionSettings(
        brightness_cutoff=2.25,
        cloud_forecast=True,
        alert_lead=timedelta(minutes=15),
        show_in_calendar=True,
        units="auto",
    )


def test_settings_follow_the_options() -> None:
    settings = PredictionSettings.from_options(
        {
            "brightness_cutoff": 1.0,
            "cloud_forecast": False,
            "alert_lead_minutes": 240,
            "show_in_calendar": False,
            "units": "imperial",
        }
    )
    assert settings == PredictionSettings(
        brightness_cutoff=1.0,
        cloud_forecast=False,
        alert_lead=timedelta(hours=4),
        show_in_calendar=False,
        units="imperial",
    )


def test_settings_cannot_be_changed_in_place() -> None:
    # They say how a location was set up, which its unload relies on.
    settings = PredictionSettings.from_options({})
    with pytest.raises(FrozenInstanceError):
        settings.units = "metric"  # type: ignore[misc]


# Scrubbing.


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "No https://api.open-meteo.com/v1/forecast?latitude=21.3&longitude=-157.8 now",
            "No https://api.open-meteo.com/v1/forecast now",
        ),
        ("https://example.org/a#key=secret", "https://example.org/a"),
        (
            "url='https://a.example/x?key=1', other http://b.example/y?k=2",
            "url='https://a.example/x', other http://b.example/y",
        ),
        ('"wss://a.example/?token=abc" failed', '"wss://a.example/" failed'),
        ("plain words about a? question", "plain words about a? question"),
        ("https://example.org/no/query", "https://example.org/no/query"),
    ],
)
def test_scrub_takes_the_query_out_of_any_url(text: str, expected: str) -> None:
    assert scrub(ValueError(text)) == expected


def test_scrub_names_an_error_without_words() -> None:
    assert scrub(TimeoutError()) == "TimeoutError"


# Listing what the search found.


def _honolulu() -> Observer:
    return Observer(21.3069, -157.8583, 5.0)


def test_a_listed_pass_has_its_id_clouds_and_highest_point() -> None:
    catalog = satellites()
    start = NOW + timedelta(minutes=9, seconds=12)
    iss = next(sat for sat in catalog if sat.name == "ISS")
    tiangong = next(sat for sat in catalog if sat.name == "Tiangong")
    sightings = [sighting(start, 240), sighting(start, 240, name="Tiangong", norad_id=48274)]
    sightings[0].satellite = iss
    sightings[1].satellite = tiangong
    forecast = CloudForecast({(int(start.timestamp()) // 3600 + 1) * 3600: 33})
    with_mock = MagicMock(return_value=sightings)
    with patch("custom_components.satellite_spotter.coordinator.find_sightings", with_mock):
        passes = predict_passes(catalog, _honolulu(), start=NOW, faintest=2.25, forecast=forecast)
    assert len(passes) == 1
    p = passes[0]
    assert p.id == str(int(start.timestamp()))
    assert p.cloud_cover == 33
    assert len(p.shapes) == 2
    assert p.peak.elevation == max(shape.peak.elevation for shape in p.shapes)
    with_mock.assert_called_once()
    assert with_mock.call_args.kwargs == {"start": NOW, "faintest": 2.25}


def test_a_listed_pass_has_no_clouds_without_a_forecast() -> None:
    catalog = satellites()
    passes = predict_passes(catalog, _honolulu(), start=NOW, faintest=2.25, forecast=None)
    assert passes
    assert all(p.cloud_cover is None for p in passes)


def test_a_forecast_with_a_gap_leaves_that_pass_without_clouds() -> None:
    catalog = satellites()
    passes = predict_passes(
        catalog, _honolulu(), start=NOW, faintest=2.25, forecast=CloudForecast({})
    )
    assert passes
    assert all(p.cloud_cover is None for p in passes)


def test_a_listed_pass_has_the_shapes_of_at_most_sixty_sightings() -> None:
    iss = next(sat for sat in satellites() if sat.name == "ISS")
    start = NOW + timedelta(minutes=9, seconds=12)
    many = [sighting(start, 240) for _ in range(61)]
    for one in many:
        one.satellite = iss
    with patch(
        "custom_components.satellite_spotter.coordinator.find_sightings",
        MagicMock(return_value=many),
    ):
        passes = predict_passes([iss], _honolulu(), start=NOW, faintest=2.25, forecast=None)
    assert passes[0].count == 61
    assert len(passes[0].shapes) == 60


# Refreshing.


async def test_a_refresh_every_hour_updates_the_clouds_without_searching_again(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    await add_location(hass)
    assert predict_passes.call_count == 1
    assert mock_downloads["fetch_forecast"].await_count == 1

    await advance(hass, freezer, NOW + timedelta(hours=1) - SECOND)
    assert mock_downloads["fetch_forecast"].await_count == 1

    await advance(hass, freezer, NOW + timedelta(hours=1))
    assert predict_passes.call_count == 1
    assert mock_downloads["fetch_forecast"].await_count == 2


async def test_the_clouds_change_on_the_passes_of_the_search_already_done(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    entry = await add_location(hass)
    before = entry.runtime_data.predictions
    later = before.passes[-1]
    hour = (int(later.start.timestamp()) // 3600 + 1) * 3600
    mock_downloads["fetch_forecast"].return_value = CloudForecast({hour: 77})
    refresh = NOW + timedelta(hours=1)

    await advance(hass, freezer, refresh)

    after = entry.runtime_data.predictions
    assert after is not before
    assert after.searched_at == before.searched_at == NOW
    assert after.satellites is before.satellites
    assert after.cloud_forecast is True
    ids = [p.id for p in before.passes if p.end > refresh - timedelta(minutes=5)]
    assert [p.id for p in after.passes] == ids
    assert after.by_id[later.id].cloud_cover == 77
    assert after.passes[0].cloud_cover is None
    assert after.by_id[later.id] is after.passes[-1]
    # What the entities say follows at once.
    assert hass.states.get("sensor.home_next_visible_pass").attributes["upcoming"]


async def test_a_refresh_keeps_a_pass_that_just_ended_and_drops_what_is_long_over(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    refresh = NOW + timedelta(hours=1)
    gone = dim_pass(refresh - timedelta(minutes=5) - timedelta(seconds=60), 60, name="GONE")
    recent = dim_pass(refresh - timedelta(minutes=5) - timedelta(seconds=59), 60, name="RECENT")
    predict_passes.return_value = [gone, recent]
    entry = await add_location(hass)
    await advance(hass, freezer, refresh)
    assert [p.title for p in entry.runtime_data.predictions.passes] == ["RECENT"]


async def test_a_new_catalog_brings_a_new_search_on_a_rolling_window(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    await add_location(hass)
    await advance(hass, freezer, NOW + timedelta(hours=11))
    assert predict_passes.call_count == 1

    later = NOW + timedelta(hours=12)
    await advance(hass, freezer, later)
    assert mock_downloads["fetch_catalog"].await_count == 2
    assert predict_passes.call_count == 2
    assert predict_passes.call_args.kwargs["start"] == later - timedelta(minutes=5)


async def test_the_window_keeps_rolling_without_a_new_catalog(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    await advance(hass, freezer, NOW + timedelta(hours=11))
    assert predict_passes.call_count == 1
    await advance(hass, freezer, NOW + timedelta(hours=12))
    assert predict_passes.call_count == 2


async def test_a_clock_set_back_brings_a_new_search(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    entry = await add_location(hass)
    freezer.move_to(NOW - timedelta(hours=1))
    await entry.runtime_data.async_refresh()
    assert predict_passes.call_count == 2


async def test_the_search_starts_five_minutes_back_on_a_whole_minute(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    freezer.move_to(NOW + timedelta(seconds=42, microseconds=5))
    await add_location(hass)
    assert predict_passes.call_args.kwargs["start"] == NOW - timedelta(minutes=5)


async def test_the_search_is_for_the_place_cutoff_and_forecast_of_the_location(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    entry = await add_location(hass, DENVER, options={"brightness_cutoff": 1.0})
    (found_in, observer), kwargs = predict_passes.call_args
    assert len(found_in) == len(satellites())
    assert observer is entry.runtime_data.observer
    assert kwargs["faintest"] == 1.0
    assert kwargs["forecast"] == forecast_of([])


async def test_the_forecast_is_asked_with_the_shared_session_and_the_place(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    await add_location(hass, DENVER)
    mock_downloads["fetch_forecast"].assert_awaited_once_with(
        async_get_clientsession(hass), DENVER["latitude"], DENVER["longitude"]
    )


async def test_predictions_say_what_they_came_from(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    coordinator: SatelliteSpotterCoordinator = init_integration.runtime_data
    data = coordinator.predictions
    assert data is not None
    assert data.searched_at == NOW
    assert data.catalog_version == coordinator.catalog.version == int(NOW.timestamp())
    assert data.satellites is coordinator.catalog.by_id()
    assert data.cloud_forecast is True


async def test_each_pass_has_the_cloud_cover_of_the_hour_after_it_starts(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    data = init_integration.runtime_data.predictions
    assert data.passes
    for p in data.passes:
        assert p.cloud_cover == cloud_percent((int(p.start.timestamp()) // 3600 + 1) * 3600)


async def test_the_forecast_switched_off_is_not_asked_for(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass, options={"cloud_forecast": False})
    mock_downloads["fetch_forecast"].assert_not_awaited()
    data = entry.runtime_data.predictions
    assert data.cloud_forecast is None
    assert data.passes
    assert all(p.cloud_cover is None for p in data.passes)


async def test_a_forecast_failure_costs_only_the_clouds_and_leaks_nothing(
    hass: HomeAssistant,
    mock_downloads: dict[str, AsyncMock],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG, logger=LOGGER_NAME)
    mock_downloads["fetch_forecast"].side_effect = CloudCoverError(
        "500, url='https://api.open-meteo.com/v1/forecast?latitude=21.3069&longitude=-157.8583'"
    )
    entry = await add_location(hass)
    coordinator = entry.runtime_data
    assert coordinator.last_update_success
    data = coordinator.predictions
    assert data.cloud_forecast is False
    assert data.passes
    assert all(p.cloud_cover is None for p in data.passes)
    assert "No cloud cover forecast" in caplog.text
    assert "https://api.open-meteo.com/v1/forecast" in caplog.text
    assert "21.3069" not in caplog.text
    assert "157.8583" not in caplog.text


async def test_a_forecast_that_answers_again_brings_the_clouds_back(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_forecast"].side_effect = CloudCoverError("down")
    entry = await add_location(hass)
    mock_downloads["fetch_forecast"].side_effect = None
    await advance(hass, freezer, NOW + timedelta(hours=1))
    assert entry.runtime_data.predictions.cloud_forecast is True
    assert any(p.cloud_cover is not None for p in entry.runtime_data.predictions.passes)


async def test_a_forecast_that_stops_answering_is_kept_for_six_hours(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass)
    first = entry.runtime_data.predictions.passes[-1]
    assert first.cloud_cover is not None
    mock_downloads["fetch_forecast"].side_effect = CloudCoverError("down")

    await advance(hass, freezer, NOW + timedelta(hours=6))
    data = entry.runtime_data.predictions
    assert data.cloud_forecast is True
    assert next(p for p in data.passes if p.id == first.id).cloud_cover == first.cloud_cover

    await advance(hass, freezer, NOW + timedelta(hours=7))
    data = entry.runtime_data.predictions
    assert data.cloud_forecast is False
    assert all(p.cloud_cover is None for p in data.passes)


# A catalog from elsewhere.


async def test_a_new_catalog_refreshes_every_location(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU)
    cabin = await add_location(hass, DENVER, title="Cabin")
    asked = mock_downloads["fetch_forecast"].await_count
    manager = home.runtime_data.catalog

    freezer.move_to(NOW + timedelta(hours=12))
    await manager.async_satellites()
    await hass.async_block_till_done(wait_background_tasks=True)

    assert manager.version == int((NOW + timedelta(hours=12)).timestamp())
    assert mock_downloads["fetch_forecast"].await_count == asked + 2
    assert home.runtime_data.predictions.catalog_version == manager.version
    assert cabin.runtime_data.predictions.catalog_version == manager.version


async def test_a_location_downloading_for_itself_refreshes_only_the_others(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU)
    asked = mock_downloads["fetch_forecast"].await_count
    freezer.move_to(NOW + timedelta(hours=12))
    await home.runtime_data.async_refresh()
    await hass.async_block_till_done(wait_background_tasks=True)
    assert home.runtime_data.catalog.version == int((NOW + timedelta(hours=12)).timestamp())
    assert mock_downloads["fetch_forecast"].await_count == asked + 1


async def test_predictions_already_on_this_catalog_are_not_redone(
    hass: HomeAssistant, init_integration: MockConfigEntry, mock_downloads: dict[str, AsyncMock]
) -> None:
    asked = mock_downloads["fetch_forecast"].await_count
    init_integration.runtime_data._async_new_catalog()
    await hass.async_block_till_done(wait_background_tasks=True)
    assert mock_downloads["fetch_forecast"].await_count == asked


async def test_an_unloaded_location_hears_no_more_of_new_catalogs(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    home = await add_location(hass, HONOLULU)
    cabin = await add_location(hass, DENVER, title="Cabin")
    manager = home.runtime_data.catalog
    await hass.config_entries.async_unload(home.entry_id)
    await hass.async_block_till_done()
    asked = mock_downloads["fetch_forecast"].await_count

    freezer.move_to(NOW + timedelta(hours=12))
    await manager.async_satellites()
    await hass.async_block_till_done(wait_background_tasks=True)

    assert mock_downloads["fetch_forecast"].await_count == asked + 1
    assert cabin.runtime_data.predictions.catalog_version == manager.version


async def test_unloading_leaves_no_listener_behind_and_reloading_only_one(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass)
    manager = entry.runtime_data.catalog
    assert len(manager._listeners) == 1
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert len(manager._listeners) == 1
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert manager._listeners == []


async def test_a_coordinator_with_no_data_yet_takes_any_new_catalog(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], catalog: list[Satellite]
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    manager = CatalogManager(hass)
    coordinator = SatelliteSpotterCoordinator(hass, entry, manager)
    await manager.async_satellites()
    await hass.async_block_till_done(wait_background_tasks=True)
    assert coordinator.predictions is not None
    assert coordinator.predictions.catalog_version == manager.version
    await coordinator.async_shutdown()


# Waking the entities.


async def test_listeners_wake_a_second_after_each_change_and_only_then(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    start = NOW + timedelta(minutes=30)
    p = bright_pass(start)
    predict_passes.return_value = [p]
    entry = await add_location(hass)
    woken = MagicMock()
    entry.async_on_unload(entry.runtime_data.async_add_listener(woken))

    for count, moment in enumerate((start - timedelta(minutes=15), start, p.end), start=1):
        await advance(hass, freezer, moment)
        assert woken.call_count == count - 1, f"too early for {moment}"
        await advance(hass, freezer, moment + SECOND)
        assert woken.call_count == count, f"not woken for {moment}"

    assert predict_passes.call_count == 1
    assert mock_downloads["fetch_forecast"].await_count == 1


async def test_nothing_wakes_after_the_last_change(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(minutes=10), 60)
    predict_passes.return_value = [p]
    entry = await add_location(hass)
    woken = MagicMock()
    entry.async_on_unload(entry.runtime_data.async_add_listener(woken))
    await advance(hass, freezer, p.start + SECOND)
    await advance(hass, freezer, p.end + SECOND)
    assert woken.call_count == 2
    await advance(hass, freezer, p.end + timedelta(minutes=30))
    assert woken.call_count == 2


async def test_the_wait_for_the_next_change_does_not_hold_up_a_shutdown(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    assert init_integration.runtime_data._wake_job.cancel_on_shutdown is True


async def test_a_refresh_replaces_the_timer_rather_than_adding_one(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(minutes=10), 60)
    predict_passes.return_value = [p]
    entry = await add_location(hass)
    await entry.runtime_data.async_refresh()
    woken = MagicMock()
    entry.async_on_unload(entry.runtime_data.async_add_listener(woken))
    await advance(hass, freezer, p.start + SECOND)
    assert woken.call_count == 1


async def test_no_passes_set_no_timer(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    entry = await add_location(hass)
    woken = MagicMock()
    entry.async_on_unload(entry.runtime_data.async_add_listener(woken))
    await advance(hass, freezer, NOW + timedelta(hours=1) - SECOND)
    woken.assert_not_called()


async def test_an_unloaded_location_is_never_woken(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(minutes=10), 60)
    predict_passes.return_value = [p]
    entry = await add_location(hass)
    coordinator = entry.runtime_data
    woken = MagicMock()
    coordinator.async_add_listener(woken)
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    await advance(hass, freezer, p.start + SECOND)
    woken.assert_not_called()


async def test_a_refresh_finishing_after_the_shutdown_sets_no_timer(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    p = dim_pass(NOW + timedelta(minutes=10), 60)
    predict_passes.return_value = [p]
    entry = await add_location(hass)
    coordinator = entry.runtime_data
    woken = MagicMock()
    coordinator.async_add_listener(woken)
    await coordinator.async_shutdown()
    coordinator._async_refresh_finished()
    await advance(hass, freezer, p.start + SECOND)
    woken.assert_not_called()


async def test_the_timer_goes_on_after_a_failed_refresh(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    # Set up on elements about to go stale, so that the refresh fails while passes are ahead.
    almost = NOW - timedelta(days=14) + timedelta(hours=1)
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, almost) for s in satellites()]
    p = dim_pass(NOW + timedelta(hours=2, minutes=3), 60)
    predict_passes.return_value = [p]
    entry = await add_location(hass)
    coordinator = entry.runtime_data
    await advance(hass, freezer, NOW + timedelta(hours=2))
    assert not coordinator.last_update_success
    woken = MagicMock()
    entry.async_on_unload(coordinator.async_add_listener(woken))
    await advance(hass, freezer, p.start + SECOND)
    woken.assert_called()


# Going stale, and the repair issue.


async def _stale_setup(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> tuple[MockConfigEntry, datetime]:
    """Set up, and let the clock run on until the elements are 20 days old."""
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    entry = await add_location(hass)
    later = NOW + timedelta(days=20)
    await advance(hass, freezer, later)
    return entry, later


async def test_elements_over_two_weeks_old_pause_predictions_with_the_upstream_wording(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry, _ = await _stale_setup(hass, freezer, mock_downloads)
    coordinator = entry.runtime_data
    assert not coordinator.last_update_success
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE)
    assert issue is not None
    assert issue.translation_key == "catalog_stale_upstream"
    assert issue.translation_placeholders == {"age": "20"}
    assert issue.severity is ir.IssueSeverity.WARNING
    assert issue.is_fixable is False


async def test_a_repair_someone_ignored_stays_ignored_through_a_reload(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    """Changing an option reloads the location, which must not bring the repair back."""
    entry, _ = await _stale_setup(hass, freezer, mock_downloads)
    ir.async_get(hass).async_ignore(DOMAIN, ISSUE, True)
    await set_options(hass, entry, {CONF_ALERT_LEAD_MINUTES: 20})
    assert entry.state is ConfigEntryState.SETUP_RETRY
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE)
    assert issue is not None
    assert issue.dismissed_version is not None


@pytest.mark.parametrize(
    ("catalog", "failure", "key", "placeholders"),
    [
        pytest.param(False, "no route", "catalog_unavailable", {"error": "no route"}, id="none"),
        pytest.param(True, None, "catalog_stale_upstream", {"age": "15"}, id="as old upstream"),
        pytest.param(
            True, "no route", "catalog_stale", {"age": "15", "error": "no route"}, id="unrefreshed"
        ),
    ],
)
async def test_why_predictions_stopped_can_be_translated(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    catalog: bool,
    failure: str | None,
    key: str,
    placeholders: dict[str, str],
) -> None:
    """Home Assistant shows these words on the integration's card, in the person's language."""
    fetch = mock_downloads["fetch_catalog"]
    if catalog:
        fetch.return_value = [with_epoch(s, NOW - timedelta(days=15)) for s in satellites()]
        await async_shared_catalog(hass).async_satellites()
    if failure is not None:
        fetch.side_effect = CatalogError(failure)
        # Late enough for the next download, the one that fails.
        freezer.move_to(NOW + timedelta(hours=13))
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    coordinator = SatelliteSpotterCoordinator(hass, entry, async_shared_catalog(hass))
    await coordinator.async_refresh()
    await coordinator.async_shutdown()
    error = coordinator.last_exception
    assert isinstance(error, UpdateFailed)
    assert (error.translation_domain, error.translation_key) == (DOMAIN, key)
    assert error.translation_placeholders == placeholders


async def test_a_failed_download_makes_the_repair_say_why(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    await advance(hass, freezer, NOW + timedelta(days=20))
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE)
    assert issue is not None
    assert issue.translation_key == "catalog_stale"
    assert issue.translation_placeholders == {"age": "20", "error": "no route"}


@pytest.mark.parametrize(
    ("age", "paused"),
    [
        pytest.param(timedelta(days=14), False, id="exactly 14 days"),
        pytest.param(timedelta(days=14, seconds=1), True, id="a second over"),
    ],
)
async def test_the_limit_is_fourteen_days(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    age: timedelta,
    paused: bool,
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW - age) for s in satellites()]
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert (ir.async_get(hass).async_get_issue(DOMAIN, ISSUE) is not None) is paused
    assert (entry.state.value == "setup_retry") is paused


async def test_paused_predictions_retry_after_five_minutes_and_a_second(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
) -> None:
    # The comment in coordinator.py: the refresh must find the catalog ready to try again.
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    later = NOW + timedelta(days=20)
    await advance(hass, freezer, later)
    asked = mock_downloads["fetch_catalog"].await_count

    await advance(hass, freezer, later + timedelta(minutes=5))
    assert mock_downloads["fetch_catalog"].await_count == asked

    await advance(hass, freezer, later + timedelta(minutes=5) + SECOND)
    assert mock_downloads["fetch_catalog"].await_count == asked + 1


async def test_a_fresh_catalog_clears_the_repair_and_brings_predictions_back(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry, later = await _stale_setup(hass, freezer, mock_downloads)
    state = hass.states.get("sensor.home_next_visible_pass")
    assert state is not None
    assert state.state == "unavailable"

    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, later) for s in satellites()]
    # Another try once CelesTrak's data is new: downloads are due every 12 hours.
    next_try = later + timedelta(hours=12)
    await advance(hass, freezer, next_try)
    await advance(hass, freezer, next_try + timedelta(minutes=6))

    assert entry.runtime_data.last_update_success
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE) is None
    state = hass.states.get("sensor.home_next_visible_pass")
    assert state is not None
    assert state.state != "unavailable"


async def test_the_issue_is_deleted_only_when_the_elements_are_fresh(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    ir.async_create_issue(
        hass,
        DOMAIN,
        ISSUE,
        is_fixable=False,
        severity=ir.IssueSeverity.WARNING,
        translation_key=ISSUE,
    )
    await add_location(hass)
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE) is None


async def test_setup_on_a_stale_catalog_retries_and_raises_the_repair(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = aged(satellites(), timedelta(days=-30))
    entry = await add_location(hass)
    assert entry.state.value == "setup_retry"
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE) is not None


# Why predictions are paused, in words.


async def test_nothing_to_say_while_all_is_well(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    assert init_integration.runtime_data.paused_reason(NOW) is None


async def test_the_reason_gives_the_age_before_a_refresh_has_noticed(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    entry = await add_location(hass)
    coordinator = entry.runtime_data
    assert coordinator.paused_reason(NOW + timedelta(days=14)) is None
    assert coordinator.paused_reason(NOW + timedelta(days=15)) == "Orbit data is 15 days old"


async def test_the_reason_after_a_failed_update_is_its_message(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry, later = await _stale_setup(hass, freezer, mock_downloads)
    reason = entry.runtime_data.paused_reason(later)
    assert reason is not None
    assert reason != "Predictions could not be updated"
    assert reason == str(entry.runtime_data.last_exception)


async def test_the_reason_after_a_failure_without_words_is_still_a_sentence(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    coordinator = init_integration.runtime_data
    coordinator.last_update_success = False
    coordinator.last_exception = None
    assert coordinator.paused_reason(NOW) == "Predictions could not be updated"
    coordinator.last_exception = ValueError()
    assert coordinator.paused_reason(NOW) == "Predictions could not be updated"
    coordinator.last_update_success = True


async def test_the_stale_age_is_there_only_when_too_old(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    entry = await add_location(hass)
    coordinator = entry.runtime_data
    assert coordinator.stale_age(NOW) is None
    assert coordinator.stale_age(NOW + timedelta(days=14)) is None
    assert coordinator.stale_age(NOW + timedelta(days=14) + SECOND) == timedelta(days=14) + SECOND


# Before any predictions exist.


async def test_before_the_first_run_there_is_nothing_to_follow(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Home", data=dict(HONOLULU))
    entry.add_to_hass(hass)
    manager = CatalogManager(hass)
    coordinator = SatelliteSpotterCoordinator(hass, entry, manager)
    assert coordinator.predictions is None
    assert coordinator.next_visible_pass(NOW) is None
    assert coordinator.next_bright_pass(NOW) is None
    assert coordinator.pass_under_way(NOW) is None
    assert coordinator.bright_pass_soon(NOW) is None
    assert coordinator.stale_age(NOW) is None
    await coordinator.async_shutdown()


async def test_the_coordinator_names_its_location(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Cabin", data=dict(DENVER))
    entry.add_to_hass(hass)
    coordinator = SatelliteSpotterCoordinator(hass, entry, CatalogManager(hass))
    assert coordinator.name == "satellite_spotter Cabin"
    assert coordinator.update_interval == timedelta(hours=1)
    await coordinator.async_shutdown()


async def test_the_followed_passes_with_data(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    dim = dim_pass(NOW + timedelta(hours=1))
    bright = bright_pass(NOW + timedelta(hours=3))
    predict_passes.return_value = [dim, bright]
    entry = await add_location(hass, options={"alert_lead_minutes": 30})
    coordinator = entry.runtime_data
    assert coordinator.next_visible_pass(NOW) is dim
    assert coordinator.next_bright_pass(NOW) is bright
    assert coordinator.pass_under_way(NOW) is None
    assert coordinator.pass_under_way(dim.start) is dim
    notice = bright.start - timedelta(minutes=30)
    assert coordinator.bright_pass_soon(notice - SECOND) is None
    assert coordinator.bright_pass_soon(notice) is bright
    assert coordinator.bright_pass_soon(bright.end - SECOND) is bright
    assert coordinator.bright_pass_soon(bright.end) is None


async def test_refused_downloads_do_not_stop_a_location_with_a_catalog(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = DownloadRefused("403")
    await advance(hass, freezer, NOW + timedelta(hours=12))
    coordinator = entry.runtime_data
    assert coordinator.last_update_success
    assert coordinator.predictions.searched_at == NOW + timedelta(hours=12)
    assert coordinator.catalog.last_error == "403"
