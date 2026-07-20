#!/usr/bin/env bash
# Runs the studio backend (:8788) and the Vite dev server (:5273) together.
set -euo pipefail
cd "$(dirname "$0")"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT

# Postgres holds the project documents. Host port 5544 avoids a natively-installed
# Postgres on 5432. Existing timeline.json projects are adopted on first start.
export STUDIO_DATABASE_URL="${STUDIO_DATABASE_URL:-postgres://studio:studio@localhost:5544/studio?sslmode=disable}"
echo "→ postgres on :5544"
docker compose up -d postgres >/dev/null
until docker compose exec -T postgres pg_isready -U studio -d studio >/dev/null 2>&1; do sleep 1; done

echo "→ backend on :8788"
( cd backend && go run ./cmd/studio -addr :8788 ) &

echo "→ frontend on :5273 (proxies API to :8788)"
( cd frontend && npm run dev ) &

wait
