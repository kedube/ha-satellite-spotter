"""The files shipped for browsers: that they are there, and their compressed copies are true."""

from __future__ import annotations

import gzip

import pytest

from custom_components.satellite_spotter.const import CARD_MODULE, PANEL_MODULE

from .common import INTEGRATION

FRONTEND = INTEGRATION / "frontend"
MAPLIBRE = FRONTEND / "vendor" / "maplibre-gl-6.11.2"
MAPLIBRE_FILES = (
    "maplibre-gl.mjs",
    "maplibre-gl-shared.mjs",
    "maplibre-gl-worker.mjs",
    "maplibre-gl.css",
)


def test_the_modules_home_assistant_is_told_to_load_are_there() -> None:
    assert (FRONTEND / CARD_MODULE).is_file()
    assert (FRONTEND / PANEL_MODULE).is_file()
    assert (FRONTEND / "translations" / "en.js").is_file()


@pytest.mark.parametrize("name", MAPLIBRE_FILES)
def test_a_gzip_copy_holds_what_its_source_holds(name: str) -> None:
    source = (MAPLIBRE / name).read_bytes()
    assert gzip.decompress((MAPLIBRE / f"{name}.gz").read_bytes()) == source


@pytest.mark.parametrize("name", MAPLIBRE_FILES)
def test_a_brotli_copy_holds_what_its_source_holds(name: str) -> None:
    brotli = pytest.importorskip("brotli")
    source = (MAPLIBRE / name).read_bytes()
    assert brotli.decompress((MAPLIBRE / f"{name}.br").read_bytes()) == source


def test_nothing_of_ours_has_a_compressed_copy() -> None:
    """A browser is given the copy in place of its source, so ours would soon go stale."""
    copies = {path for path in FRONTEND.rglob("*") if path.suffix in (".gz", ".br")}
    assert copies == {
        MAPLIBRE / f"{name}{suffix}" for name in MAPLIBRE_FILES for suffix in (".gz", ".br")
    }
