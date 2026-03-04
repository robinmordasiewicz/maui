#!/usr/bin/env node
/**
 * three-day-outlook.mjs — 3-day session window summary for Kanaha
 *
 * For each of the next 3 session days, summarizes:
 *   - Wind estimate (from Open-Meteo daily max + iK-TRRM if available)
 *   - Rain risk (PoP, QPF, weathercodes during session window)
 *   - Go/no-go verdict
 *   - Storm triage flag
 *
 * Reads from already-fetched Open-Meteo (pressure-meteo) and NWS
 * data passed via stdin as JSON, or runs standalone with --standalone.
 *
 * Usage (standalone): node three-day-outlook.mjs
 * Usage (piped):      echo '<json>' | node three-day-outlook.mjs
 */
import https from 'https';
import { readFileSync } from 'fs';

const LAT = 20.896;
const LON = -156.452;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'maui-wx/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Session window hours by day-of-week
const SESSION_WINDOWS = {
  Monday:    { start: 12, end: 16 },
  Tuesday:   { start: 12, end: 16 },
  Wednesday: { start: 12, end: 16 },
  Thursday:  { start: 12, end: 16 },
  Friday:    { start: 12, end: 17 },
  Saturday:  { start: 11, end: 17 },
  Sunday:    { start: 11, end: 16 },
};

function hstDatePlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 10);
}

function hstDayName(dateStr) {
  const d = new Date(dateStr + 'T12:00:00-10:00');
  return d.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', weekday: 'long' });
}

// WMO weathercode → severity
function weathercodeSeverity(code) {
  if ([95, 96, 99].includes(code)) return 'storm';
  if ([63, 65, 73, 75, 82].includes(code)) return 'heavy_rain';
  if ([61, 80, 81].includes(code)) return 'rain';
  if ([51, 53, 55].includes(code)) return 'drizzle';
  return 'none';
}

function assessRainRisk(popPct, qpfMm, showersMm, maxCode) {
  const codeSev = weathercodeSeverity(maxCode);

  // STORM: cancel session, enter triage
  if (codeSev === 'storm' || (popPct >= 80 && qpfMm >= 20)) {
    return { level: 'storm', cancel: true, reason: 'Thunderstorm/severe rain event' };
  }
  // HEAVY: cancel session
  if (codeSev === 'heavy_rain' || (popPct >= 70 && qpfMm >= 15)) {
    return { level: 'heavy', cancel: true, reason: `Heavy rain — ${Math.round(qpfMm)}mm expected, ${popPct}% PoP` };
  }
  // MODERATE: flag, conditions degraded
  if (popPct >= 40 || qpfMm >= 5 || codeSev === 'rain') {
    return { level: 'moderate', cancel: false, reason: `Shower risk — ${Math.round(qpfMm)}mm, ${popPct}% PoP` };
  }
  // SCATTERED: report only
  if (popPct >= 20 || qpfMm > 0.5 || showersMm > 0) {
    return { level: 'scattered', cancel: false, reason: `Scattered showers possible (${popPct}% PoP)` };
  }
  return { level: 'none', cancel: false, reason: null };
}

function windVerdictLabel(windKts, rainCancel) {
  if (rainCancel) return 'RAIN-CANCEL';
  if (windKts >= 18) return 'EPIC';
  if (windKts >= 15) return 'GOOD';
  if (windKts >= 12) return 'MARGINAL';
  if (windKts >= 8)  return 'LIGHT';
  return 'NO-GO';
}

async function main() {
  process.stderr.write('three-day-outlook: building 3-day forecast... ');

  // Always fetch fresh Open-Meteo (3 days)
  const params = [
    'precipitation_probability', 'precipitation', 'showers', 'rain',
    'weathercode', 'windspeed_10m', 'cloudcover',
  ].join(',');
  const daily = [
    'precipitation_sum', 'precipitation_probability_max',
    'windspeed_10m_max', 'winddirection_10m_dominant',
    'weathercode',
  ].join(',');

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=${params}&daily=${daily}&forecast_days=4&timezone=Pacific/Honolulu&windspeed_unit=kn`;
  const data = await fetchJSON(url);
  const h = data.hourly || {};
  const d = data.daily || {};

  // Also fetch NWS daily narratives
  let nwsDailyMap = {};
  try {
    const nws = await fetchJSON('https://api.weather.gov/gridpoints/HFO/213,126/forecast');
    for (const p of (nws.properties?.periods || [])) {
      const dt = new Date(p.startTime).toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 10);
      if (!nwsDailyMap[dt]) nwsDailyMap[dt] = [];
      nwsDailyMap[dt].push(p.detailedForecast);
    }
  } catch { /* optional */ }

  process.stderr.write('done\n');

  const days = [];

  // Build hourly lookup
  const hourlyLookup = {};
  for (let i = 0; i < (h.time || []).length; i++) {
    const t = h.time[i]; // "YYYY-MM-DDTHH:00"
    hourlyLookup[t] = {
      pop:      h.precipitation_probability?.[i] ?? 0,
      precip:   h.precipitation?.[i] ?? 0,
      showers:  h.showers?.[i] ?? 0,
      rain:     h.rain?.[i] ?? 0,
      code:     h.weathercode?.[i] ?? 0,
      wind:     h.windspeed_10m?.[i] ?? 0,
      cloud:    h.cloudcover?.[i] ?? 0,
    };
  }

  // Process 3 session days starting today
  for (let offset = 0; offset < 3; offset++) {
    const date = hstDatePlusDays(offset);
    const dayName = hstDayName(date);
    const win = SESSION_WINDOWS[dayName] || { start: 12, end: 16 };

    // Extract session window hours
    const sessionHours = [];
    for (let hr = win.start; hr < win.end; hr++) {
      const key = `${date}T${String(hr).padStart(2, '0')}:00`;
      if (hourlyLookup[key]) sessionHours.push({ hour: hr, ...hourlyLookup[key] });
    }

    if (sessionHours.length === 0) continue;

    // Session window aggregates
    const maxPop   = Math.max(...sessionHours.map(h => h.pop));
    const totalQpf = sessionHours.reduce((s, h) => s + h.precip, 0);
    const totalShowers = sessionHours.reduce((s, h) => s + h.showers, 0);
    const maxCode  = Math.max(...sessionHours.map(h => h.code));
    const avgWind  = sessionHours.reduce((s, h) => s + h.wind, 0) / sessionHours.length;
    const peakWind = Math.max(...sessionHours.map(h => h.wind));
    const avgCloud = sessionHours.reduce((s, h) => s + h.cloud, 0) / sessionHours.length;

    const rain = assessRainRisk(maxPop, totalQpf, totalShowers, maxCode);
    const verdict = windVerdictLabel(peakWind, rain.cancel);

    // NWS narrative for this date
    const nwsNarratives = nwsDailyMap[date] || [];

    days.push({
      date,
      day: dayName,
      session_window: `${win.start}:00-${win.end}:00 HST`,
      verdict,
      wind: {
        avg_kts: Math.round(avgWind * 10) / 10,
        peak_kts: Math.round(peakWind * 10) / 10,
      },
      rain: {
        level: rain.level,
        cancel: rain.cancel,
        reason: rain.reason,
        max_pop_pct: maxPop,
        total_qpf_mm: Math.round(totalQpf * 10) / 10,
        total_showers_mm: Math.round(totalShowers * 10) / 10,
      },
      cloud_avg_pct: Math.round(avgCloud),
      nws_summary: nwsNarratives[0] || null,
      hourly_session: sessionHours.map(h => ({
        hour: h.hour,
        pop_pct: h.pop,
        precip_mm: h.precip,
        showers_mm: h.showers,
        wind_kts: Math.round(h.wind * 10) / 10,
        cloud_pct: h.cloud,
        weathercode: h.code,
      })),
    });
  }

  // Triage assessment — are we in a multi-day rain event?
  const cancelDays = days.filter(d => d.rain.cancel);
  const nextClearDay = days.find(d => !d.rain.cancel && d.verdict !== 'NO-GO' && d.verdict !== 'LIGHT');
  const stormDurationDays = cancelDays.length;

  // Total rainfall across all cancel days
  const stormTotalMm = cancelDays.reduce((s, d) => s + d.rain.total_qpf_mm, 0);

  const output = {
    source: 'three-day-outlook',
    fetched_utc: new Date().toISOString(),
    triage: {
      active: cancelDays.length > 0,
      storm_days: stormDurationDays,
      cancel_dates: cancelDays.map(d => d.date),
      total_qpf_mm: Math.round(stormTotalMm * 10) / 10,
      next_clear_session: nextClearDay ? `${nextClearDay.date} (${nextClearDay.day})` : 'beyond 3-day window',
      next_clear_verdict: nextClearDay?.verdict ?? null,
    },
    days,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
