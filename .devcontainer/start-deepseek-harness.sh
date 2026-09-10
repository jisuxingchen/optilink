#!/usr/bin/env bash
set -e

LOG_DIR="$HOME/.optilink"
LOG_FILE="$LOG_DIR/deepseek-harness.log"

mkdir -p "$LOG_DIR"

# 避免 Codespace attach / restart 时重复启动
if pgrep -f "deepseek" >/dev/null 2>&1; then
    echo "DeepSeek harness already running."
    exit 0
fi

echo "Starting DeepSeek harness..."

nohup deepseek-harness start \
    >"$LOG_FILE" 2>&1 &

echo "DeepSeek harness started. Log: $LOG_FILE"