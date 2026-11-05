"""Where to read about a satellite."""

from __future__ import annotations

# The few that people look up by name; N2YO has a page for everything else in orbit.
_WIKIPEDIA_PAGES = {
    20580: "Hubble_Space_Telescope",
    25544: "International_Space_Station",
    48274: "Tiangong_space_station",
}


def about_url(norad_id: int) -> str:
    """Return the page to read about a satellite, by its catalog number."""
    if (page := _WIKIPEDIA_PAGES.get(norad_id)) is not None:
        return f"https://en.wikipedia.org/wiki/{page}"
    return f"https://www.n2yo.com/satellite/?s={norad_id}"
