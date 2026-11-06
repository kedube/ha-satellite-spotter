"""Adding and moving a location, and its options."""

from __future__ import annotations

from collections.abc import Mapping
import logging
import math
from typing import Any, override

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlowWithReload,
)
from homeassistant.const import (
    CONF_ELEVATION,
    CONF_LATITUDE,
    CONF_LOCATION,
    CONF_LONGITUDE,
    CONF_NAME,
    CONF_RADIUS,
    DEGREE,
    UnitOfLength,
    UnitOfTime,
)
from homeassistant.core import callback
from homeassistant.data_entry_flow import section
from homeassistant.helpers.selector import (
    BooleanSelector,
    EntitySelector,
    EntitySelectorConfig,
    LocationSelector,
    LocationSelectorConfig,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
import voluptuous as vol

from .catalog import async_shared_catalog
from .celestrak import CatalogError, DownloadRefused
from .const import (
    CONF_ALERT_LEAD_MINUTES,
    CONF_BRIGHTNESS_CUTOFF,
    CONF_CLOUD_FORECAST,
    CONF_FOLLOW_ENTITY,
    CONF_GOOGLE_API_KEY,
    CONF_MAPILLARY_TOKEN,
    CONF_MIN_ELEVATION,
    CONF_SHOW_CALENDAR,
    CONF_SHOW_PANEL,
    CONF_STREET_SOURCE,
    CONF_STREET_VIEW,
    CONF_UNITS,
    CONF_WEATHER_ENTITY,
    CUTOFF_MAX,
    CUTOFF_MIN,
    CUTOFF_STEP,
    DEFAULT_ALERT_LEAD_MINUTES,
    DEFAULT_BRIGHTNESS_CUTOFF,
    DEFAULT_CLOUD_FORECAST,
    DEFAULT_MIN_ELEVATION,
    DEFAULT_SHOW_CALENDAR,
    DEFAULT_SHOW_PANEL,
    DEFAULT_UNITS,
    DOMAIN,
    ELEVATION_MAX_M,
    ELEVATION_MIN_M,
    MIN_ELEVATION_HIGHEST,
    MIN_ELEVATION_LOWEST,
    STREET_SOURCES,
    UNITS,
)
from .street import (
    MAPILLARY_TOKEN_FORMAT,
    async_check_google_key,
    async_check_mapillary_token,
    street_options,
)

_LOGGER = logging.getLogger(__name__)

_DEFAULT_NAME = "Home"
_COORDINATE_DIGITS = 5
_MAX_LATITUDE = 90.0
_MAX_LONGITUDE = 180.0

_ELEVATION_SELECTOR = NumberSelector(
    NumberSelectorConfig(
        min=ELEVATION_MIN_M,
        max=ELEVATION_MAX_M,
        step=1,
        mode=NumberSelectorMode.BOX,
        unit_of_measurement=UnitOfLength.METERS,
    )
)
_PASSWORD_SELECTOR = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))
# NumberSelector takes "nan": it fails no comparison with the limits. Only the API can send one.
_NUMBERS = (CONF_BRIGHTNESS_CUTOFF, CONF_ALERT_LEAD_MINUTES, CONF_MIN_ELEVATION)


class _AnyLocationSelector(LocationSelector):
    """The location picker, leaving range checks to the flow, which wraps or explains them.

    From Home Assistant 2026.11 the selector itself refuses out-of-range values.
    """

    DATA_SCHEMA = vol.Schema(
        {
            vol.Required(CONF_LATITUDE): vol.Coerce(float),
            vol.Required(CONF_LONGITUDE): vol.Coerce(float),
            vol.Optional(CONF_RADIUS): vol.Coerce(float),
        }
    )

    @override
    def __call__(self, data: Any) -> dict[str, float]:
        """Coerce the numbers to floats, and nothing else."""
        location: dict[str, float] = self.DATA_SCHEMA(data)
        return location


_LOCATION_SELECTOR = _AnyLocationSelector(LocationSelectorConfig(radius=False))


def _checked_place(location: Mapping[str, float]) -> tuple[float, float] | None:
    """Return latitude and longitude, rounded and wrapped, or None if they make no sense."""
    latitude, longitude = location[CONF_LATITUDE], location[CONF_LONGITUDE]
    if not (math.isfinite(latitude) and math.isfinite(longitude)):
        return None
    if abs(longitude) > _MAX_LONGITUDE:
        longitude = (longitude + _MAX_LONGITUDE) % (2 * _MAX_LONGITUDE) - _MAX_LONGITUDE
    latitude = round(latitude, _COORDINATE_DIGITS)
    longitude = round(longitude, _COORDINATE_DIGITS)
    return None if abs(latitude) > _MAX_LATITUDE else (latitude, longitude)


def _unique_id(latitude: float, longitude: float) -> str:
    """Return what makes a place the same place: to about 10 m, and never -0.0000."""
    return f"{round(latitude, 4) + 0.0:.4f}_{round(longitude, 4) + 0.0:.4f}"


class SatelliteSpotterConfigFlow(ConfigFlow, domain=DOMAIN):
    """Adds a location, or moves one."""

    VERSION = 1
    MINOR_VERSION = 1

    @staticmethod
    @callback
    @override
    def async_get_options_flow(config_entry: ConfigEntry) -> SatelliteSpotterOptionsFlow:
        """Return the options flow."""
        return SatelliteSpotterOptionsFlow()

    def _user_schema(self) -> vol.Schema:
        return vol.Schema(
            {
                vol.Required(CONF_NAME, default=_DEFAULT_NAME): TextSelector(),
                vol.Required(
                    CONF_LOCATION,
                    default={
                        CONF_LATITUDE: self.hass.config.latitude,
                        CONF_LONGITUDE: self.hass.config.longitude,
                    },
                ): _LOCATION_SELECTOR,
                vol.Required(CONF_ELEVATION, default=self.hass.config.elevation): (
                    _ELEVATION_SELECTOR
                ),
            }
        )

    async def _async_catalog_error(self) -> str | None:
        """Make sure there is a catalog to predict from; return what went wrong if not.

        One that is there will do, even if a new one is due: that comes after setup. Someone is
        waiting, so a failed download is tried again now, but CelesTrak's refusal stands.
        """
        catalog = async_shared_catalog(self.hass)
        try:
            if await catalog.async_load() is None:
                catalog.forget_failed_download()
                await catalog.async_satellites()
        except DownloadRefused:
            return "download_limited"
        except CatalogError:
            return "cannot_connect"
        except Exception:
            _LOGGER.exception("Unexpected error while loading the satellite catalog")
            return "unknown"
        return None

    @override
    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Ask where the location is, and make sure the catalog can be had."""
        errors: dict[str, str] = {}
        if user_input is not None:
            place = _checked_place(user_input[CONF_LOCATION])
            name = user_input[CONF_NAME].strip()
            if not name:
                errors[CONF_NAME] = "name_required"
            if place is None:
                errors[CONF_LOCATION] = "invalid_location"
            if not math.isfinite(user_input[CONF_ELEVATION]):
                errors[CONF_ELEVATION] = "invalid_elevation"
            if place is not None and not errors:
                # Two forms can be open for one place: the second finds the first's entry there.
                await self.async_set_unique_id(_unique_id(*place), raise_on_progress=False)
                self._abort_if_unique_id_configured()
                if (error := await self._async_catalog_error()) is not None:
                    errors["base"] = error
                else:
                    return self.async_create_entry(
                        title=name,
                        data={
                            CONF_LATITUDE: place[0],
                            CONF_LONGITUDE: place[1],
                            CONF_ELEVATION: user_input[CONF_ELEVATION],
                        },
                    )
        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(self._user_schema(), user_input),
            errors=errors,
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Move a location in place, so that what shows it keeps working."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            place = _checked_place(user_input[CONF_LOCATION])
            if place is None:
                errors[CONF_LOCATION] = "invalid_location"
            if not math.isfinite(user_input[CONF_ELEVATION]):
                errors[CONF_ELEVATION] = "invalid_elevation"
            if place is not None and not errors:
                unique_id = _unique_id(*place)
                if unique_id != entry.unique_id:
                    await self.async_set_unique_id(unique_id, raise_on_progress=False)
                    self._abort_if_unique_id_configured()
                return self.async_update_reload_and_abort(
                    entry,
                    unique_id=unique_id,
                    data={
                        CONF_LATITUDE: place[0],
                        CONF_LONGITUDE: place[1],
                        CONF_ELEVATION: user_input[CONF_ELEVATION],
                    },
                    reason="reconfigure_successful",
                    reload_even_if_entry_is_unchanged=False,
                )
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_LOCATION,
                    default={
                        CONF_LATITUDE: entry.data.get(CONF_LATITUDE, self.hass.config.latitude),
                        CONF_LONGITUDE: entry.data.get(CONF_LONGITUDE, self.hass.config.longitude),
                    },
                ): _LOCATION_SELECTOR,
                vol.Required(
                    CONF_ELEVATION,
                    default=entry.data.get(CONF_ELEVATION, self.hass.config.elevation),
                ): _ELEVATION_SELECTOR,
            }
        )
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=self.add_suggested_values_to_schema(schema, user_input),
            errors=errors,
        )


def _options_schema(options: Mapping[str, Any]) -> vol.Schema:
    """Return the options form, offering what is set now."""
    return vol.Schema(
        {
            vol.Required(
                CONF_BRIGHTNESS_CUTOFF,
                default=options.get(CONF_BRIGHTNESS_CUTOFF, DEFAULT_BRIGHTNESS_CUTOFF),
            ): NumberSelector(
                NumberSelectorConfig(
                    min=CUTOFF_MIN, max=CUTOFF_MAX, step=CUTOFF_STEP, mode=NumberSelectorMode.SLIDER
                )
            ),
            vol.Required(
                CONF_CLOUD_FORECAST,
                default=options.get(CONF_CLOUD_FORECAST, DEFAULT_CLOUD_FORECAST),
            ): BooleanSelector(),
            vol.Required(
                CONF_ALERT_LEAD_MINUTES,
                default=options.get(CONF_ALERT_LEAD_MINUTES, DEFAULT_ALERT_LEAD_MINUTES),
            ): NumberSelector(
                NumberSelectorConfig(
                    min=1,
                    max=240,
                    step=1,
                    mode=NumberSelectorMode.BOX,
                    unit_of_measurement=UnitOfTime.MINUTES,
                )
            ),
            vol.Required(
                CONF_MIN_ELEVATION,
                default=options.get(CONF_MIN_ELEVATION, DEFAULT_MIN_ELEVATION),
            ): NumberSelector(
                NumberSelectorConfig(
                    min=MIN_ELEVATION_LOWEST,
                    max=MIN_ELEVATION_HIGHEST,
                    step=1,
                    mode=NumberSelectorMode.SLIDER,
                    unit_of_measurement=DEGREE,
                )
            ),
            vol.Optional(CONF_WEATHER_ENTITY): EntitySelector(
                EntitySelectorConfig(domain="weather")
            ),
            vol.Optional(CONF_FOLLOW_ENTITY): EntitySelector(
                EntitySelectorConfig(domain=["person", "device_tracker"])
            ),
            vol.Required(
                CONF_SHOW_PANEL, default=options.get(CONF_SHOW_PANEL, DEFAULT_SHOW_PANEL)
            ): BooleanSelector(),
            vol.Required(
                CONF_SHOW_CALENDAR, default=options.get(CONF_SHOW_CALENDAR, DEFAULT_SHOW_CALENDAR)
            ): BooleanSelector(),
            vol.Required(CONF_UNITS, default=options.get(CONF_UNITS, DEFAULT_UNITS)): (
                SelectSelector(
                    SelectSelectorConfig(
                        options=list(UNITS),
                        mode=SelectSelectorMode.DROPDOWN,
                        translation_key=CONF_UNITS,
                    )
                )
            ),
            vol.Required(CONF_STREET_VIEW): section(
                vol.Schema(
                    {
                        vol.Required(
                            CONF_STREET_SOURCE,
                            default=street_options(options)[CONF_STREET_SOURCE],
                        ): SelectSelector(
                            SelectSelectorConfig(
                                options=list(STREET_SOURCES),
                                mode=SelectSelectorMode.DROPDOWN,
                                translation_key=CONF_STREET_SOURCE,
                            )
                        ),
                        vol.Optional(CONF_MAPILLARY_TOKEN): _PASSWORD_SELECTOR,
                        vol.Optional(CONF_GOOGLE_API_KEY): _PASSWORD_SELECTOR,
                    }
                ),
                {"collapsed": True},
            ),
        }
    )


class SatelliteSpotterOptionsFlow(OptionsFlowWithReload):
    """Which passes are reported, how, and where the street view's photos come from."""

    async def _async_street_error(
        self, street: Mapping[str, Any], errors: dict[str, str]
    ) -> dict[str, str]:
        """Note the first thing wrong with the street view's settings; return its placeholders.

        Keys already saved are not tried again.
        """
        saved = street_options(self.config_entry.options)
        source = street[CONF_STREET_SOURCE]
        key, token = street.get(CONF_GOOGLE_API_KEY), street.get(CONF_MAPILLARY_TOKEN)
        if source == "google" and not key:
            errors["base"] = "google_key_needed"
        elif source == "mapillary" and not token:
            errors["base"] = "mapillary_token_needed"
        elif token and not MAPILLARY_TOKEN_FORMAT.fullmatch(token):
            errors["base"] = "mapillary_token_format"
        elif (
            key
            and key != saved.get(CONF_GOOGLE_API_KEY)
            and (why := await async_check_google_key(self.hass, key)) is not None
        ):
            errors["base"] = "google_refused"
            return {"error": why}
        elif (
            token
            and token != saved.get(CONF_MAPILLARY_TOKEN)
            and (why := await async_check_mapillary_token(self.hass, token)) is not None
        ):
            errors["base"] = "mapillary_refused"
            return {"error": why}
        return {}

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show the options, and keep them once the street view's keys check out."""
        errors: dict[str, str] = {}
        placeholders: dict[str, str] = {}
        if user_input is not None:
            for key in _NUMBERS:
                if not math.isfinite(user_input[key]):
                    errors[key] = "invalid_number"
            street = street_options(user_input)
            if not errors:
                placeholders = await self._async_street_error(street, errors)
            if not errors:
                return self.async_create_entry(data={**user_input, CONF_STREET_VIEW: street})
        options = self.config_entry.options
        typed = (
            user_input
            if user_input is not None
            else {**options, CONF_STREET_VIEW: street_options(options)}
        )
        return self.async_show_form(
            step_id="init",
            data_schema=self.add_suggested_values_to_schema(_options_schema(options), typed),
            errors=errors,
            description_placeholders=placeholders,
        )
