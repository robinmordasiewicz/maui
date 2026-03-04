#!/bin/bash
# log-report.sh — Run kanaha-report and append to daily JSONL log
# Called by cron every 15 min during Hawaii daylight hours

set -euo pipefail
cd "$(dirname "$0")"

LOGDIR="output/log"
mkdir -p "$LOGDIR"

DATE=$(TZ=Pacific/Honolulu date +%Y-%m-%d)
LOGFILE="${LOGDIR}/${DATE}.jsonl"

# Run report and append as single JSON line
node kanaha-report.mjs --json 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(json.dumps(d))
" >> "$LOGFILE"
