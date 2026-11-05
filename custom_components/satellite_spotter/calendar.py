"""A calendar of a location's passes, with when and where to look in Home Assistant's language."""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime, timedelta
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, override

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .coordinator import ListedPass, SatelliteSpotterCoordinator
from .entity import SatelliteSpotterEntity, compass, magnitude
from .links import about_url
from .predict import Moment

if TYPE_CHECKING:
    from . import SatelliteSpotterConfigEntry

PARALLEL_UPDATES = 0

_TRANSLATIONS = Path(__file__).parent / "translations"
_DEFAULT_LANGUAGE = "en"


def resolve_language(language: str, available: Collection[str]) -> str:
    """Return an exact match, else the first with the same base language, else English."""
    language = language.replace("_", "-")
    if language in available:
        return language
    base = language.partition("-")[0].lower()
    for candidate in sorted(available):
        if candidate.partition("-")[0].lower() == base:
            return candidate
    return _DEFAULT_LANGUAGE


def _load_common(language: str) -> dict[str, str]:
    available = [path.stem for path in _TRANSLATIONS.glob("*.json")]
    path = _TRANSLATIONS / f"{resolve_language(language, available)}.json"
    common: dict[str, str] = json.loads(path.read_text(encoding="utf-8"))["common"]
    return common


async def async_pass_text(hass: HomeAssistant) -> PassText:
    """Load the calendar's words in Home Assistant's language."""
    return PassText(await hass.async_add_executor_job(_load_common, hass.config.language))


class PassText:
    """Describes passes in the words of one language."""

    def __init__(self, strings: dict[str, str]) -> None:
        """Take the translation's common strings."""
        self._strings = strings

    def summary(self, p: ListedPass) -> str:
        """Return an event's title. The blueprint recognises the star."""
        return f"{'🌟' if p.bright else '🔭'} {p.title}"

    def _sight(self, key: str, moment: Moment, **more: Any) -> str:
        return self._strings[key].format(
            time=f"{dt_util.as_local(moment.time):%H:%M:%S}",
            direction=self._strings[f"compass_{compass(moment.azimuth).lower()}"],
            elevation=f"{moment.elevation:.0f}",
            **more,
        )

    def _magnitude(self, value: float) -> str:
        return f"{magnitude(value):.1f}".replace(".", self._strings["decimal_separator"])

    def description(self, p: ListedPass) -> str:
        """Return an event's lines, about the pass's brightest satellite. The link comes last."""
        lead = p.lead
        lines = [
            self._sight(
                "calendar_brightest", lead.brightest, magnitude=self._magnitude(p.peak_magnitude)
            ),
            self._sight("calendar_appears", lead.appears),
            self._sight("calendar_disappears", lead.vanishes),
        ]
        if p.cloud_cover is not None:
            lines.append(self._strings["calendar_cloud_cover"].format(cloud_cover=p.cloud_cover))
        if p.count > 1:
            lines.append(self._strings["calendar_together"].format(count=p.count))
        lines.append(
            self._strings["calendar_about"].format(
                name=lead.satellite.name, url=about_url(lead.satellite.norad_id)
            )
        )
        return "\n".join(lines)


def event_times(p: ListedPass) -> tuple[datetime, datetime]:
    """Return a pass's start and end in local time, to the second, at least a second apart."""
    start = dt_util.as_local(p.start).replace(microsecond=0)
    end = dt_util.as_local(p.end).replace(microsecond=0)
    return start, max(end, start + timedelta(seconds=1))


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add a location's calendar."""
    async_add_entities([SatellitePassCalendar(entry.runtime_data, await async_pass_text(hass))])


class SatellitePassCalendar(SatelliteSpotterEntity, CalendarEntity):
    """The passes of the days predicted; empty while predictions are paused."""

    def __init__(self, coordinator: SatelliteSpotterCoordinator, text: PassText) -> None:
        """Remember what has been written, to tell a new prediction run from a wake-up."""
        super().__init__(coordinator, "passes")
        self._text = text
        self._written = self._what_to_write()

    def _what_to_write(self) -> tuple[object, bool]:
        return self.coordinator.data, self.coordinator.last_update_success

    @callback
    @override
    def _handle_coordinator_update(self) -> None:
        """Write the state only for new predictions: every write makes open calendars fetch."""
        data, success = self._what_to_write()
        if data is not self._written[0] or success != self._written[1]:
            self._written = data, success
            self.async_write_ha_state()

    def _passes(self) -> list[ListedPass]:
        data = self.coordinator.predictions
        return [] if data is None or not self.available else data.passes

    def _event(self, p: ListedPass) -> CalendarEvent:
        start, end = event_times(p)
        return CalendarEvent(
            start=start,
            end=end,
            summary=self._text.summary(p),
            description=self._text.description(p),
            uid=p.id,
        )

    @property
    @override
    def event(self) -> CalendarEvent | None:
        """Return the first pass not over by its own event times."""
        now = dt_util.utcnow()
        return next((self._event(p) for p in self._passes() if event_times(p)[1] > now), None)

    @override
    async def async_get_events(
        self, hass: HomeAssistant, start_date: datetime, end_date: datetime
    ) -> list[CalendarEvent]:
        """Return the passes overlapping the range."""
        events = []
        for p in self._passes():
            start, end = event_times(p)
            if start < end_date and end > start_date:
                events.append(self._event(p))
        return events
