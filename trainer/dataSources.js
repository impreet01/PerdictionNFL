// trainer/dataSources.js
import { parse } from 'csv-parse/sync';
import zlib from 'node:zlib';

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

export const caches = {
  schedules:   new Map(), // key 0
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
};

async function cached(store,key,loader){
  if(store.has(key)) return store.get(key);
  const val = await loader();
  store.set(key,val);
  return val;
}

// ---------- canonical loaders (exact paths) ----------
export async function loadSchedules(){
  return cached(caches.schedules, 0, async()=>{
    const resolved = await resolveDatasetUrl('schedules', null, REL.schedules);
    const targetUrl = resolved?.url ?? REL.schedules();
    const {rows,source} = await fetchCsvFlexible(targetUrl);
    console.log(`[loadSchedules] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadESPNQBR(){
  return cached(caches.qbr, 0, async()=>{
    const {rows,source} = await fetchCsvFlexible(REL.qbr());
    console.log(`[loadESPNQBR] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadOfficials(){
  return cached(caches.officials, 0, async()=>{
    const {rows,source} = await fetchCsvFlexible(REL.officials());
    console.log(`[loadOfficials] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadSnapCounts(season){
  const y = toInt(season); if(y==null) throw new Error('loadSnapCounts season');
  return cached(caches.snapCounts, y, async()=>{
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
    const resolved = await resolveDatasetUrl('teamWeekly', y, REL.teamWeekly);
    const targetUrl = resolved?.url ?? REL.teamWeekly(y);
    const {rows,source} = await fetchCsvFlexible(targetUrl);
    console.log(`[loadTeamWeekly] OK ${source} rows=${rows.length}`);
    return rows;
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
    const {rows,source} = await fetchCsvFlexible(targetUrl);
    console.log(`[loadPlayerWeekly] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadRostersWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadRostersWeekly season');
  return cached(caches.rosterWeekly, y, async()=>{
    const resolved = await resolveDatasetUrl('rosterWeekly', y, REL.rosterWeekly);
    const targetUrl = resolved?.url ?? REL.rosterWeekly(y);
    const {rows,source} = await fetchCsvFlexible(targetUrl);
    console.log(`[loadRostersWeekly] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadDepthCharts(season){
  const y = toInt(season); if(y==null) throw new Error('loadDepthCharts season');
  return cached(caches.depthCharts, y, async()=>{
    const resolved = await resolveDatasetUrl('depthCharts', y, REL.depthCharts);
    const targetUrl = resolved?.url ?? REL.depthCharts(y);
    const {rows,source} = await fetchCsvFlexible(targetUrl);
    console.log(`[loadDepthCharts] OK ${source} rows=${rows.length}`);
    return rows;
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
    const resolved = await resolveDatasetUrl('pbp', y, REL.pbp);
    const targetUrl = resolved?.url ?? REL.pbp(y);
    const {rows,source} = await fetchCsvFlexible(targetUrl);
    console.log(`[loadPBP] OK ${source} rows=${rows.length}`);
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
export async function loadInjuries(){
  // Not available as a single canonical csv in nflverse-data; return empty & log once
  console.warn('[loadInjuries] returning empty (no canonical weekly injuries csv in nflverse-data)');
  return [];
}
