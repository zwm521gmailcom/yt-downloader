"""Generate the extension's PNG icons.

Draws a rounded red square with a white download arrow — the same mark the
in-page floating button uses, so the extension reads consistently everywhere.

Run from the project root:  python tools/make_icons.py
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "icons")
SIZES = (16, 32, 48, 128)

RED_TOP = (255, 30, 74)
RED_BOTTOM = (196, 0, 43)
WHITE = (255, 255, 255)


def rounded_mask(size: int, radius_ratio: float = 0.22) -> Image.Image:
    """Antialiased rounded-rectangle mask."""
    # Supersample for smooth corners, then downsample.
    scale = 8
    big = size * scale
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


def gradient(size: int) -> Image.Image:
    """Vertical red gradient used as the icon background."""
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        grad.putpixel((0, y), tuple(
            int(RED_TOP[i] + (RED_BOTTOM[i] - RED_TOP[i]) * t) for i in range(3)
        ))
    return grad.resize((size, size), Image.BILINEAR)


def draw_arrow(img: Image.Image) -> None:
    """White download arrow: a shaft plus a chevron head and a base line."""
    size = img.width
    scale = 8
    big = size * scale
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    unit = big / 100.0

    cx = big / 2

    # Shaft (vertical bar), stopping short of the chevron tip.
    shaft_w = 10 * unit
    shaft_top = 22 * unit
    shaft_bottom = 52 * unit
    d.rounded_rectangle(
        (cx - shaft_w / 2, shaft_top, cx + shaft_w / 2, shaft_bottom),
        radius=shaft_w / 2, fill=WHITE,
    )

    # Chevron head: a single closed polygon so the point is crisp and the
    # stroke weight stays even on both diagonals.
    half = 20 * unit
    head_top = 42 * unit
    tip_y = 68 * unit
    inner_y = 61 * unit          # inner notch, sets the stroke thickness
    inner_half = half - (tip_y - inner_y)

    d.polygon(
        [
            (cx - half, head_top),
            (cx, tip_y),
            (cx + half, head_top),
            (cx + inner_half, head_top),
            (cx, inner_y),
            (cx - inner_half, head_top),
        ],
        fill=WHITE,
    )

    # Base tray.
    base_w = 42 * unit
    base_y = 81 * unit
    thickness = 9 * unit
    d.rounded_rectangle(
        (cx - base_w / 2, base_y - thickness / 2, cx + base_w / 2, base_y + thickness / 2),
        radius=thickness / 2, fill=WHITE,
    )

    layer = layer.resize((size, size), Image.LANCZOS)
    img.paste(layer, (0, 0), layer)


def build(size: int) -> Image.Image:
    bg = gradient(size).convert("RGBA")
    bg.putalpha(rounded_mask(size))
    draw_arrow(bg)
    return bg


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        build(size).save(path, "PNG", optimize=True)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
