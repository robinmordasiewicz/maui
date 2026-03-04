#!/usr/bin/env node
/**
 * daily-briefing.mjs — Composite Kanaha Beach watersport briefing
 *
 * Pulls data from all modules and wind-prediction engine, then produces
 * a structured JSON briefing covering:
 *   - Current conditions + go/no-go assessment
 *   - Wind prediction (upwind stations + buoys + pressure/cloud)
 *   - Tides
 *   - Waves & swell
 *   - NWS forecast & alerts
 *   - Session windows (best times to kite/windsurf)
 *
 * Usage: node daily-briefing.mjs [--text]
 *   --text  Output human-readable briefing instead of JSON
 */

import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEXT_MODE = process.argv.includes('--text');

// ── Helpers ──────────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function runModule(name, args = '') {
  try {
    const cmd = `node ${join(__dirname, name + '.mjs')} ${args}`;
    const out = execSync(cmd, { timeout: 90000, stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(out.toString());
  } catch (e) {
    process.stderr.write(`[${name}] FAILED: ${e.message?.slice(0, 80)}\n`);
    return null;
  }
}

function hstNow() {
  return new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu' });
}

function hstHour() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', hour12: false }));
}

// ── Sunrise/Sunset (approximate for Maui ~20.9°N) ───────────────────
function getSunTimes() {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  // Simple approximation for Maui latitude
  const baseRise = 6.5; // ~6:30 AM HST avg
  const baseSet = 18.25; // ~6:15 PM HST avg
  const variation = 0.75; // +/- 45 min seasonal
  const offset = Math.cos((dayOfYear - 172) * 2 * Math.PI / 365) * variation;
  return {
    sunrise_hst: `${Math.floor(baseRise - offset)}:${String(Math.round(((baseRise - offset) % 1) * 60)).padStart(2, '0')}`,
    sunset_hst: `${Math.floor(baseSet + offset)}:${String(Math.round(((baseSet + offset) % 1) * 60)).padStart(2, '0')}`,
    daylight_hours: Math.round(((baseSet + offset) - (baseRise - offset)) * 10) / 10,
  };
}

// ── Activity Assessment ──────────────────────────────────────────────
function assessConditions(windAvg, windGust, windDir, waveHt, swellPeriod, tideLevel) {
  const activities = {};

  // Kitesurfing: needs 15-30kts, cross-onshore preferred
  const kiteWindScore = windAvg >= 15 && windAvg <= 35 ? (windAvg >= 18 && windAvg <= 28 ? 5 : 3) : windAvg >= 12 ? 2 : 0;
  const kiteGustFactor = windGust && windAvg ? windGust / windAvg : 1;
  const kiteGustPenalty = kiteGustFactor > 1.5 ? -2 : kiteGustFactor > 1.3 ? -1 : 0;
  const kiteScore = Math.max(0, Math.min(5, kiteWindScore + kiteGustPenalty));

  activities.kitesurfing = {
    score: kiteScore,
    rating: kiteScore >= 4 ? 'EPIC' : kiteScore >= 3 ? 'GOOD' : kiteScore >= 2 ? 'MARGINAL' : 'NO-GO',
    wind_ok: windAvg >= 15,
    notes: [],
  };
  if (windAvg < 12) activities.kitesurfing.notes.push('Too light — need 15+ kts');
  else if (windAvg < 15) activities.kitesurfing.notes.push('Marginal — big kite only (14-17m)');
  if (windAvg > 30) activities.kitesurfing.notes.push('Overpowered — small kite, experienced riders only');
  if (kiteGustFactor > 1.4) activities.kitesurfing.notes.push(`Gusty (${Math.round(kiteGustFactor * 100 - 100)}% over avg) — expect lulls`);

  // Windsurfing: needs 18-35kts for planing, broader range with foil
  const wsWindScore = windAvg >= 18 && windAvg <= 40 ? (windAvg >= 22 && windAvg <= 32 ? 5 : 3) : windAvg >= 15 ? 2 : 0;
  const wsScore = Math.max(0, Math.min(5, wsWindScore + kiteGustPenalty));

  activities.windsurfing = {
    score: wsScore,
    rating: wsScore >= 4 ? 'EPIC' : wsScore >= 3 ? 'GOOD' : wsScore >= 2 ? 'MARGINAL' : 'NO-GO',
    wind_ok: windAvg >= 18,
    notes: [],
  };
  if (windAvg < 15) activities.windsurfing.notes.push('Too light for planing');
  else if (windAvg < 18) activities.windsurfing.notes.push('Marginal — large sail (6.5+) or foil');
  if (windAvg > 35) activities.windsurfing.notes.push('Survival conditions — expert only');

  // Wing foiling: works in lighter wind (10-25kts ideal)
  const wfScore = windAvg >= 10 && windAvg <= 30 ? (windAvg >= 12 && windAvg <= 22 ? 5 : 3) : windAvg >= 8 ? 2 : 0;
  activities.wing_foil = {
    score: Math.max(0, Math.min(5, wfScore)),
    rating: wfScore >= 4 ? 'EPIC' : wfScore >= 3 ? 'GOOD' : wfScore >= 2 ? 'MARGINAL' : 'NO-GO',
    wind_ok: windAvg >= 10,
    notes: [],
  };

  // Tide assessment for Kanaha
  if (tideLevel != null) {
    if (tideLevel < 0) {
      for (const a of Object.values(activities)) a.notes.push('Low tide — watch for reef');
    } else if (tideLevel > 2) {
      for (const a of Object.values(activities)) a.notes.push('High tide — reduced beach, shore break');
    }
  }

  // Downwind foiling: assessed separately via windswell module
  // Placeholder — will be overwritten with windswell data in main()
  activities.downwind_foil = {
    score: 0, rating: 'PENDING', wind_ok: false, notes: ['Assessed via windswell analysis'],
  };

  return activities;
}

// ── Session Window Analysis ──────────────────────────────────────────
function findSessionWindows(taperPrediction, tides) {
  if (!taperPrediction?.length) return [];

  const windows = [];
  let currentWindow = null;

  for (const tp of taperPrediction) {
    const rideable = tp.predicted_avg_kts >= 15; // kiteable threshold
    if (rideable && !currentWindow) {
      currentWindow = { start_hst: tp.hour_hst, end_hst: tp.hour_hst, peak_kts: tp.predicted_avg_kts };
    } else if (rideable && currentWindow) {
      currentWindow.end_hst = tp.hour_hst;
      currentWindow.peak_kts = Math.max(currentWindow.peak_kts, tp.predicted_avg_kts);
    } else if (!rideable && currentWindow) {
      currentWindow.duration_hours = currentWindow.end_hst - currentWindow.start_hst + 1;
      windows.push(currentWindow);
      currentWindow = null;
    }
  }
  if (currentWindow) {
    currentWindow.duration_hours = currentWindow.end_hst - currentWindow.start_hst + 1;
    windows.push(currentWindow);
  }

  // Add tide info to each window
  if (tides?.length) {
    for (const w of windows) {
      const relevantTides = tides.filter(t => {
        const tideHour = parseInt(t.time_local?.split(' ')[1]?.split(':')[0]);
        return tideHour >= w.start_hst && tideHour <= w.end_hst;
      });
      w.tides_during = relevantTides;
    }
  }

  return windows;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const briefingTime = hstNow();
  const hour = hstHour();
  const sunTimes = getSunTimes();

  process.stderr.write('=== Daily Briefing Build ===\n');

  // Pull all modules in parallel where possible
  process.stderr.write('Fetching data modules...\n');

  const [tides, nws, pressure, waves, buoy] = await Promise.all([
    Promise.resolve(runModule('tides-noaa', '3')),
    Promise.resolve(runModule('forecast-nws')),
    Promise.resolve(runModule('pressure-meteo', '3')),
    Promise.resolve(runModule('ocean-waves', '3')),
    Promise.resolve(runModule('buoy-ndbc', '24')),
  ]);

  // Wind prediction (slowest — uses Playwright)
  process.stderr.write('Running wind prediction engine...\n');
  const windPred = runModule('wind-prediction');

  // Isthmus thermal model
  process.stderr.write('Running isthmus thermal model...\n');
  const isthmusThermal = runModule('isthmus-thermal');

  // Windswell analysis (needs current wind data)
  process.stderr.write('Running windswell analysis...\n');
  const windAvgForSwell = windPred?.upwind_analysis?.kanaha_avg || 0;
  // Parse wind direction from text
  const dirMap = {N:0,NNE:22.5,NE:45,ENE:67.5,E:90,ESE:112.5,SE:135,SSE:157.5,S:180,SSW:202.5,SW:225,WSW:247.5,W:270,WNW:292.5,NW:315,NNW:337.5};
  const windDirForSwell = dirMap[windPred?.upwind_analysis?.kanaha_dir] || 0;
  const windswell = JSON.parse(execSync(
    `WIND_SPEED_KTS=${windAvgForSwell} WIND_DIR_DEG=${windDirForSwell} node ${join(__dirname, 'windswell-analysis.mjs')}`,
    { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
  ).toString());

  // ── Assemble briefing ──────────────────────────────────────────────
  const currentWind = windPred?.summary || {};
  const windAvg = windPred?.upwind_analysis?.kanaha_avg || null;
  const windGust = null; // from station data if available
  const windDir = windPred?.upwind_analysis?.kanaha_dir || null;

  // Current wave conditions from NDBC buoys
  const pauwelaObs = buoy?.stations?.['51205']?.observations;
  const currentWaveHt = pauwelaObs?.[0]?.wave_height_m || null;
  const currentSwellPeriod = pauwelaObs?.[0]?.dominant_period_s || null;

  // Current tide
  const currentTide = tides?.latest_observed || null;

  // Activity assessment
  const activities = assessConditions(windAvg, windGust, windDir, currentWaveHt, currentSwellPeriod, currentTide?.level_ft);

  // Override downwind foil with actual windswell analysis
  if (windswell?.downwind_foiling) {
    const dw = windswell.downwind_foiling;
    activities.downwind_foil = {
      score: Math.round(dw.downwind_foil_score),
      rating: dw.downwind_foil_rating,
      wind_ok: windAvg >= 10,
      notes: dw.notes || [],
      sub_scores: dw.sub_scores,
    };
  }

  // Session windows
  const sessionWindows = findSessionWindows(windPred?.taper_prediction, tides?.high_low);

  // NWS alerts
  const alerts = nws?.alerts || [];

  // Pressure analysis
  const pressureTrend = windPred?.atmosphere?.pressure_trend_3h_hpa;
  const currentPressure = pressure?.hourly ? (() => {
    const nowIdx = pressure.hourly.findIndex(h => new Date(h.time) > new Date()) - 1;
    return nowIdx >= 0 ? pressure.hourly[nowIdx] : null;
  })() : null;

  // Ocean forecast
  const todayWaves = waves?.daily?.[0] || null;
  const tomorrowWaves = waves?.daily?.[1] || null;

  const briefing = {
    briefing_time_hst: briefingTime,
    sun: sunTimes,

    // ── Alerts (top priority) ─────────────────────────────────────
    alerts: alerts.map(a => ({ event: a.event, headline: a.headline, severity: a.severity })),

    // ── Current Conditions ────────────────────────────────────────
    current: {
      wind: {
        avg_kts: windAvg,
        direction: windDir,
        summary: currentWind.current_wind || 'unknown',
        phase: currentWind.phase || 'unknown',
      },
      waves: currentWaveHt ? {
        height_m: currentWaveHt,
        period_s: currentSwellPeriod,
        source: 'NDBC Pauwela 51205',
      } : null,
      tide: currentTide,
      atmosphere: {
        pressure_hpa: currentPressure?.pressure_msl_hpa || null,
        pressure_trend_3h_hpa: pressureTrend,
        cloud_cover_pct: windPred?.atmosphere?.cloud_cover?.current_pct || null,
        thermal_modifier: windPred?.atmosphere?.thermal_modifier || null,
      },
    },

    // ── Activity Ratings ──────────────────────────────────────────
    activities,

    // ── Thermal Analysis ─────────────────────────────────────────
    thermal: windPred?.thermal_analysis || null,

    // ── Isthmus Thermal Model ─────────────────────────────────────
    isthmus: isthmusThermal ? {
      heat_index: isthmusThermal.isthmus_heat,
      thermal_state: isthmusThermal.thermal_state,
      thermal_prediction: isthmusThermal.thermal_prediction,
      venturi: isthmusThermal.venturi_observation,
      summary: isthmusThermal.summary,
    } : null,

    // ── Wind Prediction ───────────────────────────────────────────
    wind_prediction: {
      upwind_trend: windPred?.upwind_analysis?.trend || 'unknown',
      upwind_prediction: windPred?.upwind_analysis?.prediction || '',
      far_field_outlook: windPred?.upwind_analysis?.far_field_outlook || '',
      pressure_gradient: windPred?.pressure_gradient?.strength || 'unknown',
      taper_prediction: windPred?.taper_prediction || [],
      historical: {
        yesterday_peak: currentWind.yesterday_peak || 'unknown',
        evening_retention: currentWind.yesterday_evening_retention || 'unknown',
      },
      evening_outlook: currentWind.evening_outlook || 'unknown',
    },

    // ── Buoys (far-field trade indicators) ────────────────────────
    buoys: windPred?.buoy_data || {},

    // ── Tides ─────────────────────────────────────────────────────
    tides: {
      upcoming: tides?.high_low?.slice(0, 6) || [],
      current_level_ft: currentTide?.level_ft || null,
    },

    // ── Windswell & Foiling ─────────────────────────────────────
    windswell: {
      current: windswell?.current_conditions || null,
      trend: windswell?.windswell_trend || null,
      downwind_foiling: windswell?.downwind_foiling || null,
      cross_reference: windswell?.cross_reference || null,
      groundswell_early_warning: windswell?.groundswell_early_warning || null,
      summary: windswell?.summary || null,
    },

    // ── Waves & Swell Forecast ────────────────────────────────────
    wave_forecast: {
      today: todayWaves,
      tomorrow: tomorrowWaves,
      source: 'Open-Meteo Marine',
    },

    // ── NWS Forecast ──────────────────────────────────────────────
    forecast: {
      periods: nws?.daily?.slice(0, 4)?.map(p => ({
        name: p.name,
        temp_f: p.temp_f,
        wind: `${p.wind_speed} ${p.wind_dir}`,
        forecast: p.forecast,
      })) || [],
    },

    // ── Session Windows ───────────────────────────────────────────
    session_windows: sessionWindows,

    // ── Go/No-Go Summary ──────────────────────────────────────────
    go_nogo: (() => {
      const bestActivity = Object.entries(activities).sort((a, b) => b[1].score - a[1].score)[0];
      const [actName, act] = bestActivity || ['none', { rating: 'NO-GO', score: 0 }];
      let verdict;
      if (act.score >= 4) verdict = `🟢 GO — ${actName} is EPIC right now`;
      else if (act.score >= 3) verdict = `🟢 GO — ${actName} conditions are GOOD`;
      else if (act.score >= 2) verdict = `🟡 MAYBE — ${actName} is MARGINAL, check window`;
      else verdict = '🔴 NO-GO — conditions not suitable for watersports';

      if (alerts.length > 0) {
        verdict = `⚠️ ${alerts[0].event} — ${verdict}`;
      }

      return {
        verdict,
        best_activity: actName,
        best_window: sessionWindows[0] || null,
      };
    })(),
  };

  // ── Output ─────────────────────────────────────────────────────
  if (TEXT_MODE) {
    printTextBriefing(briefing);
  } else {
    console.log(JSON.stringify(briefing, null, 2));
  }
}

// ── Text Formatter ───────────────────────────────────────────────────
function printTextBriefing(b) {
  const line = '═'.repeat(50);
  const thin = '─'.repeat(50);

  console.log(line);
  console.log(`  🏖️  KANAHA BEACH — DAILY BRIEFING`);
  console.log(`  ${b.briefing_time_hst}`);
  console.log(`  ☀️ Rise ${b.sun.sunrise_hst} | Set ${b.sun.sunset_hst} (${b.sun.daylight_hours}h)`);
  console.log(line);

  // Alerts
  if (b.alerts.length > 0) {
    console.log('\n⚠️  ALERTS');
    for (const a of b.alerts) console.log(`  🚨 ${a.event}: ${a.headline}`);
  }

  // Go/No-Go
  console.log(`\n${b.go_nogo.verdict}`);
  if (b.go_nogo.best_window) {
    const w = b.go_nogo.best_window;
    console.log(`  Best window: ${w.start_hst}:00-${w.end_hst}:00 HST (${w.duration_hours}h, peak ${Math.round(w.peak_kts)}kts)`);
  }

  // Current Conditions
  console.log(`\n${thin}`);
  console.log('  CURRENT CONDITIONS');
  console.log(thin);
  console.log(`  🌬️  Wind: ${b.current.wind.summary} (${b.current.wind.phase})`);
  if (b.current.waves) console.log(`  🌊 Waves: ${b.current.waves.height_m}m${b.current.waves.period_s ? ` @ ${b.current.waves.period_s}s` : ''}`);
  if (b.current.tide) console.log(`  🌊 Tide: ${b.current.tide.level_ft}ft (${b.current.tide.type || 'observed'})`);
  console.log(`  ☁️  Clouds: ${b.current.atmosphere.cloud_cover_pct ?? '?'}% | P: ${b.current.atmosphere.pressure_hpa ?? '?'}hPa (Δ${b.current.atmosphere.pressure_trend_3h_hpa ?? '?'})`);

  // Activity Ratings
  console.log(`\n${thin}`);
  console.log('  ACTIVITY RATINGS');
  console.log(thin);
  const emoji = { EPIC: '🟢', GOOD: '🟢', MARGINAL: '🟡', 'NO-GO': '🔴' };
  for (const [name, act] of Object.entries(b.activities)) {
    const e = emoji[act.rating] || '⚪';
    const label = name.replace('_', ' ');
    console.log(`  ${e} ${label}: ${act.rating} (${act.score}/5)`);
    for (const n of act.notes) console.log(`     ${n}`);
  }

  // Thermal Analysis
  if (b.thermal || b.isthmus) {
    console.log(`\n${thin}`);
    console.log('  THERMAL ANALYSIS');
    console.log(thin);
    if (b.isthmus?.thermal_state) {
      const ist = b.isthmus.thermal_state;
      const ism = b.isthmus.summary;
      console.log(`  🏔️  Isthmus: ${ist.isthmus_temp_c}°C | Ocean: ${ist.ocean_temp_c}°C | Δ${ist.land_sea_diff_c}°C`);
      console.log(`  🌡️  Thermal drive: ${ist.thermal_drive.strength} — ${ist.thermal_drive.desc}`);
      console.log(`  💨 Regime: ${ist.wind_regime.type} — ${ist.wind_regime.desc}`);
      console.log(`     Direction: ${ist.wind_regime.expected_dir_text}`);
      console.log(`     Gustiness: ${ist.wind_regime.gustiness}`);
      console.log(`  🏔️  Venturi: ${ist.venturi.rating} — ${ist.venturi.desc}`);
    }
    if (b.thermal) {
      const ts = b.thermal.kanaha_airport_spread;
      if (ts) console.log(`  📊 Beach-Airport spread: ${ts.spread_kts > 0 ? '+' : ''}${ts.spread_kts}kts (${ts.note})`);
      console.log(`  📊 Synoptic base: ~${b.thermal.estimated_synoptic_base_kts}kts`);
    }
    // Thermal forecast
    if (b.isthmus?.thermal_prediction?.length) {
      console.log('\n  Thermal boost forecast:');
      for (const p of b.isthmus.thermal_prediction) {
        const bar = '█'.repeat(Math.round(p.thermal_boost_kts));
        console.log(`  ${String(p.hour_hst).padStart(2)}h  +${p.thermal_boost_kts.toFixed(1)}kts  solar:${String(p.solar_fraction).padStart(3)}%  ${bar}  ${p.phase}`);
      }
    }
  }

  // Wind Prediction
  console.log(`\n${thin}`);
  console.log('  WIND PREDICTION');
  console.log(thin);
  console.log(`  Upwind: ${b.wind_prediction.upwind_prediction}`);
  console.log(`  Far field: ${b.wind_prediction.far_field_outlook}`);
  console.log(`  Gradient: ${b.wind_prediction.pressure_gradient} | Yesterday peak: ${b.wind_prediction.historical.yesterday_peak}`);
  console.log(`  Evening: ${b.wind_prediction.evening_outlook}`);

  if (b.wind_prediction.taper_prediction.length > 0) {
    console.log('\n  Hour  Avg(kts)  Conf   Phase');
    for (const tp of b.wind_prediction.taper_prediction) {
      const bar = '█'.repeat(Math.round(tp.predicted_avg_kts / 2));
      const conf = { high: '🟢', medium: '🟡', low: '🟠' }[tp.confidence] || '⚪';
      console.log(`  ${String(tp.hour_hst).padStart(2)}h   ${tp.predicted_avg_kts.toFixed(1).padStart(5)}  ${conf}  ${bar}  ${tp.phase}`);
    }
  }

  // Buoys
  console.log(`\n${thin}`);
  console.log('  FAR-FIELD BUOYS');
  console.log(thin);
  for (const [id, bd] of Object.entries(b.buoys)) {
    const met = bd.met || {};
    const wav = bd.waves || {};
    console.log(`  ${bd.name}`);
    console.log(`    Wind: ${met.wind_speed_kts ?? '?'}kts from ${met.wind_dir_deg ?? '?'}° | P=${met.pressure_hpa ?? '?'}hPa | SST=${met.water_temp_c ?? '?'}°C`);
    if (wav.total_wave_ht_m) console.log(`    Waves: ${wav.total_wave_ht_m}m | Swell ${wav.swell_ht_m}m@${wav.swell_period_s}s ${wav.swell_dir || '?'} | WindWv ${wav.wind_wave_ht_m}m@${wav.wind_wave_period_s}s`);
  }

  // Windswell
  if (b.windswell?.current) {
    console.log(`\n${thin}`);
    console.log('  WINDSWELL & FOILING');
    console.log(thin);
    const ws = b.windswell.current;
    if (ws.windswell) console.log(`  🌊 Windswell:    ${ws.windswell.height_m}m @ ${ws.windswell.period_s}s from ${ws.windswell.direction}`);
    if (ws.groundswell) console.log(`  🌊 Groundswell:  ${ws.groundswell.height_m}m @ ${ws.groundswell.period_s}s from ${ws.groundswell.direction}`);
    console.log(`     Total: ${ws.total_wave_ht_m}m | Steepness: ${ws.steepness}`);
    if (b.windswell.trend) {
      const t = b.windswell.trend;
      console.log(`  📈 Trend: ${t.trend} (${t.change_pct > 0 ? '+' : ''}${t.change_pct}%) — ${t.note}`);
    }
    if (b.windswell.downwind_foiling) {
      const df = b.windswell.downwind_foiling;
      const e = { EPIC: '🟢', GOOD: '🟢', FAIR: '🟡', MARGINAL: '🟡', 'NO-GO': '🔴' }[df.downwind_foil_rating] || '⚪';
      console.log(`  ${e} Downwind foil: ${df.downwind_foil_rating} (${df.downwind_foil_score}/5)`);
      for (const n of (df.notes || [])) console.log(`     ${n}`);
    }
    if (b.windswell.cross_reference) {
      const cr = b.windswell.cross_reference;
      console.log(`  📡 Cross-ref (${cr.source}): ${cr.windswell_ht_m}m @ ${cr.windswell_period_s}s ${cr.windswell_dir}`);
    }
    if (b.windswell.groundswell_early_warning?.length) {
      console.log('\n  🔭 GROUNDSWELL EARLY WARNING');
      for (const w of b.windswell.groundswell_early_warning) {
        const icon = w.signal === 'new_swell_incoming' ? '⚠️' : w.signal === 'swell_building' ? '📈' : w.signal === 'long_period_incoming' ? '🌊' : '✅';
        console.log(`  ${icon} ${w.source}: ${w.swell_ht_m}m @ ${w.swell_period_s}s ${w.swell_dir} (vs Pauwela: ${w.vs_pauwela_ht_ratio}x)`);
        if (w.trend) console.log(`     Trend: ${w.trend} (${w.trend_pct > 0 ? '+' : ''}${w.trend_pct}%)`);
        if (w.signal !== 'consistent') console.log(`     ${w.note}`);
      }
    }
  }

  // Tides
  console.log(`\n${thin}`);
  console.log('  TIDES (Kahului Harbor)');
  console.log(thin);
  for (const t of b.tides.upcoming) {
    const icon = t.type === 'high' ? '⬆️' : '⬇️';
    console.log(`  ${icon} ${t.type.toUpperCase().padEnd(4)} ${t.time_local}  ${t.level_ft}ft`);
  }

  // Wave Forecast
  if (b.wave_forecast.today) {
    console.log(`\n${thin}`);
    console.log('  WAVE FORECAST');
    console.log(thin);
    const t = b.wave_forecast.today;
    console.log(`  Today:    Swell ${t.swell_max_m ?? '?'}m@${t.swell_period_max_s ?? '?'}s | WindWave ${t.wind_wave_max_m ?? '?'}m | Total ${t.wave_max_m ?? '?'}m`);
    if (b.wave_forecast.tomorrow) {
      const tm = b.wave_forecast.tomorrow;
      console.log(`  Tomorrow: Swell ${tm.swell_max_m ?? '?'}m@${tm.swell_period_max_s ?? '?'}s | WindWave ${tm.wind_wave_max_m ?? '?'}m | Total ${tm.wave_max_m ?? '?'}m`);
    }
  }

  // NWS Forecast
  if (b.forecast.periods.length > 0) {
    console.log(`\n${thin}`);
    console.log('  NWS FORECAST');
    console.log(thin);
    for (const p of b.forecast.periods) {
      console.log(`  ${p.name}: ${p.forecast || '?'} (${p.temp_f}°F, Wind ${p.wind})`);
    }
  }

  // Session Windows
  if (b.session_windows.length > 0) {
    console.log(`\n${thin}`);
    console.log('  SESSION WINDOWS');
    console.log(thin);
    for (const [i, w] of b.session_windows.entries()) {
      console.log(`  Window ${i + 1}: ${w.start_hst}:00 - ${w.end_hst}:00 HST (${w.duration_hours}h)`);
      console.log(`    Peak: ${Math.round(w.peak_kts)}kts`);
    }
  }

  console.log(`\n${line}`);
}

main().catch(e => { console.error(e); process.exit(1); });
