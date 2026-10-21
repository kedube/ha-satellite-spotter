"""The entities of a location: what they say, and when they change."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from freezegun.api import FrozenDateTimeFactory
from homeassistant.const import STATE_OFF, STATE_ON
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.satellite_spotter.const import (
    ATTRIBUTION,
    DEFAULT_ALERT_LEAD_MINUTES,
    DOMAIN,
    VERSION,
)

from .common import FIRST_PASS, FIRST_PASS_ID, NOW, advance

pytestmark = pytest.mark.usefixtures("init_integration")

# The attributes of See A Satellite Tonight's pass entities, which automations
# and cards read, plus the pass id for links to the pass in the sidebar page.
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
    """The next pass is the website's first one, with where to look."""
    state = hass.states.get("sensor.home_next_pass")
    assert state.state == FIRST_PASS
    attrs = state.attributes
    assert attrs.keys() == PASS_KEYS | {"attribution", "device_class", "friendly_name"}
    assert attrs["satellite"] == "BlueWalker 3"
    assert attrs["norad_id"] == 53807
    assert attrs["start"] == FIRST_PASS
    assert attrs["magnitude"] == 0.3
    assert attrs["bright"] is True
    assert attrs["before_sunset"] is False
    assert attrs["rise_direction"] == "WNW"
    assert attrs["cloud_cover"] == 20  # the first forecast hour after the start
    assert attrs["satellite_count"] == 1
    assert attrs["info_url"].startswith("https://ast-science.com/")
    assert attrs["pass_id"] == FIRST_PASS_ID
    assert attrs["attribution"] == ATTRIBUTION

    assert hass.states.get("sensor.home_next_bright_pass").state == FIRST_PASS
    passes = hass.states.get("sensor.home_passes_next_24_hours")
    assert int(passes.state) == len(passes.attributes["passes"]) == 12
    assert passes.attributes["unit_of_measurement"] == "passes"
    assert passes.attributes["passes"][0] == {
        "start": FIRST_PASS,
        "satellite": "BlueWalker 3",
        "magnitude": 0.3,
        "direction": "WNW",
        "cloud_cover": 20,
    }
    catalog = hass.states.get("sensor.home_catalog_updated")
    assert catalog.state == NOW.isoformat()
    assert catalog.attributes["satellites"] == 22
    assert catalog.attributes["stale"] is False
    assert catalog.attributes["last_download_error"] is None
    assert 0 < catalog.attributes["age_days"] < 1


async def test_entities_and_device(hass: HomeAssistant, init_integration: MockConfigEntry) -> None:
    """The entity ids of See A Satellite Tonight, one device per location."""
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
    assert device.manufacturer == "James Darpinian"
    assert device.model == "See A Satellite Tonight"
    assert device.sw_version == VERSION
    assert device.entry_type is dr.DeviceEntryType.SERVICE
    assert device.configuration_url == "https://james.darpinian.com/satellites/#loc=52.0907,5.1214"


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


async def test_pass_in_progress(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    """The binary sensor follows the pass without polling."""
    visible = "binary_sensor.home_satellite_visible"
    assert hass.states.get(visible).state == STATE_OFF
    assert hass.states.get(visible).attributes.keys() == {"friendly_name", "attribution"}

    await advance(hass, freezer, datetime(2026, 10, 10, 19, 8, 42, tzinfo=UTC))
    state = hass.states.get(visible)
    assert state.state == STATE_ON
    assert state.attributes["satellite"] == "BlueWalker 3"
    assert state.attributes["pass_id"] == FIRST_PASS_ID
    # While in progress, the "next pass" is still this one.
    assert hass.states.get("sensor.home_next_pass").state == FIRST_PASS

    await advance(hass, freezer, datetime(2026, 10, 10, 19, 9, 46, tzinfo=UTC))
    assert hass.states.get(visible).state == STATE_OFF
    assert hass.states.get("sensor.home_next_pass").state > "2026-10-10T19:09:44+00:00"


async def test_bright_pass_soon(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, init_integration: MockConfigEntry
) -> None:
    """On from the advance notice before a bright pass until it ends."""
    soon = "binary_sensor.home_bright_pass_soon"
    lead = timedelta(minutes=DEFAULT_ALERT_LEAD_MINUTES)
    second = timedelta(seconds=1)
    first, following = [p for p in init_integration.runtime_data.data.passes if p.bright][:2]
    # The first bright pass is minutes away: the notice is already on.
    assert first.start - lead < NOW < first.start
    state = hass.states.get(soon)
    assert state.state == STATE_ON
    assert state.attributes["pass_id"] == first.id

    await advance(hass, freezer, first.end + second)
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
    now = datetime(2026, 10, 11, 3, 50, tzinfo=UTC)
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
    passes = hass.states.get("sensor.home_passes_next_24_hours").attributes["passes"]
    group = next(p for p in passes if p["start"] == "2026-10-11T04:41:54+00:00")
    assert group["satellite"] == "SL-4 R/B +1"

    await advance(hass, freezer, datetime(2026, 10, 11, 4, 41, 30, tzinfo=UTC))
    attrs = hass.states.get("sensor.home_next_pass").attributes
    assert attrs["satellite"] == "SL-4 R/B"
    assert attrs["satellite_count"] == 2
    assert attrs["satellites"] == ["SL-4 R/B", "SAOCOM 1-A"]
    assert attrs["pass_id"] == "39679-1791693714"
    assert attrs.keys() == PASS_KEYS | {
        "satellites",
        "attribution",
        "device_class",
        "friendly_name",
    }


async def test_magnitudes_are_never_negative_zero(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    """BlueWalker 3 peaks at magnitude -0.009 on the 11th: that is 0.0."""
    await advance(hass, freezer, datetime(2026, 10, 11, 18, 0, tzinfo=UTC))
    attrs = hass.states.get("sensor.home_next_bright_pass").attributes
    assert attrs["start"] == "2026-10-11T18:30:19+00:00"
    assert attrs["magnitude"] == 0.0
    assert repr(attrs["magnitude"]) == "0.0"
    listed = hass.states.get("sensor.home_passes_next_24_hours").attributes["passes"]
    assert repr(next(p for p in listed if p["satellite"] == "BlueWalker 3")["magnitude"]) == "0.0"


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
