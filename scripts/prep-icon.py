"""
Build app icons with rounded corners and transparent outside.

Usage:
  python scripts/prep-icon.py [source.png]

Default: electron/assets/icon.png
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT / "electron" / "assets" / "icon.png"
RADIUS_RATIO = 0.22


def round_corners(img: Image.Image, radius_ratio: float = RADIUS_RATIO) -> Image.Image:
    """Keep the glyph; make pixels outside a rounded rect fully transparent."""
    rgba = img.convert("RGBA")
    w, h = rgba.size
    r = max(1, int(min(w, h) * radius_ratio))
    scale = 4
    mask = Image.new("L", (w * scale, h * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, w * scale - 1, h * scale - 1),
        radius=r * scale,
        fill=255,
    )
    mask = mask.resize((w, h), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(rgba, (0, 0))
    out.putalpha(ImageChops.multiply(rgba.getchannel("A"), mask))
    return out


def save_rounded(src: Image.Image, path: Path, size: int) -> None:
    im = src.resize((size, size), Image.Resampling.LANCZOS) if src.size != (size, size) else src.copy()
    im = round_corners(im)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "PNG")
    print("wrote", path)


def main() -> None:
    src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src_path.is_file():
        raise SystemExit(f"missing source icon: {src_path}")

    src = Image.open(src_path).convert("RGBA")
    assets = ROOT / "electron" / "assets"
    pub = ROOT / "public"

    save_rounded(src, assets / "icon.png", 256)
    save_rounded(src, assets / "tray-icon.png", 32)
    save_rounded(src, assets / "tray-icon-16.png", 16)
    save_rounded(src, pub / "icon.png", 256)
    save_rounded(src, ROOT / "build" / "icon.png", 256)

    im = Image.open(assets / "icon.png")
    px = im.load()
    assert px is not None
    print(
        "corner alpha",
        px[0, 0][3],
        px[255, 0][3],
        px[0, 255][3],
        px[255, 255][3],
        "center",
        px[128, 128][3],
    )


if __name__ == "__main__":
    main()
