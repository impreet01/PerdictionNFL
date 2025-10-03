// trainer/dataSources.js
import { parse } from 'csv-parse/sync';
import zlib from 'node:zlib';

import {
  adaptDepthCharts,
  adaptESPNQBR,
  adaptInjuries,
  adaptPlayerWeekly,
  adaptRostersWeekly,
  adaptSchedules,
  adaptSnapCounts,
  adaptTeamGameAdvanced,
  adaptTeamWeekly,
  adaptOfficials
} from './apiAdapter.js';
import {
  assertBTFeatureRow,
  assertScheduleRow,
  assertTeamWeeklyRow
} from './schemaChecks.js';
import { fetchTank01, tank01EnabledForSeason } from './tank01Client.js';
import {
  extractFirstArray,
  mapTank01DepthChart,
  mapTank01Injury,
  mapTank01Odds,
  mapTank01PlayerWeek,
  mapTank01Play,
  mapTank01Projection,
  mapTank01Roster,
  mapTank01Schedule,
  mapTank01TeamWeek
} from './tank01Transforms.js';

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

const PUBLIC_ENDPOINT_ENV = {
  schedules: process.env.PUBLIC_API_SCHEDULES_URL,
  teamWeekly: process.env.PUBLIC_API_TEAM_WEEKLY_URL,
  teamGameAdvanced: process.env.PUBLIC_API_TEAM_GAME_ADVANCED_URL,
  playerWeekly: process.env.PUBLIC_API_PLAYER_WEEKLY_URL,
  rostersWeekly: process.env.PUBLIC_API_ROSTERS_WEEKLY_URL,
  depthCharts: process.env.PUBLIC_API_DEPTH_CHARTS_URL,
  injuries: process.env.PUBLIC_API_INJURIES_URL,
  snapCounts: process.env.PUBLIC_API_SNAP_COUNTS_URL,
  espnQbr: process.env.PUBLIC_API_ESPN_QBR_URL,
  officials: process.env.PUBLIC_API_OFFICIALS_URL
};

const PUBLIC_API_BASE = process.env.PUBLIC_API_BASE?.replace(/\/+$/, '');
const PUBLIC_API_TIMEOUT_MS = Number(process.env.PUBLIC_API_TIMEOUT_MS ?? 15000);
const PUBLIC_API_HEADERS = {
  'user-agent': 'perdiction-nfl-adapter',
  accept: 'application/json'
};

const applyTemplate = (template, context = {}) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = context[key];
    return value == null ? '' : String(value);
  });

const resolvePublicUrl = (kind, context = {}) => {
  const template = PUBLIC_ENDPOINT_ENV[kind];
  if (template) return applyTemplate(template, context);
  if (!PUBLIC_API_BASE) return null;
  if (!context?.season) return null;
  switch (kind) {
    case 'schedules':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/schedule`;
    case 'teamWeekly':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/teams/weekly`;
    case 'teamGameAdvanced':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/games/advanced`;
    case 'playerWeekly':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/players/weekly`;
    case 'rostersWeekly':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/rosters/weekly`;
    case 'depthCharts':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/depth-charts`;
    case 'injuries':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/injuries`;
    case 'snapCounts':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/snap-counts`;
    case 'espnQbr':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/espn-qbr`;
    case 'officials':
      return `${PUBLIC_API_BASE}/seasons/${context.season}/officials`;
    default:
      return null;
  }
};

async function fetchPublicDataset(kind, context = {}) {
  const url = resolvePublicUrl(kind, context);
  if (!url) throw new Error('public API endpoint not configured');
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
        controller.abort();
      }, PUBLIC_API_TIMEOUT_MS)
    : null;
  try {
    const res = await fetch(url, {
      headers: PUBLIC_API_HEADERS,
      signal: controller?.signal
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    const data = await res.json();
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const logPublicFallback = (label, err) => {
  const reason = err?.message || err?.statusText || String(err);
  console.warn(`[${label}] public API failed, falling back to nflverse: ${reason}`);
};

async function fetchGithubJson(url) {
  const res = await fetch(url, { headers: GH_HEADERS });
  if (res.status === 404) throw Object.assign(new Error('Not found'), { status: 404 });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub API ${res.status}: ${txt}`);
  }
  return res.json();
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
};

// ---------- helpers/caches ----------
export function toInt(v){ const n = parseInt(v,10); return Number.isFinite(n) ? n : null; }
const isGz = (u)=>u.endsWith('.gz');

async function fetchBuffer(url){
  const res = await fetch(url, { redirect:'follow', headers:{'User-Agent':'nflverse-loader'}});
  if(!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(new Uint8Array(await res.arrayBuffer()));
}
function gunzipMaybe(buf,url){ return isGz(url) ? zlib.gunzipSync(buf) : buf; }
export async function fetchCsvFlexible(url){
  const buf = await fetchBuffer(url);
  const txt = gunzipMaybe(buf,url).toString('utf8');
  const rows = parse(txt, { columns:true, skip_empty_lines:true, relax_column_count:true, trim:true });
  return { rows, source:url };
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
  teamGameAdvanced: new Map(),
  pbp:         new Map(),
  pfrAdv:      new Map(), // merged weekly map (season)
  injuries:    new Map(),
  odds:        new Map(),
  projections: new Map()
};

const tankCaches = {
  schedules:   new Map(),
  teamWeekly:  new Map(),
  playerWeekly:new Map(),
  rosterWeekly:new Map(),
  depthCharts: new Map(),
  injuries:    new Map(),
  odds:        new Map(),
  projections: new Map(),
  pbp:         new Map()
};

const tankLogOnce = new Set();
const tankMemo = new Map();

const tankMemoKey = (dataset, season) => `${dataset}:${season}`;

async function cached(store,key,loader){
  if(store.has(key)) return store.get(key);
  const val = await loader();
  store.set(key,val);
  return val;
}

async function withTankFallback(dataset, season, loader, fallback) {
  const y = toInt(season);
  const cache = tankCaches[dataset];
  if (!tank01EnabledForSeason(y)) {
    return fallback();
  }
  if (cache && cache.has(y)) {
    const cachedValue = cache.get(y);
    if (cachedValue != null) return cachedValue;
  }
  try {
    const result = await loader();
    if (Array.isArray(result) ? result.length > 0 : result != null) {
      if (cache) cache.set(y, result);
      if (process.env.LOG_LEVEL?.toLowerCase() === 'debug') {
        const count = Array.isArray(result) ? result.length : typeof result;
        console.debug(`[tank01] ${dataset} season=${y} using Tank01 (${count})`);
      }
      return result;
    }
    if (cache) cache.set(y, null);
  } catch (err) {
    const key = `${dataset}:${y}`;
    if (!tankLogOnce.has(key)) {
      console.warn(`[tank01] ${dataset} season=${y} failed: ${err?.message || err}`);
      tankLogOnce.add(key);
    }
    if (cache) cache.set(y, null);
  }
  return fallback();
}

async function memoizedTank(dataset, season, loader) {
  const key = tankMemoKey(dataset, season);
  if (tankMemo.has(key)) return tankMemo.get(key);
  const value = await loader();
  tankMemo.set(key, value);
  return value;
}

// ---------- canonical loaders (exact paths) ----------
export async function loadSchedules(season){
  const y = toInt(season);
  const resolved = await resolveDatasetUrl('schedules', y, REL.schedules);
  const resolvedSeason = resolved?.season != null ? toInt(resolved.season) : null;
  const targetSeason = y ?? resolvedSeason;
  const cacheKey = targetSeason ?? ALL_SCHEDULES_KEY;
  return cached(caches.schedules, cacheKey, async()=>{
    const loadFallback = async () => {
      const targetUrl = resolved?.url ?? REL.schedules(targetSeason ?? y);
      const {rows,source} = await fetchCsvFlexible(targetUrl);
      let effectiveSeason = targetSeason;
      if (effectiveSeason == null) {
        for (const row of rows) {
          const rowSeason = toInt(row.season);
          if (rowSeason != null && (effectiveSeason == null || rowSeason > effectiveSeason)) {
            effectiveSeason = rowSeason;
          }
        }
      }
      const filteredRows = effectiveSeason == null ? rows : rows.filter((r)=>toInt(r.season) === effectiveSeason);
      if (effectiveSeason != null && cacheKey === ALL_SCHEDULES_KEY) {
        caches.schedules.set(effectiveSeason, filteredRows);
      }
      console.log(
        `[loadSchedules] OK ${source} rows=${filteredRows.length}` +
        (effectiveSeason != null ? ` season=${effectiveSeason}` : '')
      );
      return filteredRows;
    };

    const seasonForPublic = Number.isFinite(targetSeason) ? targetSeason : Number.isFinite(y) ? y : null;
    if (Number.isFinite(seasonForPublic)) {
      try {
        const payload = await fetchPublicDataset('schedules', { season: seasonForPublic });
        const rows = adaptSchedules(payload);
        rows.forEach(assertScheduleRow);
        if (rows.length) {
          console.log(`[loadSchedules] OK public rows=${rows.length} season=${seasonForPublic}`);
          if (cacheKey === ALL_SCHEDULES_KEY) {
            caches.schedules.set(seasonForPublic, rows);
          }
          return rows;
        }
        throw new Error('no schedule rows returned');
      } catch (err) {
        logPublicFallback('loadSchedules', err);
      }
    }

    if (Number.isFinite(targetSeason) && tank01EnabledForSeason(targetSeason)) {
      return withTankFallback('schedules', targetSeason, () => loadTank01Schedules(targetSeason), loadFallback);
    }

    return loadFallback();
  });
}
export async function loadESPNQBR(season){
  const y = toInt(season);
  const cacheKey = Number.isFinite(y) ? y : 0;
  return cached(caches.qbr, cacheKey, async()=>{
    if (Number.isFinite(y)) {
      try {
        const payload = await fetchPublicDataset('espnQbr', { season: y });
        const rows = adaptESPNQBR(payload);
        if (rows.length) {
          console.log(`[loadESPNQBR] OK public rows=${rows.length} season=${y}`);
          return rows;
        }
        throw new Error('no qbr rows returned');
      } catch (err) {
        logPublicFallback('loadESPNQBR', err);
      }
    }
    const {rows,source} = await fetchCsvFlexible(REL.qbr());
    console.log(`[loadESPNQBR] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadOfficials(season){
  const y = toInt(season);
  const cacheKey = Number.isFinite(y) ? y : 0;
  return cached(caches.officials, cacheKey, async()=>{
    if (Number.isFinite(y)) {
      try {
        const payload = await fetchPublicDataset('officials', { season: y });
        const rows = adaptOfficials(payload);
        if (rows.length) {
          console.log(`[loadOfficials] OK public rows=${rows.length} season=${y}`);
          return rows;
        }
        throw new Error('no officials rows returned');
      } catch (err) {
        logPublicFallback('loadOfficials', err);
      }
    }
    const {rows,source} = await fetchCsvFlexible(REL.officials());
    console.log(`[loadOfficials] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadSnapCounts(season){
  const y = toInt(season); if(y==null) throw new Error('loadSnapCounts season');
  return cached(caches.snapCounts, y, async()=>{
    try {
      const payload = await fetchPublicDataset('snapCounts', { season: y });
      const rows = adaptSnapCounts(payload);
      if (rows.length) {
        console.log(`[loadSnapCounts] OK public rows=${rows.length}`);
        return rows;
      }
      throw new Error('no snap count rows returned');
    } catch (err) {
      logPublicFallback('loadSnapCounts', err);
    }

    const resolved = await resolveDatasetUrl('snapCounts', y, REL.snapCounts);
    const targetUrl = resolved?.url ?? REL.snapCounts(y);
    const {rows,source} = await fetchCsvFlexible(targetUrl);
    console.log(`[loadSnapCounts] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadTeamWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadTeamWeekly season');
  return cached(caches.teamWeekly, y, async()=>{
    try {
      const payload = await fetchPublicDataset('teamWeekly', { season: y });
      const rows = adaptTeamWeekly(payload);
      rows.forEach(assertTeamWeeklyRow);
      if (rows.length) {
        console.log(`[loadTeamWeekly] OK public rows=${rows.length}`);
        return rows;
      }
      throw new Error('no team weekly rows returned');
    } catch (err) {
      logPublicFallback('loadTeamWeekly', err);
    }

    const loadFallback = async () => {
      const resolved = await resolveDatasetUrl('teamWeekly', y, REL.teamWeekly);
      const targetUrl = resolved?.url ?? REL.teamWeekly(y);
      const {rows,source} = await fetchCsvFlexible(targetUrl);
      const adapted = adaptTeamWeekly(rows);
      adapted.forEach(assertTeamWeeklyRow);
      console.log(`[loadTeamWeekly] OK ${source} rows=${adapted.length}`);
      return adapted;
    };

    if (tank01EnabledForSeason(y)) {
      return withTankFallback('teamWeekly', y, () => loadTank01TeamWeekly(y), loadFallback);
    }

    return loadFallback();
  });
}
export async function loadTeamGameAdvanced(season){
  const y = toInt(season); if(y==null) throw new Error('loadTeamGameAdvanced season');
  return cached(caches.teamGameAdvanced, y, async()=>{
    try {
      const payload = await fetchPublicDataset('teamGameAdvanced', { season: y });
      const rows = adaptTeamGameAdvanced(payload);
      rows.forEach(assertBTFeatureRow);
      if (rows.length) {
        console.log(`[loadTeamGameAdvanced] OK public rows=${rows.length}`);
        return rows;
      }
      throw new Error('no team game advanced rows returned');
    } catch (err) {
      logPublicFallback('loadTeamGameAdvanced', err);
    }

    return loadTeamWeekly(y);
  });
}
export async function loadPlayerWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadPlayerWeekly season');
  return cached(caches.playerWeekly, y, async()=>{
    try {
      const payload = await fetchPublicDataset('playerWeekly', { season: y });
      const rows = adaptPlayerWeekly(payload);
      if (rows.length) {
        console.log(`[loadPlayerWeekly] OK public rows=${rows.length}`);
        return rows;
      }
      throw new Error('no player weekly rows returned');
    } catch (err) {
      logPublicFallback('loadPlayerWeekly', err);
    }

    const loadFallback = async () => {
      const resolved = await resolveDatasetUrl('playerWeekly', y, REL.playerWeekly);
      const targetUrl = resolved?.url ?? REL.playerWeekly(y);
      const {rows,source} = await fetchCsvFlexible(targetUrl);
      console.log(`[loadPlayerWeekly] OK ${source} rows=${rows.length}`);
      return rows;
    };

    if (tank01EnabledForSeason(y)) {
      return withTankFallback('playerWeekly', y, () => loadTank01PlayerWeekly(y), loadFallback);
    }

    return loadFallback();
  });
}
export async function loadRostersWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadRostersWeekly season');
  return cached(caches.rosterWeekly, y, async()=>{
    try {
      const payload = await fetchPublicDataset('rostersWeekly', { season: y });
      const rows = adaptRostersWeekly(payload);
      if (rows.length) {
        console.log(`[loadRostersWeekly] OK public rows=${rows.length}`);
        return rows;
      }
      throw new Error('no roster rows returned');
    } catch (err) {
      logPublicFallback('loadRostersWeekly', err);
    }

    const loadFallback = async () => {
      const resolved = await resolveDatasetUrl('rosterWeekly', y, REL.rosterWeekly);
      const targetUrl = resolved?.url ?? REL.rosterWeekly(y);
      const {rows,source} = await fetchCsvFlexible(targetUrl);
      console.log(`[loadRostersWeekly] OK ${source} rows=${rows.length}`);
      return rows;
    };

    if (tank01EnabledForSeason(y)) {
      return withTankFallback('rosterWeekly', y, () => loadTank01Rosters(y), loadFallback);
    }

    return loadFallback();
  });
}
export async function loadDepthCharts(season){
  const y = toInt(season); if(y==null) throw new Error('loadDepthCharts season');
  return cached(caches.depthCharts, y, async()=>{
    try {
      const payload = await fetchPublicDataset('depthCharts', { season: y });
      const rows = adaptDepthCharts(payload);
      if (rows.length) {
        console.log(`[loadDepthCharts] OK public rows=${rows.length}`);
        return rows;
      }
      throw new Error('no depth chart rows returned');
    } catch (err) {
      logPublicFallback('loadDepthCharts', err);
    }

    const loadFallback = async () => {
      const resolved = await resolveDatasetUrl('depthCharts', y, REL.depthCharts);
      const targetUrl = resolved?.url ?? REL.depthCharts(y);
      const {rows,source} = await fetchCsvFlexible(targetUrl);
      console.log(`[loadDepthCharts] OK ${source} rows=${rows.length}`);
      return rows;
    };

    if (tank01EnabledForSeason(y)) {
      return withTankFallback('depthCharts', y, () => loadTank01DepthCharts(y), loadFallback);
    }

    return loadFallback();
  });
}
export async function loadFTNCharts(season){
  const y = toInt(season); if(y==null) throw new Error('loadFTNCharts season');
  return cached(caches.ftnCharts, y, async()=>{
    const resolved = await resolveDatasetUrl('ftnCharts', y, REL.ftnCharts);
    const targetUrl = resolved?.url ?? REL.ftnCharts(y);
    const {rows,source} = await fetchCsvFlexible(targetUrl);
    console.log(`[loadFTNCharts] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadPBP(season){
  const y = toInt(season); if(y==null) throw new Error('loadPBP season');
  return cached(caches.pbp, y, async()=>{
    const loadFallback = async () => {
      const resolved = await resolveDatasetUrl('pbp', y, REL.pbp);
      const targetUrl = resolved?.url ?? REL.pbp(y);
      const {rows,source} = await fetchCsvFlexible(targetUrl);
      console.log(`[loadPBP] OK ${source} rows=${rows.length}`);
      return rows;
    };

    if (tank01EnabledForSeason(y)) {
      return withTankFallback('pbp', y, () => loadTank01PBP(y), loadFallback);
    }

    return loadFallback();
  });
}

async function loadTank01Schedules(season){
  const y = toInt(season);
  if (!Number.isFinite(y)) return [];
  return memoizedTank('tank-schedules', y, async () => {
    const candidates = [
      { path: '/getNFLGamesForSeason', params: { season: y } },
      { path: '/getNFLGameSchedule', params: { season: y } }
    ];
    let rows = [];
    for (const spec of candidates) {
      try {
        const payload = await fetchTank01(spec.path, { params: spec.params });
        const arr = extractFirstArray(payload);
        if (arr.length) {
          rows = arr;
          break;
        }
      } catch (err) {
        // ignore and try next candidate
      }
    }
    if (!rows.length) {
      const weeks = Array.from({ length: 22 }, (_, idx) => idx + 1);
      for (const week of weeks) {
        try {
          const payload = await fetchTank01('/getNFLGamesForWeek', {
            params: { season: y, week, seasonType: 'REG' }
          });
          const arr = extractFirstArray(payload);
          if (!arr.length) continue;
          for (const row of arr) {
            rows.push({ ...row, weekNumber: row.weekNumber ?? row.week ?? week });
          }
        } catch (err) {
          // ignore individual week failures
        }
      }
    }
    const gameMap = new Map();
    for (const raw of rows) {
      const mapped = mapTank01Schedule(raw, {
        season: y,
        week: raw.weekNumber ?? raw.week ?? raw.week_no
      });
      if (!mapped) continue;
      const key = mapped.game_id;
      if (!gameMap.has(key)) {
        gameMap.set(key, mapped);
      } else {
        gameMap.set(key, { ...gameMap.get(key), ...mapped });
      }
    }
    const result = Array.from(gameMap.values());
    result.sort((a, b) => (Number(a.week) || 0) - (Number(b.week) || 0));
    return result;
  });
}

function buildTankOpponentIndex(games = []) {
  const map = new Map();
  for (const game of games) {
    const week = Number(game.week);
    const home = String(game.home_team || '').toUpperCase();
    const away = String(game.away_team || '').toUpperCase();
    if (Number.isFinite(week) && home) {
      map.set(`${week}|${home}`, away || null);
    }
    if (Number.isFinite(week) && away) {
      map.set(`${week}|${away}`, home || null);
    }
  }
  return map;
}

async function loadTank01TeamWeekly(season){
  const y = toInt(season);
  if (!Number.isFinite(y)) return [];
  return memoizedTank('tank-teamWeekly', y, async () => {
    const schedule = await loadTank01Schedules(y);
    const opponentIndex = buildTankOpponentIndex(schedule);
    const candidates = [
      { path: '/getNFLTeamWeeklyStats', params: { season: y } },
      { path: '/getNFLTeamStats', params: { season: y, seasonType: 'REG' } }
    ];
    let rows = [];
    for (const spec of candidates) {
      try {
        const payload = await fetchTank01(spec.path, { params: spec.params });
        const arr = extractFirstArray(payload);
        if (arr.length) {
          rows = arr;
          break;
        }
      } catch (err) {
        // continue
      }
    }
    if (!rows.length) {
      const teams = Array.from(new Set(schedule.flatMap((g) => [g.home_team, g.away_team].filter(Boolean))));
      for (const team of teams) {
        const perTeamCandidates = [
          { path: '/getNFLTeamWeeklyStats', params: { season: y, teamID: team } },
          { path: '/getNFLTeamStats', params: { season: y, teamID: team, seasonType: 'REG' } }
        ];
        for (const spec of perTeamCandidates) {
          try {
            const payload = await fetchTank01(spec.path, { params: spec.params });
            const arr = extractFirstArray(payload);
            if (!arr.length) continue;
            rows.push(...arr.map((r) => ({ ...r, team: r.team ?? team, teamID: r.teamID ?? team })));
            break;
          } catch (err) {
            // skip candidate
          }
        }
      }
    }
    const mapped = [];
    for (const raw of rows) {
      const week = toInt(raw.week ?? raw.weekNumber ?? raw.week_no);
      const team = String(raw.teamID ?? raw.team ?? '').toUpperCase();
      const opponent = opponentIndex.get(`${week}|${team}`);
      const mappedRow = mapTank01TeamWeek(raw, {
        season: y,
        week,
        team,
        opponent
      });
      if (mappedRow) mapped.push(mappedRow);
    }
    mapped.sort((a, b) =>
      (Number(a.week) || 0) - (Number(b.week) || 0) || String(a.team).localeCompare(String(b.team))
    );
    return mapped;
  });
}

async function loadTank01PlayerWeekly(season){
  const y = toInt(season);
  if (!Number.isFinite(y)) return [];
  return memoizedTank('tank-playerWeekly', y, async () => {
    const schedule = await loadTank01Schedules(y);
    const opponentIndex = buildTankOpponentIndex(schedule);
    const candidates = [
      { path: '/getNFLPlayerWeeklyStats', params: { season: y } },
      { path: '/getNFLPlayerStats', params: { season: y, seasonType: 'REG' } }
    ];
    let rows = [];
    for (const spec of candidates) {
      try {
        const payload = await fetchTank01(spec.path, { params: spec.params });
        const arr = extractFirstArray(payload);
        if (arr.length) {
          rows = arr;
          break;
        }
      } catch (err) {
        // continue
      }
    }
    if (!rows.length) {
      const teams = Array.from(new Set(schedule.flatMap((g) => [g.home_team, g.away_team].filter(Boolean))));
      for (const team of teams) {
        const perTeam = [
          { path: '/getNFLPlayerWeeklyStats', params: { season: y, teamID: team } },
          { path: '/getNFLPlayerStats', params: { season: y, teamID: team, seasonType: 'REG' } }
        ];
        for (const spec of perTeam) {
          try {
            const payload = await fetchTank01(spec.path, { params: spec.params });
            const arr = extractFirstArray(payload);
            if (!arr.length) continue;
            rows.push(...arr.map((r) => ({ ...r, team: r.team ?? team, recentTeam: r.recentTeam ?? team })));
            break;
          } catch (err) {
            // ignore
          }
        }
      }
    }
    const mapped = [];
    for (const raw of rows) {
      const week = toInt(raw.week ?? raw.weekNumber ?? raw.week_no);
      const team = String(raw.teamID ?? raw.team ?? raw.recentTeam ?? '').toUpperCase();
      const opponent = opponentIndex.get(`${week}|${team}`);
      const mappedRow = mapTank01PlayerWeek(raw, {
        season: y,
        week,
        team,
        opponent
      });
      if (mappedRow) mapped.push(mappedRow);
    }
    return mapped;
  });
}

async function loadTank01Rosters(season){
  const y = toInt(season);
  if (!Number.isFinite(y)) return [];
  return memoizedTank('tank-roster', y, async () => {
    const schedule = await loadTank01Schedules(y);
    const teams = Array.from(new Set(schedule.flatMap((g) => [g.home_team, g.away_team].filter(Boolean))));
    const mapped = [];
    const candidates = [
      { path: '/getNFLRosters', params: { season: y } }
    ];
    for (const spec of candidates) {
      try {
        const payload = await fetchTank01(spec.path, { params: spec.params });
        const arr = extractFirstArray(payload);
        if (arr.length) {
          for (const raw of arr) {
            const mappedRow = mapTank01Roster(raw, { season: y });
            if (mappedRow) mapped.push(mappedRow);
          }
          return mapped;
        }
      } catch (err) {
        // fall back to per-team
      }
    }
    for (const team of teams) {
      const perTeamCandidates = [
        { path: '/getNFLTeamRoster', params: { season: y, teamID: team } },
        { path: '/getNFLTeamRoster', params: { teamID: team } }
      ];
      for (const spec of perTeamCandidates) {
        try {
          const payload = await fetchTank01(spec.path, { params: spec.params });
          const arr = extractFirstArray(payload);
          if (!arr.length) continue;
          for (const raw of arr) {
            const mappedRow = mapTank01Roster(raw, { season: y, team });
            if (mappedRow) mapped.push(mappedRow);
          }
          break;
        } catch (err) {
          // ignore
        }
      }
    }
    return mapped;
  });
}

async function loadTank01DepthCharts(season){
  const y = toInt(season);
  if (!Number.isFinite(y)) return [];
  return memoizedTank('tank-depth', y, async () => {
    const schedule = await loadTank01Schedules(y);
    const teams = Array.from(new Set(schedule.flatMap((g) => [g.home_team, g.away_team].filter(Boolean))));
    const mapped = [];
    const candidates = [
      { path: '/getNFLDepthCharts', params: { season: y } }
    ];
    for (const spec of candidates) {
      try {
        const payload = await fetchTank01(spec.path, { params: spec.params });
        const arr = extractFirstArray(payload);
        if (arr.length) {
          for (const raw of arr) {
            const mappedRow = mapTank01DepthChart(raw, { season: y });
            if (mappedRow) mapped.push(mappedRow);
          }
          return mapped;
        }
      } catch (err) {
        // continue
      }
    }
    for (const team of teams) {
      const perTeamCandidates = [
        { path: '/getNFLTeamDepthChart', params: { season: y, teamID: team } },
        { path: '/getNFLTeamDepthChart', params: { teamID: team } }
      ];
      for (const spec of perTeamCandidates) {
        try {
          const payload = await fetchTank01(spec.path, { params: spec.params });
          const arr = extractFirstArray(payload);
          if (!arr.length) continue;
          for (const raw of arr) {
            const mappedRow = mapTank01DepthChart(raw, { season: y, team });
            if (mappedRow) mapped.push(mappedRow);
          }
          break;
        } catch (err) {
          // ignore
        }
      }
    }
    return mapped;
  });
}

async function loadTank01Injuries(season){
  const y = toInt(season);
  if (!Number.isFinite(y)) return [];
  return memoizedTank('tank-injuries', y, async () => {
    const candidates = [
      { path: '/getNFLInjuries', params: { season: y } }
    ];
    let rows = [];
    for (const spec of candidates) {
      try {
        const payload = await fetchTank01(spec.path, { params: spec.params });
        const arr = extractFirstArray(payload);
        if (arr.length) {
          rows = arr;
          break;
        }
      } catch (err) {
        // continue
      }
    }
    const mapped = [];
    for (const raw of rows) {
      const mappedRow = mapTank01Injury(raw, { season: y });
      if (mappedRow) mapped.push(mappedRow);
    }
    return mapped;
  });
}

async function loadTank01BettingOdds(season){
  const y = toInt(season);
  if (!Number.isFinite(y)) return [];
  return memoizedTank('tank-odds', y, async () => {
    const candidates = [
      { path: '/getNFLOdds', params: { season: y } },
      { path: '/getNFLBettingOdds', params: { season: y } }
    ];
    let rows = [];
    for (const spec of candidates) {
      try {
        const payload = await fetchTank01(spec.path, { params: spec.params });
        const arr = extractFirstArray(payload);
        if (arr.length) {
          rows = arr;
          break;
        }
      } catch (err) {
        // ignore
      }
    }
    const mapped = [];
    for (const raw of rows) {
      const mappedRow = mapTank01Odds(raw, { season: y });
      if (mappedRow) mapped.push(mappedRow);
    }
    return mapped;
  });
}

async function loadTank01Projections(season){
  const y = toInt(season);
  if (!Number.isFinite(y)) return [];
  return memoizedTank('tank-projections', y, async () => {
    const candidates = [
      { path: '/getNFLPlayerProjections', params: { season: y } },
      { path: '/getNFLProjections', params: { season: y } }
    ];
    let rows = [];
    for (const spec of candidates) {
      try {
        const payload = await fetchTank01(spec.path, { params: spec.params });
        const arr = extractFirstArray(payload);
        if (arr.length) {
          rows = arr;
          break;
        }
      } catch (err) {
        // continue
      }
    }
    const mapped = [];
    for (const raw of rows) {
      const mappedRow = mapTank01Projection(raw, { season: y });
      if (mappedRow) mapped.push(mappedRow);
    }
    return mapped;
  });
}

async function loadTank01PBP(season){
  const y = toInt(season);
  if (!Number.isFinite(y)) return [];
  return memoizedTank('tank-pbp', y, async () => {
    const schedule = await loadTank01Schedules(y);
    const rows = [];
    for (const game of schedule) {
      if (!game?.game_id) continue;
      try {
        const payload = await fetchTank01('/getNFLBoxScore', {
          params: {
            season: y,
            gameID: game.game_id,
            gameId: game.game_id,
            playByPlay: 'true'
          }
        });
        const playCandidates = extractFirstArray(payload?.playByPlay ?? payload?.plays ?? payload);
        for (const play of playCandidates) {
          const mappedPlay = mapTank01Play(play, {
            season: y,
            week: game.week,
            season_type: game.season_type,
            posteam: play.offenseTeam ?? play.offense ?? game.away_team,
            defteam: play.defenseTeam ?? play.defense ?? game.home_team
          });
          if (mappedPlay) rows.push(mappedPlay);
        }
      } catch (err) {
        // ignore missing play-by-play
      }
    }
    return rows;
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
let nflverseInjuryWarned = false;

export async function loadInjuries(season){
  const y = toInt(season);
  const fallback = async () => {
    if (!nflverseInjuryWarned) {
      console.warn('[loadInjuries] returning empty (no canonical weekly injuries csv in nflverse-data)');
      nflverseInjuryWarned = true;
    }
    return [];
  };

  if (Number.isFinite(y)) {
    try {
      const payload = await fetchPublicDataset('injuries', { season: y });
      const rows = adaptInjuries(payload);
      if (rows.length) {
        console.log(`[loadInjuries] OK public rows=${rows.length}`);
        return rows;
      }
      throw new Error('no injury rows returned');
    } catch (err) {
      logPublicFallback('loadInjuries', err);
    }
  }

  if (Number.isFinite(y) && tank01EnabledForSeason(y)) {
    return withTankFallback('injuries', y, () => loadTank01Injuries(y), fallback);
  }

  return fallback();
}

export async function loadBettingOdds(season){
  const y = toInt(season); if(y==null) throw new Error('loadBettingOdds season');
  return cached(caches.odds, y, async()=>{
    const fallback = async () => [];
    if (tank01EnabledForSeason(y)) {
      return withTankFallback('odds', y, () => loadTank01BettingOdds(y), fallback);
    }
    return fallback();
  });
}

export async function loadPlayerProjections(season){
  const y = toInt(season); if(y==null) throw new Error('loadPlayerProjections season');
  return cached(caches.projections, y, async()=>{
    const fallback = async () => [];
    if (tank01EnabledForSeason(y)) {
      return withTankFallback('projections', y, () => loadTank01Projections(y), fallback);
    }
    return fallback();
  });
}
