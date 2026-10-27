/**
 * 截图识别：把一张游戏截图拆成「棋盘网格 + 每格颜色 + 每格状态」。
 *
 * 思路完全靠像素几何与颜色，不依赖任何模型：
 *   1. 先找"彩色像素"（色块格子），用行/列覆盖率定位棋盘矩形；
 *   2. 棋盘内部的行列分隔缝很白，覆盖率会骤降到 0，据此切出格子；
 *   3. 每格取中间区域，统计白色像素占比判断有没有标记（X / 鹅）；
 *   4. 格子背景色聚类，聚不出来的就是"同一种颜色"，即同一个色块区域。
 */

const MAX_SIDE = 1600; // 识别前先把图缩到这个尺寸以内，够用且快

/** 把 Blob / File / ImageBitmap / HTMLImageElement 统一成 ImageBitmap */
export async function toBitmap(source) {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) return source;
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    if (typeof createImageBitmap === "function") return createImageBitmap(source);
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(source);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }
  return source; // HTMLImageElement
}

export function sizeOf(bmp) {
  return { width: bmp.width || bmp.naturalWidth, height: bmp.height || bmp.naturalHeight };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * 主入口：分析一张图。
 * @param {ImageBitmap|HTMLImageElement|Blob|File} source
 * @returns {Promise<object>} 识别结果，坐标已换算回原图
 */
export async function analyze(source) {
  const bmp = await toBitmap(source);
  const { width: ow, height: oh } = sizeOf(bmp);
  const scale = Math.min(1, MAX_SIDE / Math.max(ow, oh));
  const w = Math.max(1, Math.round(ow * scale));
  const h = Math.max(1, Math.round(oh * scale));

  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const board = locateBoard(data, w, h);
  if (!board) {
    throw new Error("没找到棋盘。请把整个棋盘都截进来，四周留一点边。");
  }
  const grid = locateGrid(data, w, h, board);
  if (!grid) {
    throw new Error("找到了彩色区域，但没能切出格子。截图可能被裁掉了一部分，或者棋盘倾斜了。");
  }

  const cells = readCells(data, w, h, grid);
  let regions = clusterColors(cells, grid.rows, grid.cols, 22);
  // 「每色块一只」意味着色块数应该正好等于棋盘边长；对不上就换几个阈值再试
  if (grid.rows === grid.cols && new Set(regions.flat()).size !== grid.rows) {
    for (const t of [14, 30, 10, 36, 8]) {
      const alt = clusterColors(cells, grid.rows, grid.cols, t);
      if (new Set(alt.flat()).size === grid.rows) { regions = alt; break; }
    }
  }

  const at2 = (v) => v / scale; // 换算回原图坐标
  return {
    imageWidth: ow,
    imageHeight: oh,
    rows: grid.rows,
    cols: grid.cols,
    // 每格的原始像素位置（原图坐标系）
    layout: cells.map((c) => ({
      r: c.r, c: c.c,
      x: at2(c.x), y: at2(c.y), w: at2(c.w), h: at2(c.h),
      color: c.color,
    })),
    states: cells.map((c) => c.state),
    stateGrid: Array.from({ length: grid.rows }, (_, r) =>
      Array.from({ length: grid.cols }, (_, c) => cells[r * grid.cols + c].state)
    ),
    regions,
    regionIds: regions.map((row) => row.map((id) => id)),
    placed: cells.filter((c) => c.state === "duck").map((c) => [c.r, c.c]),
    banned: cells.filter((c) => c.state === "x").map((c) => [c.r, c.c]),
    warnings: [],
  };
}

/* ---------------- 1. 定位棋盘 ---------------- */

function colorfulnessMask(data, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    mask[i] = mx - mn > 28 && mx > 60 ? 1 : 0;
  }
  return mask;
}

function projections(mask, w, h, x0, y0, x1, y1) {
  const rowCov = new Float32Array(h);
  const colCov = new Float32Array(w);
  const width = x1 - x0;
  const height = y1 - y0;
  for (let y = y0; y < y1; y++) {
    let rowSum = 0;
    const base = y * w;
    for (let x = x0; x < x1; x++) {
      const v = mask[base + x];
      rowSum += v;
      colCov[x] += v;
    }
    rowCov[y] = rowSum / width;
  }
  for (let x = 0; x < w; x++) colCov[x] /= height;
  return { rowCov, colCov };
}

/**
 * 平滑一下覆盖率，让格子之间的细缝不会把棋盘"切断"。
 * 只用于找棋盘的大致范围，切格子时用的还是原始覆盖率。
 */
function smooth(cov, window) {
  const out = new Float32Array(cov.length);
  const half = Math.max(1, Math.round(window / 2));
  for (let i = 0; i < cov.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(cov.length - 1, i + half); j++) {
      sum += cov[j];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

function longestRun(cov, from, to, thr) {
  let best = null;
  let start = -1;
  for (let i = from; i < to; i++) {
    const on = cov[i] > thr;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (!best || i - start > best.end - best.start) best = { start, end: i };
      start = -1;
    }
  }
  if (start >= 0 && (!best || to - start > best.end - best.start)) best = { start, end: to };
  return best;
}

/** 把平滑后的粗范围收回到真正有内容的地方，避免边缘的白边被当成分隔缝 */
function tightenBand(cov, band, thr) {
  let s = band.start;
  let e = band.end;
  while (s < e && cov[s] < thr) s++;
  while (e > s && cov[e - 1] < thr) e--;
  return { start: s, end: e };
}

function locateBoard(data, w, h) {
  const mask = colorfulnessMask(data, w, h);
  const { rowCov } = projections(mask, w, h, 0, 0, w, h);
  const roughRows = longestRun(smooth(rowCov, Math.max(3, h * 0.02)), 0, h, 0.35);
  if (!roughRows) return null;
  const rowBand = tightenBand(rowCov, roughRows, 0.45);

  const colCovBand = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = rowBand.start; y < rowBand.end; y++) sum += mask[y * w + x];
    colCovBand[x] = sum / (rowBand.end - rowBand.start);
  }
  const roughCols = longestRun(smooth(colCovBand, Math.max(3, w * 0.02)), 0, w, 0.35);
  if (!roughCols) return null;
  const colBand = tightenBand(colCovBand, roughCols, 0.45);
  if (!colBand) return null;
  return { x0: colBand.start, x1: colBand.end, y0: rowBand.start, y1: rowBand.end, mask };
}

/* ---------------- 2. 切格子 ---------------- */

function findSeparators(cov, from, to, lowThr, maxThickness) {
  const out = [];
  let start = -1;
  for (let i = from; i <= to; i++) {
    const low = i < to && cov[i] < lowThr;
    if (low && start < 0) start = i;
    if (!low && start >= 0) {
      const thickness = i - start;
      if (thickness <= maxThickness) out.push((start + i - 1) / 2);
      start = -1;
    }
  }
  return out;
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function locateGrid(data, w, h, board) {
  const { x0, x1, y0, y1, mask } = board;
  const { rowCov, colCov } = projections(mask, w, h, x0, y0, x1, y1);

  const roughPitch = Math.min(x1 - x0, y1 - y0) / 8;
  const maxThick = Math.max(3, Math.round(roughPitch * 0.35));

  let sepRows = findSeparators(rowCov, y0, y1, 0.12, maxThick);
  let sepCols = findSeparators(colCov, x0, x1, 0.12, maxThick);

  if (sepRows.length < 2 || sepCols.length < 2) return null;

  const pitchY = median(sepRows.slice(1).map((v, i) => v - sepRows[i]));
  const pitchX = median(sepCols.slice(1).map((v, i) => v - sepCols[i]));
  const rows = sepRows.length + 1;
  const cols = sepCols.length + 1;

  // 用分隔缝反推整张棋盘的左/上边界
  const firstCol = sepCols[0] - pitchX;
  const firstRow = sepRows[0] - pitchY;

  return {
    rows, cols, pitchX, pitchY,
    x0: firstCol, y0: firstRow, x1: firstCol + cols * pitchX, y1: firstRow + rows * pitchY,
  };
}

/* ---------------- 3. 读格子 ---------------- */

function readCells(data, w, h, grid) {
  const cells = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const x = Math.round(grid.x0 + c * grid.pitchX);
      const y = Math.round(grid.y0 + r * grid.pitchY);
      const cw = Math.round(grid.pitchX);
      const ch = Math.round(grid.pitchY);

      // 只取中间 64% 的区域，避开圆角、缝隙和描边
      const ix = Math.round(cw * 0.18);
      const iy = Math.round(ch * 0.18);
      const sx = Math.max(0, x + ix);
      const sy = Math.max(0, y + iy);
      const ex = Math.min(w, x + cw - ix);
      const ey = Math.min(h, y + ch - iy);

      const hist = new Map();
      let white = 0;
      let dark = 0;
      let total = 0;
      for (let yy = sy; yy < ey; yy++) {
        for (let xx = sx; xx < ex; xx++) {
          const p = (yy * w + xx) * 4;
          const R = data[p], G = data[p + 1], B = data[p + 2];
          const mx = Math.max(R, G, B);
          const mn = Math.min(R, G, B);
          total++;
          const isWhite = mx - mn < 18 && mx > 215;
          const isDark = mx < 90;
          if (isWhite) white++;
          if (isDark) dark++;
          if (!isWhite && !isDark) {
            const key = ((R >> 3) << 10) | ((G >> 3) << 5) | (B >> 3);
            hist.set(key, (hist.get(key) || 0) + 1);
          }
        }
      }
      let bestKey = 0;
      let bestCount = -1;
      for (const [k, v] of hist) {
        if (v > bestCount) { bestCount = v; bestKey = k; }
      }
      const color = [
        ((bestKey >> 10) & 31) * 8 + 4,
        ((bestKey >> 5) & 31) * 8 + 4,
        (bestKey & 31) * 8 + 4,
      ];

      const whiteRatio = total ? white / total : 0;
      const darkRatio = total ? dark / total : 0;

      let state = "empty";
      if (whiteRatio > 0.15) state = darkRatio > 0.02 ? "duck" : "x";

      cells.push({ r, c, x, y, w: cw, h: ch, color, whiteRatio, darkRatio, state });
    }
  }
  return cells;
}

/* ---------------- 4. 颜色聚类成色块 ---------------- */

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function clusterColors(cells, rows, cols, threshold = 22) {
  const THRESHOLD = threshold; // 同色块内 JPEG 抖动很小，不同色块之间差得很开
  const clusters = []; // {color, id}
  const assign = new Array(cells.length).fill(-1);

  for (let i = 0; i < cells.length; i++) {
    const col = cells[i].color;
    let found = -1;
    for (let k = 0; k < clusters.length; k++) {
      if (dist2(col, clusters[k].color) < THRESHOLD * THRESHOLD) { found = k; break; }
    }
    if (found < 0) {
      clusters.push({ color: col, id: String.fromCharCode(65 + (clusters.length % 26)) + (clusters.length >= 26 ? Math.floor(clusters.length / 26) : "") });
      found = clusters.length - 1;
    }
    // 慢慢把簇心往样本上靠，避免同色块因为压缩差异被拆成两簇
    const kc = clusters[found].color;
    clusters[found].color = [
      (kc[0] * 3 + col[0]) / 4,
      (kc[1] * 3 + col[1]) / 4,
      (kc[2] * 3 + col[2]) / 4,
    ];
    assign[i] = found;
  }

  const regions = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(clusters[assign[r * cols + c]].id);
    regions.push(row);
  }
  return regions;
}
