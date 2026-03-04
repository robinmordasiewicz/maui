#!/usr/bin/env node
/**
 * ik-auth.mjs — One-time iKitesurf session authentication
 *
 * Logs in via Playwright and saves the full browser session state
 * (cookies + localStorage) to output/cache/ik-session.json.
 *
 * Subsequent API calls in wind-prediction.mjs and wind-iktrrm.mjs
 * RESTORE this session instead of logging in — no new session is created,
 * so iKitesurf sees only one active session per account at all times.
 *
 * When to run:
 *   - First-time setup
 *   - When API calls start returning 401 (session expired)
 *   - Cron at 03:00 HST nightly (user is asleep, no browser conflict)
 *
 * Usage:
 *   node scripts/ik-auth.mjs
 *   IK_USER=user@example.com IK_PASS=password node scripts/ik-auth.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', 'output', 'cache');
const SESSION_PATH = join(CACHE_DIR, 'ik-session.json');

const IK_USER = process.env.IK_USER || 'robin@mordasiewicz.com';
const IK_PASS = process.env.IK_PASS || 'mum5th3w0rd';

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  console.log('ik-auth: launching browser...');
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
  console.log('ik-auth: navigating to login...');
  await page.goto('https://secure.ikitesurf.com/?app=wx&rd=login', { waitUntil: 'networkidle' });
  await page.fill('#login-username', IK_USER);
  await page.fill('#login-password', IK_PASS);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
    page.click('input[name="iwok.x"]'),
  ]);

  // Navigate to the map page to fully establish the premium session
  if (!page.url().includes('wx.ikitesurf.com')) {
    await page.goto('https://wx.ikitesurf.com/map', { waitUntil: 'load', timeout: 20000 });
  }

  // Verify we're logged in and have the token
  const token = await page.evaluate(() => typeof token !== 'undefined' ? token : null);
  if (!token) {
    console.error('ik-auth: ERROR — could not extract wf_token. Login may have failed.');
    await browser.close();
    process.exit(1);
  }

  // Verify premium data is accessible
  console.log('ik-auth: verifying premium data access...');
  const testData = await page.evaluate(async (t) => {
    const url = `https://api.weatherflow.com/wxengine/rest/spot/getSpotDetailSetByList?spot_list=166192&units_wind=kts&units_temp=c&wf_token=${t}`;
    const r = await fetch(url);
    return r.json();
  }, token);

  const spot = testData?.spots?.[0];
  const stations = spot?.stations?.[0];
  const hasWind = stations?.data_values?.[0]?.[2] != null; // avg field

  if (!hasWind) {
    const msg = stations?.status_message || 'unknown';
    console.warn(`ik-auth: WARNING — wind data not available: "${msg}"`);
    console.warn('ik-auth: Saving session anyway (data may be temporarily unavailable).');
  } else {
    const avg = stations.data_values[0][2];
    const gust = stations.data_values[0][4];
    console.log(`ik-auth: verified — Kanaha reading ${avg}kts avg / ${gust}kts gust`);
  }

  // Save complete session state (all cookies + localStorage)
  const state = await context.storageState();
  const sessionData = {
    ...state,
    wf_token: token,
    saved_at: new Date().toISOString(),
    saved_by: 'ik-auth.mjs',
    account: IK_USER,
  };

  writeFileSync(SESSION_PATH, JSON.stringify(sessionData, null, 2));
  console.log(`ik-auth: session saved → ${SESSION_PATH}`);
  console.log(`ik-auth: wf_token = ${token.substring(0, 8)}...`);

  // Print cookie expiry info
  const wfCookie = state.cookies?.find(c => c.name === 'wfToken');
  if (wfCookie?.expires) {
    const exp = new Date(wfCookie.expires * 1000);
    console.log(`ik-auth: wfToken expires ${exp.toISOString()} (${Math.round((exp - Date.now()) / (1000 * 3600 * 24))} days)`);
  }

  await browser.close();
  console.log('ik-auth: done. Playwright session closed.');
  console.log('');
  console.log('All subsequent API calls will reuse this session without logging in.');
  console.log('Re-run this script if wind-prediction or wind-iktrrm return 401 errors.');
}

main().catch(err => {
  console.error('ik-auth FATAL:', err.message);
  process.exit(1);
});
