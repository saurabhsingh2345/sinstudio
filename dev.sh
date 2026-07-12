#!/usr/bin/env bash
# Runs the studio backend (:8787) and the Vite dev server (:5273) together.
set -euo pipefail
cd "$(dirname "$0")"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT

echo "→ backend on :8787"
( cd backend && go run ./cmd/studio -addr :8787 ) &

echo "→ frontend on :5273 (proxies API to :8787)"
( cd frontend && npm run dev ) &

wait
