#!/usr/bin/env node
/**
 * generate-forecast.mjs — Generate a blog-style forecast post from report JSON
 *
 * Reads kanaha-report JSON (stdin or --file), calls Anthropic API to generate
 * a natural-language forecast blog post, outputs Astro-compatible markdown.
 *
 * Usage:
 *   node kanaha-report.mjs --json | node scripts/generate-forecast.mjs
 *   node scripts/generate-forecast.mjs --file output/latest.json
 *
 * Env:
 *   ANTHROPIC_API_KEY — required
 *
 * Outputs: writes to site/src/content/blog/YYYY-MM-DD.md
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BLOG_DIR = join(ROOT, 'site', 'src', 'content', 'blog');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
}

// ── Read report JSON ─────────────────────────────────────────────────
let reportJson;
const fileArg = process.argv.indexOf('--file');
if (fileArg !== -1 && process.argv[fileArg + 1]) {
  reportJson = readFileSync(process.argv[fileArg + 1], 'utf-8');
} else {
  // Read from stdin
  reportJson = readFileSync('/dev/stdin', 'utf-8');
}

const report = JSON.parse(reportJson);

// ── Read CONTEXT.md for domain knowledge ─────────────────────────────
const context = readFileSync(join(ROOT, 'CONTEXT.md'), 'utf-8');

// ── Date + forecast mode ─────────────────────────────────────────────
const now = new Date();
const hstHour = parseInt(now.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', hour12: false }));
const todayHST = now.toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 10);

// After 3pm HST = next-day forecast; before = same-day
const isNextDay = hstHour >= 15;
const targetDate = isNextDay ? (() => {
  const d = new Date(now); d.setDate(d.getDate() + 1);
  return d.toLocaleString('en-CA', { timeZone: 'Pacific/Honolulu' }).substring(0, 10);
})() : todayHST;

const forecastType = isNextDay ? 'tomorrow' : 'today';
const suffix = isNextDay ? '-preview' : '';
const dateHST = targetDate;

const timeHST = now.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', hour: 'numeric', minute: '2-digit', hour12: true });
const targetDateObj = new Date(targetDate + 'T12:00:00-10:00');
const dayName = targetDateObj.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', weekday: 'long' });
const monthDay = targetDateObj.toLocaleString('en-US', { timeZone: 'Pacific/Honolulu', month: 'long', day: 'numeric', year: 'numeric' });

// ── Build LLM prompt ─────────────────────────────────────────────────
const systemPrompt = `You are a watersport forecast writer for Kanaha Beach Park, Maui. You write daily forecasts for kite foilboarders, windsurfers, and foilers.

Your style:
- Conversational but informative, like a knowledgeable local sharing the daily report
- Lead with the verdict — should people go to the beach or not?
- Focus on actionable information: what equipment to bring, when to go, what to watch for
- Include specific numbers (wind speed, tide, swell) but make them accessible
- Mention safety considerations when relevant (reef depth, big swell, gustiness)
- Keep it concise — 300-500 words
- Use emojis sparingly for visual scanning (🪁 🌊 🏄 💨 ⚠️)
- End with a "Bottom Line" one-liner

Domain knowledge:
${context}`;

const forecastFraming = isNextDay
  ? `This is an EVENING PREVIEW forecast for TOMORROW (${dayName}, ${monthDay}), generated at ${timeHST} HST the night before. Current sensor data shows what's happening right now — use it to extrapolate tomorrow's likely conditions. Focus on what to expect, what equipment to prepare, and whether it's worth planning around. Be clear this is a preview and conditions may change overnight.`
  : `This is a SAME-DAY forecast for TODAY (${dayName}, ${monthDay}), generated at ${timeHST} HST with live sensor data. This should be as accurate as possible — the data is real-time. Be specific about current conditions, what's happening right now, and what the rest of the session window looks like. This is the "should I go NOW?" forecast.`;

const userPrompt = `Write a Kanaha forecast blog post based on this data:

${JSON.stringify(report, null, 2)}

${forecastFraming}

Write the forecast as a blog post. Include:
1. Overall verdict and best activity
2. Wind conditions and prediction through the day
3. Thermal/regime analysis (what kind of wind day is it?)
4. Wave conditions (windswell for foiling, any groundswell?)
5. Equipment recommendation (mast, kite, wings, lines, board)
6. Session window recommendation (when to go, when to come in)
7. Any alerts or things to watch for

Output ONLY the markdown body (no frontmatter — I'll add that). Start with an engaging opening line.`;

// ── Call Anthropic API ───────────────────────────────────────────────
function callAnthropic(system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.content?.[0]?.text) resolve(j.content[0].text);
          else reject(new Error('API error: ' + data.substring(0, 200)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Generate and write ───────────────────────────────────────────────
async function main() {
  process.stderr.write(`Generating forecast for ${dateHST}...\n`);

  const body = await callAnthropic(systemPrompt, userPrompt);

  // Build frontmatter
  const verdict = report.verdict || '🏖️ Kanaha Forecast';
  const typeLabel = isNextDay ? 'Preview' : 'Live';
  const title = `${monthDay} ${typeLabel} — ${verdict.replace(/[🟢🟡🔴]\s*/, '')}`;
  const description = report.analysis?.session_advice?.[0] || 'Daily Kanaha watersport forecast';

  const post = `---
title: '${title.replace(/'/g, "''")}'
description: '${description.replace(/'/g, "''")}'
pubDate: '${new Date().toISOString()}'
---

${body}
`;

  mkdirSync(BLOG_DIR, { recursive: true });
  const outPath = join(BLOG_DIR, `${dateHST}${suffix}.md`);
  writeFileSync(outPath, post);
  process.stderr.write(`Written: ${outPath}\n`);
  console.log(outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
