#!/usr/bin/env node
/**
 * equipment-rec.mjs — Equipment recommendations based on conditions
 *
 * BATHYMETRY MODEL — Kanaha Beach to Old Mans Reef:
 *
 *   Shore ──── 200m ──── 300m ──── 400m+ ──── Old Mans Reef
 *              │          │          │              │
 *   AT MLLW:  waist     shoulder   chest+     waist (reef top)
 *   (0ft tide) ~0.9m     ~1.3m     ~1.5m+        ~0.9m
 *
 *   The "inside section" is the area between shore and the reef.
 *   Old Mans reef creates a breaking wave popular for all watersports.
 *   The reef top is the shallowest hazard — damages foil masts.
 *
 * TIDE → DEPTH → MAST LENGTH:
 *   NOAA tide level is referenced to MLLW (Mean Lower Low Water).
 *   At MLLW (0.0ft tide), reef top depth ≈ 0.9m (waist deep).
 *   Each +1ft tide adds ~0.3m depth everywhere.
 *
 *   depth_at_reef(tide_ft) = 0.9 + (tide_ft * 0.3048)  [meters]
 *
 *   Mast clearance: need ~15cm minimum between mast tip and bottom
 *   to avoid strikes on bumps/swell troughs.
 *
 *   max_safe_mast(tide_ft) = depth_at_reef(tide_ft) - 0.15  [meters]
 *
 * MAST RECOMMENDATIONS:
 *   Lowest tide (<0.0ft):  72cm mast max
 *   Low-mid tide (0-1ft):  72-85cm depending on exact level
 *   Mid tide (1-2ft):      85cm mast
 *   High tide (>2ft):      90-100cm mast
 *
 * Future: front wing, tail wing, kite size, line length, board size
 *
 * Outputs JSON to stdout.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Bathymetry Model ─────────────────────────────────────────────────
// Depth at MLLW (0.0ft tide reference) in meters
const BATHYMETRY = {
  zones: [
    { name: 'shore_shallow',  dist_from_shore_m: '0-100',   depth_at_mllw_m: 0.5,  desc: 'Shallow wading area' },
    { name: 'inside_mid',     dist_from_shore_m: '100-200', depth_at_mllw_m: 0.9,  desc: 'Waist deep at low tide — primary launch/ride area' },
    { name: 'inside_deep',    dist_from_shore_m: '200-300', depth_at_mllw_m: 1.3,  desc: 'Shoulder deep at low tide' },
    { name: 'inside_channel', dist_from_shore_m: '300-400', depth_at_mllw_m: 1.5,  desc: 'Chest+ deep, deeper channel before reef' },
    { name: 'old_mans_reef',  dist_from_shore_m: '400+',    depth_at_mllw_m: 0.9,  desc: 'Old Mans reef top — shallowest hazard, popular surf break' },
  ],
  critical_depth_zone: 'old_mans_reef', // this is where mast strikes happen
  reef_depth_at_mllw_m: 0.9,
  safety_clearance_m: 0.15, // minimum gap between mast tip and bottom
};

// ── Depth Calculator ─────────────────────────────────────────────────
function depthAtTide(tideLevelFt, zoneDepthAtMllw) {
  // NOAA tide level is relative to MLLW
  // +1ft tide = +0.3048m water everywhere
  return zoneDepthAtMllw + (tideLevelFt * 0.3048);
}

function reefDepthAtTide(tideLevelFt) {
  return depthAtTide(tideLevelFt, BATHYMETRY.reef_depth_at_mllw_m);
}

function maxSafeMast(tideLevelFt) {
  const depth = reefDepthAtTide(tideLevelFt);
  return Math.max(0, depth - BATHYMETRY.safety_clearance_m);
}

// ── Mast Recommendation ──────────────────────────────────────────────
// Mast is chosen ONCE per session (~2 hours), not changed mid-session.
// Freeride foil default: 85cm. Drop to 72cm if tide is very low.
function recommendMast(tideLevelFt, ridingStyle = 'freeride_foil') {
  const reefDepth = reefDepthAtTide(tideLevelFt);
  const reefDepthCm = Math.round(reefDepth * 100);
  const safeMaxCm = Math.round(maxSafeMast(tideLevelFt) * 100);

  let recommended_cm, category, notes;

  if (ridingStyle === 'freeride_foil') {
    // Default 85cm, drop to 72cm only if reef too shallow for 85
    if (safeMaxCm < 72) {
      recommended_cm = null;
      category = 'too_shallow';
      notes = `Reef only ${reefDepthCm}cm deep — foiling on inside section risky. Consider deeper channel or wait for tide to rise.`;
    } else if (safeMaxCm < 85) {
      recommended_cm = 72;
      category = 'short_mast';
      notes = `Low tide — reef at ${reefDepthCm}cm. Use 72cm mast to protect equipment.`;
    } else {
      recommended_cm = 85;
      category = 'standard';
      notes = `Standard 85cm mast. Reef at ${reefDepthCm}cm — good clearance.`;
    }
  } else {
    // wave_foil — TBD
    recommended_cm = safeMaxCm >= 72 ? 72 : null;
    category = safeMaxCm >= 72 ? 'wave_foil' : 'too_shallow';
    notes = 'Wave foil mast selection TBD.';
  }

  return {
    tide_level_ft: tideLevelFt,
    reef_depth_cm: reefDepthCm,
    max_safe_mast_cm: safeMaxCm,
    recommended_mast_cm: recommended_cm,
    category,
    notes,
    depth_by_zone: BATHYMETRY.zones.map(z => ({
      zone: z.name,
      desc: z.desc,
      depth_cm: Math.round(depthAtTide(tideLevelFt, z.depth_at_mllw_m) * 100),
    })),
  };
}

// ── Session Mast Recommendation ──────────────────────────────────────
// Given a 2-hour session window, find the minimum tide and recommend
// a single mast for the entire session.
function recommendSessionMast(tideData, sessionStartHst, durationHours = 2, ridingStyle = 'freeride_foil') {
  if (!tideData?.predictions) return null;

  const todayHst = new Date().toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 10);
  const hstHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', hour12: false }));
  // After session hours or if today's predictions are gone, use next available date
  let targetDate = todayHst;
  const hasTodayPreds = tideData.predictions.some(p => p.time_local.startsWith(todayHst));
  if (hstHour >= 19 || !hasTodayPreds) {
    // Find earliest prediction date that is today or later
    const dates = [...new Set(tideData.predictions.map(p => p.time_local.substring(0, 10)))].sort();
    targetDate = dates.find(d => d >= todayHst) || dates[0];
  }

  const sessionEnd = sessionStartHst + durationHours;
  let minTide = Infinity;
  let maxTide = -Infinity;

  for (const pred of tideData.predictions) {
    if (!pred.time_local.startsWith(targetDate)) continue;
    const [, timeStr] = pred.time_local.split(' ');
    const [hh, mm] = timeStr.split(':').map(Number);
    const h = hh + mm / 60;
    if (h >= sessionStartHst && h <= sessionEnd) {
      if (pred.level_ft < minTide) minTide = pred.level_ft;
      if (pred.level_ft > maxTide) maxTide = pred.level_ft;
    }
  }

  if (minTide === Infinity) return null;

  const mast = recommendMast(minTide, ridingStyle);
  return {
    session_window: `${sessionStartHst}:00 - ${sessionEnd}:00 HST`,
    date: targetDate,
    min_tide_ft: Math.round(minTide * 100) / 100,
    max_tide_ft: Math.round(maxTide * 100) / 100,
    tide_range_ft: Math.round((maxTide - minTide) * 100) / 100,
    ...mast,
    session_note: `Single mast for session: ${mast.recommended_mast_cm}cm based on lowest tide ${minTide.toFixed(1)}ft during window.`,
  };
}

// ── Load equipment profiles ──────────────────────────────────────────
const PROFILES = JSON.parse(readFileSync(join(__dirname, '..', 'equipment-profiles.json'), 'utf-8'));

// ── Kite + Foil Recommendation ───────────────────────────────────────
function recommendKiteSetup(windAvgKts, ridingStyle = 'freeride_foil') {
  const style = PROFILES.riding_styles[ridingStyle];
  if (!style || !style.wind_matrix?.length) return null;

  // Find the matching wind bracket
  let match = null;
  for (const entry of style.wind_matrix) {
    const [lo, hi] = entry.wind_kts;
    if (windAvgKts >= lo && windAvgKts <= hi) {
      // Prefer narrower/higher match (later entries for stronger wind)
      match = entry;
    }
  }

  // Edge cases
  if (!match && windAvgKts < style.wind_matrix[0].wind_kts[0]) {
    return { recommendation: null, reason: `Wind ${windAvgKts}kts below minimum for ${ridingStyle} (need ${style.wind_matrix[0].wind_kts[0]}+kts)` };
  }
  if (!match && windAvgKts > style.wind_matrix[style.wind_matrix.length - 1].wind_kts[1]) {
    match = style.wind_matrix[style.wind_matrix.length - 1];
  }

  if (!match) return null;

  return {
    regime: match.regime,
    wind_range_kts: match.wind_kts,
    kite_m: match.kite_m,
    lines_m: Array.isArray(match.lines_m) ? match.lines_m : [match.lines_m],
    front_wing: match.front_wing,
    tail_wing: match.tail_wing,
    notes: match.notes,
  };
}

// ── Equipment profile (full) ─────────────────────────────────────────
function buildEquipmentProfile(tideLevelFt, windAvgKts, windGustKts) {
  const mast = recommendMast(tideLevelFt);
  const kiteSetup = windAvgKts > 0 ? recommendKiteSetup(windAvgKts) : null;

  return { mast, kite_setup: kiteSetup };
}

// ── Best Session Windows ─────────────────────────────────────────────
// Compute mast recommendations for common 2-hour session starts
function buildSessionWindows(tideData) {
  if (!tideData?.predictions) return null;

  // Kiting not legal before 11am. Earliest arrival ~11am, realistic session start noon.
  // Weekday cutoff: 4pm (work next day). Weekend cutoff: 5pm.
  // Session duration: ~2 hours.
  const dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', weekday: 'short' });
  const isWeekend = ['Sat', 'Sun'].includes(dayOfWeek);
  const latestEnd = isWeekend ? 17 : 16;
  const starts = [];
  for (let h = 12; h + 2 <= latestEnd; h++) starts.push(h); // only windows that end before cutoff
  const windows = starts.map(h => recommendSessionMast(tideData, h, 2)).filter(Boolean);
  return windows;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  // Get tide data
  let tides;
  try {
    const out = execSync(`node ${join(__dirname, 'tides-noaa.mjs')} 3`, { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    tides = JSON.parse(out.toString());
  } catch (e) {
    process.stderr.write('equipment-rec: failed to get tide data\n');
    process.exit(1);
  }

  // Current tide
  const currentTide = tides.latest_observed?.level_ft;

  // Wind (optional, from env)
  const windAvg = parseFloat(process.env.WIND_AVG_KTS || '0');
  const windGust = parseFloat(process.env.WIND_GUST_KTS || '0');

  // Current recommendation
  const currentRec = currentTide != null ? buildEquipmentProfile(currentTide, windAvg, windGust) : null;

  // Session windows (2-hour blocks)
  const sessionWindows = buildSessionWindows(tides);

  // Next 4 tide extremes with mast rec
  const tideExtremes = (tides.high_low || []).slice(0, 6).map(t => ({
    ...t,
    equipment: recommendMast(t.level_ft),
  }));

  const output = {
    source: 'equipment-rec',
    fetched_utc: new Date().toISOString(),
    location: 'Kanaha Beach Park — Old Mans Reef inside section',

    bathymetry: BATHYMETRY,

    current: currentTide != null ? {
      tide_ft: currentTide,
      tide_time: tides.latest_observed?.time_local,
      ...currentRec,
    } : null,

    session_windows: sessionWindows,

    tide_schedule: tideExtremes,

    summary: {
      current_tide_ft: currentTide,
      current_mast_cm: currentRec?.mast?.recommended_mast_cm,
      current_category: currentRec?.mast?.category,
      reef_depth_cm: currentRec?.mast?.reef_depth_cm,
      session_windows: sessionWindows,
      mast_notes: currentRec?.mast?.notes,
      kite_setup: currentRec?.kite_setup,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
