# Session Debrief Format

Each debrief is a JSON file named `YYYY-MM-DD.json`.
Multiple sessions on the same day use `YYYY-MM-DD-2.json` etc.

## Purpose

Build a ground-truth dataset mapping forecast variables → actual conditions → rider experience.
Over time this becomes a calibration dataset for tuning thresholds, verdicts, and detection logic.

## File naming

```
debriefs/
  2026-03-04.json      ← first session that day
  2026-03-04-2.json    ← second session
  README.md            ← this file
```

## Schema

```json
{
  "date": "YYYY-MM-DD",
  "session_window": "12:00-16:00 HST",
  "session_type": "kite_foil | wave_foil | no_go",

  "forecast": {
    "verdict": "GOOD | FAIR | MARGINAL | NO_GO",
    "predicted_avg_kts": 17.5,
    "predicted_gust_kts": 24.5,
    "predicted_dir": "ENE",
    "predicted_dir_deg": 67,
    "predicted_gust_ratio": 1.40,
    "predicted_regime": "active_trades",
    "wind_shadow_risk": false,
    "predicted_surf_ft": 2.5,
    "predicted_swell_dir": "ENE",
    "predicted_swell_period_s": 7,
    "equipment_rec": "3.4m, 24m, HA780, Glide220",
    "alerts": []
  },

  "actual": {
    "avg_kts_range": "15-20",
    "gust_kts_peak": 28,
    "dir_deg": 88,
    "dir_text": "E",
    "gust_ratio_experienced": 1.67,
    "surf_ft": "2-3",
    "swell_character": "short choppy windswell",
    "wind_shadow_present": true,
    "wind_shadow_extent_m": 500,
    "wind_line_present": true,
    "near_shore_quality": "poor | fair | good | excellent",
    "open_water_quality": "poor | fair | good | excellent",
    "launch_difficulty": "easy | moderate | difficult | body_drag_required"
  },

  "equipment_used": {
    "kite": "3.4m",
    "lines": "24m",
    "front_wing": "HA780",
    "tail_wing": "Glide220",
    "mast_cm": 85,
    "board": "NF Pro 4'2\""
  },

  "verdict": {
    "forecast_accuracy": "accurate | over_forecast | under_forecast | wrong_direction",
    "session_quality": 1,
    "session_quality_desc": "1=unrideable 2=poor 3=marginal 4=fair 5=good 6=excellent",
    "would_go_again": true,
    "equipment_correct": false,
    "equipment_notes": "should have used 2.2m — 3.4m was too much in gusts"
  },

  "observations": {
    "free_text": "Detailed notes on what you experienced",
    "anomalies": ["wind shadow extended 500m offshore", "dramatic wind line"],
    "new_patterns": ["isthmus direction rotation = E shadow condition"]
  },

  "sensor_actuals": {
    "kanaha_avg": null,
    "kanaha_gust": null,
    "kanaha_dir_deg": null,
    "upwind_dir_deg": null,
    "dir_divergence_deg": null,
    "isthmus_temp_c": null,
    "ocean_temp_c": null,
    "thermal_delta_c": null
  }
}
```

## Quality Scale

| Score | Label | Description |
|-------|-------|-------------|
| 1 | Unrideable | Could not ride — wind shadow, too gusty, or no wind |
| 2 | Poor | Got on water but conditions were very difficult |
| 3 | Marginal | Rideable but not enjoyable — frequent falls, fatigue |
| 4 | Fair | OK session, some good runs, some difficult moments |
| 5 | Good | Solid session, mostly powered, enjoyable |
| 6 | Excellent | Perfect conditions — steady, powered, great water state |

## Forecast Accuracy Labels

| Label | Meaning |
|-------|---------|
| `accurate` | Forecast matched reality within ±3kts and correct character |
| `over_forecast` | Forecast predicted better conditions than actual |
| `under_forecast` | Forecast predicted worse conditions than actual |
| `wrong_direction` | Direction prediction was significantly off |
| `missed_hazard` | Forecast missed a specific hazard (shadow, squall, etc.) |
