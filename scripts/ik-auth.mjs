#!/usr/bin/env node
/**
 * ik-auth.mjs — iKitesurf session capture from live Chrome cookies
 *
 * Instead of logging in (which triggers security alerts and creates a new
 * session token), this script reads the wfToken directly from Chrome's
 * cookie database using browser-cookie3 — the exact same session your
 * browser uses, no new login required.
 *
 * The Chrome token unlocks iK-TRRM premium model data. A fresh login via
 * Playwright gets a different token that doesn't have iK-TRRM access.
 *
 * When to run:
 *   - First-time setup
 *   - When iK-TRRM returns 0 hours (Chrome session expired/changed)
 *   - Never triggered automatically — only run manually
 *
 * Prerequisites:
 *   pip3 install browser-cookie3 --break-system-packages
 *
 * Usage:
 *   node scripts/ik-auth.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', 'output', 'cache');
const SESSION_PATH = join(CACHE_DIR, 'ik-session.json');

async function getChromeToken() {
  // Read wfToken directly from Chrome cookie database
  const result = execSync(`python3 -c "
import browser_cookie3
cookies = browser_cookie3.chrome(domain_name='.ikitesurf.com')
for c in cookies:
    if c.name == 'wfToken':
        print(c.value)
        break
"`, { encoding: 'utf-8' }).trim();
  return result || null;
}

async function getAllChromeCookies() {
  const result = execSync(`python3 -c "
import browser_cookie3, json
cookies = list(browser_cookie3.chrome(domain_name='.ikitesurf.com'))
cookies += list(browser_cookie3.chrome(domain_name='wx.ikitesurf.com'))
out = []
for c in cookies:
    out.append({'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path or '/', 'secure': bool(c.secure), 'httpOnly': False, 'sameSite': 'Lax', 'expires': int(c.expires) if c.expires else -1})
print(json.dumps(out))
"`, { encoding: 'utf-8' }).trim();
  return JSON.parse(result);
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  console.log('ik-auth: reading Chrome cookies for ikitesurf.com...');
  let chromeCookies, chromeToken;
  try {
    chromeCookies = await getAllChromeCookies();
    chromeToken = chromeCookies.find(c => c.name === 'wfToken')?.value;
  } catch (e) {
    console.error('ik-auth: ERROR — could not read Chrome cookies:', e.message);
    console.error('  Make sure Chrome is running and you are logged into ikitesurf.com');
    console.error('  Also: pip3 install browser-cookie3 --break-system-packages');
    process.exit(1);
  }

  if (!chromeToken) {
    console.error('ik-auth: ERROR — wfToken not found in Chrome cookies.');
    console.error('  Make sure you are logged into ikitesurf.com in Chrome.');
    process.exit(1);
  }

  console.log(`ik-auth: found Chrome wfToken = ${chromeToken.substring(0, 8)}...`);

  // Launch Playwright with Chrome cookies injected
  console.log('ik-auth: launching browser with Chrome session...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.117 Safari/537.36',
  });

  await context.addCookies(chromeCookies);

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Navigate to map to activate session
  console.log('ik-auth: activating session on wx.ikitesurf.com...');
  await page.goto('https://wx.ikitesurf.com/map', { waitUntil: 'load', timeout: 20000 });

  const liveToken = await page.evaluate(() => typeof token !== 'undefined' ? token : null);
  if (!liveToken) {
    console.error('ik-auth: ERROR — token not found on map page. Chrome session may be expired.');
    console.error('  Log back into ikitesurf.com in Chrome and re-run.');
    await browser.close();
    process.exit(1);
  }

  // Verify iK-TRRM access
  console.log('ik-auth: verifying iK-TRRM access...');
  const trrmData = await page.evaluate(async (t) => {
    const r = await fetch(`https://api.weatherflow.com/wxengine/rest/model/getModelDataBySpot?spot_id=166192&model_id=-7&units_wind=kts&units_temp=c&wf_token=${t}`);
    return r.json();
  }, liveToken);

  const trrmHours = trrmData.model_data?.length ?? 0;
  if (trrmHours > 0) {
    console.log(`ik-auth: iK-TRRM verified — ${trrmHours} hours available`);
    const session = trrmData.model_data.find(f => parseInt((f.model_time_local||'').substring(11,13)) >= 12);
    if (session) console.log(`ik-auth: first session hour: ${session.model_time_local?.substring(11,16)} avg=${session.wind_speed?.toFixed(1)}kts gust=${session.wind_gust?.toFixed(1)}kts`);
  } else {
    console.warn(`ik-auth: WARNING — iK-TRRM has 0 hours. Model may not be running (calm conditions or model gap).`);
    console.warn(`ik-auth: premium: ${trrmData.is_premium} | graphDataExists: ${trrmData.graphDataExists}`);
  }

  // Verify obs access
  const obsData = await page.evaluate(async (t) => {
    const r = await fetch(`https://api.weatherflow.com/wxengine/rest/spot/getSpotDetailSetByList?spot_list=166192&units_wind=kts&units_temp=c&wf_token=${t}`);
    return r.json();
  }, liveToken);
  const stations = obsData?.spots?.[0]?.stations?.[0];
  const vals = stations?.data_values?.[0];
  const names = obsData?.spots?.[0]?.data_names || [];
  const avg  = vals?.[names.indexOf('avg')];
  const gust = vals?.[names.indexOf('gust')];
  if (avg != null) {
    console.log(`ik-auth: live obs — Kanaha ${avg}kts avg / ${gust}kts gust`);
  } else {
    console.warn(`ik-auth: obs: ${stations?.status_message}`);
  }

  // Save complete session state
  const state = await context.storageState();
  const sessionData = {
    ...state,
    wf_token: liveToken,
    saved_at: new Date().toISOString(),
    saved_by: 'ik-auth.mjs (chrome-cookie-import)',
    source: 'chrome',
  };

  writeFileSync(SESSION_PATH, JSON.stringify(sessionData, null, 2));
  console.log(`ik-auth: session saved → ${SESSION_PATH}`);
  console.log(`ik-auth: wf_token = ${liveToken.substring(0, 8)}...`);

  const wfCookie = state.cookies?.find(c => c.name === 'wfToken');
  if (wfCookie?.expires) {
    const exp = new Date(wfCookie.expires * 1000);
    console.log(`ik-auth: wfToken expires ${exp.toISOString()} (${Math.round((exp - Date.now()) / (1000 * 3600 * 24))} days)`);
  }

  await browser.close();
  console.log('ik-auth: done.');
  console.log('');
  console.log('Session imported from Chrome. No login was performed.');
  console.log('Re-run when iK-TRRM stops returning data (Chrome session changed).');
}

main().catch(err => {
  console.error('ik-auth FATAL:', err.message);
  process.exit(1);
});
