"""The backend's strings: every language complete, consistent with the code and the manifest."""

from __future__ import annotations

import json
from pathlib import Path
import re
import string
from typing import Any

import pytest

from custom_components.satellite_spotter.binary_sensor import BINARY_SENSORS
from custom_components.satellite_spotter.const import (
    CATALOG_STALE_UPSTREAM,
    ISSUE_CATALOG_STALE,
    STREET_SOURCES,
    UNITS,
)
from custom_components.satellite_spotter.sensor import SENSORS

from .common import INTEGRATION, ROOT

TRANSLATIONS = INTEGRATION / "translations"
LANGUAGES = sorted(p.stem for p in TRANSLATIONS.glob("*.json"))


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
        same = {k for k, v in local.items() if v == english[k] and not k.startswith("common.")}
        assert len(same) <= 6, sorted(same)


def test_entities_have_names_and_icons() -> None:
    """Every entity key has a name in every language and an icon."""
    strings = _load(INTEGRATION / "strings.json")["entity"]
    icons = _load(INTEGRATION / "icons.json")["entity"]
    keys = {
        "sensor": {d.key for d in SENSORS},
        "binary_sensor": {d.key for d in BINARY_SENSORS},
        "calendar": {"passes"},
    }
    assert {platform: set(names) for platform, names in strings.items()} == keys
    assert {platform: set(names) for platform, names in icons.items()} == keys
    for platform, names in icons.items():
        for key, icon in names.items():
            assert icon["default"].startswith("mdi:"), (platform, key)
    assert strings["sensor"]["passes_next_24h"]["unit_of_measurement"] == "passes"


def test_the_code_uses_only_defined_strings() -> None:
    strings = _load(INTEGRATION / "strings.json")
    assert set(strings["selector"]["units"]["options"]) == set(UNITS)
    assert set(strings["selector"]["street_source"]["options"]) == set(STREET_SOURCES)
    # The repair, and the setup errors, each worded for failing downloads or for a
    # website catalog just as old.
    issues = {key: _placeholders(issue["description"]) for key, issue in strings["issues"].items()}
    assert issues == {ISSUE_CATALOG_STALE: {"age", "error"}, CATALOG_STALE_UPSTREAM: {"age"}}
    errors = {key: _placeholders(error["message"]) for key, error in strings["exceptions"].items()}
    assert errors == {"catalog_unavailable": {"error"}, **issues}
    assert 'translation_key="catalog_unavailable"' in (INTEGRATION / "coordinator.py").read_text()
    errors = set(strings["config"]["error"]) | set(strings["options"]["error"])
    source = (INTEGRATION / "config_flow.py").read_text()
    used = set(re.findall(r'errors\[[^\]]+\] = "(\w+)"', source))
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
    assert "Open-Meteo" in options["cloud_cover"]
    assert "OpenFreeMap" in options["show_in_sidebar"]
    # The keys go to the browser, and Mapillary sees the area around home.
    street = strings["options"]["step"]["init"]["sections"]["street_view"]
    assert "browser" in street["description"] and "keys" in street["description"]
    assert "area around home" in street["data_description"]["mapillary_token"]


def test_manifest_and_requirements_agree() -> None:
    manifest = _load(INTEGRATION / "manifest.json")
    assert manifest["domain"] == "satellite_spotter"
    assert manifest["name"] == "Satellite Spotter"
    (requirement,) = manifest["requirements"]
    # Home Assistant installs it from PyPI, so it is pinned by version.
    assert re.fullmatch(r"pysatellitespotter==[\d.]+", requirement)
    for name in ("requirements_test.txt", "requirements_test_oldest.txt"):
        assert requirement in (ROOT / name).read_text().splitlines()
    hacs = _load(ROOT / "hacs.json")
    assert hacs["name"] == "Satellite Spotter"
