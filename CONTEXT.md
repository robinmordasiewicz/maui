# CONTEXT.md — Kanaha Watersport Forecast System

> **This file is the knowledge base for the LLM agent.** Read this before interpreting any forecast data. It contains domain knowledge, physics models, calibration notes, and equipment logic that cannot be derived from raw sensor data alone.

---

## Timezone: HST (UTC-10) — ALWAYS

**All times in this system are Hawaii Standard Time.** Your host machine may be in any timezone — ignore it. The report JSON provides `time_hst` and `hour_hst` fields. Use those for all reasoning about current conditions, session windows, thermal state, and forecasts. Never use your system clock for Kanaha analysis.

## Location: Kanaha Beach Park, North Shore Maui, Hawaii

- GPS: 20.895°N, 156.460°W
- Shore normal: 30° NNE (0° = onshore)
- Primary launch: Kite Beach (western end of Kanaha)
- Primary riding area: Inside section between shore and Old Mans reef

---

## Wind Physics

### Trade Winds
- Prevailing NE-E trades driven by North Pacific subtropical high
- Typical range: 15-30 kts when active
- Best direction for Kanaha: NE (45°) — side-onshore, long fetch along north shore
- E wind (90°) = more cross-shore, shorter fetch, choppier windswell
- NNE/N wind = more onshore, usually indicates sea breeze dominance or trades dying

### Maui Isthmus Thermal Effect
The isthmus is the flat low-lying area connecting Haleakala (east) and West Maui Mountains. This geography creates unique wind amplification:

1. **Solar heating**: Isthmus heats up in sunshine → sea breeze pulls cool air onshore from the north
2. **Trade + thermal interaction**: Combined trades + sea breeze creates side-onshore wind at Kanaha
3. **Venturi compression**: Mountains on both sides compress airflow through the isthmus gap
4. **No trades = pure sea breeze**: Light 12-15kt northerly/NNW — enough for big kite
5. **Light trades + hot isthmus = sweet spot**: 15-22kts NE — best conditions
6. **Strong trades overpower thermal**: 25-40kts E, gusty — manageable but demanding

### Wind Regimes
| Regime | Trade kts | Thermal | Result at Kanaha |
|--------|-----------|---------|------------------|
| `calm` | <5 | none | No wind — no session |
| `pure_sea_breeze` | <5 | hot isthmus | 12-15kts N/NNW |
| `light_trades` | 5-12 | weak | 10-15kts NE, inconsistent |
| `trades_plus_thermal` | 8-15 | strong | 15-22kts NE — **sweet spot** |
| `trades_dominant` | 15-22 | adds power | 18-28kts ENE |
| `trades_overpowering` | 22+ | overwhelmed | 25-40kts E, gusty |

### Diurnal Pattern
- **Peak wind: 11:00-14:00 HST** — sun overhead, maximum thermal boost
- Wind decays after 14h as thermal component fades
- By 19h (sunset), only synoptic base remains
- Evening surges are exceptions, not the norm
- **Cloud cover is the #1 uncertainty**: kills thermal component by blocking solar heating of isthmus

### Wind Prediction Architecture
- **Synoptic base**: Estimated from evening retention + Upolu upwind reading + far-field buoys (median of three)
- **Thermal boost**: Peaks 11-14h, decays linearly to 0 by 19h; modulated by cloud cover and land-sea temperature differential
- **Per-hour cloud forecast**: From Open-Meteo; single biggest prediction improvement
- **Kanaha-Airport spread**: Live thermal indicator; spread >3kts = thermal active; ≈0 = pure synoptic; negative = thermal dead

---

## Sensor Network

### Primary Station
- **Kanaha (166192)**: Paid/maintained WeatherFlow sensor — **gold standard**. All other stations are relative signal only. Never compare raw kts across stations.

### Local Reference
- **Kahului Airport (643)**: FAA ASOS — maintained, reliable, slight inland offset. Good for thermal spread calculation (Kanaha minus Airport = thermal contribution).
- **Kahului Harbor (4349)**: Sheltered harbor, reads low. Cross-reference only.
- **Maalaea (642710)**: South gap exit of isthmus. Maalaea/Kanaha ratio >0.8 = venturi active; <0.5 = venturi weak.

### Upwind Predictors (Big Island)
- **Upolu Airport (188392)**: ~100 miles upwind. Mostly synoptic (no thermal). 1-2 hour lead time for trade changes.
- **HELCO Upolu (681478)**: Adjacent to Upolu Airport. Cross-reference.
- **Calibration note**: Never compare raw kts between stations. Use gust-to-avg ratios, direction shifts, and self-relative trends.

### Isthmus Thermal Stations (7 total)
Weighted average for isthmus heat index:
| Station | ID | Weight | Notes |
|---------|------|--------|-------|
| Hansen Rd | 645600 | 1.5 | Central, low elevation — best thermal indicator |
| Kahului Airport | 643 | 1.2 | Reliable, maintained |
| Haleakala Hwy | 645598 | 1.0 | East side |
| Veterans Hwy | 645604 | 0.8 | South |
| Upper Division Rd | 645602 | 0.8 | Southeast |
| Haleakala Hwy 2 | 681503 | 0.7 | Far east |
| Maalaea | 642710 | 0.7 | South gap |

### NDBC Buoy Network
| Buoy | Location | Role |
|------|----------|------|
| 51004 | SE Hawaii (17.5°N, 152.2°W) | **Primary upwind trade indicator** — synoptic wind truth |
| 51002 | SW Hawaii (17.1°N, 157.8°W) | Cross-reference |
| 51000 | N Hawaii (23.5°N, 153.8°W) | North reference — trades taper here first when pattern weakens |
| 51001 | NW Hawaii (23.4°N, 162.3°W) | **Groundswell early warning** — do NOT use for wind (downwind of trades) |
| 51205 | Pauwela, north shore | **Wave truth** — local swell + SST reference for thermal model |
| 51202 | Mokapu | Cross-reference |

---

## Wave & Swell

### Windswell vs Groundswell — Critical Distinction
- **Windswell**: Locally generated by trade winds. Period 3-8 seconds. Builds and dies with wind. Best from NE direction (45-70°) = long fetch along north shore → clean organized bumps for downwind foiling.
- **Groundswell**: Generated by distant North Pacific storms. Period 10-20 seconds. Arrives independent of local wind. Can be overhead+ and dangerous. Direction typically NNW-NW.

### Why It Matters
- **Downwind foiling** needs windswell bumps to glide on — period, height, and direction all matter
- **NE trade fetch** along north shore produces the best organized bumps
- **E wind** = cross-shore, shorter fetch, choppier/messier
- **Groundswell** changes the game entirely — board choice becomes safety-critical (duck diving)

### Swell Warning
- NDBC 51001 (NW) and 51000 (N) detect incoming groundswell before it reaches Pauwela
- Compare outer buoy swell height to Pauwela — divergence = swell incoming

---

## Bathymetry: Kanaha to Old Mans Reef

```
Shore ──── 200m ──── 300m ──── 400m+ ──── Old Mans Reef
             │          │          │              │
 AT MLLW:  waist     shoulder   chest+      waist (reef top)
 (0ft tide) ~0.9m     ~1.3m     ~1.5m+        ~0.9m
```

- **Old Mans reef top** is the shallowest hazard — this is where foil masts strike bottom
- NOAA tide level is referenced to MLLW (Mean Lower Low Water)
- **Depth at reef** = 0.9m + (tide_ft × 0.3048m)
- **Safe mast** = reef depth − 15cm clearance

### Mast Selection
**Mast is chosen once per session (typically ~2 hours), not changed during the session.**

The decision depends on **riding style + tide during the session window**:

**Freeride foil** (windswell / sub-shoulder groundswell):
- **Default: 85cm** — standard freeride mast
- **Low tide session (reef <~95cm): 72cm** — protect equipment from reef strikes
- Longer mast = more stability and lift, but reef strike risk at low tide

**Wave foil** (overhead groundswell): TBD

The equipment-rec module should identify the **minimum tide level during the planned 2-hour session window** and recommend a single mast for the session, not suggest changes mid-session.

### Session Constraints
- **Kiting not legal before 11:00 AM** — Kanaha Beach Park rule
- **Earliest realistic arrival: ~11:00 AM** — earliest session start is noon
- **Weekday cutoff: 4:00 PM** — off the water by 4pm when working next day
- **Weekend cutoff: 5:00 PM** — wind usually tapering by then anyway
- **Session duration: ~2 hours**

---

## Equipment — Rider: Robin

### Riding Style 1: Freeride Foil
**Conditions**: Windswell and small-to-medium groundswell. Emphasis on glide, efficiency, bump riding.

**Board**: Armstrong Noah Flegel Pro Board, 4'2", 19L

**Wind → Equipment Matrix:**
| Wind (kts) | Regime | Kite | Lines | Front Wing | Tail Wing |
|------------|--------|------|-------|-----------|-----------|
| 12-15 | Sea breeze | 5.0m | 26m | HA1080 | Glide220 |
| 14-17 | Light trades | 4.0m | 25m | HA1080 | Glide220 |
| 15-18 | Light trades+ | 4.0m | 25m | HA780 | Glide220 |
| 15-20 | Trades active | 3.4m | 24m | HA780 | Glide220 |
| 20-22 | Trades strong | 2.2m | 24m | HA780 | Glide220 |
| 22-25 | Trades powered | 2.2m | 22m | UHA570 | Glide220 |
| 25-30 | Trades full | 2.2m | 18-20m | UHA570 | Speed180 |
| 30+ | Overpowering | 2.2m | 16-18m | UHA570 | Speed180 |

**Pattern**: As wind increases → reduce kite size → shorten lines → shrink front wing → switch to speed tail. Each step depowers progressively.

### Gust Factor — Equipment Sizing
Equipment is sized differently based on steady vs gust values:
- **Kite + lines**: Sized to **gust value** — must handle blasts safely. Being overpowered is dangerous.
- **Front wing**: Sized to **steady value** — need lift in lulls to stay on foil.
- **Tail wing**: Switch to Speed180 when **gusts exceed 25kts**.

| Gust Ratio | Delta | Quality | Meaning |
|------------|-------|---------|---------|
| 1.0–1.2x | 0–20% | Smooth | Consistent power, size to steady, most favorable |
| 1.2–1.35x | 20–35% | Moderate | Normal trades, kite for gusts, wing for steady |
| 1.35–1.5x | 35–50% | Gusty | Demanding, kite must handle blasts, rider fatigue |
| 1.5x+ | 50%+ | Very gusty | Expert only, dangerous swings, everything sized for gusts |

**Note**: 2.8m kite is owned but typically skipped — jump from 3.4m straight to 2.2m.

### Riding Style 2: Wave Foil
**Conditions**: Overhead+ groundswell (10+ second period, 1.5m+ face height)

**Board**: Naish Hover Macro Chip, 3'3⅜" (100cm), 9L, 1.92kg — **safety-critical**. Low volume required for duck diving under breaking waves on wipeouts. Too much buoyancy = can't get under crashing waves. This is not optional in big surf.

**Kite/wing/line matrix**: TBD

### Equipment Inventory

**Kites**: 2.2m, 2.8m, 3.4m, 4.0m, 5.0m

**Front Wings (Armstrong)**:
- HA1080: 1080cm², high aspect — maximum lift/glide, lightest wind
- HA780: 780cm², high aspect — versatile, moderate wind
- UHA570: 570cm², ultra high aspect — strong wind, speed-oriented, less drag

**Tail Wings (Armstrong)**:
- Glide220: 220cm² — maximum glide/stability, pairs with larger fronts
- Speed180: 180cm² — less drag, more speed, 25+ kts

**Boards**:
- Armstrong Noah Flegel Pro 4'2" 19L — freeride/small wave
- 3'10" 8L — big wave duck diving

**Masts**: 72cm, 85cm, 90cm, 100cm

**Kite Lines**: 16m, 18m, 20m, 22m, 24m, 25m, 26m

---

## Confidence & Calibration Notes

- **Kanaha sensor is truth** — all other stations are relative only
- **Cloud cover is the #1 forecast uncertainty** — kills thermal component
- **Per-hour cloud forecast** from Open-Meteo was the single biggest prediction improvement
- **Far-field buoys** (51004, 51002) hold steady when Kanaha drops = local suppression, not synoptic change
- **Upolu barely moves when Kanaha drops** = synoptic stable, thermal component died
- **First verification**: Predicted 17.7kts at 5pm, actual 14.2kts (−3.5kts, 20%). Root cause: cloud cover increased from 78% to 100%. Synoptic base estimate was close (15kts predicted vs 14.2 actual).

---

## Data Sources & API Endpoints
- **WeatherFlow/iKitesurf**: Authenticated via Playwright headless login (HttpOnly cookies). `getSpotDetailSetByList` API for station data.
- **NDBC**: `https://www.ndbc.noaa.gov/data/realtime2/{id}.txt` (met) and `.spec` (spectral wave). Case-sensitive IDs.
- **NOAA Tides**: CO-OPS API, station 1615680 (Kahului Harbor)
- **NWS**: `api.weather.gov` — forecasts + alerts for Kanaha grid point
- **Open-Meteo**: Atmosphere (clouds, pressure, temperature) + ocean waves. Free, no auth.

---

## System Architecture

```
Sensors → Scripts (deterministic, cached) → JSON → LLM (interpretation)
```

- **Scripts pull data programmatically** on cron (every 15 min during daylight HST)
- **Scripts compute all analysis deterministically**: verdicts, anomalies, correlations, confidence, equipment recs
- **LLM is the analyst**: reads pre-computed JSON, adds pattern recognition, natural language, judgment
- **Historical data** accumulates in `output/log/YYYY-MM-DD.jsonl` for model refinement

### Module Map
| Module | Function | TTL |
|--------|----------|-----|
| `wind-prediction.mjs` | Wind + upwind + thermal analysis | 15 min |
| `isthmus-thermal.mjs` | Isthmus heat + regime classification | 15 min |
| `windswell-analysis.mjs` | Swell decomposition + foil rating | 30 min |
| `equipment-rec.mjs` | Mast + kite + wing recommendations | 30 min |
| `buoy-ndbc.mjs` | NDBC buoy data (met + spectral) | 30 min |
| `tides-noaa.mjs` | NOAA tide predictions + observations | 12 hr |
| `forecast-nws.mjs` | NWS forecast + alerts | 60 min |
| `pressure-meteo.mjs` | Open-Meteo atmosphere | 60 min |
| `ocean-waves.mjs` | Open-Meteo wave model | 60 min |
| `coastline-model.mjs` | Beach geometry + fetch model | static |
| `kanaha-report.mjs` | Orchestrator — runs all modules, outputs report | — |
