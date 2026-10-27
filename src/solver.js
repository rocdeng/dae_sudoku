/**
 * 谜题求解器
 *
 * 规则（从游戏内的三条说明反推得到）：
 *   1. 每种颜色（色块区域）里恰好 1 只鹅
 *   2. 每行、每列各恰好 1 只鹅
 *   3. 两只鹅不能相邻（含斜角）
 *
 * 坐标一律用 [行, 列]，从 0 开始。
 */

const cellKey = (r, c) => r + "," + c;

/**
 * @param {object} opts
 * @param {string[][]} opts.regions  regions[r][c] = 色块编号
 * @param {Array<[number,number]>} [opts.placed] 已经放好的鹅
 * @param {Array<[number,number]>} [opts.banned] 玩家已经标了 X 的格子
 * @param {"diag"|"orth"} [opts.adjacency] diag = 斜角也算相邻（游戏实际规则）
 * @param {number} [opts.limit] 最多枚举多少个解
 * @returns {{solutions: number[][], truncated: boolean, conflict: string|null}}
 */
export function solve({ regions, placed = [], banned = [], adjacency = "diag", limit = 20000 }) {
  const n = regions.length;
  const bannedSet = new Set(banned.map(([r, c]) => cellKey(r, c)));

  // 已放的鹅自己要先合法
  const placedByRow = new Map();
  const seenCols = new Set();
  const seenRegions = new Set();
  for (const [r, c] of placed) {
    if (r < 0 || c < 0 || r >= n || c >= n) continue;
    if (placedByRow.has(r)) return { solutions: [], truncated: false, conflict: "同一行里有两只已经放好的鹅" };
    if (seenCols.has(c)) return { solutions: [], truncated: false, conflict: "同一列里有两只已经放好的鹅" };
    const reg = String(regions[r][c]);
    if (seenRegions.has(reg)) return { solutions: [], truncated: false, conflict: "同一个色块里有两只已经放好的鹅" };
    placedByRow.set(r, c);
    seenCols.add(c);
    seenRegions.add(reg);
  }
  const placedList = [...placedByRow].map(([r, c]) => [r, c]);
  for (let i = 0; i < placedList.length; i++) {
    for (let j = i + 1; j < placedList.length; j++) {
      if (isAdjacent(placedList[i][0], placedList[i][1], placedList[j][0], placedList[j][1], adjacency)) {
        return { solutions: [], truncated: false, conflict: "两只已经放好的鹅是相邻的" };
      }
    }
  }

  const regIndex = new Map();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const id = String(regions[r][c]);
      if (!regIndex.has(id)) regIndex.set(id, regIndex.size);
    }
  }
  const regOf = (r, c) => regIndex.get(String(regions[r][c]));
  const regCount = regIndex.size;

  const solutions = [];
  let truncated = false;
  const cols = new Array(n).fill(-1);
  const usedCols = new Uint8Array(n);
  const usedRegs = new Uint8Array(regCount);

  function tryCol(r, c, prevCol) {
    if (bannedSet.has(cellKey(r, c))) return false;
    const reg = regOf(r, c);
    if (usedCols[c] || usedRegs[reg]) return false;
    // 只跟上一行比就够了：更上面的行不可能相邻
    if (prevCol >= 0) {
      const d = Math.abs(prevCol - c);
      if (adjacency === "diag" ? d <= 1 : d === 0) return false;
    }
    return true;
  }

  function dfs(r, prevCol) {
    if (solutions.length >= limit) {
      truncated = true;
      return;
    }
    if (r === n) {
      solutions.push(cols.slice());
      return;
    }
    const fixed = placedByRow.has(r) ? placedByRow.get(r) : -1;
    const candidates = fixed >= 0 ? [fixed] : Array.from({ length: n }, (_, i) => i);
    for (const c of candidates) {
      if (!tryCol(r, c, prevCol)) continue;
      const reg = regOf(r, c);
      const hadCol = usedCols[c];
      const hadReg = usedRegs[reg];
      usedCols[c] = 1;
      usedRegs[reg] = 1;
      cols[r] = c;
      dfs(r + 1, c);
      usedCols[c] = hadCol;
      usedRegs[reg] = hadReg;
      cols[r] = -1;
    }
  }

  dfs(0, -1);
  return { solutions, truncated, conflict: null };
}

function isAdjacent(r1, c1, r2, c2, mode) {
  const dr = Math.abs(r1 - r2);
  const dc = Math.abs(c1 - c2);
  if (mode === "orth") return dr + dc === 1;
  return dr <= 1 && dc <= 1 && dr + dc > 0;
}

/**
 * 先按「含斜角相邻」求解；解不出来再退回「只算四方向相邻」。
 */
export function solveAuto(opts) {
  const diag = solve({ ...opts, adjacency: "diag" });
  if (diag.conflict || diag.solutions.length > 0) return { ...diag, adjacency: "diag" };
  const orth = solve({ ...opts, adjacency: "orth" });
  return { ...orth, adjacency: "orth" };
}

/**
 * 把解集合折算成「每格是鹅的概率」。
 */
export function probabilities(n, solutions) {
  const prob = Array.from({ length: n }, () => new Array(n).fill(0));
  const guaranteed = Array.from({ length: n }, () => new Array(n).fill(false));
  const possible = Array.from({ length: n }, () => new Array(n).fill(false));
  if (solutions.length === 0) return { prob, guaranteed, possible };
  for (const sol of solutions) {
    for (let r = 0; r < n; r++) prob[r][sol[r]] += 1;
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const p = prob[r][c] / solutions.length;
      prob[r][c] = p;
      guaranteed[r][c] = p === 1;
      possible[r][c] = p > 0;
    }
  }
  return { prob, guaranteed, possible };
}
