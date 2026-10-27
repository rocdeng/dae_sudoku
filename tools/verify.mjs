/**
 * 用本机 Edge 跑一遍真实页面，把识别+求解结果打出来。
 * 用法: node tools/verify.mjs [图片路径]
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const image = process.argv[2] || "tests/fixtures/level10.jfif";
const port = 5199;

const server = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await wait(600);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(`http://localhost:${port}/`);
  await page.setInputFiles("#file-input", image);
  await page.waitForSelector(".goose", { timeout: 8000 }).catch(() => {});
  await wait(1600);

  const data = await page.evaluate(() => ({
    stats: [...document.querySelectorAll(".stats dd")].map((d) => d.textContent),
    note: document.getElementById("note")?.textContent,
    caption: document.getElementById("caption")?.textContent,
    markers: [...document.querySelectorAll(".goose")].map((g) => ({
      r: +g.dataset.r, c: +g.dataset.c,
      left: g.style.left, top: g.style.top, w: g.style.width,
    })),
    answers: [...document.querySelectorAll(".answers li")].map((li) => li.textContent.replace(/\s+/g, " ").trim()),
    mode: document.querySelector(".mode-btn.is-active")?.textContent,
    layout: (() => {
      const img = document.getElementById("board").getBoundingClientRect();
      const ghosts = [...document.querySelectorAll(".goose")].map((g) => {
        const r = g.getBoundingClientRect();
        return {
          insideX: r.left >= img.left - 1 && r.right <= img.right + 1,
          insideY: r.top >= img.top - 1 && r.bottom <= img.bottom + 1,
          size: [Math.round(r.width), Math.round(r.height)],
        };
      });
      return {
        viewport: [innerWidth, innerHeight],
        imageDisplayed: [Math.round(img.width), Math.round(img.height)],
        allMarkersInside: ghosts.every((g) => g.insideX && g.insideY),
        markerSizes: [...new Set(ghosts.map((g) => g.size.join("x")))],
      };
    })(),
  }));

  // 切到"推下一步"，点两次，看看标记数量是否按步增长
  let stepMode = null;
  if (await page.locator(".goose").count()) {
    await page.click('.mode-btn[data-mode="step"]');
    const before = await page.locator(".goose").count();
    await page.click("#btn-step");
    await wait(120);
    const afterOne = await page.locator(".goose").count();
    const blinking = await page.locator(".goose.is-blink").count();
    await page.click("#btn-step");
    await wait(120);
    const afterTwo = await page.locator(".goose").count();
    stepMode = { before, afterOne, afterTwo, blinking };
  }

  await page.screenshot({ path: "tools/shot.png", fullPage: false });
  await browser.close();

  console.log(JSON.stringify({
    ...data,
    stepMode,
    errors,
  }, null, 2));
} finally {
  server.kill();
}
