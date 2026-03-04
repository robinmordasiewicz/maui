#!/usr/bin/env node
/**
 * pressure-meteo.mjs — Atmospheric conditions via Open-Meteo
 *
 * Pressure systems, precipitation, cloud cover, temperature.
 * Usage: node pressure-meteo.mjs [forecast_days]    (default: 7)
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
  process.stderr.write('pressure-meteo: fetching atmospheric data... ');

  const params = [
    'pressure_msl', 'surface_pressure',
    'precipitation', 'precipitation_probability', 'rain', 'showers',
    'cloudcover', 'cloudcover_low', 'cloudcover_mid', 'cloudcover_high',
    'temperature_2m', 'apparent_temperature', 'dewpoint_2m',
    'relativehumidity_2m',
    'windspeed_10m', 'windgusts_10m', 'winddirection_10m',
    'cape', 'visibility', 'weathercode',
  ].join(',');

  const daily = [
    'temperature_2m_max', 'temperature_2m_min',
    'precipitation_sum', 'precipitation_probability_max',
    'windspeed_10m_max', 'windgusts_10m_max', 'winddirection_10m_dominant',
    'sunrise', 'sunset',
  ].join(',');

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=${params}&daily=${daily}&forecast_days=${DAYS}&timezone=Pacific/Honolulu&windspeed_unit=kn`;

  const data = await fetchJSON(url);
  process.stderr.write('done\n');

  const h = data.hourly || {};
  const d = data.daily || {};

  const output = {
    source: 'pressure-meteo',
    location: 'Kanaha, Maui HI',
    coordinates: { lat: LAT, lon: LON },
    fetched_utc: new Date().toISOString(),
    forecast_days: DAYS,
    units: {
      pressure: 'hPa',
      temp: 'C',
      wind: 'kts',
      precip: 'mm',
      visibility: 'm',
      cloud: '%',
    },
    hourly: (h.time || []).map((t, i) => ({
      time_hst: t,
      pressure_msl_hpa: h.pressure_msl?.[i],
      surface_pressure_hpa: h.surface_pressure?.[i],
      precipitation_mm: h.precipitation?.[i],
      precip_probability_pct: h.precipitation_probability?.[i],
      rain_mm: h.rain?.[i],
      showers_mm: h.showers?.[i],
      cloud_cover_pct: h.cloudcover?.[i],
      cloud_low_pct: h.cloudcover_low?.[i],
      cloud_mid_pct: h.cloudcover_mid?.[i],
      cloud_high_pct: h.cloudcover_high?.[i],
      temp_c: h.temperature_2m?.[i],
      apparent_temp_c: h.apparent_temperature?.[i],
      dewpoint_c: h.dewpoint_2m?.[i],
      humidity_pct: h.relativehumidity_2m?.[i],
      wind_kts: h.windspeed_10m?.[i],
      wind_gust_kts: h.windgusts_10m?.[i],
      wind_dir_deg: h.winddirection_10m?.[i],
      cape_jkg: h.cape?.[i],
      visibility_m: h.visibility?.[i],
      weathercode: h.weathercode?.[i],
      // Derived: shower flag (WMO codes 80-82 = rain showers, 95-99 = thunderstorm)
      is_shower: [80, 81, 82, 85, 86, 95, 96, 99].includes(h.weathercode?.[i]),
    })),
    daily: (d.time || []).map((t, i) => ({
      date: t,
      temp_max_c: d.temperature_2m_max?.[i],
      temp_min_c: d.temperature_2m_min?.[i],
      precip_sum_mm: d.precipitation_sum?.[i],
      precip_prob_max_pct: d.precipitation_probability_max?.[i],
      wind_max_kts: d.windspeed_10m_max?.[i],
      wind_gust_max_kts: d.windgusts_10m_max?.[i],
      wind_dir_dominant_deg: d.winddirection_10m_dominant?.[i],
      sunrise: d.sunrise?.[i],
      sunset: d.sunset?.[i],
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
