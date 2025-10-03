// trainer/databases.js
// Build a context-only data cache from nflverse releases (no model changes).
// Outputs:
//   artifacts/context_{SEASON}_to_W{WW}.json
//   artifacts/context_current.json
//
// Requires: axios, csv-parse (installed in package.json)
// Node ESM ("type":"module")

import { CONFIG } from "../config/env.js";
import fs from "fs";
import path from "path";
import axios from "axios";
import zlib from "zlib";
import { parse } from "csv-parse/sync";
import {
  loadSchedules as loadSchedulesDS,
  loadESPNQBR as loadESPNQBRDS,
  loadOfficials as loadOfficialsDS,
  loadSnapCounts as loadSnapCountsDS,
  loadTeamWeekly as loadTeamWeeklyDS,
  loadTeamGameAdvanced as loadTeamGameAdvancedDS,
  loadPlayerWeekly as loadPlayerWeeklyDS,
  loadRostersWeekly as loadRostersWeeklyDS,
  loadDepthCharts as loadDepthChartsDS,
  loadFTNCharts as loadFTNChartsDS,
  loadPBP as loadPBPDS,
  loadPFRAdvTeamWeekly as loadPFRAdvTeamWeeklyDS,
  listDatasetSeasons,
  PUBLIC_API_ENABLED,
  PUBLIC_API_SEASON_CUTOFF
} from "./dataSources.js";

void CONFIG;

const BASE_REL = "https://github.com/nflverse/nflverse-data/releases/download";
const RAW_MAIN = "https://raw.githubusercontent.com/nflverse/nflverse-data/main";
const RAW_MAST = "https://raw.githubusercontent.com/nflverse/nflverse-data/master";
// Community fallback for schedules/games table:
const NFLDATA_GAMES = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

// ---------- tiny helpers ----------
function toInt(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function uniq(arr) { return Array.from(new Set(arr)); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

export async function resolveSeasonList({
  targetSeason,
  includeAll = false,
  sinceSeason = null,
  maxSeasons = null,
  availableSeasons = [],
  dataset = "teamWeekly",
  publicApiEnabled = false,
  publicApiCutoff = null
} = {}) {
  const seasons = Array.isArray(availableSeasons) && availableSeasons.length
    ? availableSeasons.slice()
    : await listDatasetSeasons(dataset).catch((err) => {
        console.warn(`[resolveSeasonList] manifest seasons unavailable (${err?.message || err})`);
        return [];
      });
  const canonical = Array.from(
    new Set(
      seasons
        .concat(targetSeason != null ? [targetSeason] : [])
        .map((s) => toInt(s))
        .filter((s) => Number.isFinite(s))
    )
  ).sort((a, b) => a - b);

  if (!canonical.length && Number.isFinite(targetSeason)) {
    return [Number(targetSeason)];
  }

  let filtered = canonical;
  const since = toInt(sinceSeason);
  const publicCutoff = toInt(publicApiCutoff);
  const tgt = Number.isFinite(targetSeason) ? Number(targetSeason) : null;

  let effectiveSince = since;
  if (!Number.isFinite(effectiveSince) && publicApiEnabled && !includeAll) {
    if (Number.isFinite(publicCutoff)) {
      effectiveSince = publicCutoff;
    } else if (tgt != null) {
      effectiveSince = tgt;
    }
  }

  if (Number.isFinite(effectiveSince)) {
    filtered = filtered.filter((s) => s >= effectiveSince);
  }

  if (!includeAll) {
    if (tgt != null) {
      filtered = filtered.filter((s) => s <= tgt);
      if (!filtered.includes(tgt)) filtered.push(tgt);
    } else if (filtered.length) {
      filtered = [filtered[filtered.length - 1]];
    }
  }

  const max = toInt(maxSeasons);
  if (Number.isFinite(max) && max > 0) {
    filtered = filtered.slice(-max);
  }

  return Array.from(new Set(filtered.filter((s) => Number.isFinite(s)).sort((a, b) => a - b)));
}

async function fetchCsvFlexible(url) {
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
      const looksGz = u.endsWith(".gz") || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b);
      if (looksGz) {
        try { buf = zlib.gunzipSync(buf); } catch {/* ignore */ }
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

// ---------- dataset loaders (multi-source, csv/gz) ----------
async function loadSchedules(season) {
  const y = toInt(season);
  const rel = [
    `${BASE_REL}/schedules/schedules.csv`,
    `${BASE_REL}/schedules/schedules_${y}.csv`,
    `${BASE_REL}/schedules/schedules_${y}.csv.gz`
  ];
  const fallbacks = [ NFLDATA_GAMES ];

  const tried = [];
  for (const u of rel) {
    try {
      const { rows, source } = await fetchCsvFlexible(u);
      const out = rows.map(coerceScheduleRow).filter(r => r.season === y);
      if (out.length) { console.log(`[context/schedules] OK ${source} rows=${out.length}`); return out; }
      tried.push(`${u} (no rows for ${y})`);
    } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
  }
  for (const u of fallbacks) {
    try {
      const { rows, source } = await fetchCsvFlexible(u);
      const out = rows.map(coerceScheduleRow).filter(r => r.season === y);
      if (out.length) { console.log(`[context/schedules] OK FB ${source} rows=${out.length}`); return out; }
      tried.push(`${u} (no rows for ${y})`);
    } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
  }
  throw new Error(`Could not load schedules for ${y}:\n  - ${tried.join("\n  - ")}`);
}
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
    season_type: r.season_type ?? r.game_type ?? null,
    result_posted: (r.home_score ?? r.score_home ?? r.home_points) != null &&
                   (r.away_score ?? r.score_away ?? r.away_points) != null ? 1 : 0
  };
}

async function loadTeamWeekly(season) {
  const y = toInt(season);
  const candidates = [
    `${BASE_REL}/stats_team/stats_team_week_${y}.csv`,
    `${BASE_REL}/stats_team/stats_team_week_${y}.csv.gz`,
    `${BASE_REL}/stats_team/stats_team_week.csv`,
    `${BASE_REL}/stats_team/stats_team_week.csv.gz`,
    `${RAW_MAIN}/data/team_week_stats/stats_team_week_${y}.csv`,
    `${RAW_MAST}/data/team_week_stats/stats_team_week_${y}.csv`
  ];
  return loadOneOf(candidates, r => toInt(r.season) === y, `[context/team_week]`);
}

async function loadPlayerWeekly(season) {
  const y = toInt(season);
  const candidates = [
    `${BASE_REL}/stats_player/stats_player_week_${y}.csv`,
    `${BASE_REL}/stats_player/stats_player_week_${y}.csv.gz`,
    `${BASE_REL}/stats_player/stats_player_week.csv`,
    `${BASE_REL}/stats_player/stats_player_week.csv.gz`,
    `${RAW_MAIN}/data/player_stats/player_stats_${y}.csv`,
    `${RAW_MAST}/data/player_stats/player_stats_${y}.csv`
  ];
  return loadOneOf(candidates, r => toInt(r.season) === y, `[context/player_week]`, { emptyOk: true });
}

async function loadWeeklyRosters(season) {
  const y = toInt(season);
  const candidates = [
    `${BASE_REL}/weekly_rosters/roster_weekly_${y}.csv`,
    `${BASE_REL}/weekly_rosters/roster_weekly_${y}.csv.gz`,
    `${BASE_REL}/weekly_rosters/weekly_rosters_${y}.csv`,
    `${BASE_REL}/weekly_rosters/weekly_rosters_${y}.csv.gz`,
    `${RAW_MAIN}/data/rosters/weekly_rosters_${y}.csv`,
    `${RAW_MAST}/data/rosters/weekly_rosters_${y}.csv`
  ];
  return loadOneOf(candidates, null, `[context/weekly_rosters]`, { emptyOk: true });
}

async function loadDepthCharts(season) {
  const y = toInt(season);
  const candidates = [
    `${BASE_REL}/depth_charts/depth_charts_${y}.csv`,
    `${BASE_REL}/depth_charts/depth_charts_${y}.csv.gz`,
    `${RAW_MAIN}/data/depth_charts/depth_charts_${y}.csv`,
    `${RAW_MAST}/data/depth_charts/depth_charts_${y}.csv`
  ];
  return loadOneOf(candidates, null, `[context/depth_charts]`, { emptyOk: true });
}

async function loadInjuries(season) {
  const y = toInt(season);
  const candidates = [
    `${BASE_REL}/injuries/injuries_${y}.csv`,
    `${BASE_REL}/injuries/injuries_${y}.csv.gz`,
    `${RAW_MAIN}/data/injuries/injuries_${y}.csv`,
    `${RAW_MAST}/data/injuries/injuries_${y}.csv`
  ];
  return loadOneOf(candidates, null, `[context/injuries]`, { emptyOk: true });
}

async function loadSnapCounts(season) {
  const y = toInt(season);
  const candidates = [
    `${BASE_REL}/snap_counts/snap_counts_${y}.csv`,
    `${BASE_REL}/snap_counts/snap_counts_${y}.csv.gz`,
    `${RAW_MAIN}/data/snap_counts/snap_counts_${y}.csv`,
    `${RAW_MAST}/data/snap_counts/snap_counts_${y}.csv`
  ];
  return loadOneOf(candidates, null, `[context/snap_counts]`, { emptyOk: true });
}

async function loadPFRAdvTeam(season) {
  const y = toInt(season);
  try {
    const map = await loadPFRAdvTeamWeeklyDS(y);
    const rows = Array.isArray(map) ? map : Array.from(map.values());
    console.log(`[context/pfr_adv_team] OK dataSources rows=${rows.length}`);
    return rows;
  } catch (e) {
    console.warn(`[context/pfr_adv_team] empty; dataSources error: ${e.message}`);
    return [];
  }
}

async function loadESPNQBR(season) {
  const y = toInt(season);
  const candidates = [
    `${BASE_REL}/espn_data/qbr_week_level.csv`,
    `${BASE_REL}/espn_data/qbr_week_level.csv.gz`,
    `${BASE_REL}/espn_data/espn_qbr_${y}.csv`,
    `${BASE_REL}/espn_data/espn_qbr_${y}.csv.gz`,
    `${RAW_MAIN}/data/espn_qbr/espn_qbr_${y}.csv`,
    `${RAW_MAST}/data/espn_qbr/espn_qbr_${y}.csv`
  ];
  return loadOneOf(candidates, null, `[context/espn_qbr]`, { emptyOk: true });
}

async function loadTeamGameAdvanced(season) {
  const y = toInt(season);
  try {
    const rows = await loadTeamGameAdvancedDS(y);
    console.log(`[context/team_game_adv] OK dataSources rows=${rows.length}`);
    return rows;
  } catch (e) {
    console.warn(`[context/team_game_adv] empty; dataSources error: ${e.message}`);
    return [];
  }
}

async function loadOneOf(candidates, filterFn, tag, opts = {}) {
  const tried = [];
  for (const u of candidates) {
    try {
      const { rows, source } = await fetchCsvFlexible(u);
      const out = filterFn ? rows.filter(filterFn) : rows;
      console.log(`${tag} OK ${source} rows=${out.length}`);
      return out;
    } catch (e) { tried.push(`${u} (${e.message.split("\n")[0]})`); }
  }
  if (opts.emptyOk) {
    console.warn(`${tag} empty; tried:\n  - ${tried.join("\n  - ")}`);
    return [];
  }
  throw new Error(`${tag} failed:\n  - ${tried.join("\n  - ")}`);
}

// ---------- light summaries (context signals) ----------
function latestCompletedWeek(schedules) {
  const reg = schedules.filter(r => r.season_type?.toUpperCase() === "REG" || r.season_type?.toUpperCase() === "REGULAR");
  const withScores = reg.filter(r => r.result_posted === 1);
  return withScores.length ? Math.max(...withScores.map(r => r.week || 0)) : null;
}

function summarizeInjuries(inj, weekCap) {
  // Aggregate by team+week and by key positions
  const keyPos = new Set(["QB","RB","WR","TE"]);
  const out = {}; // out[team][week] = {...}
  for (const r of inj) {
    const wk = toInt(r.week);
    if (weekCap && wk && wk > weekCap) continue;
    const team = r.team || r.team_abbr || r.Team;
    if (!team) continue;
    const pos = r.position?.toUpperCase?.() || "UNK";
    const status = (r.status || r.injury_status || "").toUpperCase();
    if (!out[team]) out[team] = {};
    if (!out[team][wk]) out[team][wk] = { Out:0, Doubtful:0, Questionable:0, Probable:0, Unknown:0, key_out:0 };
    const bucket = status.includes("OUT") ? "Out"
                 : status.includes("DOUBT") ? "Doubtful"
                 : status.includes("QUESTION") ? "Questionable"
                 : status.includes("PROB") ? "Probable" : "Unknown";
    out[team][wk][bucket] += 1;
    if (keyPos.has(pos) && bucket === "Out") out[team][wk].key_out += 1;
  }
  return out;
}

function summarizeDepthChange(depth, weekCap) {
  // Starter volatility per team: count how often depth_chart_position_rank == 1 changes for same position
  const byTeamPos = new Map(); // key: team|pos -> [{week, player_id}]
  for (const r of depth) {
    const wk = toInt(r.week);
    if (weekCap && wk && wk > weekCap) continue;
    const team = r.team || r.team_abbr;
    const pos = r.position || r.depth_chart_position || r.slot;
    const rank = toInt(r.depth_chart_position_rank ?? r.rank);
    if (!team || !pos || rank !== 1) continue;
    const pid = r.gsis_id || r.pfr_player_id || r.esb_id || r.player_id || r.full_name;
    const key = `${team}|${pos}`;
    if (!byTeamPos.has(key)) byTeamPos.set(key, []);
    byTeamPos.get(key).push({ week: wk, pid });
  }
  const out = {}; // out[team][week] = count of first-string changes up to that week
  for (const [key, rows] of byTeamPos.entries()) {
    rows.sort((a,b) => (a.week||0) - (b.week||0));
    let changes = 0;
    let last = null;
    for (const row of rows) {
      if (row.pid && last && row.pid !== last) changes++;
      last = row.pid;
      const [team] = key.split("|");
      if (!out[team]) out[team] = {};
      out[team][row.week] = (out[team][row.week] || 0) + changes;
    }
  }
  return out;
}

function summarizeSnaps(snaps, weekCap) {
  // total snaps O/D and change vs previous week
  const key = r => `${r.season}-${r.week}-${r.team ?? r.team_abbr}-${r.offense_defense ?? r.unit ?? ""}`;
  const byKey = new Map();
  for (const r of snaps) byKey.set(key(r), r);
  const byTeamWeek = {};
  for (const r of snaps) {
    const wk = toInt(r.week);
    if (weekCap && wk && wk > weekCap) continue;
    const team = r.team || r.team_abbr;
    const unit = (r.offense_defense || r.unit || "").toUpperCase();
    const snapsVal = toInt(r.snaps) ?? toInt(r.total) ?? null;
    if (!team || !wk || snapsVal == null) continue;
    if (!byTeamWeek[team]) byTeamWeek[team] = {};
    if (!byTeamWeek[team][wk]) byTeamWeek[team][wk] = { off:0, def:0 };
    if (unit.startsWith("OFF")) byTeamWeek[team][wk].off += snapsVal;
    if (unit.startsWith("DEF")) byTeamWeek[team][wk].def += snapsVal;
  }
  // compute deltas
  for (const team of Object.keys(byTeamWeek)) {
    const weeks = Object.keys(byTeamWeek[team]).map(w => +w).sort((a,b)=>a-b);
    let prev = null;
    for (const wk of weeks) {
      const cur = byTeamWeek[team][wk];
      const prevRow = prev ? byTeamWeek[team][prev] : null;
      cur.off_delta = prevRow ? cur.off - (prevRow.off ?? 0) : null;
      cur.def_delta = prevRow ? cur.def - (prevRow.def ?? 0) : null;
      prev = wk;
    }
  }
  return byTeamWeek;
}

function summarizeForm(teamWeek, weekCap) {
  // rolling 3-game averages for points for/against and total yards (if available)
  const byTeam = {};
  for (const r of teamWeek) {
    const wk = toInt(r.week);
    const team = r.team || r.team_abbr || r.posteam;
    if (!team || !wk) continue;
    const pf = toInt(r.points_for ?? r.points_scored ?? r.points) ?? null;
    const pa = toInt(r.points_against ?? r.points_allowed) ?? null;
    const yds = toInt(r.total_yards ?? r.off_total_yards ?? r.off_total_yds) ?? null;
    if (!byTeam[team]) byTeam[team] = [];
    byTeam[team].push({ week: wk, pf, pa, yds });
  }
  for (const t of Object.keys(byTeam)) byTeam[t].sort((a,b)=>a.week-b.week);

  const out = {};
  for (const [team, rows] of Object.entries(byTeam)) {
    for (let i=0;i<rows.length;i++) {
      const wk = rows[i].week;
      if (weekCap && wk > weekCap) continue;
      const slice = rows.slice(Math.max(0,i-2), i+1); // last up to 3
      const mean = k => {
        const vals = slice.map(x=>x[k]).filter(v=>v!=null);
        if (!vals.length) return null;
        return vals.reduce((a,b)=>a+b,0)/vals.length;
      };
      if (!out[team]) out[team] = {};
      out[team][wk] = {
        pf3: mean("pf"),
        pa3: mean("pa"),
        yds3: mean("yds")
      };
    }
  }
  return out;
}

function summarizeQBForm(playerWeek, rostersWeekly, qbr, weekCap) {
  // Link QB stats/QBR to the team in that week (simple mean of team’s QB rows)
  const qbWeeks = {};
  const isQB = r => (r.position || r.pos || "").toUpperCase()==="QB";
  for (const r of playerWeek) {
    if (!isQB(r)) continue;
    const wk = toInt(r.week); if (weekCap && wk && wk > weekCap) continue;
    const team = r.team || r.team_abbr || r.recent_team;
    const ypa = Number(r.yards_per_attempt ?? r.ypa ?? r.pass_ypa ?? r.passing_yards_per_attempt);
    const rating = Number(r.passer_rating ?? r.rating ?? r.qb_rating);
    if (!team || !wk) continue;
    if (!qbWeeks[team]) qbWeeks[team] = {};
    if (!qbWeeks[team][wk]) qbWeeks[team][wk] = [];
    qbWeeks[team][wk].push({ ypa: isFinite(ypa)?ypa:null, rating: isFinite(rating)?rating:null });
  }
  const qbrByTeamWeek = {};
  for (const r of qbr) {
    const wk = toInt(r.week); if (weekCap && wk && wk > weekCap) continue;
    const team = r.team || r.team_abbr;
    const val = Number(r.qbr_total ?? r.qbr ?? r.total_qbr);
    if (!team || !wk || !isFinite(val)) continue;
    if (!qbrByTeamWeek[team]) qbrByTeamWeek[team] = {};
    qbrByTeamWeek[team][wk] = val;
  }
  const out = {};
  for (const [team, weeks] of Object.entries(qbWeeks)) {
    for (const wk of Object.keys(weeks).map(w=>+w)) {
      const arr = weeks[wk];
      const mean = (k)=> {
        const vs = arr.map(o=>o[k]).filter(v=>v!=null);
        return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : null;
      };
      if (!out[team]) out[team] = {};
      out[team][wk] = {
        ypa_mean: mean("ypa"),
        rating_mean: mean("rating"),
        qbr: qbrByTeamWeek[team]?.[wk] ?? null
      };
    }
  }
  return out;
}

// ---------- main builder ----------
export async function buildContextDB(season, weekCap, outDir = "artifacts") {
  const y = toInt(season);
  if (!y) throw new Error("buildContextDB: invalid season");

  // fetch in parallel (safe groups to avoid GitHub throttling)
  const [schedules, teamWeek] = await Promise.all([
    loadSchedules(y),
    loadTeamWeekly(y)
  ]);

  // auto-cap to latest completed week if weekCap not given
  const latestDone = latestCompletedWeek(schedules);
  const cap = weekCap ? Math.min(weekCap, latestDone ?? weekCap) : latestDone ?? null;

  const [playerWeek, rostersWeekly, depthCharts, injuries, snaps, pfrAdvTeam, qbr, teamGameAdv] =
    await Promise.all([
      loadPlayerWeekly(y),
      loadWeeklyRosters(y),
      loadDepthCharts(y),
      loadInjuries(y),
      loadSnapCounts(y),
      loadPFRAdvTeam(y),
      loadESPNQBR(y),
      loadTeamGameAdvanced(y)
    ]);

  // build summaries (bounded by cap)
  const injSummary   = summarizeInjuries(injuries, cap);
  const depthChange  = summarizeDepthChange(depthCharts, cap);
  const snapSummary  = summarizeSnaps(snaps, cap);
  const formSummary  = summarizeForm(teamWeek, cap);
  const qbForm       = summarizeQBForm(playerWeek, rostersWeekly, qbr, cap);

  // compact schedule index per week (REG only)
  const weeks = uniq(
    schedules
      .filter(r => (r.season_type?.toUpperCase?.()||"REG").startsWith("REG"))
      .map(r => r.week)
      .filter(Boolean)
  ).sort((a,b)=>a-b).filter(w => !cap || w <= cap);

  const payload = {
    season: y,
    built_through_week: cap,
    weeks,
    sources: {
      schedules: "nflverse-data releases (fallback nfldata games.csv)",
      team_week: "nflverse-data stats_team_week",
      player_week: "nflverse-data stats_player_week",
      weekly_rosters: "nflverse-data roster_weekly",
      depth_charts: "nflverse-data depth_charts",
      injuries: "nflverse-data injuries",
      snap_counts: "nflverse-data snap_counts",
      pfr_adv_team: "nflverse-data pfr advstats weekly merges",
      espn_qbr: "nflverse-data qbr_week_level",
      team_game_adv: "nflverse-data stats_team_week"
    },
    context: {
      // raw shards (optional: you can remove these if too large)
      // rostersWeekly, depthCharts, injuries, snaps, pfrAdvTeam, qbr, teamGameAdv, playerWeek, teamWeek,
      summaries: {
        injuries: injSummary,
        depth_chart_changes: depthChange,
        snap_counts: snapSummary,
        form_rolling3: formSummary,
        qb_form: qbForm
      },
      venues: schedules.reduce((acc, r) => {
        const gid = r.game_id || `${r.season}-W${r.week}-${r.away_team}-${r.home_team}`;
        acc[gid] = { roof: r.roof ?? null, surface: r.surface ?? null };
        return acc;
      }, {})
    }
  };

  ensureDir(outDir);
  const fileA = path.join(outDir, `context_${y}_to_W${String(cap ?? 0).padStart(2,"0")}.json`);
  const fileB = path.join(outDir, `context_current.json`);
  fs.writeFileSync(fileA, JSON.stringify(payload, null, 2));
  fs.writeFileSync(fileB, JSON.stringify({ ...payload }, null, 2));
  console.log(`[context] WROTE ${fileA}`);
  console.log(`[context] WROTE ${fileB}`);

  return payload;
}

// ---------------------------------------------------------------------------
// Season database facade used by training pipeline
const keyTW = (s, w, t) => `${s}|${w}|${t}`;
const kGame = (gid) => String(gid);
const T = (v) => String(v || "").toUpperCase();

function scheduleKey(r) {
  const season = toInt(r.season ?? r.year);
  const week = toInt(r.week ?? r.gameday ?? r.game_week);
  const home = T(r.home_team ?? r.home_team_abbr ?? r.home);
  const away = T(r.away_team ?? r.away_team_abbr ?? r.away);
  const id = r.game_id ?? r.gsis ?? `${season}-W${String(week).padStart(2, "0")}-${away}-${home}`;
  return { season, week, home, away, game_id: id };
}

export async function buildSeasonDB(season) {
  const y = toInt(season);
  if (y == null) throw new Error("buildSeasonDB season");
  const [
    schedulesAll,
    qbrAll,
    officialsAll,
    snapRows,
    teamWeeklyRows,
    teamAdvRows,
    playerWeeklyRows,
    rosterRows,
    depthRows,
    ftnRows,
    pbpRows,
    pfrAdvMap
  ] = await Promise.all([
    loadSchedulesDS(),
    loadESPNQBRDS(y),
    loadOfficialsDS(y),
    loadSnapCountsDS(y),
    loadTeamWeeklyDS(y),
    loadTeamGameAdvancedDS(y),
    loadPlayerWeeklyDS(y),
    loadRostersWeeklyDS(y),
    loadDepthChartsDS(y),
    loadFTNChartsDS(y),
    loadPBPDS(y),
    loadPFRAdvTeamWeeklyDS(y)
  ]);

  const schedules = schedulesAll.filter((r) => toInt(r.season ?? r.year) === y);

  const gamesById = new Map();
  const weeksIndex = new Map();
  for (const r of schedules) {
    const { season: s, week: w, home, away, game_id } = scheduleKey(r);
    if (s == null || w == null || !home || !away) continue;
    const gid = kGame(game_id);
    gamesById.set(gid, { game_id: gid, season: s, week: w, home_team: home, away_team: away, raw: r });
    const wkKey = `${s}|${w}`;
    if (!weeksIndex.has(wkKey)) weeksIndex.set(wkKey, []);
    weeksIndex.get(wkKey).push(gid);
  }

  const teamWeekMap = new Map();
  for (const r of teamWeeklyRows) {
    const s = toInt(r.season ?? r.year);
    const w = toInt(r.week ?? r.wk);
    const t = T(r.team ?? r.team_abbr ?? r.TEAM);
    if (s == null || w == null || !t) continue;
    teamWeekMap.set(keyTW(s, w, t), r);
  }

  const qbrMap = new Map();
  for (const r of qbrAll) {
    const s = toInt(r.season ?? r.year);
    const w = toInt(r.week ?? r.wk);
    const t = T(r.team ?? r.team_abbr ?? r.QBR_TEAM ?? r.team_name);
    if (s == null || w == null || !t) continue;
    qbrMap.set(keyTW(s, w, t), r);
  }

  const officialsByGame = new Map();
  for (const r of officialsAll) {
    const gid = kGame(r.game_id ?? r.gsis_id ?? r.gid);
    if (gid) officialsByGame.set(gid, r);
  }

  return {
    season: y,
    gamesById,
    weeksIndex,
    teamWeekMap,
    playerWeekly: playerWeeklyRows,
    depthCharts: depthRows,
    rosters: rosterRows,
    ftnChart: ftnRows,
    teamGameAdvanced: teamAdvRows,
    qbrMap,
    officialsByGame,
    snaps: snapRows,
    pfrAdvWeekly: pfrAdvMap,
    pbp: pbpRows
  };
}

export function attachAdvWeeklyDiff(db, feat, week, homeTeam, awayTeam) {
  const wk = toInt(week);
  const hKey = `${db.season}|${wk}|${T(homeTeam)}`;
  const aKey = `${db.season}|${wk}|${T(awayTeam)}`;
  const h = db.pfrAdvWeekly.get(hKey);
  const a = db.pfrAdvWeekly.get(aKey);
  if (h) {
    for (const [k, v] of Object.entries(h)) {
      if (["season", "week", "team"].includes(k)) continue;
      if (typeof v === "number") feat[`home_${k}`] = v;
    }
  }
  if (a) {
    for (const [k, v] of Object.entries(a)) {
      if (["season", "week", "team"].includes(k)) continue;
      if (typeof v === "number") feat[`away_${k}`] = v;
    }
  }
  if (h && a) {
    for (const [k, v] of Object.entries(h)) {
      if (["season", "week", "team"].includes(k)) continue;
      const av = a[k];
      if (typeof v === "number" && typeof av === "number") {
        feat[`diff_${k}`] = v - av;
      }
    }
  }
  return feat;
}

export function listWeekGames(db, week) {
  const key = `${db.season}|${toInt(week)}`;
  const ids = db.weeksIndex.get(key) || [];
  return ids.map((id) => db.gamesById.get(id)).filter(Boolean);
}

// CLI
if (import.meta && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, rawVal] = arg.split('=', 2);
    const key = rawKey.replace(/^--/, '');
    if (rawVal !== undefined) {
      opts[key] = rawVal;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      opts[key] = argv[i + 1];
      i += 1;
    } else {
      opts[key] = true;
    }
  }

  const envSeason = toInt(process.env.SEASON);
  const targetSeason = toInt(opts.season) || envSeason || new Date().getFullYear();
  const targetWeek = opts.week != null ? toInt(opts.week) : (process.env.WEEK ? toInt(process.env.WEEK) : null);
  const includeAll = Boolean(
    opts.all === true ||
      /^(1|true|yes)$/i.test(String(opts.all ?? '')) ||
      /^(1|true|yes)$/i.test(String(process.env.ALL_SEASONS ?? process.env.ALL ?? ''))
  );
  const cliSince = opts.since != null ? toInt(opts.since) : null;
  const envSince = process.env.SINCE_SEASON ? toInt(process.env.SINCE_SEASON) : null;
  const sinceSeason =
    cliSince ??
    envSince ??
    (!includeAll && PUBLIC_API_ENABLED
      ? (Number.isFinite(PUBLIC_API_SEASON_CUTOFF) ? PUBLIC_API_SEASON_CUTOFF : targetSeason)
      : null);
  const maxSeasons = opts.max != null ? toInt(opts.max) : (process.env.MAX_SEASONS ? toInt(process.env.MAX_SEASONS) : null);
  const outDir = opts.out || process.env.ARTIFACT_DIR || 'artifacts';

  (async () => {
    const discovered = await listDatasetSeasons('teamWeekly').catch(() => []);
    const seasons = await resolveSeasonList({
      targetSeason,
      includeAll,
      sinceSeason,
      maxSeasons,
      availableSeasons: discovered,
      publicApiEnabled: PUBLIC_API_ENABLED,
      publicApiCutoff: PUBLIC_API_SEASON_CUTOFF
    });
    if (!seasons.length) {
      throw new Error('No seasons resolved for context build');
    }
    console.log(`[context] seasons selected: ${seasons.join(', ')}`);
    ensureDir(outDir);
    const indexEntries = [];
    for (const season of seasons) {
      const payload = await buildContextDB(season, targetWeek, outDir);
      const fileName = `context_${season}_to_W${String(payload.built_through_week ?? 0).padStart(2, '0')}.json`;
      indexEntries.push({
        season,
        built_through_week: payload.built_through_week ?? null,
        artifact: path.join(outDir, fileName)
      });
    }
    const indexPath = path.join(outDir, 'context_index.json');
    fs.writeFileSync(
      indexPath,
      JSON.stringify({ generated_at: new Date().toISOString(), seasons: indexEntries }, null, 2)
    );
    console.log(`[context] WROTE ${indexPath}`);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
