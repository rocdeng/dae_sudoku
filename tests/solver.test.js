import test from "node:test";
import assert from "node:assert/strict";
import { solve, solveAuto, probabilities } from "../src/solver.js";

// 第 10 关实测色块布局（A..H 八种颜色）
const REGIONS = [
  "A A A A A A A B",
  "A A A A A A C B",
  "D D D A A E C B",
  "D D D F A E E E",
  "D G G F E E E E",
  "D G G G E E E E",
  "G G G G G G E E",
  "H G G G G E E E",
].map((row) => row.split(" "));

const EXPECTED = [
  [0, 7],
  [1, 4],
  [2, 6],
  [3, 1],
  [4, 3],
  [5, 5],
  [6, 2],
  [7, 0],
];

const asSet = (sol) => sol.map((c, r) => `${r},${c}`).sort().join(" ");

test("只靠色块布局就能解出唯一解", () => {
  const { solutions, conflict } = solve({ regions: REGIONS, adjacency: "diag" });
  assert.equal(conflict, null);
  assert.equal(solutions.length, 1);
  assert.equal(asSet(solutions[0]), asSet(EXPECTED.map(([r, c]) => c)));
});

test("四方向相邻的规则会留下多解，说明斜角也必须算相邻", () => {
  const { solutions } = solve({ regions: REGIONS, adjacency: "orth" });
  assert.ok(solutions.length > 1, `期望多解，实际 ${solutions.length}`);
});

test("solveAuto 解得开时会选中含斜角的规则", () => {
  const res = solveAuto({ regions: REGIONS });
  assert.equal(res.adjacency, "diag");
  assert.equal(res.solutions.length, 1);
});

test("已放的鹅作为约束不改变结果", () => {
  const placed = [
    [0, 7],
    [2, 6],
    [7, 0],
  ];
  const { solutions } = solve({ regions: REGIONS, placed, adjacency: "diag" });
  assert.equal(solutions.length, 1);
  assert.equal(solutions[0][0], 7);
  assert.equal(solutions[0][2], 6);
  assert.equal(solutions[0][7], 0);
});

test("X 的正确标记不影响唯一解", () => {
  const banned = [];
  const bannedGrid = [
    "XXXXXXX.",
    "X..X.XXX",
    "XXXXXX.X",
    "X....XXX",
    "X.....XX",
    "X..X..XX",
    "XX.X..XX",
    ".XXXXXXX",
  ];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (bannedGrid[r][c] === "X") banned.push([r, c]);
    }
  }
  const { solutions } = solve({ regions: REGIONS, banned, adjacency: "diag" });
  assert.equal(solutions.length, 1);
});

test("玩家把 X 标错时会出现矛盾或者解不含该格", () => {
  // 在正确答案 (0,7) 上标 X，应当没有解
  const { solutions } = solve({ regions: REGIONS, banned: [[0, 7]] });
  assert.equal(solutions.length, 0);
});

test("已放的鹅互相冲突会被识别出来", () => {
  const { conflict } = solve({ regions: REGIONS, placed: [[0, 0], [1, 1]] });
  assert.ok(conflict, "应该报告冲突");
});

test("概率：唯一解时答案格概率为 1", () => {
  const { solutions } = solve({ regions: REGIONS });
  const { prob, guaranteed } = probabilities(8, solutions);
  for (const [r, c] of EXPECTED) {
    assert.equal(prob[r][c], 1);
    assert.equal(guaranteed[r][c], true);
  }
  assert.equal(prob[0][0], 0);
});
