// scripts/resolveWeek.js
// Decide which NFL regular-season week to PREDICT next from nflverse schedules.
// Always return at least WEEK=2 (Week 1 has no prior history for S2D features).
//
// Outputs a GitHub Actions output line: week=<N>
//
// SEASON inference:
// - If env SEASON is set, use it.
// - Otherwise: if month <= Feb, use previous year; else current year.

import axios from "axios";
import Papa from "papaparse";

const SCHEDULES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

function inferSeason() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return m <= 2 ? y - 1 : y;
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
  const hs = row.home_score ?? row.home_points ?? row.home_pts ?? null;
  const as = row.away_score ?? row.away_points ?? row.away_pts ?? null;
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

  const weeks = [...new Set(rows.map(r => Number(r.week)).filter(w => Number.isFinite(w)))].sort((a,b)=>a-b);
  if (weeks.length === 0) {
    process.stdout.write(`week=2\n`); // default floor
    process.exit(0);
  }

  let chosen = null;
  for (const w of weeks) {
    const games = rows.filter(r => Number(r.week) === w);
    const allScored = games.every(hasScore);
    if (!allScored) { chosen = w; break; } // upcoming/in-progress week
  }
  if (chosen == null) chosen = weeks[weeks.length - 1]; // all finished -> last week

  if (chosen < 2) chosen = 2; // floor to week 2 (Week 1 has no S2D)

  process.stdout.write(`week=${chosen}\n`);
} catch (_e) {
  // Fail-safe: don't break the workflow; choose a sane default
  process.stdout.write(`week=2\n`);
}
