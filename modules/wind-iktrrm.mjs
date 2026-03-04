#!/usr/bin/env node
/**
 * wind-iktrrm.mjs — iK-TRRM premium wind forecast for Kanaha via WeatherFlow
 *
 * Uses getModelDataBySpot API which returns hourly forecast data including
 * wind_speed, wind_gust, wind_dir, temp, cloud_cover, pressure, humidity.
 *
 * This is the SAME data the iKitesurf website graph displays.
 *
 * Usage: node wind-iktrrm.mjs
 * Env:   IK_USER, IK_PASS
 */
import { chromium } from 'playwright';

const SPOT_ID = 166192;
const MODEL_ID = -7; // iK-TRRM premium model
const IK_USER = process.env.IK_USER || 'robin@mordasiewicz.com';
const IK_PASS = process.env.IK_PASS || 'mum5th3w0rd';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.117 Safari/537.36',
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Login
  process.stderr.write('wind-iktrrm: logging in... ');
  await page.goto('https://secure.ikitesurf.com/?app=wx&rd=login', { waitUntil: 'networkidle' });
  await page.fill('#login-username', IK_USER);
  await page.fill('#login-password', IK_PASS);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
    page.click('input[name="iwok.x"]'),
  ]);
  process.stderr.write('done\n');

  // Fetch model forecast data
  process.stderr.write('wind-iktrrm: fetching iK-TRRM forecast... ');
  const data = await page.evaluate(async ({ spotId, modelId }) => {
    const t = typeof token !== 'undefined' ? token : '';
    const url =
      `https://api.weatherflow.com/wxengine/rest/model/getModelDataBySpot` +
      `?spot_id=${spotId}&model_id=${modelId}` +
      `&units_wind=kts&units_temp=c&units_distance=km&units_precip=in` +
      `&wf_token=${t}`;
    const r = await fetch(url);
    return r.json();
  }, { spotId: SPOT_ID, modelId: MODEL_ID });

  if (data.status?.status_code && data.status.status_code !== 0) {
    process.stderr.write(`ERROR: ${JSON.stringify(data.status)}\n`);
    await browser.close();
    process.exit(1);
  }

  const modelData = data.model_data || [];
  process.stderr.write(`done (${modelData.length} hours)\n`);

  // Also get current observation
  const obsData = await page.evaluate(async ({ spotId }) => {
    const t = typeof token !== 'undefined' ? token : '';
    const url =
      `https://api.weatherflow.com/wxengine/rest/spot/getSpotDetailSetByList` +
      `?spot_id=${spotId}&units_wind=kts&units_temp=c&units_distance=km` +
      `&wf_token=${t}`;
    const r = await fetch(url);
    return r.json();
  }, { spotId: SPOT_ID });

  const spot = obsData?.spots?.[0];
  const current = spot ? {
    avg_kts: spot.avg != null ? Math.round(spot.avg * 10) / 10 : null,
    gust_kts: spot.gust != null ? Math.round(spot.gust * 10) / 10 : null,
    lull_kts: spot.lull != null ? Math.round(spot.lull * 10) / 10 : null,
    dir_deg: spot.dir,
    dir_text: spot.dir_text,
    temp_c: spot.temp != null ? Math.round(spot.temp * 10) / 10 : null,
    wind_desc: spot.wind_desc,
  } : null;

  await browser.close();

  // Build output
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
    forecast: modelData.map(d => ({
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
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
