// trainer/dataSources.js
// Downloads nflverse schedules and team weekly stats (CSV or CSV.GZ) for a given season.
// Uses the asset pattern: stats_team_week_<season>.csv[.gz]

import axios from "axios";
import Papa from "papaparse";
import { gunzipSync } from "zlib";

const NFLVERSE_RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const STATS_TEAM_TAG = "stats_team"; // team-week summary release
const SCHEDULES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

/** Parse CSV text -> array of objects */
function parseCSV(text) {
  const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  return parsed.data;
}

/** Fetch text */
async function fetchText(url) {
  const { data } = await axios.get(url, { responseType: "text" });
  return data;
}

/** Fetch CSV or CSV.GZ -> rows[] */
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
      try { buf = gunzipSync(buf); } catch (_) { /* already plain */ }
    }
    const text = buf.toString("utf8");
    return parseCSV(text);
  }
  throw new Error(`Unsupported extension for ${url}`);
}

/** Load schedules (all seasons) */
export async function loadSchedules() {
  const text = await fetchText(SCHEDULES_URL);
  return parseCSV(text);
}

/** Load team-week stats for a season */
export async function loadTeamWeekly(season) {
  // Correct filename pattern here:
  const candidates = [
    `${NFLVERSE_RELEASE}/${STATS_TEAM_TAG}/stats_team_week_${season}.csv`,
    `${NFLVERSE_RELEASE}/${STATS_TEAM_TAG}/stats_team_week_${season}.csv.gz`,
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
