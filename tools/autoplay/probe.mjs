/**
 * M1 探测：列出窗口 / 截取指定窗口 / OCR 识别文字。
 *
 *   node tools/autoplay/probe.mjs windows
 *   node tools/autoplay/probe.mjs shot <窗口id>
 *   node tools/autoplay/probe.mjs shot <窗口id> --watch 60   // 连续截 60 秒
 *
 * 截图和识别结果保存在 tools/autoplay/runs/ 下。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pruneRuns } from "./runs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "macctl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} 失败：${r.stderr || r.stdout || r.status}`);
  return r.stdout;
}

const macctl = (...args) => JSON.parse(run(bin, args));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "windows") {
  const list = macctl("windows");
  for (const w of list.sort((a, b) => a.owner.localeCompare(b.owner))) {
    console.log(`${w.id}\t${w.owner}\t${w.title || "(无标题)"}\t${Math.round(w.w)}x${Math.round(w.h)} @${Math.round(w.x)},${Math.round(w.y)}`);
  }
} else if (cmd === "shot") {
  const id = Number(rest[0]);
  if (!Number.isInteger(id)) throw new Error("用法：probe.mjs shot <窗口id> [--watch 秒数]");
  const win = macctl("windows").find((w) => w.id === id);
  if (!win) throw new Error(`找不到窗口 ${id}`);

  const watchIndex = rest.indexOf("--watch");
  const seconds = watchIndex >= 0 ? Number(rest[watchIndex + 1] || 30) : 0;
  const dir = join(here, "runs", `probe-${stamp()}`);
  mkdirSync(dir, { recursive: true });
  pruneRuns({ keepDirs: 3, keepLogs: 5 });

  console.log(`窗口：${win.owner} / ${win.title || "(无标题)"}  ${win.w}x${win.h} @${win.x},${win.y}`);
  console.log(`输出：${dir}`);

  const started = Date.now();
  let i = 0;
  do {
    const name = `frame-${String(i).padStart(2, "0")}`;
    const png = join(dir, `${name}.png`);
    run("screencapture", ["-x", "-o", "-l", String(id), png]);
    const ocr = macctl("ocr", png);
    const frame = { at: new Date().toISOString(), window: win, image: ocr.image, lines: ocr.lines };
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(frame, null, 2));

    const texts = ocr.lines.map((l) => l.text).join(" | ");
    console.log(`[${i}] ${ocr.image.width}x${ocr.image.height}  ${texts || "(无文字)"}`);
    i++;
    if (seconds) await sleep(1500);
  } while (seconds && Date.now() - started < seconds * 1000);
} else {
  console.log("用法：");
  console.log("  node tools/autoplay/probe.mjs windows");
  console.log("  node tools/autoplay/probe.mjs shot <窗口id> [--watch 秒数]");
  process.exit(1);
}
