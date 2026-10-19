"""Render the HomeCircle logo into the app icon assets (run: python3 scripts/make-icons.py)."""
from pathlib import Path
from PIL import Image, ImageDraw

BRAND = (0x2F, 0x7D, 0x6D, 255)
CREAM = (0xF6, 0xEF, 0xE4, 255)
GOLD = (0xF2, 0xB8, 0x4B, 255)
WHITE = (255, 255, 255, 255)
SS = 4  # supersampling for smooth edges
OUT = Path(__file__).resolve().parent.parent / "assets"


def symbol(draw, cx, cy, unit, ring=CREAM, house=CREAM, dot=GOLD):
    """The ring + house + dot from icon.svg, drawn in 64-unit logo coordinates."""
    p = lambda x, y: (cx + (x - 32) * unit, cy + (y - 32) * unit)
    r, w = 17 * unit, 5 * unit
    draw.ellipse([cx - r - w / 2, cy - r - w / 2, cx + r + w / 2, cy + r + w / 2], fill=ring)
    draw.ellipse([cx - r + w / 2, cy - r + w / 2, cx + r - w / 2, cy + r - w / 2], fill=(0, 0, 0, 0))
    draw.polygon([p(32, 21), p(41, 29), p(41, 40), p(23, 40), p(23, 29)], fill=house)
    dr = 4 * unit
    dx, dy = p(32, 15)
    draw.ellipse([dx - dr, dy - dr, dx + dr, dy + dr], fill=dot)


def render(size, bg, symbol_unit, rounded=False, **colors):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg:
        if rounded:
            d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.25, fill=bg)
        else:
            d.rectangle([0, 0, big, big], fill=bg)
    # The ring cuts a transparent hole; repaint the background inside it.
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    symbol(ImageDraw.Draw(layer), big / 2, big / 2 + symbol_unit * SS * 0, symbol_unit * SS, **colors)
    img.alpha_composite(layer)
    return img.resize((size, size), Image.LANCZOS)


# iOS / store icon: full-bleed square (the OS rounds the corners).
render(1024, BRAND, 1024 / 64).save(OUT / "icon.png")
# Android adaptive icon: symbol inside the 66% safe zone on a solid background.
render(1024, None, 13.5).save(OUT / "android-icon-foreground.png")
Image.new("RGBA", (1024, 1024), BRAND).save(OUT / "android-icon-background.png")
render(1024, None, 13.5, ring=WHITE, house=WHITE, dot=WHITE).save(OUT / "android-icon-monochrome.png")
# Splash and favicon: the rounded logo.
render(1024, BRAND, 1024 / 64, rounded=True).save(OUT / "splash-icon.png")
render(48, BRAND, 48 / 64, rounded=True).save(OUT / "favicon.png")
print("icons written to", OUT)
