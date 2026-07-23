#!/usr/bin/env bash
# Studio without Docker — filesystem project store (STUDIO_DATABASE_URL=local).
set -euo pipefail
cd "$(dirname "$0")"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT

export STUDIO_DATABASE_URL="${STUDIO_DATABASE_URL:-local}"
echo "→ local store (timeline.json under media/projects/)"

echo "→ backend on :8788"
( cd backend && go run ./cmd/studio -addr :8788 ) &

echo "→ frontend on :5273 (proxies API to :8788)"
( cd frontend && npm run dev ) &

wait
