#!/usr/bin/env node
/**
 * isthmus-thermal.mjs — Maui Isthmus Thermal Effect Model
 *
 * PHYSICAL MODEL:
 * Maui has two large mountains (Haleakala 10,023' and West Maui Mtns 5,788')
 * connected by a low-lying, nearly sea-level flat area: the Central Valley / Isthmus.
 *
 * The isthmus heats up under sun → creates a thermal low → draws cooler marine air
 * onshore from the north (sea breeze effect). This interacts with trade winds:
 *
 *   1. NO TRADES + HOT ISTHMUS → Pure sea breeze, ~12-15kts, northerly direction
 *      (straight onshore at Kanaha, ~330-000°)
 *
 *   2. LIGHT TRADES + HOT ISTHMUS → Combined flow, trades pulled more onshore,
 *      creating ideal NE cross-onshore at Kanaha (~30-45°), 15-20kts
 *
 *   3. STRONG TRADES + COOL ISTHMUS → Pure trade flow, easterly (~60-90°),
 *      gusty because trades overpower thermal, no onshore pulling effect
 *
 * VENTURI EFFECT:
 * The two mountains compress airflow through the isthmus gap, accelerating wind.
 * Stronger when: trades are moderate AND thermal is active (both push air through gap).
 * The venturi is observable at Maalaea (south side of gap) where wind accelerates.
 *
 * THERMAL INDICATORS:
 * Five inland MECO stations measure isthmus temperature. We compare their average
 * to ocean buoy SST to determine thermal gradient strength.
 *
 * Outputs JSON with thermal state, predicted wind direction effect, and venturi index.
 */

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

// ── Isthmus Temperature Stations ─────────────────────────────────────
// All MECO (Maui Electric) stations on the central valley / isthmus
const ISTHMUS_STATIONS = {
  hansen_rd:        { id: 645600, name: 'MECO Hansen Rd',        lat: 20.870, lon: -156.454, elevation_m: 20,  note: 'Central isthmus, near sea level — best isthmus temp indicator' },
  haleakala_hwy:    { id: 645598, name: 'MECO Haleakala Hwy',    lat: 20.883, lon: -156.417, elevation_m: 60,  note: 'East side of isthmus, slight elevation' },
  upper_division:   { id: 645602, name: 'MECO Upper Division Rd', lat: 20.848, lon: -156.413, elevation_m: 100, note: 'South isthmus, foothills of Haleakala' },
  haleakala_hwy2:   { id: 681503, name: 'MECO Haleakala Hwy 2',  lat: 20.867, lon: -156.379, elevation_m: 120, note: 'Further up Haleakala side' },
  // Additional useful inland stations for context
  veterans_hwy:     { id: 645604, name: 'MECO Veterans Hwy',     lat: 20.795, lon: -156.465, elevation_m: 30,  note: 'South end of isthmus near Maalaea' },
  maalaea:          { id: 642710, name: 'MECO Maalaea',          lat: 20.801, lon: -156.489, elevation_m: 10,  note: 'South gap exit — venturi acceleration point, also captures isthmus temp' },
};

// Reference stations for comparison
const REFERENCE_STATIONS = {
  kahului_airport: { id: 643, name: 'Kahului Airport (ASOS)', note: 'FAA maintained, isthmus level, reliable temp' },
  kahului_harbor:  { id: 4349, name: 'Kahului Harbor', note: 'Water-adjacent, includes wtemp' },
  kanaha:          { id: 166192, name: 'Kanaha Beach', note: 'Gold standard wind, coastal temp' },
  maalaea:         { id: 642710, name: 'Maalaea', note: 'South gap exit — venturi indicator' },
};

// ── Thermal State Classification ─────────────────────────────────────
function classifyThermalState(isthmusTempC, oceanTempC, tradeWindKts) {
  const landSeaDiff = isthmusTempC - oceanTempC;

  // Thermal drive strength based on land-sea temperature differential
  let thermalDrive;
  if (landSeaDiff > 5) thermalDrive = { strength: 'very_strong', factor: 1.5, desc: 'Intense isthmus heating — strong onshore pull' };
  else if (landSeaDiff > 3) thermalDrive = { strength: 'strong', factor: 1.3, desc: 'Hot isthmus — significant sea breeze component' };
  else if (landSeaDiff > 1.5) thermalDrive = { strength: 'moderate', factor: 1.0, desc: 'Moderate thermal — normal sea breeze assist' };
  else if (landSeaDiff > 0) thermalDrive = { strength: 'weak', factor: 0.5, desc: 'Minimal thermal differential — limited sea breeze' };
  else thermalDrive = { strength: 'none', factor: 0.0, desc: 'No thermal drive — land cooler than sea (nighttime or heavy overcast)' };

  // Wind regime based on trade + thermal interaction
  let regime;
  if (tradeWindKts < 8) {
    if (thermalDrive.strength === 'strong' || thermalDrive.strength === 'very_strong') {
      regime = {
        type: 'pure_sea_breeze',
        expected_speed_kts: '12-15',
        expected_dir: '330-360° (N/NNW)',
        expected_dir_text: 'N to NNW — straight onshore',
        gustiness: 'light_variable',
        desc: 'No trades → pure thermal sea breeze pulling air onshore through the gap',
      };
    } else {
      regime = {
        type: 'calm',
        expected_speed_kts: '0-8',
        expected_dir: 'variable',
        expected_dir_text: 'Variable — light and fluky',
        gustiness: 'variable',
        desc: 'No trades and no thermal → calm conditions',
      };
    }
  } else if (tradeWindKts < 15) {
    if (thermalDrive.factor > 0.5) {
      regime = {
        type: 'trades_plus_thermal',
        expected_speed_kts: '15-22',
        expected_dir: '30-60° (NE-ENE)',
        expected_dir_text: 'NE — ideal cross-onshore (trades pulled onshore by thermal)',
        gustiness: 'moderate_steady',
        desc: 'Sweet spot: light trades + thermal = wind pulled onshore, steady, cross-shore at Kanaha',
      };
    } else {
      regime = {
        type: 'light_trades',
        expected_speed_kts: '10-15',
        expected_dir: '50-80° (NE-ENE)',
        expected_dir_text: 'ENE — slightly cross-shore',
        gustiness: 'moderate',
        desc: 'Light trades without strong thermal assist — moderate, slightly offshore',
      };
    }
  } else if (tradeWindKts < 25) {
    regime = {
      type: 'trades_dominant',
      expected_speed_kts: '18-28',
      expected_dir: '50-70° (NE-ENE)',
      expected_dir_text: 'ENE — trades with some onshore pull',
      gustiness: thermalDrive.factor > 0.5 ? 'steady' : 'moderate_gusty',
      desc: 'Strong trades — thermal adds power but trades control direction. Best conditions.',
    };
  } else {
    regime = {
      type: 'trades_overpowering',
      expected_speed_kts: '25-40',
      expected_dir: '60-100° (ENE-E)',
      expected_dir_text: 'E to ENE — trades overpower thermal, gusty and more offshore',
      gustiness: 'very_gusty',
      desc: 'Very strong trades overpower sea breeze → gusty, more easterly, less organized',
    };
  }

  // Venturi effect estimate
  // Stronger when both trades and thermal push air through the gap
  const venturiIndex = Math.min(5, Math.round(
    (Math.min(tradeWindKts, 25) / 25 * 2.5) + // trade contribution
    (thermalDrive.factor * 2.5)                  // thermal contribution
  ) * 10) / 10;
  const venturi = {
    index: venturiIndex,
    rating: venturiIndex > 4 ? 'strong' : venturiIndex > 2.5 ? 'moderate' : venturiIndex > 1 ? 'weak' : 'minimal',
    desc: venturiIndex > 4 ? 'Strong compression through isthmus gap — Maalaea howling'
      : venturiIndex > 2.5 ? 'Moderate venturi — noticeable acceleration through gap'
      : 'Minimal venturi effect',
  };

  return {
    land_sea_diff_c: Math.round(landSeaDiff * 10) / 10,
    isthmus_temp_c: Math.round(isthmusTempC * 10) / 10,
    ocean_temp_c: Math.round(oceanTempC * 10) / 10,
    thermal_drive: thermalDrive,
    wind_regime: regime,
    venturi,
  };
}

// ── Predict thermal contribution to wind ─────────────────────────────
function predictThermalContribution(thermalState, currentHstHour) {
  const { thermal_drive, wind_regime } = thermalState;

  // Thermal contribution follows solar curve — peaks 12-14h HST
  function solarFraction(h) {
    if (h <= 7) return 0;
    if (h <= 9) return (h - 7) / 4;    // ramp 0→0.5
    if (h <= 11) return 0.5 + (h - 9) / 4; // ramp 0.5→1.0
    if (h <= 14) return 1.0;            // peak
    if (h <= 17) return 1.0 - (h - 14) / 5; // decay 1.0→0.4
    if (h <= 19) return 0.4 - (h - 17) / 5; // decay 0.4→0
    return 0;
  }

  const predictions = [];
  for (let h = Math.max(7, Math.floor(currentHstHour)); h <= 20; h++) {
    const solar = solarFraction(h);
    const thermalKts = Math.round(thermal_drive.factor * solar * 8 * 10) / 10; // max ~8kts thermal boost
    const thermalDir = 350; // sea breeze pulls roughly from N
    // Combined direction: weighted vector addition (simplified)
    // Strong trades → direction stays E. Strong thermal → pulled toward N.
    const tradeWeight = 1.0;
    const thermalWeight = thermal_drive.factor * solar * 0.3; // thermal influences direction less than speed

    predictions.push({
      hour_hst: h,
      solar_fraction: Math.round(solar * 100),
      thermal_boost_kts: thermalKts,
      onshore_pull_factor: Math.round(thermalWeight * 100) / 100,
      phase: h <= 9 ? 'thermal_building' : h <= 14 ? 'thermal_peak' : h <= 17 ? 'thermal_fading' : 'thermal_off',
    });
  }

  return predictions;
}

// ── Isthmus heat index from multiple stations ────────────────────────
function computeIsthmusHeatIndex(stationTemps) {
  // Weight stations by relevance (lower elevation, more central = more representative)
  const weights = {
    hansen_rd: 1.5,      // most central, lowest
    haleakala_hwy: 1.0,
    upper_division: 0.8, // slightly elevated
    haleakala_hwy2: 0.7, // further up slope
    veterans_hwy: 0.8,   // south end
    maalaea: 0.7,         // south gap exit, slightly coastal
    kahului_airport: 1.2, // reliable, central
  };

  let totalWeight = 0;
  let weightedSum = 0;
  let maxTemp = -999;
  let minTemp = 999;
  const readings = [];

  for (const [key, temp] of Object.entries(stationTemps)) {
    if (temp == null) continue;
    const w = weights[key] || 1.0;
    weightedSum += temp * w;
    totalWeight += w;
    maxTemp = Math.max(maxTemp, temp);
    minTemp = Math.min(minTemp, temp);
    readings.push({ station: key, temp_c: temp, weight: w });
  }

  if (totalWeight === 0) return null;

  return {
    weighted_avg_c: Math.round((weightedSum / totalWeight) * 10) / 10,
    max_c: maxTemp,
    min_c: minTemp,
    spread_c: Math.round((maxTemp - minTemp) * 10) / 10,
    station_count: readings.length,
    readings,
  };
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  process.stderr.write('isthmus-thermal: loading session... ');
  let browser, page, token;
  try {
    ({ browser, page, token } = await loadSession());
  } catch (e) {
    process.stderr.write(`FAILED\n  ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write('done\n');

  // Fetch all station data
  const allIds = [
    ...Object.values(ISTHMUS_STATIONS).map(s => s.id),
    ...Object.values(REFERENCE_STATIONS).map(s => s.id),
  ].join(',');

  process.stderr.write('isthmus-thermal: fetching stations... ');
  const stationsRaw = await page.evaluate(async (ids) => {
    const t = typeof token !== 'undefined' ? token : '';
    const r = await fetch(`https://api.weatherflow.com/wxengine/rest/spot/getSpotDetailSetByList?spot_list=${ids}&units_wind=kts&units_temp=c&wf_token=${t}`);
    return r.json();
  }, allIds);
  process.stderr.write('done\n');

  // Parse station readings
  const stationData = {};
  for (const s of (stationsRaw.spots || [])) {
    const names = s.data_names || [];
    const vals = s.stations?.[0]?.data_values?.[0] || [];
    const get = (f) => { const i = names.indexOf(f); return i >= 0 ? vals[i] : null; };
    stationData[s.spot_id] = {
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      atemp: get('atemp'),
      wtemp: get('wtemp'),
      avg: get('avg'),
      gust: get('gust'),
      dir: get('dir'),
      dir_text: get('dir_text'),
      timestamp: get('timestamp'),
    };
  }

  // Fetch ocean reference temp from NDBC buoy (Pauwela or SE Hawaii)
  let oceanTemp = null;
  try {
    const metText = await fetchText('https://www.ndbc.noaa.gov/data/realtime2/51205.txt');
    const lines = metText.trim().split('\n');
    if (lines.length >= 3) {
      const cols = lines[2].trim().split(/\s+/);
      if (cols[14] !== 'MM') oceanTemp = parseFloat(cols[14]);
    }
  } catch (e) { /* */ }
  // Fallback to harbor wtemp
  if (!oceanTemp) oceanTemp = stationData[4349]?.wtemp;

  // Compute isthmus heat index
  const isthmusTemps = {};
  for (const [key, meta] of Object.entries(ISTHMUS_STATIONS)) {
    const data = stationData[meta.id];
    if (data?.atemp != null) isthmusTemps[key] = data.atemp;
  }
  // Add airport temp
  if (stationData[643]?.atemp != null) isthmusTemps.kahului_airport = stationData[643].atemp;

  const heatIndex = computeIsthmusHeatIndex(isthmusTemps);

  // Get current trade wind strength from Kanaha
  const kanahaData = stationData[166192];
  const tradeWindKts = kanahaData?.avg || 0;

  // Classify thermal state
  const thermalState = heatIndex && oceanTemp
    ? classifyThermalState(heatIndex.weighted_avg_c, oceanTemp, tradeWindKts)
    : null;

  // Current HST hour
  const hstStr = new Date().toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour12: false });
  const hstHour = parseInt(hstStr.split(', ')[1]?.split(':')[0]) || 12;

  // Predict thermal contribution
  const thermalPrediction = thermalState ? predictThermalContribution(thermalState, hstHour) : null;

  // Maalaea venturi check
  const maalaeaData = stationData[642710];
  const venturiObs = maalaeaData ? {
    maalaea_wind_kts: maalaeaData.avg,
    maalaea_gust_kts: maalaeaData.gust,
    maalaea_dir: maalaeaData.dir_text,
    kanaha_wind_kts: kanahaData?.avg,
    maalaea_kanaha_ratio: maalaeaData.avg && kanahaData?.avg
      ? Math.round((maalaeaData.avg / kanahaData.avg) * 100) / 100
      : null,
    note: maalaeaData.avg > (kanahaData?.avg || 0) * 0.8
      ? 'Maalaea reading strong — venturi acceleration active'
      : 'Maalaea reading lighter — venturi effect weak or wind not channeling',
  } : null;

  // Compile output
  const output = {
    source: 'isthmus-thermal',
    fetched_utc: new Date().toISOString(),
    location: 'Maui Central Valley / Isthmus',
    current_hst_hour: hstHour,

    isthmus_heat: heatIndex,
    ocean_reference_temp_c: oceanTemp,

    thermal_state: thermalState,
    thermal_prediction: thermalPrediction,
    venturi_observation: venturiObs,

    station_detail: Object.fromEntries(
      Object.entries(ISTHMUS_STATIONS).map(([key, meta]) => [key, {
        ...meta,
        current: stationData[meta.id] || null,
      }])
    ),

    reference_stations: {
      kanaha: stationData[166192],
      airport: stationData[643],
      harbor: stationData[4349],
      maalaea: stationData[642710],
    },

    summary: {
      isthmus_temp_c: heatIndex?.weighted_avg_c || null,
      ocean_temp_c: oceanTemp,
      land_sea_diff_c: thermalState?.land_sea_diff_c || null,
      thermal_drive: thermalState?.thermal_drive?.strength || 'unknown',
      wind_regime: thermalState?.wind_regime?.type || 'unknown',
      regime_desc: thermalState?.wind_regime?.desc || '',
      expected_direction: thermalState?.wind_regime?.expected_dir_text || 'unknown',
      gustiness: thermalState?.wind_regime?.gustiness || 'unknown',
      venturi: thermalState?.venturi?.rating || 'unknown',
      current_wind: `${kanahaData?.avg || '?'}kts ${kanahaData?.dir_text || '?'}`,
    },
  };

  console.log(JSON.stringify(output, null, 2));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
