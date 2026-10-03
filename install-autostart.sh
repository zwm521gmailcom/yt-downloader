#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Install a login helper so opening the extension starts the bridge.
#  安装登录自启：之后打开扩展弹窗会自动拉起下载服务。
#
#  Run once:  ./install-autostart.sh
#  Remove:    ./install-autostart.sh remove
# ---------------------------------------------------------------------------

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.ytdownloader.launcher"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "remove" ]]; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"
  echo "  Removed ${LABEL}."
  echo "  已移除登录自启。"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "  [ERROR] Node.js was not found on your PATH."
  echo "  [错误] 未在 PATH 中找到 Node.js。"
  exit 1
fi

NODE="$(command -v node)"
NODE_DIR="$(dirname "$NODE")"
LOG_DIR="${HOME}/Library/Logs"
mkdir -p "${HOME}/Library/LaunchAgents" "$LOG_DIR"

# launchd does not inherit a terminal PATH. Homebrew's node, yt-dlp and ffmpeg
# live outside /usr/bin, so the helper needs them listed explicitly.
PATH_VALUE="${NODE_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "${ROOT}/launcher/launcher.js")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "${ROOT}/launcher")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$PATH_VALUE")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "${LOG_DIR}/ytd-launcher.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "${LOG_DIR}/ytd-launcher.err.log")</string>
</dict>
</plist>
EOF

launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "${DOMAIN}/${LABEL}"
launchctl kickstart -k "${DOMAIN}/${LABEL}"

echo
echo "  Login helper installed. Opening the extension will start the bridge."
echo "  登录自启已安装。之后打开扩展弹窗会自动启动下载服务。"
echo "  Logs: ${LOG_DIR}/ytd-launcher.log"
echo
