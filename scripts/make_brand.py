"""Draw the brand images in custom_components/satellite_spotter/brand/.

The icon is the moment the integration is for: nightfall at home, and someone
outside pointing up at a small, bright satellite. Its arc of light climbs out of
the last of the sunset; the only other warm light is the window behind them. The
badge is its own sky, so it reads on light and dark pages alike; the dark version
gets a rim, so that it does not sink into a dark page. The logo sets "SATELLITE"
over "SPOTTER" beside the icon, both lines the same width, in the colors of the
sky and the horizon.

Home Assistant (2026.3 and later) shows these from the integration's own brand
folder: icon 256 x 256 (512 x 512 @2x), logo 256 px high (512 @2x), trimmed,
transparent around the badge.

usage:
  pip install playwright pillow && playwright install chromium
  python scripts/make_brand.py

Or, with a browser you already have: python scripts/make_brand.py --channel chrome

The name is the Sora typeface (SIL Open Font License 1.1,
https://github.com/sora-xor/sora-font) turned into outlines, so drawing it needs no
font.

Importing the module draws nothing; only main() needs Playwright.
"""

# The SVG markup reads better on one line per element.
# ruff: noqa: E501

import argparse
import io
import math
from pathlib import Path
import random

from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "custom_components/satellite_spotter/brand"
SIDE = 512  # the icon's design space, 512 x 512
CORNER = 116  # the badge's corner radius

THEMES = {
    "light": {
        "rim": None,
        "line1": ((0, "#0a0c50"), (1, "#2629b8")),
        "line2": ((0, "#ea641f"), (1, "#c8420a")),
    },
    "dark": {
        "rim": "#33358f",
        "line1": ((0, "#ffffff"), (1, "#c7d0ff")),
        "line2": ((0, "#ffc25c"), (1, "#ff8a3c")),
    },
}


# ---- shapes and paints ---------------------------------------------------------
def rect(x, y, w, h, fill, rx=0):
    return (
        f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" rx="{rx}" fill="{fill}"/>'
    )


def polygon(points, fill, stroke):
    path = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    return f'<polygon points="{path}" fill="{fill}" stroke="{fill}" stroke-width="{stroke}" stroke-linejoin="round"/>'


def stops(items):
    """Gradient stops from (offset, color) or (offset, color, opacity)."""
    return "".join(
        f'<stop offset="{offset}" stop-color="{color}"'
        + (f' stop-opacity="{opacity[0]}"' if opacity else "")
        + "/>"
        for offset, color, *opacity in items
    )


def linear(name, x1, y1, x2, y2, items):
    return f'<linearGradient id="{name}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">{stops(items)}</linearGradient>'


def radial(name, cx, cy, r, items, transform=""):
    turned = f' gradientTransform="{transform}"' if transform else ""
    return f'<radialGradient id="{name}" gradientUnits="userSpaceOnUse" cx="{cx}" cy="{cy}" r="{r}"{turned}>{stops(items)}</radialGradient>'


FILTERS = "".join(
    f'<filter id="blur{n}" filterUnits="userSpaceOnUse" x="-400" y="-400" width="1400" height="1400"><feGaussianBlur stdDeviation="{n}"/></filter>'
    for n in (5, 8, 12, 18)
)


def blurred(amount, opacity, inner):
    return f'<g filter="url(#blur{amount})" opacity="{opacity}">{inner}</g>'


# ---- the sky -------------------------------------------------------------------
SKY = (
    (0, "#03041f"),
    (0.2, "#090b45"),
    (0.4, "#16188c"),
    (0.56, "#2c2ecb"),
    (0.66, "#5a44cf"),
    (0.725, "#a951b2"),
    (0.77, "#f06d6a"),
    (0.81, "#ff9a42"),
    (0.86, "#ffc25c"),
    (1, "#ffd98a"),
)
STAR_HALO = "#7cb6ff"
STARS = (  # x, y, radius, opacity
    (40, 62, 1.5, 0.8),
    (92, 30, 1.2, 0.7),
    (154, 92, 2.1, 1),
    (212, 42, 1.4, 0.8),
    (268, 88, 1.1, 0.7),
    (322, 26, 1.7, 0.9),
    (398, 50, 1.2, 0.7),
    (462, 36, 1.9, 0.9),
    (490, 118, 1.2, 0.7),
    (58, 150, 1.2, 0.7),
    (126, 190, 1.1, 0.7),
    (26, 232, 1.5, 0.8),
    (214, 158, 1.0, 0.6),
    (468, 226, 1.5, 0.8),
    (420, 268, 1.1, 0.7),
    (92, 268, 1.0, 0.6),
    (486, 300, 1.0, 0.6),
    (318, 268, 1.0, 0.6),
    (250, 300, 0.9, 0.5),
)


def star_svg(x, y, r, opacity):
    """A white point in a soft halo."""
    return (
        f'<circle cx="{x}" cy="{y}" r="{r * 5.5:.1f}" fill="url(#starhalo)" opacity="{opacity}"/>'
        f'<circle cx="{x}" cy="{y}" r="{r}" fill="#ffffff" opacity="{min(1, opacity + 0.1):.2f}"/>'
    )


def sky_svg():
    """Dusk from top to bottom, a deeper blue up to the right, the last of the sunset low on the left."""
    sunset = ((0, "#ffb54d", 0.9), (0.5, "#ff7a55", 0.4), (1, "#ff7a55", 0))
    return (
        linear("sky", 0, 0, 0, SIDE, SKY)
        + rect(0, 0, SIDE, SIDE, "url(#sky)")
        + radial("deep", 400, 250, 300, ((0, "#3a3ee6", 0.55), (1, "#3a3ee6", 0)))
        + rect(0, 0, SIDE, SIDE, "url(#deep)")
        + radial("sunset", 150, 430, 300, sunset, "translate(0 300) scale(1 0.3)")
        + rect(0, 0, SIDE, SIDE, "url(#sunset)")
        + f'<radialGradient id="starhalo">{stops(((0, STAR_HALO, 0.6), (0.3, STAR_HALO, 0.252), (1, STAR_HALO, 0)))}</radialGradient>'
        + "".join(star_svg(*star) for star in STARS)
    )


# ---- the pass ------------------------------------------------------------------
SATELLITE_AT = (344, 128)
SATELLITE_TURN, SATELLITE_SCALE = 10, 0.52
SATELLITE_GLOW = "#6fd0ff"
TRAIL_FROM = (44, 340)
TRAIL_BOW = -0.075  # as a share of its length: a pass rises as an arc, not a straight line
TRAIL_WIDTH = 4.2
TRAIL_POWER = 1.2  # how late it widens


def trail_outline(width, fill):
    """The trail as a filled shape, from a hairline to `width` at the satellite."""
    (x0, y0), (x1, y1) = TRAIL_FROM, SATELLITE_AT
    bx = (x0 + x1) / 2 - (y1 - y0) * TRAIL_BOW
    by = (y0 + y1) / 2 + (x1 - x0) * TRAIL_BOW
    samples = 120
    points = [
        (
            (1 - u) ** 2 * x0 + 2 * (1 - u) * u * bx + u * u * x1,
            (1 - u) ** 2 * y0 + 2 * (1 - u) * u * by + u * u * y1,
        )
        for u in (i / samples for i in range(samples + 1))
    ]
    left, right = [], []
    for i, (x, y) in enumerate(points):
        ax, ay = points[max(i - 1, 0)]
        cx, cy = points[min(i + 1, samples)]
        norm = math.hypot(cx - ax, cy - ay)
        nx, ny = -(cy - ay) / norm, (cx - ax) / norm
        half = (0.4 + (width - 0.4) * (i / samples) ** TRAIL_POWER) / 2
        left.append((x + nx * half, y + ny * half))
        right.append((x - nx * half, y - ny * half))
    path = "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in left + right[::-1]) + " Z"
    return f'<path d="{path}" fill="{fill}"/>'


def trail_svg():
    """Warm where it leaves the sunset, white where the satellite is now."""
    x1, y1 = SATELLITE_AT
    colors = (
        (0, "#ff8f7a", 0.0),
        (0.2, "#ff8f7a", 0.5),
        (0.55, "#b8b4ff", 0.8),
        (1, "#ffffff", 1.0),
    )
    return (
        linear("trail", *TRAIL_FROM, *SATELLITE_AT, colors)
        + blurred(5, 0.5, trail_outline(TRAIL_WIDTH * 2.6, "url(#trail)"))
        + trail_outline(TRAIL_WIDTH, "url(#trail)")
        + f'<circle cx="{x1}" cy="{y1}" r="{TRAIL_WIDTH / 2}" fill="#ffffff"/>'
    )


def satellite_shapes(fill, panel=None, line=None):
    """Bold shapes in one color: a body and two solar panels, and a dish that faces the ground."""
    body_w, body_h = 25, 32
    panel_w, panel_h = 54, 30
    shapes = rect(-body_w / 2 - 4, -2.6, body_w + 8, 5.2, fill)
    for x in (body_w / 2 + 10, -(body_w / 2 + 10) - panel_w):
        shapes += rect(x, -panel_h / 2, panel_w, panel_h, panel or fill, 3)
        if line:
            for i in (1, 2):
                shapes += rect(
                    x + panel_w * i / 3 - 1.1, -panel_h / 2 + 3, 2.2, panel_h - 6, line, 1
                )
    shapes += rect(-body_w / 2, -body_h / 2, body_w, body_h, fill, 6)
    y0, y1, y2 = body_h / 2, body_h / 2 + 7, body_h / 2 + 19
    return (
        shapes
        + f'<line x1="0" y1="{y0}" x2="0" y2="{y1}" stroke="{fill}" stroke-width="5"/>'
        + f'<path d="M-19 {y2} A19 13 0 0 1 19 {y2} Z" fill="{fill}" stroke="{fill}" stroke-width="2" stroke-linejoin="round"/>'
        + f'<line x1="0" y1="{y2}" x2="0" y2="{y2 + 8}" stroke="{fill}" stroke-width="2.4"/>'
        + f'<circle cx="0" cy="{y2 + 9}" r="3.2" fill="{fill}"/>'
    )


def satellite_svg():
    """Small, and bright for what surrounds it: a bloom, and a glow that follows its outline."""
    x, y = SATELLITE_AT
    bloom = 0.55
    placed = f"translate({x} {y}) rotate({SATELLITE_TURN}) scale({SATELLITE_SCALE})"
    glow = f'<g transform="{placed}">{satellite_shapes(SATELLITE_GLOW)}</g>'
    return (
        radial(
            "bloom",
            x,
            y,
            96,
            (
                (0, SATELLITE_GLOW, bloom),
                (0.22, SATELLITE_GLOW, round(bloom * 0.5, 3)),
                (0.55, SATELLITE_GLOW, round(bloom * 0.14, 3)),
                (1, SATELLITE_GLOW, 0),
            ),
        )
        + f'<circle cx="{x}" cy="{y}" r="96" fill="url(#bloom)"/>'
        + blurred(18, 0.8, glow)
        + blurred(8, 0.9, glow)
        + f'<g transform="{placed}">{satellite_shapes("#ffffff", "#d9ecff", "#3550c0")}</g>'
    )


# ---- the ground ----------------------------------------------------------------
GROUND = "#04041a"
MOUNTAINS_FAR = (
    "M-10 408 L28 388 L52 372 L70 382 L92 366 L128 392 L150 386 L204 420 L256 448 L-10 448 Z"
)
MOUNTAINS_NEAR = "M-10 430 L20 414 L60 404 L96 416 L140 410 L196 430 L240 448 L-10 450 Z"
RIDGE = "M-10 440 C70 424 160 430 240 436 S372 436 412 418 C440 408 480 404 522 398 V520 H-10 Z"
PINES = (  # x, base, height, width, seed
    (458, 424, 84, 42, 3),
    (492, 420, 122, 58, 7),
    (430, 430, 54, 28, 5),
    (526, 416, 90, 46, 11),
)


def pine_svg(x, base, height, width, seed, tiers=5):
    """A dark fir, its branches a little uneven: seeded, so that it comes out the same every time."""
    rng = random.Random(seed)
    right, left = [], []
    for i in range(1, tiers + 1):
        t = i / tiers
        y = -height + height * 0.9 * t
        half = width / 2 * t**0.92
        right += [
            (half * (1 + rng.uniform(-0.1, 0.1)), y + rng.uniform(-1, 2)),
            (half * 0.5, y - height * 0.018),
        ]
        left += [
            (-half * (1 + rng.uniform(-0.1, 0.1)), y + rng.uniform(-1, 2)),
            (-half * 0.5, y - height * 0.018),
        ]
    trunk = max(1.6, width * 0.05)
    outline = [
        (0, -height),
        *right[:-1],
        (trunk, -height * 0.09),
        (trunk, 8),
        (-trunk, 8),
        (-trunk, -height * 0.09),
        *reversed(left[:-1]),
    ]
    return polygon([(x + a, base + b) for a, b in outline], GROUND, 1.6)


def home_svg():
    """A house as it looks from outside at nightfall: a dark shape, a second gable, one room lit."""
    main = ((-62, 70), (-62, -58), (-71, -58), (0, -130), (71, -58), (62, -58), (62, 70))
    gable = ((50, 70), (50, -40), (96, -86), (146, -36), (138, -36), (138, 70))
    x, y, w, h = -19, -52, 38, 50  # one pane with a rounded head: no glazing bars
    r = w / 2
    pane = f"M{x} {y + h} V{y + r} A{r} {r} 0 0 1 {x + w} {y + r} V{y + h} Z"
    return (
        '<g transform="translate(300 436) scale(0.84)">'
        + rect(-46, -128, 18, 56, GROUND, 1)
        + rect(-49, -131, 24, 7, GROUND, 1)
        + polygon(gable, GROUND, 3)
        + polygon(main, GROUND, 3)
        + linear("pane", 0, y, 0, y + h, ((0, "#ffedb0"), (1, "#ffb03c")))
        + blurred(12, 0.8, f'<path d="{pane}" fill="#ff9a2e" stroke="#ff9a2e" stroke-width="8"/>')
        + f'<path d="{pane}" fill="url(#pane)"/>'
        + "</g>"
    )


def spotter_svg():
    """Someone standing outside, head back, pointing up."""
    return (
        f'<g transform="translate(214 436)" fill="{GROUND}" stroke="{GROUND}" stroke-linecap="round" stroke-linejoin="round">'
        '<circle cx="-1.6" cy="-38.2" r="4.5" stroke="none"/>'
        '<line x1="-0.8" y1="-35" x2="-0.4" y2="-31" stroke-width="3.2" fill="none"/>'
        '<path d="M-5 -30.5 Q-0.6 -32.5 3.8 -30.5 L3.6 -15 L4.8 -1 L1.3 -1 L-0.5 -13 L-2.3 -1 L-5.8 -1 L-4.8 -15 Z" stroke-width="0.8"/>'
        '<line x1="2.8" y1="-29.2" x2="10.5" y2="-46" stroke-width="2.9" fill="none"/>'
        '<line x1="-4.3" y1="-28.5" x2="-6.6" y2="-16" stroke-width="2.7" fill="none"/>'
        "</g>"
    )


def ground_svg():
    """Far mountains in the sunset, then everything close by as one dark shape."""
    return (
        linear("mountains", 0, 366, 0, 432, ((0, "#3a2a84"), (1, "#5a3a86")))
        + f'<path d="{MOUNTAINS_FAR}" fill="url(#mountains)"/>'
        + f'<path d="{MOUNTAINS_NEAR}" fill="#1a1450"/>'
        + "".join(pine_svg(*pine) for pine in PINES)
        + f'<path d="{RIDGE}" fill="{GROUND}"/>'
        + f'<ellipse cx="422" cy="424" rx="22" ry="20" fill="{GROUND}"/>'
        + home_svg()
        + spotter_svg()
    )


def icon_svg(theme):
    """The badge, in the 512 x 512 design space."""
    rim = (
        f'<rect x="1.5" y="1.5" width="{SIDE - 3}" height="{SIDE - 3}" rx="{CORNER - 1.5}" fill="none" stroke="{theme["rim"]}" stroke-width="3"/>'
        if theme["rim"]
        else ""
    )
    return (
        f"<defs>{FILTERS}</defs>"
        f'<clipPath id="badge"><rect width="{SIDE}" height="{SIDE}" rx="{CORNER}"/></clipPath>'
        f'<g clip-path="url(#badge)">{sky_svg()}{trail_svg()}{satellite_svg()}{ground_svg()}{rim}</g>'
    )


# ---- the logo ------------------------------------------------------------------
# The name in outlines, 240 high to the top of the capitals, baseline at y = 0: Sora 700 with
# 0.012 em of tracking, and Sora 600 at 0.74 of that height, tracked out to the same width.
SATELLITE = "M110.47 6.25Q77.92 6.25 55.56 -4.11Q33.21 -14.47 21.7 -32.38Q10.19 -50.3 10.19 -73.64H62.47Q62.47 -64.44 67.56 -56.55Q72.66 -48.66 83.18 -43.89Q93.7 -39.12 110.47 -39.12Q125.59 -39.12 135.78 -43.07Q145.97 -47.01 151.23 -54.08Q156.49 -61.15 156.49 -70.36Q156.49 -81.86 146.63 -88.6Q136.77 -95.34 114.74 -97.32L96.66 -98.96Q60.82 -101.92 39.45 -121.32Q18.08 -140.71 18.08 -172.6Q18.08 -195.62 29.1 -212.38Q40.11 -229.15 59.84 -238.19Q79.56 -247.23 106.52 -247.23Q134.79 -247.23 155.01 -237.53Q175.23 -227.84 186.08 -210.25Q196.93 -192.66 196.93 -168.99H144.33Q144.33 -177.86 140.05 -185.26Q135.78 -192.66 127.4 -197.26Q119.01 -201.86 106.52 -201.86Q94.68 -201.86 86.63 -197.92Q78.58 -193.97 74.63 -187.23Q70.68 -180.49 70.68 -172.6Q70.68 -162.41 77.92 -154.85Q85.15 -147.29 101.59 -145.97L120 -144.33Q146.3 -142.03 166.36 -132.99Q186.41 -123.95 197.75 -108.33Q209.1 -92.71 209.1 -70.36Q209.1 -47.34 197.1 -30.08Q185.1 -12.82 163.07 -3.29Q141.04 6.25 110.47 6.25ZM226.19 0 305.42 -240H392.55L474.74 0H418.85L352.44 -202.85L369.53 -195.95H327.12L344.88 -202.85L280.11 0ZM286.36 -59.51 302.79 -104.22H396.82L413.59 -59.51ZM536.22 0V-199.56H590.14V0ZM468.82 -192.99V-240H657.86V-192.99ZM695.67 0V-240H748.27V0ZM741.7 0V-44.71H846.58V0ZM741.7 -99.62V-144.33H839.01V-99.62ZM741.7 -195.29V-240H844.27V-195.29ZM894.9 0V-240H948.82V0ZM942.25 0V-47.34H1042.85V0ZM1082.3 0V-240H1136.22V0ZM1129.64 0V-47.34H1230.25V0ZM1270.36 0V-240H1324.27V0ZM1430.47 0V-199.56H1484.38V0ZM1363.07 -192.99V-240H1552.11V-192.99ZM1589.92 0V-240H1642.52V0ZM1635.95 0V-44.71H1740.82V0ZM1635.95 -99.62V-144.33H1733.26V-99.62ZM1635.95 -195.29V-240H1738.52V-195.29Z"
SPOTTER = "M82.47 4.62Q58.88 4.62 42.7 -2.92Q26.52 -10.46 18 -23.72Q9.49 -36.98 9.49 -53.77H43.31Q43.31 -46.71 47.2 -40.02Q51.09 -33.33 59.73 -29.19Q68.36 -25.06 82.47 -25.06Q95.13 -25.06 103.64 -28.71Q112.16 -32.36 116.29 -38.32Q120.43 -44.28 120.43 -51.82Q120.43 -61.31 112.4 -67.03Q104.37 -72.74 87.58 -74.2L72.01 -75.42Q46.47 -77.61 31.26 -91.35Q16.06 -105.1 16.06 -127.73Q16.06 -144.76 24.09 -157.04Q32.11 -169.33 46.59 -176.02Q61.07 -182.71 80.53 -182.71Q100.72 -182.71 115.32 -175.65Q129.92 -168.6 137.94 -155.83Q145.97 -143.05 145.97 -125.78H112.16Q112.16 -133.08 108.63 -139.28Q105.1 -145.49 98.17 -149.26Q91.23 -153.03 80.53 -153.03Q70.31 -153.03 63.5 -149.62Q56.69 -146.22 53.28 -140.38Q49.87 -134.54 49.87 -127.73Q49.87 -119.45 55.96 -113.25Q62.04 -107.05 75.18 -106.07L90.75 -104.61Q109.72 -103.15 124.08 -96.59Q138.43 -90.02 146.34 -78.83Q154.24 -67.63 154.24 -51.82Q154.24 -35.03 145.49 -22.26Q136.73 -9.49 120.55 -2.43Q104.37 4.62 82.47 4.62ZM314.96 -54.5V-84.42H349.5Q359.96 -84.42 367.14 -88.56Q374.32 -92.69 378.09 -99.99Q381.86 -107.29 381.86 -116.78Q381.86 -126.27 378.09 -133.56Q374.32 -140.86 367.14 -144.88Q359.96 -148.89 349.5 -148.89H314.96V-178.82H346.58Q368.97 -178.82 384.66 -171.52Q400.35 -164.22 408.62 -150.72Q416.89 -137.21 416.89 -118.72V-114.83Q416.89 -96.34 408.62 -82.84Q400.35 -69.34 384.66 -61.92Q368.97 -54.5 346.58 -54.5ZM285.28 0V-178.82H319.82V0ZM628.21 4.62Q604.12 4.62 586.49 -3.89Q568.85 -12.41 557.29 -26.15Q545.74 -39.9 540.02 -55.83Q534.3 -71.77 534.3 -86.61V-91.96Q534.3 -108.26 540.14 -124.44Q545.98 -140.62 557.78 -153.76Q569.58 -166.9 587.09 -174.8Q604.61 -182.71 628.21 -182.71Q651.57 -182.71 669.08 -174.8Q686.6 -166.9 698.4 -153.76Q710.2 -140.62 716.04 -124.44Q721.88 -108.26 721.88 -91.96V-86.61Q721.88 -71.77 716.16 -55.83Q710.44 -39.9 698.89 -26.15Q687.33 -12.41 669.69 -3.89Q652.05 4.62 628.21 4.62ZM628.21 -27.49Q641.83 -27.49 652.66 -32.36Q663.49 -37.22 671.15 -45.86Q678.81 -54.5 682.83 -65.57Q686.84 -76.64 686.84 -89.04Q686.84 -102.42 682.83 -113.62Q678.81 -124.81 671.15 -133.08Q663.49 -141.35 652.54 -145.97Q641.59 -150.6 628.21 -150.6Q614.59 -150.6 603.64 -145.97Q592.69 -141.35 585.03 -133.08Q577.36 -124.81 573.35 -113.62Q569.33 -102.42 569.33 -89.04Q569.33 -76.64 573.35 -65.57Q577.36 -54.5 585.03 -45.86Q592.69 -37.22 603.64 -32.36Q614.59 -27.49 628.21 -27.49ZM884.53 0V-152.05H919.08V0ZM833.2 -147.19V-177.6H970.42V-147.19ZM1134.05 0V-152.05H1168.59V0ZM1082.71 -147.19V-177.6H1219.93V-147.19ZM1346.82 0V-177.6H1380.64V0ZM1375.77 0V-29.19H1456.3V0ZM1375.77 -75.66V-104.86H1449.98V-75.66ZM1375.77 -148.41V-177.6H1454.36V-148.41ZM1591.23 0V-178.82H1625.77V0ZM1699.73 0 1645.24 -77.37H1683.92L1740.12 0ZM1615.56 -59.36V-87.34H1660.81Q1670.29 -87.34 1677.23 -91.23Q1684.16 -95.13 1688.05 -102.18Q1691.95 -109.24 1691.95 -118.24Q1691.95 -127.48 1688.05 -134.54Q1684.16 -141.59 1677.23 -145.49Q1670.29 -149.38 1660.81 -149.38H1615.56V-178.82H1657.16Q1678.57 -178.82 1694.26 -172.49Q1709.95 -166.17 1718.47 -153.27Q1726.98 -140.38 1726.98 -120.91V-117.02Q1726.98 -97.32 1718.34 -84.66Q1709.71 -72.01 1694.14 -65.69Q1678.57 -59.36 1657.16 -59.36Z"
CAP1, CAP2 = 240, 177.6  # the height of each line's capitals
NAME_X, NAME_Y = 568, 102  # where the name's box starts, beside the icon and centered on it
NAME_SCALE = 0.5749  # the outlines' units to the design space
LOGO_WIDTH = 1564  # even, so that the normal version is exactly half the @2x


def name_svg(theme):
    """The two lines beside the icon, each shaded from the top of its capitals to its baseline."""
    return (
        linear("line1", 0, -CAP1, 0, 0, theme["line1"])
        + linear("line2", 0, -CAP2, 0, 0, theme["line2"])
        + f'<g transform="translate({NAME_X} {NAME_Y}) scale({NAME_SCALE})">'
        + f'<path fill="url(#line1)" transform="translate(-10.19 240)" d="{SATELLITE}"/>'
        + f'<path fill="url(#line2)" transform="translate(-9.49 528)" d="{SPOTTER}"/>'
        + "</g>"
    )


# ---- rendering -----------------------------------------------------------------
PAGE = """<!doctype html><html><head><style>
html, body {{ margin: 0; background: transparent; }} svg {{ display: block; }}</style></head>
<body>{svg}</body></html>"""


def render(page, svg_inner, view, size):
    """PNG bytes of the SVG content in a `view` (w, h) of the design space, drawn at `size` (w, h) px."""
    vw, vh = view
    w, h = size
    svg = f'<svg id="s" xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {vw} {vh}">{svg_inner}</svg>'
    page.set_viewport_size({"width": w, "height": h})
    page.set_content(PAGE.format(svg=svg))
    return page.locator("#s").screenshot(omit_background=True)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--out", type=Path, default=OUT, help="where to write the PNGs (default: %(default)s)"
    )
    parser.add_argument(
        "--channel", help="a browser you already have, such as chrome, in place of Playwright's own"
    )
    args = parser.parse_args(argv)

    # Only rendering needs a browser: the rest imports without Playwright.
    from playwright.sync_api import sync_playwright  # noqa: PLC0415

    args.out.mkdir(parents=True, exist_ok=True)

    def save(png, name):
        path = args.out / name
        im = Image.open(io.BytesIO(png))
        im.save(path, optimize=True)
        print(name, im.size, path.stat().st_size)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel=args.channel)
        page = browser.new_page()
        for name, theme in THEMES.items():
            prefix = "" if name == "light" else "dark_"
            icon = icon_svg(theme)
            for size, suffix in ((256, ""), (512, "@2x")):
                save(render(page, icon, (SIDE, SIDE), (size, size)), f"{prefix}icon{suffix}.png")
            logo = icon + name_svg(theme)
            for h, suffix in ((256, ""), (512, "@2x")):
                save(
                    render(page, logo, (LOGO_WIDTH, SIDE), (LOGO_WIDTH * h // SIDE, h)),
                    f"{prefix}logo{suffix}.png",
                )
        browser.close()


if __name__ == "__main__":
    main()
