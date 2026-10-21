"""Config flow for Satellite Spotter."""

from __future__ import annotations

import logging
import math
from typing import Any, override

from homeassistant.config_entries import (
    ConfigEntryState,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import (
    CONF_ELEVATION,
    CONF_LATITUDE,
    CONF_LOCATION,
    CONF_LONGITUDE,
    CONF_NAME,
    UnitOfLength,
    UnitOfTime,
)
from homeassistant.core import callback
from homeassistant.data_entry_flow import section
from homeassistant.helpers.selector import (
    BooleanSelector,
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
from see_a_satellite import CatalogError
import voluptuous as vol

from . import SatelliteSpotterConfigEntry
from .catalog import async_get_catalog
from .const import (
    CONF_ALERT_LEAD_MINUTES,
    CONF_CLOUD_COVER,
    CONF_GOOGLE_API_KEY,
    CONF_MAPILLARY_TOKEN,
    CONF_MAX_MAGNITUDE,
    CONF_SHOW_CALENDAR,
    CONF_SHOW_PANEL,
    CONF_STREET_SOURCE,
    CONF_STREET_VIEW,
    CONF_UNITS,
    DEFAULT_ALERT_LEAD_MINUTES,
    DEFAULT_CLOUD_COVER,
    DEFAULT_MAX_MAGNITUDE,
    DEFAULT_SHOW_CALENDAR,
    DEFAULT_SHOW_PANEL,
    DEFAULT_UNITS,
    DOMAIN,
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

DEFAULT_NAME = "Home"


def _number(
    minimum: float,
    maximum: float,
    step: float,
    unit: str | None = None,
    mode: NumberSelectorMode = NumberSelectorMode.BOX,
) -> NumberSelector:
    config = NumberSelectorConfig(min=minimum, max=maximum, step=step, mode=mode)
    if unit is not None:
        config["unit_of_measurement"] = unit
    return NumberSelector(config)


def _coordinates(location: dict[str, Any]) -> tuple[float, float] | None:
    """Latitude and longitude from the location selector, or None when out of range.

    The selector accepts any number. Longitudes written 0-360 (or wrapped
    further) are brought into -180..180 so that the same place is recognised
    as a duplicate whichever way it was typed.
    """
    latitude = round(float(location[CONF_LATITUDE]), 5)
    longitude = round(float(location[CONF_LONGITUDE]), 5)
    if abs(longitude) > 180:
        longitude = round((longitude + 180) % 360 - 180, 5)
    # Written so that NaN fails too.
    if not (math.isfinite(longitude) and -90 <= latitude <= 90):
        return None
    return latitude, longitude


def _unique_id(latitude: float, longitude: float) -> str:
    # About 10 m: one location per place.
    return f"{latitude:.4f}_{longitude:.4f}"


def _elevation_selector() -> NumberSelector:
    return _number(-500, 9000, 1, UnitOfLength.METERS)


def _location_selector() -> LocationSelector:
    return LocationSelector(LocationSelectorConfig(radius=False))


class SatelliteSpotterConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add an observing location."""

    VERSION = 1
    MINOR_VERSION = 1

    @override
    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Pick the location to predict passes for."""
        errors: dict[str, str] = {}
        if user_input is not None:
            if (coordinates := _coordinates(user_input[CONF_LOCATION])) is None:
                errors[CONF_LOCATION] = "invalid_location"
            else:
                latitude, longitude = coordinates
                await self.async_set_unique_id(_unique_id(latitude, longitude))
                self._abort_if_unique_id_configured()
                try:
                    # Shared with every location, so it is downloaded once.
                    await async_get_catalog(self.hass).async_get(retry_now=True)
                except CatalogError:
                    errors["base"] = "cannot_connect"
                except Exception:
                    _LOGGER.exception("Unexpected error while loading the satellite catalog")
                    errors["base"] = "unknown"
                else:
                    return self.async_create_entry(
                        title=user_input[CONF_NAME],
                        data={
                            CONF_LATITUDE: latitude,
                            CONF_LONGITUDE: longitude,
                            CONF_ELEVATION: float(user_input[CONF_ELEVATION]),
                        },
                    )

        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default=DEFAULT_NAME): str,
                vol.Required(
                    CONF_LOCATION,
                    default={
                        CONF_LATITUDE: self.hass.config.latitude,
                        CONF_LONGITUDE: self.hass.config.longitude,
                    },
                ): _location_selector(),
                vol.Required(CONF_ELEVATION, default=self.hass.config.elevation): (
                    _elevation_selector()
                ),
            }
        )
        if user_input is not None:
            # Keep what was typed, so only what was wrong needs correcting.
            schema = self.add_suggested_values_to_schema(schema, user_input)
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Move a location in place, so the dashboard cards that show it keep working."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            if (coordinates := _coordinates(user_input[CONF_LOCATION])) is None:
                errors[CONF_LOCATION] = "invalid_location"
            else:
                latitude, longitude = coordinates
                unique_id = _unique_id(latitude, longitude)
                if unique_id != entry.unique_id:
                    await self.async_set_unique_id(unique_id, raise_on_progress=False)
                    self._abort_if_unique_id_configured()
                changed = self.hass.config_entries.async_update_entry(
                    entry,
                    unique_id=unique_id,
                    data={
                        **entry.data,
                        CONF_LATITUDE: latitude,
                        CONF_LONGITUDE: longitude,
                        CONF_ELEVATION: float(user_input[CONF_ELEVATION]),
                    },
                )
                # A loaded entry reloads through its update listener; one that
                # is not loaded (still retrying setup, say) is retried now.
                if changed and entry.state is not ConfigEntryState.LOADED:
                    self.hass.config_entries.async_schedule_reload(entry.entry_id)
                return self.async_abort(reason="reconfigure_successful")

        schema = vol.Schema(
            {
                vol.Required(CONF_LOCATION): _location_selector(),
                vol.Required(CONF_ELEVATION): _elevation_selector(),
            }
        )
        current = {
            CONF_LOCATION: {
                CONF_LATITUDE: entry.data[CONF_LATITUDE],
                CONF_LONGITUDE: entry.data[CONF_LONGITUDE],
            },
            CONF_ELEVATION: entry.data.get(CONF_ELEVATION, 0.0),
        }
        schema = self.add_suggested_values_to_schema(schema, user_input or current)
        return self.async_show_form(step_id="reconfigure", data_schema=schema, errors=errors)

    @staticmethod
    @callback
    @override
    def async_get_options_flow(config_entry: SatelliteSpotterConfigEntry) -> OptionsFlow:
        """Return the options flow."""
        return SatelliteSpotterOptionsFlow()


def _street_schema(street: dict[str, Any]) -> vol.Schema:
    """Return the street view section: where its photos come from, and the services' keys."""
    password = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))
    return vol.Schema(
        {
            vol.Required(CONF_STREET_SOURCE, default=street[CONF_STREET_SOURCE]): SelectSelector(
                SelectSelectorConfig(
                    options=list(STREET_SOURCES),
                    translation_key=CONF_STREET_SOURCE,
                    mode=SelectSelectorMode.DROPDOWN,
                )
            ),
            # Optional, and offered as suggestions: a key emptied in the form is removed.
            vol.Optional(CONF_MAPILLARY_TOKEN): password,
            vol.Optional(CONF_GOOGLE_API_KEY): password,
        }
    )


class SatelliteSpotterOptionsFlow(OptionsFlow):
    """Tune which passes are reported and how they are shown."""

    async def _street_errors(
        self, street: dict[str, Any], errors: dict[str, str], placeholders: dict[str, str]
    ) -> None:
        """Refuse a source without its key, and a new key its service refuses."""
        source = street[CONF_STREET_SOURCE]
        if source == "google" and CONF_GOOGLE_API_KEY not in street:
            errors["base"] = "google_key_needed"
            return
        if source == "mapillary" and CONF_MAPILLARY_TOKEN not in street:
            errors["base"] = "mapillary_token_needed"
            return
        token = street.get(CONF_MAPILLARY_TOKEN)
        if token and not MAPILLARY_TOKEN_FORMAT.fullmatch(token):
            errors["base"] = "mapillary_token_format"
            return
        # A key that is already saved worked then: only new ones are tried.
        saved = street_options(self.config_entry.options)
        key = street.get(CONF_GOOGLE_API_KEY)
        if (
            key
            and key != saved.get(CONF_GOOGLE_API_KEY)
            and (reason := await async_check_google_key(self.hass, key)) is not None
        ):
            errors["base"] = "google_refused"
            placeholders["error"] = reason
            return
        if (
            token
            and token != saved.get(CONF_MAPILLARY_TOKEN)
            and (reason := await async_check_mapillary_token(self.hass, token)) is not None
        ):
            errors["base"] = "mapillary_refused"
            placeholders["error"] = reason

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Manage the options (the location reloads with them)."""
        errors: dict[str, str] = {}
        placeholders = {"error": ""}
        if user_input is not None:
            street = street_options(user_input)
            await self._street_errors(street, errors, placeholders)
            if not errors:
                return self.async_create_entry(data={**user_input, CONF_STREET_VIEW: street})

        current = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Required(
                    CONF_MAX_MAGNITUDE,
                    default=current.get(CONF_MAX_MAGNITUDE, DEFAULT_MAX_MAGNITUDE),
                ): _number(-2, 4, 0.5, mode=NumberSelectorMode.SLIDER),
                vol.Required(
                    CONF_CLOUD_COVER,
                    default=current.get(CONF_CLOUD_COVER, DEFAULT_CLOUD_COVER),
                ): BooleanSelector(),
                vol.Required(
                    CONF_ALERT_LEAD_MINUTES,
                    default=current.get(CONF_ALERT_LEAD_MINUTES, DEFAULT_ALERT_LEAD_MINUTES),
                ): _number(1, 240, 1, UnitOfTime.MINUTES),
                vol.Required(
                    CONF_SHOW_PANEL,
                    default=current.get(CONF_SHOW_PANEL, DEFAULT_SHOW_PANEL),
                ): BooleanSelector(),
                vol.Required(
                    CONF_SHOW_CALENDAR,
                    default=current.get(CONF_SHOW_CALENDAR, DEFAULT_SHOW_CALENDAR),
                ): BooleanSelector(),
                vol.Required(
                    CONF_UNITS,
                    default=current.get(CONF_UNITS, DEFAULT_UNITS),
                ): SelectSelector(
                    SelectSelectorConfig(
                        options=list(UNITS),
                        translation_key=CONF_UNITS,
                        mode=SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Required(CONF_STREET_VIEW): section(_street_schema(street_options(current))),
            }
        )
        # The keys saved (or, after an error, everything as typed) fill the form.
        schema = self.add_suggested_values_to_schema(
            schema, user_input or {CONF_STREET_VIEW: street_options(current)}
        )
        return self.async_show_form(
            step_id="init", data_schema=schema, errors=errors, description_placeholders=placeholders
        )
