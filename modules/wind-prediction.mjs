#!/usr/bin/env node
/**
 * wind-prediction.mjs — Diurnal wind pattern analysis & prediction for Kanaha
 *
 * Analyzes upwind station network, historical diurnal patterns, pressure gradients,
 * and solar thermal effects to predict wind evolution through the day.
 *
 * Usage:
 *   node wind-prediction.mjs                    # Full analysis (requires browser auth)
 *   node wind-prediction.mjs --from-files       # Analyze from cached output/ data
 *
 * Requires: Authenticated iKitesurf session (Playwright)
 */

import { readFileSync, writeFileSync } from 'fs';
import { loadSession } from './ik-session.mjs';
import https from 'https';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}



// ============================================================
// STATION NETWORK — Upwind reference stations for NE trades
// ============================================================
// For classic NE trade winds (40-80°), wind arrives from the open
// Pacific, passes these stations, then reaches Kanaha.
// Stations are ordered by their "upwind distance" for NE trades.

const STATION_NETWORK = {
  // PRIMARY — Kanaha itself
  kanaha: { id: 166192, name: 'Kanaha', lat: 20.896, lon: -156.456, role: 'primary', upwind_order: 0, note: 'WeatherFlow paid/maintained sensor — gold standard calibration. All other stations are relative signal only.' },

  // FAR UPWIND — Open ocean buoys, 3-6 hour lead time for trade wind trends
  // These are the most reliable predictors of sustained wind changes
  buoy_se_hawaii: { id: null, ndbc: '51004', name: 'SE Hawaii Buoy (NDBC 51004)', lat: 17.538, lon: -152.230, role: 'far_upwind', upwind_order: 1, dist_km: 550, lead_hours: '4-6', note: '205nm SE of Hilo. Best far-field trade wind indicator. If trades drop here, Kanaha follows in 4-6h.' },
  buoy_sw_hawaii: { id: null, ndbc: '51002', name: 'SW Hawaii Buoy (NDBC 51002)', lat: 17.094, lon: -157.808, role: 'far_upwind', upwind_order: 2, dist_km: 450, lead_hours: '4-6', note: '215nm SSW of Hilo. Cross-reference for large-scale trade wind pattern.' },
  buoy_n_hawaii: { id: null, ndbc: '51000', name: 'N Hawaii Buoy (NDBC 51000)', lat: 23.534, lon: -153.752, role: 'north_ref', upwind_order: 3, dist_km: 300, lead_hours: '3-5', note: '245nm NE of Honolulu. North reference — trades taper here first when cooler air intrudes from north.' },

  // MEDIUM UPWIND — Big Island north tip, 1-2 hour lead time
  // Wind funnels through the Alenuihaha Channel between Maui and Big Island
  upolu_airport: { id: 188392, name: 'Upolu Airport', lat: 20.265, lon: -155.858, role: 'upwind_medium', upwind_order: 3, dist_km: 93.5, lead_hours: '1-2', note: 'Big Island north tip. ASOS station. KEY predictor — if wind tapers here at 3pm, Kanaha follows by 4pm.' },
  // kawaihae (4350) removed — west coast Big Island, lee/offshore flow, not representative of trade winds
  helco_upolu: { id: 681478, name: 'HELCO Upolu Airport Rd', lat: 20.256, lon: -155.857, role: 'upwind_medium', upwind_order: 5, dist_km: 94.4, lead_hours: '1-2', note: 'Secondary reading near Upolu Airport for validation.' },

  // LOCAL REFERENCE — Near Kanaha, for current conditions validation
  kahului_airport: { id: 643, name: 'Kahului Airport', lat: 20.900, lon: -156.430, role: 'local_ref', dist_km: 2.3, note: 'FAA ASOS — maintained, reliable for direction and speed. Slightly inland so reads minor direction/speed offset vs beach. Good cross-reference for Kanaha.' },
  kahului_harbor: { id: 4349, name: 'Kahului Harbor', lat: 20.900, lon: -156.470, role: 'local_ref', dist_km: 1.9, note: 'NOAA station, water temp available.' },

  // CHANNEL REFERENCE — Alenuihaha Channel and Maui isthmus
  maalaea: { id: 642710, name: 'Maalaea', lat: 20.801, lon: -156.489, role: 'channel_ref', dist_km: 11.2, note: 'Isthmus venturi indicator. Strong here = trades accelerating through gap.' },

  // HIGH ALTITUDE — Trade wind inversion indicator
  haleakala_hwy: { id: 645598, name: 'Haleakala Hwy', lat: 20.883, lon: -156.417, role: 'altitude', dist_km: 3.9, note: 'Elevated station. Temp diff vs sea level indicates inversion strength.' },
};

// ============================================================
// DIURNAL PATTERN MODEL
// ============================================================
// Based on analysis of historical Kanaha wind data.
// Times in HST (UTC-10).
//
// The Hawaiian trade wind diurnal cycle:
// 1. Pre-dawn (03:00-06:00): Trades at base level, katabatic drainage from Haleakala
//    can temporarily suppress or enhance coastal winds
// 2. Sunrise ramp (06:00-09:00): Solar heating begins, thermal component starts
//    adding to synoptic trades. Land heats faster than ocean.
// 3. Peak thermal (10:00-14:00): Maximum solar heating. Island thermal low draws
//    sea breeze component, amplifying trades on north shore.
// 4. Sustained peak (14:00-17:00): Often strongest period. Thermal + synoptic aligned.
//    Whether wind sustains into evening depends on synoptic gradient strength.
// 5. Evening transition (17:00-19:00): Solar heating fades. If synoptic gradient
//    is strong, wind barely drops. If weak, can lose 5-10 kts in 30 min.
// 6. Night (19:00-03:00): Pure synoptic flow. Often 40-70% of daytime peak.
//    Katabatic drainage from Haleakala creates variable light winds.

const DIURNAL_PHASES = [
  { phase: 'pre_dawn',    start_hst: 3,  end_hst: 6,  thermal_factor: 0.0,  desc: 'Katabatic drainage, base synoptic flow' },
  { phase: 'sunrise_ramp', start_hst: 6,  end_hst: 9,  thermal_factor: 0.3, desc: 'Solar heating begins, wind building' },
  { phase: 'morning_build', start_hst: 9, end_hst: 11, thermal_factor: 0.6, desc: 'Trades establishing, thermal amplification growing' },
  { phase: 'peak_thermal', start_hst: 11, end_hst: 14, thermal_factor: 1.0, desc: 'Maximum thermal enhancement, typically strongest winds' },
  { phase: 'sustained',    start_hst: 14, end_hst: 17, thermal_factor: 0.9, desc: 'Often sustained peak, depends on gradient' },
  { phase: 'evening_transition', start_hst: 17, end_hst: 19, thermal_factor: 0.4, desc: 'Thermal fading, gradient determines if wind holds' },
  { phase: 'early_night',  start_hst: 19, end_hst: 22, thermal_factor: 0.1, desc: 'Mostly synoptic, katabatic beginning' },
  { phase: 'late_night',   start_hst: 22, end_hst: 3,  thermal_factor: 0.0, desc: 'Pure synoptic + katabatic, minimum wind' },
];

// ============================================================
// PREDICTION VARIABLES
// ============================================================
// Additional factors that influence wind prediction accuracy.

const PREDICTION_VARIABLES = {
  // Pressure gradient between upwind stations and Kanaha
  // Strong gradient (>2 hPa over 50km) = wind will persist into evening
  pressure_gradient: {
    strong: { threshold_hpa_per_100km: 3, effect: 'Wind persists into evening, minimal taper' },
    moderate: { threshold_hpa_per_100km: 1.5, effect: 'Normal diurnal pattern, moderate evening taper' },
    weak: { threshold_hpa_per_100km: 0.5, effect: 'Wind dies early, heavy thermal dependence' },
  },

  // Cloud cover effect on thermal component
  // Clear skies = stronger thermal enhancement
  cloud_cover: {
    clear: { threshold_pct: 20, thermal_modifier: 1.2, desc: 'Enhanced thermal, earlier/stronger wind onset' },
    partly_cloudy: { threshold_pct: 50, thermal_modifier: 1.0, desc: 'Normal thermal cycle' },
    mostly_cloudy: { threshold_pct: 80, thermal_modifier: 0.6, desc: 'Reduced thermal, later onset, earlier taper' },
    overcast: { threshold_pct: 95, thermal_modifier: 0.3, desc: 'Minimal thermal, wind is purely synoptic' },
  },

  // Upwind station speed comparison
  // If upwind stations are reading higher than Kanaha, wind is still building
  // If upwind stations have dropped, Kanaha will follow in 1-3 hours
  upwind_lead_time_hours: 1.5, // typical lag from upwind Paia to Kanaha

  // Sea-land temperature differential
  // Larger diff = stronger thermal enhancement
  sea_land_temp: {
    strong: { diff_c: 3, thermal_boost: 1.3, desc: 'Strong sea breeze reinforcement' },
    moderate: { diff_c: 1.5, thermal_boost: 1.0, desc: 'Normal thermal' },
    weak: { diff_c: 0.5, thermal_boost: 0.7, desc: 'Minimal thermal' },
    reversed: { diff_c: -1, thermal_boost: 0.4, desc: 'Land cooler than sea, thermal opposing trades' },
  },

  // Pressure trend (3h change at Kanaha)
  pressure_trend: {
    rapid_fall: { threshold: -2, wind_change: 'increasing', desc: 'Approaching low/front, expect increasing wind' },
    falling: { threshold: -0.5, wind_change: 'building', desc: 'Gradient tightening, wind building' },
    steady: { threshold: 0.5, wind_change: 'steady', desc: 'Stable pattern, normal diurnal cycle' },
    rising: { threshold: 2, wind_change: 'moderating', desc: 'Gradient relaxing, wind easing' },
    rapid_rise: { threshold: 999, wind_change: 'dropping', desc: 'Post-frontal, expect significant wind decrease' },
  },

  // Trade Wind Inversion (TWI) height
  // Lower inversion = more consistent trades (wind channeled below inversion)
  // Higher/absent inversion = more variable, possible convective disruption
  // We infer this from temp lapse rate between sea level and elevated stations
};

// ============================================================
// ANALYSIS FUNCTIONS
// ============================================================

function getCurrentPhase(hstHour) {
  for (const p of DIURNAL_PHASES) {
    if (p.start_hst < p.end_hst) {
      if (hstHour >= p.start_hst && hstHour < p.end_hst) return p;
    } else {
      // Wraps midnight
      if (hstHour >= p.start_hst || hstHour < p.end_hst) return p;
    }
  }
  return DIURNAL_PHASES[0];
}

function analyzePressureGradient(stations, buoyData) {
  const kanaha = stations.find(s => s.id === 166192);
  if (!kanaha?.pres) return { gradient: null, strength: 'unknown' };

  // Use buoy pressure for far-field gradient
  const results = { kanaha_pres: kanaha.pres };

  if (buoyData) {
    for (const [buoyId, data] of Object.entries(buoyData)) {
      if (data.pres) {
        const diffHpa = data.pres - kanaha.pres;
        const distKm = data.dist_km || 500;
        results[`buoy_${buoyId}`] = {
          name: data.name,
          pressure: data.pres,
          diff_hpa: Math.round(diffHpa * 10) / 10,
          gradient_per_100km: Math.round((diffHpa / distKm) * 100 * 10) / 10,
        };
      }
    }
  }

  // Use upwind medium stations for regional gradient
  const upwindMed = stations.filter(s => (s.role === 'upwind_medium') && s.pres);
  if (upwindMed.length > 0) {
    const avgPres = upwindMed.reduce((a, s) => a + s.pres, 0) / upwindMed.length;
    const avgDist = upwindMed.reduce((a, s) => a + (s.dist_km || 100), 0) / upwindMed.length;
    const diff = avgPres - kanaha.pres;
    results.regional = {
      avg_upwind_pres: Math.round(avgPres * 10) / 10,
      diff_hpa: Math.round(diff * 10) / 10,
      gradient_per_100km: Math.round((diff / avgDist) * 100 * 10) / 10,
    };
  }

  // Overall gradient strength assessment
  // Check buoy gradient first (most reliable large-scale indicator)
  const buoyGradients = Object.values(results).filter(v => v?.gradient_per_100km);
  const maxGrad = buoyGradients.length > 0 ? Math.max(...buoyGradients.map(v => Math.abs(v.gradient_per_100km))) : 0;

  let strength;
  if (maxGrad > 0.5) strength = 'strong';
  else if (maxGrad > 0.2) strength = 'moderate';
  else if (maxGrad > 0) strength = 'weak';
  else strength = 'unknown';

  results.strength = strength;
  return results;
}

function analyzeUpwindTrend(stations, buoyData) {
  const kanaha = stations.find(s => s.id === 166192);
  if (!kanaha?.avg) return { trend: 'unknown', kanaha_avg: null };

  const result = {
    kanaha_avg: kanaha.avg,
    kanaha_dir: kanaha.dir_txt,
    medium_upwind: [],
    far_upwind: [],
    trend: 'unknown',
    prediction: '',
  };

  // Medium upwind (Upolu) — 1-2 hour lead time
  // KEY INSIGHT: Don't compare raw kts between stations — each has unique calibration.
  // Instead, track each station's OWN trend (is it rising/falling/steady relative to itself?)
  const medUpwind = stations.filter(s => s.role === 'upwind_medium' && s.avg > 0);
  for (const s of medUpwind) {
    const networkEntry = STATION_NETWORK[Object.keys(STATION_NETWORK).find(k => STATION_NETWORK[k].id === s.id)];
    result.medium_upwind.push({
      name: s.name,
      avg_kts: s.avg,
      gust_kts: s.gust,
      dir: s.dir_txt,
      dir_deg: s.dir ?? null,
      lead_hours: networkEntry?.lead_hours || '1-2',
      // Gust-to-avg ratio indicates steadiness at that station
      gust_ratio: s.gust && s.avg ? Math.round((s.gust / s.avg) * 100) / 100 : null,
    });
  }

  // Far upwind (NDBC buoys) — 4-6 hour lead time
  // Same principle: we care about each buoy's OWN trend, not raw comparison to Kanaha.
  // A buoy at 17kts is not "weaker" than Kanaha at 23kts — it's open ocean vs coastal thermal boost.
  if (buoyData) {
    for (const [id, data] of Object.entries(buoyData)) {
      const windKts = data.wind_speed_kts || data.met?.wind_speed_kts;
      const gustKts = data.wind_gust_kts || data.met?.wind_gust_kts;
      const windDir = data.wind_dir || data.met?.wind_dir_deg;
      if (windKts) {
        result.far_upwind.push({
          name: data.name,
          avg_kts: windKts,
          gust_kts: gustKts,
          dir_deg: windDir,
          lead_hours: '4-6',
          gust_ratio: gustKts && windKts ? Math.round((gustKts / windKts) * 100) / 100 : null,
        });
      }
    }
  }
  const farAvg = result.far_upwind.length > 0 ? result.far_upwind.reduce((a, s) => a + s.avg_kts, 0) / result.far_upwind.length : null;

  // Determine trend from medium upwind using SELF-RELATIVE signals, not raw comparison
  // Signals that upwind is tapering: gustiness increasing (gust_ratio > 1.5), direction shifting
  if (medUpwind.length > 0) {
    const medAvg = medUpwind.reduce((a, s) => a + s.avg, 0) / medUpwind.length;
    const medGustRatio = medUpwind.reduce((a, s) => a + (s.gust && s.avg ? s.gust / s.avg : 1), 0) / medUpwind.length;
    const kanahaGustRatio = kanaha.gust && kanaha.avg ? kanaha.gust / kanaha.avg : 1;
    result.medium_upwind_avg = Math.round(medAvg * 10) / 10;
    result.medium_gust_ratio = Math.round(medGustRatio * 100) / 100;
    result.kanaha_gust_ratio = Math.round(kanahaGustRatio * 100) / 100;

    // Compare gustiness: upwind getting gustier than Kanaha = trades becoming less organized
    // This is calibration-independent
    if (medGustRatio > 1.5 && kanahaGustRatio < 1.3) {
      result.trend = 'upwind_destabilizing';
      result.prediction = `Upwind stations getting gusty (gust ratio ${result.medium_gust_ratio}x vs Kanaha ${result.kanaha_gust_ratio}x) — trades may become inconsistent in 1-2h`;
    } else if (medGustRatio < 1.2 && kanahaGustRatio < 1.3) {
      result.trend = 'steady_trades';
      result.prediction = 'Both upwind and Kanaha showing steady, organized flow — expect conditions to hold 1-2h';
    } else if (medGustRatio > 1.4) {
      result.trend = 'upwind_gusty';
      result.prediction = `Upwind flow becoming variable (gust ratio ${result.medium_gust_ratio}x) — may see shifts at Kanaha in 1-2h`;
    } else {
      result.trend = 'nominal';
      result.prediction = 'Upwind readings within normal range — no major changes expected in 1-2h';
    }

    // Direction check: if upwind direction is shifting away from NE trades, that's a signal
    const upwindDirs = medUpwind.filter(s => s.dir_txt).map(s => s.dir_txt);
    const tradeDirections = ['NE', 'ENE', 'E', 'NNE'];
    const nonTradeUpwind = upwindDirs.filter(d => !tradeDirections.includes(d));
    if (nonTradeUpwind.length > 0) {
      result.trend = 'direction_shift';
      result.prediction += ` ⚠️ Direction shifting (${nonTradeUpwind.join(', ')}) — trades may be weakening`;
    }
  }

  // Far-field context: absolute thresholds make sense for open-ocean buoys since
  // they're measuring true synoptic trade wind strength, unaffected by terrain/thermal
  if (farAvg != null) {
    result.far_upwind_avg = Math.round(farAvg * 10) / 10;
    if (farAvg < 10) {
      result.far_field_outlook = 'Far-field buoys showing light trades — wind may not sustain into evening';
    } else if (farAvg < 15) {
      result.far_field_outlook = 'Moderate trades at buoy level — normal diurnal pattern expected';
    } else {
      result.far_field_outlook = 'Strong trades at buoy level — wind likely to persist well into evening';
    }
  }

  // Wind shadow detection — learned from 2026-03-04 debrief
  // When Kanaha direction rotates to due-East (80-100°), the wind comes from behind
  // the shoreline tree line rather than off the water. This creates an extended wind
  // shadow projecting offshore — dead zone 500m+ from beach, dramatic wind line,
  // extreme turbulence and lull-blast cycles. Nearly unrideable near-shore.
  //
  // Trigger conditions (all three required):
  //   1. kanaha_dir > 80° (side-offshore to offshore at north-facing beach)
  //   2. direction_divergence > 15° (upwind ENE but Kanaha rotated to E — isthmus bending)
  //   3. gust_ratio > 1.35 (pulsing, not smooth)
  const kanahaDir = kanaha.dir ?? kanaha.dir_deg;  // 'dir' is the raw degrees field
  const medUpwindDirs = medUpwind.map(s => s.dir_deg ?? s.dir).filter(d => d != null);
  const medAvgDir = medUpwindDirs.length > 0
    ? medUpwindDirs.reduce((a, b) => a + b, 0) / medUpwindDirs.length
    : null;
  const dirDivergence = (kanahaDir != null && medAvgDir != null)
    ? Math.abs(kanahaDir - medAvgDir)
    : null;
  const kanahaGustRatioFinal = kanaha.gust && kanaha.avg ? kanaha.gust / kanaha.avg : 1;

  if (kanahaDir > 80 && dirDivergence > 15 && kanahaGustRatioFinal > 1.35) {
    result.wind_shadow_risk = true;
    result.wind_shadow_desc = `⚠️ WIND SHADOW RISK: Kanaha wind rotated to ${Math.round(kanahaDir)}° (E) vs upwind ${Math.round(medAvgDir)}°ENE — ${Math.round(dirDivergence)}° isthmus rotation. Wind coming from behind shoreline trees, not off water. Expect extended dead zone 300-700m offshore, dramatic wind line, 10kt+ lull-blast cycles. Conditions very difficult near-shore.`;
  } else {
    result.wind_shadow_risk = false;
    result.wind_shadow_desc = null;
  }
  result.kanaha_dir_deg = kanahaDir;
  result.upwind_dir_deg = medAvgDir ? Math.round(medAvgDir) : null;
  result.dir_divergence_deg = dirDivergence ? Math.round(dirDivergence) : null;

  return result;
}

function analyzeHistoricalPattern(windHistory) {
  // Bucket observations into HST hours and find the diurnal pattern
  const hourBuckets = {};
  for (const obs of windHistory) {
    const utcHour = parseInt(obs.t.split(':')[0]);
    const hstHour = (utcHour - 10 + 24) % 24;
    if (!hourBuckets[hstHour]) hourBuckets[hstHour] = [];
    hourBuckets[hstHour].push(obs.v);
  }

  const hourlyStats = {};
  for (const [hour, values] of Object.entries(hourBuckets)) {
    const sorted = [...values].sort((a, b) => a - b);
    hourlyStats[hour] = {
      hour: parseInt(hour),
      avg: Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10,
      median: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
      count: values.length,
    };
  }

  // Find peak and trough
  const hours = Object.values(hourlyStats).sort((a, b) => a.hour - b.hour);
  const peakHour = hours.reduce((max, h) => h.avg > max.avg ? h : max, hours[0]);
  const troughHour = hours.reduce((min, h) => h.avg < min.avg ? h : min, hours[0]);

  // Determine if yesterday's evening wind held strong (pushed into evening)
  const eveningHours = hours.filter(h => h.hour >= 17 && h.hour <= 20);
  const eveningAvg = eveningHours.length > 0 ? eveningHours.reduce((a, h) => a + h.avg, 0) / eveningHours.length : 0;
  const peakAvg = peakHour.avg;
  const eveningRetention = peakAvg > 0 ? Math.round((eveningAvg / peakAvg) * 100) : 0;

  return {
    hourly: hours,
    peak: { hour_hst: peakHour.hour, avg_kts: peakHour.avg },
    trough: { hour_hst: troughHour.hour, avg_kts: troughHour.avg },
    evening_retention_pct: eveningRetention,
    evening_held: eveningRetention > 60,
    pattern_desc: eveningRetention > 70
      ? 'Strong trades — wind persisted into evening (synoptic dominant)'
      : eveningRetention > 40
        ? 'Normal trade pattern — moderate evening taper'
        : 'Thermal-dependent — wind dropped significantly in evening',
  };
}

function predictTaper(currentAvg, currentHstHour, historicalPattern, upwindTrend, pressureGrad, thermalMod = 1.0, cloudHourly = null, thermalSpread = null, iktrrm = null, nwsWindKts = null) {
  const remainingHours = [];
  const taper_warnings = [];

  // PHYSICAL DIURNAL MODEL: Peak wind is when sun is overhead (11-14h HST).
  // After peak, thermal component fades with sun angle. Evening surges are rare exceptions.
  //
  // The thermal component adds ~30-50% on top of synoptic base. As thermal fades,
  // wind returns toward synoptic base. Historical evening_retention tells us how much
  // of peak wind persists (60-80% = strong synoptic, 30-50% = thermal-dominant).
  const eveningRetention = (historicalPattern.evening_retention_pct || 60) / 100;

  // Estimate synoptic base: the floor wind that persists after thermal fades
  // Use thermal spread if available — if Kanaha-Airport spread is known,
  // synoptic base ≈ currentAvg minus the thermal spread component
  let synopticBase;
  if (thermalSpread && thermalSpread.spread_kts > 0) {
    // Airport reads mostly synoptic; Kanaha = synoptic + thermal boost
    // Use airport reading as synoptic proxy, but airport also has SOME thermal
    // so add a small fraction back. Synoptic ≈ airport * 1.05
    synopticBase = thermalSpread.airport_kts * 1.05;
  } else {
    synopticBase = currentAvg * eveningRetention;
  }

  // ── Synoptic floor ──────────────────────────────────────────────────
  // Debrief 2026-03-07: model predicted 11.4kts but actual was 19.3kts.
  // Root cause: morning cloud suppression gave artificially low baseline,
  // model anchored on it without considering the strong pressure gradient.
  // Fix: enforce a floor based on gradient-implied minimum wind.
  let synopticFloor = 0;
  if (pressureGrad.strength === 'strong') {
    synopticFloor = synopticBase * 0.9;
  } else if (pressureGrad.strength === 'moderate') {
    synopticFloor = synopticBase * 0.75;
  }

  // Build iktrrm lookup by hour for cross-checking
  const iktByHour = {};
  if (iktrrm && Array.isArray(iktrrm)) {
    for (const f of iktrrm) {
      if (f.hour_hst != null && f.avg_kts != null) {
        iktByHour[f.hour_hst] = f.avg_kts;
      }
    }
  }

  // Thermal decay curve: peaks at 12-13h, fades to 0 by ~19h
  function thermalFraction(h) {
    if (h <= 9) return 0.3;
    if (h <= 11) return 0.6 + (h - 9) * 0.2; // ramp up
    if (h <= 14) return 1.0; // peak
    if (h <= 19) return Math.max(0, 1.0 - (h - 14) * 0.2); // fade: 0.8, 0.6, 0.4, 0.2, 0
    return 0;
  }

  const currentThermalFrac = thermalFraction(currentHstHour);
  const currentThermalComponent = currentThermalFrac > 0
    ? (currentAvg - synopticBase) / currentThermalFrac
    : 0;

  for (let h = Math.ceil(currentHstHour); h <= 20; h++) {
    const phase = getCurrentPhase(h);

    // Base prediction: synoptic + thermal(h)
    const futureThermalFrac = thermalFraction(h);
    let predicted = synopticBase + currentThermalComponent * futureThermalFrac;

    // Modifier from current signals
    let modifier = 1.0;

    // Upwind trend (calibration-independent)
    if (upwindTrend.trend === 'upwind_destabilizing') modifier *= 0.9;
    else if (upwindTrend.trend === 'steady_trades') modifier *= 1.05;
    else if (upwindTrend.trend === 'direction_shift') modifier *= 0.85;

    // Pressure gradient affects synoptic persistence
    if (pressureGrad.strength === 'strong') modifier *= 1.1;
    else if (pressureGrad.strength === 'weak') modifier *= 0.9;

    // Cloud cover dampens thermal component — USE FORECAST for future hours, not current snapshot
    // This was the #1 prediction error source: noon 78% cloud → 5pm was actually 100%
    const hourCloudMod = cloudHourly?.[h]?.thermal_mod ?? thermalMod;

    if (h >= 9 && h <= 18 && futureThermalFrac > 0) {
      // Only modify the thermal portion, not synoptic base
      const thermalPortion = currentThermalComponent * futureThermalFrac;
      const adjustedThermal = thermalPortion * hourCloudMod;
      predicted = synopticBase * modifier + adjustedThermal;
    } else {
      predicted *= modifier;
    }

    // After peak (14h), cap at max of current reading OR synoptic base * 1.3
    // (Debrief 2026-03-07: old hard cap prevented predictions from exceeding
    // a cloud-suppressed morning reading. Synoptic base anchors the ceiling instead.)
    if (h > 14) {
      const ceiling = Math.max(currentAvg, synopticBase * 1.3);
      if (predicted > ceiling) predicted = ceiling;
    }

    // Monotonic non-increasing after 14h
    if (h > 14 && remainingHours.length > 0) {
      const prev = remainingHours[remainingHours.length - 1].predicted_avg_kts;
      if (predicted > prev) predicted = prev;
    }

    // ── Synoptic floor enforcement ──────────────────────────────────
    // Never predict below gradient-implied minimum
    if (predicted < synopticFloor) predicted = synopticFloor;

    // ── iKitesurf cross-check ───────────────────────────────────────
    // When taper diverges >30% below iktrrm for a given hour, blend upward.
    // Trust iktrrm more (0.6 weight) since it incorporates mesoscale models.
    const iktVal = iktByHour[h];
    if (iktVal != null && predicted < iktVal * 0.7) {
      predicted = predicted * 0.4 + iktVal * 0.6;
    }

    predicted = Math.round(Math.max(0, predicted) * 10) / 10;
    const histHour = historicalPattern.hourly.find(x => x.hour === h);

    remainingHours.push({
      hour_hst: h,
      phase: phase.phase,
      predicted_avg_kts: predicted,
      historical_avg_kts: histHour?.avg || null,
      thermal_fraction: Math.round(futureThermalFrac * 100),
      confidence: h - currentHstHour < 3 ? 'high' : h - currentHstHour < 6 ? 'medium' : 'low',
    });
  }

  // ── NWS cross-check warning ─────────────────────────────────────
  // When NWS wind forecast significantly exceeds taper peak, flag it
  if (nwsWindKts != null && remainingHours.length > 0) {
    const taperPeak = Math.max(...remainingHours.map(h => h.predicted_avg_kts));
    if (taperPeak < nwsWindKts * 0.7) {
      taper_warnings.push(`Taper peak ${taperPeak}kts is ${Math.round((1 - taperPeak / nwsWindKts) * 100)}% below NWS forecast ${nwsWindKts}kts — model may be underestimating due to suppressed baseline`);
    }
  }

  // ── iKitesurf peak cross-check warning ──────────────────────────
  if (Object.keys(iktByHour).length > 0 && remainingHours.length > 0) {
    const taperPeak = Math.max(...remainingHours.map(h => h.predicted_avg_kts));
    const iktPeak = Math.max(...Object.values(iktByHour));
    if (taperPeak < iktPeak * 0.7) {
      taper_warnings.push(`Taper peak ${taperPeak}kts is ${Math.round((1 - taperPeak / iktPeak) * 100)}% below iKitesurf peak ${iktPeak}kts`);
    }
  }

  if (taper_warnings.length > 0) {
    remainingHours.taper_warnings = taper_warnings;
  }

  return remainingHours;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // Load saved session — no login, no duplicate session conflict
  process.stderr.write('wind-prediction: loading session... ');
  let browser, page, token;
  try {
    ({ browser, page, token } = await loadSession());
  } catch (e) {
    process.stderr.write(`FAILED\n  ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write('done\n');

  // Fetch NDBC buoy data (far upwind)
  process.stderr.write('wind-prediction: fetching buoy data... ');
  const buoyData = {};
  for (const buoyId of ['51004', '51002', '51000']) {
    try {
      const meta = Object.values(STATION_NETWORK).find(s => s.ndbc === buoyId);
      const entry = { name: meta?.name || `Buoy ${buoyId}`, dist_km: meta?.dist_km || 500 };

      // Segment 1: Standard meteorological — wind, pressure, temperature
      const metText = await fetchText(`https://www.ndbc.noaa.gov/data/realtime2/${buoyId}.txt`);
      const metLines = metText.trim().split('\n');
      if (metLines.length >= 3) {
        const c = metLines[2].trim().split(/\s+/);
        const v = (i) => c[i] !== 'MM' ? parseFloat(c[i]) : null;
        const wsMs = v(6);
        const wgMs = v(7);
        entry.met = {
          time_utc: `${c[0]}-${c[1]}-${c[2]}T${c[3]}:${c[4]}Z`,
          wind_dir_deg: v(5) != null ? parseInt(c[5]) : null,
          wind_speed_ms: wsMs,
          wind_speed_kts: wsMs ? Math.round(wsMs * 1.94384 * 10) / 10 : null,
          wind_gust_ms: wgMs,
          wind_gust_kts: wgMs ? Math.round(wgMs * 1.94384 * 10) / 10 : null,
          pressure_hpa: v(12),
          pressure_tendency_hpa: c[17] !== 'MM' ? parseFloat(c[17]) : null,
          air_temp_c: v(13),
          water_temp_c: v(14),
          dewpoint_c: v(15),
        };
        // Flatten key fields for backward compat
        entry.wind_dir = entry.met.wind_dir_deg;
        entry.wind_speed_kts = entry.met.wind_speed_kts;
        entry.wind_gust_kts = entry.met.wind_gust_kts;
        entry.pres = entry.met.pressure_hpa;
        entry.air_temp_c = entry.met.air_temp_c;
        entry.water_temp_c = entry.met.water_temp_c;
      }

      // Segment 2: Spectral wave summary — swell and wind-wave decomposition
      try {
        const specText = await fetchText(`https://www.ndbc.noaa.gov/data/realtime2/${buoyId}.spec`);
        const specLines = specText.trim().split('\n');
        if (specLines.length >= 3) {
          const s = specLines[2].trim().split(/\s+/);
          const sv = (i) => s[i] !== 'MM' ? parseFloat(s[i]) : null;
          entry.waves = {
            time_utc: `${s[0]}-${s[1]}-${s[2]}T${s[3]}:${s[4]}Z`,
            total_wave_ht_m: sv(5),
            swell_ht_m: sv(6),
            swell_period_s: sv(7),
            wind_wave_ht_m: sv(8),
            wind_wave_period_s: sv(9),
            swell_dir: s[10] !== 'MM' ? s[10] : null,
            wind_wave_dir: s[11] !== 'MM' ? s[11] : null,
            steepness: s[12] !== 'MM' ? s[12] : null,
            avg_period_s: sv(13),
            mean_wave_dir_deg: sv(14),
          };
        }
      } catch (e) { /* spec file not available for this buoy */ }

      buoyData[buoyId] = entry;
    } catch (e) { /* buoy fetch failed, continue */ }
  }
  process.stderr.write('done\n');

  // Fetch Open-Meteo atmospheric data (pressure trends, cloud cover)
  process.stderr.write('wind-prediction: fetching atmospheric data... ');
  let atmosData = null;
  try {
    atmosData = await fetchJSON('https://api.open-meteo.com/v1/forecast?latitude=20.896&longitude=-156.452&hourly=pressure_msl,cloudcover,cloudcover_low,temperature_2m,precipitation_probability&forecast_days=2&past_days=1&timezone=Pacific/Honolulu');
  } catch (e) { /* atmospheric fetch failed */ }
  process.stderr.write('done\n');

  // Parse atmospheric trends
  let pressureTrend = null;
  let cloudCover = null;
  let thermalModifier = 1.0;
  if (atmosData?.hourly) {
    const h = atmosData.hourly;
    const nowIdx = h.time?.findIndex(t => new Date(t) > new Date()) - 1;
    if (nowIdx >= 3) {
      const currentPres = h.pressure_msl[nowIdx];
      const pres3hAgo = h.pressure_msl[nowIdx - 3];
      pressureTrend = currentPres && pres3hAgo ? Math.round((currentPres - pres3hAgo) * 10) / 10 : null;
    }
    if (nowIdx >= 0) {
      cloudCover = {
        current_pct: h.cloudcover?.[nowIdx],
        low_pct: h.cloudcover_low?.[nowIdx],
        precip_prob_pct: h.precipitation_probability?.[nowIdx],
        // 6-hour forecast
        forecast: Array.from({ length: 6 }, (_, i) => ({
          hour_offset: i + 1,
          cloud_pct: h.cloudcover?.[nowIdx + i + 1],
          precip_prob_pct: h.precipitation_probability?.[nowIdx + i + 1],
        })),
      };

      // Compute thermal modifier from cloud cover (current snapshot — used as fallback)
      const cc = cloudCover.current_pct;
      if (cc != null) {
        if (cc < 20) thermalModifier = 1.2;
        else if (cc < 50) thermalModifier = 1.0;
        else if (cc < 80) thermalModifier = 0.6;
        else thermalModifier = 0.3;
      }

      // Build PER-HOUR cloud forecast for dynamic thermal prediction
      // This was the #1 source of error: using noon snapshot to predict 5pm
      cloudCover.hourly_forecast = {};
      for (let i = 0; i < h.time.length; i++) {
        const t = h.time[i];
        const hstHour = new Date(t).getHours(); // already in HST from timezone param
        const ccPct = h.cloudcover?.[i];
        if (ccPct != null) {
          let mod;
          if (ccPct < 20) mod = 1.2;
          else if (ccPct < 50) mod = 1.0;
          else if (ccPct < 80) mod = 0.6;
          else mod = 0.3;
          // Store by date-hour key to handle multi-day
          const dateKey = t.substring(0, 10);
          const key = `${dateKey}_${hstHour}`;
          cloudCover.hourly_forecast[key] = { cloud_pct: ccPct, thermal_mod: mod };
          // Also store just by hour for today (simple lookup)
          const today = new Date().toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 10);
          if (dateKey === today) {
            cloudCover.hourly_forecast[hstHour] = { cloud_pct: ccPct, thermal_mod: mod };
          }
        }
      }
    }
  }

  // Fetch station network current readings
  process.stderr.write('wind-prediction: fetching station network... ');
  const stationIds = Object.values(STATION_NETWORK).filter(s => s.id).map(s => s.id).join(',');
  const stationsRaw = await page.evaluate(async (ids) => {
    const t = typeof token !== 'undefined' ? token : '';
    const url = `https://api.weatherflow.com/wxengine/rest/spot/getSpotDetailSetByList?spot_list=${ids}&units_wind=kts&units_temp=c&units_distance=km&include_spot_products=true&wf_token=${t}`;
    const r = await fetch(url);
    return r.json();
  }, stationIds);
  process.stderr.write('done\n');

  // Parse station data — observations are in stations[0].data_values[0]
  // with field names in spot.data_names
  const stationReadings = (stationsRaw.spots || []).map(s => {
    const meta = Object.values(STATION_NETWORK).find(n => n.id === s.spot_id) || {};
    const names = s.data_names || [];
    const station = s.stations?.[0];
    const vals = station?.data_values?.[0] || [];
    const get = (field) => { const i = names.indexOf(field); return i >= 0 ? vals[i] : null; };
    return {
      id: s.spot_id,
      name: s.name,
      role: meta.role || 'unknown',
      upwind_order: meta.upwind_order,
      dist_km: meta.dist_km,
      avg: get('avg'),
      gust: get('gust'),
      lull: get('lull'),
      dir: get('dir'),
      dir_txt: get('dir_text'),
      pres: get('pres'),
      atemp: get('atemp'),
      wtemp: get('wtemp'),
      timestamp: get('timestamp'),
      wind_desc: get('wind_desc'),
    };
  });

  // Fetch 48h history for Kanaha
  process.stderr.write('wind-prediction: fetching 48h history... ');
  const historyRaw = await page.evaluate(async () => {
    const t = typeof token !== 'undefined' ? token : '';
    const url = `https://api.weatherflow.com/wxengine/rest/graph/getGraph?spot_id=166192&model_ids=-7&fields=wind&format=json&type=dataonly&null_ob_min_from_now=30&show_virtual_obs=true&time_start_offset_hours=-48&time_end_offset_hours=0&units_wind=kts&units_temp=c&wf_token=${t}`;
    const r = await fetch(url);
    return r.json();
  });
  process.stderr.write('done\n');

  const windHistory = (historyRaw.wind_avg_data || [])
    .filter(p => p[1] !== null)
    .map(p => ({ t: new Date(p[0]).toISOString().substring(11, 16), v: Math.round(p[1] * 10) / 10 }));

  // Run analyses
  const pressureGrad = analyzePressureGradient(stationReadings, buoyData);
  const upwindTrend = analyzeUpwindTrend(stationReadings, buoyData);
  const historicalPattern = analyzeHistoricalPattern(windHistory);

  const nowUTC = new Date();
  // Convert to HST by formatting in that timezone
  const hstStr = nowUTC.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour12: false });
  const hstParts = hstStr.split(', ')[1]?.split(':') || [];
  const hstHourRaw = parseInt(hstParts[0]) || 0;
  const hstMinRaw = parseInt(hstParts[1]) || 0;
  const currentHstHour = hstHourRaw + hstMinRaw / 60;
  const nowHST = new Date(nowUTC.getTime() - 10 * 3600000); // for display only
  const currentPhase = getCurrentPhase(Math.floor(currentHstHour));
  const kanaha = stationReadings.find(s => s.id === 166192);

  // ── Thermal spread analysis ──────────────────────────────────────
  // Kanaha vs Kahului Airport: when Kanaha reads significantly higher than
  // Airport, the difference is thermal boost (Airport is inland, less thermal).
  // This spread shrinks to near zero at sunset — a real-time thermal indicator.
  const airport = stationReadings.find(s => s.id === 643);
  const thermalSpread = kanaha?.avg && airport?.avg ? {
    kanaha_kts: kanaha.avg,
    airport_kts: airport.avg,
    spread_kts: Math.round((kanaha.avg - airport.avg) * 10) / 10,
    spread_pct: Math.round(((kanaha.avg - airport.avg) / kanaha.avg) * 100),
    note: kanaha.avg - airport.avg > 3
      ? 'Strong thermal boost at beach vs inland — thermal still active'
      : kanaha.avg - airport.avg > 1
        ? 'Moderate thermal difference — thermal starting to fade'
        : 'Kanaha ≈ Airport — thermal component minimal, pure synoptic flow',
  } : null;

  // ── Sea-land temperature differential ──────────────────────────────
  // Larger sea-land temp diff = stronger onshore thermal enhancement
  // Water temp from harbor station, air temp from airport or Kanaha
  const harbor = stationReadings.find(s => s.id === 4349);
  const waterTemp = harbor?.wtemp || kanaha?.wtemp;
  const airTemp = airport?.atemp || kanaha?.atemp;
  const seaLandTemp = waterTemp != null && airTemp != null ? {
    water_temp_c: waterTemp,
    air_temp_c: airTemp,
    diff_c: Math.round((waterTemp - airTemp) * 10) / 10,
    thermal_boost: waterTemp - airTemp > 3 ? 'strong' :
      waterTemp - airTemp > 1.5 ? 'moderate' :
      waterTemp - airTemp > 0 ? 'weak' : 'reversed',
    note: waterTemp > airTemp
      ? `Sea ${Math.round((waterTemp - airTemp) * 10) / 10}°C warmer than land — drives onshore thermal flow`
      : 'Land warmer than sea — thermal opposing trades (unusual)',
  } : null;

  // ── Synoptic base estimation ───────────────────────────────────────
  // Multiple methods to estimate the synoptic (non-thermal) wind floor:
  // 1. Historical evening retention (yesterday's pattern)
  // 2. Current Upolu reading (mostly synoptic, minimal thermal)
  // 3. Far-field buoy average (pure synoptic)
  const upoluReading = stationReadings.find(s => s.id === 188392)?.avg;
  const farFieldAvg = upwindTrend.far_upwind_avg;
  const synopticEstimates = {
    from_evening_retention: Math.round(kanaha?.avg * historicalPattern.evening_retention_pct / 100 * 10) / 10,
    from_upolu: upoluReading || null,
    from_far_field: farFieldAvg || null,
  };
  // Use median of available estimates for robustness
  const synEstValues = Object.values(synopticEstimates).filter(v => v != null && v > 0);
  const estimatedSynopticBase = synEstValues.length > 0
    ? synEstValues.sort((a, b) => a - b)[Math.floor(synEstValues.length / 2)]
    : (kanaha?.avg || 15) * 0.6;

  const taperPrediction = predictTaper(
    kanaha?.avg || 15,
    currentHstHour,
    historicalPattern,
    upwindTrend,
    pressureGrad,
    thermalModifier,
    cloudCover?.hourly_forecast || null,
    thermalSpread
  );

  // Compile output
  const output = {
    source: 'wind-prediction',
    location: 'Kanaha, Maui HI',
    fetched_utc: nowUTC.toISOString(),
    current_hst: nowHST.toISOString().replace('T', ' ').substring(0, 16) + ' HST',

    current_phase: {
      phase: currentPhase.phase,
      description: currentPhase.desc,
      thermal_factor: currentPhase.thermal_factor,
    },

    station_network: stationReadings,

    pressure_gradient: pressureGrad,
    upwind_analysis: upwindTrend,
    historical_pattern: historicalPattern,
    taper_prediction: taperPrediction,

    buoy_data: buoyData,

    thermal_analysis: {
      kanaha_airport_spread: thermalSpread,
      sea_land_temp: seaLandTemp,
      synoptic_base_estimates: synopticEstimates,
      estimated_synoptic_base_kts: estimatedSynopticBase,
    },

    atmosphere: {
      pressure_trend_3h_hpa: pressureTrend,
      cloud_cover: cloudCover,
      thermal_modifier: thermalModifier,
    },

    summary: {
      current_wind: `${kanaha?.avg || '?'} kts ${kanaha?.dir_txt || '?'}`,
      phase: currentPhase.phase,
      upwind_trend: upwindTrend.trend,
      upwind_prediction: upwindTrend.prediction,
      far_field_outlook: upwindTrend.far_field_outlook || 'No buoy data',
      pressure_gradient: pressureGrad.strength,
      pressure_trend_3h: pressureTrend != null ? `${pressureTrend > 0 ? '+' : ''}${pressureTrend} hPa` : 'unknown',
      cloud_cover_pct: cloudCover?.current_pct,
      thermal_modifier: thermalModifier,
      evening_outlook: historicalPattern.evening_held
        ? 'Wind likely to persist into evening (based on yesterday + current gradient)'
        : 'Wind likely to taper before sunset',
      yesterday_peak: `${historicalPattern.peak.avg_kts} kts at ${historicalPattern.peak.hour_hst}:00 HST`,
      yesterday_evening_retention: `${historicalPattern.evening_retention_pct}%`,
    },

    prediction_variables: Object.keys(PREDICTION_VARIABLES),
  };

  console.log(JSON.stringify(output, null, 2));
  await browser.close();
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
