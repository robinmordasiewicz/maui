#!/usr/bin/env node
/**
 * ocean-waves.mjs — Wave/swell forecast via Open-Meteo Marine API
 *
 * Usage: node ocean-waves.mjs [forecast_days]    (default: 7)
 */
import https from 'https';

const LAT = 20.896;
const LON = -156.452;
const DAYS = parseInt(process.argv[2] || '7');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  process.stderr.write('ocean-waves: fetching marine data... ');

  const params = [
    'wave_height', 'wave_direction', 'wave_period',
    'wind_wave_height', 'wind_wave_direction', 'wind_wave_period', 'wind_wave_peak_period',
    'swell_wave_height', 'swell_wave_direction', 'swell_wave_period', 'swell_wave_peak_period',
    'ocean_current_velocity', 'ocean_current_direction',
  ].join(',');

  const daily = [
    'wave_height_max', 'wave_direction_dominant', 'wave_period_max',
    'wind_wave_height_max', 'wind_wave_direction_dominant', 'wind_wave_period_max',
    'swell_wave_height_max', 'swell_wave_direction_dominant', 'swell_wave_period_max',
  ].join(',');

  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT}&longitude=${LON}&hourly=${params}&daily=${daily}&forecast_days=${DAYS}&timezone=Pacific/Honolulu`;

  const data = await fetchJSON(url);
  process.stderr.write('done\n');

  const h = data.hourly || {};
  const d = data.daily || {};

  const output = {
    source: 'ocean-waves',
    location: 'Kanaha, Maui HI',
    coordinates: { lat: LAT, lon: LON },
    fetched_utc: new Date().toISOString(),
    forecast_days: DAYS,
    units: {
      height: 'm',
      period: 's',
      direction: 'deg',
      current_velocity: 'm/s',
    },
    hourly: (h.time || []).map((t, i) => ({
      time_hst: t,
      // Combined sea state
      wave_height_m: h.wave_height?.[i],
      wave_dir_deg: h.wave_direction?.[i],
      wave_period_s: h.wave_period?.[i],
      // Wind waves (locally generated chop)
      wind_wave_height_m: h.wind_wave_height?.[i],
      wind_wave_dir_deg: h.wind_wave_direction?.[i],
      wind_wave_period_s: h.wind_wave_period?.[i],
      wind_wave_peak_period_s: h.wind_wave_peak_period?.[i],
      // Swell (distant storms)
      swell_height_m: h.swell_wave_height?.[i],
      swell_dir_deg: h.swell_wave_direction?.[i],
      swell_period_s: h.swell_wave_period?.[i],
      swell_peak_period_s: h.swell_wave_peak_period?.[i],
      // Currents
      current_velocity_ms: h.ocean_current_velocity?.[i],
      current_dir_deg: h.ocean_current_direction?.[i],
    })),
    daily: (d.time || []).map((t, i) => ({
      date: t,
      wave_max_m: d.wave_height_max?.[i],
      wave_dir_dominant_deg: d.wave_direction_dominant?.[i],
      wave_period_max_s: d.wave_period_max?.[i],
      wind_wave_max_m: d.wind_wave_height_max?.[i],
      wind_wave_dir_dominant_deg: d.wind_wave_direction_dominant?.[i],
      swell_max_m: d.swell_wave_height_max?.[i],
      swell_dir_dominant_deg: d.swell_wave_direction_dominant?.[i],
      swell_period_max_s: d.swell_wave_period_max?.[i],
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
