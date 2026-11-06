"""The backend's strings: every language complete, consistent with the code and the manifest."""

from __future__ import annotations

import json
from pathlib import Path
import re
import string
from typing import Any

import homeassistant
import pytest

from custom_components.satellite_spotter.const import (
    CATALOG_STALE_UPSTREAM,
    ISSUE_CATALOG_STALE,
    STREET_SOURCES,
    UNITS,
)

from .common import INTEGRATION, ROOT

TRANSLATIONS = INTEGRATION / "translations"
LANGUAGES = sorted(p.stem for p in TRANSLATIONS.glob("*.json"))
# The integration categories arrived in Home Assistant 2026.11.
CATEGORIES = Path(homeassistant.__file__).parent / "generated" / "integration_categories.json"


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _leaves(tree: dict[str, Any], prefix: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in tree.items():
        if isinstance(value, dict):
            out |= _leaves(value, f"{prefix}{key}.")
        else:
            out[f"{prefix}{key}"] = value
    return out


def _placeholders(text: str) -> set[str]:
    return {name for _, name, _, _ in string.Formatter().parse(text) if name}


def test_languages() -> None:
    assert LANGUAGES == ["de", "en", "es", "fr", "it", "nl", "pl", "pt-BR", "sv"]


def test_strings_are_the_english_translation() -> None:
    """Custom integrations load only translations/*.json: strings.json must be the same."""
    strings = (INTEGRATION / "strings.json").read_bytes()
    assert strings == (TRANSLATIONS / "en.json").read_bytes()
    assert b"[%key:" not in strings


@pytest.mark.parametrize("language", LANGUAGES)
def test_every_language_is_complete(language: str) -> None:
    english = _leaves(_load(INTEGRATION / "strings.json"))
    local = _leaves(_load(TRANSLATIONS / f"{language}.json"))
    assert local.keys() == english.keys()
    for key, text in local.items():
        assert text.strip(), key
        assert _placeholders(text) == _placeholders(english[key]), key
        assert "[%key:" not in text, key
    if language != "en":
        # Translated, not copied (names and units excepted).
        same = {
            k
            for k, v in local.items()
            if v == english[k] and not k.startswith(("common.", "selector.kind."))
        }
        assert len(same) <= 6, sorted(same)


def test_entities_have_names_and_icons() -> None:
    """Every entity key has a name in every language and an icon."""
    strings = _load(INTEGRATION / "strings.json")["entity"]
    icons = _load(INTEGRATION / "icons.json")["entity"]
    keys = {
        "sensor": {
            "next_visible_pass",
            "next_visible_pass_peak_elevation",
            "next_visible_pass_brightness",
            "next_visible_pass_duration",
            "next_visible_pass_cloud_cover",
            "next_visible_pass_rating",
            "next_visible_satellite_name",
            "next_bright_pass",
            "satellite_elevation",
            "visible_passes_next_24_hours",
            "orbital_elements_epoch",
        },
        "binary_sensor": {"satellite_visible_now", "visible_pass_soon", "bright_pass_soon"},
        "calendar": {"visible_passes"},
        "device_tracker": {"satellite_position"},
    }
    assert {platform: set(names) for platform, names in strings.items()} == keys
    assert {platform: set(names) for platform, names in icons.items()} == keys
    for platform, names in icons.items():
        for key, icon in names.items():
            assert icon["default"].startswith("mdi:"), (platform, key)
    assert strings["sensor"]["visible_passes_next_24_hours"]["unit_of_measurement"] == "passes"


def test_the_code_uses_only_defined_strings() -> None:
    strings = _load(INTEGRATION / "strings.json")
    assert set(strings["selector"]["units"]["options"]) == set(UNITS)
    assert set(strings["selector"]["street_source"]["options"]) == set(STREET_SOURCES)
    # The repair, and the setup errors, each worded for failing downloads or for
    # data at CelesTrak just as old.
    issues = {key: _placeholders(issue["description"]) for key, issue in strings["issues"].items()}
    assert issues == {ISSUE_CATALOG_STALE: {"age", "error"}}
    errors = {key: _placeholders(error["message"]) for key, error in strings["exceptions"].items()}
    assert errors == {
        "catalog_unavailable": {"error"},
        CATALOG_STALE_UPSTREAM: {"age"},
        "unknown_location": set(),
        "location_not_loaded": set(),
        **issues,
    }
    services = (INTEGRATION / "services.py").read_text()
    assert {"unknown_location", "location_not_loaded"} <= set(
        re.findall(r'translation_key="(\w+)"', services)
    )
    assert 'translation_key="catalog_unavailable"' in (INTEGRATION / "coordinator.py").read_text()
    errors = set(strings["config"]["error"]) | set(strings["options"]["error"])
    source = (INTEGRATION / "config_flow.py").read_text()
    used = set(re.findall(r'errors\[[^\]]+\] = "(\w+)"', source))
    used |= set(re.findall(r'return "(\w+)"', source))
    assert used == errors
    section = strings["options"]["step"]["init"]["sections"]["street_view"]
    assert set(section["data"]) == set(section["data_description"]) == {
        "street_source", "mapillary_token", "google_api_key"
    }  # fmt: skip
    aborts = set(re.findall(r'reason="(\w+)"', source)) | {"already_configured"}
    assert aborts == set(strings["config"]["abort"])
    calendar = (INTEGRATION / "calendar.py").read_text()
    common = set(strings["common"])
    used = set(re.findall(r'"((?:calendar|compass)_\w*)', calendar)) | {"decimal_separator"}
    assert {k for k in used if not k.endswith("_")} <= common
    assert {f"compass_{c}" for c in ("n", "nne", "ne", "ene", "e", "ese", "se", "sse",
            "s", "ssw", "sw", "wsw", "w", "wnw", "nw", "nnw")} <= common  # fmt: skip


def test_privacy_is_described_honestly() -> None:
    """The location leaves Home Assistant for the cloud cover and the street view's tiles."""
    strings = _load(INTEGRATION / "strings.json")
    user = strings["config"]["step"]["user"]["description"]
    assert "Open-Meteo" in user and "map tiles" in user
    assert "never" not in user
    options = strings["options"]["step"]["init"]["data_description"]
    assert "Open-Meteo" in options["cloud_forecast"]
    assert "every hour" in options["cloud_forecast"]
    assert "OpenFreeMap" in options["show_in_sidebar"]
    # The keys go to administrators' browsers only, and Mapillary sees the area around home.
    street = strings["options"]["step"]["init"]["sections"]["street_view"]
    assert "administrators' browsers receive the keys" in street["description"]
    assert "Panoramax's photos only" in street["description"]
    assert "area around home" in street["data_description"]["mapillary_token"]


def test_manifest_and_requirements_agree() -> None:
    manifest = _load(INTEGRATION / "manifest.json")
    assert manifest["domain"] == "satellite_spotter"
    assert manifest["name"] == "Satellite Spotter"
    # Home Assistant installs them from PyPI. SGP4 is pinned by version; numpy is
    # for Home Assistant to pin, which it does for everything it runs.
    (numpy, sgp4) = manifest["requirements"]
    assert numpy.startswith("numpy>=")
    assert re.fullmatch(r"sgp4==[\d.]+", sgp4)
    for name in ("requirements_test.txt", "requirements_test_oldest.txt"):
        assert sgp4 in (ROOT / name).read_text().splitlines()
    hacs = _load(ROOT / "hacs.json")
    assert hacs["name"] == "Satellite Spotter"


@pytest.mark.skipif(
    not CATEGORIES.is_file(), reason="integration categories need a newer Home Assistant"
)
def test_manifest_categories_are_known() -> None:
    """Home Assistant knows the categories; hassfest only warns about one it does not."""
    known = set()
    for category in json.loads(CATEGORIES.read_text(encoding="utf-8")):
        known.add(category["slug"])
        known |= {f"{category['slug']}.{sub['slug']}" for sub in category["subcategories"]}
    categories = _load(INTEGRATION / "manifest.json")["categories"]
    assert 1 <= len(categories) <= 3
    assert set(categories) <= known
