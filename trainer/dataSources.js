// trainer/dataSources.js
import { parse } from 'csv-parse/sync';
import zlib from 'node:zlib';

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
    const {rows,source} = await fetchCsvFlexible(REL.schedules());
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
    const {rows,source} = await fetchCsvFlexible(REL.snapCounts(y));
    console.log(`[loadSnapCounts] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadTeamWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadTeamWeekly season');
  return cached(caches.teamWeekly, y, async()=>{
    const {rows,source} = await fetchCsvFlexible(REL.teamWeekly(y));
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
    const {rows,source} = await fetchCsvFlexible(REL.playerWeekly(y));
    console.log(`[loadPlayerWeekly] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadRostersWeekly(season){
  const y = toInt(season); if(y==null) throw new Error('loadRostersWeekly season');
  return cached(caches.rosterWeekly, y, async()=>{
    const {rows,source} = await fetchCsvFlexible(REL.rosterWeekly(y));
    console.log(`[loadRostersWeekly] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadDepthCharts(season){
  const y = toInt(season); if(y==null) throw new Error('loadDepthCharts season');
  return cached(caches.depthCharts, y, async()=>{
    const {rows,source} = await fetchCsvFlexible(REL.depthCharts(y));
    console.log(`[loadDepthCharts] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadFTNCharts(season){
  const y = toInt(season); if(y==null) throw new Error('loadFTNCharts season');
  return cached(caches.ftnCharts, y, async()=>{
    const {rows,source} = await fetchCsvFlexible(REL.ftnCharts(y));
    console.log(`[loadFTNCharts] OK ${source} rows=${rows.length}`);
    return rows;
  });
}
export async function loadPBP(season){
  const y = toInt(season); if(y==null) throw new Error('loadPBP season');
  return cached(caches.pbp, y, async()=>{
    const {rows,source} = await fetchCsvFlexible(REL.pbp(y));
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
      fetchCsvFlexible(REL.pfrRush(y)).then(x=>x.rows).catch(()=>[]),
      fetchCsvFlexible(REL.pfrDef(y)).then(x=>x.rows).catch(()=>[]),
      fetchCsvFlexible(REL.pfrPass(y)).then(x=>x.rows).catch(()=>[]),
      fetchCsvFlexible(REL.pfrRec(y)).then(x=>x.rows).catch(()=>[]),
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
