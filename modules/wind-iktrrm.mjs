#!/usr/bin/env node
/**
 * wind-iktrrm.mjs — iK-TRRM wind forecast for Kanaha via WeatherFlow
 *
 * Usage: node wind-iktrrm.mjs [hours_ahead]    (default: 48)
 * Env:   IK_USER, IK_PASS
 */
import { chromium } from 'playwright';

const SPOT_ID = 166192;
const MODEL_ID = -7;
const HOURS = parseInt(process.argv[2] || '48');
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

  if (!page.url().includes('wx.ikitesurf.com')) {
    await page.goto('https://wx.ikitesurf.com/map', { waitUntil: 'load', timeout: 20000 });
  }
  process.stderr.write('done\n');

  // Fetch forecast
  process.stderr.write(`wind-iktrrm: fetching ${HOURS}h forecast... `);
  const data = await page.evaluate(async ({ spotId, modelId, hours }) => {
    const t = typeof token !== 'undefined' ? token : '';
    const url =
      `https://api.weatherflow.com/wxengine/rest/graph/getGraph` +
      `?spot_id=${spotId}&model_ids=${modelId}` +
      `&fields=wind&format=json&type=dataonly` +
      `&null_ob_min_from_now=30&show_virtual_obs=true` +
      `&time_start_offset_hours=-4&time_end_offset_hours=${hours}` +
      `&units_wind=kts&units_temp=c&units_distance=km&units_precip=in` +
      `&wf_token=${t}`;
    const r = await fetch(url);
    return r.json();
  }, { spotId: SPOT_ID, modelId: MODEL_ID, hours: HOURS });

  if (data.status?.status_code && data.status.status_code !== 0) {
    process.stderr.write(`ERROR: ${JSON.stringify(data.status)}\n`);
    await browser.close();
    process.exit(1);
  }
  process.stderr.write('done\n');

  const output = {
    source: 'wind-iktrrm',
    location: 'Kanaha, Maui HI',
    spot_id: SPOT_ID,
    model: 'iK-TRRM',
    model_id: MODEL_ID,
    fetched_utc: new Date().toISOString(),
    hours_ahead: HOURS,
    units: { wind: 'kts', temp: 'c', pressure: 'mb' },
    current: {
      wind_desc: data.last_ob_wind_desc,
      avg_kts: data.last_ob_avg != null ? Math.round(data.last_ob_avg * 10) / 10 : null,
      gust_kts: data.last_ob_gust != null ? Math.round(data.last_ob_gust * 10) / 10 : null,
      lull_kts: data.last_ob_lull != null ? Math.round(data.last_ob_lull * 10) / 10 : null,
      dir_deg: data.last_ob_dir,
      dir_text: data.last_ob_dir_txt,
      temp_c: data.last_ob_temp != null ? Math.round(data.last_ob_temp * 10) / 10 : null,
      pressure_mb: data.last_ob_pres,
    },
    forecast: (data.wind_avg_data || [])
      .filter(p => p[1] !== null)
      .map((p, i) => ({
        time_utc: new Date(p[0]).toISOString(),
        wind_avg_kts: Math.round(p[1] * 10) / 10,
        wind_gust_kts: data.wind_gust_data?.[i]?.[1] ? Math.round(data.wind_gust_data[i][1] * 10) / 10 : null,
        wind_lull_kts: data.wind_lull_data?.[i]?.[1] ? Math.round(data.wind_lull_data[i][1] * 10) / 10 : null,
        wind_dir_deg: data.wind_dir_data?.[i]?.[1] ? Math.round(data.wind_dir_data[i][1]) : null,
      })),
  };

  console.log(JSON.stringify(output, null, 2));
  await browser.close();
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
