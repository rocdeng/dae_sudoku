import { analyze, toBitmap } from "./vision.js";
import { solveAuto, probabilities } from "./solver.js";

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $("dropzone"),
  dropTitle: document.querySelector("#dropzone .drop-title"),
  dropHint: document.querySelector("#dropzone .drop-hint"),
  btnPaste: $("btn-paste"),
  fileInput: $("file-input"),
  boardWrap: $("board-wrap"),
  board: $("board"),
  screenshot: $("screenshot"),
  markers: $("markers"),
  caption: $("caption"),
  statGrid: $("stat-grid"),
  statRegions: $("stat-regions"),
  statPlaced: $("stat-placed"),
  statSolutions: $("stat-solutions"),
  note: $("note"),
  actions: $("actions"),
  btnStep: $("btn-step"),
  btnAll: $("btn-all"),
  btnReset: $("btn-reset"),
  btnPick: $("btn-pick"),
  answerCard: $("answer-card"),
  answers: $("answers"),
  toast: $("toast"),
  toggleFull: $("toggle-full"),
};

const state = {
  mode: "auto",
  result: null,
  solved: null,
  answer: [],       // [{r, c, state: "known"|"todo"}]
  step: 0,
  objectUrl: null,
  view: null,       // 当前显示区域 {x, y, w, h}，原图像素坐标
  fullView: null,
};

const isTouch = matchMedia("(pointer: coarse)").matches;
const copy = isTouch
  ? { title: "点这里选择截图", hint: "从相册选图，或拍照后上传", compact: "点击换图" }
  : { title: "Ctrl + V 粘贴截图", hint: "也可以把图片拖进来，或者点这里选文件", compact: "Ctrl + V 继续粘贴 · 点击换图" };
const canPaste = typeof navigator.clipboard?.read === "function";

els.dropTitle.textContent = copy.title;
els.dropHint.textContent = copy.hint;
els.btnPaste.hidden = !canPaste;

/* ---------------- 交互 ---------------- */

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-selected", String(b === btn));
    });
    state.mode = btn.dataset.mode;
    state.step = 0;
    renderMarkers({ animate: true });
    renderAnswers();
  });
});

els.dropzone.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("keydown", (e) => {
  if (e.target !== els.dropzone) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  if (file) handleImage(file);
  els.fileInput.value = "";
});
els.btnPaste.addEventListener("click", (e) => {
  e.stopPropagation();
  pasteFromClipboard();
});

["dragenter", "dragover"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("is-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("is-over");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) handleImage(file);
});

document.addEventListener("paste", (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const item = items.find((i) => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (file) handleImage(file);
});

els.toggleFull.addEventListener("change", () => {
  state.view = els.toggleFull.checked ? state.fullView : boardView(state.result);
  applyView();
  renderMarkers({ animate: false });
});

els.btnPick.addEventListener("click", () => els.fileInput.click());
els.btnReset.addEventListener("click", () => {
  state.step = 0;
  renderMarkers({ animate: true });
  renderAnswers();
});
els.btnAll.addEventListener("click", () => {
  state.step = Number.MAX_SAFE_INTEGER;
  renderMarkers({ animate: true });
  renderAnswers();
});
els.btnStep.addEventListener("click", () => {
  const todo = state.answer.filter((a) => a.state !== "known");
  if (state.step >= todo.length) return;
  state.step += 1;
  renderMarkers({ animate: false });
  renderAnswers();
  const justPlaced = todo[state.step - 1];
  if (justPlaced) blinkAt(justPlaced.r, justPlaced.c);
  // 全部推完时给个回执
  if (state.step >= todo.length) toast("这一关推完啦，按提示点完就过关了。");
});

window.addEventListener("resize", () => renderMarkers({ animate: false }));

/* ---------------- 主流程 ---------------- */

async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      await handleImage(await item.getType(type));
      return;
    }
    toast("剪贴板里没有图片，试试选择图片。");
  } catch (err) {
    console.warn(err);
    toast("没拿到剪贴板权限，帮你打开选图。");
    els.fileInput.click();
  }
}

async function handleImage(blob) {
  try {
    const bitmap = await toBitmap(blob);
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(blob);
    els.screenshot.src = state.objectUrl;
    await new Promise((res) => {
      if (els.screenshot.complete) res();
      else els.screenshot.onload = res;
    });

    const result = await analyze(bitmap);
    const solved = solveWithFallback(result);

    state.result = result;
    state.solved = solved;
    state.answer = buildAnswer(result, solved);
    state.step = 0;
    state.fullView = { x: 0, y: 0, w: result.imageWidth, h: result.imageHeight };
    state.view = boardView(result);
    els.toggleFull.checked = false;
    applyView();

    els.dropzone.classList.add("is-compact");
    els.dropTitle.textContent = copy.compact;
    els.boardWrap.hidden = false;
    els.actions.hidden = false;
    els.answerCard.hidden = false;

    updateStats(result, solved);
    renderMarkers({ animate: true });
    renderAnswers();
    els.boardWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    console.error(err);
    toast(err?.message || "这张图没认出来。");
  }
}

function solveWithFallback(result) {
  const attempts = [
    { placed: result.placed, banned: result.banned, note: null },
    {
      placed: result.placed,
      banned: [],
      note: result.banned.length
        ? "你标的一部分 X 和规则对不上，已经忽略 X 重算。"
        : null,
    },
    {
      placed: [],
      banned: [],
      note: "已放的鹅和规则有冲突，先只按色块布局推算。",
    },
  ];

  for (const attempt of attempts) {
    const res = solveAuto({ regions: result.regions, placed: attempt.placed, banned: attempt.banned });
    if (!res.conflict && res.solutions.length > 0) {
      return { ...res, note: attempt.note, fallback: attempts.indexOf(attempt) };
    }
  }
  return { solutions: [], conflict: "这些色块怎么摆都拼不出合法答案", note: null, adjacency: "diag" };
}

function buildAnswer(result, solved) {
  const n = result.rows;
  const knownCells = new Set(result.placed.map(([r, c]) => `${r},${c}`));

  if (solved.solutions.length === 1) {
    const sol = solved.solutions[0];
    const list = [];
    for (let r = 0; r < n; r++) {
      list.push({ r, c: sol[r], state: knownCells.has(`${r},${sol[r]}`) ? "known" : "todo" });
    }
    return list;
  }

  // 多解时只标"每格必为鹅"的格子
  const { guaranteed } = probabilities(n, solved.solutions);
  const list = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < result.cols; c++) {
      if (guaranteed[r][c]) list.push({ r, c, state: knownCells.has(`${r},${c}`) ? "known" : "todo" });
    }
  }
  return list;
}

/* ---------------- 渲染 ---------------- */

/** 棋盘（含一点边距）在原图里占的范围，默认只看这一块 */
function boardView(result) {
  if (!result) return null;
  const cells = result.layout;
  const x0 = Math.min(...cells.map((c) => c.x));
  const y0 = Math.min(...cells.map((c) => c.y));
  const x1 = Math.max(...cells.map((c) => c.x + c.w));
  const y1 = Math.max(...cells.map((c) => c.y + c.h));
  const padX = (x1 - x0) * 0.06;
  const padY = (y1 - y0) * 0.06;
  const x = Math.max(0, x0 - padX);
  const y = Math.max(0, y0 - padY);
  const w = Math.min(result.imageWidth, x1 + padX) - x;
  const h = Math.min(result.imageHeight, y1 + padY) - y;
  return { x, y, w, h };
}

/** 把显示区域套到 DOM 上：截图放大并对齐，只露出 view 那一块 */
function applyView() {
  const view = state.view;
  const result = state.result;
  if (!view || !result) return;
  els.board.style.aspectRatio = `${view.w} / ${view.h}`;
  els.board.style.width = `min(100%, calc(74vh * ${view.w / view.h}))`;
  els.screenshot.style.width = `${(result.imageWidth / view.w) * 100}%`;
  els.screenshot.style.height = `${(result.imageHeight / view.h) * 100}%`;
  els.screenshot.style.left = `${(-view.x / view.w) * 100}%`;
  els.screenshot.style.top = `${(-view.y / view.h) * 100}%`;
}

function updateStats(result, solved) {
  const n = result.rows;
  els.statGrid.textContent = `${result.rows} × ${result.cols}`;
  els.statRegions.textContent = String(new Set(result.regions.flat()).size);
  els.statPlaced.textContent = `${result.placed.length}`;
  els.statSolutions.textContent = solved.solutions.length ? String(solved.solutions.length) : "0";

  els.caption.textContent = `${result.rows}×${result.cols} 棋盘 · 需要放 ${n} 只鹅 · 截图里已放 ${result.placed.length} 只`;

  const notes = [];
  els.note.className = "note";

  if (solved.solutions.length === 0) {
    notes.push(solved.conflict || "算不出解，可能是截图裁到了棋盘、或者色块没认全。");
    els.note.classList.add("is-error");
  } else if (solved.solutions.length === 1) {
    notes.push(solved.fallback > 0 ? solved.note || "已修正后再求解。" : "唯一解，直接照着摆就行。");
    els.note.classList.add("is-good");
  } else {
    notes.push(`有 ${solved.solutions.length} 种合法解，先标出每格必是鹅的位置。`);
  }

  if (result.banned.length) {
    const dupX = result.banned.filter(([r, c]) => solved.solutions.length === 1 && solved.solutions[0][r] === c);
    if (dupX.length) {
      const pos = dupX.map(([r, c]) => `第${r + 1}行第${c + 1}列`).join("、");
      notes.push(`${pos} 你标了 X，但那格应该是鹅。`);
      els.note.classList.add("is-warn");
    }
  }

  if (solved.adjacency === "orth") {
    notes.push("这局按「不含斜角」的相邻规则才算得通。");
  }

  els.note.textContent = notes.join(" ");
}

function renderMarkers({ animate }) {
  const result = state.result;
  els.markers.innerHTML = "";
  if (!result) return;

  const visible = markersToShow();
  const view = state.view || { x: 0, y: 0, w: result.imageWidth, h: result.imageHeight };

  visible.forEach((item, index) => {
    const cell = result.layout[item.r * result.cols + item.c];
    if (!cell) return;
    const el = document.createElement("div");
    el.className = "goose" + (item.kind === "known" ? " is-known" : "");
    el.dataset.r = item.r;
    el.dataset.c = item.c;
    const pad = 0.08;
    el.style.left = `${((cell.x + cell.w * pad - view.x) / view.w) * 100}%`;
    el.style.top = `${((cell.y + cell.h * pad - view.y) / view.h) * 100}%`;
    el.style.width = `${((cell.w * (1 - pad * 2)) / view.w) * 100}%`;
    el.style.height = `${((cell.h * (1 - pad * 2)) / view.h) * 100}%`;

    const img = document.createElement("img");
    img.src = "assets/goose.png";
    img.alt = "";
    el.appendChild(img);

    if (animate && item.kind !== "known") {
      el.classList.add("is-new");
      el.style.animationDelay = `${index * 70}ms`;
    }
    els.markers.appendChild(el);
  });
}

/** 当前模式下该显示哪些标记 */
function markersToShow() {
  if (!state.answer.length) return [];

  // 截图里已经放好的鹅，始终淡淡地显示
  const known = state.answer
    .filter((a) => a.state === "known")
    .map((a) => ({ r: a.r, c: a.c, kind: "known" }));

  const todo = state.answer.filter((a) => a.state !== "known");

  if (state.mode === "auto") {
    return [...known, ...todo.map((a) => ({ r: a.r, c: a.c, kind: "answer" }))];
  }
  const showCount = Math.min(state.step, todo.length);
  return [...known, ...todo.slice(0, showCount).map((a) => ({ r: a.r, c: a.c, kind: "answer" }))];
}

function blinkAt(r, c) {
  const el = els.markers.querySelector(`.goose[data-r="${r}"][data-c="${c}"]`);
  if (!el) return;
  el.classList.remove("is-blink");
  void el.offsetWidth;
  el.classList.add("is-blink");
  el.addEventListener("animationend", () => el.classList.remove("is-blink"), { once: true });
}

function renderAnswers() {
  const result = state.result;
  if (!result) return;
  const todo = state.answer.filter((a) => a.state !== "known");

  els.answers.innerHTML = "";
  state.answer.forEach((a) => {
    const li = document.createElement("li");
    if (a.state === "known") li.classList.add("is-known");

    const todoIndex = todo.indexOf(a);
    if (a.state !== "known") {
      if (state.mode === "auto" || todoIndex < state.step) li.classList.add("is-done");
      if (state.mode === "step" && todoIndex === state.step) li.classList.add("is-next");
    }

    const dot = document.createElement("span");
    dot.className = "dot";
    li.appendChild(dot);

    const label = document.createElement("span");
    label.textContent = `第 ${a.r + 1} 行 · 第 ${a.c + 1} 列`;
    li.appendChild(label);

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = a.state === "known" ? "已放" : state.mode === "step" && todoIndex === state.step ? "下一只" : "";
    li.appendChild(tag);
    els.answers.appendChild(li);
  });

  const stepMode = state.mode === "step";
  els.btnStep.hidden = !stepMode;
  els.btnAll.hidden = !stepMode;
  els.btnStep.disabled = state.step >= todo.length;
  els.btnStep.textContent = state.step >= todo.length
    ? `推完了 ${todo.length}/${todo.length}`
    : `下一步 (${state.step}/${todo.length})`;
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3600);
}
