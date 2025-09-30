// trainer/dataSources.js
// Fetches nflverse datasets via GitHub Releases with raw fallbacks.
// Keep all functions idempotent and tolerant to missing optional sources.

import { gunzipSync } from "node:zlib";

// ---- logging ---------------------------------------------------------------
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
function log(level, ...args) {
  const rank = { silent:0, warn:1, info:2, debug:3 }[LOG_LEVEL] ?? 2;
  const need = { warn:1, info:2, debug:3 }[level] ?? 2;
  if (need <= rank) console[level === "warn" ? "warn" : "log"](...args);
}

function yearNow(){ return new Date().getUTCFullYear(); }

// ---- fetch helpers ---------------------------------------------------------
async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "nfl-wins/1.0 (+actions)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}
async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "nfl-wins/1.0 (+actions)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
async function tryFirst(urls, binary=false) {
  for (const url of urls) {
    try {
      const out = binary ? await fetchBuffer(url) : await fetchText(url);
      log("info", `OK ${url}`);
      return out;
    } catch (e) {
      const m = String(e?.message||e);
      if (m.includes("HTTP 404")) { log("debug", `404 ${url}`); continue; }
      log("warn", `warn: ${m}`);
    }
  }
  return null;
}

// ---- CSV parsers -----------------------------------------------------------
function parseCsvLoose(txt) {
  // Lightweight CSV splitter (no quotes support). Enough for most nflverse CSVs we use here.
  const lines = txt.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map(line => {
    const cols = line.split(",");
    const o = {};
    for (let i=0;i<header.length;i++) o[header[i]] = cols[i] ?? "";
    return o;
  });
}

// ---- URL builders / sources ------------------------------------------------
const BASE_REL = "https://github.com/nflverse/nflverse-data/releases/download";
const RAW_MAIN  = "https://raw.githubusercontent.com/nflverse/nflverse-data/main";
const RAW_MAST  = "https://raw.githubusercontent.com/nflverse/nflverse-data/master";

// Schedules (all-years CSV; filter season in code)
export async function loadSchedules() {
  const C = [
    `${BASE_REL}/schedules/schedules.csv`,
    `${RAW_MAIN}/data/games.csv`,
    `${RAW_MAST}/data/games.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) throw new Error("Could not load schedules");
  return parseCsvLoose(txt);
}

// Team weekly summary stats (PRIMARY, must exist)
export async function loadTeamWeekly(season) {
  const y = Number(season || yearNow());
  const C = [
    `${BASE_REL}/stats_team/stats_team_week_${y}.csv`,
    `${RAW_MAIN}/data/team_week_stats/stats_team_week_${y}.csv`,
    `${RAW_MAST}/data/team_week_stats/stats_team_week_${y}.csv`,
    // legacy fallback
    `https://raw.githubusercontent.com/nflverse/nflfastR-data/master/team_stats/team_stats_${y}.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) throw new Error(`Could not load team weekly for ${y}`);
  return parseCsvLoose(txt);
}

// Player weekly summary stats (optional)
export async function loadPlayerWeekly(season) {
  const y = Number(season || yearNow());
  const C = [
    `${BASE_REL}/stats_player/stats_player_week_${y}.csv`,
    `${RAW_MAIN}/data/player_stats/player_stats_${y}.csv`,
    `${RAW_MAST}/data/player_stats/player_stats_${y}.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) { log("warn", `loadPlayerWeekly(${y}) → []`); return []; }
  return parseCsvLoose(txt);
}

// Weekly rosters (optional; helps identify starters)
export async function loadRostersWeekly(season) {
  const y = Number(season || yearNow());
  const C = [
    `${BASE_REL}/weekly_rosters/weekly_rosters_${y}.csv`,
    `${RAW_MAIN}/data/rosters/weekly_rosters_${y}.csv`,
    `${RAW_MAST}/data/rosters/weekly_rosters_${y}.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) { log("warn", `loadRostersWeekly(${y}) → []`); return []; }
  return parseCsvLoose(txt);
}

// Depth charts (optional; starter flags)
export async function loadDepthCharts(season) {
  const y = Number(season || yearNow());
  const C = [
    `${BASE_REL}/depth_charts/depth_charts_${y}.csv`,
    `${RAW_MAIN}/data/depth_charts/depth_charts_${y}.csv`,
    `${RAW_MAST}/data/depth_charts/depth_charts_${y}.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) { log("warn", `loadDepthCharts(${y}) → []`); return []; }
  return parseCsvLoose(txt);
}

// Injuries (optional; weekly reports)
export async function loadInjuries(season) {
  const y = Number(season || yearNow());
  const C = [
    `${BASE_REL}/injuries/injuries_${y}.csv`,
    `${RAW_MAIN}/data/injuries/injuries_${y}.csv`,
    `${RAW_MAST}/data/injuries/injuries_${y}.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) { log("warn", `loadInjuries(${y}) → []`); return []; }
  return parseCsvLoose(txt);
}

// Snap counts (optional)
export async function loadSnapCounts(season) {
  const y = Number(season || yearNow());
  const C = [
    `${BASE_REL}/snap_counts/snap_counts_${y}.csv`,
    `${RAW_MAIN}/data/snap_counts/snap_counts_${y}.csv`,
    `${RAW_MAST}/data/snap_counts/snap_counts_${y}.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) { log("warn", `loadSnapCounts(${y}) → []`); return []; }
  return parseCsvLoose(txt);
}

// Officials (optional; all-years)
export async function loadOfficials() {
  const C = [
    `${BASE_REL}/officials/officials.csv`,
    `${RAW_MAIN}/data/officials/officials.csv`,
    `${RAW_MAST}/data/officials/officials.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) { log("warn", "loadOfficials() → []"); return []; }
  return parseCsvLoose(txt);
}

// PFR advanced team stats (optional)
export async function loadPFRAdvTeam(season) {
  const y = Number(season || yearNow());
  const C = [
    `${BASE_REL}/pfr_advstats/pfr_advstats_team_${y}.csv`,
    `${RAW_MAIN}/data/pfr_advstats/pfr_advstats_team_${y}.csv`,
    `${RAW_MAST}/data/pfr_advstats/pfr_advstats_team_${y}.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) { log("warn", `loadPFRAdvTeam(${y}) → []`); return []; }
  return parseCsvLoose(txt);
}

// ESPN QBR (optional)
export async function loadESPNQBR(season) {
  const y = Number(season || yearNow());
  const C = [
    `${BASE_REL}/espn_data/espn_qbr_${y}.csv`,
    `${RAW_MAIN}/data/espn_qbr/espn_qbr_${y}.csv`,
    `${RAW_MAST}/data/espn_qbr/espn_qbr_${y}.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) { log("warn", `loadESPNQBR(${y}) → []`); return []; }
  return parseCsvLoose(txt);
}

// Play-by-play CSV.GZ (optional; heavy)
export async function loadPBP(season) {
  const y = Number(season || yearNow());
  const C = [
    `${BASE_REL}/pbp/play_by_play_${y}.csv.gz`
  ];
  const buf = await tryFirst(C, true);
  if (!buf) { log("warn", `loadPBP(${y}) → []`); return []; }
  let csv;
  try { csv = gunzipSync(buf).toString("utf8"); }
  catch { log("warn", "gunzip failed for PBP"); return []; }
  return parseCsvLoose(csv);
}

// Team game advanced stats (optional legacy helper)
export async function loadTeamGameAdvanced(season) {
  const y = Number(season || yearNow());
  const C = [
    `${RAW_MAIN}/data/team_game/team_game_${y}.csv`,
    `${RAW_MAIN}/data/team_game/team_games_${y}.csv`,
    `${RAW_MAST}/data/team_game/team_game_${y}.csv`,
    `${RAW_MAST}/data/team_game/team_games_${y}.csv`
  ];
  const txt = await tryFirst(C);
  if (!txt) { log("warn", `loadTeamGameAdvanced(${y}) → []`); return []; }
  return parseCsvLoose(txt);
}
