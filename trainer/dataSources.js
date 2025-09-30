// trainer/dataSources.js
// Downloads nflverse schedules and team weekly stats (CSV or CSV.GZ) for a given season.
// Uses the asset pattern: stats_team_week_<season>.csv[.gz]

import axios from "axios";
import Papa from "papaparse";
import { gunzipSync } from "node:zlib"; // <-- use Node built-in zlib

const NFLVERSE_RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const STATS_TEAM_TAG = "stats_team";
const TEAM_GAME_TAG = "team_game";
const PBP_TAG = "pbp";
const PLAYER_WEEKLY_TAG = "player_stats";
const SCHEDULES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

function parseCSV(text) {
  const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  return parsed.data;
}

async function fetchText(url) {
  const { data } = await axios.get(url, { responseType: "text" });
  return data;
}

async function fetchCSVMaybeGz(url) {
  if (url.endsWith(".csv")) {
    const text = await fetchText(url);
    return parseCSV(text);
  }
  if (url.endsWith(".csv.gz")) {
    const { data, headers } = await axios.get(url, { responseType: "arraybuffer" });
    let buf = Buffer.from(data);
    const enc = (headers["content-encoding"] || "").toLowerCase();
    if (enc.includes("gzip")) {
      buf = gunzipSync(buf);
    } else {
      try { buf = gunzipSync(buf); } catch (_) { /* not gzipped, ignore */ }
    }
    const text = buf.toString("utf8");
    return parseCSV(text);
  }
  throw new Error(`Unsupported extension for ${url}`);
}

function inferRoofFlags(row = {}) {
  const rawRoof =
    row.roof ?? row.stadium_type ?? row.venue_type ?? row.roof_type ?? row.stadium_roof ?? row.venue_roof;
  if (rawRoof == null || rawRoof === "") {
    return { is_dome: null, is_outdoor: null };
  }
  const roof = String(rawRoof).toLowerCase();
  const isDome = /dome|indoor/.test(roof);
  const isOutdoor = /outdoor|open/.test(roof);
  return { is_dome: isDome ? 1 : 0, is_outdoor: isOutdoor ? 1 : 0 };
}

export async function loadSchedules() {
  const text = await fetchText(SCHEDULES_URL);
  const rows = parseCSV(text);
  return rows.map((row) => {
    const flags = inferRoofFlags(row);
    return { ...row, ...flags };
  });
}

export async function loadTeamWeekly(season) {
  const candidates = [
    `${NFLVERSE_RELEASE}/${STATS_TEAM_TAG}/stats_team_week_${season}.csv`,
    `${NFLVERSE_RELEASE}/${STATS_TEAM_TAG}/stats_team_week_${season}.csv.gz`
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const rows = await fetchCSVMaybeGz(url);
      if (rows?.length) return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not fetch team weekly stats for ${season}: ${lastErr?.message || "no candidates succeeded"}`);
}

export async function loadTeamGameAdvanced(season) {
  const suffixes = [
    `team_game_${season}.csv`,
    `team_game_${season}.csv.gz`,
    `team_games_${season}.csv`,
    `team_games_${season}.csv.gz`
  ];
  const rawBases = [
    "https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/team_game",
    "https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/team_game",
    "https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/team_games",
    "https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/team_games",
    "https://raw.githubusercontent.com/nflverse/nfldata/master/data/team_game",
    "https://raw.githubusercontent.com/nflverse/nfldata/master/data/team_games"
  ];
  const releaseCandidates = suffixes.map((s) => `${NFLVERSE_RELEASE}/${TEAM_GAME_TAG}/${s}`);
  const rawCandidates = rawBases.flatMap((base) => suffixes.map((s) => `${base}/${s}`));
  const candidates = [...releaseCandidates, ...rawCandidates];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const rows = await fetchCSVMaybeGz(url);
      if (Array.isArray(rows)) return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) {
    console.warn(`loadTeamGameAdvanced(${season}) fell back to empty dataset: ${lastErr?.message}`);
  }
  return [];
}

export async function loadPBP(season) {
  const suffixes = [
    `play_by_play_${season}.csv.gz`,
    `play_by_play_${season}.csv`
  ];
  const releaseCandidates = suffixes.map((s) => `${NFLVERSE_RELEASE}/${PBP_TAG}/${s}`);
  const rawBases = [
    "https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/play_by_play",
    "https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/play_by_play",
    "https://raw.githubusercontent.com/nflverse/nfldata/master/data/play_by_play"
  ];
  const rawCandidates = rawBases.flatMap((base) => suffixes.map((s) => `${base}/${s}`));
  const candidates = [...releaseCandidates, ...rawCandidates];
  for (const url of candidates) {
    try {
      const rows = await fetchCSVMaybeGz(url);
      if (Array.isArray(rows) && rows.length) return rows;
    } catch (err) {
      // ignore and try next candidate
    }
  }
  console.warn(`loadPBP(${season}) fell back to empty dataset`);
  return [];
}

export async function loadPlayerWeekly(season) {
  const suffixes = [
    `player_stats_weekly_${season}.csv.gz`,
    `player_stats_weekly_${season}.csv`,
    `player_stats_${season}.csv.gz`,
    `player_stats_${season}.csv`
  ];
  const releaseCandidates = suffixes.map((s) => `${NFLVERSE_RELEASE}/${PLAYER_WEEKLY_TAG}/${s}`);
  const rawBases = [
    "https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/player_stats_weekly",
    "https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/player_stats_weekly",
    "https://raw.githubusercontent.com/nflverse/nfldata/master/data/player_stats_weekly",
    "https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/player_stats",
    "https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/player_stats",
    "https://raw.githubusercontent.com/nflverse/nfldata/master/data/player_stats"
  ];
  const rawCandidates = rawBases.flatMap((base) => suffixes.map((s) => `${base}/${s}`));
  const candidates = [...releaseCandidates, ...rawCandidates];
  for (const url of candidates) {
    try {
      const rows = await fetchCSVMaybeGz(url);
      if (Array.isArray(rows) && rows.length) return rows;
    } catch (err) {
      // ignore and continue
    }
  }
  console.warn(`loadPlayerWeekly(${season}) fell back to empty dataset`);
  return [];
}
