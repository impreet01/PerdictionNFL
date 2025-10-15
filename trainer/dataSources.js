// trainer/dataSources.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parse } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

import { getDataConfig } from './config.js';

// ---------- discovery helpers ----------
const GH_ROOT = 'https://api.github.com/repos/nflverse/nflverse-data';
const GH_HEADERS = {
  'User-Agent': 'perdiction-nfl-discovery',
  Accept: 'application/vnd.github+json'
};
if (process.env.GITHUB_TOKEN) {
  GH_HEADERS.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const manifestCache = new Map();
const DATA_CONFIG = getDataConfig();
const WEEKLY_SANITY_DATASETS = new Set([
  'teamWeekly',
  'playerWeekly',
  'rosterWeekly',
  'depthCharts',
  'ftnCharts',
  'nextGenStats',
  'participation'
]);

const DEFAULT_RETRY = {
  attempts: 3,
  backoffMs: 500
};

function getRetrySettings() {
  const retry = DATA_CONFIG.retry || {};
  const attempts = Number.isFinite(Number(retry.attempts)) ? Number(retry.attempts) : DEFAULT_RETRY.attempts;
  const backoffMs = Number.isFinite(Number(retry.backoffMs)) ? Number(retry.backoffMs) : DEFAULT_RETRY.backoffMs;
  return { attempts: Math.max(1, attempts), backoffMs: Math.max(0, backoffMs) };
}

async function fetchWithRetry(url, options = {}, label = 'fetch') {
  const { attempts, backoffMs } = getRetrySettings();
  let attempt = 0;
  let lastErr;
  while (attempt < attempts) {
    attempt += 1;
    try {
      const controller = new AbortController();
      const timeout = Number(options.timeout || 45_000);
      const id = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`${label} ${res.status}: ${text}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      const jitter = Math.random() * 0.25 + 0.75;
      await wait(backoffMs * attempt * jitter);
    }
  }
  throw lastErr;
}

async function fetchJSONWithRetry(url, options, label = 'json') {
  const res = await fetchWithRetry(url, options, label);
  return res.json();
}

async function fetchGithubJson(url) {
  try {
    return await fetchJSONWithRetry(url, { headers: GH_HEADERS }, 'github');
  } catch (err) {
    if (err?.message?.includes('404') || err?.status === 404) {
      throw Object.assign(new Error('Not found'), { status: 404 });
    }
    throw err;
  }
}

async function fetchReleaseByTag(tag) {
  const cacheKey = `release:${tag}`;
  if (manifestCache.has(cacheKey)) return manifestCache.get(cacheKey);
  try {
    const rel = await fetchGithubJson(`${GH_ROOT}/releases/tags/${tag}`);
    manifestCache.set(cacheKey, rel);
    return rel;
  } catch (err) {
    if (err?.status === 404) {
      // fallback: list releases and search
      const releases = await fetchGithubJson(`${GH_ROOT}/releases?per_page=100`);
      const match = releases.find((r) => r.tag_name === tag || r.name === tag);
      if (match) {
        manifestCache.set(cacheKey, match);
        return match;
      }
    }
    throw err;
  }
}

const PATTERN = (regex, seasonIndex = 1) => (asset) => {
  const m = asset.name.match(regex);
  if (!m) return null;
  const season = Number.parseInt(m[seasonIndex], 10);
  if (!Number.isFinite(season)) return null;
  return {
    season,
    url: asset.browser_download_url,
    name: asset.name,
    size: asset.size,
    updated_at: asset.updated_at,
    content_type: asset.content_type
  };
};

const DATASET_MANIFEST = {
  schedules: {
    tag: 'schedules',
    parser(asset) {
      if (/schedules_(\d{4})\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/schedules_(\d{4})\.csv(\.gz)?$/)(asset);
      }
      if (/^schedules\.csv(\.gz)?$/i.test(asset.name)) {
        return {
          season: null,
          url: asset.browser_download_url,
          name: asset.name,
          size: asset.size,
          updated_at: asset.updated_at,
          content_type: asset.content_type
        };
      }
      return null;
    }
  },
  snapCounts: {
    tag: 'snap_counts',
    parser(asset) {
      if (/snap_counts_(\d{4})\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/snap_counts_(\d{4})\.csv(\.gz)?$/)(asset);
      }
      if (/^snap_counts\.csv(\.gz)?$/i.test(asset.name)) {
        return {
          season: null,
          url: asset.browser_download_url,
          name: asset.name,
          size: asset.size,
          updated_at: asset.updated_at,
          content_type: asset.content_type
        };
      }
      return null;
    }
  },
  teamWeekly: {
    tag: 'stats_team',
    parser(asset) {
      if (/stats_team_week_(\d{4})\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/stats_team_week_(\d{4})\.csv(\.gz)?$/)(asset);
      }
      if (/stats_team_week\.csv(\.gz)?$/i.test(asset.name)) {
        return {
          season: null,
          url: asset.browser_download_url,
          name: asset.name,
          size: asset.size,
          updated_at: asset.updated_at,
          content_type: asset.content_type
        };
      }
      return null;
    }
  },
  playerWeekly: {
    tag: 'stats_player',
    parser(asset) {
      if (/stats_player_week_(\d{4})\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/stats_player_week_(\d{4})\.csv(\.gz)?$/)(asset);
      }
      if (/stats_player_week\.csv(\.gz)?$/i.test(asset.name)) {
        return {
          season: null,
          url: asset.browser_download_url,
          name: asset.name,
          size: asset.size,
          updated_at: asset.updated_at,
          content_type: asset.content_type
        };
      }
      return null;
    }
  },
  nextGenPassing: {
    tag: 'nextgen_stats',
    parser(asset) {
      if (/ngs_(\d{4})_passing\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/ngs_(\d{4})_passing\.csv(\.gz)?$/)(asset);
      }
      return null;
    }
  },
  nextGenRushing: {
    tag: 'nextgen_stats',
    parser(asset) {
      if (/ngs_(\d{4})_rushing\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/ngs_(\d{4})_rushing\.csv(\.gz)?$/)(asset);
      }
      return null;
    }
  },
  nextGenReceiving: {
    tag: 'nextgen_stats',
    parser(asset) {
      if (/ngs_(\d{4})_receiving\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/ngs_(\d{4})_receiving\.csv(\.gz)?$/)(asset);
      }
      return null;
    }
  },
  participation: {
    tag: 'pbp_participation',
    parser(asset) {
      if (/pbp_participation_(\d{4})\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/pbp_participation_(\d{4})\.csv(\.gz)?$/)(asset);
      }
      return null;
    }
  },
  rosterWeekly: {
    tag: 'weekly_rosters',
    parser(asset) {
      if (/roster_weekly_(\d{4})\.csv(\.gz)?$/i.test(asset.name) || /weekly_rosters_(\d{4})\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/(roster|weekly)_rosters?_(\d{4})\.csv(\.gz)?$/, 2)(asset);
      }
      if (/^roster_weekly\.csv(\.gz)?$/i.test(asset.name) || /^weekly_rosters\.csv(\.gz)?$/i.test(asset.name)) {
        return {
          season: null,
          url: asset.browser_download_url,
          name: asset.name,
          size: asset.size,
          updated_at: asset.updated_at,
          content_type: asset.content_type
        };
      }
      return null;
    }
  },
  depthCharts: {
    tag: 'depth_charts',
    parser(asset) {
      if (/depth_charts_(\d{4})\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/depth_charts_(\d{4})\.csv(\.gz)?$/)(asset);
      }
      if (/^depth_charts\.csv(\.gz)?$/i.test(asset.name)) {
        return {
          season: null,
          url: asset.browser_download_url,
          name: asset.name,
          size: asset.size,
          updated_at: asset.updated_at,
          content_type: asset.content_type
        };
      }
      return null;
    }
  },
  ftnCharts: {
    tag: 'ftn_charting',
    parser(asset) {
      if (/ftn_charting_(\d{4})\.csv(\.gz)?$/i.test(asset.name)) {
        return PATTERN(/ftn_charting_(\d{4})\.csv(\.gz)?$/)(asset);
      }
      if (/^ftn_charting\.csv(\.gz)?$/i.test(asset.name)) {
        return {
          season: null,
          url: asset.browser_download_url,
          name: asset.name,
          size: asset.size,
          updated_at: asset.updated_at,
          content_type: asset.content_type
        };
      }
      return null;
    }
  },
  pbp: { tag: 'pbp', parser: PATTERN(/play_by_play_(\d{4})\.csv\.gz$/) },
  pfrRush: { tag: 'pfr_advstats', parser: PATTERN(/advstats_week_rush_(\d{4})\.csv$/) },
  pfrDef: { tag: 'pfr_advstats', parser: PATTERN(/advstats_week_def_(\d{4})\.csv$/) },
  pfrPass: { tag: 'pfr_advstats', parser: PATTERN(/advstats_week_pass_(\d{4})\.csv$/) },
  pfrRec: { tag: 'pfr_advstats', parser: PATTERN(/advstats_week_rec_(\d{4})\.csv$/) }
};

async function discoverManifest(dataset) {
  const spec = DATASET_MANIFEST[dataset];
  if (!spec) return { entries: [], source: null };
  const cacheKey = `manifest:${dataset}`;
  if (manifestCache.has(cacheKey)) return manifestCache.get(cacheKey);
  try {
    const release = await fetchReleaseByTag(spec.tag);
    const entries = (release.assets || [])
      .map((asset) => spec.parser(asset))
      .filter(Boolean)
      .sort((a, b) => (a.season || 0) - (b.season || 0) || a.name.localeCompare(b.name));
    const manifest = {
      dataset,
      entries,
      discovered_at: new Date().toISOString(),
      source: release.tag_name || spec.tag
    };
    manifestCache.set(cacheKey, manifest);
    return manifest;
  } catch (err) {
    const manifest = {
      dataset,
      entries: [],
      error: err?.message || String(err)
    };
    manifestCache.set(cacheKey, manifest);
    return manifest;
  }
}

export async function listDatasetSeasons(dataset) {
  const manifest = await discoverManifest(dataset);
  const seasons = manifest.entries
    .map((e) => Number(e.season))
    .filter((s) => Number.isFinite(s));
  const uniq = Array.from(new Set(seasons)).sort((a, b) => a - b);
  return uniq;
}

async function resolveFromManifest(dataset, season) {
  const manifest = await discoverManifest(dataset);
  if (!manifest.entries.length) return null;
  const target = Number.isFinite(Number(season)) ? Number(season) : null;
  const matches = manifest.entries.filter((e) => (target == null ? true : Number(e.season) === target));
  if (matches.length) {
    const preferred = matches.sort((a, b) => {
      const byUpdated = new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
      if (byUpdated !== 0) return byUpdated;
      const gzScore = (name) => (name.endsWith('.gz') ? 1 : 0);
      return gzScore(b.name) - gzScore(a.name);
    })[0];
    return { url: preferred.url, name: preferred.name, season: preferred.season, source: 'manifest' };
  }
  // If no direct season match, fall back to newest available
  const latest = manifest.entries[manifest.entries.length - 1];
  if (latest) {
    return { url: latest.url, name: latest.name, season: latest.season, source: 'manifest-latest' };
  }
  return null;
}

async function resolveDatasetUrl(dataset, season, fallbackFactory) {
  try {
    const resolved = await resolveFromManifest(dataset, season);
    if (resolved?.url) return resolved;
  } catch (err) {
    console.warn(`[dataSources] manifest lookup failed for ${dataset} ${season ?? ''}: ${err?.message || err}`);
  }
  if (typeof fallbackFactory === 'function') {
    const url = fallbackFactory(season);
    return url ? { url, source: 'static' } : null;
  }
  return null;
}


// ---------- URLs (exact nflverse sources) ----------
const REL = {
  qbr:        ()  => `https://github.com/nflverse/nflverse-data/releases/download/espn_data/qbr_week_level.csv`,
  officials:  ()  => `https://github.com/nflverse/nflverse-data/releases/download/officials/officials.csv`,
  schedules:  ()  => `https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv`,
  snapCounts: (y) => `https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_${y}.csv`,
  teamWeekly: (y) => `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${y}.csv`,
  playerWeekly:(y)=> `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${y}.csv`,
  rosterWeekly:(y)=> `https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_${y}.csv`,
  depthCharts:(y) => `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${y}.csv`,
  ftnCharts:  (y) => `https://github.com/nflverse/nflverse-data/releases/download/ftn_charting/ftn_charting_${y}.csv`,
  pbp:        (y) => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${y}.csv.gz`,
  pfrRush:    (y) => `https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats/advstats_week_rush_${y}.csv`,
  pfrDef:     (y) => `https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats/advstats_week_def_${y}.csv`,
  pfrPass:    (y) => `https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats/advstats_week_pass_${y}.csv`,
  pfrRec:     (y) => `https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats/advstats_week_rec_${y}.csv`,
  nextGenPassing:   (y) => `https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_${y}_passing.csv.gz`,
  nextGenRushing:   (y) => `https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_${y}_rushing.csv.gz`,
  nextGenReceiving: (y) => `https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats/ngs_${y}_receiving.csv.gz`,
  participation:    (y) => `https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_${y}.csv`
};

// ---------- helpers/caches ----------
export function toInt(v){ const n = parseInt(v,10); return Number.isFinite(n) ? n : null; }
const isGz = (u)=>u.endsWith('.gz');

function getEffectiveThreshold(dataset, baseThreshold) {
  const threshold = Number(baseThreshold);
  if (!Number.isFinite(threshold)) return undefined;
  if (!WEEKLY_SANITY_DATASETS.has(dataset)) return threshold;
  const configuredWeek = Number(DATA_CONFIG?.week);
  if (!Number.isFinite(configuredWeek) || configuredWeek <= 0) return threshold;
  const seasonWeeks = Number.isFinite(Number(DATA_CONFIG?.weeksInSeason))
    ? Number(DATA_CONFIG.weeksInSeason)
    : 18;
  const normalizedWeek = Math.max(1, Math.min(configuredWeek, seasonWeeks));
  const scaled = Math.ceil((threshold * normalizedWeek) / seasonWeeks);
  return Math.max(1, Math.min(threshold, scaled));
}

function sanityCheckRows(dataset, rows) {
  if (!Array.isArray(rows)) {
    throw new Error(`[dataSources] ${dataset} did not return an array`);
  }
  const sanity = DATA_CONFIG.sanityChecks || {};
  const key = `min${dataset.charAt(0).toUpperCase()}${dataset.slice(1)}Rows`;
  const threshold = getEffectiveThreshold(dataset, sanity[key]);
  if (Number.isFinite(threshold) && rows.length < threshold) {
    throw new Error(`[dataSources] ${dataset} row count ${rows.length} < ${threshold}`);
  }
  return rows;
}

async function fetchBuffer(url){
  const res = await fetchWithRetry(url, { redirect:'follow', headers:{'User-Agent':'nflverse-loader'}}, 'buffer');
  return Buffer.from(new Uint8Array(await res.arrayBuffer()));
}
function gunzipMaybe(buf,url){ return isGz(url) ? zlib.gunzipSync(buf) : buf; }
export async function fetchCsvFlexible(url){
  const buf = await fetchBuffer(url);
  const decoded = gunzipMaybe(buf,url);
  const checksum = crypto.createHash('sha256').update(decoded).digest('hex');
  const txt = decoded.toString('utf8');
  const rows = parse(txt, { columns:true, skip_empty_lines:true, relax_column_count:true, trim:true });
  return { rows, source:url, checksum };
}

function normalizeSuccessFlag(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? (value > 0 ? 1 : 0) : null;
  const str = String(value).trim();
  if (!str) return null;
  if (/^(true|t|yes|y)$/i.test(str)) return 1;
  if (/^(false|f|no|n)$/i.test(str)) return 0;
  const num = Number(str);
  if (Number.isFinite(num)) return num > 0 ? 1 : 0;
  return null;
}

function mapPbpRow(raw, seasonFilter) {
  const season = toInt(raw.season ?? raw.game_season ?? raw.year);
  if (season == null || (seasonFilter != null && season !== seasonFilter)) return null;
  const week = toInt(raw.week ?? raw.game_week ?? raw.week_number);
  if (week == null) return null;

  const out = { season, week };
  const seasonType = raw.season_type ?? raw.game_type ?? null;
  if (seasonType != null && seasonType !== '') out.season_type = seasonType;

  for (const key of ['posteam', 'offense', 'offense_team', 'defteam', 'defense', 'defense_team']) {
    const val = raw[key];
    if (val != null && val !== '') out[key] = val;
  }

  const epa = Number(raw.epa);
  if (Number.isFinite(epa)) out.epa = epa;

  const airYards = Number(raw.air_yards ?? raw.air_yards_intended ?? raw.air_yards_thrown);
  if (Number.isFinite(airYards)) out.air_yards = airYards;

  const success = normalizeSuccessFlag(raw.success);
  if (success != null) out.success = success;

  return out;
}

async function fetchPbpSeason(url, season) {
  let buf = await fetchBuffer(url);
  const rows = [];
  const hash = crypto.createHash('sha256');
  const parser = parseStream({
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  });

  parser.on('readable', () => {
    let record;
    while ((record = parser.read()) !== null) {
      const filtered = mapPbpRow(record, season);
      if (filtered) rows.push(filtered);
    }
  });

  const hashingStream = new Transform({
    transform(chunk, enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    }
  });

  const streams = [Readable.from(buf)];
  if (isGz(url)) streams.push(zlib.createGunzip());
  streams.push(hashingStream, parser);

  try {
    await streamPipeline(...streams);
  } finally {
    buf = null;
  }

  const checksum = hash.digest('hex');
  return { rows, checksum };
}

const ALL_SCHEDULES_KEY = Symbol('schedules-all');

export const caches = {
  schedules:   new Map(), // key season or ALL_SCHEDULES_KEY
  qbr:         new Map(),
  officials:   new Map(),
  snapCounts:  new Map(), // key season
  teamWeekly:  new Map(),
  playerWeekly:new Map(),
  rosterWeekly:new Map(),
  depthCharts: new Map(),
  ftnCharts:   new Map(),
  pbp:         new Map(),
  pfrAdv:      new Map(), // merged weekly map (season)
  injuries:    new Map(),
  markets:     new Map(),
  weather:     new Map(),
  nextGenStats:new Map(), // key `${season}|${statType}`
  participation:new Map(),
};

const DATA_INSPECTION_META = {
  schedules: {
    fields: [
      'game_id: Unique schedule identifier from nflverse games feed (string).',
      'home_team: Home team abbreviation, string code for franchise.',
      'spread_line: Closing spread line when available, numeric in points.'
    ],
    availability: (season) => {
      if (season == null) {
        return 'Schedules available for all tracked seasons; manifest fallback keeps historical coverage.';
      }
      return `Schedules for ${season} served from nflverse games releases with live fallback when manifest lags.`;
    }
  },
  qbr: {
    fields: [
      'qbr_total: ESPN Total QBR scaled 0-100 per game since 2006.',
      'qb_plays: Plays included in Total QBR calculation, numeric count.'
    ],
    availability: () => 'ESPN Total QBR has coverage beginning in 2006; earlier seasons return empty results.'
  },
  officials: {
    fields: [
      'referee: Lead official name for the crew, string.',
      'total_penalties: Combined accepted penalties flagged by crew, numeric if available.'
    ],
    availability: () => 'Officials data maintained since 2015 across regular and postseason games.'
  },
  snapCounts: {
    fields: [
      'offense_snaps: Offensive snaps played by the player, numeric.',
      'special_teams_snaps: Special-teams snaps logged, numeric count.'
    ],
    availability: (season) => `Snap counts tracked by nflverse weekly releases; consistent coverage from 2012 onward (requested ${season}).`
  },
  teamWeekly: {
    fields: [
      'pass_yards: Team passing yards for the week, numeric aggregate.',
      'rush_yards: Team rushing yards for the week, numeric aggregate.'
    ],
    availability: () => 'Team weekly stats cover regular and postseason performance for modern NFL seasons.'
  },
  teamGameAdvanced: {
    fields: [
      'off_pass_epa: Offensive pass EPA per play, numeric per game.',
      'def_rush_success_rate: Defensive rush success rate allowed, numeric share.'
    ],
    availability: () => 'Team-game advanced stats derived from nflverse advanced releases for play-by-play era (1999+).'
  },
  playerWeekly: {
    fields: [
      'targets: Player targets for the week, numeric usage metric.',
      'rush_attempts: Player rushing attempts per week, numeric volume.'
    ],
    availability: () => 'Player weekly usage spans play-by-play era with bye-week aware splits by position.'
  },
  rosterWeekly: {
    fields: [
      'status: Weekly roster status (active/inactive/IR), string.',
      'position: Official roster position code, string.'
    ],
    availability: () => 'Weekly rosters updated throughout each season with full franchise coverage.'
  },
  depthCharts: {
    fields: [
      'depth_team: Team abbreviation for the depth entry, string.',
      'depth_order: Numeric depth chart order (1=starter).'
    ],
    availability: () => 'Depth charts captured weekly from nflverse depth chart releases.'
  },
  ftnCharts: {
    fields: [
      'pressures: FTN charted pass-rush pressures, numeric.',
      'defense_man_rate: Share of defensive snaps in man coverage, numeric.'
    ],
    availability: (season) => `FTN charting expands defensive detail for recent seasons (requested ${season}); earliest coverage circa 2020.`
  },
  pbp: {
    fields: [
      'epa: Expected Points Added, numeric efficiency from play.',
      'air_yards: Pass distance in the air, numeric (tracking since 2006).'
    ],
    availability: (season) => {
      if (season == null) {
        return 'Full play-by-play spans from 1999 forward with postseason coverage; request-specific filtering applied.';
      }
      return `Play-by-play for ${season} sourced from nflverse pbp release with auto mirror + gunzip fallbacks.`;
    }
  },
  pfrAdvTeamWeekly: {
    fields: [
      'rush_success_rate: Pro-Football-Reference rushing success rate, numeric.',
      'pass_epa: PFR modeled passing EPA per play, numeric.'
    ],
    availability: () => 'PFR advanced team splits aggregated weekly dating to 2000-era advanced stat coverage.'
  },
  injuries: {
    fields: [
      'status: Player injury designation (out/questionable), string.',
      'practice: Practice participation notes, string from Rotowire.'
    ],
    availability: (season) => `Rotowire injury reports refreshed daily; data persists for ${season} season snapshots.`
  },
  markets: {
    fields: [
      'spread_home: Consensus home spread line in points, numeric.',
      'total: Consensus game total in points, numeric.'
    ],
    availability: () => 'Market artifacts generated weekly from Rotowire betting tables when fetched.'
  },
  weather: {
    fields: [
      'temperature: Forecast/observed temperature in Fahrenheit, numeric.',
      'wind_mph: Reported wind speed in miles per hour, numeric.'
    ],
    availability: () => 'Weather artifacts captured weekly from Rotowire with stadium-specific forecasts.'
  },
  nextGenStats: {
    fields: [
      'avg_time_to_throw: Seconds from snap to pass attempt, numeric from tracking.',
      'aggressiveness: Tight-window throw rate percentage, numeric.',
      'expected_yac: Expected yards after catch for targeted receivers, numeric.'
    ],
    availability: (season, rows, ctx) => {
      const type = ctx?.statType ? ctx.statType.toLowerCase() : 'tracking';
      if (season != null && season < 2016) {
        return `Next Gen Stats ${type} data begins in 2016; season ${season} will fallback to traditional stats.`;
      }
      return `Next Gen Stats ${type} tracking metrics available from 2016 onward (requested ${season}).`;
    }
  },
  participation: {
    fields: [
      'offense_players: Offensive personnel on field (comma-separated), string.',
      'defense_players: Defensive personnel grouping per play, string.'
    ],
    availability: (season) => {
      if (season != null && season < 2016) {
        return `Participation tracking starts in 2016; season ${season} will not return personnel splits.`;
      }
      return `Participation files supply offense/defense/special-teams personnel from 2016 onward (requested ${season}).`;
    }
  }
};

function inspectData(dataset, rows, context = {}) {
  try {
    const meta = DATA_INSPECTION_META[dataset] || {};
    const availabilitySource = context.availability ?? meta.availability;
    const availability = typeof availabilitySource === 'function'
      ? availabilitySource(context.season ?? null, rows, context)
      : availabilitySource;
    const fieldMeanings = [];
    if (Array.isArray(meta.fields)) fieldMeanings.push(...meta.fields);
    if (Array.isArray(context.fields)) fieldMeanings.push(...context.fields);

    if (Array.isArray(rows) && rows.length > 0) {
      const sampleRow = rows[0];
      const sampleKeys = Object.keys(sampleRow || {});
      console.log(`[inspectData/${dataset}] sample columns=${sampleKeys.join(', ')}`);
      console.table([sampleRow]);
    } else if (!Array.isArray(rows) || rows.length === 0) {
      console.warn(`[inspectData/${dataset}] dataset empty or unavailable`);
    }

    if (availability) {
      console.log(`[inspectData/${dataset}] availability: ${availability}`);
    }

    for (const desc of fieldMeanings) {
      console.log(`[inspectData/${dataset}] field: ${desc}`);
    }
  } catch (err) {
    console.warn(`[inspectData/${dataset}] inspection failed: ${err?.message || err}`);
  }
  return rows;
}

function parseCacheLimit(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num <= 0) return 0;
  return Math.floor(num);
}

const PBP_CACHE_LIMIT = parseCacheLimit(process.env.PBP_CACHE_LIMIT, 2);

function enforceCacheLimit(store, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return;
  const normalized = Math.floor(limit);
  while (store.size > normalized) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

async function cached(store, key, loader, options = {}) {
  if (store.has(key)) {
    const cachedValue = store.get(key);
    if (typeof options.inspect === 'function') {
      try {
        options.inspect(cachedValue, { cached: true, key });
      } catch (err) {
        console.warn(`[dataSources] inspect callback failed for cached key ${String(key)}: ${err?.message || err}`);
      }
    }
    return cachedValue;
  }
  const val = await loader();
  store.set(key, val);
  if (typeof options.inspect === 'function') {
    try {
      options.inspect(val, { cached: false, key });
    } catch (err) {
      console.warn(`[dataSources] inspect callback failed for key ${String(key)}: ${err?.message || err}`);
    }
  }
  const { maxSize } = options;
  if (maxSize != null) {
    const limit = Number(maxSize);
    if (Number.isFinite(limit)) {
      if (limit <= 0) {
        store.delete(key);
      } else {
        enforceCacheLimit(store, limit);
      }
    }
  }
  return val;
}

const ROTOWIRE_ARTIFACTS_DIR = path.resolve(process.cwd(), process.env.ROTOWIRE_ARTIFACTS_DIR ?? 'artifacts');

function normalizeRotowireRecord(row, defaults = {}) {
  if (!row || typeof row !== 'object') return null;
  const teamRaw = row.team ?? row.team_abbr ?? defaults.team;
  const playerRaw = row.player ?? row.player_name ?? row.name;
  if (!teamRaw || !playerRaw) return null;
  const team = String(teamRaw).trim().toUpperCase();
  const player = String(playerRaw).trim();
  if (!team || !player) return null;
  const season = toInt(row.season ?? row.snapshot_season ?? defaults.season);
  const week = toInt(row.week ?? row.snapshot_week ?? defaults.week);
  const position = row.position ?? row.pos ?? row.player_position ?? null;
  const status = row.status ?? row.injury_status ?? row.designation ?? null;
  const injury = row.injury ?? row.injury_detail ?? row.description ?? row.detail ?? null;
  const practice = row.practice ?? row.practice_status ?? row.practice_text ?? row.practice_notes ?? null;
  const fetchedAt = row.fetched_at ?? row.snapshot_fetched_at ?? row.snapshot?.fetched_at ?? defaults.fetchedAt ?? null;
  const noteBits = [];
  if (row.notes) noteBits.push(String(row.notes));
  if (row.note) noteBits.push(String(row.note));
  if (row.report) noteBits.push(String(row.report));
  if (!noteBits.length && injury) noteBits.push(String(injury));
  if (practice && !noteBits.includes(String(practice))) noteBits.push(String(practice));
  const notes = noteBits.length ? noteBits.join(' | ') : null;
  return {
    season,
    week,
    team,
    player,
    position,
    status,
    injury,
    practice,
    notes,
    fetched_at: fetchedAt,
    source: row.source ?? 'rotowire'
  };
}

function toNumberLoose(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const str = String(value).trim();
  if (!str) return null;
  if (/^pk$/i.test(str) || /^pick'em$/i.test(str) || /^pickem$/i.test(str) || /^pick$/i.test(str)) return 0;
  if (/^ev$/i.test(str) || /^even$/i.test(str)) return 100;
  const cleaned = str.replace(/[,]/g, '');
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeMarketBooks(rawBooks) {
  if (!rawBooks || typeof rawBooks !== 'object') return {};
  const books = {};
  for (const [name, rawVal] of Object.entries(rawBooks)) {
    if (!rawVal || typeof rawVal !== 'object') continue;
    const key = name.toLowerCase();
    const moneyline = rawVal.moneyline || {};
    const spread = rawVal.spread || {};
    const spreadHome = spread.home || {};
    const spreadAway = spread.away || {};
    const total = rawVal.total || {};
    const teamTotal = rawVal.team_total || rawVal.teamTotal || {};
    const teamTotalHome = teamTotal.home || {};
    const teamTotalAway = teamTotal.away || {};
    books[key] = {
      moneyline: {
        home: toNumberLoose(moneyline.home),
        away: toNumberLoose(moneyline.away)
      },
      spread: {
        home: {
          line: toNumberLoose(spreadHome.line ?? spread.home_line ?? spread.homeLine),
          price: toNumberLoose(spreadHome.price ?? spread.home_price ?? spread.homePrice)
        },
        away: {
          line: toNumberLoose(spreadAway.line ?? spread.away_line ?? spread.awayLine),
          price: toNumberLoose(spreadAway.price ?? spread.away_price ?? spread.awayPrice)
        }
      },
      total: {
        points: toNumberLoose(total.points ?? total.line ?? total.value),
        over_price: toNumberLoose(total.over_price ?? total.overPrice ?? total.over),
        under_price: toNumberLoose(total.under_price ?? total.underPrice ?? total.under)
      },
      team_total: {
        home: {
          points: toNumberLoose(teamTotalHome.points ?? teamTotal.home_points ?? teamTotalHome.value),
          over_price: toNumberLoose(teamTotalHome.over_price ?? teamTotal.home_over_price ?? teamTotalHome.overPrice ?? teamTotalHome.over),
          under_price: toNumberLoose(teamTotalHome.under_price ?? teamTotal.home_under_price ?? teamTotalHome.underPrice ?? teamTotalHome.under)
        },
        away: {
          points: toNumberLoose(teamTotalAway.points ?? teamTotal.away_points ?? teamTotalAway.value),
          over_price: toNumberLoose(teamTotalAway.over_price ?? teamTotal.away_over_price ?? teamTotalAway.overPrice ?? teamTotalAway.over),
          under_price: toNumberLoose(teamTotalAway.under_price ?? teamTotal.away_under_price ?? teamTotalAway.underPrice ?? teamTotalAway.under)
        }
      }
    };
  }
  return books;
}

function normalizeMarketBest(rawBest) {
  if (!rawBest || typeof rawBest !== 'object') {
    return {
      moneyline: { home: { book: null, price: null }, away: { book: null, price: null } },
      spread: { home: { book: null, line: null, price: null }, away: { book: null, line: null, price: null } },
      total: { over: { book: null, points: null, price: null }, under: { book: null, points: null, price: null } },
      team_total: {
        home: { over: { book: null, points: null, price: null }, under: { book: null, points: null, price: null } },
        away: { over: { book: null, points: null, price: null }, under: { book: null, points: null, price: null } }
      }
    };
  }
  const safe = (obj, path, fallback = null) => {
    let cur = obj;
    for (const key of path) {
      if (!cur || typeof cur !== 'object') return fallback;
      cur = cur[key];
    }
    return cur ?? fallback;
  };
  return {
    moneyline: {
      home: {
        book: safe(rawBest, ['moneyline', 'home', 'book'], null),
        price: toNumberLoose(safe(rawBest, ['moneyline', 'home', 'price'], null))
      },
      away: {
        book: safe(rawBest, ['moneyline', 'away', 'book'], null),
        price: toNumberLoose(safe(rawBest, ['moneyline', 'away', 'price'], null))
      }
    },
    spread: {
      home: {
        book: safe(rawBest, ['spread', 'home', 'book'], null),
        line: toNumberLoose(safe(rawBest, ['spread', 'home', 'line'], null)),
        price: toNumberLoose(safe(rawBest, ['spread', 'home', 'price'], null))
      },
      away: {
        book: safe(rawBest, ['spread', 'away', 'book'], null),
        line: toNumberLoose(safe(rawBest, ['spread', 'away', 'line'], null)),
        price: toNumberLoose(safe(rawBest, ['spread', 'away', 'price'], null))
      }
    },
    total: {
      over: {
        book: safe(rawBest, ['total', 'over', 'book'], null),
        points: toNumberLoose(safe(rawBest, ['total', 'over', 'points'], null)),
        price: toNumberLoose(safe(rawBest, ['total', 'over', 'price'], null))
      },
      under: {
        book: safe(rawBest, ['total', 'under', 'book'], null),
        points: toNumberLoose(safe(rawBest, ['total', 'under', 'points'], null)),
        price: toNumberLoose(safe(rawBest, ['total', 'under', 'price'], null))
      }
    },
    team_total: {
      home: {
        over: {
          book: safe(rawBest, ['team_total', 'home', 'over', 'book'], null),
          points: toNumberLoose(safe(rawBest, ['team_total', 'home', 'over', 'points'], null)),
          price: toNumberLoose(safe(rawBest, ['team_total', 'home', 'over', 'price'], null))
        },
        under: {
          book: safe(rawBest, ['team_total', 'home', 'under', 'book'], null),
          points: toNumberLoose(safe(rawBest, ['team_total', 'home', 'under', 'points'], null)),
          price: toNumberLoose(safe(rawBest, ['team_total', 'home', 'under', 'price'], null))
        }
      },
      away: {
        over: {
          book: safe(rawBest, ['team_total', 'away', 'over', 'book'], null),
          points: toNumberLoose(safe(rawBest, ['team_total', 'away', 'over', 'points'], null)),
          price: toNumberLoose(safe(rawBest, ['team_total', 'away', 'over', 'price'], null))
        },
        under: {
          book: safe(rawBest, ['team_total', 'away', 'under', 'book'], null),
          points: toNumberLoose(safe(rawBest, ['team_total', 'away', 'under', 'points'], null)),
          price: toNumberLoose(safe(rawBest, ['team_total', 'away', 'under', 'price'], null))
        }
      }
    }
  };
}

function normalizeMarketObject(rawMarket) {
  if (!rawMarket || typeof rawMarket !== 'object') return null;
  const out = {
    spread: toNumberLoose(rawMarket.spread ?? rawMarket.spread_home ?? rawMarket.close_spread ?? rawMarket.open_spread),
    close_spread: toNumberLoose(rawMarket.close_spread ?? rawMarket.spread ?? rawMarket.spread_home),
    open_spread: toNumberLoose(rawMarket.open_spread ?? rawMarket.spread ?? rawMarket.spread_home),
    spread_home: toNumberLoose(rawMarket.spread_home ?? rawMarket.spread),
    spread_away: toNumberLoose(rawMarket.spread_away ?? (rawMarket.spread_home != null ? -toNumberLoose(rawMarket.spread_home) : null)),
    spread_price_home: toNumberLoose(rawMarket.spread_price_home),
    spread_price_away: toNumberLoose(rawMarket.spread_price_away),
    moneyline_home: toNumberLoose(rawMarket.moneyline_home),
    moneyline_away: toNumberLoose(rawMarket.moneyline_away),
    total: toNumberLoose(rawMarket.total ?? rawMarket.total_points),
    total_points: toNumberLoose(rawMarket.total_points ?? rawMarket.total),
    total_over_price: toNumberLoose(rawMarket.total_over_price),
    total_under_price: toNumberLoose(rawMarket.total_under_price),
    team_total_home: toNumberLoose(rawMarket.team_total_home),
    team_total_home_over_price: toNumberLoose(rawMarket.team_total_home_over_price),
    team_total_home_under_price: toNumberLoose(rawMarket.team_total_home_under_price),
    team_total_away: toNumberLoose(rawMarket.team_total_away),
    team_total_away_over_price: toNumberLoose(rawMarket.team_total_away_over_price),
    team_total_away_under_price: toNumberLoose(rawMarket.team_total_away_under_price),
    consensus_samples: toInt(rawMarket.consensus_samples ?? rawMarket.sample_size ?? rawMarket.samples ?? null) ?? 0,
    books: normalizeMarketBooks(rawMarket.books || rawMarket.markets || {}),
    best: normalizeMarketBest(rawMarket.best),
    fetched_at: rawMarket.fetched_at ?? null,
    source: rawMarket.source ?? 'rotowire'
  };
  if (!Number.isFinite(out.spread) && Number.isFinite(out.spread_home)) out.spread = out.spread_home;
  if (!Number.isFinite(out.total) && Number.isFinite(out.total_points)) out.total = out.total_points;
  return out;
}

function normalizeMarketRow(row, defaults = {}) {
  if (!row || typeof row !== 'object') return null;
  const season = toInt(row.season ?? defaults.season);
  const week = toInt(row.week ?? defaults.week);
  const homeRaw = row.home_team ?? row.home ?? row.homeTeam ?? defaults.home;
  const awayRaw = row.away_team ?? row.away ?? row.awayTeam ?? defaults.away;
  const home = homeRaw ? String(homeRaw).trim().toUpperCase() : null;
  const away = awayRaw ? String(awayRaw).trim().toUpperCase() : null;
  if (!home || !away) return null;
  const gameKey = row.game_key ?? `${season ?? ''}-W${week != null ? String(week).padStart(2, '0') : '??'}-${home}-${away}`;
  const market = normalizeMarketObject(row.market ?? row.markets ?? null);
  const fetchedAt = row.fetched_at ?? market?.fetched_at ?? defaults.fetchedAt ?? null;
  if (market && !market.fetched_at) market.fetched_at = fetchedAt;
  return {
    season,
    week,
    rotowire_game_id: row.rotowire_game_id ?? row.game_id ?? row.gameID ?? null,
    game_key: gameKey,
    game_date: row.game_date ?? row.kickoff_local ?? row.gameDate ?? null,
    game_day: row.game_day ?? row.gameDay ?? null,
    kickoff_display: row.kickoff_display ?? row.gameDateTime ?? null,
    market_url: row.market_url ?? (row.gameURL ? `https://www.rotowire.com${row.gameURL}` : null),
    home_team: home,
    away_team: away,
    home_name: row.home_name ?? row.homeName ?? null,
    away_name: row.away_name ?? row.awayName ?? null,
    fetched_at: fetchedAt,
    source: row.source ?? market?.source ?? 'rotowire',
    market
  };
}

function normalizeWeatherRow(row, defaults = {}) {
  if (!row || typeof row !== 'object') return null;
  const season = toInt(row.season ?? defaults.season);
  const week = toInt(row.week ?? defaults.week);
  const homeRaw = row.home_team ?? row.home ?? defaults.home;
  const awayRaw = row.away_team ?? row.away ?? defaults.away;
  const home = homeRaw ? String(homeRaw).trim().toUpperCase() : null;
  const away = awayRaw ? String(awayRaw).trim().toUpperCase() : null;
  if (!home || !away) return null;
  const gameKey = row.game_key ?? `${season ?? ''}-W${week != null ? String(week).padStart(2, '0') : '??'}-${home}-${away}`;
  const fetchedAt = row.fetched_at ?? defaults.fetchedAt ?? null;
  const temperature = toNumberLoose(row.temperature_f ?? row.temperature ?? row.temp_f ?? null);
  const precip = toNumberLoose(
    row.precipitation_chance ?? row.precipitation ?? row.precip_prob ?? row.precip ?? row.rain_chance ?? null
  );
  const wind = toNumberLoose(row.wind_mph ?? row.wind ?? row.wind_speed ?? null);
  const impact = toNumberLoose(row.impact_score ?? row.impact ?? null);
  const links = Array.isArray(row.forecast_links)
    ? row.forecast_links
        .map((link) => {
          if (!link || typeof link !== 'object') return null;
          const url = link.url ?? link.href ?? null;
          if (!url) return null;
          return {
            label: link.label ?? link.name ?? null,
            url
          };
        })
        .filter(Boolean)
    : [];
  const textBundle = `${row.summary ?? ''} ${row.details ?? ''} ${row.notes ?? ''}`;
  const domeHint = /domed stadium|indoors?|roof (?:closed|open)/i.test(textBundle) || /inside a dome/i.test(textBundle);
  const isDome = row.is_dome != null ? Boolean(row.is_dome) : domeHint;
  return {
    season,
    week,
    game_key: gameKey,
    home_team: home,
    away_team: away,
    summary: row.summary ?? null,
    details: row.details ?? null,
    notes: row.notes ?? null,
    location: row.location ?? null,
    forecast_provider: row.forecast_provider ?? row.provider ?? null,
    icon: row.icon ?? row.icon_url ?? null,
    kickoff_display: row.kickoff_display ?? row.kickoff ?? null,
    temperature_f: Number.isFinite(temperature) ? temperature : null,
    precipitation_chance: Number.isFinite(precip) ? precip : null,
    wind_mph: Number.isFinite(wind) ? wind : null,
    impact_score: Number.isFinite(impact) ? impact : null,
    forecast_links: links,
    fetched_at: fetchedAt,
    source: row.source ?? 'rotowire',
    is_dome: isDome
  };
}

async function readJsonArray(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
  return [];
}

async function loadRotowireArtifacts(season) {
  let files;
  try {
    files = await fs.readdir(ROTOWIRE_ARTIFACTS_DIR);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const weekEntries = files
    .map((name) => {
      const m = name.match(new RegExp(`^injuries_${season}_W(\\d{2})\\.json$`, 'i'));
      if (!m) return null;
      return { name, week: toInt(m[1]) };
    })
    .filter(Boolean)
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0));

  const dedup = new Map();
  const out = [];

  for (const entry of weekEntries) {
    try {
      const rows = await readJsonArray(path.join(ROTOWIRE_ARTIFACTS_DIR, entry.name));
      for (const raw of rows) {
        const normalized = normalizeRotowireRecord(raw, { season, week: entry.week });
        if (!normalized) continue;
        const key = `${normalized.season ?? ''}|${normalized.week ?? ''}|${normalized.team}|${normalized.player}|${normalized.status ?? ''}`;
        if (dedup.has(key)) continue;
        dedup.set(key, true);
        out.push(normalized);
      }
    } catch (err) {
      console.warn(`[loadInjuries] failed to read ${entry.name}: ${err?.message || err}`);
    }
  }

  if (!out.length) {
    try {
      const currentRows = await readJsonArray(path.join(ROTOWIRE_ARTIFACTS_DIR, 'injuries_current.json'));
      for (const raw of currentRows) {
        const normalized = normalizeRotowireRecord(raw, { season });
        if (!normalized) continue;
        const key = `${normalized.season ?? ''}|${normalized.week ?? ''}|${normalized.team}|${normalized.player}|${normalized.status ?? ''}`;
        if (dedup.has(key)) continue;
        dedup.set(key, true);
        out.push(normalized);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn(`[loadInjuries] failed to read injuries_current.json: ${err?.message || err}`);
      }
    }
  }

  return out;
}

async function loadRotowireMarketArtifacts(season) {
  let files;
  try {
    files = await fs.readdir(ROTOWIRE_ARTIFACTS_DIR);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const weekEntries = files
    .map((name) => {
      const m = name.match(new RegExp(`^markets_${season}_W(\\d{2})\\.json$`, 'i'));
      if (!m) return null;
      return { name, week: toInt(m[1]) };
    })
    .filter(Boolean)
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0));

  const dedup = new Map();

  console.log(
    `[loadMarkets] Rotowire artifacts season=${season} weekEntries=${weekEntries.length}` +
      (weekEntries.length ? ` firstWeek=${weekEntries[0]?.week} lastWeek=${weekEntries[weekEntries.length - 1]?.week}` : '')
  );

  const addRows = (rows, defaults = {}) => {
    for (const raw of rows || []) {
      const normalized = normalizeMarketRow(raw, defaults);
      if (!normalized || !normalized.market) continue;
      const key = normalized.game_key ?? `${normalized.home_team ?? ''}|${normalized.away_team ?? ''}|${normalized.week ?? ''}`;
      const prev = dedup.get(key);
      if (!prev) {
        dedup.set(key, normalized);
        continue;
      }
      const prevTs = Date.parse(prev.market?.fetched_at ?? prev.fetched_at ?? '');
      const nextTs = Date.parse(normalized.market?.fetched_at ?? normalized.fetched_at ?? '');
      if (!Number.isFinite(prevTs) || (Number.isFinite(nextTs) && nextTs >= prevTs)) {
        dedup.set(key, normalized);
      }
    }
  };

  for (const entry of weekEntries) {
    try {
      const rows = await readJsonArray(path.join(ROTOWIRE_ARTIFACTS_DIR, entry.name));
      console.log(`[loadMarkets] reading ${entry.name} rows=${rows?.length ?? 0}`);
      addRows(rows, { season, week: entry.week });
    } catch (err) {
      console.warn(`[loadMarkets] failed to read ${entry.name}: ${err?.message || err}`);
    }
  }

  if (!dedup.size) {
    try {
      const currentRows = await readJsonArray(path.join(ROTOWIRE_ARTIFACTS_DIR, 'markets_current.json'));
      console.log(`[loadMarkets] reading markets_current.json rows=${currentRows?.length ?? 0}`);
      addRows(currentRows, { season });
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn(`[loadMarkets] failed to read markets_current.json: ${err?.message || err}`);
      }
    }
  }

  if (!dedup.size) {
    console.warn('[loadMarkets] no Rotowire market artifacts were added after processing all sources');
  } else {
    console.log(`[loadMarkets] deduped markets=${dedup.size}`);
  }

  return Array.from(dedup.values());
}

async function loadRotowireWeatherArtifacts(season) {
  let files;
  try {
    files = await fs.readdir(ROTOWIRE_ARTIFACTS_DIR);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const weekEntries = files
    .map((name) => {
      const m = name.match(new RegExp(`^weather_${season}_W(\\d{2})\\.json$`, 'i'));
      if (!m) return null;
      return { name, week: toInt(m[1]) };
    })
    .filter(Boolean)
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0));

  const dedup = new Map();

  console.log(
    `[loadWeather] Rotowire artifacts season=${season} weekEntries=${weekEntries.length}` +
      (weekEntries.length ? ` firstWeek=${weekEntries[0]?.week} lastWeek=${weekEntries[weekEntries.length - 1]?.week}` : '')
  );

  const addRows = (rows, defaults = {}) => {
    for (const raw of rows || []) {
      const normalized = normalizeWeatherRow(raw, defaults);
      if (!normalized) continue;
      const key = normalized.game_key ?? `${normalized.home_team ?? ''}|${normalized.away_team ?? ''}|${normalized.week ?? ''}`;
      const prev = dedup.get(key);
      if (!prev) {
        dedup.set(key, normalized);
        continue;
      }
      const prevTs = Date.parse(prev.fetched_at ?? '');
      const nextTs = Date.parse(normalized.fetched_at ?? '');
      if (!Number.isFinite(prevTs) || (Number.isFinite(nextTs) && nextTs >= prevTs)) {
        dedup.set(key, normalized);
      }
    }
  };

  for (const entry of weekEntries) {
    try {
      const rows = await readJsonArray(path.join(ROTOWIRE_ARTIFACTS_DIR, entry.name));
      console.log(`[loadWeather] reading ${entry.name} rows=${rows?.length ?? 0}`);
      addRows(rows, { season, week: entry.week });
    } catch (err) {
      console.warn(`[loadWeather] failed to read ${entry.name}: ${err?.message || err}`);
    }
  }

  if (!dedup.size) {
    try {
      const currentRows = await readJsonArray(path.join(ROTOWIRE_ARTIFACTS_DIR, 'weather_current.json'));
      console.log(`[loadWeather] reading weather_current.json rows=${currentRows?.length ?? 0}`);
      addRows(currentRows, { season });
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn(`[loadWeather] failed to read weather_current.json: ${err?.message || err}`);
      }
    }
  }

  if (!dedup.size) {
    console.warn('[loadWeather] no Rotowire weather artifacts were added after processing all sources');
  } else {
    console.log(`[loadWeather] deduped weather=${dedup.size}`);
  }

  return Array.from(dedup.values());
}

// ---------- canonical loaders (exact paths) ----------
function coerceScore(value) {
  if (value == null) return Number.NaN;
  const text = String(value).trim();
  if (text === '' || text.toUpperCase() === 'NA') return Number.NaN;
  const num = Number(text);
  return Number.isFinite(num) ? num : Number.NaN;
}

function scheduleHasFinalScore(row) {
  const hs = coerceScore(row.home_score ?? row.home_points ?? row.home_pts);
  const as = coerceScore(row.away_score ?? row.away_points ?? row.away_pts);
  return Number.isFinite(hs) && Number.isFinite(as);
}

function maxWeekWithScores(rows) {
  let max = 0;
  for (const row of rows || []) {
    if (!scheduleHasFinalScore(row)) continue;
    const wk = toInt(row.week);
    if (wk != null) max = Math.max(max, wk);
  }
  return max;
}

function resolveExpectedCompletedWeek() {
  const envWeek = toInt(process.env.WEEK);
  if (envWeek != null && envWeek > 0) return Math.max(0, envWeek - 1);
  const configWeek = toInt(DATA_CONFIG?.week);
  if (configWeek != null && configWeek > 0) return Math.max(0, configWeek - 1);
  return null;
}

function shouldUseDynamicSchedule(candidate, expectedCompletedWeek) {
  if (!candidate || !Array.isArray(candidate.rows)) return true;
  if (!candidate.rows.length) return true;
  if (!candidate.sourceType || !candidate.sourceType.startsWith('manifest')) return false;
  if (!Number.isFinite(expectedCompletedWeek) || expectedCompletedWeek <= 0) return false;
  return (candidate.maxWeekWithScores ?? 0) < expectedCompletedWeek;
}

function describeSourceType(candidate) {
  if (!candidate?.sourceType) return '';
  if (candidate.sourceType.startsWith('manifest')) return ' (manifest)';
  if (candidate.sourceType === 'static') return ' (live)';
  return ` (${candidate.sourceType})`;
}

async function fetchScheduleCandidate(url, seasonHint, sourceType) {
  const { rows, source, checksum } = await fetchCsvFlexible(url);
  sanityCheckRows('schedule', rows);
  let effectiveSeason = seasonHint;
  if (effectiveSeason == null) {
    for (const row of rows) {
      const rowSeason = toInt(row.season);
      if (rowSeason != null && (effectiveSeason == null || rowSeason > effectiveSeason)) {
        effectiveSeason = rowSeason;
      }
    }
  }
  const filteredRows = effectiveSeason == null ? rows : rows.filter((r) => toInt(r.season) === effectiveSeason);
  return {
    rows: filteredRows,
    source,
    sourceType,
    checksum,
    effectiveSeason,
    maxWeekWithScores: maxWeekWithScores(filteredRows)
  };
}

export async function loadSchedules(season){
  const y = toInt(season);
  const resolved = await resolveDatasetUrl('schedules', y, REL.schedules);
  const resolvedSeason = resolved?.season != null ? toInt(resolved.season) : null;
  const targetSeason = y ?? resolvedSeason;
  const cacheKey = targetSeason ?? ALL_SCHEDULES_KEY;
  return cached(caches.schedules, cacheKey, async()=>{
    const expectedCompletedWeek = resolveExpectedCompletedWeek();

    let candidate = null;
    if (resolved?.url) {
      candidate = await fetchScheduleCandidate(
        resolved.url,
        targetSeason ?? resolvedSeason,
        resolved.source || 'manifest'
      );
    }

    const needsLiveFallback = shouldUseDynamicSchedule(candidate, expectedCompletedWeek);
    if (!candidate || needsLiveFallback) {
      if (candidate) {
        const manifestMax = candidate.maxWeekWithScores ?? 0;
        if (!candidate.rows.length) {
          console.warn(
            `[loadSchedules] Manifest schedule for season ${targetSeason ?? y} contained no rows – falling back to live feed.`
          );
        } else if (needsLiveFallback) {
          if (Number.isFinite(expectedCompletedWeek)) {
            console.warn(
              `[loadSchedules] Manifest schedule for season ${targetSeason ?? y} is stale (scores through week ${manifestMax}); ` +
                `expected completion >= week ${expectedCompletedWeek}. Falling back to live feed.`
            );
          } else {
            console.warn(
              `[loadSchedules] Manifest schedule for season ${targetSeason ?? y} appears stale – falling back to live feed.`
            );
          }
        }
      }

      const liveCandidate = await fetchScheduleCandidate(
        REL.schedules(targetSeason ?? y),
        targetSeason ?? y,
        'static'
      );
      if (liveCandidate.rows.length) {
        candidate = liveCandidate;
      }
    }

    if (!candidate) {
      throw new Error('[loadSchedules] Unable to resolve schedules dataset');
    }

    const filteredRows = candidate.rows;
    const effectiveSeason = candidate.effectiveSeason;
    if (effectiveSeason != null && cacheKey === ALL_SCHEDULES_KEY) {
      caches.schedules.set(effectiveSeason, filteredRows);
    }

    console.log(
      `[loadSchedules] OK ${candidate.source}${describeSourceType(candidate)} rows=${filteredRows.length} checksum=${candidate.checksum.slice(0, 12)}` +
        (effectiveSeason != null ? ` season=${effectiveSeason}` : '')
    );
    return filteredRows;
  }, {
    inspect: (rows) => inspectData('schedules', rows, { season: targetSeason ?? resolvedSeason ?? null })
  });
}
export async function loadESPNQBR(){
  return cached(caches.qbr, 0, async()=>{
    const {rows,source,checksum} = await fetchCsvFlexible(REL.qbr());
    sanityCheckRows('qbr', rows);
    console.log(`[loadESPNQBR] OK ${source} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
    return rows;
  }, {
    inspect: (rows) => inspectData('qbr', rows, { season: null })
  });
}
export async function loadOfficials(){
  return cached(caches.officials, 0, async()=>{
    const {rows,source,checksum} = await fetchCsvFlexible(REL.officials());
    sanityCheckRows('officials', rows);
    console.log(`[loadOfficials] OK ${source} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
    return rows;
  }, {
    inspect: (rows) => inspectData('officials', rows, { season: null })
  });
}
const NEXT_GEN_TYPE_KEYS = new Map([
  ['passing', 'nextGenPassing'],
  ['rushing', 'nextGenRushing'],
  ['receiving', 'nextGenReceiving']
]);

/**
 * Loads Next Gen Stats tracking feed for the requested season/stat split. Headers include
 * avg_time_to_throw (seconds from snap to release, numeric), aggressiveness (tight-window throw rate, percent),
 * and expected_yac (modeled yards after catch, numeric). Coverage begins with the 2016 season.
 *
 * @param {number|string} season - Season to request (e.g., 2023).
 * @param {'passing'|'rushing'|'receiving'} [statType='passing'] - Tracking split to fetch.
 * @returns {Promise<object[]>} Parsed tracking rows for the requested split/season.
 */
export async function loadNextGenStats(season, statType = 'passing') {
  const y = toInt(season);
  if (y == null) throw new Error('loadNextGenStats season');
  const normalizedType = String(statType ?? 'passing').toLowerCase();
  const datasetKey = NEXT_GEN_TYPE_KEYS.get(normalizedType);
  if (!datasetKey) {
    throw new Error(`loadNextGenStats unsupported stat_type=${statType}`);
  }
  if (y < 2016) {
    console.warn(`[loadNextGenStats] season ${y} precedes tracking availability; returning empty set for ${normalizedType}`);
    return inspectData('nextGenStats', [], { season: y, statType: normalizedType });
  }
  return cached(caches.nextGenStats, `${y}|${normalizedType}`, async()=>{
    const resolved = await resolveDatasetUrl(datasetKey, y, (seasonVal) => {
      const relFactory = REL[datasetKey];
      return typeof relFactory === 'function' ? relFactory(seasonVal) : null;
    });
    const fallbackFactory = REL[datasetKey];
    const targetUrl = resolved?.url ?? (typeof fallbackFactory === 'function' ? fallbackFactory(y) : null);
    if (!targetUrl) {
      console.warn(`[loadNextGenStats] unable to resolve ${normalizedType} tracking for season ${y}`);
      return [];
    }
    const { rows, source, checksum } = await fetchCsvFlexible(targetUrl);
    sanityCheckRows('nextGenStats', rows);
    const sourceLabel = resolved?.source || source;
    console.log(
      `[loadNextGenStats/${normalizedType}] OK ${sourceLabel} rows=${rows.length} checksum=${checksum.slice(0, 12)}`
    );
    return rows;
  }, {
    inspect: (rows) => inspectData('nextGenStats', rows, { season: y, statType: normalizedType })
  });
}

/**
 * Loads nflverse pbp_participation personnel tracking (offense/defense/special teams per play).
 * Provides offense_players, defense_players, and special_teams_players columns describing on-field groupings.
 * Data availability starts in 2016 with tracking-era charting.
 *
 * @param {number|string} season - Season year requested.
 * @returns {Promise<object[]>} Parsed participation rows for the season.
 */
export async function loadParticipation(season) {
  const y = toInt(season);
  if (y == null) throw new Error('loadParticipation season');
  if (y < 2016) {
    console.warn(`[loadParticipation] season ${y} precedes personnel tracking availability; returning []`);
    return inspectData('participation', [], { season: y });
  }
  return cached(caches.participation, y, async()=>{
    const resolved = await resolveDatasetUrl('participation', y, REL.participation);
    const targetUrl = resolved?.url ?? REL.participation(y);
    if (!targetUrl) {
      console.warn(`[loadParticipation] unable to resolve participation feed for season ${y}`);
      return [];
    }
    const { rows, source, checksum } = await fetchCsvFlexible(targetUrl);
    sanityCheckRows('participation', rows);
    const label = resolved?.source || source;
    console.log(`[loadParticipation] OK ${label} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
    return rows;
  }, {
    inspect: (rows) => inspectData('participation', rows, { season: y })
  });
}

export async function loadSnapCounts(season){
  const y = toInt(season); if(y==null) throw new Error('loadSnapCounts season');
  return cached(caches.snapCounts, y, async()=>{
    const resolved = await resolveDatasetUrl('snapCounts', y, REL.snapCounts);
    const targetUrl = resolved?.url ?? REL.snapCounts(y);
    const {rows,source,checksum} = await fetchCsvFlexible(targetUrl);
    sanityCheckRows('snapCounts', rows);
    console.log(`[loadSnapCounts] OK ${source} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
    return rows;
  }, {
    inspect: (rows) => inspectData('snapCounts', rows, { season: y })
  });
}
export async function loadTeamWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadTeamWeekly season');
  return cached(caches.teamWeekly, y, async()=>{
    const resolved = await resolveDatasetUrl('teamWeekly', y, REL.teamWeekly);
    const targetUrl = resolved?.url ?? REL.teamWeekly(y);
    const {rows,source,checksum} = await fetchCsvFlexible(targetUrl);
    sanityCheckRows('teamWeekly', rows);
    console.log(`[loadTeamWeekly] OK ${source} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
    return rows;
  }, {
    inspect: (rows) => inspectData('teamWeekly', rows, { season: y })
  });
}
// legacy alias in code -> keep signature
export async function loadTeamGameAdvanced(season){
  return loadTeamWeekly(season);
}
export async function loadPlayerWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadPlayerWeekly season');
  return cached(caches.playerWeekly, y, async()=>{
    const resolved = await resolveDatasetUrl('playerWeekly', y, REL.playerWeekly);
    const targetUrl = resolved?.url ?? REL.playerWeekly(y);
    const {rows,source,checksum} = await fetchCsvFlexible(targetUrl);
    sanityCheckRows('playerWeekly', rows);
    console.log(`[loadPlayerWeekly] OK ${source} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
    return rows;
  }, {
    inspect: (rows) => inspectData('playerWeekly', rows, { season: y })
  });
}
export async function loadRostersWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadRostersWeekly season');
  return cached(caches.rosterWeekly, y, async()=>{
    const resolved = await resolveDatasetUrl('rosterWeekly', y, REL.rosterWeekly);
    const targetUrl = resolved?.url ?? REL.rosterWeekly(y);
    try {
      const {rows,source,checksum} = await fetchCsvFlexible(targetUrl);
      sanityCheckRows('rosterWeekly', rows);
      console.log(`[loadRostersWeekly] OK ${source} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
      return rows;
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes('404')) {
        console.warn(`[loadRostersWeekly] missing data for season ${y} at ${targetUrl}: ${msg}`);
        return [];
      }
      throw err;
    }
  }, {
    inspect: (rows) => inspectData('rosterWeekly', rows, { season: y })
  });
}
export async function loadDepthCharts(season){
  const y = toInt(season); if(y==null) throw new Error('loadDepthCharts season');
  return cached(caches.depthCharts, y, async()=>{
    const resolved = await resolveDatasetUrl('depthCharts', y, REL.depthCharts);
    const targetUrl = resolved?.url ?? REL.depthCharts(y);
    const {rows,source,checksum} = await fetchCsvFlexible(targetUrl);
    sanityCheckRows('depthCharts', rows);
    console.log(`[loadDepthCharts] OK ${source} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
    return rows;
  }, {
    inspect: (rows) => inspectData('depthCharts', rows, { season: y })
  });
}
export async function loadFTNCharts(season){
  const y = toInt(season); if(y==null) throw new Error('loadFTNCharts season');
  return cached(caches.ftnCharts, y, async()=>{
    const resolved = await resolveDatasetUrl('ftnCharts', y, REL.ftnCharts);
    const targetUrl = resolved?.url ?? REL.ftnCharts(y);
    const {rows,source,checksum} = await fetchCsvFlexible(targetUrl);
    sanityCheckRows('ftnCharts', rows);
    console.log(`[loadFTNCharts] OK ${source} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
    return rows;
  }, {
    inspect: (rows) => inspectData('ftnCharts', rows, { season: y })
  });
}
export async function loadPBP(season){
  const y = toInt(season); if(y==null) throw new Error('loadPBP season');
  const loader = async()=>{
    const resolved = await resolveDatasetUrl('pbp', y, REL.pbp);
    const targetUrl = resolved?.url ?? REL.pbp(y);
    try {
      const { rows, checksum } = await fetchPbpSeason(targetUrl, y);
      sanityCheckRows('pbp', rows);
      const source = resolved?.url ?? targetUrl;
      console.log(`[loadPBP] OK ${source} rows=${rows.length} checksum=${checksum.slice(0, 12)}`);
      return rows;
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes('404')) {
        console.warn(`[loadPBP] missing data for season ${y} at ${targetUrl}: ${msg}`);
        return [];
      }
      throw err;
    }
  };
  if (PBP_CACHE_LIMIT === 0) {
    if (caches.pbp.size) caches.pbp.clear();
    const rows = await loader();
    return inspectData('pbp', rows, { season: y });
  }
  return cached(caches.pbp, y, loader, {
    maxSize: PBP_CACHE_LIMIT,
    inspect: (rows) => inspectData('pbp', rows, { season: y })
  });
}

// ---------- PFR advanced weekly (merge rush/def/pass/rec) ----------
function toNumOrNull(v){ if(v===''||v==null) return null; const n=Number(v); return Number.isFinite(n)?n:null; }
function extractKeys(row){
  const season = toInt(row.season ?? row.yr ?? row.year);
  const week   = toInt(row.week ?? row.wk);
  const team   = String(row.team ?? row.team_abbr ?? row.TEAM ?? '').toUpperCase();
  return { season, week, team };
}
function prefixPhase(rows, phase){
  const out=[];
  for(const r of rows){
    const {season,week,team}=extractKeys(r);
    if(season==null||week==null||!team) continue;
    const o={season,week,team};
    for(const [k,v] of Object.entries(r)){
      const lk = k.toLowerCase();
      if(['season','yr','year','week','wk','team','team_abbr','team_name'].includes(lk)) continue;
      const n=toNumOrNull(v); if(n==null) continue;
      o[`${phase}_${lk}`]=n;
    }
    out.push(o);
  }
  return out;
}
function mergeByKey(...arrays){
  const key = (r)=>`${r.season}|${r.week}|${r.team}`;
  const map = new Map();
  for(const arr of arrays){
    for(const r of arr){
      const k=key(r);
      if(!map.has(k)) map.set(k,{season:r.season,week:r.week,team:r.team});
      Object.assign(map.get(k), r);
    }
  }
  return map;
}
export async function loadPFRAdvTeamWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadPFRAdvTeamWeekly season');
  return cached(caches.pfrAdv, y, async()=>{
    const [rush,defn,pass,rec] = await Promise.all([
      resolveDatasetUrl('pfrRush', y, REL.pfrRush).then((u)=>u?.url || REL.pfrRush(y)).then((url)=>fetchCsvFlexible(url).then(x=>x.rows)).catch(()=>[]),
      resolveDatasetUrl('pfrDef', y, REL.pfrDef).then((u)=>u?.url || REL.pfrDef(y)).then((url)=>fetchCsvFlexible(url).then(x=>x.rows)).catch(()=>[]),
      resolveDatasetUrl('pfrPass', y, REL.pfrPass).then((u)=>u?.url || REL.pfrPass(y)).then((url)=>fetchCsvFlexible(url).then(x=>x.rows)).catch(()=>[]),
      resolveDatasetUrl('pfrRec', y, REL.pfrRec).then((u)=>u?.url || REL.pfrRec(y)).then((url)=>fetchCsvFlexible(url).then(x=>x.rows)).catch(()=>[]),
    ]);
    const map = mergeByKey(
      prefixPhase(rush,'rush'),
      prefixPhase(defn,'def'),
      prefixPhase(pass,'pass'),
      prefixPhase(rec,'rec')
    );
    console.log(`[loadPFRAdvTeamWeekly] merged=${map.size}`);
    return map;
  }, {
    inspect: (map) => {
      const rows = map && typeof map.values === 'function' ? Array.from(map.values()) : [];
      inspectData('pfrAdvTeamWeekly', rows, { season: y });
    }
  });
}
export async function loadPFRAdvTeamWeeklyArray(season){
  const m = await loadPFRAdvTeamWeekly(season);
  return Array.from(m.values());
}

// ---- compatibility aliases (your code imports these) ----
export async function loadPFRAdvTeam(season){
  // Return array for backward compatibility with existing callers
  return loadPFRAdvTeamWeeklyArray(season);
}

export async function loadMarkets(season){
  const y = toInt(season);
  if (y == null) throw new Error('loadMarkets season');
  return cached(caches.markets, y, async()=>{
    try {
      // Artifacts created by `scripts/fetchRotowireMarkets.js`, which fetches
      // https://www.rotowire.com/betting/nfl/tables/nfl-games-by-market.php?week=<week>
      const rows = await loadRotowireMarketArtifacts(y);
      if (rows.length) {
        console.log(`[loadMarkets] using Rotowire market artifacts rows=${rows.length}`);
      } else {
        console.warn('[loadMarkets] Rotowire market artifacts empty');
      }
      return rows;
    } catch (err) {
      console.warn(`[loadMarkets] Rotowire market artifacts load failed: ${err?.message || err}`);
      return [];
    }
  }, {
    inspect: (rows) => inspectData('markets', rows, { season: y })
  });
}

export async function loadWeather(season){
  const y = toInt(season);
  if (y == null) throw new Error('loadWeather season');
  return cached(caches.weather, y, async()=>{
    try {
      const rows = await loadRotowireWeatherArtifacts(y);
      if (rows.length) {
        console.log(`[loadWeather] using Rotowire weather artifacts rows=${rows.length}`);
      } else {
        console.warn('[loadWeather] Rotowire weather artifacts empty');
      }
      return rows;
    } catch (err) {
      console.warn(`[loadWeather] Rotowire weather artifacts load failed: ${err?.message || err}`);
      return [];
    }
  }, {
    inspect: (rows) => inspectData('weather', rows, { season: y })
  });
}

export async function loadInjuries(season){
  const y = toInt(season);
  if (y == null) throw new Error('loadInjuries season');
  return cached(caches.injuries, y, async()=>{
    try {
      const rows = await loadRotowireArtifacts(y);
      if (rows.length) {
        console.log(`[loadInjuries] using Rotowire artifacts rows=${rows.length}`);
        return rows;
      }
      console.warn('[loadInjuries] Rotowire artifacts empty');
      return rows;
    } catch (err) {
      console.warn(`[loadInjuries] Rotowire artifacts load failed: ${err?.message || err}`);
      return [];
    }
  }, {
    inspect: (rows) => inspectData('injuries', rows, { season: y })
  });
}
