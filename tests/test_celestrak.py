"""The download from CelesTrak, and joining its orbital data with the brightness table."""

from __future__ import annotations

import csv
from typing import Any
from unittest.mock import patch

import aiohttp
from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

from custom_components.satellite_spotter import track
from custom_components.satellite_spotter.celestrak import (
    GP_URL,
    QUERIES,
    STARLINK_MAX_PERIGEE_KM,
    SUPPLEMENTAL_QUERY,
    SUPPLEMENTAL_URL,
    CatalogError,
    DownloadRefused,
    async_fetch_catalog,
    build_catalog,
)
from custom_components.satellite_spotter.const import ATTRIBUTION, USER_AGENT

from .common import INTEGRATION, gp_csv

# A circular orbit about 300 km up, and one about 550 km up.
LOW = 15.9
HIGH = 15.05


def _row(norad_id: int, name: str, mean_motion: float = HIGH, **fields: Any) -> dict[str, Any]:
    return {
        "OBJECT_NAME": name,
        "OBJECT_ID": f"2026-001{norad_id % 26 + 65:c}",
        "EPOCH": "2026-11-04T00:00:00.000000",
        "MEAN_MOTION": mean_motion,
        "ECCENTRICITY": 0.0001,
        "INCLINATION": 51.6,
        "RA_OF_ASC_NODE": 10.0,
        "ARG_OF_PERICENTER": 20.0,
        "MEAN_ANOMALY": 30.0,
        "EPHEMERIS_TYPE": 0,
        "CLASSIFICATION_TYPE": "U",
        "NORAD_CAT_ID": norad_id,
        "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 100,
        "BSTAR": 0.0001,
        "MEAN_MOTION_DOT": 0.0001,
        "MEAN_MOTION_DDOT": 0,
        **fields,
    }


@pytest.fixture(autouse=True)
def table() -> Any:
    """A brightness table of three objects."""
    with patch(
        "custom_components.satellite_spotter.celestrak.brightness_table",
        return_value={25544: -1.75, 20580: 2.25, 900: 3.0},
    ):
        yield


def _mock_answers(mocker: AiohttpClientMocker, **kwargs: Any) -> None:
    for query in QUERIES:
        mocker.get(GP_URL, params={**query, "FORMAT": "csv"}, **kwargs)


def _mock_supplement(mocker: AiohttpClientMocker, **kwargs: Any) -> None:
    mocker.get(SUPPLEMENTAL_URL, params={**SUPPLEMENTAL_QUERY, "FORMAT": "csv"}, **kwargs)


def test_only_objects_with_a_brightness_are_kept() -> None:
    catalog = build_catalog([gp_csv([_row(900, "CALSPHERE 1"), _row(901, "NOT IN THE TABLE")])])
    assert [(sat.norad_id, sat.name, sat.standard_magnitude, sat.curve) for sat in catalog] == [
        (900, "CALSPHERE 1", 3.0, None)
    ]


def test_well_known_objects_get_their_usual_names() -> None:
    answer = gp_csv([_row(25544, "ISS (ZARYA)"), _row(20580, "HST")])
    assert {sat.name for sat in build_catalog([answer])} == {"ISS", "Hubble"}


def test_the_newest_elements_win_across_answers() -> None:
    old = gp_csv([_row(900, "CALSPHERE 1", EPOCH="2026-11-01T00:00:00.000000")])
    new = gp_csv([_row(900, "CALSPHERE 1", EPOCH="2026-11-03T00:00:00.000000")])
    for answers in ([old, new], [new, old]):
        catalog = build_catalog(answers)
        assert [sat.elements["EPOCH"] for sat in catalog] == ["2026-11-03T00:00:00.000000"]


@pytest.mark.parametrize(
    ("regular", "supplemental", "kept"),
    [
        ("2026-11-03T00:00:00.000000", "2026-11-04T00:00:00.000000", 15.9),
        ("2026-11-04T00:00:00.000000", "2026-11-03T00:00:00.000000", 15.8),
    ],
)
def test_the_newest_elements_win_for_a_supplemental_starlink(
    regular: str, supplemental: str, kept: float
) -> None:
    """The two files share their catalog numbers, which is how they are matched."""
    catalog = build_catalog(
        [
            gp_csv([_row(60000, "STARLINK-1", 15.8, EPOCH=regular)]),
            gp_csv([_row(60000, "STARLINK-1", 15.9, EPOCH=supplemental)]),
        ]
    )
    assert [float(sat.elements["MEAN_MOTION"]) for sat in catalog] == [kept]


def test_a_starlink_only_the_supplemental_file_has_is_kept() -> None:
    (sat,) = build_catalog([gp_csv([]), gp_csv([_row(60000, "STARLINK-1", LOW)])])
    assert (sat.norad_id, sat.curve) == (60000, "starlink-raising")


def test_only_low_starlinks_are_kept_with_their_models() -> None:
    catalog = build_catalog(
        [
            gp_csv(
                [
                    _row(1, "STARLINK-1", LOW),
                    _row(2, "STARLINK-2 [DTC]", LOW),
                    _row(3, "STARLINK-3", HIGH),
                ]
            )
        ]
    )
    assert {sat.name: sat.curve for sat in catalog} == {
        "STARLINK-1": "starlink-raising",
        "STARLINK-2 [DTC]": "starlink-dtc",
    }
    assert all(sat.standard_magnitude is None for sat in catalog)
    assert all(track.apsides_km(sat)[0] < STARLINK_MAX_PERIGEE_KM for sat in catalog)


def test_a_bad_row_costs_only_itself() -> None:
    answer = gp_csv([_row(900, "CALSPHERE 1"), _row(25544, "ISS (ZARYA)", EPOCH="soon")])
    # Starlinks are parsed to find their height, which a bad row must survive too.
    starlink = gp_csv([_row(1, "STARLINK-1", 0.0)])
    assert [sat.norad_id for sat in build_catalog([answer, starlink])] == [900]


def test_a_line_cut_short_is_skipped() -> None:
    """A download that ended early must not spoil what did arrive."""
    whole = gp_csv([_row(900, "CALSPHERE 1")])
    cut = f"{whole}CALSPHERE 1,1964-063C"
    assert [sat.norad_id for sat in build_catalog([cut])] == [900]


@pytest.mark.parametrize(
    "answer", ["No GP data found", "<html>Maintenance</html>", ""], ids=["none", "html", "empty"]
)
def test_an_answer_that_is_not_orbital_data_is_a_refusal(answer: str) -> None:
    with pytest.raises(DownloadRefused):
        build_catalog([answer])


async def test_download_asks_once_each_and_names_itself(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    _mock_answers(aioclient_mock, text=gp_csv([_row(900, "CALSPHERE 1")]))
    _mock_supplement(aioclient_mock, text=gp_csv([_row(60000, "STARLINK-1", LOW)]))
    catalog = await async_fetch_catalog(hass)
    assert [sat.norad_id for sat in catalog] == [900, 60000]
    assert aioclient_mock.call_count == len(QUERIES) + 1
    for _method, url, _data, headers in aioclient_mock.mock_calls:
        assert headers["User-Agent"] == USER_AGENT, url
        assert url.query["FORMAT"] == "csv"
    # Asked for last: the catalog can do without it.
    assert str(aioclient_mock.mock_calls[-1][1]).startswith(SUPPLEMENTAL_URL)


@pytest.mark.parametrize("status", [301, 403, 404, 500, 503])
async def test_any_answer_but_200_stops_the_download_at_once(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, status: int
) -> None:
    """CelesTrak's usage policy: stop querying on anything else, redirects included."""
    _mock_answers(aioclient_mock, status=status)
    with pytest.raises(DownloadRefused, match=str(status)):
        await async_fetch_catalog(hass)
    assert aioclient_mock.call_count == 1


@pytest.mark.parametrize(
    "answer",
    [
        {"status": 301},
        {"status": 403},
        {"status": 404},
        {"status": 503},
        {"exc": aiohttp.ClientError()},
        {"exc": TimeoutError()},
        {"text": "No GP data found"},
    ],
)
async def test_the_catalog_can_do_without_the_supplemental_file(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, answer: dict[str, Any]
) -> None:
    _mock_answers(aioclient_mock, text=gp_csv([_row(900, "CALSPHERE 1")]))
    _mock_supplement(aioclient_mock, **answer)
    catalog = await async_fetch_catalog(hass)
    assert [sat.norad_id for sat in catalog] == [900]
    # Nothing more is asked of CelesTrak after it.
    assert aioclient_mock.call_count == len(QUERIES) + 1


@pytest.mark.parametrize(
    ("status", "says"),
    [
        (
            403,
            "CelesTrak allows one download every two hours, "
            "and answered HTTP 403 for GROUP=visual.",
        ),
        (503, "CelesTrak answered HTTP 503 for GROUP=visual."),
    ],
)
async def test_a_refusal_says_what_it_means_and_what_happens_next(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, status: int, says: str
) -> None:
    _mock_answers(aioclient_mock, status=status)
    with pytest.raises(DownloadRefused) as caught:
        await async_fetch_catalog(hass)
    assert (
        str(caught.value) == f"{says} The integration waits two hours, then tries again by itself."
    )


@pytest.mark.parametrize("error", [aiohttp.ClientError(), TimeoutError()])
async def test_not_reaching_celestrak_is_not_a_refusal(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker, error: Exception
) -> None:
    _mock_answers(aioclient_mock, exc=error)
    with pytest.raises(CatalogError) as caught:
        await async_fetch_catalog(hass)
    assert not isinstance(caught.value, DownloadRefused)
    assert aioclient_mock.call_count == 1


def test_the_table_shipped_can_be_read() -> None:
    """The table as built: sensible values, for objects we would predict from it."""
    path = INTEGRATION / "brightness.csv"
    with path.open(encoding="utf-8", newline="") as handle:
        lines = [line for line in handle if not line.startswith("#")]
    rows = list(csv.DictReader(lines))
    assert len(rows) > 300
    assert all(-3 <= float(row["magnitude"]) <= 8 for row in rows)
    assert {row["source"] for row in rows} <= {
        "override",
        "mmt",
        "mccants",
        "score",
        "stellarium",
        "family",
    }
    assert not any(row["name"].upper().startswith("STARLINK") for row in rows)
    ids = [int(row["norad_id"]) for row in rows]
    assert ids == sorted(set(ids))
    # The ISS and Hubble, whose names and links the integration knows.
    assert {25544, 20580} <= set(ids)
    by_id = {int(row["norad_id"]): row for row in rows}
    # Tiangong's value is added by hand, and the outliers among Qianfan's are gone.
    assert (by_id[48274]["magnitude"], by_id[48274]["source"]) == ("0.00", "override")
    assert not {61563, 63166} & set(ids)


def test_the_entities_credit_where_the_brightness_comes_from() -> None:
    """Mini-MegaTORTORA asks for the citation and this acknowledgement."""
    assert "Karpov et al. 2016" in ATTRIBUTION
    assert "Kazan Federal University" in ATTRIBUTION


def test_the_table_keeps_the_attribution_its_sources_ask_for() -> None:
    header = (INTEGRATION / "brightness.csv").read_text(encoding="utf-8").split("norad_id")[0]
    for credit in (
        "Mini-MegaTORTORA",
        "Karpov",
        "Kazan Federal University",
        "McCants",
        "SCORE",
        "CC BY 4.0",
        "Stellarium",
        "McDowell",
        "CelesTrak",
        "Mallama",
    ):
        assert credit in header
