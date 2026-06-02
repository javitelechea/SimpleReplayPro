#!/usr/bin/env bash
# MediaMTX + video de prueba en path "tapo" (o solo MediaMTX si ya tenés config propia).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
CONF="${MTX_CONF:-$ROOT/mediamtx.yml}"
RTSP_URL="rtsp://127.0.0.1:8554/tapo"

command -v mediamtx >/dev/null || { echo "Instalá MediaMTX: brew install mediamtx"; exit 1; }

for name in mediamtx ffmpeg; do
  f="$ROOT/${name}.pid"
  if [[ -f "$f" ]]; then
    pid="$(cat "$f")"
    kill "$pid" 2>/dev/null || true
    rm -f "$f"
  fi
done
sleep 0.5

if lsof -i :8554 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Puerto 8554 ocupado. ¿Ya tenés MediaMTX? Usá tu config y publicá en path tapo."
  echo "Si querés el servidor de prueba, pará el otro MediaMTX primero."
  exit 1
fi

mediamtx "$CONF" >>"$ROOT/mediamtx.log" 2>&1 &
echo $! >"$ROOT/mediamtx.pid"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  lsof -i :8554 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.3
done

if ! lsof -i :8888 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "MediaMTX no levantó. Últimas líneas del log:"
  tail -5 "$ROOT/mediamtx.log"
  exit 1
fi

# Si el path ya tiene source: en el yml (cámara real), no publicar con ffmpeg.
if grep -qE '^\s*source:\s*rtsp' "$CONF" 2>/dev/null; then
  echo ""
  echo "MediaMTX listo (lee RTSP desde config en path tapo)."
  echo "  Probar: http://127.0.0.1:8888/tapo/"
  echo "  App:    misma URL en Cámara IP"
  exit 0
fi

command -v ffmpeg >/dev/null || { echo "Instalá ffmpeg: brew install ffmpeg"; exit 1; }

: >"$ROOT/ffmpeg.log"
ffmpeg -hide_banner -loglevel warning -re \
  -f lavfi -i "smptebars=size=1280x720:rate=25" \
  -pix_fmt yuv420p -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -g 25 -an \
  -f rtsp -rtsp_transport tcp "$RTSP_URL" >>"$ROOT/ffmpeg.log" 2>&1 &
echo $! >"$ROOT/ffmpeg.pid"
sleep 2

if curl -sf -o /dev/null -L --max-time 5 http://127.0.0.1:8888/tapo/index.m3u8; then
  echo ""
  echo "MediaMTX OK — stream de prueba en path tapo."
  echo "  Navegador: http://127.0.0.1:8888/tapo/"
  echo "  App:       http://127.0.0.1:8888/tapo/"
else
  echo ""
  echo "MediaMTX corre pero NO hay video en tapo (por eso el navegador muestra error)."
  echo "  Revisá: tail -20 $ROOT/ffmpeg.log"
  echo "  O configurá tu Tapo en mediamtx.example-tapo.yml"
fi
echo "  Parar: $ROOT/stop.sh"
echo ""
