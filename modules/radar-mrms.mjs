#!/usr/bin/env node
/**
 * radar-mrms.mjs — NOAA MRMS wide-area radar for Maui
 *
 * Fetches current radar reflectivity at Kanaha and a Maui-area radar
 * image URL from the NOAA MRMS MapServer (ArcGIS REST).
 *
 * Triggered when rain_risk >= moderate. No GDAL required — uses the
 * ArcGIS identify endpoint for point dBZ and the export endpoint for
 * a PNG image URL covering the Maui area.
 *
 * Usage: node radar-mrms.mjs
 */
import https from 'https';

// Kanaha grid point
const LAT = 20.896;
const LON = -156.452;

// Maui bounding box for radar image (lon_min, lat_min, lon_max, lat_max)
const BBOX = '-157.4,20.4,-155.8,21.2';
const IMG_W = 800;
const IMG_H = 450;

// NOAA MRMS ArcGIS REST MapServer
const BASE = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity/MapServer';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'maui-wx/1.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// dBZ → intensity label
function dbzLabel(dbz) {
  if (dbz == null || dbz < 5)  return 'none';
  if (dbz < 20) return 'light';       // trace / drizzle
  if (dbz < 30) return 'moderate';    // light rain showers
  if (dbz < 40) return 'heavy';       // moderate-heavy rain
  if (dbz < 50) return 'intense';     // heavy rain, possible hail
  return 'extreme';                   // severe / hail
}

// dBZ → estimated rain rate mm/hr (Z-R Marshall-Palmer)
function dbzToRainRate(dbz) {
  if (dbz == null || dbz < 5) return 0;
  const z = Math.pow(10, dbz / 10);
  const r = Math.pow(z / 200, 1 / 1.6);
  return Math.round(r * 10) / 10;
}

async function main() {
  process.stderr.write('radar-mrms: fetching MRMS radar data... ');

  // Build identify URL — point query for reflectivity at Kanaha
  const identifyUrl = `${BASE}/identify?` + new URLSearchParams({
    geometry: `${LON},${LAT}`,
    geometryType: 'esriGeometryPoint',
    sr: '4326',
    layers: 'all',
    tolerance: '3',
    mapExtent: `${LON - 0.5},${LAT - 0.5},${LON + 0.5},${LAT + 0.5}`,
    imageDisplay: '400,400,96',
    returnGeometry: 'false',
    f: 'json',
  });

  // Build export PNG URL (we return the URL, not the image — caller can render or display)
  const exportUrl = `${BASE}/export?` + new URLSearchParams({
    bbox: BBOX,
    bboxSR: '4326',
    size: `${IMG_W},${IMG_H}`,
    imageSR: '4326',
    format: 'png',
    transparent: 'true',
    f: 'image',
  });

  let dbz = null;
  let identifyResults = [];

  try {
    const id = await fetchJSON(identifyUrl);
    identifyResults = id.results || [];
    // Extract the pixel value — MRMS services return value in attributes
    for (const r of identifyResults) {
      const val = r.attributes?.['Pixel Value'] ?? r.attributes?.value ?? r.value;
      if (val != null && !isNaN(parseFloat(val))) {
        const parsed = parseFloat(val);
        // MRMS dBZ range: typically -32 to 95. Values like 0 from no-echo = no rain.
        if (parsed > 5) { dbz = parsed; break; }
      }
    }
  } catch (e) {
    process.stderr.write(`identify failed: ${e.message} `);
  }

  process.stderr.write('done\n');

  const intensity = dbzLabel(dbz);
  const rainRate = dbzToRainRate(dbz);

  // Storm presence: check if nearby cells are intense (Maui-wide threat)
  // We do a second identify with a wider tolerance to catch nearby cells
  let nearbyThreat = false;
  let nearbyDbz = null;
  try {
    const wideUrl = `${BASE}/identify?` + new URLSearchParams({
      geometry: `${LON},${LAT}`,
      geometryType: 'esriGeometryPoint',
      sr: '4326',
      layers: 'all',
      tolerance: '20',
      mapExtent: `${LON - 1},${LAT - 1},${LON + 1},${LAT + 1}`,
      imageDisplay: '400,400,96',
      returnGeometry: 'false',
      f: 'json',
    });
    const wide = await fetchJSON(wideUrl);
    for (const r of (wide.results || [])) {
      const val = parseFloat(r.attributes?.['Pixel Value'] ?? r.attributes?.value ?? r.value);
      if (!isNaN(val) && val > (nearbyDbz || 0)) nearbyDbz = val;
    }
    if (nearbyDbz >= 35) nearbyThreat = true;
  } catch { /* ignore */ }

  const output = {
    source: 'radar-mrms',
    fetched_utc: new Date().toISOString(),
    location: 'Kanaha, Maui HI',

    kanaha: {
      reflectivity_dbz: dbz,
      intensity: intensity,
      rain_rate_mmhr: rainRate,
      active_precipitation: intensity !== 'none',
    },

    maui_wide: {
      max_nearby_dbz: nearbyDbz,
      nearby_threat: nearbyThreat,
      threat_label: dbzLabel(nearbyDbz),
    },

    // Radar image URL — PNG of Maui bbox, suitable for display/browser
    radar_image_url: exportUrl,
    radar_image_bbox: BBOX,

    // Source info
    source_info: {
      product: 'MRMS Base Reflectivity (Quality Controlled)',
      update_freq: 'Every 5 minutes',
      coverage: 'Hawaii multi-radar composite',
      url: BASE,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => { process.stderr.write(`FATAL: ${err.message}\n`); process.exit(1); });
