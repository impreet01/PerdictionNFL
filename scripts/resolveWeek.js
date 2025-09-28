// scripts/resolveWeek.js
// Decide which WEEK to train/predict:
// WEEK = min( maxWeekInTeamWeekly + 1, maxWeekInSchedule ), and >= 2.
// Prints: "Resolved WEEK=<n>"

import { loadSchedules, loadTeamWeekly } from "../trainer/dataSources.js";

async function main() {
  const SEASON = Number(process.env.SEASON || new Date().getFullYear());

  const schedules = await loadSchedules();
  const regWeeks = [...new Set(
    schedules
      .filter(g => Number(g.season) === SEASON && String(g.season_type || "").toUpperCase().startsWith("REG"))
      .map(g => Number(g.week))
      .filter(Number.isFinite)
  )].sort((a,b)=>a-b);
  const maxSchedWeek = regWeeks.length ? regWeeks[regWeeks.length - 1] : 18;

  let maxWeekInData = 1;
  try {
    const teamWeekly = await loadTeamWeekly(SEASON);
    const twWeeks = [...new Set(
      (teamWeekly || [])
        .filter(r => Number(r.season) === SEASON)
        .map(r => Number(r.week))
        .filter(Number.isFinite)
    )].sort((a,b)=>a-b);
    if (twWeeks.length) maxWeekInData = twWeeks[twWeeks.length - 1];
  } catch {
    // fall back to 1 if teamWeekly not yet published
  }

  let WEEK = Math.min(maxSchedWeek, Math.max(2, maxWeekInData + 1));
  console.log(`Resolved WEEK=${WEEK}`);
}

main().catch(e => {
  console.log("Resolved WEEK="); // keep workflow tolerant
  process.exit(0);
});
