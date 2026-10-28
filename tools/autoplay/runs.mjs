/**
 * 清理 tools/autoplay/runs 下的旧运行记录，避免截图越积越多。
 * 默认保留最近 3 次运行目录和最近 5 个 web 日志。
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runsDir = join(here, "runs");

export function pruneRuns({ keepDirs = 3, keepLogs = 5 } = {}) {
  if (!existsSync(runsDir)) return { dirs: 0, logs: 0 };

  let dirs = 0;
  let logs = 0;
  try {
    const entries = readdirSync(runsDir, { withFileTypes: true });

    const oldDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, time: statSync(join(runsDir, e.name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(keepDirs);
    for (const e of oldDirs) {
      try {
        rmSync(join(runsDir, e.name), { recursive: true, force: true });
        dirs++;
      } catch {}
    }

    const oldLogs = entries
      .filter((e) => e.isFile() && /^web-.*\.log$/.test(e.name))
      .map((e) => ({ name: e.name, time: statSync(join(runsDir, e.name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(keepLogs);
    for (const e of oldLogs) {
      try {
        rmSync(join(runsDir, e.name), { force: true });
        logs++;
      } catch {}
    }
  } catch {}

  return { dirs, logs };
}
