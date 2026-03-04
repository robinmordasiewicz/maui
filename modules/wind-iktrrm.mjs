#!/usr/bin/env node
/**
 * wind-iktrrm.mjs — iK-TRRM premium wind forecast for Kanaha via WeatherFlow
 *
 * Uses getModelDataBySpot API which returns hourly forecast data including
 * wind_speed, wind_gust, wind_dir, temp, cloud_cover, pressure, humidity.
 *
 * This is the SAME data the iKitesurf website graph displays.
 *
 * Authentication: restores saved session from output/cache/ik-session.json.
 * No login is performed — no duplicate session conflict with user's browser.
 * If session is missing or expired, run: node scripts/ik-auth.mjs
 *
 * Usage: node wind-iktrrm.mjs [hours]   (default: 48)
 */
import { loadSession } from './ik-session.mjs';

const SPOT_ID = 166192;
const MODEL_ID = -7; // iK-TRRM premium model
const HOURS = parseInt(process.argv[2] || '48');

async function main() {
  process.stderr.write('wind-iktrrm: loading session... ');
  let browser, page, token;
  try {
    ({ browser, page, token } = await loadSession());
  } catch (e) {
    process.stderr.write(`FAILED\n  ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write('done\n');

  try {
    // Fetch iK-TRRM premium model forecast
    process.stderr.write('wind-iktrrm: fetching iK-TRRM forecast... ');
    const data = await page.evaluate(async ({ spotId, modelId, t }) => {
      const url =
        `https://api.weatherflow.com/wxengine/rest/model/getModelDataBySpot` +
        `?spot_id=${spotId}&model_id=${modelId}` +
        `&units_wind=kts&units_temp=c&units_distance=km&units_precip=in` +
        `&wf_token=${t}`;
      const r = await fetch(url);
      return r.json();
    }, { spotId: SPOT_ID, modelId: MODEL_ID, t: token });

    if (data.status?.status_code && data.status.status_code !== 0) {
      process.stderr.write(`ERROR: ${JSON.stringify(data.status)}\n`);
      if (data.status.status_code === 401) {
        process.stderr.write('  Session expired — run: node scripts/ik-auth.mjs\n');
      }
      await browser.close();
      process.exit(1);
    }

    const modelData = data.model_data || [];
    process.stderr.write(`done (${modelData.length} hours)\n`);

    // Current observation
    const obsData = await page.evaluate(async ({ spotId, t }) => {
      const url =
        `https://api.weatherflow.com/wxengine/rest/spot/getSpotDetailSetByList` +
        `?spot_id=${spotId}&units_wind=kts&units_temp=c&units_distance=km` +
        `&wf_token=${t}`;
      const r = await fetch(url);
      return r.json();
    }, { spotId: SPOT_ID, t: token });

    const spot = obsData?.spots?.[0];
    // Data is in stations[0].data_values[0] array — index map from data_names
    const names = spot?.data_names || [];
    const vals = spot?.stations?.[0]?.data_values?.[0] || [];
    const get = (name) => {
      const i = names.indexOf(name);
      return i >= 0 && vals[i] != null ? vals[i] : null;
    };

    const current = spot ? {
      avg_kts:  get('avg')  != null ? Math.round(get('avg')  * 10) / 10 : null,
      gust_kts: get('gust') != null ? Math.round(get('gust') * 10) / 10 : null,
      lull_kts: get('lull') != null ? Math.round(get('lull') * 10) / 10 : null,
      dir_deg:  get('dir'),
      dir_text: get('dir_text'),
      temp_c:   get('atemp'),
    } : null;

    const output = {
      source: 'wind-iktrrm',
      location: 'Kanaha, Maui HI',
      spot_id: SPOT_ID,
      model: data.model_name || 'iK-TRRM',
      model_id: MODEL_ID,
      timezone: data.tz_name || 'Pacific/Honolulu',
      fetched_utc: new Date().toISOString(),
      units: { wind: 'kts', temp: 'c', pressure: 'mb' },
      sun_times: data.sun_times || null,
      current,
      forecast: modelData.slice(0, HOURS).map(d => ({
        time_local: d.model_time_local,
        time_utc: d.model_time_utc,
        wind_speed_kts: Math.round(d.wind_speed * 10) / 10,
        wind_gust_kts: Math.round(d.wind_gust * 10) / 10,
        wind_dir_deg: d.wind_dir,
        wind_dir_text: d.wind_dir_txt,
        temp_c: d.temp,
        cloud_cover_pct: d.cloud_cover,
        pressure_mb: d.pres,
        humidity_pct: d.relative_humidity,
        precip_type: d.precip_type,
        total_precip: d.total_precip,
      })),
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
