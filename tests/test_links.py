"""Where a satellite's link to read about it points."""

from __future__ import annotations

import pytest

from custom_components.satellite_spotter.links import info_url

WIKIPEDIA = "https://en.wikipedia.org/wiki/"


@pytest.mark.parametrize(
    ("norad_id", "name", "page"),
    [
        # An object with an article of its own, whatever it is called.
        (25544, "ISS", "International_Space_Station"),
        (25544, "STARLINK-1234", "International_Space_Station"),
        # A family, in any case.
        (1, "STARLINK-1234", "Starlink"),
        (1, "Starlink-1234", "Starlink"),
        # Each stage's own rocket, ahead of the family's page.
        (1, "CZ-3B R/B", "Long_March_3"),
        (1, "CZ-11 R/B", "Long_March_(rocket_family)"),
        (1, "H-2A R/B", "H-IIA"),
        (1, "H-2B R/B", "H-II_(rocket_family)"),
        # The Soviet designations are different rockets, and SL-3 is not SL-30.
        (1, "SL-3 R/B", "Vostok_(rocket_family)"),
        (1, "SL-16 R/B", "Zenit_(rocket_family)"),
    ],
)
def test_articles(norad_id: int, name: str, page: str) -> None:
    assert info_url(norad_id, name) == WIKIPEDIA + page


@pytest.mark.parametrize("name", ["NOAA 18", "SL-30 R/B", "TERRASAR-X"])
def test_anything_else_has_a_page_on_heavens_above(name: str) -> None:
    assert info_url(12345, name) == "https://www.heavens-above.com/satinfo.aspx?satid=12345"
