import { createServer } from "node:http";
import { mkdirSync, appendFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname);
const port = Number(process.env.PORT) || 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/* ---------------- 自动玩 ---------------- */

const MAX_LINES = 300;
let autoplay = { child: null, levels: 0, startedAt: null, exitCode: null, lines: [], logFile: null };

const isLoopback = (req) => {
  const addr = req.socket.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
};

const sendJSON = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
};

function readJSON(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("请求不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function autoplayStatus() {
  return {
    running: !!autoplay.child,
    levels: autoplay.levels,
    startedAt: autoplay.startedAt,
    exitCode: autoplay.exitCode,
    logFile: autoplay.logFile,
    lines: autoplay.lines.slice(-80),
  };
}

function pushLine(text) {
  for (const line of text.split("\n")) {
    if (line === "") continue;
    autoplay.lines.push(line);
    if (autoplay.lines.length > MAX_LINES) autoplay.lines.shift();
    if (autoplay.logFile) appendFileSync(autoplay.logFile, line + "\n");
  }
}

function startAutoplay(levels, dryRun) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(root, "tools/autoplay/runs", `web-${stamp}.log`);
  mkdirSync(dirname(logFile), { recursive: true });

  const args = ["tools/autoplay/play.mjs", "--levels", String(levels)];
  if (!dryRun) args.push("--live");

  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  autoplay = { child, levels, startedAt: Date.now(), exitCode: null, lines: [], logFile };
  pushLine(`[web] 启动：node ${args.join(" ")}`);

  const onData = (buf) => pushLine(buf.toString());
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code, signal) => {
    pushLine(`[web] 结束：${signal ? `signal ${signal}` : `exit ${code}`}`);
    autoplay.child = null;
    autoplay.exitCode = signal ? -1 : code;
  });

  return child;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (path.startsWith("/api/autoplay/")) {
      if (!isLoopback(req)) return sendJSON(res, 403, { error: "自动玩只允许本机访问" });

      if (path === "/api/autoplay/status" && req.method === "GET") {
        return sendJSON(res, 200, autoplayStatus());
      }

      if (path === "/api/autoplay/start" && req.method === "POST") {
        if (req.headers["content-type"] !== "application/json") {
          return sendJSON(res, 415, { error: "需要 JSON 请求" });
        }
        if (autoplay.child) return sendJSON(res, 409, { error: "已经在跑了" });
        const body = await readJSON(req);
        const levels = Math.max(1, Math.min(20, Number(body.levels) || 1));
        startAutoplay(levels, Boolean(body.dryRun));
        return sendJSON(res, 200, { ok: true, levels, dryRun: Boolean(body.dryRun) });
      }

      if (path === "/api/autoplay/stop" && req.method === "POST") {
        if (!autoplay.child) return sendJSON(res, 200, { ok: true });
        const child = autoplay.child;
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, 6000);
        return sendJSON(res, 200, { ok: true });
      }

      return sendJSON(res, 404, { error: "接口不存在" });
    }

    let filePath = decodeURIComponent(path);
    if (filePath === "/") filePath = "/index.html";
    const file = normalize(join(root, filePath));
    if (!file.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFileAsync(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
});

server.listen(port, () => {
  console.log(`找鹅助手跑起来了： http://localhost:${port}`);
});
