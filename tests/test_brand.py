"""The brand images Home Assistant (2026.3 and later) and HACS show for the integration."""

from __future__ import annotations

from pathlib import Path

from PIL import Image
import pytest

BRAND = Path(__file__).parents[1] / "custom_components/satellite_spotter/brand"


@pytest.mark.parametrize("prefix", ["", "dark_"])
def test_icons_are_square_badges(prefix: str) -> None:
    for suffix, side in (("", 256), ("@2x", 512)):
        with Image.open(BRAND / f"{prefix}icon{suffix}.png") as im:
            assert (im.format, im.mode, im.size) == ("PNG", "RGBA", (side, side))
            alpha = im.getchannel("A")
            # Trimmed: the badge fills the square, transparent only in its round corners.
            assert alpha.getbbox() == (0, 0, side, side)
            assert alpha.getpixel((0, 0)) == 0
            assert alpha.getpixel((side // 2, side // 2)) == 255


@pytest.mark.parametrize("prefix", ["", "dark_"])
def test_logos_are_the_icon_and_the_name(prefix: str) -> None:
    sizes = []
    for suffix, height in (("", 256), ("@2x", 512)):
        with Image.open(BRAND / f"{prefix}logo{suffix}.png") as im:
            assert (im.format, im.mode, im.height) == ("PNG", "RGBA", height)
            assert im.width > 2 * im.height
            # Trimmed: drawn right up to its edges.
            x0, y0, x1, y1 = im.getchannel("A").getbbox()
            assert (x0, y0, y1) == (0, 0, height)
            assert x1 >= im.width - 2
            sizes.append(im.size)
    assert sizes[1] == (2 * sizes[0][0], 2 * sizes[0][1])
