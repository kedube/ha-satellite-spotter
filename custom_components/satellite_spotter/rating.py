"""How worth going outside for a pass is: a rule of thumb, not a measurement."""

from __future__ import annotations

import math

from .const import DEFAULT_MIN_ELEVATION, RATINGS

# How much of the score each part is, before clouds and a short pass take their share.
_BRIGHTNESS_WEIGHT = 0.7
_HEIGHT_WEIGHT = 0.3
# Magnitudes clear of what the sky shows at which a pass could get no brighter to the eye, the
# height from which it is as good as overhead for anyone not among tall buildings, and how long
# it takes to step outside, find it and watch it for a while.
_FULL_CONTRAST = 6.0
_FULL_HEIGHT = 60.0
_FULL_SECONDS = 120.0
# The least score for each rating but the last, in the order of RATINGS. Over the real catalog at
# seven cities, with clear skies, these rate about one pass in eight great and over a quarter good.
_LEAST_SCORES = (0.7, 0.5, 0.25)


def _share(value: float) -> float:
    return min(1.0, max(0.0, value))


def pass_score(
    magnitude: float,
    sky_limit: float,
    peak_elevation: float,
    seconds: float,
    cloud_cover: int | None,
    moon_dimming: float = 0.0,
) -> float:
    """Return how good a pass is, from 0 to 1.

    Brightness counts against what the sky shows, so twilight and moonlight both take from it.
    Clouds matter little until they cover most of the sky; without a forecast they do not count.
    """
    contrast = sky_limit - moon_dimming - magnitude
    height = (peak_elevation - DEFAULT_MIN_ELEVATION) / (_FULL_HEIGHT - DEFAULT_MIN_ELEVATION)
    score = _BRIGHTNESS_WEIGHT * _share(contrast / _FULL_CONTRAST) + _HEIGHT_WEIGHT * _share(height)
    score *= math.sqrt(_share(seconds / _FULL_SECONDS))
    return (
        score
        if cloud_cover is None
        else score * (1.0 - _share(cloud_cover / 100.0) * _share(cloud_cover / 100.0))
    )


def rating_of(score: float) -> str:
    """Return the rating for a score."""
    return next(
        (rating for rating, least in zip(RATINGS, _LEAST_SCORES, strict=False) if score >= least),
        RATINGS[-1],
    )


def at_least(rating: str, least: str) -> bool:
    """Say whether a rating is as good as another."""
    return RATINGS.index(rating) <= RATINGS.index(least)
