"""从游戏截图里抠出"鹅"的图标，生成 assets/goose.png（透明底）和 assets/goose-tile.png（带格子底色）。

用法: python tools/extract_icon.py <截图路径> [行 列] [格子参数 x0 y0 pitch]
默认从第 10 关截图里 (1,8) 那只鹅抠。
"""
import sys
import numpy as np
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else r"D:/Downloads/dae.jfif"
ROW = int(sys.argv[2]) if len(sys.argv) > 2 else 0
COL = int(sys.argv[3]) if len(sys.argv) > 3 else 7
X0 = float(sys.argv[4]) if len(sys.argv) > 4 else 42.0
Y0 = float(sys.argv[5]) if len(sys.argv) > 5 else 1133.0
PITCH = float(sys.argv[6]) if len(sys.argv) > 6 else 169.35

im = Image.open(SRC).convert("RGB")
a = np.asarray(im).astype(float)

xa = int(X0 + COL * PITCH)
ya = int(Y0 + ROW * PITCH)
sub = a[ya:ya + int(PITCH), xa:xa + int(PITCH)]
h, w, _ = sub.shape

# 格子底色 = 四条边内侧的中位色
edge = np.concatenate([sub[8:14, 8:-8].reshape(-1, 3), sub[-14:-8, 8:-8].reshape(-1, 3)])
tile = np.median(edge, axis=0)

dist = np.abs(sub - tile).max(axis=2)
alpha = np.clip((dist - 8) / 22.0, 0, 1)

# 只看中间区域，避开圆角外的白底
inset = int(PITCH * 0.10)
m = np.zeros_like(alpha)
m[inset:h - inset, inset:w - inset] = alpha[inset:h - inset, inset:w - inset]

ys, xs = np.where(m > 0.35)
top, bottom, left, right = ys.min(), ys.max(), xs.min(), xs.max()
pad = 3
top, left = max(0, top - pad), max(0, left - pad)
bottom, right = min(h - 1, bottom + pad), min(w - 1, right + pad)

crop_rgb = sub[top:bottom + 1, left:right + 1]
crop_a = (m[top:bottom + 1, left:right + 1] * 255).astype(np.uint8)
out = np.dstack([crop_rgb, crop_a]).astype(np.uint8)
icon = Image.fromarray(out, "RGBA")
scale = 320 / max(icon.size)
icon = icon.resize((round(icon.width * scale), round(icon.height * scale)), Image.LANCZOS)
icon.save("assets/goose.png", optimize=True)
print("goose.png", icon.size, "tile color", tile.astype(int))
