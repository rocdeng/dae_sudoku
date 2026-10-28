# Edge 图标在 Dock 里"跳一下"的问题：调查与修复

> 结论先行：**不是 Edge 自己在后台启动，是 `tools/autoplay/play.mjs` 和 `tools/verify.mjs` 用 Playwright 以 `channel: "msedge"` 拉起本机 Edge 导致的。**

---

## 一、现象

- macOS Dock 里 Microsoft Edge 图标每隔一阵就"跳一下"（启动动画）
- 但 Edge 窗口从未出现过，App 也没真正打开
- 一次 autoplay 运行期间可以连续跳十几次

---

## 二、根因

两个文件把 Edge 当成 Playwright 的浏览器：

| 文件 | 行号 | 代码 |
|---|---|---|
| `tools/autoplay/play.mjs` | 212 | `browser = await chromium.launch({ channel: "msedge", headless: true });` |
| `tools/verify.mjs` | 20 | `const browser = await chromium.launch({ channel: "msedge", headless: true });` |

**为什么会跳**：`channel: "msedge"` 启动的是 `/Applications/Microsoft Edge.app` 这个真实的 GUI 二进制。`headless: true` 只是不开窗口，进程启动时仍会向 LaunchServices 注册为前台 App，于是 Dock 播一次启动动画；脚本用完 `browser.close()`，图标随即消失。表现出来就是"跳一下但没启动"。

**为什么会反复跳**：`play.mjs` 的 `ensurePage()`（198-217 行）带崩溃自愈逻辑——页面一挂就重新 `chromium.launch()`：

```js
async function ensurePage() {
  try {
    if (browser && page && !page.isClosed()) return page;
  } catch {}
  ...
  browser = await chromium.launch({ channel: "msedge", headless: true });  // ← 每次重试 = 一次 Dock 跳动
```

历史运行日志里确实有 `browser.newPage: Target page, context or browser has been closed`，所以一次运行会触发多次重启。

---

## 三、证据

| 证据 | 具体内容 |
|---|---|
| 系统启动记录 | `2026-10-28 07:49:42` ~ `07:54:56`，`com.microsoft.edgemac` 被拉起约 **20 次**，稳态间隔约 30 秒 |
| 进程行为 | 每次启动后几百毫秒内退出，无窗口，`launchservicesd` 记录 `QUITTING: foreground=0 wasFront=0` |
| 归因 | 24 小时内 1415 条相关归因记录，`responsible` 全部是 `sh.kero`（Kero 终端里的子进程） |
| 时间精确对齐 | 上述 5 分钟窗口 == 运行目录 `tools/autoplay/runs/play-2026-10-27T23-49-42-493Z/`（目录名用 UTC，= 本地 10-28 07:49:42）。`step-00.png` 生成于 `07:49:43`，目录最后修改 `07:54:55` |
| 全盘搜索 | `~/Documents/Coding`、`~/Downloads` 中真正传 `channel: "msedge"` 的代码**只有上面两处**，其余命中都是 Playwright 库自身文件 |

---

## 四、修复方案

### 方案 A（推荐）：改用 Playwright 自带 Chromium

自带 Chromium 的 headless 模式跑的是 `chrome-headless-shell`，它不是 GUI App，**完全不会注册 Dock 图标**。

**前置检查**：项目依赖的是 `playwright-core`（`package.json:12`），它不自带浏览器；`~/Library/Caches/ms-playwright` 目前是空目录。

1. 安装浏览器内核（`~/node_modules/playwright` 已存在，直接执行即可）：

   ```bash
   cd ~/Documents/Coding/dae_sudoku
   npx playwright install chromium
   ```

2. 改两处调用，去掉 `channel`：

   ```diff
   - await chromium.launch({ channel: "msedge", headless: true });
   + await chromium.launch({ headless: true });
   ```

   涉及 `tools/autoplay/play.mjs:212`、`tools/verify.mjs:20`。

3. 注意：`playwright-core` 能识别默认缓存目录里的内核，前提是第 1 步成功。若第 1 步因网络失败，改走方案 B。

### 方案 B（不改依赖）：保留 Edge，但收拾重启逻辑

不改浏览器的话，至少要保证**一次运行只启动一次 Edge**：

- `ensurePage()` 只在 `browser.isConnected() === false` 时重启，不要因为 `page.isClosed()` 就整个重建 browser（页面挂了重新 `newPage()` 即可）
- 先定位并修掉导致页面崩溃的根因（日志里的 `Target page, context or browser has been closed`）

这样跳动会从"一次运行十几次"降到"一次运行最多一次"，但**不会彻底消失**。

> ⚠️ 不要把 `channel` 换成 `"chrome"`：只是把 Dock 里跳的图标从 Edge 换成 Chrome，问题依旧。

### 方案 C（兜底，系统级）

如果只是想眼不见为净，可全局关掉启动动画：

```bash
defaults write com.apple.dock no-bouncing -bool true && killall Dock
```

副作用：所有 App 的启动反馈都没了，不推荐作为最终方案。

---

## 五、验收标准

改完后必须全部满足：

| # | 检查项 | 命令 / 方法 | 期望 |
|---|---|---|---|
| 1 | Edge 不再被拉起 | `log show --last 5m --predicate 'eventMessage CONTAINS "CHECKIN" AND eventMessage CONTAINS "com.microsoft.edgemac" AND eventMessage CONTAINS "launchservicesd"' --style compact` | 无输出 |
| 2 | Dock 无跳动 | 连续跑 3 次 `node tools/verify.mjs`，肉眼观察 Dock | 全程 Edge 图标不跳 |
| 3 | 功能没退化 | `node tools/verify.mjs` | OCR / 求解结果与改动前一致 |
| 4 | autoplay 可用 | 跑一轮 autoplay | 正常出截图，无 `browser has been closed` 之类的重试日志 |

> 第 1 条的 predicate 必须带 `launchservicesd`，否则会把你自己的 `log show` 命令误判成一次启动（本机实测过这个假阳性）。

---

## 六、已排除的可能（不用再查）

| 怀疑对象 | 结论 |
|---|---|
| Edge 自带更新器 `EdgeUpdater` | 最后一次执行 2026-10-25 07:49，此后无动作 |
| `launchd` / `LaunchAgents` / `LaunchDaemons` / `crontab` | 完全没有 Microsoft/Edge 相关条目 |
| 登录项 Login Items | 只有 Bitwarden、BetterTouchTool、AndPhone、Codex Provider Switch、MonitorGlue、FlClash |
| Edge PWA / 后台扩展常驻 | `~/Applications/Edge Apps.localized` 为空，无残留 Edge 进程 |
| 默认浏览器被劫持 | 默认仍是 Safari（http/https） |

---

## 七、附：复现与排查命令

```bash
# 看 Edge 最近被启动了多少次（只看主进程）
log show --last 24h --predicate 'eventMessage CONTAINS "CHECKIN" AND eventMessage CONTAINS "com.microsoft.edgemac" AND process == "launchservicesd"' --style compact

# 看是谁在拉起（responsible 字段）
log show --last 24h --predicate 'eventMessage CONTAINS "responsible=" AND eventMessage CONTAINS "edgemac"' --style compact | grep -oE 'responsible=\{[^}]*identifier=[^,]*'

# 实时盯：一旦 Edge 出现就打印它的父进程链
while true; do
  ps -Ao pid=,ppid=,command= | grep "Microsoft Edge.app/Contents/MacOS/Microsoft Edge" | grep -v grep
  sleep 0.5
done
```

**排查时踩过的坑**：本机 `log` 被 shell 里的同名命令遮蔽，必须写绝对路径 `/usr/bin/log`；`pkill -f` 和 `timeout` 在这套环境里不可用，用 `ps` + `kill` 代替。
