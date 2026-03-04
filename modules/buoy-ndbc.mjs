#!/usr/bin/env node
/**
 * buoy-ndbc.mjs — NDBC buoy observations near Maui
 *
 * Pulls real-time wave/ocean data from NOAA NDBC buoys.
 * Usage: node buoy-ndbc.mjs [hours_back]    (default: 24)
 */
import https from 'https';

const STATIONS = {
  '51205': { name: 'Pauwela, Maui', lat: 21.018, lon: -156.421, note: 'Closest to Kanaha, north swell indicator' },
  '51202': { name: 'Mokapu, Oahu', lat: 21.417, lon: -157.680, note: 'Windward swell reference' },
};
const HOURS_BACK = parseInt(process.argv[2] || '24');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseNDBC(text, hoursBack) {
  const lines = text.trim().split('\n');
  if (lines.length < 3) return [];

  const headers = lines[0].replace(/^#/, '').trim().split(/\s+/);
  const cutoff = Date.now() - hoursBack * 3600000;
  const records = [];

  for (let i = 2; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length < 5) continue;

    const [yr, mo, dy, hr, mn] = cols;
    const dt = new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +mn));
    if (dt.getTime() < cutoff) break;

    const get = (idx) => {
      const v = cols[idx];
      return v === 'MM' || v === undefined ? null : parseFloat(v);
    };

    records.push({
      time_utc: dt.toISOString(),
      wind_dir_deg: get(5),
      wind_speed_ms: get(6),
      wind_gust_ms: get(7),
      wave_height_m: get(8),
      dominant_wave_period_s: get(9),
      avg_wave_period_s: get(10),
      mean_wave_dir_deg: get(11),
      pressure_hpa: get(12),
      air_temp_c: get(13),
      water_temp_c: get(14),
      dewpoint_c: get(15),
    });
  }
  return records;
}

async function main() {
  process.stderr.write('buoy-ndbc: fetching buoy data... ');

  const stationData = {};
  for (const [id, info] of Object.entries(STATIONS)) {
    try {
      const text = await fetchText(`https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`);
      stationData[id] = {
        ...info,
        station_id: id,
        observations: parseNDBC(text, HOURS_BACK),
      };
    } catch (err) {
      stationData[id] = { ...info, station_id: id, error: err.message, observations: [] };
    }
  }

  process.stderr.write('done\n');

  const output = {
    source: 'buoy-ndbc',
    location: 'North Maui / Hawaii buoys',
    fetched_utc: new Date().toISOString(),
    hours_back: HOURS_BACK,
    units: {
      wave_height: 'm',
      wave_period: 's',
      wind_speed: 'm/s',
      pressure: 'hPa',
      temp: 'C',
      direction: 'degTrue',
    },
    stations: stationData,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
