#!/usr/bin/env node
/**
 * synoptic-pressure.mjs — Large-area pressure system monitoring for Hawaii
 *
 * Monitors the North Pacific subtropical high (trade wind engine) and
 * approaching low pressure systems (kona lows, cold fronts) that can
 * weaken or kill trades days before storm arrival.
 *
 * Data sources:
 *   - Open-Meteo pressure forecasts at multiple waypoints around Hawaii
 *   - NDBC buoy pressure readings (real-time ground truth)
 *   - GFS/ECMWF pressure gradient analysis
 *
 * Key concept: Trade winds are driven by the pressure gradient between
 * the North Pacific subtropical high (NE of Hawaii) and the equatorial
 * trough (S of Hawaii). When a low approaches from the west/south, it:
 *   1. Compresses/displaces the subtropical high
 *   2. Reduces the NE-SW pressure gradient
 *   3. Trades weaken progressively over 2-4 days
 *   4. Wind direction rotates from NE → E → SE → S as low arrives
 *   5. Storm conditions (kona winds from SW) during passage
 *   6. Trades re-establish 1-3 days after passage
 *
 * Usage: node synoptic-pressure.mjs [forecast_days]  (default: 7)
 */
import https from 'https';

const FORECAST_DAYS = parseInt(process.argv[2] || '7');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'maui-wx/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── Waypoints for pressure gradient monitoring ───────────────────────
// The trade wind gradient runs roughly NE→SW. We monitor pressure at
// points along and perpendicular to this axis to detect approaching systems.
const WAYPOINTS = {
  // Kanaha (local reference)
  kanaha: { lat: 20.896, lon: -156.452, name: 'Kanaha (local)', role: 'local' },

  // NE of Hawaii — subtropical high territory
  // When pressure here drops, the high is weakening
  ne_high: { lat: 28.0, lon: -145.0, name: 'NE Pacific High Zone', role: 'high_pressure' },

  // North of Hawaii — cold front approach vector
  north: { lat: 28.0, lon: -157.0, name: 'North of Hawaii', role: 'north_approach' },

  // West of Hawaii — kona low approach vector (most common storm track)
  west: { lat: 21.0, lon: -165.0, name: 'West of Hawaii', role: 'west_approach' },

  // NW of Hawaii — common winter storm track
  nw: { lat: 26.0, lon: -165.0, name: 'NW of Hawaii', role: 'nw_approach' },

  // SW of Hawaii — equatorial trough / kona low origin
  sw: { lat: 16.0, lon: -163.0, name: 'SW of Hawaii', role: 'sw_trough' },

  // South of Hawaii — equatorial trough reference
  south: { lat: 15.0, lon: -157.0, name: 'South of Hawaii', role: 'equatorial_trough' },

  // SE of Hawaii — trade wind source region
  se_trades: { lat: 17.0, lon: -148.0, name: 'SE Trade Wind Source', role: 'trade_source' },
};

// ── NDBC buoys for real-time pressure validation ─────────────────────
const BUOYS = {
  '51000': { name: 'N Hawaii (51000)', lat: 23.534, lon: -153.752, role: 'north_ref' },
  '51001': { name: 'NW Hawaii (51001)', lat: 23.445, lon: -162.075, role: 'nw_ref' },
  '51002': { name: 'SW Hawaii (51002)', lat: 17.094, lon: -157.808, role: 'sw_ref' },
  '51003': { name: 'W Hawaii (51003)', lat: 19.228, lon: -160.569, role: 'west_ref' },
  '51004': { name: 'SE Hawaii (51004)', lat: 17.538, lon: -152.230, role: 'se_ref' },
};

// ── Analysis thresholds ──────────────────────────────────────────────
const THRESHOLDS = {
  // Trade wind gradient: pressure diff between NE high and local
  // Normal trades: NE high ~1025hPa, Kanaha ~1015hPa = 10hPa gradient
  trade_gradient_strong: 8,     // hPa — strong trades (20+ kts)
  trade_gradient_normal: 5,     // hPa — normal trades (15-20 kts)
  trade_gradient_weak: 3,       // hPa — light trades (10-15 kts)
  trade_gradient_dead: 1.5,     // hPa — trades dying/dead

  // Approaching system detection
  pressure_drop_24h_warning: -3,   // hPa — system approaching
  pressure_drop_24h_alert: -6,     // hPa — significant system approaching
  pressure_drop_48h_warning: -5,   // hPa — building system
  pressure_drop_48h_alert: -10,    // hPa — major system

  // Wind direction shift thresholds (from NE baseline of ~50°)
  dir_shift_warning: 30,          // degrees from NE — trades weakening
  dir_shift_alert: 60,            // degrees from NE — trades broken

  // Absolute pressure levels
  low_pressure_warning: 1010,     // hPa — tropical low territory
  low_pressure_alert: 1005,       // hPa — significant low
};

async function main() {
  process.stderr.write('synoptic-pressure: fetching multi-point pressure forecasts... ');

  // ── Fetch Open-Meteo pressure forecasts at all waypoints ───────────
  const waypointData = {};
  const fetches = Object.entries(WAYPOINTS).map(async ([key, wp]) => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${wp.lat}&longitude=${wp.lon}&hourly=pressure_msl,windspeed_10m,winddirection_10m&daily=pressure_msl_max,pressure_msl_min,windspeed_10m_max,winddirection_10m_dominant&forecast_days=${FORECAST_DAYS}&past_days=2&timezone=Pacific/Honolulu&windspeed_unit=kn`;
      const data = await fetchJSON(url);
      waypointData[key] = { ...wp, hourly: data.hourly, daily: data.daily };
    } catch (e) {
      waypointData[key] = { ...wp, error: e.message };
    }
  });
  await Promise.all(fetches);
  process.stderr.write('done\n');

  // ── Fetch NDBC buoy pressure readings (real-time) ──────────────────
  process.stderr.write('synoptic-pressure: fetching buoy pressures... ');
  const buoyPressure = {};
  for (const [id, info] of Object.entries(BUOYS)) {
    try {
      const text = await fetchText(`https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`);
      const lines = text.trim().split('\n');
      if (lines.length >= 3) {
        const cols = lines[2].trim().split(/\s+/);
        const pres = cols[12] !== 'MM' ? parseFloat(cols[12]) : null;
        const windDir = cols[5] !== 'MM' ? parseInt(cols[5]) : null;
        const windSpd = cols[6] !== 'MM' ? Math.round(parseFloat(cols[6]) * 1.94384 * 10) / 10 : null;
        // Get 24h-ago reading for trend
        let pres24h = null;
        for (let i = 3; i < lines.length; i++) {
          const c = lines[i].trim().split(/\s+/);
          const rowTime = new Date(`${c[0]}-${c[1]}-${c[2]}T${c[3]}:${c[4]}:00Z`);
          const age = (Date.now() - rowTime.getTime()) / 3600000;
          if (age >= 23 && age <= 25 && c[12] !== 'MM') {
            pres24h = parseFloat(c[12]);
            break;
          }
        }
        buoyPressure[id] = {
          ...info,
          pressure_hpa: pres,
          wind_dir_deg: windDir,
          wind_kts: windSpd,
          pressure_24h_ago: pres24h,
          pressure_change_24h: pres != null && pres24h != null ? Math.round((pres - pres24h) * 10) / 10 : null,
        };
      }
    } catch { /* buoy unavailable */ }
  }
  process.stderr.write('done\n');

  // ── Analyze trade wind gradient forecast ───────────────────────────
  process.stderr.write('synoptic-pressure: analyzing pressure patterns... ');

  const kanaha = waypointData.kanaha;
  const neHigh = waypointData.ne_high;

  // Build daily pressure gradient forecast (NE high minus Kanaha)
  const gradientForecast = [];
  if (kanaha?.daily && neHigh?.daily) {
    const kDates = kanaha.daily.time || [];
    const neDates = neHigh.daily.time || [];
    for (let i = 0; i < kDates.length; i++) {
      const date = kDates[i];
      const neIdx = neDates.indexOf(date);
      if (neIdx < 0) continue;

      // Use average of max and min for representative daily pressure
      const kPres = ((kanaha.daily.pressure_msl_max?.[i] || 0) + (kanaha.daily.pressure_msl_min?.[i] || 0)) / 2;
      const nePres = ((neHigh.daily.pressure_msl_max?.[neIdx] || 0) + (neHigh.daily.pressure_msl_min?.[neIdx] || 0)) / 2;
      const gradient = Math.round((nePres - kPres) * 10) / 10;

      // Dominant wind direction at Kanaha for this day
      const kWindDir = kanaha.daily.winddirection_10m_dominant?.[i];
      const kWindMax = kanaha.daily.windspeed_10m_max?.[i];

      let tradeStrength;
      if (gradient >= THRESHOLDS.trade_gradient_strong) tradeStrength = 'strong';
      else if (gradient >= THRESHOLDS.trade_gradient_normal) tradeStrength = 'normal';
      else if (gradient >= THRESHOLDS.trade_gradient_weak) tradeStrength = 'weak';
      else if (gradient >= THRESHOLDS.trade_gradient_dead) tradeStrength = 'dying';
      else tradeStrength = 'dead';

      // Direction shift from NE trades (baseline ~50°)
      const dirShift = kWindDir != null ? Math.abs(((kWindDir - 50) + 180) % 360 - 180) : null;
      let dirStatus = 'trades';
      if (dirShift != null) {
        if (dirShift > THRESHOLDS.dir_shift_alert) dirStatus = 'non_trade';
        else if (dirShift > THRESHOLDS.dir_shift_warning) dirStatus = 'shifting';
      }

      gradientForecast.push({
        date,
        kanaha_pressure_hpa: Math.round(kPres * 10) / 10,
        ne_high_pressure_hpa: Math.round(nePres * 10) / 10,
        gradient_hpa: gradient,
        trade_strength: tradeStrength,
        wind_dir_deg: kWindDir,
        wind_dir_status: dirStatus,
        wind_max_kts: kWindMax != null ? Math.round(kWindMax * 10) / 10 : null,
      });
    }
  }

  // ── Detect approaching pressure systems ────────────────────────────
  const approachingSystems = [];

  // Check each approach vector (west, NW, north, SW) for pressure drops
  const approachVectors = ['west', 'nw', 'north', 'sw'];
  for (const vecKey of approachVectors) {
    const wp = waypointData[vecKey];
    if (!wp?.hourly?.pressure_msl) continue;

    const times = wp.hourly.time || [];
    const pressures = wp.hourly.pressure_msl || [];
    const winds = wp.hourly.windspeed_10m || [];
    const windDirs = wp.hourly.winddirection_10m || [];

    // Find current index (closest to now)
    const nowStr = new Date().toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 13).replace(' ', 'T');
    let nowIdx = times.findIndex(t => t >= nowStr);
    if (nowIdx < 0) nowIdx = Math.max(0, times.length - 1);

    const currentPres = pressures[nowIdx];
    if (currentPres == null) continue;

    // Look ahead: find minimum pressure in next 7 days
    let minPres = currentPres;
    let minPresTime = times[nowIdx];
    let minPresIdx = nowIdx;
    for (let i = nowIdx; i < pressures.length; i++) {
      if (pressures[i] != null && pressures[i] < minPres) {
        minPres = pressures[i];
        minPresTime = times[i];
        minPresIdx = i;
      }
    }

    const pressDrop = minPres - currentPres;
    const hoursToMin = (minPresIdx - nowIdx);

    // Check if this qualifies as an approaching system
    if (pressDrop <= THRESHOLDS.pressure_drop_24h_warning || minPres <= THRESHOLDS.low_pressure_warning) {
      // Estimate arrival at Kanaha based on approach vector
      // Systems move ~20-40 km/h typically
      const distToKanaha = Math.sqrt(
        Math.pow((wp.lat - 20.896) * 111, 2) +
        Math.pow((wp.lon - (-156.452)) * 111 * Math.cos(20.896 * Math.PI / 180), 2)
      );

      // Wind at minimum pressure point (peak of system)
      const peakWind = winds[minPresIdx];
      const peakWindDir = windDirs[minPresIdx];

      // Build hourly pressure profile for this vector
      const pressureProfile = [];
      for (let i = nowIdx; i < Math.min(times.length, nowIdx + FORECAST_DAYS * 24); i += 6) {
        pressureProfile.push({
          time: times[i],
          pressure_hpa: pressures[i] != null ? Math.round(pressures[i] * 10) / 10 : null,
          wind_kts: winds[i] != null ? Math.round(winds[i] * 10) / 10 : null,
          wind_dir_deg: windDirs[i] != null ? Math.round(windDirs[i]) : null,
        });
      }

      let severity;
      if (pressDrop <= THRESHOLDS.pressure_drop_48h_alert || minPres <= THRESHOLDS.low_pressure_alert) {
        severity = 'major';
      } else if (pressDrop <= THRESHOLDS.pressure_drop_24h_alert) {
        severity = 'significant';
      } else {
        severity = 'minor';
      }

      approachingSystems.push({
        approach_vector: vecKey,
        approach_name: wp.name,
        current_pressure_hpa: Math.round(currentPres * 10) / 10,
        minimum_pressure_hpa: Math.round(minPres * 10) / 10,
        pressure_drop_hpa: Math.round(pressDrop * 10) / 10,
        hours_to_minimum: hoursToMin,
        estimated_arrival_hours: Math.round(hoursToMin * 0.7), // system moves faster than pressure minimum
        peak_wind_kts: peakWind != null ? Math.round(peakWind * 10) / 10 : null,
        peak_wind_dir_deg: peakWindDir != null ? Math.round(peakWindDir) : null,
        severity,
        distance_km: Math.round(distToKanaha),
        pressure_profile: pressureProfile,
      });
    }
  }

  // ── Trade wind impact assessment ───────────────────────────────────
  // How will approaching systems affect trades at Kanaha over coming days?
  const tradeImpact = [];
  if (kanaha?.hourly?.pressure_msl && neHigh?.hourly?.pressure_msl) {
    const kTimes = kanaha.hourly.time || [];
    const kPressures = kanaha.hourly.pressure_msl || [];
    const kWinds = kanaha.hourly.windspeed_10m || [];
    const kWindDirs = kanaha.hourly.winddirection_10m || [];
    const neTimes = neHigh.hourly.time || [];
    const nePressures = neHigh.hourly.pressure_msl || [];

    // Sample every 6 hours for the forecast period
    const nowStr = new Date().toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 13).replace(' ', 'T');
    let nowIdx = kTimes.findIndex(t => t >= nowStr);
    if (nowIdx < 0) nowIdx = 0;

    for (let i = nowIdx; i < kTimes.length; i += 6) {
      const kPres = kPressures[i];
      const neIdx = neTimes.indexOf(kTimes[i]);
      const nePres = neIdx >= 0 ? nePressures[neIdx] : null;

      if (kPres == null || nePres == null) continue;

      const gradient = Math.round((nePres - kPres) * 10) / 10;
      const windKts = kWinds[i] != null ? Math.round(kWinds[i] * 10) / 10 : null;
      const windDir = kWindDirs[i] != null ? Math.round(kWindDirs[i]) : null;

      let phase;
      if (gradient >= THRESHOLDS.trade_gradient_normal) phase = 'normal_trades';
      else if (gradient >= THRESHOLDS.trade_gradient_weak) phase = 'weakening_trades';
      else if (gradient >= THRESHOLDS.trade_gradient_dead) phase = 'dying_trades';
      else if (gradient >= 0) phase = 'calm_transition';
      else phase = 'reversed_flow'; // low is W/S of Hawaii, gradient reversed

      // Kite-relevant impact
      let kiteImpact;
      if (phase === 'normal_trades') kiteImpact = 'Normal session conditions expected';
      else if (phase === 'weakening_trades') kiteImpact = 'Lighter trades — may need larger kite or may be subliminal for kiting';
      else if (phase === 'dying_trades') kiteImpact = 'Marginal to no-go for kiting — possible light-wind foil session';
      else if (phase === 'calm_transition') kiteImpact = 'Calm/variable — no kiting, possible glass-off foil conditions';
      else kiteImpact = 'Storm/kona winds — conditions unsafe or offshore at north shore';

      tradeImpact.push({
        time: kTimes[i],
        kanaha_pressure_hpa: Math.round(kPres * 10) / 10,
        ne_high_pressure_hpa: Math.round(nePres * 10) / 10,
        gradient_hpa: gradient,
        phase,
        wind_kts: windKts,
        wind_dir_deg: windDir,
        kite_impact: kiteImpact,
      });
    }
  }

  // ── Storm lifecycle timeline (if approaching system detected) ──────
  let stormTimeline = null;
  if (approachingSystems.length > 0) {
    // Use the most significant approaching system
    const primary = approachingSystems.sort((a, b) => a.pressure_drop_hpa - b.pressure_drop_hpa)[0];

    // Build timeline: pre-storm → arrival → peak → post-storm → trade recovery
    const phases = [];

    // Find when gradient drops below trade thresholds
    let tradeWeakeningStart = null;
    let tradeDyingStart = null;
    let tradeDeadStart = null;
    let reversedFlowStart = null;
    let tradeRecoveryStart = null;
    let lastPhase = null;

    for (const pt of tradeImpact) {
      if (!tradeWeakeningStart && pt.phase === 'weakening_trades') tradeWeakeningStart = pt.time;
      if (!tradeDyingStart && pt.phase === 'dying_trades') tradeDyingStart = pt.time;
      if (!tradeDeadStart && (pt.phase === 'calm_transition' || pt.phase === 'reversed_flow')) tradeDeadStart = pt.time;
      if (!reversedFlowStart && pt.phase === 'reversed_flow') reversedFlowStart = pt.time;
      if (lastPhase === 'reversed_flow' && (pt.phase === 'calm_transition' || pt.phase === 'dying_trades') && !tradeRecoveryStart) {
        tradeRecoveryStart = pt.time;
      }
      lastPhase = pt.phase;
    }

    if (tradeWeakeningStart) phases.push({ phase: 'trades_weakening', start: tradeWeakeningStart, desc: 'Pressure gradient compressing — trades lighter than normal. Light-wind kite foiling may be excellent.' });
    if (tradeDyingStart) phases.push({ phase: 'trades_dying', start: tradeDyingStart, desc: 'Gradient near zero — trades gone. Variable light winds, calm conditions.' });
    if (tradeDeadStart) phases.push({ phase: 'calm_transition', start: tradeDeadStart, desc: 'Pre-storm calm. Possible glass-off conditions. Last chance for water time.' });
    if (reversedFlowStart) phases.push({ phase: 'storm_arrival', start: reversedFlowStart, desc: 'Gradient reversed — kona/southerly flow. Storm conditions. Stay off water.' });
    if (tradeRecoveryStart) phases.push({ phase: 'trade_recovery', start: tradeRecoveryStart, desc: 'Low passing east. Gradient rebuilding. Trades returning, initially gusty.' });

    stormTimeline = {
      primary_system: {
        approach: primary.approach_name,
        severity: primary.severity,
        pressure_drop: primary.pressure_drop_hpa,
        minimum_pressure: primary.minimum_pressure_hpa,
      },
      phases,
      kite_windows: {
        pre_storm_light_wind: tradeWeakeningStart && tradeDeadStart ? {
          start: tradeWeakeningStart,
          end: tradeDeadStart,
          desc: 'Light wind window — trades weakened by approaching low. Good for light-wind kite foiling (5.0m kite, HA1080 wing).',
        } : null,
        post_storm_recovery: tradeRecoveryStart ? {
          start: tradeRecoveryStart,
          desc: 'Trades re-establishing — initially gusty, improving over 24-48h.',
        } : null,
      },
    };
  }

  // ── Build buoy pressure summary ────────────────────────────────────
  const buoySummary = Object.entries(buoyPressure).map(([id, data]) => ({
    id,
    name: data.name,
    role: data.role,
    pressure_hpa: data.pressure_hpa,
    wind_kts: data.wind_kts,
    wind_dir_deg: data.wind_dir_deg,
    pressure_change_24h: data.pressure_change_24h,
    trend: data.pressure_change_24h != null
      ? (data.pressure_change_24h <= -3 ? 'falling_fast' :
         data.pressure_change_24h <= -1 ? 'falling' :
         data.pressure_change_24h >= 3 ? 'rising_fast' :
         data.pressure_change_24h >= 1 ? 'rising' : 'steady')
      : null,
  }));

  process.stderr.write('done\n');

  // ── Output ─────────────────────────────────────────────────────────
  const output = {
    source: 'synoptic-pressure',
    fetched_utc: new Date().toISOString(),
    forecast_days: FORECAST_DAYS,

    // Current state
    current: {
      buoy_pressures: buoySummary,
      trade_gradient: gradientForecast.length > 0 ? {
        current: gradientForecast[0],
        trend_7day: gradientForecast,
      } : null,
    },

    // Approaching systems
    approaching_systems: approachingSystems,
    system_count: approachingSystems.length,
    max_severity: approachingSystems.length > 0
      ? approachingSystems.reduce((max, s) => {
          const order = { major: 3, significant: 2, minor: 1 };
          return (order[s.severity] || 0) > (order[max] || 0) ? s.severity : max;
        }, 'minor')
      : 'none',

    // Trade wind impact timeline
    trade_impact_timeline: tradeImpact,

    // Storm lifecycle (if applicable)
    storm_timeline: stormTimeline,

    // Summary for forecast integration
    summary: {
      trade_gradient_today: gradientForecast[0]?.trade_strength || 'unknown',
      trade_gradient_trend: (() => {
        if (gradientForecast.length < 3) return 'insufficient_data';
        const first = gradientForecast[0]?.gradient_hpa || 0;
        const last = gradientForecast[Math.min(2, gradientForecast.length - 1)]?.gradient_hpa || 0;
        const change = last - first;
        if (change <= -3) return 'collapsing';
        if (change <= -1) return 'weakening';
        if (change >= 3) return 'strengthening';
        if (change >= 1) return 'building';
        return 'stable';
      })(),
      approaching_storm: approachingSystems.length > 0,
      storm_severity: approachingSystems.length > 0
        ? approachingSystems.sort((a, b) => a.pressure_drop_hpa - b.pressure_drop_hpa)[0].severity
        : null,
      pre_storm_light_wind_window: stormTimeline?.kite_windows?.pre_storm_light_wind || null,
      days_until_storm: approachingSystems.length > 0
        ? Math.round(Math.min(...approachingSystems.map(s => s.hours_to_minimum)) / 24 * 10) / 10
        : null,
      buoy_pressure_consensus: (() => {
        const trends = buoySummary.map(b => b.pressure_change_24h).filter(v => v != null);
        if (trends.length === 0) return 'no_data';
        const avg = trends.reduce((a, b) => a + b, 0) / trends.length;
        if (avg <= -3) return 'all_falling_fast';
        if (avg <= -1) return 'mostly_falling';
        if (avg >= 1) return 'mostly_rising';
        return 'mixed_stable';
      })(),
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
