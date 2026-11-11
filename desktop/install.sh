#!/bin/sh
# Installs the Teams desktop injector as a launch agent that starts at login and stays running.
# The agent also sets WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS for your login session so that
# Teams, however it is opened (Dock, login item, its own restarts), exposes a local DevTools
# port the injector can use. Undo with ./uninstall.sh.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
PORT=${HTC_PORT:-29229}
NODE=${HTC_NODE:-$(command -v node)}
case "$NODE" in
  */fnm_multishells/*) NODE="$HOME/.local/share/fnm/aliases/default/bin/node" ;; # per-shell fnm path disappears
esac
[ -x "$NODE" ] || { echo "node not found; set HTC_NODE=/path/to/node" >&2; exit 1; }

LABEL=com.hide-teams-camera.inject
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/hide-teams-camera.log"
ARGS="--remote-debugging-port=$PORT"

[ -f "$DIR/names.txt" ] || cp "$DIR/names.example.txt" "$DIR/names.txt"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>launchctl setenv WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS '$ARGS'; exec '$NODE' '$DIR/inject.mjs' --port $PORT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl setenv WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS "$ARGS"
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed. Names to hide: $DIR/names.txt   Log: $LOG"
if pgrep -x MSTeams >/dev/null && ! curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null; then
  echo "Teams is running without support yet: quit it (Cmd+Q) and open it again."
fi
