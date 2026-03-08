#!/bin/bash
# run-forecast.sh — Full local forecast pipeline
#
# 1. Pulls all data and generates report JSON
# 2. Generates AI blog post via Anthropic API
# 3. Builds Astro site locally
# 4. Deploys built static files to gh-pages branch
#
# Everything runs locally — no GitHub Actions involved.
# iKitesurf Playwright auth requires local execution (fraud protection).
# Schedule via OpenClaw cron (see cron jobs).
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

  # ── 3. Build Astro site locally ────────────────────────────────────
  echo "[$(date -u +%H:%MZ)] Building Astro site..."
  cd site && npm run build 2>>"../${LOGDIR}/stderr.log" && cd ..
  echo "[$(date -u +%H:%MZ)] Site built."

  # ── 4. Deploy to gh-pages branch ──────────────────────────────────
  echo "[$(date -u +%H:%MZ)] Deploying to gh-pages..."

  # Commit source changes to main
  git add site/src/content/blog/
  if ! git diff --cached --quiet; then
    git commit -m "📡 Forecast: ${DATE} ${TIME} HST"
  fi

  # Push built dist/ to gh-pages branch using a temp worktree
  DIST_DIR="$(pwd)/site/dist"
  DEPLOY_TMP="$(mktemp -d)"

  # Clean up any stale worktrees before adding
  git worktree prune 2>/dev/null || true
  git worktree add "$DEPLOY_TMP" gh-pages 2>/dev/null || {
    git worktree add --detach "$DEPLOY_TMP" 2>/dev/null || true
    cd "$DEPLOY_TMP"
    git checkout --orphan gh-pages
  }
  cd "$DEPLOY_TMP"

  # Clear everything and copy fresh build
  git rm -rf . 2>/dev/null || true
  cp -a "$DIST_DIR"/. .
  touch .nojekyll

  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "🚀 Deploy: ${DATE} ${TIME} HST"
    git push origin gh-pages --force
    echo "[$(date -u +%H:%MZ)] Deployed to gh-pages."
  else
    echo "[$(date -u +%H:%MZ)] No deploy changes."
  fi

  # Cleanup worktree
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo /Users/robin/.openclaw/workspace/maui-wx)"
  cd "$REPO_ROOT"
  git worktree remove "$DEPLOY_TMP" --force 2>/dev/null || rm -rf "$DEPLOY_TMP"

  # Push main branch source
  git push origin main 2>/dev/null || true
  echo "[$(date -u +%H:%MZ)] Source pushed to main."
else
  echo "[$(date -u +%H:%MZ)] Skipping blog post (no ANTHROPIC_API_KEY or --no-post)."
fi

echo "[$(date -u +%H:%MZ)] run-forecast: done."
