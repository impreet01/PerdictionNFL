import { loadSchedules, loadTeamWeekly, loadTeamGameAdvanced } from "../trainer/dataSources.js";
import { buildFeatures } from "../trainer/featureBuild.js";
import { buildBTFeatures } from "../trainer/featureBuild_bt.js";

const season = Number(process.env.SEASON ?? 2025);

const schedules = await loadSchedules(season);
const teamWeekly = await loadTeamWeekly(season);
const teamGame = await loadTeamGameAdvanced(season);

console.log({ schedules: schedules.length, teamWeekly: teamWeekly.length, teamGame: teamGame.length });

const feats = buildFeatures({ teamWeekly, teamGame, schedules, season });
const bt = buildBTFeatures({ teamWeekly, teamGame, schedules, season });

console.log({ featureRows: feats.length, btRows: bt.length, sample: feats.slice(0, 3) });
