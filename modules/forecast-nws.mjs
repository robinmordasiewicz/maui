#!/usr/bin/env node
/**
 * forecast-nws.mjs — NWS forecast for Kanaha area
 *
 * Pulls hourly forecast, daily narrative, and active hazards/warnings.
 * Usage: node forecast-nws.mjs
 */
import https from 'https';

const GRID = 'HFO/213,126'; // Kanaha area
const UA = 'maui-wx/1.0 (watersport-conditions)';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  process.stderr.write('forecast-nws: fetching NWS data... ');

  const [hourly, daily, gridpoint, alerts] = await Promise.all([
    fetchJSON(`https://api.weather.gov/gridpoints/${GRID}/forecast/hourly`),
    fetchJSON(`https://api.weather.gov/gridpoints/${GRID}/forecast`),
    fetchJSON(`https://api.weather.gov/gridpoints/${GRID}`),
    fetchJSON(`https://api.weather.gov/alerts/active?point=20.896,-156.452`),
  ]);

  process.stderr.write('done\n');

  // Extract gridpoint fields
  const gp = gridpoint.properties || {};
  const extractGrid = (field) => {
    const vals = gp[field]?.values || [];
    return vals.map(v => ({
      time: v.validTime?.split('/')[0],
      value: v.value,
    }));
  };

  const output = {
    source: 'forecast-nws',
    location: 'Kanaha, Maui HI',
    grid: GRID,
    fetched_utc: new Date().toISOString(),

    // Active alerts/warnings
    alerts: (alerts.features || []).map(f => ({
      event: f.properties?.event,
      headline: f.properties?.headline,
      severity: f.properties?.severity,
      onset: f.properties?.onset,
      expires: f.properties?.expires,
      description: f.properties?.description?.substring(0, 500),
    })),

    // Hourly forecast (next 48h or so)
    hourly: (hourly.properties?.periods || []).slice(0, 48).map(p => ({
      time: p.startTime,
      temp_f: p.temperature,
      wind_speed: p.windSpeed,
      wind_dir: p.windDirection,
      short_forecast: p.shortForecast,
      precip_pct: p.probabilityOfPrecipitation?.value,
      humidity_pct: p.relativeHumidity?.value,
    })),

    // Daily narrative forecast
    daily: (daily.properties?.periods || []).map(p => ({
      name: p.name,
      temp_f: p.temperature,
      wind_speed: p.windSpeed,
      wind_dir: p.windDirection,
      forecast: p.detailedForecast,
    })),

    // Gridpoint data (precip, pressure, hazards)
    gridpoint: {
      precip_probability: extractGrid('probabilityOfPrecipitation'),
      quantitative_precip: extractGrid('quantitativePrecipitation'),
      wind_speed: extractGrid('windSpeed'),
      wind_gust: extractGrid('windGust'),
      wind_direction: extractGrid('windDirection'),
      temperature: extractGrid('temperature'),
      dewpoint: extractGrid('dewpoint'),
      humidity: extractGrid('relativeHumidity'),
      sky_cover: extractGrid('skyCover'),
      hazards: extractGrid('hazards'),
      primary_swell_height: extractGrid('primarySwellHeight'),
      primary_swell_direction: extractGrid('primarySwellDirection'),
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
