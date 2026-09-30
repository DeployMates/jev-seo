#!/usr/bin/env bash
# Start the Jev SEO dashboard detached, so it survives the terminal that
# launched it. Logs land in .logs/. Stop it with ./stop.sh.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p .logs

port_busy() { lsof -iTCP:"$1" -sTCP:LISTEN -P -n >/dev/null 2>&1; }

if port_busy 8787; then
  echo "already listening on 8787 (server), leaving it alone"
else
  nohup npm --workspace server run start > .logs/server.log 2>&1 < /dev/null &
  disown || true
  echo "started server -> port 8787 (log: .logs/server.log)"
fi

if port_busy 5173; then
  echo "already listening on 5173 (web), leaving it alone"
else
  nohup npm --workspace web run dev > .logs/web.log 2>&1 < /dev/null &
  disown || true
  echo "started web -> port 5173 (log: .logs/web.log)"
fi

for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null --max-time 2 http://localhost:5173/ 2>/dev/null &&
     curl -fsS -o /dev/null --max-time 2 http://localhost:8787/api/health 2>/dev/null; then
    echo
    echo "ready: http://localhost:5173"
    exit 0
  fi
  sleep 1
done

echo "did not become ready in time; check .logs/" >&2
exit 1
