#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  YouTube Downloader - start the local bridge  /  启动本地下载服务
#
#  Run:  ./start-bridge.sh
#  Keep this terminal open while downloading; Ctrl+C stops the bridge.
#
#  运行：./start-bridge.sh
#  下载期间请保持本终端开启；按 Ctrl+C 停止服务。
# ---------------------------------------------------------------------------

set -euo pipefail
cd "$(dirname "$0")/server"

echo
echo "  Starting the YouTube Downloader bridge..."
echo "  正在启动 YouTube 下载器本地服务..."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  [ERROR] Node.js was not found on your PATH."
  echo "  [错误] 未在 PATH 中找到 Node.js。"
  echo
  echo "  Install Node.js 18 or newer from https://nodejs.org"
  echo "  请从 https://nodejs.org 安装 Node.js 18 或更高版本，然后重新运行本脚本。"
  echo
  exit 1
fi

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "  [WARN] yt-dlp was not found on your PATH."
  echo "  [警告] 未在 PATH 中找到 yt-dlp。"
  echo "         Install with:  brew install yt-dlp   (or: pip install -U yt-dlp)"
  echo
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "  [WARN] ffmpeg was not found on your PATH."
  echo "  [警告] 未在 PATH 中找到 ffmpeg。"
  echo "         High-resolution video and audio cannot be merged without it."
  echo "         缺少它时将无法合并高清视频与音频。"
  echo "         Install with:  brew install ffmpeg"
  echo
fi

# On many networks (shared proxy / VPN exit IPs) YouTube's download servers
# answer some player clients with HTTP 403. Keep yt-dlp's built-in default
# (a recent yt-dlp is required — run `brew upgrade yt-dlp` / `winget upgrade
# yt-dlp.yt-dlp` first). Only override when 403 persists, e.g.:
#   YTD_PLAYER_CLIENT=mweb ./start-bridge.sh   (browser-style client, ≤360p only)
# 若持续 403：先升级 yt-dlp；仍不行再用上面的 YTD_PLAYER_CLIENT 覆盖（mweb 只有 360p）。
export YTD_PLAYER_CLIENT="${YTD_PLAYER_CLIENT:-}"

exec node server.js
