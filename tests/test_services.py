"""The action listing passes: what it filters by, what it says, and when it refuses."""

from __future__ import annotations

from datetime import timedelta
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.util import dt as dt_util
from homeassistant.util.yaml import load_yaml_dict
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
import voluptuous as vol

from custom_components.satellite_spotter.celestrak import CatalogError
from custom_components.satellite_spotter.const import DOMAIN, SERVICE_GET_PASSES
from custom_components.satellite_spotter.services import KINDS

from .common import (
    INTEGRATION,
    NOW,
    add_location,
    advance,
    bright_pass,
    dim_pass,
    listed,
    satellites,
    sighting,
    with_epoch,
)

SOON = NOW + timedelta(hours=2)


@pytest.fixture(autouse=True)
def _clock(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(NOW)


async def ask(hass: HomeAssistant, entry: MockConfigEntry, **fields: Any) -> dict[str, Any]:
    answer = await hass.services.async_call(
        DOMAIN,
        SERVICE_GET_PASSES,
        {"config_entry_id": entry.entry_id, **fields},
        blocking=True,
        return_response=True,
    )
    assert answer is not None
    return answer


async def location_with(
    hass: HomeAssistant, predict_passes: MagicMock, *passes: Any
) -> MockConfigEntry:
    predict_passes.return_value = list(passes)
    return await add_location(hass)


def titles(answer: dict[str, Any]) -> list[str]:
    return [p["satellite"] for p in answer["passes"]]


async def test_it_lists_what_is_coming_soonest_first(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    first = bright_pass(SOON, cloud_cover=12)
    second = dim_pass(SOON + timedelta(hours=3), name="CZ-2C R/B", norad_id=7777)
    entry = await location_with(hass, predict_passes, first, second)
    answer = await ask(hass, entry)
    assert answer["location"] == "Home"
    assert answer["paused"] is None
    assert titles(answer) == ["ISS", "CZ-2C R/B"]
    described = answer["passes"][0]
    assert described["pass_id"] == first.id
    assert described["start"] == dt_util.as_local(first.start).isoformat()
    assert described["rating"] == "great"
    assert described["bright"] is True
    assert described["cloud_cover"] == 12
    assert described["kind"] == "iss"
    assert described["catalog_number"] == 25544
    assert described["satellite_count"] == 1
    assert described["satellites"] == ["ISS"]
    assert described["confidence"] == "high"
    assert described["sky_chart"].startswith(
        f"/api/satellite_spotter/sky_chart/{entry.entry_id}/{first.id}.png?authSig="
    )


async def test_its_answer_can_go_anywhere_json_can(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    entry = await location_with(hass, predict_passes, bright_pass(SOON))
    json.dumps(await ask(hass, entry))


async def test_what_is_over_stays_out_unless_asked_for(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
) -> None:
    gone = bright_pass(NOW + timedelta(minutes=10), 60, name="GONE", norad_id=1)
    coming = bright_pass(NOW + timedelta(hours=3), name="COMING", norad_id=2)
    entry = await location_with(hass, predict_passes, gone, coming)
    await advance(hass, freezer, NOW + timedelta(minutes=12))
    assert titles(await ask(hass, entry)) == ["COMING"]
    assert titles(await ask(hass, entry, pass_id=gone.id)) == ["GONE"]
    start = (NOW + timedelta(minutes=9)).isoformat()
    assert titles(await ask(hass, entry, start=start)) == ["GONE", "COMING"]


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        pytest.param({}, ["BRIGHT", "DIM", "ROCKET", "TRAIN"], id="everything"),
        pytest.param({"min_rating": "great"}, ["BRIGHT", "TRAIN"], id="great ones"),
        pytest.param({"min_rating": "good"}, ["BRIGHT", "TRAIN"], id="good ones"),
        pytest.param({"min_rating": "fair"}, ["BRIGHT", "DIM", "TRAIN"], id="fair ones"),
        pytest.param({"max_cloud_cover": 50}, ["BRIGHT", "DIM", "TRAIN"], id="not too cloudy"),
        pytest.param({"bright_only": True}, ["BRIGHT", "TRAIN"], id="bright ones"),
        pytest.param({"bright_only": False}, ["BRIGHT", "DIM", "ROCKET", "TRAIN"], id="not only"),
        pytest.param({"kinds": ["rocket"]}, ["ROCKET"], id="one kind"),
        pytest.param({"kinds": "rocket"}, ["ROCKET"], id="one kind, not in a list"),
        pytest.param({"kinds": ["rocket", "iss"]}, ["BRIGHT", "ROCKET"], id="two kinds"),
        pytest.param({"kinds": []}, ["BRIGHT", "DIM", "ROCKET", "TRAIN"], id="no kinds"),
        pytest.param({"kinds": ["hubble"]}, [], id="a kind that is not coming"),
        pytest.param({"satellite": "dim"}, ["DIM"], id="part of a name, in any case"),
        pytest.param({"satellite": "other"}, ["TRAIN"], id="any satellite of a pass"),
        pytest.param({"satellite": ""}, ["BRIGHT", "DIM", "ROCKET", "TRAIN"], id="no name"),
        pytest.param({"limit": 2}, ["BRIGHT", "DIM"], id="a limit"),
    ],
)
async def test_what_it_filters_by(
    hass: HomeAssistant,
    mock_downloads: dict[str, AsyncMock],
    predict_passes: MagicMock,
    fields: dict[str, Any],
    expected: list[str],
) -> None:
    bright = bright_pass(SOON, cloud_cover=10, name="BRIGHT", norad_id=25544)
    dim = dim_pass(SOON + timedelta(hours=1), name="DIM", norad_id=1)
    rocket = bright_pass(
        SOON + timedelta(hours=2), cloud_cover=80, name="ROCKET R/B", norad_id=2, peak_magnitude=2.0
    )
    train = listed(
        sighting(SOON + timedelta(hours=3), name="TRAIN", norad_id=3),
        sighting(SOON + timedelta(hours=3), name="OTHER", norad_id=4, peak_magnitude=2.0),
    )
    entry = await location_with(hass, predict_passes, bright, dim, rocket, train)
    answer = await ask(hass, entry, **fields)
    assert [title.split(" ")[0] for title in titles(answer)] == expected


async def test_a_pass_with_no_forecast_counts_as_clear(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    entry = await location_with(hass, predict_passes, bright_pass(SOON))
    assert titles(await ask(hass, entry, max_cloud_cover=0)) == ["ISS"]


async def test_the_end_of_the_range_leaves_out_what_starts_after_it(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    first = bright_pass(SOON, name="FIRST", norad_id=1)
    second = bright_pass(SOON + timedelta(hours=5), name="SECOND", norad_id=2)
    entry = await location_with(hass, predict_passes, first, second)
    end = (SOON + timedelta(hours=1)).isoformat()
    assert titles(await ask(hass, entry, end=end)) == ["FIRST"]


async def test_a_pass_shifted_by_a_new_catalog_is_still_found_by_its_old_id(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock], predict_passes: MagicMock
) -> None:
    p = bright_pass(SOON)
    entry = await location_with(hass, predict_passes, p)
    assert titles(await ask(hass, entry, pass_id=str(int(p.id) + 30))) == ["ISS"]
    assert titles(await ask(hass, entry, pass_id=str(int(p.id) + 9999))) == []
    assert titles(await ask(hass, entry, pass_id="not a number")) == []


async def test_paused_predictions_list_nothing_and_say_why(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].return_value = [with_epoch(s, NOW) for s in satellites()]
    entry = await add_location(hass)
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    await advance(hass, freezer, NOW + timedelta(days=20))
    answer = await ask(hass, entry)
    assert answer["passes"] == []
    assert "no route" in answer["paused"]
    assert (await ask(hass, entry, pass_id="1793806752"))["passes"] == []


async def test_a_location_that_does_not_exist_is_refused(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    with pytest.raises(ServiceValidationError) as caught:
        await hass.services.async_call(
            DOMAIN,
            SERVICE_GET_PASSES,
            {"config_entry_id": "nothing"},
            blocking=True,
            return_response=True,
        )
    assert caught.value.translation_key == "unknown_location"


async def test_another_integrations_entry_is_refused(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    other = MockConfigEntry(domain="sun")
    other.add_to_hass(hass)
    with pytest.raises(ServiceValidationError) as caught:
        await ask(hass, other)
    assert caught.value.translation_key == "unknown_location"


async def test_a_location_that_is_not_loaded_is_refused(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    mock_downloads["fetch_catalog"].side_effect = CatalogError("no route")
    entry = await add_location(hass)
    with pytest.raises(ServiceValidationError) as caught:
        await ask(hass, entry)
    assert caught.value.translation_key == "location_not_loaded"


@pytest.mark.parametrize(
    "fields",
    [
        {"min_rating": "wonderful"},
        {"max_cloud_cover": 101},
        {"kinds": ["unicorn"]},
        {"limit": 0},
        {"limit": 201},
        {"start": "not a time"},
    ],
)
async def test_what_makes_no_sense_is_refused_by_the_schema(
    hass: HomeAssistant, init_integration: MockConfigEntry, fields: dict[str, Any]
) -> None:
    with pytest.raises(vol.Invalid):
        await ask(hass, init_integration, **fields)


async def test_it_gives_an_answer_or_nothing(
    hass: HomeAssistant, init_integration: MockConfigEntry
) -> None:
    # Only for its answer: an automation calling it must ask for one.
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            DOMAIN,
            SERVICE_GET_PASSES,
            {"config_entry_id": init_integration.entry_id},
            blocking=True,
        )


def test_the_kinds_it_offers_are_those_of_the_form() -> None:
    fields = load_yaml_dict(str(INTEGRATION / "services.yaml"))["get_passes"]["fields"]
    assert fields["kinds"]["selector"]["select"]["options"] == list(KINDS)
    assert fields["min_rating"]["selector"]["select"]["options"] == [
        "great", "good", "fair", "poor"
    ]  # fmt: skip
