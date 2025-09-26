// trainer/dataSources.js
// Downloads nflverse schedules and team weekly stats (CSV or CSV.GZ) for a given season.

import axios from "axios";
import Papa from "papaparse";
import { gunzipSync } from "zlib";

const NFLVERSE_RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const STATS_TEAM_TAG = "stats_team"; // team weekly stats bundle
const SCHEDULES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

/** Parse CSV text -> array of objects */
function parseCSV(text) {
  const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  return parsed.data;
}

/** Fetch a text file */
async function fetchText(url) {
  const { data } = await axios.get(url, { responseType: "text" });
  return data;
}

/** Fetch a CSV or CSV.GZ and return rows */
async function fetchCSVMaybeGz(url) {
  if (url.endsWith(".csv")) {
    const text = await fetchText(url);
    return parseCSV(text);
  }
  if (url.endsWith(".csv.gz")) {
    const { data, headers } = await axios.get(url, { responseType: "arraybuffer" });
    // Some CDNs auto-decompress; detect by header
    let buf = Buffer.from(data);
    const enc = (headers["content-encoding"] || "").toLowerCase();
    if (enc.includes("gzip")) {
      // already compressed; gunzip
      buf = gunzipSync(buf);
    } else {
      // may still be gzipped file content
      try { buf = gunzipSync(buf); } catch (_) { /* noop if already plain */ }
    }
    const text = buf.toString("utf8");
    return parseCSV(text);
  }
  throw new Error(`Unsupported extension for ${url}`);
}

/** Load schedules (all seasons) then filter by caller */
export async function loadSchedules() {
  // Contains: season, week, season_type (REG/POST), game_id, home_team, away_team, etc.
  const text = await fetchText(SCHEDULES_URL);
  return parseCSV(text);
}

/** Load team weekly stats for a season from nflverse-data release */
export async function loadTeamWeekly(season) {
  // Try CSV, then CSV.GZ (common for recent seasons)
  const candidates = [
    `${NFLVERSE_RELEASE}/stats_team/team_stats_week_${season}.csv`,
    `${NFLVERSE_RELEASE}/stats_team/team_stats_week_${season}.csv.gz`,
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
