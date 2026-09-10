#!/usr/bin/env bash
set -euo pipefail

DSH_BIN="$HOME/.local/bin/dsh"
LOG_DIR="$HOME/.optilink"
LOG_FILE="$LOG_DIR/deepseek-harness.log"
PID_FILE="$LOG_DIR/deepseek-harness.pid"
PORT="3080"

mkdir -p "$LOG_DIR"

if [[ ! -x "$DSH_BIN" ]]; then
  echo "DeepSeek Harness is not installed at $DSH_BIN. Rebuild the Codespace or run .devcontainer/setup-deepseek-harness.sh." >&2
  exit 1
fi

if curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
  echo "DeepSeek Harness already healthy on port ${PORT}."
  exit 0
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

echo "Starting DeepSeek Harness Web UI on port ${PORT} ..."
nohup "$DSH_BIN" web --port "$PORT" >"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" > "$PID_FILE"

for _ in $(seq 1 20); do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "DeepSeek Harness is ready. Log: $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "DeepSeek Harness exited during startup. See $LOG_FILE" >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 1
done

echo "DeepSeek Harness did not become healthy on port ${PORT}. See $LOG_FILE" >&2
exit 1
