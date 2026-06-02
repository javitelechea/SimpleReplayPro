#!/usr/bin/env bash
# App web local + MediaMTX de prueba (path tapo).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RTSP_TEST="$ROOT/tools/rtsp-test"
PORT="${SR_PORT:-8080}"

command -v python3 >/dev/null || { echo "Necesitás python3."; exit 1; }

if [[ -f "$HOME/mediamtx-tapo/mediamtx.yml" ]]; then
  echo "Usá tu MediaMTX: cd ~/mediamtx-tapo && mediamtx mediamtx.yml"
  echo "(No se inicia el MediaMTX de prueba del repo para no pisar tus puertos.)"
  echo ""
else
  "$RTSP_TEST/start.sh"
fi

if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "SimpleReplay ya corre en http://127.0.0.1:$PORT/"
elif lsof -i ":8888" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "MediaMTX ya usa :8888 (¿tu tapo real?). Solo levantando la app web..."
  cd "$ROOT"
  python3 -m http.server "$PORT" >>"$RTSP_TEST/app-web.log" 2>&1 &
  echo $! >"$RTSP_TEST/app-web.pid"
  sleep 0.5
else
  echo "Iniciando SimpleReplay en http://127.0.0.1:$PORT/ ..."
  cd "$ROOT"
  python3 -m http.server "$PORT" >>"$RTSP_TEST/app-web.log" 2>&1 &
  echo $! >"$RTSP_TEST/app-web.pid"
  sleep 0.5
fi

echo ""
echo "════════════════════════════════════════"
echo "  App:     http://127.0.0.1:$PORT/"
echo "  Cámara:  http://localhost:8888/tapo/"
echo "  Parar:   $RTSP_TEST/stop.sh && kill \$(cat $RTSP_TEST/app-web.pid 2>/dev/null) 2>/dev/null"
echo "════════════════════════════════════════"
echo ""
