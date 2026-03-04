#!/usr/bin/env node
/**
 * north-pacific-swell.mjs — North Pacific storm & swell early warning system
 *
 * Monitors storm generation zones across the North Pacific from the Gulf of
 * Alaska to the Western Pacific and computes swell propagation timing to the
 * Maui north shore (Pauwela). Provides 3-10 day early warning of incoming
 * groundswell events.
 *
 * Data sources:
 *   - Open-Meteo Marine API at 5 North Pacific waypoints (storm indicators)
 *   - NDBC buoy real-time observations (46001, 46035, 46066 + existing 51001, 51000)
 *   - NWS HFO Surf Forecast discussion (qualitative outlook + Maui heights)
 *   - Open-Meteo Marine at Pauwela (direct 7-day swell forecast)
 *
 * Physics: Group velocity Cg = g*T/(4π) m/s; swell period T is the dominant
 * period of the storm. Longer period = faster group velocity = earlier arrival.
 * Height attenuation: ~1/sqrt(distance ratio) from source to destination.
 *
 * Usage: node north-pacific-swell.mjs
 */
import https from 'https';

// ── Pauwela (Maui north shore reference) ────────────────────────────
const PAUWELA = { lat: 21.018, lon: -156.421, name: 'Pauwela, Maui' };
const KANAHA  = { lat: 20.896, lon: -156.452, name: 'Kanaha, Maui' };

// ── North Pacific storm generation zones ────────────────────────────
// Ordered by typical storm track relevance to Hawaii north shore
const NP_WAYPOINTS = [
  { id: 'gulf_alaska',    name: 'Gulf of Alaska',        lat: 56,  lon: -148, note: 'Primary winter storm source; 4-5 day travel' },
  { id: 'central_np',     name: 'Central North Pacific',  lat: 40,  lon: -155, note: 'Mid-Pacific swell generator; 3-4 day travel' },
  { id: 'nw_pacific',     name: 'NW Pacific / Kamchatka', lat: 47,  lon: -175, note: 'Western storm track; 6-7 day travel' },
  { id: 'ne_pacific',     name: 'NE Pacific / Aleutians', lat: 50,  lon: -160, note: 'Aleutian low source; 5-6 day travel' },
  { id: 'dateline_np',    name: 'International Dateline', lat: 45,  lon: 175,  note: 'Long-fetch Western Pacific swell; 7-9 day travel' },
];

// ── NDBC buoys in the North Pacific storm corridor ───────────────────
const NP_BUOYS = {
  '46001': { name: 'Gulf of Alaska',   lat: 56.30,  lon: -148.02, dist_nm: 2100 },
  '46035': { name: 'Central Bering Sea', lat: 57.03, lon: -177.47, dist_nm: 2800 },
  '46066': { name: 'South Kodiak',     lat: 52.78,  lon: -155.02, dist_nm: 2400 },
  '51001': { name: 'NW Hawaii',        lat: 23.43,  lon: -162.28, dist_nm: 500  },
  '51000': { name: 'N Hawaii',         lat: 23.54,  lon: -153.77, dist_nm: 400  },
};

// ── Swell alert levels (at Pauwela) ─────────────────────────────────
const SWELL_LEVELS = [
  { level: 'XXL',      min_m: 3.0, min_period: 16, label: 'XXL — rare major event',       wave_event: true,  cancel_plans: true  },
  { level: 'pumping',  min_m: 2.0, min_period: 14, label: 'Pumping — overhead+ surf',      wave_event: true,  cancel_plans: true  },
  { level: 'fun',      min_m: 1.0, min_period: 12, label: 'Fun — chest to head high',      wave_event: false, cancel_plans: false },
  { level: 'small',    min_m: 0.5, min_period: 10, label: 'Small — ankle to waist high',   wave_event: false, cancel_plans: false },
  { level: 'flat',     min_m: 0,   min_period: 0,  label: 'Flat',                          wave_event: false, cancel_plans: false },
];

// ── North-facing swell direction window ─────────────────────────────
// Maui north shore responds to swell from NW to NE (270°-90° via north)
// Best direction: NNW-N (315-360°) → direct Kanaha approach
// Acceptable: NW (270-315°) and NNE (0-45°)
function isNorthFacingSwell(dirDeg) {
  if (dirDeg == null) return false;
  // Swell direction is "coming FROM" — north shore needs swell FROM the north
  // NDBC/model direction = direction swell is coming from
  return (dirDeg >= 270 || dirDeg <= 90); // W through N through E (NW to NE arc)
}

function swellDirectionLabel(dirDeg) {
  if (dirDeg == null) return '?';
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(dirDeg / 22.5) % 16];
}

// ── Swell propagation physics ────────────────────────────────────────
// Group velocity: Cg = g*T/(4π) m/s
// Convert to knots: × 1.944
// Distance in nm → travel time in hours
function groupVelocityKts(periodSeconds) {
  const Cg_ms = (9.81 * periodSeconds) / (4 * Math.PI);
  return Cg_ms * 1.944; // m/s → kts
}

function travelTimeHours(distNm, periodSeconds) {
  const Cg = groupVelocityKts(periodSeconds);
  return distNm / Cg;
}

// Great-circle distance in nautical miles
function distNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius in nm
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Height attenuation (1/sqrt(distance) decay)
function attenuatedHeight(sourceHm, distSourceNm, distDestNm) {
  if (distSourceNm <= 0) return sourceHm;
  return sourceHm * Math.sqrt(distSourceNm / distDestNm);
}

// Classify swell level
function classifySwellLevel(heightM, periodS, dirDeg) {
  const northFacing = isNorthFacingSwell(dirDeg);
  if (!northFacing) return SWELL_LEVELS[SWELL_LEVELS.length - 1]; // flat if wrong direction
  for (const lvl of SWELL_LEVELS) {
    if (heightM >= lvl.min_m && periodS >= lvl.min_period) return lvl;
  }
  return SWELL_LEVELS[SWELL_LEVELS.length - 1];
}

// ── HTTP helpers ─────────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'maui-wx/1.0' } };
    https.get(url, opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'maui-wx/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── Parse NDBC standard met text ────────────────────────────────────
function parseNDBCLatest(text) {
  const lines = text.trim().split('\n').filter(l => !l.startsWith('##') && l.trim());
  const headers = lines[0].replace(/^#/, '').trim().split(/\s+/);
  const specLine = lines.find((l, i) => i >= 2 && !l.startsWith('#'));
  if (!specLine) return null;
  const cols = specLine.trim().split(/\s+/);
  const get = (name) => {
    const idx = headers.indexOf(name);
    const v = idx >= 0 ? cols[idx] : null;
    return v === 'MM' || v == null ? null : parseFloat(v);
  };
  return {
    wave_height_m: get('WVHT'),
    dominant_period_s: get('DPD'),
    avg_period_s: get('APD'),
    mean_wave_dir_deg: get('MWD'),
    wind_speed_ms: get('WSPD'),
    wind_gust_ms: get('GST'),
    wind_dir_deg: get('WDIR'),
    pressure_hpa: get('PRES'),
    time_utc: (() => {
      const [yr,mo,dy,hr,mn] = cols;
      return new Date(Date.UTC(+yr,+mo-1,+dy,+hr,+mn||0)).toISOString();
    })(),
  };
}

// Parse NDBC spectral summary (.spec)
function parseNDBCSpec(text) {
  const lines = text.trim().split('\n').filter(l => !l.startsWith('##') && l.trim());
  const headers = lines[0].replace(/^#/, '').trim().split(/\s+/);
  const latest = lines.find((l, i) => i >= 2 && !l.startsWith('#'));
  if (!latest) return null;
  const cols = latest.trim().split(/\s+/);
  const get = (name) => {
    const idx = headers.indexOf(name);
    const v = idx >= 0 ? cols[idx] : null;
    return v === 'MM' || v == null ? null : parseFloat(v);
  };
  return {
    total_height_m: get('WVHT'),
    swell_height_m: get('SwH'),
    swell_period_s: get('SwP'),
    swell_dir_deg: (() => { // SwD is a text direction
      const idx = headers.indexOf('SwD');
      const v = idx >= 0 ? cols[idx] : null;
      if (!v || v === 'MM') return null;
      const dirMap = { N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135, SSE:157.5,
        S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5 };
      return dirMap[v] ?? null;
    })(),
    wind_wave_height_m: get('WWH'),
    wind_wave_period_s: get('WWP'),
  };
}

// ── Fetch NWS HFO Surf Forecast ──────────────────────────────────────
async function fetchSurfForecast() {
  try {
    const list = await fetchJSON('https://api.weather.gov/products?type=SRF&location=HFO&limit=1');
    const id = list['@graph']?.[0]?.['@id'];
    if (!id) return null;
    const product = await fetchJSON(id);
    const text = product.productText || '';

    // Extract discussion
    const discIdx = text.indexOf('.DISCUSSION');
    const discEnd = text.indexOf('\n\n', discIdx + 1);
    const discussion = discIdx >= 0 ? text.substring(discIdx, discEnd > 0 ? discEnd : discIdx + 800).trim() : null;

    // Extract Maui north-facing surf heights (today/tomorrow)
    const mauiIdx = text.indexOf('Maui-');
    let mauiNorthToday = null, mauiNorthTomorrow = null;
    if (mauiIdx >= 0) {
      const mauiBlock = text.substring(mauiIdx, mauiIdx + 1200);
      // North Facing line: "North Facing         3-5    3-5                 1-3    1-3"
      const northMatch = mauiBlock.match(/North Facing\s+(\d+)-(\d+)\s+(\d+)-(\d+)\s+(\d+)-(\d+)\s+(\d+)-(\d+)/);
      if (northMatch) {
        mauiNorthToday = {
          am_ft: [parseInt(northMatch[1]), parseInt(northMatch[2])],
          pm_ft: [parseInt(northMatch[3]), parseInt(northMatch[4])],
        };
        mauiNorthTomorrow = {
          am_ft: [parseInt(northMatch[5]), parseInt(northMatch[6])],
          pm_ft: [parseInt(northMatch[7]), parseInt(northMatch[8])],
        };
      }
    }

    return { discussion, maui_north_today: mauiNorthToday, maui_north_tomorrow: mauiNorthTomorrow };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Fetch Open-Meteo marine at a waypoint ───────────────────────────
async function fetchWaypointSwell(wp) {
  const params = [
    'wave_height', 'wave_period', 'wave_direction',
    'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
  ].join(',');
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${wp.lat}&longitude=${wp.lon}&hourly=${params}&forecast_days=7&timezone=UTC&windspeed_unit=kn`;
  const data = await fetchJSON(url);
  const h = data.hourly || {};

  // Find peak conditions in next 7 days
  let peakWave = 0, peakPeriod = 0, peakDir = null, peakTime = null;
  for (let i = 0; i < (h.time || []).length; i++) {
    const wh = h.wave_height?.[i] || 0;
    if (wh > peakWave) {
      peakWave = wh;
      peakPeriod = h.wave_period?.[i] || 0;
      peakDir = h.wave_direction?.[i];
      peakTime = h.time?.[i];
    }
  }

  // Current conditions (first valid observation)
  const current = {
    wave_height_m: h.wave_height?.[0],
    wave_period_s: h.wave_period?.[0],
    wave_dir_deg: h.wave_direction?.[0],
    swell_height_m: h.swell_wave_height?.[0],
    swell_period_s: h.swell_wave_period?.[0],
    swell_dir_deg: h.swell_wave_direction?.[0],
  };

  // Identify storm windows — consecutive hours with wave_height > threshold
  const STORM_THRESHOLD_M = 3.0;
  const stormWindows = [];
  let inStorm = false, stormStart = null, stormPeak = 0, stormPeriod = 0, stormDir = null;
  for (let i = 0; i < (h.time || []).length; i++) {
    const wh = h.wave_height?.[i] || 0;
    const wp2 = h.wave_period?.[i] || 0;
    if (wh >= STORM_THRESHOLD_M) {
      if (!inStorm) { inStorm = true; stormStart = h.time[i]; stormPeak = 0; }
      if (wh > stormPeak) { stormPeak = wh; stormPeriod = wp2; stormDir = h.wave_direction?.[i]; }
    } else if (inStorm) {
      stormWindows.push({ start: stormStart, end: h.time[i-1], peak_m: stormPeak, period_s: stormPeriod, dir_deg: stormDir });
      inStorm = false;
    }
  }
  if (inStorm) stormWindows.push({ start: stormStart, end: h.time[h.time.length-1], peak_m: stormPeak, period_s: stormPeriod, dir_deg: stormDir });

  return {
    waypoint: wp,
    current,
    peak_7day: { height_m: peakWave, period_s: peakPeriod, dir_deg: peakDir, time_utc: peakTime },
    storm_windows: stormWindows,
  };
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  process.stderr.write('north-pacific-swell: fetching storm & swell data...\n');

  // ── 1. Direct swell forecast at Pauwela (7 days) ──────────────────
  process.stderr.write('  pauwela swell forecast... ');
  const pauwelaSwell = await (async () => {
    const params = [
      'swell_wave_height', 'swell_wave_period', 'swell_wave_direction',
      'wave_height', 'wave_period', 'wave_direction',
    ].join(',');
    const daily = [
      'swell_wave_height_max', 'swell_wave_period_max', 'swell_wave_direction_dominant',
      'wave_height_max',
    ].join(',');
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${PAUWELA.lat}&longitude=${PAUWELA.lon}&hourly=${params}&daily=${daily}&forecast_days=7&timezone=Pacific/Honolulu`;
    const d = await fetchJSON(url);
    const h = d.hourly || {};
    const dd = d.daily || {};
    return {
      hourly: (h.time || []).map((t, i) => ({
        time_hst: t,
        swell_height_m: h.swell_wave_height?.[i],
        swell_period_s: h.swell_wave_period?.[i],
        swell_dir_deg: h.swell_wave_direction?.[i],
        wave_height_m: h.wave_height?.[i],
      })),
      daily: (dd.time || []).map((t, i) => ({
        date: t,
        swell_max_m: dd.swell_wave_height_max?.[i],
        swell_period_max_s: dd.swell_wave_period_max?.[i],
        swell_dir_dominant_deg: dd.swell_wave_direction_dominant?.[i],
        wave_max_m: dd.wave_height_max?.[i],
      })),
    };
  })().catch(e => ({ error: e.message }));
  process.stderr.write('done\n');

  // ── 2. NDBC buoy observations ─────────────────────────────────────
  process.stderr.write('  NDBC buoys... ');
  const buoyData = {};
  for (const [id, info] of Object.entries(NP_BUOYS)) {
    try {
      const [metText, specText] = await Promise.all([
        fetchText(`https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`),
        fetchText(`https://www.ndbc.noaa.gov/data/realtime2/${id}.spec`).catch(() => null),
      ]);
      const met = parseNDBCLatest(metText);
      const spec = specText ? parseNDBCSpec(specText) : null;
      buoyData[id] = { ...info, met, spec };
    } catch (e) {
      buoyData[id] = { ...info, error: e.message };
    }
  }
  process.stderr.write('done\n');

  // ── 3. North Pacific waypoint monitoring ──────────────────────────
  process.stderr.write('  North Pacific waypoints... ');
  const waypointResults = await Promise.allSettled(
    NP_WAYPOINTS.map(wp => fetchWaypointSwell(wp))
  );
  const waypoints = waypointResults.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { waypoint: NP_WAYPOINTS[i], error: r.reason?.message }
  );
  process.stderr.write('done\n');

  // ── 4. NWS HFO Surf Forecast ──────────────────────────────────────
  process.stderr.write('  NWS surf forecast... ');
  const surfForecast = await fetchSurfForecast();
  process.stderr.write('done\n');

  // ── 5. Swell propagation: compute arrival windows from storms ─────
  const swellArrivals = [];

  // From NDBC buoys — if they show significant swell, project forward
  for (const [id, buoy] of Object.entries(buoyData)) {
    if (buoy.error) continue;
    const ht = buoy.spec?.swell_height_m || buoy.met?.wave_height_m || 0;
    const period = buoy.spec?.swell_period_s || buoy.met?.dominant_period_s || 0;
    const dir = buoy.spec?.swell_dir_deg || buoy.met?.mean_wave_dir_deg;

    if (ht >= 1.5 && period >= 10 && isNorthFacingSwell(dir)) {
      const dist = distNm(buoy.lat, buoy.lon, PAUWELA.lat, PAUWELA.lon);
      const travelHrs = travelTimeHours(dist, period);
      const arrivalDate = new Date(Date.now() + travelHrs * 3600000);
      // Rough height estimate at Pauwela — empirical attenuation
      const estHeightM = Math.min(ht * 0.35, attenuatedHeight(ht, buoy.dist_nm || dist, dist));
      const level = classifySwellLevel(estHeightM, period, dir);

      swellArrivals.push({
        source: `NDBC ${id} (${buoy.name})`,
        observed_height_m: ht,
        observed_period_s: period,
        observed_dir_deg: dir,
        dist_nm: Math.round(dist),
        travel_hours: Math.round(travelHrs),
        arrival_utc: arrivalDate.toISOString(),
        arrival_hst: arrivalDate.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu' }),
        est_height_pauwela_m: Math.round(estHeightM * 10) / 10,
        est_period_s: period,
        level: level.level,
        level_label: level.label,
        wave_event: level.wave_event,
        cancel_plans: level.cancel_plans,
        direction_label: swellDirectionLabel(dir),
      });
    }
  }

  // From waypoint storm windows — future storms generating swell
  for (const wp of waypoints) {
    if (wp.error || !wp.storm_windows?.length) continue;
    for (const storm of wp.storm_windows) {
      if (storm.peak_m < 3.0 || storm.period_s < 10) continue;
      if (!isNorthFacingSwell(storm.dir_deg)) continue;

      const dist = distNm(wp.waypoint.lat, wp.waypoint.lon, PAUWELA.lat, PAUWELA.lon);
      // Storm arrival = storm start time + travel time
      const stormStartMs = new Date(storm.start + 'Z').getTime();
      const travelHrs = travelTimeHours(dist, storm.period_s);
      const arrivalMs = stormStartMs + travelHrs * 3600000;
      const arrivalDate = new Date(arrivalMs);

      // Only include future arrivals (within 10 days)
      const daysOut = (arrivalMs - Date.now()) / (1000 * 3600 * 24);
      if (daysOut < 0 || daysOut > 10) continue;

      // Height estimate at Pauwela
      const estHt = Math.min(storm.peak_m * 0.3, attenuatedHeight(storm.peak_m, 500, dist));
      const level = classifySwellLevel(estHt, storm.period_s, storm.dir_deg);

      swellArrivals.push({
        source: `Model — ${wp.waypoint.name}`,
        observed_height_m: storm.peak_m,
        observed_period_s: storm.period_s,
        observed_dir_deg: storm.dir_deg,
        dist_nm: Math.round(dist),
        travel_hours: Math.round(travelHrs),
        arrival_utc: arrivalDate.toISOString(),
        arrival_hst: arrivalDate.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu' }),
        est_height_pauwela_m: Math.round(estHt * 10) / 10,
        est_period_s: storm.period_s,
        level: level.level,
        level_label: level.label,
        wave_event: level.wave_event,
        cancel_plans: level.cancel_plans,
        direction_label: swellDirectionLabel(storm.dir_deg),
        days_out: Math.round(daysOut * 10) / 10,
      });
    }
  }

  // ── 6. Classify direct Pauwela 7-day swell forecast ──────────────
  const pauwelaDailyEvents = (pauwelaSwell?.daily || []).map(d => {
    const ht = d.swell_max_m || 0;
    const period = d.swell_period_max_s || 0;
    const dir = d.swell_dir_dominant_deg;
    const level = classifySwellLevel(ht, period, dir);
    return {
      date: d.date,
      swell_max_m: ht,
      swell_period_s: period,
      swell_dir_deg: dir,
      direction_label: swellDirectionLabel(dir),
      level: level.level,
      level_label: level.label,
      wave_event: level.wave_event,
      cancel_plans: level.cancel_plans,
    };
  });

  // ── 7. Overall alert ──────────────────────────────────────────────
  const allEvents = [
    ...pauwelaDailyEvents.filter(d => d.wave_event),
    ...swellArrivals.filter(a => a.wave_event),
  ];
  const cancelPlansEvents = allEvents.filter(e => e.cancel_plans);
  const maxPauwelaSwell = Math.max(0, ...(pauwelaSwell?.daily || []).map(d => d.swell_max_m || 0));
  const maxPauwelaPeriod = Math.max(0, ...(pauwelaSwell?.daily || []).map(d => d.swell_period_max_s || 0));

  const overallLevel = (() => {
    for (const lvl of SWELL_LEVELS) {
      if (maxPauwelaSwell >= lvl.min_m && maxPauwelaPeriod >= lvl.min_period) return lvl;
    }
    return SWELL_LEVELS[SWELL_LEVELS.length - 1];
  })();

  const output = {
    source: 'north-pacific-swell',
    fetched_utc: new Date().toISOString(),

    // Overall 7-day swell outlook
    summary: {
      level: overallLevel.level,
      level_label: overallLevel.label,
      wave_event_active: allEvents.length > 0,
      cancel_plans_alert: cancelPlansEvents.length > 0,
      max_swell_pauwela_m: Math.round(maxPauwelaSwell * 10) / 10,
      max_period_s: Math.round(maxPauwelaPeriod * 10) / 10,
      wave_event_dates: [...new Set(pauwelaDailyEvents.filter(d => d.wave_event).map(d => d.date))],
      cancel_plans_dates: [...new Set(pauwelaDailyEvents.filter(d => d.cancel_plans).map(d => d.date))],
    },

    // NWS Surf Forecast
    surf_forecast: surfForecast,

    // Day-by-day at Pauwela
    pauwela_7day: pauwelaDailyEvents,

    // Propagation-based swell arrivals from North Pacific storms
    swell_arrivals: swellArrivals.sort((a, b) => new Date(a.arrival_utc) - new Date(b.arrival_utc)),

    // NDBC buoy real-time conditions
    buoys: Object.fromEntries(
      Object.entries(buoyData).map(([id, b]) => [id, {
        name: b.name,
        dist_nm: b.dist_nm,
        wave_height_m: b.met?.wave_height_m,
        dominant_period_s: b.met?.dominant_period_s,
        mean_wave_dir_deg: b.met?.mean_wave_dir_deg,
        wind_speed_ms: b.met?.wind_speed_ms,
        swell_height_m: b.spec?.swell_height_m,
        swell_period_s: b.spec?.swell_period_s,
        swell_dir_label: swellDirectionLabel(b.spec?.swell_dir_deg ?? b.met?.mean_wave_dir_deg),
        observed_at: b.met?.time_utc,
        error: b.error,
      }])
    ),

    // Waypoint storm status
    north_pacific_waypoints: waypoints.map(wp => ({
      id: wp.waypoint?.id,
      name: wp.waypoint?.name,
      note: wp.waypoint?.note,
      current_wave_m: wp.current?.wave_height_m,
      current_period_s: wp.current?.wave_period_s,
      current_dir_deg: wp.current?.wave_dir_deg,
      peak_7day_m: wp.peak_7day?.height_m,
      peak_7day_period_s: wp.peak_7day?.period_s,
      peak_7day_time: wp.peak_7day?.time_utc,
      active_storm_windows: wp.storm_windows?.length || 0,
      error: wp.error,
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
