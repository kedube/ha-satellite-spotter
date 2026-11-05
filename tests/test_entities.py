"""The entities of a location: what they say, and when they change."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

from freezegun.api import FrozenDateTimeFactory
from homeassistant.const import STATE_OFF, STATE_ON
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.const import (
    ATTRIBUTION,
    CONF_SHOW_PANEL,
    DEFAULT_ALERT_LEAD_MINUTES,
    DOMAIN,
    VERSION,
)
from custom_components.satellite_spotter.entity import magnitude

from .common import DENVER, DENVER_ID, FIRST_PASS, FIRST_PASS_ID, NOW, add_location, advance

pytestmark = pytest.mark.usefixtures("init_integration")

# The attributes of a pass, which automations and cards read.
PASS_KEYS = {
    "satellite",
    "norad_id",
    "start",
    "end",
    "duration",
    "magnitude",
    "bright",
    "before_sunset",
    "rise_direction",
    "rise_azimuth",
    "rise_elevation",
    "brightest_time",
    "brightest_direction",
    "brightest_azimuth",
    "brightest_elevation",
    "set_direction",
    "set_azimuth",
    "set_elevation",
    "cloud_cover",
    "satellite_count",
    "info_url",
    "pass_id",
}
ENTITIES = {
    "sensor.home_next_pass": "next_pass",
    "sensor.home_next_bright_pass": "next_bright_pass",
    "sensor.home_passes_next_24_hours": "passes_next_24h",
    "sensor.home_catalog_updated": "catalog_updated",
    "binary_sensor.home_satellite_visible": "pass_in_progress",
    "binary_sensor.home_bright_pass_soon": "bright_pass_soon",
    "calendar.home_satellite_passes": "passes",
}


async def test_next_pass(hass: HomeAssistant) -> None:
    """The next pass comes with everything an automation needs to point someone at it."""
    state = hass.states.get("sensor.home_next_pass")
    assert state.state == FIRST_PASS
    assert state.attributes.keys() == PASS_KEYS | {"attribution", "device_class", "friendly_name"}
    expected = {
        "satellite": "BLUEWALKER-3",
        "norad_id": 53807,
        "start": FIRST_PASS,
        "magnitude": 0.2,
        "bright": True,
        "before_sunset": False,
        "rise_direction": "NW",
        # The first forecast hour after the start.
        "cloud_cover": 16,
        "satellite_count": 1,
        "info_url": "https://en.wikipedia.org/wiki/BlueWalker_3",
        "pass_id": FIRST_PASS_ID,
        "attribution": ATTRIBUTION,
    }
    assert {key: state.attributes[key] for key in expected} == expected


async def test_what_comes_after_the_next_pass(hass: HomeAssistant) -> None:
    """The other sensors tell the same story."""
    assert hass.states.get("sensor.home_next_bright_pass").state == FIRST_PASS
    passes = hass.states.get("sensor.home_passes_next_24_hours")
    assert int(passes.state) == len(passes.attributes["passes"]) == 7
    assert passes.attributes["unit_of_measurement"] == "passes"
    assert passes.attributes["passes"][0] == {
        "start": FIRST_PASS,
        "satellite": "BLUEWALKER-3",
        "magnitude": 0.2,
        "direction": "NW",
        "cloud_cover": 16,
    }


async def test_catalog_sensor(hass: HomeAssistant) -> None:
    catalog = hass.states.get("sensor.home_catalog_updated")
    assert catalog.state == NOW.isoformat()
    attributes = catalog.attributes
    assert (attributes["satellites"], attributes["stale"]) == (22, False)
    assert attributes["last_download_error"] is None
    assert 0 < attributes["age_days"] < 1


async def test_entities_and_device(hass: HomeAssistant, init_integration: MockConfigEntry) -> None:
    """The entity ids automations and cards rely on, with one device per location."""
    ent_reg = er.async_get(hass)
    entry_id = init_integration.entry_id
    for entity_id, key in ENTITIES.items():
        entity = ent_reg.async_get(entity_id)
        assert entity is not None, entity_id
        assert entity.unique_id == f"{entry_id}_{key}"
        assert entity.translation_key == key
    assert ent_reg.async_get("sensor.home_catalog_updated").entity_category == "diagnostic"

    (device,) = dr.async_entries_for_config_entry(dr.async_get(hass), entry_id)
    assert device.identifiers == {(DOMAIN, entry_id)}
    assert device.name == "Home"
    assert device.manufacturer == "Satellite Spotter"
    assert device.model == "Pass predictions"
    assert device.sw_version == VERSION
    assert device.entry_type is dr.DeviceEntryType.SERVICE
    # Visit opens this location on the page.
    assert device.configuration_url == f"homeassistant://satellite-spotter?entry_id={entry_id}"


async def test_no_link_to_a_page_that_is_switched_off(
    hass: HomeAssistant, mock_downloads: dict[str, AsyncMock]
) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Cabin",
        data=DENVER,
        unique_id=DENVER_ID,
        options={CONF_SHOW_PANEL: False},
    )
    await add_location(hass, entry)
    (device,) = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    assert device.configuration_url is None


async def test_lists_stay_out_of_the_recorder(hass: HomeAssistant) -> None:
    """The long lists change with every pass and are not worth a history."""
    unrecorded = hass.states.get("sensor.home_passes_next_24_hours").state_info[
        "unrecorded_attributes"
    ]
    assert {"passes", "satellites", "info_url"} <= unrecorded
    unrecorded = hass.states.get("binary_sensor.home_bright_pass_soon").state_info[
        "unrecorded_attributes"
    ]
    assert {"satellites", "info_url"} <= unrecorded
    # The catalog's size is worth a history.
    catalog = hass.states.get("sensor.home_catalog_updated")
    assert "satellites" not in catalog.state_info["unrecorded_attributes"]


async def test_visible_while_a_pass_is_under_way(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    """The binary sensor turns on and off by itself, at the pass's own times."""
    sensor = "binary_sensor.home_satellite_visible"
    before = hass.states.get(sensor)
    assert before.state == STATE_OFF
    # Off, it describes no pass.
    assert before.attributes.keys() == {"friendly_name", "attribution"}

    first = init_integration.runtime_data.data.passes[0]
    await advance(hass, freezer, first.start + timedelta(seconds=5))
    during = hass.states.get(sensor)
    assert during.state == STATE_ON
    assert (during.attributes["satellite"], during.attributes["pass_id"]) == (
        "BLUEWALKER-3",
        FIRST_PASS_ID,
    )
    # Under way, it is still the next pass.
    assert hass.states.get("sensor.home_next_pass").state == FIRST_PASS

    await advance(hass, freezer, first.end + timedelta(seconds=2))
    assert hass.states.get(sensor).state == STATE_OFF
    assert hass.states.get("sensor.home_next_pass").state > first.end.isoformat()


async def test_bright_pass_soon(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    """On from the advance notice before a bright pass until it ends."""
    soon = "binary_sensor.home_bright_pass_soon"
    lead = timedelta(minutes=DEFAULT_ALERT_LEAD_MINUTES)
    second = timedelta(seconds=1)
    first, close, following = [p for p in init_integration.runtime_data.data.passes if p.bright][:3]
    # The first bright pass is minutes away: the notice is already on.
    assert first.start - lead < NOW < first.start
    state = hass.states.get(soon)
    assert state.state == STATE_ON
    assert state.attributes["pass_id"] == first.id

    # The next is close behind, so the notice moves straight on to it.
    assert close.start - lead < first.end
    await advance(hass, freezer, first.end + second)
    state = hass.states.get(soon)
    assert state.state == STATE_ON
    assert state.attributes["pass_id"] == close.id

    await advance(hass, freezer, close.end + second)
    assert hass.states.get(soon).state == STATE_OFF
    assert hass.states.get(soon).attributes.keys() == {"friendly_name", "attribution"}

    await advance(hass, freezer, following.start - lead - second)
    assert hass.states.get(soon).state == STATE_OFF
    await advance(hass, freezer, following.start - lead + second)
    state = hass.states.get(soon)
    assert state.state == STATE_ON
    assert state.attributes["pass_id"] == following.id
    assert state.attributes["bright"] is True
    await advance(hass, freezer, following.start + second)
    assert hass.states.get(soon).state == STATE_ON
    await advance(hass, freezer, following.end + second)
    assert hass.states.get(soon).state == STATE_OFF


async def test_passes_next_24h_follow_the_window(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    init_integration: MockConfigEntry,
) -> None:
    """A pass is counted as soon as it is less than 24 hours away."""
    now = datetime(2026, 11, 5, 15, 0, tzinfo=UTC)
    await advance(hass, freezer, now)
    sensor = "sensor.home_passes_next_24_hours"
    before = int(hass.states.get(sensor).state)

    passes = init_integration.runtime_data.data.passes
    later = next(p for p in passes if p.start > now + timedelta(hours=24))
    # No pass starts or ends and no refresh is due before it comes into view.
    assert all(p.start > later.start - timedelta(hours=24) for p in passes if p.end > now)
    assert later.start - timedelta(hours=24) < now + timedelta(hours=2)
    await advance(hass, freezer, later.start - timedelta(hours=24) + timedelta(seconds=2))
    state = hass.states.get(sensor)
    assert int(state.state) == before + 1
    assert state.attributes["passes"][-1]["start"] == later.start.isoformat()


async def test_groups_of_satellites(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    """Satellites passing together are one pass, named after the first."""
    start = datetime(2026, 11, 8, 4, 15, 34, tzinfo=UTC)
    await advance(hass, freezer, start - timedelta(seconds=30))
    passes = hass.states.get("sensor.home_passes_next_24_hours").attributes["passes"]
    assert passes[0]["start"] == start.isoformat()
    assert passes[0]["satellite"] == "ISS +1"

    attrs = hass.states.get("sensor.home_next_pass").attributes
    assert attrs["satellite"] == "ISS"
    assert attrs["satellite_count"] == 2
    assert attrs["satellites"] == ["ISS", "Hubble"]
    assert attrs["pass_id"] == f"25544-{int(start.timestamp())}"
    assert attrs.keys() == PASS_KEYS | {
        "satellites",
        "attribution",
        "device_class",
        "friendly_name",
    }


@pytest.mark.parametrize("value", [-0.04, 0.0, 0.04])
def test_magnitudes_are_never_negative_zero(value: float) -> None:
    assert repr(magnitude(value)) == "0.0"


async def test_pass_ids_are_stable(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    """Each run predicts from a whole minute, so passes keep their times and ids."""
    before = {p.id: (p.start, p.end) for p in init_integration.runtime_data.data.passes}
    await advance(hass, freezer, NOW + timedelta(hours=2, seconds=1))
    data = init_integration.runtime_data.data
    assert data.computed_at > NOW
    after = {p.id: (p.start, p.end) for p in data.passes}
    still_to_come = {i: t for i, t in before.items() if t[1] > NOW + timedelta(hours=2)}
    assert still_to_come
    assert {i: after[i] for i in still_to_come} == still_to_come
