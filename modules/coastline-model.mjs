#!/usr/bin/env node
/**
 * coastline-model.mjs — Kanaha Beach geographic & wind analysis model
 *
 * Defines the coastline geometry, wind angle classification, fetch distances,
 * terrain obstacles, and produces deterministic condition assessments from
 * wind/wave input data.
 *
 * Usage:
 *   node coastline-model.mjs                         # dump model as JSON
 *   node coastline-model.mjs --analyze <wind.json>   # analyze against wind data
 *   node coastline-model.mjs --wind-deg 65 --wind-kts 20 --gust-kts 27 --wave-m 2.0 --wave-dir 330 --wave-period 13
 */

// ============================================================
// COASTLINE GEOMETRY
// ============================================================
// Kanaha Beach Park coastline traced from satellite imagery.
// Points ordered west to east along the waterline.
// Each segment has a "shore normal" — the compass bearing pointing
// directly offshore (perpendicular to the beach, toward open water).

const COASTLINE_SEGMENTS = [
  {
    name: 'Kanaha West (Kahului Harbor side)',
    from: { lat: 20.8952, lon: -156.4680 },
    to:   { lat: 20.8975, lon: -156.4620 },
    shore_bearing_deg: 285,  // coastline runs ~ESE-WNW, shore faces ~WNW
    shore_normal_deg: 345,   // offshore direction (perpendicular out to sea)
    notes: 'Westernmost section, partially sheltered by harbor breakwall',
  },
  {
    name: 'Kanaha Central (Main beach / Lifeguard tower)',
    from: { lat: 20.8975, lon: -156.4620 },
    to:   { lat: 20.8995, lon: -156.4530 },
    shore_bearing_deg: 295,  // coastline runs roughly WNW-ESE
    shore_normal_deg: 25,    // shore faces NNE
    notes: 'Main swimming area, lifeguard station. Reef-protected inner lagoon.',
  },
  {
    name: 'Kanaha Kite Beach (Primary kite/windsurf launch)',
    from: { lat: 20.8995, lon: -156.4530 },
    to:   { lat: 20.9010, lon: -156.4470 },
    shore_bearing_deg: 300,  // coastline runs WNW-ESE
    shore_normal_deg: 30,    // shore faces NNE
    notes: 'Primary kite launch. Open fetch to NE. Reef gap for entry/exit.',
  },
  {
    name: "Ka'a Point",
    from: { lat: 20.9010, lon: -156.4470 },
    to:   { lat: 20.9020, lon: -156.4430 },
    shore_bearing_deg: 315,  // point juts out, coastline turns more northward
    shore_normal_deg: 45,    // shore faces NE
    notes: "Rocky point. Separates Kanaha from Spreckelsville. Advanced sailing area.",
  },
  {
    name: 'Kite Beach East / Lowers',
    from: { lat: 20.9020, lon: -156.4430 },
    to:   { lat: 20.9050, lon: -156.4370 },
    shore_bearing_deg: 320,  // coastline bends more NW-SE
    shore_normal_deg: 50,    // shore faces NE
    notes: 'Lowers break. More wave exposure. Experienced riders.',
  },
  {
    name: 'Upper Kanaha / Kooks',
    from: { lat: 20.9050, lon: -156.4370 },
    to:   { lat: 20.9070, lon: -156.4350 },
    shore_bearing_deg: 330,  // coastline almost N-S here
    shore_normal_deg: 60,    // shore faces ENE
    notes: 'Kooks break. Full north swell exposure. Windsurfer launch area.',
  },
];

// ============================================================
// PRIMARY RIDING ZONE (Kite Beach segment)
// Used as the default reference for wind angle calculations
// ============================================================
const PRIMARY_ZONE = COASTLINE_SEGMENTS[2]; // Kite Beach
const PRIMARY_SHORE_NORMAL = PRIMARY_ZONE.shore_normal_deg; // 30° (NNE)

// ============================================================
// WIND ANGLE CLASSIFICATION
// ============================================================
// The "wind angle" is the angle between the wind direction (FROM)
// and the shore normal (outward perpendicular).
//
// Convention: wind_from_deg is meteorological (where wind comes FROM).
// A wind angle of 0° = wind blowing directly offshore (from land to sea)
// A wind angle of 180° = wind blowing directly onshore (from sea to land)
//
// For kitesurfing/windsurfing, the ideal is ~90° (cross-shore) or
// ~110-130° (cross-onshore from the right for right-of-way sailing).

function normalizeAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

function angleDiff(a, b) {
  let d = normalizeAngle(a - b);
  return d > 180 ? d - 360 : d;
}

/**
 * Compute the wind angle relative to the shore.
 * Returns -180 to +180 where:
 *   0 = directly onshore (wind FROM the same bearing as shore normal)
 *  +90 = cross-shore from the right (looking out to sea)
 *  -90 = cross-shore from the left
 * +180/-180 = directly offshore
 *
 * For Kanaha Kite Beach (shore normal 30° NNE):
 *   Wind FROM 30° (NNE) = 0° = direct onshore
 *   Wind FROM 65° (ENE) = +35° = cross-onshore right (IDEAL for kiting)
 *   Wind FROM 120° (ESE) = +90° = cross-shore right (over airport)
 *   Wind FROM 210° (SSW) = +180° = offshore (Kona wind)
 */
function windAngle(windFromDeg, shoreNormalDeg) {
  return angleDiff(windFromDeg, shoreNormalDeg);
}

const WIND_CLASSIFICATIONS = [
  // 0° = direct onshore, ±180° = offshore
  // Positive = from the right looking out to sea, Negative = from the left
  { min: -15,  max: 15,   label: 'direct onshore',      code: 'ON',    quality: 'challenging', emoji: '🟠', desc: 'Wind blowing straight onshore. Difficult launching, shore break issues. Chop aligns with swell.' },
  { min: 15,   max: 45,   label: 'cross-onshore right', code: 'XON-R', quality: 'excellent',  emoji: '🟢', desc: 'IDEAL for kite/windsurf at Kanaha. Classic NE trades direction. Clean over-water fetch, natural safety (pushes to shore), good upwind angle.' },
  { min: -45,  max: -15,  label: 'cross-onshore left',  code: 'XON-L', quality: 'good',       emoji: '🟢', desc: 'Cross-onshore from left. Decent conditions, wind has ocean fetch.' },
  { min: 45,   max: 75,   label: 'side-shore right',    code: 'XSH-R', quality: 'good',       emoji: '🟡', desc: 'Side-shore from right. Clean wind if fetch is adequate. More easterly = closer to airport turbulence zone.' },
  { min: -75,  max: -45,  label: 'side-shore left',     code: 'XSH-L', quality: 'good',       emoji: '🟡', desc: 'Side-shore from left. Northerly component. Clean if no terrain shadow.' },
  { min: 75,   max: 110,  label: 'cross-offshore right', code: 'XOF-R', quality: 'marginal',  emoji: '🟠', desc: 'Mostly offshore with cross component. Wind passes over land/airport. Turbulent, gusty, shadowed.' },
  { min: -110, max: -75,  label: 'cross-offshore left',  code: 'XOF-L', quality: 'marginal',  emoji: '🟠', desc: 'Cross-offshore from left (westerly). Wind over West Maui terrain or harbor.' },
  { min: 110,  max: 150,  label: 'offshore right',      code: 'OFF-R', quality: 'poor',       emoji: '🔴', desc: 'Offshore from SE. Wind from land. Pushes riders out to sea. Gusty and dangerous.' },
  { min: -150, max: -110, label: 'offshore left',       code: 'OFF-L', quality: 'poor',       emoji: '🔴', desc: 'Offshore from W/SW. Kona wind direction. Terrain-disrupted, pushes riders out.' },
  { min: 150,  max: 180,  label: 'direct offshore',     code: 'OFF',   quality: 'poor',       emoji: '🔴', desc: 'Wind blowing from land to sea. DANGEROUS — pushes riders out. Maximum terrain turbulence.' },
  { min: -180, max: -150, label: 'direct offshore',     code: 'OFF',   quality: 'poor',       emoji: '🔴', desc: 'Wind blowing from land to sea. DANGEROUS.' },
];

function classifyWindAngle(angle) {
  for (const c of WIND_CLASSIFICATIONS) {
    if (angle >= c.min && angle < c.max) return c;
  }
  return WIND_CLASSIFICATIONS[0]; // fallback
}

// ============================================================
// FETCH DISTANCE MODEL
// ============================================================
// Over-water fetch determines wind quality (longer = smoother, laminar).
// Modeled as approximate distances from Kanaha Kite Beach in each direction.

const FETCH_DISTANCES_NM = {
  0:   { nm: 0.3,   desc: 'Blocked by Kahului Harbor breakwall' },
  15:  { nm: 1.5,   desc: 'Inner Kahului Bay, short fetch' },
  30:  { nm: 5,     desc: 'Across Kahului Bay to west Maui' },
  45:  { nm: 50,    desc: 'Open ocean channel toward Molokai' },
  60:  { nm: 200,   desc: 'Open Pacific (NE trades direction)' },
  75:  { nm: 200,   desc: 'Open Pacific' },
  90:  { nm: 100,   desc: 'Open ocean, Alenuihaha Channel toward Big Island' },
  105: { nm: 15,    desc: 'Toward Hana coast / east Maui' },
  120: { nm: 5,     desc: 'East Maui coastline blocks' },
  135: { nm: 2,     desc: 'Over Spreckelsville / airport' },
  150: { nm: 1,     desc: 'Over Kahului town / airport runway' },
  165: { nm: 0.5,   desc: 'Direct over airport terminal' },
  180: { nm: 0.5,   desc: 'Over Kahului industrial / harbor' },
  195: { nm: 0.3,   desc: 'Kahului Harbor' },
  210: { nm: 0.8,   desc: 'Inner bay, West Maui Mountains create turbulence' },
  225: { nm: 1,     desc: 'West Maui Mountains, katabatic effects' },
  240: { nm: 3,     desc: 'Partial shelter from West Maui' },
  255: { nm: 5,     desc: 'Through gap between Maui mountains' },
  270: { nm: 10,    desc: 'Pailolo Channel toward Molokai' },
  285: { nm: 20,    desc: 'Pailolo Channel, open' },
  300: { nm: 50,    desc: 'Open ocean NW' },
  315: { nm: 200,   desc: 'Open Pacific NW (north swell direction)' },
  330: { nm: 200,   desc: 'Open Pacific N (primary north swell corridor)' },
  345: { nm: 200,   desc: 'Open Pacific NNW' },
};

function getFetch(dirDeg) {
  const dir = normalizeAngle(Math.round(dirDeg / 15) * 15);
  return FETCH_DISTANCES_NM[dir] || { nm: 10, desc: 'interpolated' };
}

// ============================================================
// TERRAIN & OBSTACLE MODEL
// ============================================================
// Obstacles between the wind source and the riding area cause
// turbulence, gustiness, and wind shadows.

const TERRAIN_EFFECTS = [
  {
    wind_from_min: 100, wind_from_max: 170,
    severity: 'high',
    obstacle: 'Kahului Airport / Industrial zone',
    effect: 'Extreme turbulence. Wind passes over buildings, hangars, runway infrastructure. Creates severe gustiness and wind shadows. Kite/windsurf NOT recommended.',
  },
  {
    wind_from_min: 170, wind_from_max: 210,
    severity: 'high',
    obstacle: 'Kahului Town / Harbor',
    effect: 'Wind over dense urban area and harbor structures. Turbulent and gusty.',
  },
  {
    wind_from_min: 210, wind_from_max: 260,
    severity: 'extreme',
    obstacle: 'West Maui Mountains (Puu Kukui 5,788ft)',
    effect: 'Massive terrain blocking. Katabatic acceleration in gaps, dead zones behind ridges. Highly unpredictable.',
  },
  {
    wind_from_min: 260, wind_from_max: 300,
    severity: 'moderate',
    obstacle: 'Pailolo Channel gap / West Maui shoulder',
    effect: 'Venturi acceleration through channel. Can be stronger than open ocean wind but turbulent.',
  },
  {
    wind_from_min: 40, wind_from_max: 80,
    severity: 'none',
    obstacle: 'Open ocean (NE trades)',
    effect: 'Clean, laminar flow over 200+ nm of open water. IDEAL. This is the classic Kanaha trade wind direction.',
  },
  {
    wind_from_min: 0, wind_from_max: 40,
    severity: 'low',
    obstacle: 'Open ocean / slight Molokai shadow at low angles',
    effect: 'Generally clean. At very low angles (N), long-period swell may align with wind creating confused seas.',
  },
  {
    wind_from_min: 80, wind_from_max: 100,
    severity: 'moderate',
    obstacle: 'East Maui / Haleakala foothills',
    effect: 'Partial blocking by Haleakala. Wind accelerates around eastern tip. Can be clean but inconsistent near shore.',
  },
  {
    wind_from_min: 300, wind_from_max: 360,
    severity: 'low',
    obstacle: 'Open Pacific (NW-N)',
    effect: 'Clean ocean fetch. North winds = onshore. May coincide with north swell creating challenging conditions.',
  },
];

function getTerrainEffect(windFromDeg) {
  const wd = normalizeAngle(windFromDeg);
  const effects = TERRAIN_EFFECTS.filter(t => {
    if (t.wind_from_min <= t.wind_from_max) {
      return wd >= t.wind_from_min && wd < t.wind_from_max;
    }
    return wd >= t.wind_from_min || wd < t.wind_from_max;
  });
  return effects[0] || { severity: 'unknown', obstacle: 'Unknown', effect: 'No data' };
}

// ============================================================
// WAVE-WIND INTERACTION MODEL
// ============================================================
// When swell direction and wind direction are aligned, conditions change.

function analyzeWaveWindInteraction(windFromDeg, swellFromDeg, swellHeightM, swellPeriodS) {
  if (swellHeightM == null || swellFromDeg == null) {
    return { interaction: 'no_data', desc: 'Insufficient wave data' };
  }

  // Swell "from" direction: where swell is coming FROM
  // Wind "from" direction: where wind is coming FROM
  const alignment = Math.abs(angleDiff(windFromDeg, swellFromDeg));

  let interaction, desc;

  if (alignment < 30) {
    interaction = 'aligned';
    desc = 'Wind and swell from same direction. Creates steep, choppy waves. Difficult for riding but can produce good wave-riding conditions for advanced kiters.';
  } else if (alignment < 60) {
    interaction = 'partially_aligned';
    desc = 'Wind and swell partially aligned. Moderate chop with some organization to the waves.';
  } else if (alignment < 120) {
    interaction = 'cross';
    desc = 'Wind crosses the swell. Creates manageable cross-chop. Good for bump-and-jump if swell is significant.';
  } else if (alignment < 150) {
    interaction = 'partially_opposed';
    desc = 'Wind partially opposes swell. Can smooth wave faces on the windward side. Decent wave-riding conditions.';
  } else {
    interaction = 'opposed';
    desc = 'Wind directly opposes swell. Smooths wave faces, creates clean conditions for wave riding. Classic "offshore" wave conditions.';
  }

  // Factor in swell size
  let swellImpact;
  if (swellHeightM < 0.5) {
    swellImpact = 'negligible';
  } else if (swellHeightM < 1.0) {
    swellImpact = 'minor';
  } else if (swellHeightM < 2.0) {
    swellImpact = 'moderate';
  } else if (swellHeightM < 3.0) {
    swellImpact = 'significant';
  } else {
    swellImpact = 'major';
  }

  // Factor in period (longer period = more powerful)
  let periodImpact;
  if (swellPeriodS < 8) {
    periodImpact = 'wind_swell'; // locally generated, short period
  } else if (swellPeriodS < 12) {
    periodImpact = 'moderate_swell';
  } else if (swellPeriodS < 16) {
    periodImpact = 'long_period_swell'; // distant storm, powerful
  } else {
    periodImpact = 'ground_swell'; // very distant, very powerful
  }

  return {
    interaction,
    alignment_deg: Math.round(alignment),
    swell_impact: swellImpact,
    period_type: periodImpact,
    desc,
  };
}

// ============================================================
// COMPREHENSIVE CONDITIONS ASSESSMENT
// ============================================================

function assessConditions({
  windFromDeg,
  windAvgKts,
  windGustKts,
  windLullKts,
  swellFromDeg,
  swellHeightM,
  swellPeriodS,
  tideLevelFt,
  tidePhase,
  pressureMslHpa,
  pressureTrendHpa3h,
  segment = PRIMARY_ZONE,
}) {
  const shoreNormal = segment.shore_normal_deg;
  const wa = windAngle(windFromDeg, shoreNormal);
  const classification = classifyWindAngle(wa);
  const fetch = getFetch(windFromDeg);
  const terrain = getTerrainEffect(windFromDeg);
  const waveWind = analyzeWaveWindInteraction(windFromDeg, swellFromDeg, swellHeightM, swellPeriodS);

  // Gustiness factor (lower = smoother)
  const gustFactor = windGustKts && windLullKts
    ? Math.round((windGustKts - windLullKts) / windAvgKts * 100)
    : null;

  let gustQuality;
  if (gustFactor == null) gustQuality = 'unknown';
  else if (gustFactor < 40) gustQuality = 'smooth';
  else if (gustFactor < 70) gustQuality = 'moderate';
  else if (gustFactor < 100) gustQuality = 'gusty';
  else gustQuality = 'extremely_gusty';

  // Kite size recommendation (rough guide)
  let kiteSize;
  if (windAvgKts < 10) kiteSize = 'No kite (too light)';
  else if (windAvgKts < 15) kiteSize = '14-17m (light wind, foil recommended)';
  else if (windAvgKts < 20) kiteSize = '12-14m';
  else if (windAvgKts < 25) kiteSize = '9-12m';
  else if (windAvgKts < 30) kiteSize = '7-9m';
  else if (windAvgKts < 35) kiteSize = '5-7m';
  else kiteSize = '5m or smaller (expert only)';

  // Tide effect on Kanaha
  let tideEffect = null;
  if (tideLevelFt != null) {
    if (tideLevelFt < 0) tideEffect = 'Very low tide. Reef exposed. Dangerous for fins/boards. Walk out carefully.';
    else if (tideLevelFt < 0.5) tideEffect = 'Low tide. Shallow inner reef. Be cautious with fin depth.';
    else if (tideLevelFt < 1.5) tideEffect = 'Mid tide. Good depth over reef. Most versatile conditions.';
    else if (tideLevelFt < 2.0) tideEffect = 'Higher tide. Deeper water inside reef. Good for beginners.';
    else tideEffect = 'High tide. Full water over reef. Easy launch but current can be strong in channels.';
  }

  // Pressure analysis
  let pressureAnalysis = null;
  if (pressureTrendHpa3h != null) {
    if (pressureTrendHpa3h < -2) pressureAnalysis = 'Rapidly falling pressure. Expect increasing wind and possible weather change.';
    else if (pressureTrendHpa3h < -0.5) pressureAnalysis = 'Falling pressure. Wind likely to increase.';
    else if (pressureTrendHpa3h < 0.5) pressureAnalysis = 'Stable pressure. Conditions likely to persist.';
    else if (pressureTrendHpa3h < 2) pressureAnalysis = 'Rising pressure. Wind may moderate.';
    else pressureAnalysis = 'Rapidly rising pressure. Wind likely to drop.';
  }

  // Overall rating
  let overallRating;
  const scores = [];
  // Wind angle quality
  if (classification.quality === 'excellent') scores.push(5);
  else if (classification.quality === 'good') scores.push(4);
  else if (classification.quality === 'fair') scores.push(3);
  else if (classification.quality === 'marginal') scores.push(2);
  else if (classification.quality === 'challenging') scores.push(2);
  else scores.push(1);

  // Wind strength
  if (windAvgKts >= 15 && windAvgKts <= 30) scores.push(5);
  else if (windAvgKts >= 12 && windAvgKts <= 35) scores.push(4);
  else if (windAvgKts >= 10) scores.push(3);
  else scores.push(1);

  // Terrain
  if (terrain.severity === 'none') scores.push(5);
  else if (terrain.severity === 'low') scores.push(4);
  else if (terrain.severity === 'moderate') scores.push(3);
  else if (terrain.severity === 'high') scores.push(1);
  else scores.push(0);

  // Gustiness
  if (gustQuality === 'smooth') scores.push(5);
  else if (gustQuality === 'moderate') scores.push(4);
  else if (gustQuality === 'gusty') scores.push(2);
  else if (gustQuality === 'extremely_gusty') scores.push(1);
  else scores.push(3);

  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (avgScore >= 4.5) overallRating = { score: 5, label: 'EPIC', emoji: '🔥' };
  else if (avgScore >= 3.5) overallRating = { score: 4, label: 'GOOD', emoji: '🟢' };
  else if (avgScore >= 2.5) overallRating = { score: 3, label: 'FAIR', emoji: '🟡' };
  else if (avgScore >= 1.5) overallRating = { score: 2, label: 'MARGINAL', emoji: '🟠' };
  else overallRating = { score: 1, label: 'POOR', emoji: '🔴' };

  return {
    segment: segment.name,
    shore_normal_deg: shoreNormal,
    wind: {
      from_deg: windFromDeg,
      avg_kts: windAvgKts,
      gust_kts: windGustKts,
      lull_kts: windLullKts,
      angle_to_shore_deg: Math.round(wa),
      classification: classification.label,
      classification_code: classification.code,
      quality: classification.quality,
      emoji: classification.emoji,
    },
    fetch: {
      distance_nm: fetch.nm,
      description: fetch.desc,
    },
    terrain: {
      severity: terrain.severity,
      obstacle: terrain.obstacle,
      effect: terrain.effect,
    },
    gustiness: {
      factor_pct: gustFactor,
      quality: gustQuality,
    },
    wave_wind: waveWind,
    tide: tideEffect ? { level_ft: tideLevelFt, phase: tidePhase, effect: tideEffect } : null,
    pressure: pressureAnalysis ? { msl_hpa: pressureMslHpa, trend_3h: pressureTrendHpa3h, analysis: pressureAnalysis } : null,
    kite_size: kiteSize,
    overall: overallRating,
    description: classification.desc,
  };
}

// ============================================================
// CLI
// ============================================================

const args = process.argv.slice(2);

if (args.includes('--analyze') && args.length > args.indexOf('--analyze') + 1) {
  // Analyze from wind data file
  const fs = await import('fs');
  const file = args[args.indexOf('--analyze') + 1];
  const windData = JSON.parse(fs.readFileSync(file, 'utf8'));

  const results = {
    source: 'coastline-model',
    analyzed_from: file,
    fetched_utc: new Date().toISOString(),
    current: windData.current ? assessConditions({
      windFromDeg: windData.current.dir_deg,
      windAvgKts: windData.current.avg_kts,
      windGustKts: windData.current.gust_kts,
      windLullKts: windData.current.lull_kts,
    }) : null,
    forecast: (windData.forecast || []).map(f => ({
      time_utc: f.time_utc,
      ...assessConditions({
        windFromDeg: f.wind_dir_deg,
        windAvgKts: f.wind_avg_kts,
        windGustKts: f.wind_gust_kts,
        windLullKts: f.wind_lull_kts,
      }),
    })),
  };
  console.log(JSON.stringify(results, null, 2));

} else if (args.includes('--wind-deg')) {
  // Quick single-point analysis
  const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? parseFloat(args[i + 1]) : null; };
  const result = assessConditions({
    windFromDeg: getArg('--wind-deg'),
    windAvgKts: getArg('--wind-kts') || 15,
    windGustKts: getArg('--gust-kts'),
    windLullKts: getArg('--lull-kts'),
    swellFromDeg: getArg('--wave-dir'),
    swellHeightM: getArg('--wave-m'),
    swellPeriodS: getArg('--wave-period'),
    tideLevelFt: getArg('--tide-ft'),
    pressureMslHpa: getArg('--pressure'),
    pressureTrendHpa3h: getArg('--pressure-trend'),
  });
  console.log(JSON.stringify(result, null, 2));

} else {
  // Dump full model
  const model = {
    source: 'coastline-model',
    version: '1.0',
    location: 'Kanaha Beach Park, Maui HI',
    primary_zone: PRIMARY_ZONE.name,
    primary_shore_normal_deg: PRIMARY_SHORE_NORMAL,
    coastline_segments: COASTLINE_SEGMENTS,
    wind_classifications: WIND_CLASSIFICATIONS,
    fetch_distances: FETCH_DISTANCES_NM,
    terrain_effects: TERRAIN_EFFECTS,
    notes: [
      'Shore normal is the compass bearing perpendicular to the beach, pointing out to sea.',
      'Wind angle is measured relative to the offshore direction (shore normal + 180).',
      'A wind angle of 0 = offshore, 90 = cross-shore, 180 = onshore.',
      'Positive angles = wind from the right (looking out to sea), negative = from the left.',
      'For Kanaha Kite Beach, shore normal is ~30° (NNE). Classic NE trades (60°) give cross-onshore right — IDEAL.',
      'Fetch distance is the over-water distance wind travels before reaching the beach.',
      'Longer fetch = smoother, more consistent wind. Short fetch = gusty, turbulent.',
    ],
  };
  console.log(JSON.stringify(model, null, 2));
}
