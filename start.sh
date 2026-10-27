#!/usr/bin/env bash
# 启动找鹅助手本地服务：网页 + 自动玩 API。
# 自动玩需要屏幕录制和辅助功能权限；当前权限授给了 Kero，
# 所以请在 Kero 里运行，或在别的终端里给该终端重新授权。
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-5173}"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js。" >&2
  exit 1
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已经被占用：" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | head -5 >&2
  echo "换个端口：PORT=5180 ./start.sh" >&2
  exit 1
fi

echo "找鹅助手启动中：http://localhost:$PORT"
echo "自动玩入口在页面右侧的「自动玩」卡片（仅本机 localhost 可用）。"
echo

exec env PORT="$PORT" node server.js
