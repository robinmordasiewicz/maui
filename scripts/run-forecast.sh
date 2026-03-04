#!/bin/bash
# run-forecast.sh — Full local forecast pipeline
#
# 1. Pulls all data and generates report JSON
# 2. Generates AI blog post via Anthropic API
# 3. Commits new blog post and pushes to GitHub
# 4. GitHub Actions picks up the push and deploys the updated site
#
# Runs locally — no GitHub Actions needed for data collection.
# Schedule via cron or launchd (see README).
#
# Usage: bash scripts/run-forecast.sh [--no-post]
#   --no-post  Skip blog post generation (just update report cache)

set -euo pipefail
cd "$(dirname "$0")/.."

LOGDIR="output/log"
mkdir -p "$LOGDIR"

DATE=$(TZ=Pacific/Honolulu date +%Y-%m-%d)
TIME=$(TZ=Pacific/Honolulu date +%H:%M)
LOGFILE="${LOGDIR}/${DATE}.jsonl"
JSON_OUT="output/latest.json"

echo "[$(date -u +%H:%MZ)] run-forecast: starting..."

# ── 1. Generate report ───────────────────────────────────────────────
echo "[$(date -u +%H:%MZ)] Pulling data..."
node kanaha-report.mjs --json --no-cache > "$JSON_OUT" 2>>"${LOGDIR}/stderr.log"

# Append to daily JSONL log
python3 -c "import json,sys; d=json.load(open('$JSON_OUT')); print(json.dumps(d))" >> "$LOGFILE"

echo "[$(date -u +%H:%MZ)] Report complete."

# ── 2. Generate blog post ────────────────────────────────────────────
if [[ "${1:-}" != "--no-post" ]] && [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "[$(date -u +%H:%MZ)] Generating blog post..."
  node scripts/generate-forecast.mjs --file "$JSON_OUT" 2>>"${LOGDIR}/stderr.log"
  echo "[$(date -u +%H:%MZ)] Blog post written."

  # ── 3. Commit and push ─────────────────────────────────────────────
  git add site/src/content/blog/
  if ! git diff --cached --quiet; then
    git commit -m "📡 Forecast: ${DATE} ${TIME} HST"
    git push
    echo "[$(date -u +%H:%MZ)] Pushed — GitHub Pages deploy triggered."
  else
    echo "[$(date -u +%H:%MZ)] No blog changes to commit."
  fi
else
  echo "[$(date -u +%H:%MZ)] Skipping blog post (no ANTHROPIC_API_KEY or --no-post)."
fi

echo "[$(date -u +%H:%MZ)] run-forecast: done."
