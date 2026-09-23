from PIL import Image
from pathlib import Path

src = Path(
    r"C:\Users\43798\.cursor\projects\d-electron-navora-harness-navora-flow-desktop\assets\navora-monitor-icon-full.png"
)
out_dir = Path(r"D:\electron\navora-harness\navora-monitor\electron\assets")
out_dir.mkdir(parents=True, exist_ok=True)

img = Image.open(src).convert("RGBA")
w, h = img.size
px = img.load()
TEAL = (15, 110, 86, 255)  # #0f6e56


def is_near_white(r, g, b, a):
    if a < 10:
        return True
    return r > 230 and g > 230 and b > 230


band = max(4, int(min(w, h) * 0.04))
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        on_edge = x < band or y < band or x >= w - band or y >= h - band
        if on_edge and is_near_white(r, g, b, a):
            px[x, y] = TEAL
        elif a < 250 and on_edge:
            px[x, y] = TEAL

for y in range(h):
    for x in range(w):
        dx = min(x, w - 1 - x)
        dy = min(y, h - 1 - y)
        if dx + dy < band * 2:
            r, g, b, a = px[x, y]
            if is_near_white(r, g, b, a):
                px[x, y] = TEAL

out = Image.new("RGBA", (w, h), TEAL)
out.paste(img, (0, 0), img)
rgb = Image.new("RGB", (w, h), (15, 110, 86))
rgb.paste(out.convert("RGB"), (0, 0))
final = rgb.convert("RGBA")

final.resize((256, 256), Image.Resampling.LANCZOS).save(out_dir / "icon.png", "PNG")
final.resize((32, 32), Image.Resampling.LANCZOS).save(out_dir / "tray-icon.png", "PNG")
final.resize((16, 16), Image.Resampling.LANCZOS).save(out_dir / "tray-icon-16.png", "PNG")

pub = Path(r"D:\electron\navora-harness\navora-monitor\public")
pub.mkdir(parents=True, exist_ok=True)
final.resize((256, 256), Image.Resampling.LANCZOS).save(pub / "icon.png", "PNG")
print("wrote", out_dir / "icon.png")
