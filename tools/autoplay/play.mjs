/**
 * 大鹅数独自动过关：截图 → 识别 → 求解 → 双击放鹅 → 继续 → 下一关。
 *
 *   node tools/autoplay/play.mjs                  // 干跑：只打印这一轮要点哪里
 *   node tools/autoplay/play.mjs --live            // 真玩 1 关
 *   node tools/autoplay/play.mjs --live --levels 3 // 连玩 3 关
 *   node tools/autoplay/play.mjs --live --limit 1  // 只放 1 只鹅，用于验证
 *
 * 安全护栏：
 *   - 每次点击前确认该坐标最上层窗口就是游戏窗口，否则立刻中止；
 *   - 只发鼠标左键（格子用双击，按钮用单击），不发键盘；
 *   - 默认干跑，必须显式 --live；
 *   - 动作间隔 1.5s 起并带随机抖动，避免触发微信风控；
 *   - 点完立刻把光标送回原位，不长期占用鼠标。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const bin = join(here, "macctl");
let analysisPort = Number(process.env.PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const titleArg = argv.indexOf("--title");
const title = titleArg >= 0 ? argv[titleArg + 1] : "大鹅数独";
const delayArg = argv.indexOf("--delay");
const clickDelay = delayArg >= 0 ? Number(argv[delayArg + 1]) : 1500;
const limitArg = argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : Infinity;
const levelsArg = argv.indexOf("--levels");
const levels = levelsArg >= 0 ? Number(argv[levelsArg + 1]) : 1;

const NAV_WORDS = ["下一关", "继续", "开始", "再来一次"];
const STOP_WORDS = ["免费体力", "观看广告以恢复体力", "观看广告"];
const AD_WORDS = ["进入小游戏", "广告继续计时", "秒后可获得奖励", "已获得奖励"];
const isAdText = (text) => AD_WORDS.some((w) => text.includes(w));

function macctl(...args) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`macctl ${args.join(" ")} 失败：${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

function shot(windowId, file) {
  const r = spawnSync("screencapture", ["-x", "-o", "-l", String(windowId), file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`screencapture 失败：${r.stderr || r.status}`);
}

async function waitForServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("本地识别服务没起来");
}

/** 从网页启动时复用已运行的网页服务；CLI 启动时自起一个随机端口。 */
async function ensureAnalysisServer() {
  if (analysisPort) {
    try {
      const res = await fetch(`http://localhost:${analysisPort}/`);
      if (res.ok) return;
    } catch {}
  }
  analysisPort = 5200 + Math.floor(Math.random() * 3000);
  server = spawn(process.execPath, ["server.js"], {
    cwd: repo,
    env: { ...process.env, PORT: String(analysisPort) },
    stdio: "ignore",
  });
  await waitForServer(`http://localhost:${analysisPort}/`);
}

async function analyze(png, win) {
  await ensurePage();
  const b64 = readFileSync(png).toString("base64");
  let result;
  try {
    result = await page.evaluate(async (b64) => {
    const { analyze } = await import("/src/vision.js");
    const { solveAuto } = await import("/src/solver.js");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const r = await analyze(bmp);
    const strict = solveAuto({ regions: r.regions, placed: r.placed, banned: r.banned });
    let sol = strict.solutions[0] || null;
    let solutions = strict.solutions.length;
    let adjacency = strict.adjacency;
    let conflict = strict.conflict;
    let recovered = null;

    // 无解时：忽略 X 再算一次；只有解仍包含全部已放鹅才采用
    if (!sol && (r.placed.length || r.banned.length)) {
      const loose = solveAuto({ regions: r.regions, placed: r.placed, banned: [] });
      const cand = loose.solutions[0];
      if (cand) {
        const solSet = new Set(cand.map((c, row) => `${row},${c}`));
        if (r.placed.every(([row, col]) => solSet.has(`${row},${col}`))) {
          sol = cand;
          solutions = loose.solutions.length;
          adjacency = loose.adjacency;
          conflict = null;
          recovered = "ignore-banned";
        }
      }
    }

    return {
      rows: r.rows, cols: r.cols,
      image: { w: r.imageWidth, h: r.imageHeight },
      regions: new Set(r.regions.flat()).size,
      placed: r.placed,
      banned: r.banned,
      solutions,
      conflict,
      adjacency,
      recovered,
      cells: sol ? sol.map((c, row) => {
        const cell = r.layout[row * r.cols + c];
        return { row, col: c, x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 };
      }) : [],
    };
    }, b64);
  } catch (err) {
    page = null;   // 下一次 analyze 会重启浏览器
    throw err;
  }

  const sx = result.image.w / win.w;
  const sy = result.image.h / win.h;
  const placed = new Set(result.placed.map(([r, c]) => `${r},${c}`));
  result.targets = result.cells
    .filter((c) => !placed.has(`${c.row},${c.col}`))
    .map((c) => ({
      row: c.row,
      col: c.col,
      x: Math.round(win.x + c.x / sx),
      y: Math.round(win.y + c.y / sy),
    }));
  return result;
}

function lineCenter(line, ocr, win) {
  const sx = ocr.image.width / win.w;
  const sy = ocr.image.height / win.h;
  return {
    x: Math.round(win.x + (line.x + line.w / 2) / sx),
    y: Math.round(win.y + (line.y + line.h / 2) / sy),
  };
}

function closePoint(ocr, win) {
  const line = ocr.lines
    .filter((l) => /关闭|美闭|送闭|伏闭/.test(l.text))
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (line) return lineCenter(line, ocr, win);
  return {
    x: Math.round(win.x + win.w * 0.919),
    y: Math.round(win.y + win.h * 0.086),
  };
}

function findNav(ocr, win) {
  for (const word of NAV_WORDS) {
    const line = ocr.lines
      .filter((l) => l.text.includes(word))
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (!line) continue;
    return { word, ...lineCenter(line, ocr, win) };
  }
  return null;
}

function ensureHit(win, point) {
  const hit = macctl("hit", String(point.x), String(point.y)).hit;
  if (!hit || hit.id !== win.id) {
    throw new Error(`(${point.x}, ${point.y}) 被其他窗口挡住`);
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

let server;
let browser;
let page = null;
let stopping = false;

/** 识别浏览器挂了就重启；分析前都会调用。 */
async function ensurePage() {
  try {
    if (browser && page && !page.isClosed()) return page;
  } catch {}
  const had = !!browser;
  if (browser) {
    try {
      if (browser.isConnected()) await browser.close();
    } catch {}
  }
  browser = null;
  page = null;
  await ensureAnalysisServer();
  if (had) await sleep(300);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage();
  await page.goto(`http://localhost:${analysisPort}/`);
  if (had) console.log("识别浏览器已重启。");
  return page;
}

function shutdown() {
  stopping = true;
  try { server?.kill(); } catch {}
  if (browser) browser.close().catch(() => {}).finally(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/** 退出前先关掉识别服务和浏览器，避免留下后台进程。 */
async function exitSoon(code) {
  stopping = true;
  try { server?.kill(); } catch {}
  if (browser) await Promise.race([browser.close().catch(() => {}), sleep(1500)]);
  process.exit(code);
}

try {
  const win = macctl("windows").find((w) => w.title.includes(title));
  if (!win) throw new Error(`没找到标题包含「${title}」的窗口`);

  const dir = join(here, "runs", `play-${stamp()}`);
  mkdirSync(dir, { recursive: true });
  console.log(`窗口：${win.owner} / ${win.title}  ${win.w}x${win.h} @${win.x},${win.y}`);
  console.log(`输出：${dir}`);

  await ensurePage();

  let step = 0;
  const capture = () => {
    const png = join(dir, `step-${String(step++).padStart(2, "0")}.png`);
    shot(win.id, png);
    return png;
  };
  const ocrOf = (png) => {
    const ocr = macctl("ocr", png);
    writeFileSync(png.replace(/\.png$/, ".ocr.json"), JSON.stringify(ocr, null, 2));
    return ocr;
  };
  const textOf = (ocr) => ocr.lines.map((l) => l.text).join(" ");

  const restoreFocus = (saved) => {
    const pid = saved?.window?.pid || saved?.app?.pid;
    if (!pid || pid <= 0) return;
    if (saved?.window?.id === win.id && pid === win.pid) return;
    const windowTitle = saved?.window?.title;
    macctl("activate", String(pid), ...(windowTitle ? [windowTitle] : []));
  };

  const withGameFocus = (fn) => {
    const saved = macctl("front");
    macctl("raise", title);
    try {
      fn();
    } finally {
      restoreFocus(saved);
    }
  };

  /** 点击前记住前台 App 和光标；点完两者都还回去。 */
  const safeClick = (pt, dbl = false) => {
    const front = macctl("front");
    macctl("raise", title);
    try {
      ensureHit(win, pt);
      const before = macctl("cursor");
      if (dbl) macctl("dblclick", String(pt.x), String(pt.y));
      else macctl("click", String(pt.x), String(pt.y));
      const now = macctl("cursor");
      if (Math.abs(now.x - pt.x) < 8 && Math.abs(now.y - pt.y) < 8) {
        macctl("move", String(before.x), String(before.y));
      }
    } finally {
      restoreFocus(front);
    }
  };

  const click1 = (pt) => safeClick(pt, false);
  const click2 = (pt) => safeClick(pt, true);

  /** 白 X 要先单击清掉，再双击放鹅。 */
  const placeCell = async (pt, banned, label) => {
    if (banned.has(`${pt.row},${pt.col}`)) {
      console.log(`  ${label}：先单击清掉白 X（第 ${pt.row + 1} 行 第 ${pt.col + 1} 列）`);
      click1(pt);
      await sleep(400 + Math.round(Math.random() * 300));
    }
    click2(pt);
  };
  const wait = (min, span) => sleep(min + Math.round(Math.random() * span));

  /**
   * 体力弹窗 → 看一次广告 → 等倒计时 → 关闭 → 领取。
   * 只点「4倍获得」；「分享获得」的 0/3 是分享次数，永远不点；也绝不点「进入小游戏」。
   */
  async function watchAdAndClaim() {
    const popup = ocrOf(capture());
    const adBtn = popup.lines.find((l) => l.text.includes("4倍获得"));
    if (!adBtn) return { ok: false, why: "没找到「4倍获得」按钮" };
    let pt = lineCenter(adBtn, popup, win);
    await wait(1000, 2000);
    click1(pt);

    let adSeen = false;
    for (let attempt = 0; attempt < 2 && !adSeen; attempt++) {
      for (let i = 0; i < 30; i++) {
        await sleep(1500);
        const text = textOf(ocrOf(capture()));
        if (isAdText(text)) { adSeen = true; break; }
      }
      if (!adSeen && attempt === 0) {
        // 只有体力弹窗还在时才补一次双击；广告已经在加载时绝不点
        if (textOf(ocrOf(capture())).includes("免费体力")) click2(pt);
      }
    }
    if (!adSeen) {
      if (isAdText(textOf(ocrOf(capture())))) return { ok: true, why: "广告已打开，交给主循环处理" };
      return { ok: false, why: "广告没有打开" };
    }

    let rewarded = false;
    const adStart = Date.now();
    for (let i = 0; i < 70; i++) {
      const text = textOf(ocrOf(capture()));
      if (text.includes("已获得奖励")) { rewarded = true; break; }
      if (!isAdText(text)) break;
      if (Date.now() - adStart > 38000) break;
      await sleep(1200);
    }

    const closing = ocrOf(capture());
    const closingText = textOf(closing);
    if (isAdText(closingText)) {
      pt = closePoint(closing, win);
      await wait(3000, 5000);   // 看完广告后像真人一样停几秒再关
      click1(pt);
      await sleep(1500);
    }

    for (let i = 0; i < 6; i++) {
      const ocr = ocrOf(capture());
      const line = ocr.lines.find((l) => l.text.includes("确定"));
      if (line) {
        pt = lineCenter(line, ocr, win);
        await wait(1000, 2000);
        click1(pt);
        await sleep(1500);
        return { ok: true, rewarded };
      }
      await sleep(1200);
    }
    return { ok: rewarded, why: "奖励弹窗没出现" };
  }

  /* ---------- 干跑：只分析当前这一屏 ---------- */
  if (!live) {
    const png = capture();
    const ocr = ocrOf(png);
    const nav = findNav(ocr, win);
    if (nav) {
      console.log(`当前屏是「${nav.word}」按钮，直播时会点它。`);
      await exitSoon(0);
    }
    const result = await analyze(png, win);
    console.log(`棋盘：${result.rows}×${result.cols}  色块 ${result.regions}  已放 ${result.placed.length}  解 ${result.solutions}（${result.adjacency}）`);
    if (result.recovered) console.log("严格规则无解，已忽略 X 重新求解（盘面仍一致）。");
    if (result.conflict) console.log(`冲突：${result.conflict}`);
    const plan = result.targets.slice(0, limit);
    console.log(`\n计划双击 ${plan.length} 格：`);
    for (const t of plan) console.log(`  第 ${t.row + 1} 行 第 ${t.col + 1} 列  →  屏幕 (${t.x}, ${t.y})`);
    try {
      withGameFocus(() => { for (const t of plan) ensureHit(win, t); });
    } catch (err) {
      console.log(`✗ ${err.message}，干跑中止。`);
      await exitSoon(4);
    }
    console.log("\n✓ 所有点击点都落在游戏窗口最上层。干跑结束（没有点击）。");
    await exitSoon(0);
  }

  /* ---------- 直播循环 ---------- */
  let boardsPlayed = 0;
  let playedThisBoard = false;
  let advancing = false;
  let navClicks = 0;
  let adsUsed = 0;
  let pendingTargets = null;   // 这一关记下的解，漏点/被标成 X 时用它补点
  let recoverAttempts = 0;
  let stalls = 0;
  let adWaitSince = null;

  while (step < 400) {
    let png;
    let ocr = null;
    let nav = null;
    let result = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      png = capture();
      ocr = ocrOf(png);
      nav = findNav(ocr, win);
      if (nav) break;

      const seen = textOf(ocr);
      if (STOP_WORDS.some((w) => seen.includes(w))) break;
      if (isAdText(seen) || (seen.includes("广告") && seen.includes("关闭"))) break;
      if ((seen.includes("恭喜获得") || seen.includes("获得奖励")) && ocr.lines.some((l) => l.text.includes("确定"))) break;

      try {
        result = await analyze(png, win);
        break;
      } catch (err) {
        if (attempt === 5) {
          console.log(`连续 6 次都认不出这一屏：${err.message}`);
          console.log(`最后识别到的文字：${textOf(ocr) || "(无文字)"}`);
          console.log(`图片：${png}`);
          await exitSoon(2);
        }
        console.log(`画面还没稳定（${attempt + 1}/6）：${err.message}`);
        await sleep(1500);
      }
    }

    const blocked = ocr.lines.find((l) => STOP_WORDS.some((w) => l.text.includes(w)));
    if (blocked) {
      adsUsed++;
      console.log(`\n体力不足（${blocked.text}），第 ${adsUsed} 次看广告恢复…`);
      const ad = await watchAdAndClaim();
      console.log(ad.ok ? "广告完成，体力已领取，继续。" : `广告流程没走通：${ad.why}`);
      if (ad.ok) {
        await sleep(1500);
        continue;
      }
      console.log("已停止：不点分享、不再点广告。等体力自己恢复后再跑。");
      console.log(`截图：${png}`);
      await exitSoon(5);
    }

    const screenText = textOf(ocr);
    if (isAdText(screenText)) {
      if (!adWaitSince) adWaitSince = Date.now();
      const finished = screenText.includes("已获得奖励") || Date.now() - adWaitSince > 40000;
      if (finished) {
        console.log("广告已结束，点「关闭」");
        await wait(3000, 5000);
        click1(closePoint(ocr, win));
        await sleep(1500);
        adWaitSince = null;
      } else {
        console.log("广告播放中，等倒计时…");
        await sleep(2000);
      }
      navClicks = 0;
      continue;
    }
    adWaitSince = null;

    const rewardBtn = ocr.lines.find((l) => l.text.includes("确定"));
    const hasRewardTitle = ocr.lines.some((l) => l.text.includes("恭喜获得") || l.text.includes("获得奖励"));
    if (rewardBtn && hasRewardTitle) {
      console.log("领取奖励：点「确定」");
      await wait(600, 1200);
      click1(lineCenter(rewardBtn, ocr, win));
      await sleep(1500);
      navClicks = 0;
      continue;
    }

    if (nav) {
      if (++navClicks > 8) {
        console.log("连续 8 次都只是导航按钮，停下来看看。");
        break;
      }
      console.log(`点「${nav.word}」 (${nav.x}, ${nav.y})`);
      await wait(600, 1200);
      click1(nav);
      await sleep(1800 + Math.round(Math.random() * 500));
      pendingTargets = null;
      recoverAttempts = 0;
      stalls = 0;

      if (playedThisBoard) {
        boardsPlayed++;
        playedThisBoard = false;
        console.log(`—— 已完成 ${boardsPlayed}/${levels} 关 ——`);
        if (boardsPlayed >= levels) advancing = true;
      }
      continue;
    }

    if (advancing) {
      console.log("已到下一关棋盘，按 --levels 停止。");
      break;
    }
    navClicks = 0;

    if (result.recovered) console.log("严格规则无解，已忽略 X 重新求解（盘面仍一致）。");
    console.log(`棋盘 ${result.rows}×${result.cols}，已放 ${result.placed.length}，剩余 ${result.targets.length}`);
    const placedSet = new Set(result.placed.map(([r, c]) => `${r},${c}`));
    const bannedSet = new Set(result.banned.map(([r, c]) => `${r},${c}`));

    if (!result.targets.length) {
      const complete = result.placed.length >= result.rows;

      if (complete) {
        if (playedThisBoard) {
          boardsPlayed++;
          playedThisBoard = false;
          console.log(`—— 已完成 ${boardsPlayed}/${levels} 关 ——`);
          if (boardsPlayed >= levels) advancing = true;
          else await sleep(1500);
        } else {
          stalls++;
          console.log(`盘面已满 ${result.placed.length}/${result.rows}，等通关画面… (${stalls}/5)`);
          if (stalls > 5) {
            console.log("通关画面一直没出现，停下来。");
            break;
          }
          await sleep(1800);
        }
        continue;
      }

      // 没放满、也算不出解：多半是某格的双击退化成了单击 X，按记下的解补点
      const missing = pendingTargets
        ? pendingTargets.filter((t) => !placedSet.has(`${t.row},${t.col}`))
        : [];

      if (missing.length) {
        if (recoverAttempts++ >= 3) {
          console.log(`补点 ${recoverAttempts} 次仍未成功，停下来。`);
          break;
        }
        console.log(`盘面 ${result.placed.length}/${result.rows}，补点 ${missing.length} 格（含被标成 X 的）`);
        for (const [i, t] of missing.entries()) {
          await sleep(300 + Math.round(Math.random() * 600));
          await placeCell(t, bannedSet, `补点 ${i + 1}/${missing.length}`);
          playedThisBoard = true;
          console.log(`  补点 ${i + 1}/${missing.length}：第 ${t.row + 1} 行 第 ${t.col + 1} 列`);
          if (i < missing.length - 1) await sleep(clickDelay + Math.round(Math.random() * 400));
        }
        stalls = 0;
        await sleep(1800);
        continue;
      }

      stalls++;
      console.log(`已放 ${result.placed.length}/${result.rows}，但暂时没有可补的格子，等画面更新… (${stalls}/5)`);
      if (stalls > 5) {
        console.log("画面一直没更新，停下来。");
        break;
      }
      await sleep(1800);
      continue;
    }

    const plan = result.targets.slice(0, limit);
    pendingTargets = result.targets;
    stalls = 0;
    recoverAttempts = 0;
    for (const [i, t] of plan.entries()) {
      await sleep(300 + Math.round(Math.random() * 600));
      await placeCell(t, bannedSet, `双击 ${i + 1}/${plan.length}`);
      playedThisBoard = true;
      console.log(`  双击 ${i + 1}/${plan.length}：第 ${t.row + 1} 行 第 ${t.col + 1} 列`);
      if (i < plan.length - 1) await sleep(clickDelay + Math.round(Math.random() * 400));
    }
    if (limit < Infinity) {
      console.log("已按 --limit 点完，停止。");
      break;
    }
    await sleep(1800);
  }

  console.log(`\n结束。截图：${dir}`);
} catch (err) {
  if (!stopping) {
    console.error(err);
    process.exitCode = 1;
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
