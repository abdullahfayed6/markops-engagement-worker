#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!
x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -localhost &
VNC_PID=$!
websockify --web /usr/share/novnc 6080 localhost:5900 &
WEBSOCKIFY_PID=$!

cleanup() {
  kill "${APP_PID:-}" "$WEBSOCKIFY_PID" "$VNC_PID" "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
node dist/server.js &
APP_PID=$!
wait "$APP_PID"
