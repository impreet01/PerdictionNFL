// scripts/debugData.js
import { loadSchedules, loadTeamWeekly } from "../trainer/dataSources.js";
import { buildFeatures } from "../trainer/featureBuild.js";

const SEASON = Number(process.env.SEASON || new Date().getFullYear());
const WEEK = Number(process.env.WEEK || 2);

function countBy(arr, key) {
  const m = new Map();
  for (const r of arr) {
    const k = r[key];
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a,b)=>a[0]-b[0]);
}

(async () => {
  console.log(`DEBUG: Season=${SEASON}, Week(target)=${WEEK}`);

  // Schedules
  const schedules = await loadSchedules();
  const schedReg = schedules.filter(r => Number(r.season) === SEASON && String(r.season_type).toUpperCase() === "REG");
  console.log(`DEBUG: schedules REG rows this season: ${schedReg.length}`);
  console.log(`DEBUG: schedules by week (rows):`, countBy(schedReg, "week"));

  // Team weekly current season
  let teamWeekly = [];
  try {
    teamWeekly = await loadTeamWeekly(SEASON);
    console.log(`DEBUG: teamWeekly rows (season ${SEASON}): ${teamWeekly.length}`);
  } catch (e) {
    console.log(`DEBUG: loadTeamWeekly(${SEASON}) failed: ${e?.message || e}`);
  }

  // Team weekly previous season (for W1 carry-in)
  let prevTeamWeekly = [];
  try {
    prevTeamWeekly = await loadTeamWeekly(SEASON - 1);
    console.log(`DEBUG: teamWeekly rows (season ${SEASON-1}): ${prevTeamWeekly.length}`);
  } catch (e) {
    console.log(`DEBUG: loadTeamWeekly(${SEASON-1}) failed: ${e?.message || e}`);
  }

  // Build features and show train/test sizes
  const featRows = buildFeatures({ teamWeekly, schedules, season: SEASON, prevTeamWeekly });
  console.log(`DEBUG: feature rows (REG only): ${featRows.length}`);

  const train = featRows.filter(r => r.season === SEASON && r.week < WEEK);
  const test  = featRows.filter(r => r.season === SEASON && r.week === WEEK);

  console.log(`DEBUG: train rows (< week ${WEEK}): ${train.length}`);
  console.log(`DEBUG: test rows (== week ${WEEK}): ${test.length}`);

  // Helpful peek
  if (train.length) {
    const sample = train[0];
    console.log(`DEBUG: sample train row keys: ${Object.keys(sample).slice(0, 20).join(", ")} ...`);
  }
})();
