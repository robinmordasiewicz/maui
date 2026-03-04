# AGENTS.md — Kanaha Watersport Forecast

## First Thing
Read `CONTEXT.md` — it contains all domain knowledge, physics models, calibration notes, and equipment logic. You cannot make intelligent predictions without it.

## What This System Does
Programmatic weather/ocean data collection and analysis for watersport conditions at Kanaha Beach Park, Maui. Produces equipment recommendations and go/no-go ratings for kitesurfing, windsurfing, wing foiling, and downwind foilboarding.

## Your Role
You are the analyst. The scripts do the data collection and deterministic computation. You interpret the results, answer questions, explain patterns, and provide judgment that algorithms can't.

## Key Commands
```bash
# Full report (text)
node kanaha-report.mjs

# Full report (JSON — for your consumption)
node kanaha-report.mjs --json

# Quick wind check (no Playwright)
node kanaha-report.mjs --wind-only

# Force fresh data (ignore cache)
node kanaha-report.mjs --no-cache
```

## Important Rules
0. **ALL times are HST (UTC-10)**. The report JSON contains `time_hst` and `hour_hst` — use those, never your system clock. Your host machine may be in a different timezone. When reasoning about "now", "today", "tomorrow", always reference the HST time from the report data. Sunrise ~6:30, sunset ~18:15, thermal window 9-17h, session window noon-4pm weekday / noon-5pm weekend — all HST.
1. **Kanaha sensor (166192) is truth** — never compare raw kts with other stations
2. **Cloud cover is the #1 forecast uncertainty** — always check and caveat
3. **Peak wind is 11-14h HST** — evening surges are exceptions
4. **Equipment recommendations are safety-critical** — especially board choice in big swell (duck diving) and mast length (reef strikes)
5. **NE wind = best windswell for foiling** — direction matters as much as speed
