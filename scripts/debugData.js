// scripts/debugData.js
import { CONFIG } from "../config/env.js";
import { loadSchedules, loadTeamWeekly, loadTeamGameAdvanced } from "../trainer/dataSources.js";
import { buildFeatures } from "../trainer/featureBuild.js";

void CONFIG;

const SEASON = Number(process.env.SEASON || new Date().getFullYear());
const WEEK = Number(process.env.WEEK || 2);

function counts(arr, key) {
  const m = new Map();
  for (const r of arr) {
    const k = r[key];
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a,b)=> String(a[0]).localeCompare(String(b[0])));
}

(async () => {
  console.log(`DEBUG: Season=${SEASON}, TargetWeek=${WEEK}`);
  const schedules = await loadSchedules(SEASON);
  const schedReg = schedules.filter(r => Number(r.season) === SEASON);
  console.log(`schedules total rows (this season): ${schedReg.length}`);
  console.log(`schedules season_type counts:`, counts(schedReg, "season_type"));
  console.log(`schedules week counts:`, counts(schedReg, "week"));

  let teamWeekly = [];
  try {
    teamWeekly = await loadTeamWeekly(SEASON);
    console.log(`teamWeekly rows (season ${SEASON}): ${teamWeekly.length}`);
    console.log(`teamWeekly season_type counts:`, counts(teamWeekly, "season_type"));
    console.log(`teamWeekly week counts:`, counts(teamWeekly, "week"));
  } catch (e) {
    console.log(`loadTeamWeekly(${SEASON}) failed: ${e?.message || e}`);
  }

  let teamGame = [];
  try {
    teamGame = await loadTeamGameAdvanced(SEASON);
    console.log(`teamGame rows (season ${SEASON}): ${teamGame.length}`);
  } catch (e) {
    console.log(`loadTeamGameAdvanced(${SEASON}) failed: ${e?.message || e}`);
  }

  let prevTeamWeekly = [];
  try {
    prevTeamWeekly = await loadTeamWeekly(SEASON - 1);
    console.log(`teamWeekly rows (season ${SEASON - 1}): ${prevTeamWeekly.length}`);
  } catch (e) {
    console.log(`loadTeamWeekly(${SEASON - 1}) failed: ${e?.message || e}`);
  }

  const featRows = buildFeatures({ teamWeekly, teamGame, schedules, season: SEASON, prevTeamWeekly });
  console.log(`feature rows (REG relaxed): ${featRows.length}`);
  const train = featRows.filter(r => r.season === SEASON && r.week < WEEK);
  const test  = featRows.filter(r => r.season === SEASON && r.week === WEEK);
  console.log(`train rows (< W${WEEK}): ${train.length}`);
  console.log(`test rows (== W${WEEK}): ${test.length}`);
})();
