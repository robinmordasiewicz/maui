#!/usr/bin/env node
/**
 * alerts-nws.mjs — Active NWS weather & marine alerts for Maui
 *
 * Checks all relevant NWS zones covering Maui land and waters:
 *   HIZ011 — Maui County (land, windward/leeward)
 *   HIC003 — Maui County (civil/county zone)
 *   PHZ117 — Maui County Windward Waters
 *   PHZ118 — Maalaea Bay
 *   PHZ119 — Pailolo Channel
 *   PHZ120 — Alenuihaha Channel
 *
 * Alert severity levels: Extreme > Severe > Moderate > Minor
 * Alert types relevant to kiting/watersports:
 *   - Small Craft Advisory (25kts+)
 *   - Gale Warning (34kts+)
 *   - Storm Warning (48kts+)
 *   - High Surf Advisory / Warning
 *   - Flash Flood Watch/Warning
 *   - Wind Advisory
 *
 * Usage: node alerts-nws.mjs
 */

const ZONES = [
  'HIZ011', // Maui County land
  'HIC003', // Maui County civil
  'PHZ117', // Maui Windward Waters
  'PHZ118', // Maalaea Bay
  'PHZ119', // Pailolo Channel
  'PHZ120', // Alenuihaha Channel
].join(',');

const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

// Alert events relevant to kiting/watersports — higher = more impactful
const RELEVANCE = {
  'Storm Warning':            10,
  'Gale Warning':              9,
  'High Surf Warning':         8,
  'Small Craft Advisory':      7,
  'High Surf Advisory':        6,
  'Wind Advisory':             5,
  'Flash Flood Warning':       5,
  'Flash Flood Watch':         4,
  'Flood Advisory':            3,
  'Dense Fog Advisory':        3,
  'Special Marine Warning':    8,
  'Tropical Storm Warning':   10,
  'Hurricane Warning':        10,
};

async function main() {
  process.stderr.write('alerts-nws: fetching active alerts... ');
  const url = `https://api.weather.gov/alerts/active?zone=${ZONES}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'maui-wx/1.0' } });
  if (!r.ok) throw new Error(`NWS alerts HTTP ${r.status}`);
  const data = await r.json();
  process.stderr.write('done\n');

  const alerts = (data.features || []).map(f => {
    const p = f.properties;
    return {
      id:          p.id,
      event:       p.event,
      severity:    p.severity,
      urgency:     p.urgency,
      certainty:   p.certainty,
      headline:    p.headline,
      description: p.description?.replace(/\n+/g, ' ').trim().substring(0, 500),
      instruction: p.instruction?.replace(/\n+/g, ' ').trim().substring(0, 300) || null,
      areas:       p.areaDesc,
      onset:       p.onset,
      expires:     p.expires,
      ends:        p.ends,
      sender:      p.senderName,
      relevance:   RELEVANCE[p.event] || 1,
      severity_rank: SEVERITY_RANK[p.severity] || 0,
    };
  }).sort((a, b) => b.relevance - a.relevance || b.severity_rank - a.severity_rank);

  // Identify highest-impact alert
  const topAlert = alerts[0] || null;
  const hasMarine = alerts.some(a => a.areas?.includes('Waters') || a.areas?.includes('Channel') || a.areas?.includes('Bay'));
  const hasSmallCraft = alerts.some(a => a.event === 'Small Craft Advisory');
  const hasGale = alerts.some(a => a.event === 'Gale Warning');
  const hasHighSurf = alerts.some(a => a.event?.includes('High Surf'));

  const output = {
    source:      'alerts-nws',
    location:    'Maui County, HI',
    zones:       ZONES.split(','),
    fetched_utc: new Date().toISOString(),
    alert_count: alerts.length,
    has_marine_alert:      hasMarine,
    has_small_craft:       hasSmallCraft,
    has_gale_warning:      hasGale,
    has_high_surf:         hasHighSurf,
    top_alert:             topAlert,
    alerts,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
