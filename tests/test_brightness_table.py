"""How scripts/make_brightness_table.py chooses a magnitude (made-up values, no real sources)."""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import re
import subprocess
import sys
from typing import Any
from unittest.mock import patch

import pytest

from custom_components.satellite_spotter.celestrak import QUERIES

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
    mmt: dict[int, float] | None = None,
    mccants: dict[int, float] | None = None,
    score: dict[int, float] | None = None,
    stellarium: dict[int, float] | None = None,
    gcat: dict[int, dict[str, str]] | None = None,
    overrides: dict[int, float] | None = None,
    elements: set[int] | None = None,
) -> dict[int, tuple[float, str]]:
    rows = table.build(
        mmt or {},
        mccants or {},
        score or {},
        stellarium or {},
        gcat or {},
        satcat,
        overrides or {},
        elements,
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
    """A standard magnitude is for 1000 km and half lit, which is phase 90."""
    assert table.intrinsic(3.0, 1000, 90) == pytest.approx(3.0)
    # Twice as far is a quarter of the light: the same object is intrinsically brighter.
    assert table.intrinsic(3.0, 2000, 90) == pytest.approx(3.0 - 5 * math.log10(2))
    # Three quarters lit is half as bright again: the same object is intrinsically fainter.
    assert table.intrinsic(3.0, 1000, 60) == pytest.approx(3.0 + 2.5 * math.log10(1.5))


def test_mmts_list_gives_the_medians_of_objects_with_norad_numbers() -> None:
    """Made-up rows, in the list's columns."""
    header = (
        "# nsatellites: 3\n#\n# Catalogue Id Name Country Variability Period StdMag_Clear "
        "StdMag_Clear_Sigma StdMag_B StdMag_B_Sigma StdMag_V StdMag_V_Sigma StdMag_R "
        "StdMag_R_Sigma StdMag_Clear_Median StdMag_Clear_Min StdMag_Clear_Max Type Id\n"
    )

    def row(catalogue: str, number: object, name: str, median: object) -> str:
        return f'{catalogue} {number} "{name}" XX 0 0 9 0 0 0 0 0 0 0 {median} 8 10 PAY {number}\n'

    text = (
        header
        + row("NORAD", 900, "IT'S ONE", 3.5)
        + row("McCants", 901, "OTHER", 3.5)
        + row("NORAD", 902, "NO VALUE", "nan")
        + "NORAD 903 cut short\n"
    )
    assert table.read_mmt(text) == {900: 3.5}


def test_anything_else_is_not_mmts_list() -> None:
    with pytest.raises(ValueError, match="not MMT's satellite list"):
        table.read_mmt("<html>Not found</html>")


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
    satcat = _satcat(n1="A", n2="B", n3="C", n4="D", n5="E")
    every = {1: 2.0, 2: 2.0, 3: 2.0, 4: 2.0, 5: 2.0}
    result = _build(
        satcat,
        mmt={2: 1.5},
        mccants={1: 1.0, 2: 1.0, 3: 1.0},
        score={3: 0.5, 4: 0.5},
        stellarium=every,
        overrides={1: 0.1},
    )
    assert result == {
        1: (0.1, "override"),
        2: (1.5, "mmt"),
        3: (round(1.0 + table.MCCANTS_OFFSET + table.MCCANTS_TO_MMT["PAY"], 2), "mccants"),
        4: (0.5, "score"),
        5: (2.0, "stellarium"),
    }


@pytest.mark.parametrize("name", ["BLUEWALKER-3", "SPACEMOBILE-001", "BLUEBIRD 7"])
def test_observers_come_first_for_what_mmt_has_barely_seen(name: str) -> None:
    satcat = {1: {**LOW, "OBJECT_NAME": name}}
    assert _build(satcat, mmt={1: 1.5}, score={1: 0.5}) == {1: (0.5, "score")}
    # MMT's value is still better than none.
    assert _build(satcat, mmt={1: 1.5}) == {1: (1.5, "mmt")}


@pytest.mark.parametrize(
    ("kind", "offset"), [("R/B", 0.55), ("DEB", 0.15), ("PAY", 0.04), ("UNK", 0.04)]
)
def test_mccants_values_are_turned_into_standard_magnitudes(kind: str, offset: float) -> None:
    satcat = {1: {**LOW, "OBJECT_NAME": "X", "OBJECT_TYPE": kind}}
    (magnitude, source) = _build(satcat, mccants={1: 1.0})[1]
    assert source == "mccants"
    assert magnitude == pytest.approx(1.0 + 0.75 + offset)


def test_a_family_shares_its_median_but_debris_does_not() -> None:
    satcat = _satcat(n1="CZ-2C R/B", n2="CZ-2C R/B", n3="CZ-2C R/B", n4="CZ-2C R/B", n5="LONE")
    debris = {**LOW, "OBJECT_NAME": "CZ-2C R/B", "OBJECT_TYPE": "DEB"}
    result = _build({**satcat, 6: debris}, mccants={1: 1.0, 2: 2.0, 3: 3.0})
    assert result[4] == (round(2.0 + 0.75 + 0.04, 2), "family")
    assert 5 not in result
    assert 6 not in result


def test_a_family_in_mmts_list_comes_before_one_in_mccants() -> None:
    satcat = _satcat(n1="CZ-2C R/B", n2="CZ-2C R/B", n3="CZ-2C R/B", n4="CZ-2C R/B")
    three = {1: 1.0, 2: 2.0, 3: 3.0}
    result = _build(satcat, mmt={k: v - 0.5 for k, v in three.items()}, mccants=three)
    assert result[4] == (1.5, "family")


def test_only_objects_the_integration_has_an_orbit_for_are_kept() -> None:
    """Their values would be published for nothing."""
    satcat = _satcat(n1="A", n2="B")
    assert set(_build(satcat, mmt={1: 1.0, 2: 1.0}, elements={2})) == {2}


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


def test_observed_values_are_checked_against_a_published_mean() -> None:
    """Two standard deviations either way, for the constellation with a published mean."""
    mean, deviation = table.PUBLISHED_MEANS["QIANFAN"]
    near, far = mean - 1.9 * deviation, mean - 2.1 * deviation
    satcat = _satcat(n1="QIANFAN-1", n2="QIANFAN-2", n3="QIANFAN-3", n4="OTHER-1", n5="QIANFAN-5")
    result = _build(
        satcat,
        score={1: near, 2: far, 4: far},
        stellarium={3: far, 5: mean + 2.1 * deviation},
    )
    assert result == {1: (round(near, 2), "score"), 4: (round(far, 2), "score")}


def test_a_published_mean_does_not_overrule_mccants_or_a_citation() -> None:
    far = table.PUBLISHED_MEANS["QIANFAN"][0] - 3.0
    result = _build(_satcat(n1="QIANFAN-1", n2="QIANFAN-2"), mccants={1: far}, overrides={2: far})
    assert result[1][1] == "mccants"
    assert result[2][1] == "override"


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
    assert table.read_overrides(table.OVERRIDES)[48274] == 0.0


def test_written_table_carries_its_attribution(tmp_path: Path) -> None:
    path = tmp_path / "table.csv"
    table.write_table([table.Row(1, 2.5, "mccants", "A, B")], path, "2026-11-04")
    text = path.read_text()
    assert text.startswith("# How bright")
    assert "2026-11-04" in text
    # What MMT's team asks for.
    assert "Karpov et al. 2016" in text
    assert "Beskin et al. 2017" in text
    assert text.endswith('norad_id,magnitude,source,name\n1,2.50,mccants,"A, B"\n')


# --- Bringing the table up to date with a newer list ---------------------------


BUILT = "2026-11-05"


def _update(
    satcat: dict[int, dict[str, str]],
    mmt: dict[int, float],
    known: dict[int, tuple[float, str]],
) -> dict[int, tuple[float, str]]:
    rows = table.update(mmt, known, satcat, set(satcat), BUILT)
    return {row.norad_id: (row.magnitude, row.source) for row in rows}


def test_a_newer_list_replaces_its_own_values_only() -> None:
    satcat = _satcat(n1="A", n2="B", n3="C", n4="D")
    known = {1: (2.0, "mmt"), 2: (2.0, "mccants"), 3: (2.0, "score"), 4: (2.0, "stellarium")}
    assert _update(satcat, {1: 1.5}, known) == {
        1: (1.5, "mmt"),
        2: (2.0, "mccants"),
        3: (2.0, "score"),
        4: (2.0, "stellarium"),
    }


def test_a_newer_list_overrules_older_values_but_not_a_citation_or_observers() -> None:
    satcat = _satcat(n1="A", n2="BLUEWALKER-3", n3="B")
    known = {1: (0.1, "override"), 2: (0.2, "score"), 3: (0.3, "mccants")}
    assert _update(satcat, {1: 1.5, 2: 1.5, 3: 1.5}, known) == {
        1: (0.1, "override"),
        2: (0.2, "score"),
        3: (1.5, "mmt"),
    }


def test_what_is_new_to_orbit_comes_from_the_list() -> None:
    satcat = _satcat(n1="NEW SAT", n2="OTHER SAT")
    assert _update(satcat, {1: 1.5}, {}) == {1: (1.5, "mmt")}


def _stages(launched: str) -> dict[int, dict[str, str]]:
    """Three rocket stages on the list, and a fourth launched then, which is not."""
    satcat = _satcat(n1="CZ-2C R/B", n2="CZ-2C R/B", n3="CZ-2C R/B", n4="CZ-2C R/B")
    satcat[4]["LAUNCH_DATE"] = launched
    return satcat


def test_a_rocket_stage_launched_since_takes_its_familys_median_from_the_list() -> None:
    result = _update(_stages("2027-01-01"), {1: 1.0, 2: 2.0, 3: 3.0}, {})
    assert result[4] == (2.0, "family")


def test_a_rocket_stage_catalogued_after_the_last_update_still_takes_its_familys_median() -> None:
    """It can reach the catalogue days after its launch, and the table is updated every week."""
    result = _update(_stages("2026-10-29"), {1: 1.0, 2: 2.0, 3: 3.0}, {})
    assert result[4] == (2.0, "family")


def test_an_older_object_left_out_for_being_faint_does_not_come_back() -> None:
    """Its own measured value kept it out, and that outweighs its family's."""
    result = _update(_stages("2020-01-01"), {1: 1.0, 2: 2.0, 3: 3.0}, {})
    assert 4 not in result


def test_a_family_value_moves_with_the_list_and_stays_without_it() -> None:
    satcat = _satcat(n1="CZ-2C R/B", n2="CZ-2C R/B", n3="CZ-2C R/B", n4="CZ-2C R/B", n5="LONE")
    known = {4: (9.0, "family"), 5: (2.5, "family")}
    result = _update(satcat, {1: 1.0, 2: 2.0, 3: 3.0}, known)
    assert result[4] == (2.0, "family")
    assert result[5] == (2.5, "family")


def test_an_object_dropped_from_the_list_keeps_its_last_value() -> None:
    assert _update(_satcat(n1="A"), {}, {1: (2.0, "mmt")}) == {1: (2.0, "mmt")}


def test_the_update_leaves_out_what_the_integration_has_no_orbit_for() -> None:
    rows = table.update({1: 1.0, 2: 1.0}, {}, _satcat(n1="A", n2="B"), {2}, BUILT)
    assert [row.norad_id for row in rows] == [2]


def test_the_queries_are_the_integrations() -> None:
    assert list(table.ELEMENT_QUERIES) == list(QUERIES)


def test_the_table_survives_being_read_back(tmp_path: Path) -> None:
    path = tmp_path / "table.csv"
    table.write_table([table.Row(1, 2.5, "mmt", "A, B")], path, "2026-11-04")
    assert table.read_table(path) == {1: (2.5, "mmt")}


def _files(tmp_path: Path, rows: int) -> list[str]:
    """Made-up files for --update, without touching the network."""
    (tmp_path / "list.txt").write_text(
        "# Catalogue Id Name StdMag_Clear_Median\n"
        + "".join(f'NORAD {n} "SAT {n}" 1.5\n' for n in range(1, rows + 1))
    )
    columns = (
        "NORAD_CAT_ID,OBJECT_NAME,PERIGEE,ORBIT_CENTER,OBJECT_TYPE,DECAY_DATE,DATA_STATUS_CODE"
    )
    (tmp_path / "satcat.csv").write_text(
        columns + "\n" + "".join(f"{n},SAT {n},400,EA,PAY,,\n" for n in range(1, 5))
    )
    (tmp_path / "active.csv").write_text("NORAD_CAT_ID\n" + "".join(f"{n}\n" for n in range(1, 5)))
    table.write_table(
        [table.Row(n, 2.0, "mmt", f"SAT {n}") for n in range(1, 5)],
        tmp_path / "out.csv",
        "2026-01-01",
    )
    return [
        "make_brightness_table.py",
        "--update",
        "--mmt",
        str(tmp_path / "list.txt"),
        "--satcat",
        str(tmp_path / "satcat.csv"),
        "--elements",
        str(tmp_path / "active.csv"),
        "--out",
        str(tmp_path / "out.csv"),
    ]


def test_the_update_command_rewrites_the_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", _files(tmp_path, 4))
    table.main()
    assert table.read_table(tmp_path / "out.csv") == {n: (1.5, "mmt") for n in range(1, 5)}
    assert "2026-01-01" not in (tmp_path / "out.csv").read_text()
    assert "0 objects added, 0 gone." in capsys.readouterr().out


def test_an_update_with_nothing_new_leaves_the_table_and_its_date_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    args = _files(tmp_path, 4)
    (tmp_path / "list.txt").write_text(
        "# Catalogue Id Name StdMag_Clear_Median\n"
        + "".join(f'NORAD {n} "SAT {n}" 2.0\n' for n in range(1, 5))
    )
    before = (tmp_path / "out.csv").read_bytes()
    monkeypatch.setattr(sys, "argv", args)
    table.main()
    assert (tmp_path / "out.csv").read_bytes() == before
    assert "Nothing has changed" in capsys.readouterr().out


def test_the_update_says_how_far_the_values_moved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", _files(tmp_path, 4))
    table.main()
    assert "4 values changed, the largest by 0.50." in capsys.readouterr().out


def test_a_list_that_moves_much_of_the_table_stops_the_update(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _files(tmp_path, 4)
    (tmp_path / "list.txt").write_text(
        "# Catalogue Id Name StdMag_Clear_Median\n"
        + "".join(f'NORAD {n} "SAT {n}" 3.5\n' for n in range(1, 5))
    )
    before = (tmp_path / "out.csv").read_text()
    monkeypatch.setattr(sys, "argv", args)
    with pytest.raises(SystemExit, match="4 of 4 values would move"):
        table.main()
    assert (tmp_path / "out.csv").read_text() == before


def _downloading(args: list[str]) -> list[str]:
    """The same update, downloading MMT's list rather than reading it."""
    at = args.index("--mmt")
    return [*args[:at], "--download-mmt", *args[at + 2 :]]


def test_the_list_is_downloaded_with_the_referer_mmts_team_gave(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _files(tmp_path, 4)
    answer = (tmp_path / "list.txt").read_bytes()
    asked: list[list[str]] = []

    def run(command: list[str], **_kwargs: Any) -> Any:
        asked.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=answer)

    monkeypatch.setattr(sys, "argv", _downloading(args))
    with patch.object(table.subprocess, "run", run):
        table.main()
    assert len(asked) == 1, "CelesTrak's files came from disk here"
    command = asked[0]
    assert command[-1] == "http://mmt.favor2.info/satellites/download"
    assert command[command.index("--referer") + 1] == "http://mmt.favor2.info"
    assert "--fail" in command
    assert table.USER_AGENT in command
    assert table.read_table(tmp_path / "out.csv") == {n: (1.5, "mmt") for n in range(1, 5)}


def test_a_refused_list_stops_before_celestrak_is_asked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _downloading(_files(tmp_path, 4))
    # Without its files, the update would go on to download CelesTrak's.
    args = args[: args.index("--satcat")] + args[args.index("--out") :]
    before = (tmp_path / "out.csv").read_text()
    failure = subprocess.CalledProcessError(22, "curl", stderr=b"curl: (22) error: 403")
    monkeypatch.setattr(sys, "argv", args)
    with (
        patch.object(table.subprocess, "run", side_effect=failure) as run,
        pytest.raises(SystemExit, match="no list from MMT: curl: \\(22\\) error: 403"),
    ):
        table.main()
    assert run.call_count == 1
    assert (tmp_path / "out.csv").read_text() == before


def test_either_a_saved_list_or_a_download_but_not_both(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for argv in (["x", "--update"], ["x", "--update", "--download-mmt", "--mmt", "list.txt"]):
        monkeypatch.setattr(sys, "argv", argv)
        with pytest.raises(SystemExit):
            table.main()
        assert "--mmt" in capsys.readouterr().err


def test_the_workflow_asks_about_once_a_week_and_only_from_this_repository() -> None:
    """As MMT's team agreed. A fork's schedule would ask them as well."""
    workflow = Path(__file__).parents[1] / ".github/workflows/brightness.yml"
    text = workflow.read_text(encoding="utf-8")
    crons = re.findall(r'cron: "([^"]+)"', text)
    assert len(crons) == 1
    minute, hour, day, month, weekday = crons[0].split()
    assert minute.isdigit() and hour.isdigit() and weekday.isdigit()
    assert day == month == "*"
    assert "--update --download-mmt" in text
    assert "github.repository == 'kedube/ha-satellite-spotter'" in text


def test_the_update_stops_rather_than_lose_most_of_the_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    args = _files(tmp_path, 4)
    monkeypatch.setattr(sys, "argv", args)
    # Hardly anything still has an orbit.
    (tmp_path / "active.csv").write_text("NORAD_CAT_ID\n1\n")
    before = (tmp_path / "out.csv").read_text()
    with pytest.raises(SystemExit, match="only 1 objects"):
        table.main()
    assert (tmp_path / "out.csv").read_text() == before


def test_a_file_that_is_not_the_list_stops_the_update(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "argv", _files(tmp_path, 4))
    (tmp_path / "list.txt").write_text("<html>Not found</html>")
    with pytest.raises(ValueError, match="not MMT's satellite list"):
        table.main()


@pytest.mark.parametrize(
    ("failure", "said"),
    [
        (subprocess.CalledProcessError(22, "curl", stderr=b"curl: (22) error: 403"), "403"),
        (FileNotFoundError("curl"), "curl"),
    ],
)
def test_a_failed_download_stops_the_update_and_leaves_the_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: Exception, said: str
) -> None:
    args = _files(tmp_path, 4)
    args = args[: args.index("--satcat")] + args[args.index("--out") :]
    monkeypatch.setattr(sys, "argv", args)
    before = (tmp_path / "out.csv").read_text()
    with (
        patch.object(table.subprocess, "run", side_effect=failure),
        pytest.raises(SystemExit, match=said),
    ):
        table.main()
    assert (tmp_path / "out.csv").read_text() == before


def test_the_downloads_name_the_script_and_ask_for_csv() -> None:
    asked: list[list[str]] = []

    def answer(command: list[str], **_kwargs: Any) -> Any:
        asked.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=b"NORAD_CAT_ID\n900\n")

    with patch.object(table.subprocess, "run", answer):
        assert table.download_elements() == {900}
    assert len(asked) == len(table.ELEMENT_QUERIES)
    for command in asked:
        assert "FORMAT=csv" in command[-1]
        assert table.USER_AGENT in command
        # Anything but a 200 has to stop it, as CelesTrak asks.
        assert "--fail" in command


def test_a_full_build_says_what_it_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["x", "--mmt", str(tmp_path / "list.txt")])
    with pytest.raises(SystemExit):
        table.main()
    assert "--qsmag" in capsys.readouterr().err
