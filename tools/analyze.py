"""像素分析工具：把游戏截图拆成棋盘网格，输出每格颜色/状态。

用法: python tools/analyze.py <图片路径>
"""
import sys
import numpy as np
from PIL import Image


def load(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    return im, a


def srgb_stats(a):
    """返回 (彩度饱和度, 明度) 用 HSV 近似。"""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    sat = (mx - mn)  # 0..255 的色度范围
    return sat, mx, mn


def find_board(a):
    sat, mx, mn = srgb_stats(a)
    # 彩色格子: 有明显色差且不太暗不太亮
    mask = (sat > 28) & (mx > 60)
    h, w = mask.shape
    col_cov = mask.mean(axis=0)
    row_cov = mask.mean(axis=1)

    def band(cov, thr):
        idx = np.where(cov > thr)[0]
        if len(idx) == 0:
            return None
        return int(idx[0]), int(idx[-1])

    cb = band(col_cov, 0.15)
    rb = band(row_cov, 0.30)
    return mask, cb, rb, col_cov, row_cov


def main(path):
    im, a = load(path)
    print("size", im.size)
    mask, cb, rb, col_cov, row_cov = find_board(a)
    print("col band", cb, "row band", rb)
    h, w = mask.shape
    # 打印行方向的彩色覆盖率，找出棋盘所在的行区间
    step = max(1, h // 80)
    for y in range(0, h, step):
        print(f"y={y:5d} cov={row_cov[y]:.2f}")


if __name__ == "__main__":
    main(sys.argv[1])
