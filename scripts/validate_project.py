#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
required = [
    "README.md",
    "docs/PRODUCT_VISION.md",
    "docs/SCENARIO_LIBRARY.md",
    "docs/PRODUCT_REQUIREMENTS.md",
    "docs/TECHNICAL_OPTIONS.md",
    "docs/GLOSSARY.md",
    "docs/adr/ADR-0001-development-governance.md",
    "project/ROADMAP.md",
    "project/PROJECT_STATUS.json",
    "dashboard/index.html",
]
missing = [p for p in required if not (ROOT / p).is_file()]
if missing:
    raise SystemExit("Missing required files: " + ", ".join(missing))

status = json.loads((ROOT / "project/PROJECT_STATUS.json").read_text(encoding="utf-8"))
for key in ["project", "phase", "sprint", "overallProgress", "approvals", "epics", "blockers", "terminology"]:
    if key not in status:
        raise SystemExit(f"PROJECT_STATUS.json missing key: {key}")

progress = status["overallProgress"]
if not isinstance(progress, (int, float)) or not 0 <= progress <= 100:
    raise SystemExit("overallProgress must be between 0 and 100")

approval_ids = {g.get("id") for g in status["approvals"]}
if "G0" not in approval_ids or "G1" not in approval_ids:
    raise SystemExit("Status must include G0 and G1")

for epic in status["epics"]:
    for key in ["id", "title", "status", "progress", "start", "end", "tasks"]:
        if key not in epic:
            raise SystemExit(f"Epic missing {key}: {epic}")
    if not 0 <= epic["progress"] <= 100:
        raise SystemExit(f"Invalid epic progress: {epic['id']}")
    for task in epic["tasks"]:
        if not {"id", "title", "status", "progress", "subtasks"}.issubset(task):
            raise SystemExit(f"Malformed task in {epic['id']}: {task}")

html = (ROOT / "dashboard/index.html").read_text(encoding="utf-8")
if "./data/status.json" not in html:
    raise SystemExit("Dashboard must consume generated data/status.json")

print("OptiLink project validation passed")
