// scripts/resolveWeek.js
// Resolve WEEK = max(2, min(maxSchedWeek, lastFullWeek + 1))
// "lastFullWeek" = latest regular-season week where ALL scheduled games have final scores.

import { loadSchedules } from "../trainer/dataSources.js";

function isReg(v) {
  if (v == null) return true;
  const s = String(v).trim().toUpperCase();
  return s === "" || s.startsWith("REG");
}

function coerceScore(value) {
  if (value == null) return NaN;
  const text = String(value).trim();
  if (text === "" || text.toUpperCase() === "NA") return NaN;
  const num = Number(text);
  return Number.isFinite(num) ? num : NaN;
}

function hasFinalScore(g) {
  const hs = coerceScore(g.home_score ?? g.home_points ?? g.home_pts);
  const as = coerceScore(g.away_score ?? g.away_points ?? g.away_pts);
  return Number.isFinite(hs) && Number.isFinite(as);
}

async function main() {
  const SEASON = Number(process.env.SEASON || new Date().getFullYear());
  const schedules = await loadSchedules(SEASON);

  const reg = schedules.filter(
    (g) => Number(g.season) === SEASON && isReg(g.season_type)
  );

  const weeks = [...new Set(reg.map((g) => Number(g.week)).filter(Number.isFinite))].sort((a, b) => a - b);
  const maxSchedWeek = weeks.length ? weeks[weeks.length - 1] : 18;

  // compute last full week (all games have final scores)
  let lastFull = 0;
  for (const w of weeks) {
    const games = reg.filter((g) => Number(g.week) === w);
    const allFinal = games.length > 0 && games.every(hasFinalScore);
    if (allFinal) lastFull = w; else break;
  }

  let WEEK = Math.max(2, Math.min(maxSchedWeek, lastFull + 1));
  console.log(`Resolved WEEK=${WEEK}`);
}

main().catch((err) => {
  // Be tolerant; let the workflow continue even if resolution fails
  console.warn(`resolveWeek failed: ${err?.message || err}`);
  console.log("Resolved WEEK=");
});
