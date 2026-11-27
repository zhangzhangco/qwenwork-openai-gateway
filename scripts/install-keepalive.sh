#!/usr/bin/env bash
# install-keepalive —— 安装凭证保活 LaunchAgent（macOS）。
# 用法：bash scripts/install-keepalive.sh [--uninstall]
set -euo pipefail

LABEL="com.zhangzhangco.qwenwork-keepalive"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "keepalive agent removed."
  exit 0
fi

[[ "$(uname)" == "Darwin" ]] || { echo "macOS only (launchd)."; exit 1; }
[[ -n "$NODE_BIN" ]] || { echo "node not found in PATH."; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$REPO_DIR/launchd/$LABEL.plist" > "$PLIST"
plutil -lint "$PLIST"

# 已加载则先卸载，保证幂等
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "keepalive agent installed: every 90 min, log at ~/Library/Logs/qwenwork-keepalive.log"
echo "first run happens immediately (RunAtLoad); check the log in a few seconds."