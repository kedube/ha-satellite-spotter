"""Where a satellite's link to read about it points."""

from __future__ import annotations

import pytest

from custom_components.satellite_spotter.links import about_url


@pytest.mark.parametrize(
    ("norad_id", "page"),
    [
        (25544, "International_Space_Station"),
        (48274, "Tiangong_space_station"),
        (20580, "Hubble_Space_Telescope"),
    ],
)
def test_the_famous_ones_have_an_article(norad_id: int, page: str) -> None:
    assert about_url(norad_id) == f"https://en.wikipedia.org/wiki/{page}"


def test_anything_else_has_a_page_on_n2yo() -> None:
    assert about_url(53807) == "https://www.n2yo.com/satellite/?s=53807"
