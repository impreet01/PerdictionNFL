// trainer/dataSources.js
// Robust nflverse loaders with multi-URL fallbacks (.csv and .csv.gz) and helpful logging.
// Requires: axios, csv-parse

import axios from "axios";
import zlib from "zlib";
import { parse } from "csv-parse/sync";

// ---------- helpers ----------
function toInt(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const caches = {
  schedules: new Map(),
  teamWeekly: new Map(),
  teamGame: new Map(),
  playerWeekly: new Map(),
  rostersWeekly: new Map(),
  depthCharts: new Map(),
  injuries: new Map(),
  snapCounts: new Map(),
  officials: new Map(),
  pfrAdvTeam: new Map(),
  espnQBR: new Map(),
  pbp: new Map()
};

function cached(cache, key, loader) {
  if (cache.has(key)) {
    const value = cache.get(key);
    return value instanceof Promise ? value : Promise.resolve(value);
  }
  const promise = loader()
    .then((result) => {
      cache.set(key, result);
      return result;
    })
    .catch((err) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, promise);
  return promise;
}

async function fetchCsvFlexible(url) {
  // Try the exact URL and its .gz or non-gz twin.
  const tryUrls = [url];
  if (url.endsWith(".gz")) tryUrls.push(url.slice(0, -3));
  else tryUrls.push(url + ".gz");

  const errs = [];
  for (const u of tryUrls) {
    try {
      const resp = await axios.get(u, {
        responseType: "arraybuffer",
        timeout: 30000,
        headers: {
          "User-Agent": "nfl-wins-free-stack/1.0",
          "Accept": "text/csv,application/octet-stream,*/*",
          "Accept-Encoding": "gzip,deflate,br"
        }
      });
      let buf = Buffer.from(resp.data);
      // if gzipped, try gunzip
      const looksGz = u.endsWith(".gz") || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b);
      if (looksGz) {
        try { buf = zlib.gunzipSync(buf); } catch {/* fall through */}
      }
      const text = buf.toString("utf8");
      const rows = parse(text, { columns: true, skip_empty_lines: true });
      return { rows, source: u };
    } catch (e) {
      errs.push(`${u}: ${e?.response?.status || e.code || e.message}`);
    }
  }
  const err = new Error(`fetchCsvFlexible failed:\n  - ${errs.join("\n  - ")}`);
  err._attempts = errs;
  throw err;
}

// ---------- bases ----------
const BASE_REL = "https://github.com/nflverse/nflverse-data/releases/download";
const RAW_MAIN = "https://raw.githubusercontent.com/nflverse/nflverse-data/main";
const RAW_MAST = "https://raw.githubusercontent.com/nflverse/nflverse-data/master";

// ---------- Schedules ----------
function coerceScheduleRow(r) {
  return {
    season: toInt(r.season ?? r.year ?? r.Season),
    week: toInt(r.week ?? r.Week),
    game_id: r.game_id ?? r.gsis ?? r.game_id_pfr ?? null,
    gameday: r.gameday ?? r.game_date ?? r.gametime ?? null,
    game_time_utc: r.game_time_utc ?? r.start_time ?? null,
    home_team: r.home_team ?? r.home ?? r.home_team_abbr ?? r.team_home ?? null,
    away_team: r.away_team ?? r.away ?? r.away_team_abbr ?? r.team_away ?? null,
    home_score: toInt(r.home_score ?? r.score_home ?? r.home_points),
    away_score: toInt(r.away_score ?? r.score_away ?? r.away_points),
    roof: r.roof ?? r.roof_type ?? null,
    surface: r.surface ?? r.surface_short ?? null,
    game_type: r.game_type ?? r.season_type ?? null
  };
}

export async function loadSchedules(season) {
  const seasonInt = toInt(season);
  if (seasonInt == null) {
    throw new Error(`loadSchedules requires a valid season, received ${season}`);
  }
  return cached(caches.schedules, seasonInt, async () => {
    const rel = [
      `${BASE_REL}/schedules/schedules.csv`,
      `${BASE_REL}/schedules/schedules_${seasonInt}.csv`,
      `${BASE_REL}/schedules/schedules_${seasonInt}.csv.gz`
    ];
    const fb = [
      "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
    ];
    const tried = [];
    for (const u of rel) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        const out = rows.map(coerceScheduleRow).filter(r => r.season === seasonInt);
        if (out.length) { console.log(`[loadSchedules] OK ${source} (${out.length})`); return out; }
        tried.push(`${u} (no rows for ${seasonInt})`);
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    for (const u of fb) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        const out = rows.map(coerceScheduleRow).filter(r => r.season === seasonInt);
        if (out.length) { console.log(`[loadSchedules] OK FB ${source} (${out.length})`); return out; }
        tried.push(`${u} (no rows for ${seasonInt})`);
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    throw new Error(`Could not load schedules for ${seasonInt}:\n  - ${tried.join("\n  - ")}`);
  });
}

// ---------- Team weekly ----------
export async function loadTeamWeekly(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadTeamWeekly requires a valid season, received ${season}`);
  return cached(caches.teamWeekly, y, async () => {
    const candidates = [
      `${BASE_REL}/stats_team/stats_team_week_${y}.csv`,
      `${RAW_MAIN}/data/team_week_stats/stats_team_week_${y}.csv`,
      `${RAW_MAST}/data/team_week_stats/stats_team_week_${y}.csv`,
      `${BASE_REL}/stats_team/stats_team_week_${y}.csv.gz`,
      `${BASE_REL}/stats_team/stats_team_week.csv`,
      `${BASE_REL}/stats_team/stats_team_week.csv.gz`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        const filtered = rows.filter(r => toInt(r.season) === y);
        const out = filtered.length ? filtered : rows;
        console.log(`[loadTeamWeekly] OK ${source} (rows=${out.length})`);
        return out;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    throw new Error(`Could not load team weekly stats for ${y}:\n  - ${tried.join("\n  - ")}`);
  });
}

// ---------- Player weekly (optional) ----------
export async function loadPlayerWeekly(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadPlayerWeekly requires a valid season, received ${season}`);
  return cached(caches.playerWeekly, y, async () => {
    const candidates = [
      `${BASE_REL}/stats_player/stats_player_week_${y}.csv`,
      `${BASE_REL}/stats_player/stats_player_week_${y}.csv.gz`,
      `${BASE_REL}/stats_player/stats_player_week.csv`,
      `${BASE_REL}/stats_player/stats_player_week.csv.gz`,
      `${RAW_MAIN}/data/player_stats/player_stats_${y}.csv`,
      `${RAW_MAST}/data/player_stats/player_stats_${y}.csv`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        const filtered = rows.filter(r => toInt(r.season) === y);
        const out = filtered.length ? filtered : rows;
        console.log(`[loadPlayerWeekly] OK ${source} (rows=${out.length})`);
        return out;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadPlayerWeekly] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}

// ---------- Weekly rosters (optional) ----------
export async function loadRostersWeekly(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadRostersWeekly requires a valid season, received ${season}`);
  return cached(caches.rostersWeekly, y, async () => {
    const candidates = [
      `${BASE_REL}/weekly_rosters/weekly_rosters_${y}.csv`,
      `${BASE_REL}/weekly_rosters/weekly_rosters_${y}.csv.gz`,
      `${RAW_MAIN}/data/rosters/weekly_rosters_${y}.csv`,
      `${RAW_MAST}/data/rosters/weekly_rosters_${y}.csv`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        console.log(`[loadRostersWeekly] OK ${source} (rows=${rows.length})`);
        return rows;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadRostersWeekly] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}

// ---------- Depth charts (optional) ----------
export async function loadDepthCharts(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadDepthCharts requires a valid season, received ${season}`);
  return cached(caches.depthCharts, y, async () => {
    const candidates = [
      `${BASE_REL}/depth_charts/depth_charts_${y}.csv`,
      `${BASE_REL}/depth_charts/depth_charts_${y}.csv.gz`,
      `${RAW_MAIN}/data/depth_charts/depth_charts_${y}.csv`,
      `${RAW_MAST}/data/depth_charts/depth_charts_${y}.csv`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        console.log(`[loadDepthCharts] OK ${source} (rows=${rows.length})`);
        return rows;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadDepthCharts] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}

// ---------- Injuries (optional) ----------
export async function loadInjuries(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadInjuries requires a valid season, received ${season}`);
  return cached(caches.injuries, y, async () => {
    const candidates = [
      `${BASE_REL}/injuries/injuries_${y}.csv`,
      `${BASE_REL}/injuries/injuries_${y}.csv.gz`,
      `${RAW_MAIN}/data/injuries/injuries_${y}.csv`,
      `${RAW_MAST}/data/injuries/injuries_${y}.csv`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        console.log(`[loadInjuries] OK ${source} (rows=${rows.length})`);
        return rows;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadInjuries] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}

// ---------- Snap counts (optional) ----------
export async function loadSnapCounts(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadSnapCounts requires a valid season, received ${season}`);
  return cached(caches.snapCounts, y, async () => {
    const candidates = [
      `${BASE_REL}/snap_counts/snap_counts_${y}.csv`,
      `${BASE_REL}/snap_counts/snap_counts_${y}.csv.gz`,
      `${RAW_MAIN}/data/snap_counts/snap_counts_${y}.csv`,
      `${RAW_MAST}/data/snap_counts/snap_counts_${y}.csv`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        console.log(`[loadSnapCounts] OK ${source} (rows=${rows.length})`);
        return rows;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadSnapCounts] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}

// ---------- Officials (optional, all-years) ----------
export async function loadOfficials() {
  return cached(caches.officials, "all", async () => {
    const candidates = [
      `${BASE_REL}/officials/officials.csv`,
      `${BASE_REL}/officials/officials.csv.gz`,
      `${RAW_MAIN}/data/officials/officials.csv`,
      `${RAW_MAST}/data/officials/officials.csv`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        console.log(`[loadOfficials] OK ${source} (rows=${rows.length})`);
        return rows;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadOfficials] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}

// ---------- PFR advanced team (optional) ----------
export async function loadPFRAdvTeam(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadPFRAdvTeam requires a valid season, received ${season}`);
  return cached(caches.pfrAdvTeam, y, async () => {
    const candidates = [
      `${BASE_REL}/pfr_advstats/pfr_advstats_team_${y}.csv`,
      `${BASE_REL}/pfr_advstats/pfr_advstats_team_${y}.csv.gz`,
      `${RAW_MAIN}/data/pfr_advstats/pfr_advstats_team_${y}.csv`,
      `${RAW_MAST}/data/pfr_advstats/pfr_advstats_team_${y}.csv`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        console.log(`[loadPFRAdvTeam] OK ${source} (rows=${rows.length})`);
        return rows;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadPFRAdvTeam] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}

// ---------- ESPN QBR (optional) ----------
export async function loadESPNQBR(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadESPNQBR requires a valid season, received ${season}`);
  return cached(caches.espnQBR, y, async () => {
    const candidates = [
      `${BASE_REL}/espn_data/espn_qbr_${y}.csv`,
      `${BASE_REL}/espn_data/espn_qbr_${y}.csv.gz`,
      `${RAW_MAIN}/data/espn_qbr/espn_qbr_${y}.csv`,
      `${RAW_MAST}/data/espn_qbr/espn_qbr_${y}.csv`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        console.log(`[loadESPNQBR] OK ${source} (rows=${rows.length})`);
        return rows;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadESPNQBR] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}

// ---------- Play-by-play (optional, heavy) ----------
export async function loadPBP(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadPBP requires a valid season, received ${season}`);
  return cached(caches.pbp, y, async () => {
    const candidates = [
      `${BASE_REL}/pbp/play_by_play_${y}.csv.gz`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        console.log(`[loadPBP] OK ${source} (rows=${rows.length})`);
        return rows;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadPBP] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}

// ---------- Team per-game advanced (optional convenience) ----------
export async function loadTeamGameAdvanced(season) {
  const y = toInt(season);
  if (y == null) throw new Error(`loadTeamGameAdvanced requires a valid season, received ${season}`);
  return cached(caches.teamGame, y, async () => {
    const candidates = [
      `${BASE_REL}/stats_team/stats_team_game_${y}.csv`,
      `${BASE_REL}/stats_team/stats_team_game_${y}.csv.gz`,
      `${BASE_REL}/stats_team/stats_team_game.csv`,
      `${BASE_REL}/stats_team/stats_team_game.csv.gz`,
      `${RAW_MAIN}/data/team_game_stats/stats_team_game_${y}.csv`,
      `${RAW_MAST}/data/team_game_stats/stats_team_game_${y}.csv`
    ];
    const tried = [];
    for (const u of candidates) {
      try {
        const { rows, source } = await fetchCsvFlexible(u);
        const filtered = rows.filter(r => toInt(r.season) === y);
        const out = filtered.length ? filtered : rows;
        console.log(`[loadTeamGameAdvanced] OK ${source} (rows=${out.length})`);
        return out;
      } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
    }
    console.warn(`[loadTeamGameAdvanced] empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  });
}