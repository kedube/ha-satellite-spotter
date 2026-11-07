"""A pass's path across the sky as a PNG, for notifications.

Drawn here rather than in a browser, as nothing else is open when a notification goes out, and with
nothing but NumPy, as phones cannot show the page's SVG. The same chart as the page's: the sky as a
dome seen from below, north at the top and east to the right like a compass, with the path gold
where the satellite can be seen.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from http import HTTPStatus
from itertools import pairwise
import math
import struct
from typing import TYPE_CHECKING, Any
import zlib

from aiohttp import web
from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.config_entries import ConfigEntryState
import numpy as np

from . import track
from .const import DOMAIN, SKY_CHART_URL
from .predict import cutoff_for
from .texts import load_common

if TYPE_CHECKING:
    from .coordinator import ListedPass, SatelliteSpotterCoordinator

_SIZE = 480
_CENTER = _SIZE / 2
_DOME_RADIUS = _CENTER * 0.8
# Rough sizes for the page's chart, which is 220 across.
_SCALE = _SIZE / 220

_BACKGROUND = (9, 13, 24)
_DOME_MIDDLE = (22, 36, 74)
_DOME_EDGE = (7, 12, 28)
_GUIDE = (148, 163, 184)
_LETTER = (226, 232, 240)
_PATH_ABOVE = (226, 232, 240)
_PATH_GLOW = (251, 191, 36)
_PATH = (252, 211, 77)
_PEAK = (255, 247, 214)
_MARK_EDGE = (120, 53, 15)

# Each letter as strokes on a unit square, x to the right and y down.
_GLYPHS: Mapping[str, tuple[tuple[tuple[float, float], ...], ...]] = {
    "N": (((0, 1), (0, 0), (1, 1), (1, 0)),),
    "E": (((1, 0), (0, 0), (0, 1), (1, 1)), ((0, 0.5), (0.8, 0.5))),
    "S": (
        (
            (1, 0.12), (0.72, 0), (0.28, 0), (0, 0.12), (0, 0.36), (0.28, 0.5), (0.72, 0.5),
            (1, 0.64), (1, 0.88), (0.72, 1), (0.28, 1), (0, 0.88),
        ),
    ),
    "W": (((0, 0), (0.25, 1), (0.5, 0.3), (0.75, 1), (1, 0)),),
    "O": (
        (
            (0.3, 0), (0.7, 0), (1, 0.25), (1, 0.75), (0.7, 1), (0.3, 1), (0, 0.75), (0, 0.25),
            (0.3, 0),
        ),
    ),
    "Z": (((0, 0), (1, 0), (0, 1), (1, 1)),),
    "V": (((0, 0), (0.5, 1), (1, 0)),),
    "Ö": (
        (
            (0.3, 0.2), (0.7, 0.2), (1, 0.4), (1, 0.8), (0.7, 1), (0.3, 1), (0, 0.8), (0, 0.4),
            (0.3, 0.2),
        ),
        ((0.3, -0.08), (0.3, 0.04)),
        ((0.7, -0.08), (0.7, 0.04)),
    ),
}  # fmt: skip
_LETTER_HEIGHT = 18.0
_LETTER_WIDTH = 13.0
_ENGLISH_CARDINALS = ("N", "E", "S", "W")
_CARDINAL_KEYS = ("compass_n", "compass_e", "compass_s", "compass_w")

# How many of a pass's satellites get a path, and how far apart its points are, in seconds.
_MAX_MEMBERS = 12
_LEAD_STEP = 5.0
_MEMBER_STEP = 10.0


@dataclass(frozen=True)
class ChartPath:
    """A satellite's way across the sky: (azimuth, elevation) in degrees, up to where it sets."""

    above: Sequence[tuple[float, float]]
    visible: Sequence[tuple[float, float]]


def sky_xy(azimuth: float, elevation: float) -> tuple[float, float]:
    """Return where an azimuth and elevation go on the chart."""
    distance = max(0.0, 90.0 - elevation) / 90.0 * _DOME_RADIUS
    angle = math.radians(azimuth)
    return _CENTER + distance * math.sin(angle), _CENTER - distance * math.cos(angle)


class _Canvas:
    """An image of floats, with shapes blended in by how much of each pixel they cover."""

    def __init__(self) -> None:
        self.rgb = np.empty((_SIZE, _SIZE, 3))
        self.rgb[...] = _BACKGROUND
        ys, xs = np.mgrid[0:_SIZE, 0:_SIZE]
        self._xs, self._ys = xs + 0.5, ys + 0.5

    def _blend(
        self, cover: np.ndarray[Any, Any], color: tuple[int, int, int], alpha: float
    ) -> None:
        share = (cover * alpha)[..., np.newaxis]
        self.rgb += (np.asarray(color, dtype=float) - self.rgb) * share

    def dome(self) -> None:
        """Fill the sky, lighter toward the zenith."""
        distance = np.hypot(self._xs - _CENTER, self._ys - _CENTER)
        share = np.clip(distance / _DOME_RADIUS, 0.0, 1.0)[..., np.newaxis]
        sky = np.asarray(_DOME_MIDDLE, float) * (1 - share) + np.asarray(_DOME_EDGE, float) * share
        cover = np.clip(_DOME_RADIUS + 0.5 - distance, 0.0, 1.0)[..., np.newaxis]
        self.rgb += (sky - self.rgb) * cover

    def disk(
        self, x: float, y: float, radius: float, color: tuple[int, int, int], alpha: float = 1.0
    ) -> None:
        """Draw a filled circle."""
        distance = np.hypot(self._xs - x, self._ys - y)
        self._blend(np.clip(radius + 0.5 - distance, 0.0, 1.0), color, alpha)

    def ring(
        self, radius: float, width: float, color: tuple[int, int, int], alpha: float = 1.0
    ) -> None:
        """Draw a circle around the center."""
        distance = np.abs(np.hypot(self._xs - _CENTER, self._ys - _CENTER) - radius)
        self._blend(np.clip(width / 2 + 0.5 - distance, 0.0, 1.0), color, alpha)

    def stroke(
        self,
        lines: Iterable[Sequence[tuple[float, float]]],
        width: float,
        color: tuple[int, int, int],
        alpha: float = 1.0,
    ) -> None:
        """Draw polylines as one shape, so that where they join is no brighter."""
        reach = width / 2 + 0.5
        cover = np.zeros((_SIZE, _SIZE))
        for points in lines:
            for (x0, y0), (x1, y1) in pairwise(points):
                left = max(0, math.floor(min(x0, x1) - reach))
                right = min(_SIZE, math.ceil(max(x0, x1) + reach) + 1)
                top = max(0, math.floor(min(y0, y1) - reach))
                bottom = min(_SIZE, math.ceil(max(y0, y1) + reach) + 1)
                if left >= right or top >= bottom:
                    continue
                xs, ys = self._xs[top:bottom, left:right], self._ys[top:bottom, left:right]
                dx, dy = x1 - x0, y1 - y0
                length = dx * dx + dy * dy
                along = (
                    np.clip(((xs - x0) * dx + (ys - y0) * dy) / length, 0.0, 1.0) if length else 0.0
                )
                distance = np.hypot(xs - x0 - along * dx, ys - y0 - along * dy)
                part = np.clip(reach - distance, 0.0, 1.0)
                cover[top:bottom, left:right] = np.maximum(cover[top:bottom, left:right], part)
        self._blend(cover, color, alpha)

    def letter(self, glyph: str, x: float, y: float) -> None:
        """Draw one letter, centered on a point."""
        left, top = x - _LETTER_WIDTH / 2, y - _LETTER_HEIGHT / 2
        self.stroke(
            [
                [(left + gx * _LETTER_WIDTH, top + gy * _LETTER_HEIGHT) for gx, gy in line]
                for line in _GLYPHS[glyph]
            ],
            2.6,
            _LETTER,
        )

    def png(self) -> bytes:
        """Encode the image."""
        pixels = np.clip(np.rint(self.rgb), 0, 255).astype(np.uint8)
        raw = b"".join(b"\0" + row.tobytes() for row in pixels)

        def chunk(kind: bytes, body: bytes) -> bytes:
            crc = zlib.crc32(kind + body)
            return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", crc)

        header = struct.pack(">IIBBBBB", _SIZE, _SIZE, 8, 2, 0, 0, 0)
        return b"".join(
            (
                b"\x89PNG\r\n\x1a\n",
                chunk(b"IHDR", header),
                chunk(b"IDAT", zlib.compress(raw, 6)),
                chunk(b"IEND", b""),
            )
        )


def _arrow_head(points: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
    """Return the strokes of an arrow head at the end of a path, along its direction there."""
    (x0, y0), (x1, y1) = points[max(0, len(points) - 3)], points[-1]
    angle = math.atan2(y1 - y0, x1 - x0)
    size = 9.0 * _SCALE
    spread = 0.45
    return [
        (x1 - size * math.cos(angle + spread), y1 - size * math.sin(angle + spread)),
        (x1, y1),
        (x1 - size * math.cos(angle - spread), y1 - size * math.sin(angle - spread)),
    ]


def render_chart(
    lead: ChartPath,
    members: Iterable[ChartPath] = (),
    cardinals: Sequence[str] = _ENGLISH_CARDINALS,
) -> bytes:
    """Draw a pass: its brightest satellite's path, the others' thinly, and the compass."""
    canvas = _Canvas()
    canvas.dome()
    canvas.ring(_DOME_RADIUS, 1.2 * _SCALE, _GUIDE, 0.55)
    for elevation in (30.0, 60.0):
        canvas.ring((90.0 - elevation) / 90.0 * _DOME_RADIUS, 1.0, _GUIDE, 0.3)
    canvas.stroke(
        [
            [(_CENTER, _CENTER - _DOME_RADIUS), (_CENTER, _CENTER + _DOME_RADIUS)],
            [(_CENTER - _DOME_RADIUS, _CENTER), (_CENTER + _DOME_RADIUS, _CENTER)],
        ],
        1.0,
        _GUIDE,
        0.16,
    )
    for index, glyph in enumerate(cardinals):
        canvas.letter(glyph, *sky_xy(index * 90.0, -11.0))

    def on_chart(points: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
        return [sky_xy(azimuth, elevation) for azimuth, elevation in points]

    others = list(members)
    canvas.stroke([on_chart(path.above) for path in others], 1.2 * _SCALE, _PATH_ABOVE, 0.18)
    canvas.stroke([on_chart(path.visible) for path in others], 1.4 * _SCALE, _PATH, 0.55)

    canvas.stroke([on_chart(lead.above)], 1.4 * _SCALE, _PATH_ABOVE, 0.35)
    if len(lead.visible) > 1:
        visible = on_chart(lead.visible)
        canvas.stroke([visible], 8.0 * _SCALE, _PATH_GLOW, 0.35)
        canvas.stroke([visible, _arrow_head(visible)], 3.0 * _SCALE, _PATH)
        # The moment it appears, and the highest it gets.
        canvas.disk(*visible[0], 4.0 * _SCALE + 1.2, _MARK_EDGE)
        canvas.disk(*visible[0], 4.0 * _SCALE, _PATH)
        peak = max(lead.visible, key=lambda point: point[1])
        canvas.disk(*sky_xy(*peak), 3.5 * _SCALE + 1.2, _MARK_EDGE)
        canvas.disk(*sky_xy(*peak), 3.5 * _SCALE, _PEAK)
    return canvas.png()


def _path(p_start: float, p_end: float, rows: Sequence[Sequence[Any]] | None) -> ChartPath:
    """Make a path from a pass track's rows: [t, lat, lon, alt, lit, az, el, range, mag, vis]."""
    above = [(row[0], row[5], row[6]) for row in rows or () if row[6] >= 0.0]
    return ChartPath(
        above=[(azimuth, elevation) for _, azimuth, elevation in above],
        visible=[
            (azimuth, elevation)
            for when, azimuth, elevation in above
            if p_start - 1.0 <= when <= p_end + 1.0
        ],
    )


def _cardinals(language: str) -> tuple[str, ...]:
    """Return a language's letters for the four points, if there is a shape for them all."""
    common = load_common(language)
    local = tuple(common[key].upper() for key in _CARDINAL_KEYS)
    return local if all(letter in _GLYPHS for letter in local) else _ENGLISH_CARDINALS


def chart_of_pass(p: ListedPass, observer: track.Observer, faintest: float, language: str) -> bytes:
    """Draw a pass (in the executor, as it reads a file and takes a moment)."""
    paths = []
    for index, sighting in enumerate(p.sightings[:_MAX_MEMBERS]):
        start, end = sighting.appears.time.timestamp(), sighting.vanishes.time.timestamp()
        sky = track.pass_track(
            sighting.satellite,
            observer,
            start,
            end,
            _MEMBER_STEP if index else _LEAD_STEP,
            cutoff_for(sighting.satellite, faintest),
        )
        paths.append(_path(start, end, None if sky is None else sky.rows))
    return render_chart(paths[0], paths[1:], _cardinals(language))


def sky_chart_path(entry_id: str, pass_id: str) -> str:
    """Return where a pass's chart is served."""
    return f"{SKY_CHART_URL}/{entry_id}/{pass_id}.png"


class SkyChartView(HomeAssistantView):
    """Serves a pass's chart: to the app with its token, or to anyone with a signed link."""

    url = SKY_CHART_URL + "/{entry_id}/{pass_id}.png"
    name = f"api:{DOMAIN}:sky_chart"
    requires_auth = True

    async def get(self, request: web.Request, entry_id: str, pass_id: str) -> web.Response:
        """Send the chart, or a 404 if there is no such pass (any more)."""
        hass = request.app[KEY_HASS]
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN or entry.state is not ConfigEntryState.LOADED:
            return web.Response(status=HTTPStatus.NOT_FOUND)
        coordinator: SatelliteSpotterCoordinator = entry.runtime_data
        data = coordinator.predictions
        p = None if data is None else data.find(pass_id)
        if p is None:
            return web.Response(status=HTTPStatus.NOT_FOUND)
        catalog = coordinator.catalog
        observer = coordinator.observer
        key = ("sky_chart", entry_id, p.id, observer.latitude, observer.longitude)
        if (chart := catalog.cached(key)) is None:
            chart = await hass.async_add_executor_job(
                chart_of_pass,
                p,
                observer,
                coordinator.settings.brightness_cutoff,
                hass.config.language,
            )
            catalog.remember(key, chart)
        return web.Response(
            body=chart, content_type="image/png", headers={"Cache-Control": "private, max-age=3600"}
        )
