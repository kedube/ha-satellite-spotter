"""Where to read about a satellite: an article on what it is, or else its Heavens-Above page."""

from __future__ import annotations

_WIKIPEDIA = "https://en.wikipedia.org/wiki/"
_HEAVENS_ABOVE = "https://www.heavens-above.com/satinfo.aspx?satid="

# Objects with an article of their own, by NORAD id.
_ARTICLES = {
    20580: "Hubble_Space_Telescope",
    25544: "International_Space_Station",
    25994: "Terra_(satellite)",
    48274: "Tiangong_space_station",
    53807: "BlueWalker_3",
    59588: "Advanced_Composite_Solar_Sail_System",
}
# Families, by how CelesTrak's names begin. The first that fits wins, so the rockets
# of a family stay ahead of the family, and a space keeps SL-3 from fitting SL-30.
_FAMILIES = (
    ("ALOS", "Advanced_Land_Observing_Satellite"),
    ("ARIANE", "Ariane_(rocket_family)"),
    ("ATLAS", "Atlas_(rocket_family)"),
    ("BIOMASS", "Biomass_(satellite)"),
    ("BLOCK DM", "Blok_D"),
    ("BREEZE-M", "Briz_(rocket_stage)"),
    ("COSMO-SKYMED", "COSMO-SkyMed"),
    ("COSMOS", "Kosmos_(satellite)"),
    ("CZ-2", "Long_March_2"),
    ("CZ-3", "Long_March_3"),
    ("CZ-4", "Long_March_4"),
    ("CZ-6", "Long_March_6"),
    ("CZ-8", "Long_March_8"),
    ("CZ-", "Long_March_(rocket_family)"),
    ("DELTA", "Delta_(rocket_family)"),
    ("FALCON 9", "Falcon_9"),
    ("GSLV", "Geosynchronous_Satellite_Launch_Vehicle"),
    ("GUOWANG", "Guowang"),
    ("H-2A", "H-IIA"),
    ("H-2", "H-II_(rocket_family)"),
    ("HULIANWANG", "Guowang"),
    ("IUS", "Inertial_Upper_Stage"),
    ("PSLV", "Polar_Satellite_Launch_Vehicle"),
    ("QIANFAN", "Qianfan"),
    ("SAOCOM", "SAOCOM"),
    ("SL-3 ", "Vostok_(rocket_family)"),
    ("SL-4 ", "Soyuz_(rocket_family)"),
    ("SL-8 ", "Kosmos-3M"),
    ("SL-16 ", "Zenit_(rocket_family)"),
    ("SPACEMOBILE", "AST_SpaceMobile"),
    ("STARLINK", "Starlink"),
    ("TITAN", "Titan_(rocket_family)"),
    ("YAOGAN", "Yaogan"),
)


def info_url(norad_id: int, name: str) -> str:
    """Return the page to read about a satellite."""
    article = _ARTICLES.get(norad_id)
    if article is None:
        upper = name.upper()
        article = next((page for start, page in _FAMILIES if upper.startswith(start)), None)
    return f"{_HEAVENS_ABOVE}{norad_id}" if article is None else f"{_WIKIPEDIA}{article}"
