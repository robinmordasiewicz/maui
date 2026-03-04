#!/bin/bash
# pull-all.sh — Run all maui-wx modules and save timestamped output
#
# Usage: ./pull-all.sh [--skip-wind]   (skip the slow Playwright-based wind module)

set -euo pipefail
cd "$(dirname "$0")"

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUTDIR="output/${TS}"
mkdir -p "$OUTDIR"

SKIP_WIND=false
[[ "${1:-}" == "--skip-wind" ]] && SKIP_WIND=true

echo "=== Maui WX Pull — $TS ==="
echo "Output: $OUTDIR/"
echo ""

run_module() {
  local name="$1"
  shift
  echo -n "[$name] "
  if node "modules/${name}.mjs" "$@" > "$OUTDIR/${name}.json" 2>/dev/null; then
    local count=$(python3 -c "import json; d=json.load(open('$OUTDIR/${name}.json')); fc=d.get('forecast',d.get('hourly',d.get('observations',d.get('high_low',[])))); print(len(fc) if isinstance(fc,list) else '?')" 2>/dev/null || echo "?")
    echo "✓ ($count records)"
  else
    echo "✗ FAILED"
  fi
}

# Fast modules (no auth, public APIs)
run_module buoy-ndbc 24
run_module tides-noaa 3
run_module forecast-nws
run_module pressure-meteo 7
run_module ocean-waves 7

# Slow module (Playwright login)
if [ "$SKIP_WIND" = false ]; then
  run_module wind-iktrrm 48
else
  echo "[wind-iktrrm] skipped (--skip-wind)"
fi

echo ""
echo "Done. Files:"
ls -lh "$OUTDIR/"
