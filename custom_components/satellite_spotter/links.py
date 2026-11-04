"""Where to read about a satellite: the links See A Satellite Tonight's website gives."""

from __future__ import annotations

_BY_NORAD_ID = {
    20580: "https://en.wikipedia.org/wiki/Hubble_Space_Telescope",
    25544: "https://en.wikipedia.org/wiki/International_Space_Station",
    41765: "https://en.wikipedia.org/wiki/Tiangong-2",
    41868: "https://en.wikipedia.org/wiki/Shenzhou_11",
    42830: "https://earthsky.org/space/mayak-bright-russian-satellite-july-august-2017",
    43552: "https://brownspace.org/equisat/",
    48274: "https://en.wikipedia.org/wiki/Tiangong_space_station",
    53807: "https://ast-science.com/spacemobile-network/bluewalker-3/",
    59588: "https://www.nasa.gov/mission/acs3/",
}
# The first prefix that fits wins, so "CZ-3" has to stay ahead of "CZ-".
_BY_NAME_PREFIX = (
    ("STARLINK", "https://en.wikipedia.org/wiki/Starlink"),
    ("SPACEMOBILE", "https://en.wikipedia.org/wiki/AST_SpaceMobile"),
    ("QIANFAN", "https://en.wikipedia.org/wiki/Qianfan"),
    ("HULIANWANG", "https://en.wikipedia.org/wiki/Guowang"),
    ("GUOWANG", "https://en.wikipedia.org/wiki/Guowang"),
    ("ARIANE", "https://en.wikipedia.org/wiki/Ariane_(rocket_family)"),
    ("COSMOS", "https://en.wikipedia.org/wiki/Kosmos_(satellite)"),
    ("CZ-3", "https://en.wikipedia.org/wiki/Long_March_3"),
    ("SL-", "https://en.wikipedia.org/wiki/Zenit_(rocket_family)"),
    ("FALCON 9", "https://en.wikipedia.org/wiki/Falcon_9"),
    ("ATLAS", "https://en.wikipedia.org/wiki/Atlas_(rocket_family)"),
    ("BLOCK DM-SL", "https://en.wikipedia.org/wiki/Blok_D"),
    ("BREEZE-M", "https://en.wikipedia.org/wiki/Briz_(rocket_stage)"),
    ("CZ-", "https://en.wikipedia.org/wiki/Long_March_(rocket_family)"),
    ("TITAN", "https://en.wikipedia.org/wiki/Titan_(rocket_family)"),
    ("H-2", "https://en.wikipedia.org/wiki/H-II"),
)


def info_url(norad_id: int, name: str) -> str:
    """Return the page about a satellite; Heavens-Above has one for any other."""
    if (url := _BY_NORAD_ID.get(norad_id)) is not None:
        return url
    upper = name.upper()
    by_name = (url for prefix, url in _BY_NAME_PREFIX if upper.startswith(prefix))
    return next(by_name, f"https://heavens-above.com/satinfo.aspx?satid={norad_id}")
