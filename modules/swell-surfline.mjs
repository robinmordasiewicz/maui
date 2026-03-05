#!/usr/bin/env node
/**
 * swell-surfline.mjs — Surfline wave & swell forecast for Ka'a (Kanaha), Maui
 *
 * Surfline provides surf height in feet, per-swell component breakdown
 * (height, period, direction, impact), and a surf quality rating.
 * No authentication required — public API.
 *
 * Spot ID: 5842041f4e65fad6a7708890 (Ka'a / Kanaha north shore, Maui)
 *
 * Data:
 *   - Surf height (ft, min/max) — human-readable scale
 *   - Up to 6 swell components: height (ft), period (s), direction (°)
 *   - Swell impact score (0-1) — how much each swell contributes
 *   - Surf power (kJ) — energy proxy
 *   - Quality rating: POOR / POOR_TO_FAIR / FAIR / FAIR_TO_GOOD / GOOD / EPIC
 *   - Wind speed/gust (mph) and direction at spot
 *
 * Swell direction interpretation:
 *   - 270-360 / 0-90 (NW through NE) = north shore groundswell → WAVE EVENT potential
 *   - 60-100 (ENE-E) = trade windswell → normal Kanaha chop
 *   - 180-270 (S-SW) = south swell → Kihei side, no impact on Ka'a
 *
 * Usage: node swell-surfline.mjs [hours]   (default: 72)
 */

const SPOT_ID = '5842041f4e65fad6a7708890';
const BASE    = 'https://services.surfline.com/kbyg/spots/forecasts';
const HOURS   = parseInt(process.argv[2] || '72');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

// Swell direction to compass text
function dirText(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

// Is this swell from the north shore arc? (NW-NE, 270°-90° via north)
function isNorthSwell(dir) {
  return dir >= 270 || dir <= 90;
}

// Surfline quality key → score 1-6
const QUALITY_SCORE = {
  'POOR': 1, 'POOR_TO_FAIR': 2, 'FAIR': 3,
  'FAIR_TO_GOOD': 4, 'GOOD': 5, 'EPIC': 6,
};

async function fetchJson(endpoint, params) {
  const url = `${BASE}/${endpoint}?spotId=${SPOT_ID}&days=${Math.ceil(HOURS/24)+1}&intervalHours=1&${params}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`Surfline ${endpoint} HTTP ${r.status}`);
  return r.json();
}

async function main() {
  process.stderr.write('swell-surfline: fetching wave data... ');
  const [waveResp, ratingResp] = await Promise.all([
    fetchJson('wave', ''),
    fetchJson('rating', ''),
  ]);
  process.stderr.write('done\n');

  const waveData   = waveResp.data?.wave   || [];
  const ratingData = ratingResp.data?.rating || [];
  const utcOffset  = waveResp.associated?.utcOffset ?? -10; // HST

  // Build rating lookup by timestamp
  const ratingByTs = {};
  for (const r of ratingData) ratingByTs[r.timestamp] = r.rating;

  const forecast = waveData.slice(0, HOURS).map(w => {
    // Convert UTC timestamp to HST local time string
    const localMs  = (w.timestamp + utcOffset * 3600) * 1000;
    const localDt  = new Date(localMs);
    const pad      = n => String(n).padStart(2, '0');
    const timeLocal = `${localDt.getUTCFullYear()}-${pad(localDt.getUTCMonth()+1)}-${pad(localDt.getUTCDate())} ${pad(localDt.getUTCHours())}:00`;

    // Filter active swells (height > 0)
    const swells = w.swells
      .filter(s => s.height > 0)
      .map(s => ({
        height_ft:   Math.round(s.height * 10) / 10,
        period_s:    s.period,
        direction_deg: Math.round(s.direction),
        direction_txt: dirText(s.direction),
        is_north:    isNorthSwell(s.direction),
        impact:      Math.round(s.impact * 100) / 100,  // 0-1, fraction of surf from this swell
        power_kj:    Math.round(s.power),
        optimal_score: s.optimalScore,
      }));

    const rating = ratingByTs[w.timestamp];
    const northSwells = swells.filter(s => s.is_north);
    const maxNorthHt  = northSwells.length > 0 ? Math.max(...northSwells.map(s => s.height_ft)) : 0;
    const maxNorthPer = northSwells.length > 0 ? Math.max(...northSwells.map(s => s.period_s)) : 0;

    return {
      time_local:     timeLocal,
      timestamp_utc:  w.timestamp,
      surf_min_ft:    w.surf.min,
      surf_max_ft:    w.surf.max,
      surf_plus:      w.surf.plus,           // true if occasionally bigger sets
      surf_label:     w.surf.humanRelation,  // e.g. "Waist to shoulder"
      power_kj:       Math.round(w.power),
      swells,
      north_swell_ft:  maxNorthHt,
      north_swell_period_s: maxNorthPer,
      wave_event:     maxNorthHt >= 2 && maxNorthPer >= 14, // ≥2ft@14s NW = notable
      cancel_plans:   maxNorthHt >= 4 && maxNorthPer >= 14, // serious north swell
      quality_key:    rating?.key || null,
      quality_score:  rating ? (QUALITY_SCORE[rating.key] || 0) : null,
    };
  });

  // Session window summary — today's session hours
  const now = new Date();
  const hstNow = new Date((now.getTime() + utcOffset * 3600000));
  const todayHst = hstNow.toISOString().substring(0, 10);

  const sessionHours = forecast.filter(f => {
    const dateStr = f.time_local.substring(0, 10);
    const hour    = parseInt(f.time_local.substring(11, 13));
    return dateStr === todayHst && hour >= 11 && hour <= 17;
  });

  const avgSurf = sessionHours.length > 0
    ? Math.round((sessionHours.reduce((a, f) => a + (f.surf_min_ft + f.surf_max_ft) / 2, 0) / sessionHours.length) * 10) / 10
    : null;

  // Find dominant swells across session window
  const swellMap = {};
  for (const f of sessionHours) {
    for (const s of f.swells) {
      const key = `${s.direction_txt}_${s.period_s}s`;
      if (!swellMap[key]) swellMap[key] = { ...s, count: 0, total_impact: 0 };
      swellMap[key].count++;
      swellMap[key].total_impact += s.impact;
    }
  }
  const dominantSwells = Object.values(swellMap)
    .filter(s => s.count >= sessionHours.length * 0.5)
    .sort((a, b) => b.total_impact - a.total_impact)
    .slice(0, 3);

  const output = {
    source:       'swell-surfline',
    location:     "Ka'a (Kanaha), Maui HI",
    spot_id:      SPOT_ID,
    fetched_utc:  new Date().toISOString(),
    units:        { surf: 'ft', swell_height: 'ft', period: 's', direction: 'deg', power: 'kJ' },
    session_summary: {
      date_hst:        todayHst,
      avg_surf_ft:     avgSurf,
      dominant_swells: dominantSwells,
      any_wave_event:  sessionHours.some(f => f.wave_event),
      any_cancel_plans: sessionHours.some(f => f.cancel_plans),
    },
    forecast,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
