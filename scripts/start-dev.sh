#!/bin/bash
set -e

# Build api-server bundle
echo "Building API server..."
case "$LOG_LEVEL" in
  fatal|error|warn|info|debug|trace|silent) ;;
  *) export LOG_LEVEL="info" ;;
esac
(cd artifacts/api-server && node ./build.mjs)

# Start the API server on internal port 5001
for pid in $(ss -lptn 'sport = :5001' 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill -9 $pid 2>/dev/null || true; done
(cd artifacts/api-server && PORT=5001 node --enable-source-maps ./dist/index.mjs) &
API_PID=$!

# Start the frontend Vite dev server on port 3000
(cd artifacts/pw-clone && export PORT=3000 API_PORT=5001 && if [ -x ./node_modules/.bin/vite ]; then exec ./node_modules/.bin/vite --config vite.config.ts --host 0.0.0.0 --port 3000; else exec npx vite --config vite.config.ts --host 0.0.0.0 --port 3000; fi) &
FRONTEND_PID=$!

# Cleanup child processes when exiting
trap "kill -9 $API_PID $FRONTEND_PID 2>/dev/null || true" EXIT INT TERM

# Wait for both processes; exit if either dies
wait -n $API_PID $FRONTEND_PID


