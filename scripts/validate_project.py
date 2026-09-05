#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
required = [
    "README.md",
    "docs/PRODUCT_VISION.md",
    "docs/SCENARIO_LIBRARY.md",
    "docs/BENCHMARK_SPEC.md",
    "docs/COMPETITIVE_LANDSCAPE.md",
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
required_status_keys = [
    "project", "tagline", "phase", "sprint", "overallProgress", "sprintProgress",
    "repository", "metrics", "currentFocus", "approvals", "reviewQueue", "epics",
    "documents", "health", "activity", "blockers", "terminology",
]
for key in required_status_keys:
    if key not in status:
        raise SystemExit(f"PROJECT_STATUS.json missing key: {key}")

for key in ["overallProgress", "sprintProgress"]:
    progress = status[key]
    if not isinstance(progress, (int, float)) or not 0 <= progress <= 100:
        raise SystemExit(f"{key} must be between 0 and 100")

repo = status["repository"]
for key in ["name", "url", "workingBranch", "pullRequest"]:
    if key not in repo:
        raise SystemExit(f"repository missing key: {key}")

pr = repo["pullRequest"]
if not {"number", "title", "url", "status"}.issubset(pr):
    raise SystemExit("repository.pullRequest is malformed")

metrics = status["metrics"]
for key in ["openIssues", "ownerActions", "blockers", "ciStatus", "ciUrl"]:
    if key not in metrics:
        raise SystemExit(f"metrics missing key: {key}")

approval_ids = {g.get("id") for g in status["approvals"]}
if "G0" not in approval_ids or "G1" not in approval_ids:
    raise SystemExit("Status must include G0 and G1")

for review in status["reviewQueue"]:
    required_review = {"id", "kind", "title", "status", "priority", "why", "action", "url"}
    if not required_review.issubset(review):
        raise SystemExit(f"Malformed review item: {review}")

seen_task_ids = set()
for epic in status["epics"]:
    for key in ["id", "title", "status", "progress", "start", "end", "tasks"]:
        if key not in epic:
            raise SystemExit(f"Epic missing {key}: {epic}")
    if not 0 <= epic["progress"] <= 100:
        raise SystemExit(f"Invalid epic progress: {epic['id']}")
    for task in epic["tasks"]:
        if not {"id", "title", "status", "progress", "subtasks"}.issubset(task):
            raise SystemExit(f"Malformed task in {epic['id']}: {task}")
        if task["id"] in seen_task_ids:
            raise SystemExit(f"Duplicate task id: {task['id']}")
        seen_task_ids.add(task["id"])
        if not 0 <= task["progress"] <= 100:
            raise SystemExit(f"Invalid task progress: {task['id']}")
        for subtask in task["subtasks"]:
            if isinstance(subtask, str):
                continue
            if not {"title", "status"}.issubset(subtask):
                raise SystemExit(f"Malformed subtask in {task['id']}: {subtask}")

for expected in ["PD-002", "PD-004", "TF-001", "TF-002", "TF-003"]:
    if expected not in seen_task_ids:
        raise SystemExit(f"Missing tracked Sprint 0 task: {expected}")

for doc in status["documents"]:
    if not {"title", "type", "status", "note", "url"}.issubset(doc):
        raise SystemExit(f"Malformed document item: {doc}")

scenario = (ROOT / "docs/SCENARIO_LIBRARY.md").read_text(encoding="utf-8")
for marker in ["SCN-005", "SCN-004", "SCN-002", "SCN-010", "SCN-003", "weighted"]:
    if marker.lower() not in scenario.lower():
        raise SystemExit(f"Scenario library missing marker: {marker}")

benchmark = (ROOT / "docs/BENCHMARK_SPEC.md").read_text(encoding="utf-8")
for marker in ["100 KB/s", "10 MiB", "SHA-256", "5/5", "Net goodput", "incompressible"]:
    if marker.lower() not in benchmark.lower():
        raise SystemExit(f"Benchmark spec missing marker: {marker}")

competitive = (ROOT / "docs/COMPETITIVE_LANDSCAPE.md").read_text(encoding="utf-8")
for marker in ["prior art", "third-party self-reported", "licens", "enterprise/industrial"]:
    if marker.lower() not in competitive.lower():
        raise SystemExit(f"Competitive landscape missing marker: {marker}")

html = (ROOT / "dashboard/index.html").read_text(encoding="utf-8")
for marker in ["./data/status.json", "Owner Review Center", "Roadmap Forecast", "GitHub Actions"]:
    if marker not in html:
        raise SystemExit(f"Dashboard missing required marker: {marker}")

print("OptiLink project validation passed")
