#!/usr/bin/env bash
# Stop the Jev SEO dashboard started by ./start.sh
set -uo pipefail

cd "$(dirname "$0")"

pkill -f "tsx src/index.ts" 2>/dev/null && echo "server stopped" || echo "server was not running"
pkill -f "vite" 2>/dev/null && echo "web stopped" || echo "web was not running"
