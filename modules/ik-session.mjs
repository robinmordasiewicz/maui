/**
 * ik-session.mjs — Shared iKitesurf session loader
 *
 * Loads the saved browser session from output/cache/ik-session.json and
 * provides an authenticated Playwright context WITHOUT logging in.
 *
 * If no session exists or the session is expired/invalid, throws an error
 * with instructions to run: node scripts/ik-auth.mjs
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = join(__dirname, '..', 'output', 'cache', 'ik-session.json');

export const SESSION_STALE_DAYS = 30; // Warn if session is older than this

/**
 * Load saved session and return { browser, context, page, token }.
 * Caller must call browser.close() when done.
 */
export async function loadSession() {
  if (!existsSync(SESSION_PATH)) {
    throw new Error(
      'No iKitesurf session found.\n' +
      'Run: node scripts/ik-auth.mjs\n' +
      'This only needs to be done once (or when the session expires).'
    );
  }

  let sessionData;
  try {
    sessionData = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to read session file: ${e.message}\nRe-run: node scripts/ik-auth.mjs`);
  }

  const token = sessionData.wf_token;
  if (!token) {
    throw new Error('Session file missing wf_token. Re-run: node scripts/ik-auth.mjs');
  }

  // Warn if session is getting old
  const savedAt = new Date(sessionData.saved_at);
  const ageDays = (Date.now() - savedAt) / (1000 * 3600 * 24);
  if (ageDays > SESSION_STALE_DAYS) {
    process.stderr.write(`  [ik-session] WARNING: session is ${Math.round(ageDays)} days old. Consider re-running ik-auth.mjs\n`);
  }

  // Launch browser with saved state (no login!)
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Restore full session state — same cookies as the original login
  const context = await browser.newContext({
    storageState: SESSION_PATH,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.117 Safari/537.36',
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Navigate to map to activate the session context (fast — no login)
  await page.goto('https://wx.ikitesurf.com/map', { waitUntil: 'load', timeout: 20000 });

  // Verify the session token is still valid
  const liveToken = await page.evaluate(() => typeof token !== 'undefined' ? token : null);
  if (!liveToken) {
    await browser.close();
    throw new Error(
      'Session token not found on map page — session may have expired.\n' +
      'Re-run: node scripts/ik-auth.mjs'
    );
  }

  return { browser, context, page, token: liveToken };
}

/**
 * Quick check: does the saved session file exist and appear valid?
 * Does NOT launch a browser. Returns { valid, reason, age_days }.
 */
export function checkSessionFile() {
  if (!existsSync(SESSION_PATH)) {
    return { valid: false, reason: 'No session file found' };
  }
  try {
    const d = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
    const ageDays = (Date.now() - new Date(d.saved_at)) / (1000 * 3600 * 24);
    const wfCookie = d.cookies?.find(c => c.name === 'wfToken');
    const expired = wfCookie?.expires && (wfCookie.expires * 1000) < Date.now();
    if (expired) return { valid: false, reason: 'wfToken cookie expired' };
    return { valid: true, age_days: Math.round(ageDays), token_prefix: d.wf_token?.substring(0, 8) };
  } catch (e) {
    return { valid: false, reason: `Parse error: ${e.message}` };
  }
}
