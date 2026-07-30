#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!

for _ in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo '{"level":"error","event":"xvfb_exited_during_startup"}' >&2
    exit 1
  fi
  sleep 0.1
done

if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo '{"level":"error","event":"xvfb_startup_timeout"}' >&2
  exit 1
fi

x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -localhost &
VNC_PID=$!

for _ in $(seq 1 50); do
  if (echo > /dev/tcp/127.0.0.1/5900) >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$VNC_PID" 2>/dev/null; then
    echo '{"level":"error","event":"x11vnc_exited_during_startup"}' >&2
    exit 1
  fi
  sleep 0.1
done

if ! (echo > /dev/tcp/127.0.0.1/5900) >/dev/null 2>&1; then
  echo '{"level":"error","event":"x11vnc_startup_timeout"}' >&2
  exit 1
fi

websockify --web=/usr/share/novnc 6080 localhost:5900 &
WEBSOCKIFY_PID=$!

for _ in $(seq 1 50); do
  if (echo > /dev/tcp/127.0.0.1/6080) >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$WEBSOCKIFY_PID" 2>/dev/null; then
    echo '{"level":"error","event":"novnc_exited_during_startup"}' >&2
    exit 1
  fi
  sleep 0.1
done

if ! (echo > /dev/tcp/127.0.0.1/6080) >/dev/null 2>&1; then
  echo '{"level":"error","event":"novnc_startup_timeout"}' >&2
  exit 1
fi

cleanup() {
  kill "$WEBSOCKIFY_PID" "$VNC_PID" "$XVFB_PID" 2>/dev/null || true
  wait "$WEBSOCKIFY_PID" "$VNC_PID" "$XVFB_PID" 2>/dev/null || true
}

shutdown() {
  if [[ -n "${APP_PID:-}" ]]; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  cleanup
  exit 0
}

trap shutdown INT TERM
trap cleanup EXIT
node dist/server.js &
APP_PID=$!
set +e
wait "$APP_PID"
APP_STATUS=$?
set -e
exit "$APP_STATUS"
