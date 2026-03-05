#!/usr/bin/env node
/**
 * analyze-debriefs.mjs — Analyze session debrief database
 *
 * Reads all debriefs/*.json and produces:
 *   - Forecast accuracy statistics
 *   - Condition → quality correlations
 *   - Detection algorithm validation
 *   - Threshold calibration suggestions
 *
 * Usage: node scripts/analyze-debriefs.mjs
 */

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEBRIEF_DIR = join(__dirname, '..', 'debriefs');

function load() {
  return readdirSync(DEBRIEF_DIR)
    .filter(f => f.endsWith('.json') && f !== 'DEBRIEF_FORMAT.json')
    .map(f => {
      try { return JSON.parse(readFileSync(join(DEBRIEF_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function main() {
  const debriefs = load();
  console.log(`\n═══ SESSION DEBRIEF ANALYSIS ═══`);
  console.log(`${debriefs.length} sessions logged\n`);

  if (debriefs.length === 0) {
    console.log('No debriefs found. Log sessions to debriefs/YYYY-MM-DD.json');
    return;
  }

  // Accuracy distribution
  const accuracy = {};
  for (const d of debriefs) {
    const a = d.verdict?.forecast_accuracy || 'unknown';
    accuracy[a] = (accuracy[a] || 0) + 1;
  }
  console.log('─── Forecast Accuracy ───');
  for (const [k, v] of Object.entries(accuracy)) {
    const pct = Math.round(v / debriefs.length * 100);
    const bar = '█'.repeat(Math.round(pct / 5));
    console.log(`  ${k.padEnd(20)} ${String(v).padStart(3)}  ${bar} ${pct}%`);
  }

  // Session quality distribution
  const qualities = debriefs.map(d => d.verdict?.session_quality).filter(Boolean);
  const avgQuality = qualities.length ? (qualities.reduce((a,b) => a+b, 0) / qualities.length).toFixed(1) : 'n/a';
  console.log(`\n─── Session Quality ───`);
  console.log(`  Average: ${avgQuality}/6`);
  for (let q = 1; q <= 6; q++) {
    const count = qualities.filter(v => v === q).length;
    const labels = ['','Unrideable','Poor','Marginal','Fair','Good','Excellent'];
    if (count > 0) console.log(`  ${q} ${labels[q].padEnd(12)} ${'█'.repeat(count)} (${count})`);
  }

  // Wind shadow detection validation
  const shadowSessions = debriefs.filter(d => d.actual?.wind_shadow_present === true);
  if (shadowSessions.length > 0) {
    console.log(`\n─── Wind Shadow Events (${shadowSessions.length}) ───`);
    for (const d of shadowSessions) {
      const fired = d.detection_outcome?.wind_shadow_algorithm_would_have_fired;
      const diverg = d.sensor_actuals?.dir_divergence_deg;
      const kDir = d.sensor_actuals?.kanaha_dir_deg;
      const ratio = d.sensor_actuals?.kanaha_gust / d.sensor_actuals?.kanaha_avg;
      console.log(`  ${d.date}: dir=${kDir}° divergence=${diverg}° ratio=${ratio?.toFixed(2)}x quality=${d.verdict?.session_quality} detected=${fired ? '✅' : '❌'}`);
    }
  }

  // Direction patterns
  console.log(`\n─── Direction vs Quality ───`);
  const byDir = {};
  for (const d of debriefs) {
    const dir = d.actual?.dir_deg;
    const q = d.verdict?.session_quality;
    if (dir != null && q != null) {
      const bucket = dir < 45 ? 'N-NE (<45°)' : dir < 70 ? 'NE-ENE (45-70°)' : dir < 85 ? 'ENE (70-85°)' : dir < 100 ? 'E (85-100°)' : 'E-SE (100°+)';
      if (!byDir[bucket]) byDir[bucket] = [];
      byDir[bucket].push(q);
    }
  }
  for (const [bucket, qs] of Object.entries(byDir)) {
    const avg = (qs.reduce((a,b) => a+b, 0) / qs.length).toFixed(1);
    console.log(`  ${bucket.padEnd(20)} avg quality: ${avg}/6 (n=${qs.length})`);
  }

  // Threshold calibration suggestions
  console.log(`\n─── Calibration Notes ───`);
  const missed = debriefs.filter(d => d.verdict?.forecast_accuracy === 'missed_hazard');
  if (missed.length > 0) {
    console.log(`  ${missed.length} missed hazards — review for threshold adjustment:`);
    for (const d of missed) {
      const anomalies = d.observations?.anomalies || [];
      console.log(`    ${d.date}: ${anomalies[0] || 'no notes'}`);
    }
  }

  const overForecast = debriefs.filter(d => d.verdict?.forecast_accuracy === 'over_forecast');
  if (overForecast.length > 0) {
    console.log(`  ${overForecast.length} over-forecasts — conditions worse than predicted`);
  }

  console.log(`\n  Run after 10+ sessions for statistically meaningful calibration.`);
  console.log(`  Target: >80% accuracy, <10% missed hazards.\n`);
}

main();
