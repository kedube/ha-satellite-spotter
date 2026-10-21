"""Draw the brand images in custom_components/satellite_spotter/brand/.

The icon is the moment the integration is for: a satellite crossing the night
sky over the street at home, as the street view shows it. A gold trail rises
from behind the roofs to the satellite, brightest where it is now, and dots
show where it goes next; lit windows below, stars above. The badge is its own
night sky, so it reads on light and dark pages alike; the dark version gets a
rim, so that it does not sink into a dark page. The logo sets "Satellite" over
"SPOTTER" beside the icon, both lines the same width.

Home Assistant (2026.3 and later) shows these from the integration's own brand
folder: icon 256 x 256 (512 x 512 @2x), logo 256 px high (512 @2x), trimmed,
transparent around the badge.

usage:
  pip install playwright pillow && playwright install chromium
  python scripts/make_brand.py --font "SpaceGrotesk[wght].ttf"

Input (download once):
  font  Space Grotesk, SIL Open Font License 1.1:
        https://github.com/floriankarsten/space-grotesk/tree/master/fonts/ttf

Importing the module draws nothing; only main() needs Playwright.
"""

# The SVG markup reads better on one line per element.
# ruff: noqa: E501

import argparse
import base64
import io
import math
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "custom_components/satellite_spotter/brand"
D = math.pi / 180
SIDE = 512.0  # the icon's design space, 512 x 512
CORNER = 116.0  # the badge's corner radius

THEMES = {
    "light": {"rim": None, "ink": "#0b1633", "ink2": "#b45309"},
    "dark": {"rim": "#4a6fb0", "ink": "#f8fafc", "ink2": "#fbbf24"},
}

# ---- the sky -------------------------------------------------------------------
# The pass is an arc of an ellipse over the street: angle 180 is the left
# horizon, 0 the right; the satellite is at SAT_AT, the trail starts behind
# the roofs on the left, and the dots run on until it sets behind the house on
# the right.
ARC_CX, ARC_CY, ARC_RX, ARC_RY = 256.0, 476.0, 236.0, 336.0
TRAIL_FROM, SAT_AT, DOTS_TO = 172.0, 58.0, 24.0
STARS = (  # x, y, radius, opacity
    (70, 118, 3.4, 0.95),
    (150, 62, 2.2, 0.75),
    (206, 214, 1.7, 0.55),
    (330, 72, 2.6, 0.85),
    (452, 70, 2.0, 0.7),
    (474, 168, 1.6, 0.55),
    (300, 250, 1.5, 0.5),
    (182, 300, 1.4, 0.45),
    (40, 212, 1.7, 0.6),
    (424, 296, 1.5, 0.45),
)


def arc_point(theta):
    """A point of the pass at this angle (degrees)."""
    return ARC_CX + ARC_RX * math.cos(theta * D), ARC_CY - ARC_RY * math.sin(theta * D)


def trail_path(samples=96):
    """The trail as a filled outline that widens towards the satellite."""
    left, right = [], []
    for i in range(samples + 1):
        u = i / samples
        theta = TRAIL_FROM + (SAT_AT - TRAIL_FROM) * u
        x, y = arc_point(theta)
        # The direction of travel, and the normal to it.
        tx, ty = -ARC_RX * math.sin(theta * D), -ARC_RY * math.cos(theta * D)
        norm = math.hypot(tx, ty)
        nx, ny = -ty / norm, tx / norm
        half = (2.5 + 13.0 * u**1.6) / 2
        left.append((x + nx * half, y + ny * half))
        right.append((x - nx * half, y - ny * half))
    points = left + right[::-1]
    return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in points) + " Z"


def ahead_dots(spacing=24.0):
    """Dots along the rest of the pass, fading as they go: (x, y, radius, opacity)."""
    dots, theta, length = [], SAT_AT, 0.0
    x0, y0 = arc_point(theta)
    while theta > DOTS_TO:
        theta -= 0.2
        x, y = arc_point(theta)
        length += math.hypot(x - x0, y - y0)
        x0, y0 = x, y
        if length >= spacing:
            length = 0.0
            f = (SAT_AT - theta) / (SAT_AT - DOTS_TO)
            dots.append((x, y, 4.4 - 1.4 * f, 0.8 - 0.5 * f))
    return dots


# ---- the street ----------------------------------------------------------------
NIGHT = "#08122b"  # the houses against the sky
LIT, UNLIT = "#fbbf24", "#15244d"
HOUSE_LEFT = ((14, 520), (14, 420), (96, 356), (178, 420), (178, 520))
CHIMNEY = (128, 368, 22, 44)
BLOCK = (236, 328, 120, 192)  # x, y, width, height
BLOCK_LIT = {(0, 0), (2, 0), (1, 1), (0, 2), (2, 2), (1, 3), (0, 4), (2, 4)}
HOUSE_RIGHT = ((346, 520), (346, 424), (424, 366), (502, 424), (502, 520))


def polygon(points, fill, extra=""):
    path = " ".join(f"{x},{y}" for x, y in points)
    return f'<polygon points="{path}" fill="{fill}"{extra}/>'


def street_svg():
    """The roofs and lit windows along the bottom of the badge."""
    rim = ' stroke="#2d4c86" stroke-width="3" stroke-linejoin="round"'
    bx, by, bw, bh = BLOCK
    windows = []
    for row in range(5):
        for col in range(3):
            fill = LIT if (col, row) in BLOCK_LIT else UNLIT
            windows.append(
                f'<rect x="{bx + 14 + col * 34}" y="{by + 18 + row * 34}" width="20" height="20" rx="3" fill="{fill}"/>'
            )
    cx, cy, cw, ch = CHIMNEY
    return "".join(
        (
            f'<rect x="{cx}" y="{cy}" width="{cw}" height="{ch}" fill="{NIGHT}"{rim}/>',
            polygon(HOUSE_LEFT, NIGHT, rim),
            f'<rect x="42" y="438" width="34" height="32" rx="4" fill="{LIT}"/>',
            f'<rect x="110" y="438" width="34" height="32" rx="4" fill="{LIT}" opacity="0.85"/>',
            f'<path d="M59 438 V470 M42 454 H76 M127 438 V470 M110 454 H144" stroke="{NIGHT}" stroke-width="4"/>',
            f'<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" fill="{NIGHT}"{rim}/>',
            *windows,
            polygon(HOUSE_RIGHT, NIGHT, rim),
            f'<rect x="406" y="446" width="36" height="32" rx="4" fill="{LIT}"/>',
            f'<path d="M424 446 V478 M406 462 H442" stroke="{NIGHT}" stroke-width="4"/>',
        )
    )


def satellite_svg(x, y, turn=-28.0):
    """A small satellite at (x, y): a gold body between two solar wings, turned a little."""
    wing_lines = "".join(
        f'<path d="M{side * a} -9 V9" stroke="#1d4ed8" stroke-opacity="0.55" stroke-width="1.6"/>'
        for side in (-1, 1)
        for a in (27, 36, 45)
    )
    return f"""<g transform="translate({x:.2f} {y:.2f}) rotate({turn})">
  <rect x="-18" y="-1.8" width="36" height="3.6" fill="#e2e8f0"/>
  <rect x="-53" y="-10" width="35" height="20" rx="2" fill="url(#wing)" stroke="#1e3a8a" stroke-width="1.6"/>
  <rect x="18" y="-10" width="35" height="20" rx="2" fill="url(#wing)" stroke="#1e3a8a" stroke-width="1.6"/>
  {wing_lines}
  <path d="M-53 0 H-18 M18 0 H53" stroke="#1d4ed8" stroke-opacity="0.55" stroke-width="1.6"/>
  <rect x="-12" y="-13" width="24" height="26" rx="4" fill="url(#body)" stroke="#92400e" stroke-width="1.6"/>
  <rect x="-7" y="-9" width="9" height="7" rx="1.5" fill="#fffbeb" opacity="0.85"/>
</g>"""


def icon_svg(theme):
    """The badge, in the 512 x 512 design space."""
    sx, sy = arc_point(SAT_AT)
    stars = "".join(
        f'<circle cx="{x}" cy="{y}" r="{r}" fill="#ffffff" opacity="{a}"/>' for x, y, r, a in STARS
    )
    dots = "".join(
        f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{r:.2f}" fill="#fcd34d" opacity="{a:.2f}"/>'
        for x, y, r, a in ahead_dots()
    )
    trail = trail_path()
    tx0, _ = arc_point(TRAIL_FROM)
    rim = (
        f'<rect x="1.5" y="1.5" width="{SIDE - 3}" height="{SIDE - 3}" rx="{CORNER - 1.5}" fill="none" stroke="{theme["rim"]}" stroke-width="3"/>'
        if theme["rim"]
        else ""
    )
    return f"""
<defs>
  <clipPath id="badge"><rect width="{SIDE}" height="{SIDE}" rx="{CORNER}"/></clipPath>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#050b1e"/><stop offset="0.55" stop-color="#0c1c47"/>
    <stop offset="0.86" stop-color="#1d3a7a"/><stop offset="1" stop-color="#2e5aa0"/>
  </linearGradient>
  <radialGradient id="glow" cx="256" cy="470" r="330" gradientUnits="userSpaceOnUse" gradientTransform="translate(256 470) scale(1 0.55) translate(-256 -470)">
    <stop offset="0" stop-color="#60a5fa" stop-opacity="0.35"/><stop offset="1" stop-color="#60a5fa" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="trail" x1="{tx0:.1f}" y1="0" x2="{sx:.1f}" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#f59e0b" stop-opacity="0"/><stop offset="0.35" stop-color="#f59e0b" stop-opacity="0.4"/>
    <stop offset="0.75" stop-color="#fbbf24" stop-opacity="0.9"/><stop offset="1" stop-color="#fef3c7"/>
  </linearGradient>
  <radialGradient id="halo" cx="{sx:.2f}" cy="{sy:.2f}" r="66" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fffbeb" stop-opacity="0.95"/><stop offset="0.18" stop-color="#fde68a" stop-opacity="0.7"/>
    <stop offset="0.45" stop-color="#fbbf24" stop-opacity="0.22"/><stop offset="1" stop-color="#fbbf24" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="wing" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#dbeafe"/><stop offset="1" stop-color="#60a5fa"/>
  </linearGradient>
  <linearGradient id="body" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fef3c7"/><stop offset="0.5" stop-color="#fcd34d"/><stop offset="1" stop-color="#f59e0b"/>
  </linearGradient>
  <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="0.4" stop-color="#ffffff" stop-opacity="0"/>
  </linearGradient>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>
</defs>
<g clip-path="url(#badge)">
  <rect width="{SIDE}" height="{SIDE}" fill="url(#sky)"/>
  <rect width="{SIDE}" height="{SIDE}" fill="url(#glow)"/>
  {stars}
  <path d="{trail}" fill="#fbbf24" opacity="0.55" filter="url(#soft)"/>
  <path d="{trail}" fill="url(#trail)"/>
  {dots}
  <circle cx="{sx:.2f}" cy="{sy:.2f}" r="66" fill="url(#halo)"/>
  {satellite_svg(sx, sy)}
  {street_svg()}
  <rect x="1" y="1" width="{SIDE - 2}" height="{SIDE - 2}" rx="{CORNER - 1}" fill="none" stroke="url(#edge)" stroke-width="2"/>
</g>
{rim}"""


# ---- rendering -----------------------------------------------------------------
PAGE = """<!doctype html><html><head><style>{font}
html, body {{ margin: 0; background: transparent; }} svg {{ display: block; }}</style></head>
<body>{svg}</body></html>"""


def font_face(font):
    data = base64.b64encode(font.read_bytes()).decode()
    return f"@font-face {{ font-family: 'Space Grotesk'; src: url(data:font/ttf;base64,{data}) format('truetype'); font-weight: 300 700; }}"


def render(page, font_css, svg_inner, view, size):
    """PNG bytes of the SVG content in `view` (x, y, w, h), drawn at `size` (w, h) px."""
    vx, vy, vw, vh = view
    w, h = size
    svg = f'<svg id="s" xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vx:.2f} {vy:.2f} {vw:.2f} {vh:.2f}">{svg_inner}</svg>'
    page.set_viewport_size({"width": w, "height": h})
    page.set_content(PAGE.format(font=font_css, svg=svg))
    page.evaluate("document.fonts.ready")
    return page.locator("#s").screenshot(omit_background=True)


def measure(page, font_css, svg_inner, canvas=(4200, 1200), origin=(100, 900)):
    """Exact drawn bounds of some SVG placed at `origin`, in px (1 unit = 1 px)."""
    w, h = canvas
    inner = f'<g transform="translate({origin[0]} {origin[1]})">{svg_inner}</g>'
    png = render(page, font_css, inner, (0, 0, w, h), (w, h))
    x0, y0, x1, y1 = Image.open(io.BytesIO(png)).getchannel("A").getbbox()
    return x0 - origin[0], y0 - origin[1], x1 - origin[0], y1 - origin[1]


# ---- the logo ------------------------------------------------------------------
TITLE = ("Satellite", 700, -0.01)  # text, weight, letter spacing (em)
SUBTITLE = ("SPOTTER", 600)  # spaced out to the title's width
CAP = 0.3  # the title's cap height, as a share of the icon's
SUB = 0.62  # the subtitle's height, as a share of the title's
GAP = 0.34  # between the lines, as a share of the title's height
MARGIN = 0.12  # between the icon and the text, as a share of the icon's width
SIZE = 300  # font size the text is measured at


def text_svg(text, weight, spacing, fill):
    return f'<text font-family="Space Grotesk" font-size="{SIZE}" font-weight="{weight}" letter-spacing="{spacing * SIZE:.3f}" fill="{fill}">{text}</text>'


def logo_layout(page, font_css, cap=CAP):
    """The two lines for an icon of side 1, each (text, weight, spacing, scale, x, y), and the logo's width."""
    m1 = measure(page, font_css, text_svg(*TITLE, "#000"))
    s1 = cap / (m1[3] - m1[1])
    width = (m1[2] - m1[0]) * s1
    # Spacing widens the subtitle's ink by (letters - 1) x spacing: solve for the title's width.
    m0 = measure(page, font_css, text_svg(*SUBTITLE, 0.0, "#000"))
    s2 = SUB * cap / (m0[3] - m0[1])
    spacing = (width / s2 - (m0[2] - m0[0])) / ((len(SUBTITLE[0]) - 1) * SIZE)
    m2 = measure(page, font_css, text_svg(*SUBTITLE, spacing, "#000"))
    s2 = width / (m2[2] - m2[0])  # exact, once the ink is measured
    gap = GAP * cap
    top = (1 - (cap + gap + (m2[3] - m2[1]) * s2)) / 2
    left = 1 + MARGIN
    lines = (
        (*TITLE, s1, left - m1[0] * s1, top - m1[1] * s1),
        (*SUBTITLE, spacing, s2, left - m2[0] * s2, top + cap + gap - m2[1] * s2),
    )
    return lines, left + width


def logo_svg(lines, theme):
    """The two lines of text beside an icon that fills the 512 design space's height."""
    inks = (theme["ink"], theme["ink2"])
    return "".join(
        f'<g transform="translate({x * SIDE:.2f} {y * SIDE:.2f}) scale({s * SIDE:.5f})">'
        + text_svg(text, weight, spacing, ink)
        + "</g>"
        for (text, weight, spacing, s, x, y), ink in zip(lines, inks, strict=True)
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--font", type=Path, required=True, help="SpaceGrotesk[wght].ttf")
    parser.add_argument(
        "--out", type=Path, default=OUT, help="where to write the PNGs (default: %(default)s)"
    )
    args = parser.parse_args(argv)

    # Only rendering needs a browser: the rest imports without Playwright.
    from playwright.sync_api import sync_playwright  # noqa: PLC0415

    font_css = font_face(args.font)
    args.out.mkdir(parents=True, exist_ok=True)

    def save(png, name):
        path = args.out / name
        im = Image.open(io.BytesIO(png))
        im.save(path, optimize=True)
        print(name, im.size, path.stat().st_size)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        lines, logo_w = logo_layout(page, font_css)
        for name, theme in THEMES.items():
            prefix = "" if name == "light" else "dark_"
            icon = icon_svg(theme)
            for size, suffix in ((256, ""), (512, "@2x")):
                save(
                    render(page, font_css, icon, (0, 0, SIDE, SIDE), (size, size)),
                    f"{prefix}icon{suffix}.png",
                )
            # The logo: the icon, then the two lines beside it, centred on it.
            logo = icon + logo_svg(lines, theme)
            for h, suffix in ((256, ""), (512, "@2x")):
                save(
                    render(
                        page, font_css, logo, (0, 0, logo_w * SIDE, SIDE), (round(h * logo_w), h)
                    ),
                    f"{prefix}logo{suffix}.png",
                )
        browser.close()


if __name__ == "__main__":
    main()
