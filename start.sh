#!/bin/bash
# SimpleReplay — Launch Script
# Starts a local server and opens the app in your browser.
# Requires: macOS with PHP or Python

PORT=8080
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🎬 SimpleReplay — Starting server on http://localhost:$PORT"
echo "   Press Ctrl+C to stop."
echo ""

# Try Python 3 first (more reliable for static files)
if command -v python3 &> /dev/null; then
  open "http://localhost:$PORT"
  cd "$DIR" && python3 -m http.server $PORT
# Try PHP (built into macOS)
elif command -v php &> /dev/null; then
  open "http://localhost:$PORT"
  php -S "localhost:$PORT" -t "$DIR"
# Try Ruby
elif command -v ruby &> /dev/null; then
  open "http://localhost:$PORT"
  ruby -run -e httpd "$DIR" -p $PORT
# Try Python 2
elif command -v python &> /dev/null; then
  open "http://localhost:$PORT"
  cd "$DIR" && python -m SimpleHTTPServer $PORT
else
  echo "❌ Error: No se encontró PHP ni Python."
  echo "   Instalá las Xcode Command Line Tools con: xcode-select --install"
  echo "   O instalá Node.js desde: https://nodejs.org"
  exit 1
fi
