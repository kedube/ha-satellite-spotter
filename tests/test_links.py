"""Where a satellite's link to read about it points."""

from __future__ import annotations

from custom_components.satellite_spotter.links import info_url

ISS = "https://en.wikipedia.org/wiki/International_Space_Station"


def test_norad_id_wins_over_the_name() -> None:
    assert info_url(25544, "Starlink-1234") == ISS


def test_name_prefix_for_a_family_of_satellites() -> None:
    assert info_url(1, "Starlink-1234") == "https://en.wikipedia.org/wiki/Starlink"


def test_name_prefix_ignores_case() -> None:
    """CelesTrak writes STARLINK-1234 in capitals."""
    assert info_url(1, "STARLINK-1234") == "https://en.wikipedia.org/wiki/Starlink"


def test_more_specific_prefix_wins() -> None:
    """The Long March 3's stages have a page of their own, the other stages the family's."""
    assert info_url(1, "CZ-3B R/B") == "https://en.wikipedia.org/wiki/Long_March_3"
    assert info_url(1, "CZ-4C R/B") == "https://en.wikipedia.org/wiki/Long_March_(rocket_family)"


def test_anything_else_goes_to_heavens_above() -> None:
    assert info_url(12345, "NOAA 18") == "https://heavens-above.com/satinfo.aspx?satid=12345"
