#!/usr/bin/env node
/**
 * kanaha-report.mjs — Single-command Kanaha watersport report
 *
 * Pulls all data, runs all analysis, outputs a complete human-readable
 * report to stdout. Designed to be called programmatically with zero
 * LLM interpretation needed.
 *
 * Data pull intervals (when run via cron/heartbeat):
 *   - WeatherFlow stations: every 15 min (real-time wind)
 *   - NDBC buoys: every 30 min (met + spectral)
 *   - Open-Meteo atmosphere: every 60 min (cloud/pressure forecast)
 *   - NOAA tides: once per day (predictions don't change)
 *   - NWS forecast: every 60 min
 *
 * Caching: stores last pull timestamps and data in output/cache/
 * to avoid redundant API calls. Each data source has its own TTL.
 *
 * Usage:
 *   node kanaha-report.mjs              # full report, text
 *   node kanaha-report.mjs --json       # full report, JSON
 *   node kanaha-report.mjs --wind-only  # quick wind check (no Playwright)
 *   node kanaha-report.mjs --no-cache   # force fresh pull
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULES = join(__dirname, 'modules');
const CACHE_DIR = join(__dirname, 'output', 'cache');
const JSON_MODE = process.argv.includes('--json');
const WIND_ONLY = process.argv.includes('--wind-only');
const NO_CACHE = process.argv.includes('--no-cache');

mkdirSync(CACHE_DIR, { recursive: true });

// ── Cache TTLs (seconds) ─────────────────────────────────────────────
const TTL = {
  'wind-prediction':    15 * 60,   // 15 min — real-time wind
  'wind-iktrrm':        60 * 60,   // 1 hour — iK-TRRM premium model forecast
  'isthmus-thermal':    15 * 60,   // 15 min — same Playwright session
  'windswell-analysis': 30 * 60,   // 30 min — NDBC buoys
  'buoy-ndbc':          30 * 60,   // 30 min
  'pressure-meteo':     60 * 60,   // 1 hour — forecast model
  'ocean-waves':        60 * 60,   // 1 hour
  'forecast-nws':       60 * 60,   // 1 hour
  'equipment-rec':      30 * 60,   // 30 min — follows tides
  'tides-noaa':         12 * 3600, // 12 hours — predictions stable
};

// ── Cache helpers ────────────────────────────────────────────────────
function cacheGet(key) {
  if (NO_CACHE) return null;
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const age = (Date.now() - raw._cached_at) / 1000;
    if (age > (TTL[key] || 900)) return null;
    raw._cache_age_s = Math.round(age);
    return raw;
  } catch { return null; }
}

function cacheSet(key, data) {
  const path = join(CACHE_DIR, `${key}.json`);
  try {
    writeFileSync(path, JSON.stringify({ ...data, _cached_at: Date.now() }));
  } catch { /* ignore cache write failures */ }
}

// ── Module runner with caching ───────────────────────────────────────
function runModule(name, args = '') {
  const cached = cacheGet(name);
  if (cached) {
    process.stderr.write(`  [${name}] cached (${cached._cache_age_s}s old)\n`);
    return cached;
  }
  try {
    process.stderr.write(`  [${name}] pulling...\n`);
    const cmd = `node ${join(MODULES, name + '.mjs')} ${args}`;
    const out = execSync(cmd, { timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
    const data = JSON.parse(out.toString());
    cacheSet(name, data);
    return data;
  } catch (e) {
    process.stderr.write(`  [${name}] FAILED: ${e.message?.slice(0, 80)}\n`);
    // Fall back to stale cache
    const stale = (() => { try { return JSON.parse(readFileSync(join(CACHE_DIR, `${name}.json`), 'utf-8')); } catch { return null; } })();
    if (stale) { process.stderr.write(`  [${name}] using stale cache\n`); return stale; }
    return null;
  }
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }).on('error', reject);
  });
}

// ── HST time helpers ─────────────────────────────────────────────────
function hstNow() {
  return new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu' });
}
function hstHour() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', hour12: false }));
}
function hstDate() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 10);
}

// ── Verdict engine (fully deterministic) ─────────────────────────────
function computeVerdict(windAvg, windDir, gustRatio, thermalDrive, swellHt, tideLevel, alerts) {
  const verdicts = [];

  // Wind assessment
  if (windAvg >= 18 && windAvg <= 28 && gustRatio < 1.4) {
    verdicts.push({ activity: 'kitesurfing', rating: 'EPIC', score: 5 });
    verdicts.push({ activity: 'windsurfing', rating: 'EPIC', score: 5 });
  } else if (windAvg >= 15 && windAvg <= 35) {
    verdicts.push({ activity: 'kitesurfing', rating: 'GOOD', score: 4 });
    verdicts.push({ activity: 'windsurfing', rating: windAvg >= 18 ? 'GOOD' : 'MARGINAL', score: windAvg >= 18 ? 4 : 2 });
  } else if (windAvg >= 12) {
    verdicts.push({ activity: 'kitesurfing', rating: 'MARGINAL', score: 2 });
    verdicts.push({ activity: 'windsurfing', rating: 'NO-GO', score: 0 });
  } else {
    verdicts.push({ activity: 'kitesurfing', rating: 'NO-GO', score: 0 });
    verdicts.push({ activity: 'windsurfing', rating: 'NO-GO', score: 0 });
  }

  // Wing/downwind foil
  if (windAvg >= 12 && windAvg <= 22 && swellHt >= 0.5) {
    verdicts.push({ activity: 'downwind foil', rating: 'GOOD', score: 4 });
  } else if (windAvg >= 10 && swellHt >= 0.3) {
    verdicts.push({ activity: 'downwind foil', rating: 'FAIR', score: 3 });
  }

  // Gustiness penalty
  if (gustRatio > 1.5) {
    for (const v of verdicts) { v.score = Math.max(0, v.score - 1); v.notes = (v.notes || '') + ' Gusty. '; }
  }

  // Alert override
  if (alerts?.length > 0) {
    for (const v of verdicts) v.alert = alerts[0].event || alerts[0];
  }

  const best = verdicts.sort((a, b) => b.score - a.score)[0];
  return { verdicts, best };
}

// ── Format helpers ───────────────────────────────────────────────────
function dirArrow(dir) {
  const arrows = { N: '↓', NNE: '↓', NE: '↙', ENE: '←', E: '←', ESE: '←', SE: '↖', SSE: '↑', S: '↑', SSW: '↑', SW: '↗', WSW: '→', W: '→', WNW: '→', NW: '↘', NNW: '↓' };
  return arrows[dir] || '';
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const reportTime = hstNow();
  const hour = hstHour();
  process.stderr.write(`\n=== Kanaha Report — ${reportTime} HST ===\n`);

  // ── Pull data ──────────────────────────────────────────────────────
  // Core wind data (requires Playwright login)
  const windPred = runModule('wind-prediction');
  const thermal = WIND_ONLY ? null : runModule('isthmus-thermal');

  // iK-TRRM premium forecast model (hourly predictions)
  const iktrrm = runModule('wind-iktrrm', '48');

  // NDBC + waves (no auth needed)
  const windswellEnv = windPred?.upwind_analysis?.kanaha_avg
    ? `WIND_SPEED_KTS=${windPred.upwind_analysis.kanaha_avg} WIND_DIR_DEG=${{'N':0,'NNE':22.5,'NE':45,'ENE':67.5,'E':90,'ESE':112.5,'SE':135}[windPred.upwind_analysis.kanaha_dir] || 60}`
    : 'WIND_SPEED_KTS=15 WIND_DIR_DEG=60';

  let windswell = null;
  if (!WIND_ONLY) {
    const cached = cacheGet('windswell-analysis');
    if (cached) {
      windswell = cached;
      process.stderr.write('  [windswell-analysis] cached\n');
    } else {
      try {
        process.stderr.write('  [windswell-analysis] pulling...\n');
        const out = execSync(`${windswellEnv} node ${join(MODULES, 'windswell-analysis.mjs')}`, { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
        windswell = JSON.parse(out.toString());
        cacheSet('windswell-analysis', windswell);
      } catch (e) { process.stderr.write(`  [windswell-analysis] FAILED\n`); }
    }
  }

  const tides = WIND_ONLY ? null : runModule('tides-noaa', '3');
  const nws = WIND_ONLY ? null : runModule('forecast-nws');
  const meteo = WIND_ONLY ? null : runModule('pressure-meteo', '3');

  // Equipment recommendations (uses tide data)
  let equipment = null;
  if (!WIND_ONLY) {
    const eqCached = cacheGet('equipment-rec');
    if (eqCached) {
      equipment = eqCached;
      process.stderr.write('  [equipment-rec] cached\n');
    } else {
      try {
        process.stderr.write('  [equipment-rec] pulling...\n');
        const envStr = `WIND_AVG_KTS=${windPred?.upwind_analysis?.kanaha_avg || 0} WIND_GUST_KTS=${windPred?.station_network?.find(s => s.id === 166192)?.gust || 0}`;
        const out = execSync(`${envStr} node ${join(MODULES, 'equipment-rec.mjs')}`, { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
        equipment = JSON.parse(out.toString());
        cacheSet('equipment-rec', equipment);
      } catch (e) { process.stderr.write('  [equipment-rec] FAILED\n'); }
    }
  }

  // ── Extract key values ─────────────────────────────────────────────
  const ua = windPred?.upwind_analysis || {};
  const windAvg = ua.kanaha_avg || 0;
  const windDir = ua.kanaha_dir || '?';
  const gustRatio = ua.kanaha_gust_ratio || 1.0;
  const kanahaGust = windPred?.station_network?.find(s => s.id === 166192)?.gust;

  const atm = windPred?.atmosphere || {};
  const cloudPct = atm.cloud_cover?.current_pct;
  const pressureTrend = atm.pressure_trend_3h_hpa;

  const thermalState = thermal?.thermal_state;
  const isthmusTemp = thermal?.isthmus_heat?.weighted_avg_c;
  const oceanTemp = thermal?.ocean_reference_temp_c;
  const landSeaDiff = thermalState?.land_sea_diff_c;
  const regime = thermalState?.wind_regime;

  const swellObs = windswell?.current_conditions;
  const windswellHt = swellObs?.windswell?.height_m || 0;
  const groundswellHt = swellObs?.groundswell?.height_m || 0;
  const foilRating = windswell?.downwind_foiling?.downwind_foil_rating;
  const swellWarnings = windswell?.groundswell_early_warning || [];

  const alerts = nws?.alerts || [];
  const tideList = tides?.high_low || [];
  const currentTide = tides?.latest_observed;

  // Taper prediction
  const taper = windPred?.taper_prediction || [];
  const synBase = windPred?.thermal_analysis?.estimated_synoptic_base_kts;

  // Buoys
  const buoys = windPred?.buoy_data || {};

  // Upwind stations
  const medUpwind = ua.medium_upwind || [];

  // Verdict
  const { verdicts, best } = computeVerdict(windAvg, windDir, gustRatio, thermalState?.thermal_drive?.strength, windswellHt, currentTide?.level_ft, alerts);

  // ── Build report ───────────────────────────────────────────────────
  const report = {
    time_hst: reportTime,
    hour_hst: hour,

    verdict: best ? `${best.score >= 4 ? '🟢' : best.score >= 2 ? '🟡' : '🔴'} ${best.activity.toUpperCase()}: ${best.rating}` : '🔴 NO DATA',
    alerts: alerts.map(a => a.headline || a.event),

    wind: {
      current_kts: windAvg,
      gust_kts: kanahaGust,
      direction: windDir,
      gust_ratio: gustRatio,
      upwind_trend: ua.trend,
      upwind_note: ua.prediction,
      far_field: ua.far_field_outlook,
    },

    thermal: thermalState ? {
      isthmus_temp_c: isthmusTemp,
      ocean_temp_c: oceanTemp,
      diff_c: landSeaDiff,
      drive: thermalState.thermal_drive.strength,
      regime: regime?.type,
      regime_desc: regime?.desc,
      direction_effect: regime?.expected_dir_text,
      gustiness: regime?.gustiness,
      venturi: thermalState.venturi.rating,
      synoptic_base_kts: synBase,
    } : null,

    atmosphere: {
      cloud_pct: cloudPct,
      pressure_trend_3h: pressureTrend,
      thermal_modifier: atm.thermal_modifier,
    },

    taper: taper.map(t => ({
      hour: t.hour_hst,
      kts: t.predicted_avg_kts,
      thermal_pct: t.thermal_fraction,
      phase: t.phase,
    })),

    // iK-TRRM premium model forecast (hourly, same data as iKitesurf website graph)
    iktrrm_forecast: iktrrm?.forecast ? iktrrm.forecast.map(f => {
      // time_local is already HST e.g. "2026-03-04 15:00:00-1000"
      const match = f.time_local.match(/(\d{4}-\d{2}-\d{2}) (\d{2}):00/);
      const date = match?.[1];
      const hour = match ? parseInt(match[2]) : null;
      const ratio = f.wind_speed_kts > 0 ? Math.round((f.wind_gust_kts / f.wind_speed_kts) * 100) / 100 : null;
      return {
        date,
        hour_hst: hour,
        avg_kts: f.wind_speed_kts,
        gust_kts: f.wind_gust_kts,
        dir_deg: f.wind_dir_deg,
        dir_text: f.wind_dir_text,
        temp_c: f.temp_c,
        cloud_pct: f.cloud_cover_pct,
        humidity_pct: f.humidity_pct,
        pressure_mb: f.pressure_mb,
        gust_ratio: ratio,
      };
    }).filter(f => f.hour_hst >= 6 && f.hour_hst <= 19) : null,

    iktrrm_current: iktrrm?.current || null,

    waves: swellObs ? {
      windswell: `${swellObs.windswell.height_m}m@${swellObs.windswell.period_s}s ${swellObs.windswell.direction}`,
      groundswell: `${swellObs.groundswell.height_m}m@${swellObs.groundswell.period_s}s ${swellObs.groundswell.direction}`,
      total_m: swellObs.total_wave_ht_m,
      foil_rating: foilRating,
      trend: windswell?.windswell_trend?.trend,
    } : null,

    swell_warnings: swellWarnings.filter(w => w.signal !== 'consistent').map(w => w.note),

    buoys: Object.entries(buoys).map(([id, b]) => ({
      name: b.name,
      wind_kts: b.met?.wind_speed_kts || b.wind_speed_kts,
      dir_deg: b.met?.wind_dir_deg || b.wind_dir,
      pressure: b.met?.pressure_hpa || b.pres,
      sst_c: b.met?.water_temp_c || b.water_temp_c,
    })),

    tides: tideList.slice(0, 4).map(t => `${t.type === 'high' ? '⬆' : '⬇'} ${t.time_local} ${t.level_ft}ft`),

    activities: verdicts,

    equipment: equipment ? {
      current_mast_cm: equipment.summary?.current_mast_cm,
      current_category: equipment.summary?.current_category,
      reef_depth_cm: equipment.summary?.reef_depth_cm,
      mast_notes: equipment.summary?.mast_notes,
      kite_setup: equipment.summary?.kite_setup,
      session_windows: equipment.summary?.session_windows,
    } : null,

    nws: nws?.daily?.slice(0, 2)?.map(p => `${p.name}: ${p.forecast}`) || [],

    precipitation: buildPrecipSummary(nws, meteo),

    // ── LLM Context — pre-computed analysis for interpretation ────
    analysis: buildAnalysisContext({
      windAvg, windDir, gustRatio, kanahaGust,
      cloudPct, pressureTrend,
      thermalState, isthmusTemp, oceanTemp, landSeaDiff, regime,
      swellObs, windswellHt, groundswellHt, swellWarnings,
      taper, synBase, buoys, medUpwind, ua, hour,
      windPred, thermal,
      precip: buildPrecipSummary(nws, meteo),
    }),
  };

  // ── Output ─────────────────────────────────────────────────────────
  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

// ── Session window helper ─────────────────────────────────────────────
// Returns { start, end } in HST hours for the next available session window
function getSessionWindow() {
  const now = new Date();
  const hstStr = now.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', weekday: 'long', hour: 'numeric', hour12: false });
  const day = now.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', weekday: 'long' });
  const h = hstHour();

  const windows = {
    Monday:    { start: 12, end: 16 },
    Tuesday:   { start: 12, end: 16 },
    Wednesday: { start: 12, end: 16 },
    Thursday:  { start: 12, end: 16 },
    Friday:    { start: 12, end: 17 },
    Saturday:  { start: 11, end: 17 },
    Sunday:    { start: 11, end: 16 },
  };

  const todayWindow = windows[day] || { start: 12, end: 16 };

  // If today's window hasn't closed yet, use today
  if (h < todayWindow.end) return { ...todayWindow, date: hstDate(), day };

  // Otherwise, advance to next day's window
  const nextDayMap = { Monday: 'Tuesday', Tuesday: 'Wednesday', Wednesday: 'Thursday',
    Thursday: 'Friday', Friday: 'Saturday', Saturday: 'Sunday', Sunday: 'Monday' };
  const nextDay = nextDayMap[day];
  const nextWindow = windows[nextDay] || { start: 12, end: 16 };

  // Compute next date
  const nextDate = new Date(now);
  nextDate.setDate(nextDate.getDate() + 1);
  const nextDateStr = nextDate.toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 10);

  return { ...nextWindow, date: nextDateStr, day: nextDay };
}

// ── Precip summary for session window ────────────────────────────────
function buildPrecipSummary(nws, meteo) {
  if (!nws && !meteo) return null;

  const win = getSessionWindow();
  const hours = [];
  for (let h = win.start; h < win.end; h++) hours.push(h);

  // NWS hourly — times are ISO like "2026-03-04T12:00:00-10:00"
  const nwsHourly = (nws?.hourly || []).filter(p => {
    try {
      const d = new Date(p.time);
      const hst = d.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', hour12: false });
      const dateStr = d.toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 10);
      return dateStr === win.date && hours.includes(parseInt(hst));
    } catch { return false; }
  }).map(p => {
    const d = new Date(p.time);
    const h = parseInt(d.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', hour12: false }));
    return { hour_hst: h, pop_pct: p.precip_pct, short_forecast: p.short_forecast };
  });

  // Open-Meteo hourly — time_hst is "YYYY-MM-DDTHH:00"
  const meteoHourly = (meteo?.hourly || []).filter(p => {
    if (!p.time_hst) return false;
    const [date, time] = p.time_hst.split('T');
    const h = parseInt(time?.substring(0, 2));
    return date === win.date && hours.includes(h);
  }).map(p => {
    const h = parseInt(p.time_hst.split('T')[1]?.substring(0, 2));
    return {
      hour_hst: h,
      pop_pct: p.precip_probability_pct,
      precip_mm: p.precipitation_mm,
      rain_mm: p.rain_mm,
      showers_mm: p.showers_mm,
      is_shower: p.is_shower,
      weathercode: p.weathercode,
      cloud_pct: p.cloud_cover_pct,
    };
  });

  // Merge by hour
  const merged = hours.map(h => {
    const n = nwsHourly.find(x => x.hour_hst === h) || {};
    const m = meteoHourly.find(x => x.hour_hst === h) || {};
    // Average PoP across sources that have data
    const pops = [n.pop_pct, m.pop_pct].filter(v => v != null);
    const avgPop = pops.length ? Math.round(pops.reduce((a, b) => a + b, 0) / pops.length) : null;
    return {
      hour_hst: h,
      nws_pop_pct: n.pop_pct ?? null,
      meteo_pop_pct: m.pop_pct ?? null,
      avg_pop_pct: avgPop,
      precip_mm: m.precip_mm ?? null,
      rain_mm: m.rain_mm ?? null,
      showers_mm: m.showers_mm ?? null,
      is_shower: m.is_shower ?? false,
      cloud_pct: m.cloud_pct ?? null,
      nws_short: n.short_forecast ?? null,
    };
  });

  // Session-level summary
  const maxPop = Math.max(...merged.map(h => h.avg_pop_pct ?? 0));
  const showerHours = merged.filter(h => h.is_shower || (h.avg_pop_pct ?? 0) >= 40);
  const totalPrecipMm = merged.reduce((s, h) => s + (h.precip_mm ?? 0), 0);

  let risk = 'low';
  if (maxPop >= 70 || showerHours.length >= 2) risk = 'high';
  else if (maxPop >= 40 || showerHours.length >= 1) risk = 'moderate';

  return {
    session_window: `${win.date} ${win.start}:00-${win.end}:00 HST (${win.day})`,
    rain_risk: risk,
    max_pop_pct: maxPop,
    shower_hours: showerHours.map(h => h.hour_hst),
    total_precip_mm: Math.round(totalPrecipMm * 10) / 10,
    hourly: merged,
  };
}

// ── LLM Analysis Context Builder ─────────────────────────────────────
// Pre-computes insights, anomalies, correlations, and uncertainties
// so the LLM can interpret without re-deriving from raw data.
function buildAnalysisContext(d) {
  // d.precip passed in from caller
  const ctx = {
    anomalies: [],
    correlations: [],
    confidence: {},
    uncertainties: [],
    watch_for: [],
    session_advice: [],
    time_context: {},
  };

  // ── Time context ───────────────────────────────────────────────
  const h = d.hour;
  ctx.time_context = {
    hour_hst: h,
    period: h < 7 ? 'pre-dawn' : h < 10 ? 'morning' : h < 14 ? 'midday' : h < 17 ? 'afternoon' : h < 19 ? 'evening' : 'night',
    thermal_active: h >= 9 && h <= 17,
    hours_until_sunset: Math.max(0, Math.round((18.25 - h) * 10) / 10),
    daylight_remaining: h < 18.25,
  };

  // ── Anomaly detection ──────────────────────────────────────────
  // What's unusual right now?

  // Wind direction anomaly
  const tradeDirections = ['NE', 'ENE', 'E'];
  if (d.windDir && !tradeDirections.includes(d.windDir) && d.windAvg > 8) {
    ctx.anomalies.push({
      type: 'direction',
      severity: 'notable',
      detail: `Wind from ${d.windDir} — not typical trade direction (expect NE-E). May indicate sea breeze dominance, frontal influence, or kona wind pattern.`,
    });
  }

  // Gustiness anomaly
  if (d.gustRatio > 1.5) {
    ctx.anomalies.push({
      type: 'gustiness',
      severity: 'warning',
      detail: `Gust ratio ${d.gustRatio}x — significantly gusty. Causes: trades overpowering thermal, wind shear, terrain effects, or thermal instability. Makes kiting unpredictable.`,
    });
  }

  // Thermal inversion (land cooler than sea during daytime)
  if (d.landSeaDiff != null && d.landSeaDiff < 0 && h >= 10 && h <= 16) {
    ctx.anomalies.push({
      type: 'thermal_inversion',
      severity: 'significant',
      detail: `Isthmus cooler than ocean by ${Math.abs(d.landSeaDiff)}°C during daytime — unusual. Heavy cloud cover or rain suppressing heating. Thermal wind component absent.`,
    });
  }

  // Precipitation / shower risk
  if (d.precip) {
    if (d.precip.rain_risk === 'high') {
      ctx.anomalies.push({
        type: 'rain',
        severity: 'significant',
        detail: `High rain risk during session window (${d.precip.max_pop_pct}% PoP, shower hours: ${d.precip.shower_hours.map(h => h + ':00').join(', ')}). Cloud cover will suppress thermal and precip may interrupt session.`,
      });
    } else if (d.precip.rain_risk === 'moderate') {
      ctx.anomalies.push({
        type: 'rain',
        severity: 'notable',
        detail: `Moderate shower risk during session window (${d.precip.max_pop_pct}% PoP${d.precip.shower_hours.length ? ', likely ' + d.precip.shower_hours.map(h => h + ':00').join('/') : ''}). Trade showers typically pass quickly but kill thermal temporarily.`,
      });
    }
  }

  // Pressure trend anomaly
  if (d.pressureTrend != null && Math.abs(d.pressureTrend) > 3) {
    ctx.anomalies.push({
      type: 'pressure',
      severity: 'significant',
      detail: `Rapid pressure ${d.pressureTrend > 0 ? 'rise' : 'fall'} (${d.pressureTrend}hPa/3h) — indicates ${d.pressureTrend > 0 ? 'post-frontal clearing, trades may weaken' : 'approaching low/trough, wind likely building'}.`,
    });
  }

  // Buoy-station divergence
  const buoyAvgs = Object.values(d.buoys).map(b => b.met?.wind_speed_kts || b.wind_speed_kts).filter(Boolean);
  const buoyAvg = buoyAvgs.length > 0 ? buoyAvgs.reduce((a, b) => a + b, 0) / buoyAvgs.length : null;
  if (buoyAvg && d.windAvg && Math.abs(buoyAvg - d.windAvg) > 8) {
    ctx.anomalies.push({
      type: 'buoy_divergence',
      severity: 'notable',
      detail: `Far-field buoys averaging ${Math.round(buoyAvg)}kts vs Kanaha ${d.windAvg}kts (${Math.round(buoyAvg - d.windAvg)}kts difference). ${buoyAvg > d.windAvg ? 'Kanaha suppressed — likely heavy cloud cover killing thermal boost, or local terrain shadowing.' : 'Kanaha enhanced — strong thermal boost or venturi effect amplifying beyond open-ocean trade strength.'}`,
    });
  }

  // ── Correlations ───────────────────────────────────────────────
  // What data sources agree or disagree?

  if (buoyAvg && d.windAvg) {
    const ratio = d.windAvg / buoyAvg;
    ctx.correlations.push({
      sources: ['kanaha_sensor', 'far_field_buoys'],
      agreement: ratio > 0.85 && ratio < 1.15 ? 'agree' : ratio > 1.15 ? 'kanaha_higher' : 'kanaha_lower',
      detail: ratio > 0.85 && ratio < 1.15
        ? `Kanaha and buoys in agreement (~${Math.round(buoyAvg)}kts) — confident in current reading.`
        : ratio > 1.15
          ? `Kanaha (${d.windAvg}kts) reading above buoy baseline (${Math.round(buoyAvg)}kts) — thermal enhancement active.`
          : `Kanaha (${d.windAvg}kts) below buoy baseline (${Math.round(buoyAvg)}kts) — local suppression (clouds, terrain, or thermal shutdown).`,
    });
  }

  // Upwind vs Kanaha correlation
  if (d.medUpwind.length > 0 && d.windAvg) {
    const upAvg = d.medUpwind.reduce((a, s) => a + s.avg_kts, 0) / d.medUpwind.length;
    ctx.correlations.push({
      sources: ['upolu_upwind', 'kanaha_sensor'],
      detail: `Upolu reading ${Math.round(upAvg)}kts vs Kanaha ${d.windAvg}kts. Upolu is mostly synoptic (no thermal). Difference of ${Math.round(d.windAvg - upAvg)}kts represents Kanaha's thermal + terrain amplification.`,
    });
  }

  // Thermal state vs cloud cover
  if (d.cloudPct != null && d.thermalState) {
    const driveStr = d.thermalState.thermal_drive.strength;
    if (d.cloudPct > 80 && (driveStr === 'strong' || driveStr === 'very_strong')) {
      ctx.correlations.push({
        sources: ['cloud_cover', 'isthmus_temp'],
        agreement: 'contradicting',
        detail: `High cloud cover (${d.cloudPct}%) but isthmus still hot (Δ${d.landSeaDiff}°C). Residual heat from earlier sun — thermal will fade as isthmus cools. Don't trust the current thermal reading for future hours.`,
      });
    } else if (d.cloudPct < 30 && driveStr !== 'none') {
      ctx.correlations.push({
        sources: ['cloud_cover', 'isthmus_temp'],
        agreement: 'reinforcing',
        detail: `Clear skies (${d.cloudPct}%) with active thermal (Δ${d.landSeaDiff}°C) — strong solar heating driving sea breeze. Expect thermal to sustain or build.`,
      });
    }
  }

  // ── Confidence assessment ──────────────────────────────────────
  ctx.confidence = {
    current_wind: d.windAvg ? 'high' : 'none',
    current_wind_reason: 'Kanaha is a paid/maintained WeatherFlow sensor — gold standard.',

    direction_forecast: d.thermalState?.wind_regime
      ? (d.cloudPct != null && d.cloudPct < 60 ? 'medium-high' : 'medium')
      : 'low',
    direction_reason: 'Regime model depends on accurate thermal state. Cloud cover affects thermal prediction.',

    taper_forecast: d.taper.length > 0
      ? (d.hour < 14 ? 'medium' : d.hour < 17 ? 'medium-high' : 'high')
      : 'none',
    taper_reason: 'After peak (14h), taper is physically constrained. Earlier predictions carry more uncertainty from thermal/cloud variability.',

    swell_forecast: d.swellObs ? 'high' : 'none',
    swell_reason: 'NDBC buoy spectral data is direct measurement, not modeled.',
  };

  // ── Uncertainties ──────────────────────────────────────────────
  // What could change our forecast?

  if (d.cloudPct != null && d.cloudPct > 50 && d.cloudPct < 90 && ctx.time_context.thermal_active) {
    ctx.uncertainties.push('Cloud cover at ' + d.cloudPct + '% — could break up (boosting thermal +3-5kts) or build further (killing thermal). This is the biggest forecast uncertainty right now.');
  }

  if (d.pressureTrend != null && Math.abs(d.pressureTrend) > 1.5) {
    ctx.uncertainties.push(`Pressure changing ${d.pressureTrend > 0 ? 'rising' : 'falling'} ${Math.abs(d.pressureTrend)}hPa/3h — pattern is shifting. Tomorrow could be significantly different.`);
  }

  const swellIncoming = d.swellWarnings.filter(w => w.signal !== 'consistent');
  if (swellIncoming.length > 0) {
    ctx.uncertainties.push('New groundswell detected at outer buoys — arrival time at north shore uncertain (could be hours to overnight).');
  }

  // ── Watch for (what would change the picture) ──────────────────
  if (d.windAvg > 15 && d.gustRatio < 1.3) {
    ctx.watch_for.push('Gustiness increasing → trades becoming disorganized, possible direction shift.');
  }
  if (d.windAvg > 15 && ctx.time_context.hours_until_sunset < 3) {
    ctx.watch_for.push(`${Math.round(ctx.time_context.hours_until_sunset)}h until sunset — thermal dying, wind will drop to synoptic base (~${d.synBase || '?'}kts).`);
  }
  if (buoyAvg && buoyAvg < 12) {
    ctx.watch_for.push('Far-field buoys below 12kts — synoptic trades weakening. Tomorrow may be light.');
  }
  if (d.ua?.trend === 'direction_shift') {
    ctx.watch_for.push('Upwind direction shifting — trade wind pattern may be breaking down.');
  }

  // ── Session advice (deterministic) ─────────────────────────────
  if (d.windAvg >= 18 && d.gustRatio < 1.4) {
    ctx.session_advice.push('Conditions are solid — get on the water now.');
  } else if (d.windAvg >= 15 && d.windAvg < 18) {
    ctx.session_advice.push('Rideable but not full power. Big kite/sail recommended.');
  } else if (d.windAvg >= 12 && d.windAvg < 15) {
    ctx.session_advice.push('Marginal. Foil or large kite (14m+) only. Wait for thermal to build if morning.');
  }

  if (ctx.time_context.period === 'morning' && d.cloudPct != null && d.cloudPct < 40) {
    ctx.session_advice.push('Clear morning — thermal should build strong by 11-13h. Best session window coming.');
  }

  if (d.taper.length > 0) {
    const lastGood = d.taper.filter(t => t.kts >= 15);
    if (lastGood.length > 0) {
      const lastHour = lastGood[lastGood.length - 1].hour;
      ctx.session_advice.push(`Wind should stay rideable (15+kts) until ~${lastHour}:00 HST.`);
    }
  }

  if (d.windswellHt >= 0.8 && d.windAvg >= 12) {
    ctx.session_advice.push(`Downwind foiling conditions: ${d.windswellHt}m windswell — good bumps for gliding.`);
  }

  return ctx;
}

function printReport(r) {
  const W = 56;
  const line = '═'.repeat(W);
  const thin = '─'.repeat(W);

  console.log(line);
  console.log(`  🏖️  KANAHA BEACH PARK — ${r.time_hst}`);
  console.log(line);

  // Alerts
  for (const a of r.alerts) console.log(`  ⚠️  ${a}`);

  // Verdict
  console.log(`\n  ${r.verdict}`);

  // Wind
  console.log(`\n${thin}`);
  console.log(`  WIND`);
  console.log(`  ${r.wind.current_kts} kts ${r.wind.direction} ${dirArrow(r.wind.direction)}  gust ${r.wind.gust_kts || '?'}  (ratio ${r.wind.gust_ratio}x)`);
  if (r.wind.upwind_note) console.log(`  Upwind: ${r.wind.upwind_note}`);
  if (r.wind.far_field) console.log(`  Far field: ${r.wind.far_field}`);

  // Thermal
  if (r.thermal) {
    console.log(`\n${thin}`);
    console.log(`  THERMAL`);
    console.log(`  Isthmus ${r.thermal.isthmus_temp_c}°C | Ocean ${r.thermal.ocean_temp_c}°C | Δ${r.thermal.diff_c}°C → ${r.thermal.drive}`);
    console.log(`  Regime: ${r.thermal.regime_desc}`);
    console.log(`  Direction: ${r.thermal.direction_effect} | Gustiness: ${r.thermal.gustiness}`);
    console.log(`  Venturi: ${r.thermal.venturi} | Synoptic base: ${r.thermal.synoptic_base_kts}kts`);
  }

  // Atmosphere
  console.log(`\n${thin}`);
  console.log(`  ATMOSPHERE`);
  console.log(`  Clouds: ${r.atmosphere.cloud_pct ?? '?'}% | P trend 3h: ${r.atmosphere.pressure_trend_3h != null ? (r.atmosphere.pressure_trend_3h > 0 ? '+' : '') + r.atmosphere.pressure_trend_3h + 'hPa' : '?'}`);

  // Taper
  if (r.taper.length > 0) {
    console.log(`\n${thin}`);
    console.log(`  FORECAST`);
    for (const t of r.taper) {
      const bar = '█'.repeat(Math.round(t.kts / 2));
      console.log(`  ${String(t.hour).padStart(2)}h  ${t.kts.toFixed(1).padStart(5)}kts  ${bar}`);
    }
  }

  // iK-TRRM Forecast
  if (r.iktrrm_forecast?.length > 0) {
    console.log(`\n${thin}`);
    console.log(`  iK-TRRM FORECAST`);
    let currentDate = '';
    for (const f of r.iktrrm_forecast) {
      if (f.date !== currentDate) {
        currentDate = f.date;
        console.log(`  ${f.date}`);
      }
      const bar = '█'.repeat(Math.round(f.avg_kts / 2));
      const gustBar = '░'.repeat(Math.max(0, Math.round((f.gust_kts - f.avg_kts) / 2)));
      const gustLabel = f.gust_kts ? `g${f.gust_kts}` : '';
      const ratio = f.gust_ratio ? ` (${f.gust_ratio}x)` : '';
      console.log(`  ${String(f.hour_hst).padStart(2)}h  ${f.avg_kts.toFixed(1).padStart(5)}/${gustLabel.padEnd(5)}  ${bar}${gustBar}${ratio}`);
    }
  }

  // Waves
  if (r.waves) {
    console.log(`\n${thin}`);
    console.log(`  WAVES`);
    console.log(`  Windswell:   ${r.waves.windswell} (${r.waves.trend || '?'})`);
    console.log(`  Groundswell: ${r.waves.groundswell}`);
    console.log(`  Total: ${r.waves.total_m}m | Foil: ${r.waves.foil_rating || '?'}`);
    for (const w of r.swell_warnings) console.log(`  ⚠️  ${w}`);
  }

  // Buoys
  if (r.buoys.length > 0) {
    console.log(`\n${thin}`);
    console.log(`  BUOYS`);
    for (const b of r.buoys) {
      console.log(`  ${b.name}: ${b.wind_kts}kts/${b.dir_deg}° P=${b.pressure}hPa SST=${b.sst_c}°C`);
    }
  }

  // Tides
  if (r.tides.length > 0) {
    console.log(`\n${thin}`);
    console.log(`  TIDES`);
    for (const t of r.tides) console.log(`  ${t}`);
  }

  // Activities
  console.log(`\n${thin}`);
  console.log(`  ACTIVITIES`);
  const emoji = { EPIC: '🟢', GOOD: '🟢', FAIR: '🟡', MARGINAL: '🟡', 'NO-GO': '🔴' };
  for (const v of r.activities) {
    console.log(`  ${emoji[v.rating] || '⚪'} ${v.activity}: ${v.rating} (${v.score}/5)${v.notes ? ' — ' + v.notes.trim() : ''}`);
  }

  // Precipitation
  if (r.precipitation) {
    const p = r.precipitation;
    const riskEmoji = { low: '🟢', moderate: '🟡', high: '🔴' }[p.rain_risk] || '⚪';
    console.log(`\n${thin}`);
    console.log(`  PRECIP — ${p.session_window}`);
    console.log(`  Rain risk: ${riskEmoji} ${p.rain_risk.toUpperCase()} | Max PoP: ${p.max_pop_pct}% | Total: ${p.total_precip_mm}mm`);
    for (const h of p.hourly) {
      const showerFlag = h.is_shower ? ' 🌧' : '';
      const nwsPop = h.nws_pop_pct != null ? `NWS ${h.nws_pop_pct}%` : '';
      const meteoPop = h.meteo_pop_pct != null ? `OM ${h.meteo_pop_pct}%` : '';
      const pops = [nwsPop, meteoPop].filter(Boolean).join(' / ');
      const showers = h.showers_mm ? ` showers:${h.showers_mm}mm` : '';
      const clouds = h.cloud_pct != null ? ` ☁${h.cloud_pct}%` : '';
      console.log(`  ${String(h.hour_hst).padStart(2)}:00  ${pops.padEnd(22)}${showers}${clouds}${showerFlag}`);
    }
  }

  // NWS
  if (r.nws.length > 0) {
    console.log(`\n${thin}`);
    console.log(`  NWS`);
    for (const f of r.nws) console.log(`  ${f}`);
  }

  // Equipment
  if (r.equipment) {
    console.log(`\n${thin}`);
    console.log(`  EQUIPMENT`);
    console.log(`  🏄 Mast now: ${r.equipment.current_mast_cm}cm (${r.equipment.current_category}) | Reef: ${r.equipment.reef_depth_cm}cm`);
    if (r.equipment.mast_notes) console.log(`  ${r.equipment.mast_notes}`);
    if (r.equipment.session_windows?.length > 0) {
      console.log('  Session windows (2h, single mast):');
      for (const w of r.equipment.session_windows) {
        console.log(`    ${w.session_window}  tide ${w.min_tide_ft.toFixed(1)}-${w.max_tide_ft.toFixed(1)}ft → ${w.recommended_mast_cm || '⚠️'}cm`);
      }
    }
    const ks = r.equipment.kite_setup;
    if (ks?.kite_m) {
      console.log(`  🪁 Kite: ${ks.kite_m}m | Lines: ${ks.lines_m.join('-')}m | Front: ${ks.front_wing} | Tail: ${ks.tail_wing}`);
      if (ks.notes) console.log(`  ${ks.notes}`);
    } else if (ks?.reason) {
      console.log(`  🪁 ${ks.reason}`);
    }
  }

  // Analysis context
  if (r.analysis) {
    const a = r.analysis;
    if (a.anomalies.length > 0 || a.watch_for.length > 0 || a.session_advice.length > 0) {
      console.log(`\n${thin}`);
      console.log(`  ANALYSIS`);
      for (const an of a.anomalies) console.log(`  ${an.severity === 'significant' ? '🔴' : '🟡'} ${an.detail}`);
      for (const c of a.correlations) console.log(`  📊 ${c.detail}`);
      for (const u of a.uncertainties) console.log(`  ❓ ${u}`);
      for (const w of a.watch_for) console.log(`  👀 ${w}`);
      for (const s of a.session_advice) console.log(`  💡 ${s}`);
    }
  }

  console.log(`\n${line}`);
}

main().catch(e => { console.error(e); process.exit(1); });
