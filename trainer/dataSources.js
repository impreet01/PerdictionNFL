// trainer/dataSources.js
// Downloads nflverse schedules and team weekly stats (CSV or CSV.GZ) for a given season.
// Uses the asset pattern: stats_team_week_<season>.csv[.gz]

import axios from "axios";
import Papa from "papaparse";
import { gunzipSync } from "node:zlib"; // <-- use Node built-in zlib

const NFLVERSE_RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const STATS_TEAM_TAG = "stats_team";
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

export async function loadSchedules() {
  const text = await fetchText(SCHEDULES_URL);
  return parseCSV(text);
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
