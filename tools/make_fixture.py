"""生成一张"刚开局、全空白"的合成棋盘图，用来验证识别管线不依赖特定截图。"""
from PIL import Image, ImageDraw

REGIONS = """A A A A A A A B
A A A A A A C B
D D D A A E C B
D D D F A E E E
D G G F E E E E
D G G G E E E E
G G G G G G E E
H G G G G E E E""".strip().split("\n")

PALETTE = {
    "A": (180, 216, 152),
    "B": (124, 184, 228),
    "C": (220, 188, 92),
    "D": (240, 172, 116),
    "E": (220, 136, 180),
    "F": (200, 120, 116),
    "G": (72, 136, 88),
    "H": (96, 116, 172),
}

CELL = 120
GAP = 8
MARGIN = 60
N = 8
size = MARGIN * 2 + N * CELL + (N - 1) * GAP
img = Image.new("RGB", (size, size + 120), (248, 249, 252))
draw = ImageDraw.Draw(img)

grid = [row.split(" ") for row in REGIONS]
for r in range(N):
    for c in range(N):
        x = MARGIN + c * (CELL + GAP)
        y = 40 + r * (CELL + GAP)
        draw.rounded_rectangle([x, y, x + CELL, y + CELL], radius=18, fill=PALETTE[grid[r][c]])

img.save("tests/fixtures/blank-board.png")
print("写出 tests/fixtures/blank-board.png", img.size)
