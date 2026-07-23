#!/usr/bin/env bash
# End-to-end smoke test against a running Studio backend (default :8788).
# Usage: ./scripts/e2e-smoke.sh [base_url]
set -euo pipefail

BASE="${1:-http://127.0.0.1:8788}"

echo "→ E2E smoke against $BASE"

curl -sf "$BASE/health" | grep -q '"ok":true'
echo "  ✓ health"

curl -sf "$BASE/api/capabilities" | grep -q transcribe
echo "  ✓ capabilities"

GENS=$(curl -sf "$BASE/api/generators" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "  ✓ generators ($GENS)"

# Create project, round-trip markers, optimistic concurrency
python3 - "$BASE" <<'PY'
import json, sys, urllib.request, urllib.error

BASE = sys.argv[1]

def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(r) as res:
        return json.loads(res.read())

def req_code(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(r) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

doc = req("POST", "/api/projects", {"name": "E2E Smoke"})
pid = doc["id"]

doc["markers"] = [
    {"id": "mk_e2e1", "t": 1.0, "label": "Intro", "color": "#22c55e"},
    {"id": "mk_e2e2", "t": 4.5, "label": "Outro", "color": "#3b82f6"},
]
doc["version"] = doc.get("version", 1)
req("PUT", f"/api/projects/{pid}", doc)

loaded = req("GET", f"/api/projects/{pid}")
assert len(loaded.get("markers", [])) == 2, loaded.get("markers")
assert loaded["markers"][0]["label"] == "Intro"

code, _ = req_code("PUT", f"/api/projects/{pid}", {**loaded, "version": 1, "name": "Stale"})
assert code == 409, code

job = req("POST", f"/api/projects/{pid}/export", {"format": "mp4", "preset": "1080p"})
jid = job["jobId"]

import time
for _ in range(60):
    j = req("GET", f"/api/jobs/{jid}")
    if j.get("status") in ("done", "failed", "cancelled"):
        if j.get("status") != "done":
            raise SystemExit(f"export failed: {j}")
        break
    time.sleep(0.25)
else:
    raise SystemExit("export timed out")

print(f"  ✓ project CRUD + markers + export (job {jid})")
PY

echo "→ All E2E smoke checks passed"
