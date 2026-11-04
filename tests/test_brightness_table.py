"""How scripts/make_brightness_table.py chooses a magnitude (made-up values, no real sources)."""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import sys

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "make_brightness_table", Path(__file__).parents[1] / "scripts/make_brightness_table.py"
)
table = importlib.util.module_from_spec(_SPEC)
# Its dataclass looks itself up by name.
sys.modules[_SPEC.name] = table
_SPEC.loader.exec_module(table)

LOW = {"PERIGEE": "400", "ORBIT_CENTER": "EA", "OBJECT_TYPE": "PAY"}


def _satcat(**names: str) -> dict[int, dict[str, str]]:
    """Objects 400 km up, as {"n1": "NAME"}."""
    return {int(key[1:]): {**LOW, "OBJECT_NAME": name} for key, name in names.items()}


def _build(
    satcat: dict[int, dict[str, str]],
    mccants: dict[int, float] | None = None,
    score: dict[int, float] | None = None,
    stellarium: dict[int, float] | None = None,
    gcat: dict[int, dict[str, str]] | None = None,
    overrides: dict[int, float] | None = None,
) -> dict[int, tuple[float, str]]:
    rows = table.build(
        mccants or {}, score or {}, stellarium or {}, gcat or {}, satcat, overrides or {}
    )
    return {row.norad_id: (row.magnitude, row.source) for row in rows}


def test_read_mccants_columns() -> None:
    text = (
        "00001 d Desig...  Name.......... Mag.  Sz1 Sz2 Sz3 RCS Comments\n"
        "00005   58 2B     Vanguard 1      9.5  0.2 0.0 0.0 .11\n"
        "02520   66 89B    EGRS 8                           .33\n"
        "25544   98 67A    ISS            -2.5\n"
    )
    assert table.read_mccants(text) == {5: 9.5, 25544: -2.5}


def test_intrinsic_undoes_distance_and_phase() -> None:
    """At 1000 km and phase 90 a diffuse sphere shows a third of its light (1/pi)."""
    expected = 3.0 + 2.5 * math.log10(1 / math.pi)
    assert table.intrinsic(3.0, 1000, 90) == pytest.approx(expected)
    # Twice as far is a quarter of the light: the same object is intrinsically brighter.
    assert table.intrinsic(3.0, 2000, 90) == pytest.approx(expected - 5 * math.log10(2))


@pytest.mark.parametrize(("range_km", "phase"), [(0, 90), (1000, 0), (1000, 150)])
def test_intrinsic_refuses_what_it_cannot_judge(range_km: float, phase: float) -> None:
    assert table.intrinsic(3.0, range_km, phase) is None


def _observation(norad: str = "7", **changes: str) -> dict[str, str]:
    return {
        "norad_cat_id": norad,
        "apparent_magnitude": "3.0",
        "range_to_sat_km_satchecker": "1000",
        "phase_angle_deg_satchecker": "90",
        "illuminated": "True",
        "potentially_discrepant": "False",
        **changes,
    }


def test_score_needs_enough_good_observations() -> None:
    enough = [_observation() for _ in range(table.MIN_OBSERVATIONS)]
    assert set(table.read_score(enough)) == {7}
    assert table.read_score(enough[1:]) == {}
    flagged = [*enough[1:], _observation(potentially_discrepant="True")]
    assert table.read_score(flagged) == {}
    in_shadow = [*enough[1:], _observation(illuminated="False")]
    assert table.read_score(in_shadow) == {}


def test_stellarium_values_that_repeat_mccants_are_dropped() -> None:
    text = '{"satellites": {"1": {"stdMag": 3.0}, "2": {"stdMag": 4.0}, "3": {"stdMag": 99}}}'
    assert table.read_stellarium(text, {1: 3.0}) == {2: 4.0}


def test_the_first_source_with_a_value_wins() -> None:
    satcat = _satcat(n1="A", n2="B", n3="C", n4="D")
    both = {1: 2.0, 2: 2.0, 3: 2.0, 4: 2.0}
    result = _build(
        satcat,
        mccants={2: 1.0, 3: 1.0},
        score={3: 0.5, 4: 0.5},
        stellarium=both,
        overrides={1: 0.1, 2: 0.2},
    )
    assert result == {
        1: (0.1, "override"),
        2: (0.2, "override"),
        3: (1.0 + table.MCCANTS_OFFSET, "mccants"),
        4: (0.5, "score"),
    }


def test_a_family_shares_its_median_but_debris_does_not() -> None:
    satcat = _satcat(n1="CZ-2C R/B", n2="CZ-2C R/B", n3="CZ-2C R/B", n4="CZ-2C R/B", n5="LONE")
    debris = {**LOW, "OBJECT_NAME": "CZ-2C R/B", "OBJECT_TYPE": "DEB"}
    result = _build({**satcat, 6: debris}, mccants={1: 1.0, 2: 2.0, 3: 3.0})
    assert result[4] == (2.0 + table.MCCANTS_OFFSET, "family")
    assert 5 not in result
    assert 6 not in result


def test_family_of() -> None:
    assert table.family_of("CZ-2C R/B") == "CZ-2C R/B"
    assert table.family_of("COSMOS 2251") == "COSMOS"
    assert table.family_of("ISS (ZARYA)") == "ISS"
    assert table.family_of("QIANFAN-80") == "QIANFAN"


def test_observed_values_are_checked_against_the_size() -> None:
    """Misidentified rows in SCORE gave a rocket stage -4.68, and stale values are common."""
    gcat = {
        n: {"Satcat": str(n), "Type": "R", "Length": "10", "Diameter": "4"} for n in range(1, 10)
    }
    satcat = _satcat(n1="A", n2="B", n3="C", n4="D", n5="E", n6="F")
    mccants = {5: 3.0, 6: 3.0}
    result = _build(
        satcat,
        mccants=mccants,
        score={1: -4.68, 2: 8.0, 3: 3.0},
        stellarium={4: 9.0},
        gcat=gcat,
    )
    assert 1 not in result  # Brighter than anything up there.
    assert 2 not in result  # Too far from the size, and too faint anyway.
    assert 4 not in result
    assert result[3] == (3.0, "score")


def test_objects_that_can_never_get_bright_are_left_out() -> None:
    satcat = {
        1: {**LOW, "OBJECT_NAME": "NEAR", "PERIGEE": "400"},
        2: {**LOW, "OBJECT_NAME": "FAR", "PERIGEE": "35000"},
    }
    assert set(_build(satcat, mccants={1: 4.0, 2: 4.0})) == {1}


@pytest.mark.parametrize(
    "change",
    [
        {"OBJECT_NAME": "STARLINK-1"},
        {"DECAY_DATE": "2020-01-01"},
        {"DATA_STATUS_CODE": "NEA"},
        {"ORBIT_CENTER": "MO"},
        {"PERIGEE": ""},
    ],
    ids=["starlink", "decayed", "no elements", "around the moon", "no perigee"],
)
def test_objects_left_out_whatever_their_brightness(change: dict[str, str]) -> None:
    satcat = {1: {**LOW, "OBJECT_NAME": "X", **change}}
    assert _build(satcat, mccants={1: 0.0}) == {}


def test_an_override_needs_a_citation(tmp_path: Path) -> None:
    path = tmp_path / "overrides.csv"
    path.write_text("norad_id,magnitude,citation\n1,2.5,Someone 2026\n")
    assert table.read_overrides(path) == {1: 2.5}
    path.write_text("norad_id,magnitude,citation\n1,2.5,\n")
    with pytest.raises(ValueError, match="no citation"):
        table.read_overrides(path)


def test_the_overrides_shipped_can_be_read() -> None:
    table.read_overrides(table.OVERRIDES)


def test_written_table_carries_its_attribution(tmp_path: Path) -> None:
    path = tmp_path / "table.csv"
    table.write_table([table.Row(1, 2.5, "mccants", "A, B")], path, "2026-11-04")
    text = path.read_text()
    assert text.startswith("# How bright")
    assert "2026-11-04" in text
    assert text.endswith('norad_id,magnitude,source,name\n1,2.50,mccants,"A, B"\n')
