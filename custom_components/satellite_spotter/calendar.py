"""Calendar of visible passes, with translated viewing directions and brightness."""

from __future__ import annotations

from collections.abc import Collection
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, override

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.translation import async_get_translations
from homeassistant.util import dt as dt_util

from . import SatelliteSpotterConfigEntry
from .const import DOMAIN
from .coordinator import ListedPass, Predictions, SatelliteSpotterCoordinator
from .entity import SatelliteSpotterEntity, compass
from .links import info_url
from .predict import Moment

PARALLEL_UPDATES = 0

TRANSLATIONS_DIR = Path(__file__).parent / "translations"
_PREFIX = f"component.{DOMAIN}.common."
# Event times are whole seconds, like the sensors'; every event lasts at least one.
_MIN_EVENT = timedelta(seconds=1)


def resolve_language(language: str, available: Collection[str]) -> str:
    """Pick the translation for a Home Assistant language, as the frontend does.

    "de-CH" gets German and "pt" Brazilian Portuguese; a language without a
    translation gets English.
    """
    if language in available:
        return language
    base = language.replace("_", "-").split("-")[0].lower()
    return next((code for code in sorted(available) if code.split("-")[0] == base), "en")


def _languages() -> set[str]:
    return {path.stem for path in TRANSLATIONS_DIR.glob("*.json")}


async def async_pass_text(hass: HomeAssistant) -> PassText:
    """Load the words for the events, in Home Assistant's language.

    Home Assistant fills in English for any string a translation lacks.
    """
    language = resolve_language(hass.config.language, await hass.async_add_executor_job(_languages))
    strings = await async_get_translations(hass, language, "common", [DOMAIN])
    return PassText({key.removeprefix(_PREFIX): value for key, value in strings.items()})


class PassText:
    """Words for the passes, in one language."""

    def __init__(self, strings: dict[str, str]) -> None:
        """Initialise with the integration's common strings, keyed without their prefix."""
        self._strings = strings

    def _t(self, key: str, **values: Any) -> str:
        return self._strings[key].format(**values)

    def _number(self, value: float) -> str:
        text = f"{value:.1f}"
        # "-0.0" reads oddly; the sensors say 0.0 too.
        if text == "-0.0":
            text = "0.0"
        return text.replace(".", self._t("decimal_separator"))

    def _when_and_where(self, key: str, moment: Moment, **more: str) -> str:
        return self._t(
            key,
            time=_clock(moment.time),
            direction=self._t(f"compass_{compass(moment.azimuth).lower()}"),
            elevation=f"{moment.elevation:.0f}",
            **more,
        )

    def summary(self, p: ListedPass) -> str:
        """Event title: the satellite, and whether the pass is bright."""
        key = "calendar_summary_bright" if p.bright else "calendar_summary"
        return self._t(key, title=p.title)

    def description(self, p: ListedPass) -> str:
        """Say the best moment to look, then the rest of the pass, what else to know, and the link.

        The link stays last: the blueprint's notification leaves out the last line.
        """
        named = p.lead
        sat = named.satellite
        count = p.count
        best = self._number(named.peak_magnitude)
        lines = (
            self._when_and_where("calendar_brightest", named.brightest, magnitude=best),
            self._when_and_where("calendar_appears", named.appears),
            self._when_and_where("calendar_disappears", named.vanishes),
            (
                None
                if p.cloud_cover is None
                else self._t("calendar_cloud_cover", cloud_cover=p.cloud_cover)
            ),
            self._t("calendar_together", count=count) if count > 1 else None,
            self._t("calendar_about", name=sat.name, url=info_url(sat.norad_id, sat.name)),
        )
        return "\n".join(filter(None, lines))


def _clock(t: datetime) -> str:
    return f"{dt_util.as_local(t):%H:%M:%S}"


def event_times(p: ListedPass) -> tuple[datetime, datetime]:
    """Start and end of a pass, to the second as the sensors give them."""
    start = dt_util.as_local(p.start.replace(microsecond=0))
    end = dt_util.as_local(p.end.replace(microsecond=0))
    return start, max(end, start + _MIN_EVENT)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SatelliteSpotterConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the calendar (only forwarded while the option is on)."""
    async_add_entities([SatellitePassCalendar(entry.runtime_data, await async_pass_text(hass))])


class SatellitePassCalendar(SatelliteSpotterEntity, CalendarEntity):
    """Every predicted pass of the next five days, the ones the sensors report."""

    def __init__(self, coordinator: SatelliteSpotterCoordinator, text: PassText) -> None:
        """Initialise the calendar."""
        super().__init__(coordinator, "passes")
        self._text = text
        # The first state is written with the passes there are now.
        self._written_data: Predictions | None = coordinator.data
        self._written_success = coordinator.last_update_success

    def _event(self, p: ListedPass, start: datetime, end: datetime) -> CalendarEvent:
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
        """The pass under way, or else the next one.

        Judged by the event's own times, so that at the end of an event, when
        the calendar's timer writes the state, it moves on to the next pass.
        """
        data = self.coordinator.data
        if not self.available or data is None:
            return None
        now = dt_util.now()
        for p in data.passes:
            start, end = event_times(p)
            if end > now:
                return self._event(p, start, end)
        return None

    @override
    async def async_get_events(
        self, hass: HomeAssistant, start_date: datetime, end_date: datetime
    ) -> list[CalendarEvent]:
        """Return the passes that overlap the requested range.

        Nothing while predictions are paused: the sensors are unavailable then,
        and passes predicted from orbital elements that old would mislead.
        """
        data = self.coordinator.data
        if not self.available or data is None:
            return []
        events = []
        for p in data.passes:
            start, end = event_times(p)
            if end > start_date and start < end_date:
                events.append(self._event(p, start, end))
        return events

    @callback
    @override
    def _handle_coordinator_update(self) -> None:
        """Write the state when the passes change, not at every pass boundary.

        The coordinator wakes its entities as passes start and end; the
        calendar's own timers follow its events, and every write makes open
        calendars fetch the events again.
        """
        data, success = self.coordinator.data, self.coordinator.last_update_success
        if data is self._written_data and success == self._written_success:
            return
        self._written_data, self._written_success = data, success
        super()._handle_coordinator_update()
