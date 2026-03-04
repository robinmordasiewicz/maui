#!/usr/bin/env node
/**
 * tides-noaa.mjs — NOAA tide predictions & observations for Kahului
 *
 * Usage: node tides-noaa.mjs [days_ahead]    (default: 3)
 */
import https from 'https';

const STATION = '1615680'; // Kahului, Maui
const DAYS = parseInt(process.argv[2] || '3');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'maui-wx/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function formatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function main() {
  process.stderr.write('tides-noaa: fetching tide data... ');

  const today = new Date();
  const end = new Date(today.getTime() + DAYS * 86400000);
  const base = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`;

  // Predictions (hi/lo)
  const hiloUrl = `${base}?begin_date=${formatDate(today)}&end_date=${formatDate(end)}&station=${STATION}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&format=json`;
  const hilo = await fetchJSON(hiloUrl);

  // Predictions (6-min intervals for graphing)
  const predUrl = `${base}?begin_date=${formatDate(today)}&end_date=${formatDate(end)}&station=${STATION}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json`;
  const pred = await fetchJSON(predUrl);

  // Observed water level (last 24h)
  const obsUrl = `${base}?date=latest&station=${STATION}&product=water_level&datum=MLLW&time_zone=lst_ldt&units=english&format=json`;
  const obs = await fetchJSON(obsUrl);

  process.stderr.write('done\n');

  const output = {
    source: 'tides-noaa',
    location: 'Kahului, Maui HI',
    station_id: STATION,
    fetched_utc: new Date().toISOString(),
    days_ahead: DAYS,
    units: { level: 'ft', datum: 'MLLW' },
    high_low: (hilo.predictions || []).map(p => ({
      time_local: p.t,
      level_ft: parseFloat(p.v),
      type: p.type === 'H' ? 'high' : 'low',
    })),
    predictions_count: (pred.predictions || []).length,
    predictions: (pred.predictions || []).map(p => ({
      time_local: p.t,
      level_ft: parseFloat(p.v),
    })),
    latest_observed: obs.data ? {
      time_local: obs.data[0]?.t,
      level_ft: parseFloat(obs.data[0]?.v),
      quality: obs.data[0]?.q,
    } : null,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
