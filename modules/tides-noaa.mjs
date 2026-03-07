#!/usr/bin/env node
/**
 * tides-noaa.mjs — NOAA tide predictions & observations + USNO moon data for Kahului
 *
 * Usage: node tides-noaa.mjs [days_ahead]    (default: 3)
 */
import https from 'https';

const STATION = '1615680'; // Kahului, Maui
const DAYS = parseInt(process.argv[2] || '3');

// Kanaha Beach Park coordinates
const LAT = 20.895;
const LON = -156.460;
const TZ_OFFSET = -10; // HST

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

  // ── Moon data from USNO ──────────────────────────────────────────
  process.stderr.write('tides-noaa: fetching moon data... ');
  let moon = null;
  try {
    const dateStr = today.toISOString().slice(0, 10);
    const usnoUrl = `https://aa.usno.navy.mil/api/rstt/oneday?date=${dateStr}&coords=${LAT},${LON}&tz=${TZ_OFFSET}`;
    const usnoData = await fetchJSON(usnoUrl);
    const props = usnoData?.properties?.data;
    if (props) {
      const moonrise = props.moondata?.find(m => m.phen === 'Rise')?.time || null;
      const moonset = props.moondata?.find(m => m.phen === 'Set')?.time || null;
      const transit = props.moondata?.find(m => m.phen === 'Upper Transit')?.time || null;

      // Determine tidal regime from moon phase
      const phase = props.curphase || 'Unknown';
      const illumination = props.fracillum || null;
      const closest = props.closestphase || null;

      // Spring tides occur near new/full moon; neap tides near quarter moons
      let tidal_regime = 'normal';
      let tidal_note = null;
      if (closest) {
        const closestDate = new Date(closest.year, closest.month - 1, closest.day);
        const daysToPhase = Math.round((closestDate - today) / 86400000);
        const absD = Math.abs(daysToPhase);

        if ((closest.phase === 'Full Moon' || closest.phase === 'New Moon') && absD <= 2) {
          tidal_regime = 'spring';
          tidal_note = `Spring tides — ${closest.phase} ${daysToPhase === 0 ? 'today' : daysToPhase > 0 ? `in ${absD}d` : `${absD}d ago`}. Larger tidal range (higher highs, lower lows).`;
        } else if ((closest.phase === 'First Quarter' || closest.phase === 'Last Quarter') && absD <= 2) {
          tidal_regime = 'neap';
          tidal_note = `Neap tides — ${closest.phase} ${daysToPhase === 0 ? 'today' : daysToPhase > 0 ? `in ${absD}d` : `${absD}d ago`}. Smaller tidal range (moderate highs and lows).`;
        }
      }

      moon = {
        phase,
        illumination,
        moonrise: moonrise ? `${moonrise} HST` : null,
        moonset: moonset ? `${moonset} HST` : null,
        transit: transit ? `${transit} HST` : null,
        closest_phase: closest ? {
          phase: closest.phase,
          date: `${closest.year}-${String(closest.month).padStart(2, '0')}-${String(closest.day).padStart(2, '0')}`,
          time: closest.time,
        } : null,
        tidal_regime,
        tidal_note,
      };
    }
    process.stderr.write('done\n');
  } catch (err) {
    process.stderr.write(`failed (${err.message}) — continuing without moon data\n`);
  }

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
    moon,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
