"""How worth going outside for a pass is, and the Moon that goes into it."""

from __future__ import annotations

from datetime import timedelta
import math
from unittest.mock import patch

import pytest

from custom_components.satellite_spotter import track
from custom_components.satellite_spotter.const import RATINGS
from custom_components.satellite_spotter.coordinator import _listed
from custom_components.satellite_spotter.predict import Flyover
from custom_components.satellite_spotter.rating import at_least, pass_score, rating_of

from .common import NOW, bright_pass, dim_pass, listed, sighting

DARK = 4.0


@pytest.mark.parametrize(
    ("magnitude", "sky_limit", "height", "seconds", "clouds", "rating"),
    [
        pytest.param(-3.0, DARK, 70.0, 300, None, "great", id="the station, high, on a dark night"),
        pytest.param(-3.0, DARK, 70.0, 300, 20, "great", id="a few clouds change little"),
        pytest.param(-3.0, DARK, 70.0, 300, 70, "good", id="most of the sky cloudy"),
        pytest.param(-3.0, DARK, 70.0, 300, 95, "poor", id="overcast takes it all"),
        pytest.param(-3.0, DARK, 70.0, 10, None, "fair", id="gone in ten seconds"),
        pytest.param(-3.0, DARK, 15.0, 300, None, "great", id="very bright and low"),
        pytest.param(0.4, DARK, 40.0, 300, None, "good", id="bright and fairly high"),
        pytest.param(1.8, DARK, 80.0, 200, None, "good", id="faint and overhead"),
        pytest.param(1.8, DARK, 25.0, 200, None, "fair", id="faint and low"),
        pytest.param(2.2, DARK, 12.0, 120, None, "poor", id="as faint as is listed, and low"),
        pytest.param(-2.0, -1.2, 85.0, 80, None, "fair", id="bright but in twilight"),
    ],
)
def test_ratings(
    magnitude: float,
    sky_limit: float,
    height: float,
    seconds: float,
    clouds: int | None,
    rating: str,
) -> None:
    assert rating_of(pass_score(magnitude, sky_limit, height, seconds, clouds)) == rating


def test_each_thing_counts_in_the_direction_it_should() -> None:
    base = pass_score(1.0, DARK, 30.0, 120, None)
    assert pass_score(0.0, DARK, 30.0, 120, None) > base
    assert pass_score(1.0, 3.0, 30.0, 120, None) < base
    assert pass_score(1.0, DARK, 50.0, 120, None) > base
    assert pass_score(1.0, DARK, 30.0, 60, None) < base
    assert pass_score(1.0, DARK, 30.0, 120, 40) < base
    assert pass_score(1.0, DARK, 30.0, 120, None, 0.5) < base


def test_no_forecast_is_as_good_as_a_clear_sky() -> None:
    assert pass_score(1.0, DARK, 30.0, 120, None) == pass_score(1.0, DARK, 30.0, 120, 0)


@pytest.mark.parametrize(
    "extreme",
    [(-30.0, DARK, 90.0, 9999, 0), (30.0, -4.0, 0.0, 0, 100), (2.0, DARK, 200.0, 120, 150)],
)
def test_the_score_stays_between_nothing_and_everything(extreme: tuple[float, ...]) -> None:
    assert 0.0 <= pass_score(*extreme) <= 1.0


def test_at_least_goes_by_the_order_of_the_ratings() -> None:
    assert RATINGS == ("great", "good", "fair", "poor")
    assert at_least("great", "poor")
    assert at_least("good", "good")
    assert not at_least("fair", "good")
    assert not at_least("poor", "great")


def test_a_pass_knows_its_rating_and_clouds_change_it() -> None:
    assert bright_pass(NOW).rating == "great"
    assert bright_pass(NOW, cloud_cover=100).rating == "poor"
    assert dim_pass(NOW).rating == "fair"


def test_a_fainter_satellite_higher_up_does_not_lift_a_pass() -> None:
    brightest = sighting(NOW, 110, peak_magnitude=-1.0, best_view=(10.0, 19.5))
    fainter = sighting(NOW, 110, name="B", norad_id=2, peak_magnitude=2.0, best_view=(10.0, 72.5))
    assert listed(brightest).rating == "good"
    assert listed(brightest, fainter).rating == "good"


def test_a_fainter_satellite_for_longer_does_not_lift_a_pass() -> None:
    brightest = sighting(NOW, 10, peak_magnitude=-3.0, best_view=(10.0, 70.0))
    fainter = sighting(NOW, 300, name="B", norad_id=2, peak_magnitude=2.0, best_view=(10.0, 70.0))
    assert listed(brightest).rating == "fair"
    assert listed(brightest, fainter).rating == "fair"


def test_a_fainter_satellite_in_a_brighter_sky_does_not_lower_a_pass() -> None:
    brightest = sighting(NOW, peak_magnitude=-3.0, best_view=(10.0, 60.0))
    fainter = sighting(NOW, name="B", norad_id=2, peak_magnitude=2.0, sky_limit=-1.0)
    assert listed(brightest).rating == "great"
    assert listed(brightest, fainter).rating == "great"


def test_the_moon_is_taken_when_the_brightest_satellite_is_highest() -> None:
    brightest = sighting(NOW, peak_magnitude=-3.0, best_view=(10.0, 20.0))
    later = NOW + timedelta(minutes=10)
    fainter = sighting(later, name="B", norad_id=2, peak_magnitude=2.0, best_view=(10.0, 80.0))
    observer = track.Observer(39.74, -104.99)
    with (
        patch.object(
            track,
            "sighting_shape",
            side_effect=lambda _sat, _place, _start, _end, peak: track.SightingShape(
                peak, "rise", "set"
            ),
        ),
        patch.object(track, "moon_dimming", return_value=0.25) as dimming,
    ):
        p = _listed(Flyover([brightest, fainter]), observer, None)
    dimming.assert_called_once_with(observer, brightest.brightest.time.timestamp())
    assert p.moon_dimming == 0.25
    # The highest of them all is still known, for the page.
    assert p.peak.elevation == 80.0


# Skyfield with JPL's DE421: right ascension and declination of date, geocentric, and how much of
# the Moon is lit, at four moments from 2026 to 2035.
_MOON_FIELDS = ("when", "right_ascension", "declination", "distance_km", "lit")
_MOON_FROM_SKYFIELD = [
    (1767225600.0, 63.9203, 26.4037, 361045.0, 0.9140),
    (1871744760.0, 161.8509, 2.7062, 365365.0, 0.8036),
    (1977283080.0, 69.1569, 18.8707, 388638.0, 0.4593),
    (2081804040.0, 171.3387, 5.7849, 376736.0, 0.5804),
]


@pytest.mark.parametrize(_MOON_FIELDS, _MOON_FROM_SKYFIELD)
def test_the_moon_is_where_skyfield_says(
    when: float, right_ascension: float, declination: float, distance_km: float, lit: float
) -> None:
    x, y, z = track.moon_at(when)
    turned = float(track._earth_turned(when))
    x, y = (
        math.cos(turned) * x - math.sin(turned) * y,
        math.sin(turned) * x + math.cos(turned) * y,
    )
    ra = math.degrees(math.atan2(y, x)) % 360.0
    dec = math.degrees(math.atan2(z, math.hypot(x, y)))
    off_ra = (ra - right_ascension + 180.0) % 360.0 - 180.0
    assert math.hypot(off_ra * math.cos(math.radians(dec)), dec - declination) < 0.35
    assert math.hypot(x, y, z) / 1000.0 == pytest.approx(distance_km, rel=0.005)


@pytest.mark.parametrize(_MOON_FIELDS, _MOON_FROM_SKYFIELD)
def test_the_moon_takes_off_most_when_full_and_high(
    when: float, right_ascension: float, declination: float, distance_km: float, lit: float
) -> None:
    # Directly below it, it is overhead, and takes off about as much as it is lit.
    x, y, z = track.moon_at(when)
    below = track.Observer(
        math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))
    )
    assert track.moon_dimming(below, when) == pytest.approx(lit, abs=0.02)
    # On the far side of the Earth it is down, and takes off nothing.
    away = track.Observer(-below.latitude, (below.longitude + 360.0) % 360.0 - 180.0)
    assert track.moon_dimming(away, when) == 0.0
