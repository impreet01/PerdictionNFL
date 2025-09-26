// scripts/resolveWeek.js
// Decide which NFL regular-season week to PREDICT next, based on nflverse schedules.
// Output: a GitHub Action output named `week=<N>`
//
// Logic: for the target season, find the FIRST REG week that is NOT fully scored
// (i.e., any game has missing scores). That week is "upcoming" -> predict it.
// If all weeks are scored, fallback to the max REG week.
//
// You can pin season via env SEASON; otherwise we infer from today:
//  - If month <= 2 (Jan/Feb), season = currentYear - 1 (postseason spillover)
//  - Else season = currentYear

import axios from "axios";
import Papa from "papaparse";

const SCHEDULES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

function inferSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1..12
  return m <= 2 ? year - 1 : year; // Jan/Feb -> previous season
}

function parseCSV(text) {
  const { data } = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  return data;
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function hasScore(row) {
  // Accept several possible column names found in nfldata:
  // home_score/away_score OR result columns. Treat missing/blank as "no score yet".
  const hs = row.home_score ?? row.home_points ?? row.home_pts ?? row.home ?? null;
  const as = row.away_score ?? row.away_points ?? row.away_pts ?? row.away ?? null;
  const h = toInt(hs);
  const a = toInt(as);
  return Number.isFinite(h) && Number.isFinite(a);
}

try {
  const season = Number(process.env.SEASON || inferSeason());
  const text = await axios.get(SCHEDULES_URL, { responseType: "text" }).then(r => r.data);
  const rows = parseCSV(text).filter(
    r => Number(r.season) === season && String(r.season_type).toUpperCase() === "REG"
  );

  // Weeks present in data
  const weeks = [...new Set(rows.map(r => Number(r.week)).filter(w => Number.isFinite(w)))].sort((a,b)=>a-b);
  if (weeks.length === 0) {
    // Default to week 1 if schedules aren’t there yet for some reason
    process.stdout.write(`week=1\n`);
    process.exit(0);
  }

  // For each week in order, if ANY game is missing a score -> that's the next (upcoming) week to predict
  let chosen = null;
  for (const w of weeks) {
    const games = rows.filter(r => Number(r.week) === w);
    const allScored = games.every(hasScore);
    if (!allScored) { chosen = w; break; }
  }
  if (chosen == null) {
    // All weeks scored -> pick the last (useful for backfills)
    chosen = weeks[weeks.length - 1];
  }

  // Emit GitHub Actions output
  process.stdout.write(`week=${chosen}\n`);
} catch (e) {
  // If anything fails, default to week 1 so the workflow doesn't crash
  process.stdout.write(`week=1\n`);
}
