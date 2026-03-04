# Kanaha Watersport Forecast System

Automated weather/ocean data collection and analysis for watersport conditions at Kanaha Beach Park, North Shore Maui, Hawaii. Produces equipment recommendations and go/no-go ratings for kite foilboarding, windsurfing, wing foiling, and downwind foilboarding.

## Architecture

```
Sensors → Scripts (deterministic, cached) → JSON → LLM (interpretation)
```

- **Scripts** pull data programmatically on cron (every 15 min during 6am-7pm HST)
- **Scripts** compute all analysis deterministically: verdicts, anomalies, correlations, equipment recs
- **LLM** is the analyst: reads pre-computed JSON, adds pattern recognition and judgment
- **Historical data** accumulates in `output/log/YYYY-MM-DD.jsonl`

## Quick Start

```bash
# Full report (human-readable)
node kanaha-report.mjs

# Full report (JSON — for LLM consumption)
node kanaha-report.mjs --json

# Quick wind check (no Playwright auth needed)
node kanaha-report.mjs --wind-only

# Force fresh data pull (ignore cache)
node kanaha-report.mjs --no-cache
```

## Key Files

| File | Purpose |
|------|---------|
| `CONTEXT.md` | **Domain knowledge for LLM** — wind physics, sensor calibration, equipment logic, bathymetry |
| `AGENTS.md` | Bootstrap instructions for OpenClaw agent in CI/CD |
| `equipment-profiles.json` | Rider-specific equipment correlations (wind → kite/wing/mast/board) |
| `kanaha-report.mjs` | **Orchestrator** — runs all modules, outputs composite report |
| `log-report.sh` | Cron wrapper for data logging |

## Modules

All modules are standalone Node.js ESM scripts outputting JSON to stdout.

| Module | Source | Auth | TTL | Function |
|--------|--------|------|-----|----------|
| `wind-prediction.mjs` | WeatherFlow + NDBC + Open-Meteo | Playwright | 15 min | Wind prediction with upwind analysis, thermal model, taper forecast |
| `isthmus-thermal.mjs` | WeatherFlow (7 MECO stations) | Playwright | 15 min | Isthmus heat index, wind regime classification, venturi index |
| `windswell-analysis.mjs` | NDBC spectral (.spec) | None | 30 min | Windswell/groundswell decomposition, downwind foil rating |
| `equipment-rec.mjs` | NOAA tides + profiles | None | 30 min | Mast, kite, wing, line recommendations from conditions |
| `buoy-ndbc.mjs` | NDBC | None | 30 min | Buoy met data (wind, pressure, SST) |
| `tides-noaa.mjs` | NOAA CO-OPS | None | 12 hr | Tide predictions + observations |
| `forecast-nws.mjs` | NWS API | None | 60 min | Forecast narrative + alerts |
| `pressure-meteo.mjs` | Open-Meteo | None | 60 min | Cloud cover, pressure, temperature forecasts |
| `ocean-waves.mjs` | Open-Meteo Marine | None | 60 min | Wave/swell model forecasts |
| `coastline-model.mjs` | Static model | None | — | Beach geometry, fetch distances, terrain obstacles |

## Data Sources

- **WeatherFlow/iKitesurf**: Station wind data via authenticated API (Playwright headless login for HttpOnly cookies)
- **NDBC**: `https://www.ndbc.noaa.gov/data/realtime2/{id}.txt` and `.spec` — buoy met + spectral wave data
- **NOAA CO-OPS**: Tide predictions/observations, station 1615680 (Kahului Harbor)
- **NWS**: `api.weather.gov` — forecasts + alerts for Kanaha grid point (HFO/213,126)
- **Open-Meteo**: Atmosphere + marine wave models. Free, no auth.

## Sensor Network

See `CONTEXT.md` for full details. Key stations:
- **Kanaha (166192)**: Gold standard — paid/maintained WeatherFlow sensor
- **Kahului Airport (643)**: FAA ASOS — thermal spread reference
- **Upolu Airport (188392)**: Big Island upwind predictor, 1-2h lead time
- **NDBC 51004**: Primary upwind trade indicator (SE Hawaii)
- **NDBC 51205 (Pauwela)**: North shore wave truth + SST reference

## Cron Schedule

System crontab (no LLM tokens):
```
*/15 * * * * TZ=Pacific/Honolulu h=$(date +%H); [ "$h" -ge 6 ] && [ "$h" -le 19 ] && cd /path/to/maui-wx && bash log-report.sh
```

## Requirements

- Node.js 22+
- Playwright (for WeatherFlow auth): `npx playwright install chromium`
- Python 3 (for JSONL formatting in log-report.sh)

## Directory Structure

```
maui-wx/
├── CONTEXT.md              ← Domain knowledge for LLM
├── AGENTS.md               ← Agent bootstrap instructions
├── README.md               ← This file
├── equipment-profiles.json ← Equipment correlations
├── kanaha-report.mjs       ← Orchestrator
├── log-report.sh           ← Cron data logger
├── modules/                ← Data collection + analysis modules
│   ├── wind-prediction.mjs
│   ├── isthmus-thermal.mjs
│   ├── windswell-analysis.mjs
│   ├── equipment-rec.mjs
│   ├── buoy-ndbc.mjs
│   ├── tides-noaa.mjs
│   ├── forecast-nws.mjs
│   ├── pressure-meteo.mjs
│   ├── ocean-waves.mjs
│   ├── coastline-model.mjs
│   ├── daily-briefing.mjs
│   └── wind-iktrrm.mjs
├── output/
│   ├── cache/              ← Per-module cached data (TTL-based)
│   └── log/                ← Historical JSONL (YYYY-MM-DD.jsonl)
└── pull-all.sh             ← Legacy: run all modules individually
```
