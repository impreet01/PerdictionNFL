// trainer/tests/smoke.js
// Synthetic smoke test to ensure pipeline produces artifacts with required keys.

import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { runTraining, writeArtifacts, updateHistoricalArtifacts } from "../train_multi.js";
import { adaptTeamWeekly } from "../apiAdapter.js";
import {
  loadBettingOdds as loadBettingOddsSource,
  loadDepthCharts as loadDepthChartsSource,
  loadInjuries as loadInjuriesSource,
  loadPlayerProjections as loadPlayerProjectionsSource,
  loadPlayerWeekly as loadPlayerWeeklySource,
  loadRostersWeekly as loadRostersWeeklySource,
  loadSchedules as loadSchedulesSource,
  loadTeamWeekly as loadTeamWeeklySource
} from "../dataSources.js";

const teams = ["A", "B", "C", "D"];

function makeGame(season, week, home, away, homeScore, awayScore) {
  return {
    season,
    week,
    game_id: `${season}-${week}-${home}-${away}`,
    home_team: home,
    away_team: away,
    home_score: homeScore,
    away_score: awayScore,
    season_type: "REG"
  };
}

function makeTeamRow(
  season,
  week,
  team,
  opponent,
  home,
  scoreFor,
  scoreAgainst,
  totalYards,
  passYards,
  rushYards,
  turnovers,
  oppTotalYards,
  oppPassYards,
  oppRushYards,
  defTakeaways,
  thirdAtt,
  thirdConv,
  redAtt,
  redTd,
  passAtt,
  rushAtt,
  sacksTaken,
  neutralPassAtt,
  neutralRushAtt
) {
  return {
    season,
    week,
    team,
    opponent,
    home,
    points_scored: scoreFor,
    points_allowed: scoreAgainst,
    total_yards: totalYards,
    passing_yards: passYards,
    rushing_yards: rushYards,
    turnovers,
    yards_allowed: oppTotalYards,
    pass_yards_allowed: oppPassYards,
    rush_yards_allowed: oppRushYards,
    def_turnovers: defTakeaways,
    third_down_attempts: thirdAtt,
    third_down_converted: thirdConv,
    red_zone_att: redAtt,
    red_zone_td: redTd,
    pass_attempts: passAtt,
    rush_attempts: rushAtt,
    sacks_taken: sacksTaken,
    neutral_pass_attempts: neutralPassAtt,
    neutral_rush_attempts: neutralRushAtt
  };
}

function makeTeamGameRow(season, week, team, thirdAtt, thirdConv, redAtt, redTd, passAtt, rushAtt, sacksTaken) {
  return {
    season,
    week,
    team,
    third_down_att: thirdAtt,
    third_down_conv: thirdConv,
    red_zone_att: redAtt,
    red_zone_td: redTd,
    pass_att: passAtt,
    rush_att: rushAtt,
    sacks_taken: sacksTaken
  };
}

async function main() {
  const season = 2023;
  await maybeExerciseTankSources(season);
  rmSync("artifacts", { recursive: true, force: true });
  mkdirSync("artifacts", { recursive: true });
  const schedules = [
    makeGame(season, 1, "A", "B", 24, 20),
    makeGame(season, 1, "C", "D", 17, 21),
    makeGame(season, 2, "A", "C", 30, 27),
    makeGame(season, 2, "B", "D", 10, 14),
    makeGame(season, 3, "A", "D", 28, 31),
    makeGame(season, 3, "B", "C", 24, 17)
  ];
  const teamWeeklyRaw = [];
  const teamGame = [];
  for (const game of schedules) {
    const base = 350 + game.week * 10;
    const homePassYards = base - 120;
    const awayTotal = base - 30;
    const awayPassYards = base - 150;
    const homeRushYards = base - homePassYards;
    const awayRushYards = awayTotal - awayPassYards;
    const thirdAttHome = 12 + game.week;
    const thirdAttAway = 11 + game.week;
    const redAttHome = 5 + game.week;
    const redAttAway = 4 + game.week;
    const passAttHome = 32 + game.week;
    const passAttAway = 30 + game.week;
    const rushAttHome = 28 + game.week;
    const rushAttAway = 30 + game.week;
    teamWeeklyRaw.push(
      makeTeamRow(
        season,
        game.week,
        game.home_team,
        game.away_team,
        1,
        game.home_score,
        game.away_score,
        base,
        homePassYards,
        homeRushYards,
        1,
        awayTotal,
        awayPassYards,
        awayRushYards,
        2,
        thirdAttHome,
        Math.floor(thirdAttHome * 0.5),
        redAttHome,
        3 + game.week,
        passAttHome,
        rushAttHome,
        2,
        passAttHome,
        rushAttHome
      )
    );
    teamWeeklyRaw.push(
      makeTeamRow(
        season,
        game.week,
        game.away_team,
        game.home_team,
        0,
        game.away_score,
        game.home_score,
        awayTotal,
        awayPassYards,
        awayRushYards,
        2,
        base,
        homePassYards,
        homeRushYards,
        1,
        thirdAttAway,
        Math.floor(thirdAttAway * 0.45),
        redAttAway,
        2 + game.week,
        passAttAway,
        rushAttAway,
        3,
        passAttAway,
        rushAttAway
      )
    );
    teamGame.push(
      makeTeamGameRow(
        season,
        game.week,
        game.home_team,
        thirdAttHome,
        Math.floor(thirdAttHome * 0.5),
        5 + game.week,
        3 + game.week,
        32 + game.week,
        28 + game.week,
        2
      ),
      makeTeamGameRow(
        season,
        game.week,
        game.away_team,
        thirdAttAway,
        Math.floor(thirdAttAway * 0.45),
        4 + game.week,
        2 + game.week,
        30 + game.week,
        30 + game.week,
        3
      )
    );
  }

  const teamWeekly = adaptTeamWeekly(teamWeeklyRaw);

  const options = {
    btBootstrapSamples: 20,
    annSeeds: 3,
    annMaxEpochs: 50,
    annCvMaxEpochs: 20,
    annCvSeeds: 2,
    weightStep: 0.1,
    skipSeasonDB: true
  };

  const week2 = await runTraining({
    season,
    week: 2,
    data: { schedules, teamWeekly, teamGame, prevTeamWeekly: [] },
    options
  });

  if (!Array.isArray(week2.predictions) || !week2.predictions.length) {
    throw new Error("Smoke test: week 2 predictions missing");
  }
  const hasNonFinite = week2.predictions.some((p) => {
    if (!Number.isFinite(p?.forecast)) return true;
    if (!p?.probs || typeof p.probs !== "object") return true;
    return Object.values(p.probs).some((v) => !Number.isFinite(v));
  });
  if (hasNonFinite) throw new Error("Smoke test: week 2 predictions must be finite");

  const result = await runTraining({
    season,
    week: 3,
    data: { schedules, teamWeekly, teamGame, prevTeamWeekly: [] },
    options
  });

  if (!Array.isArray(result.predictions) || !result.predictions.length) {
    throw new Error("Smoke test: predictions missing");
  }
  const sample = result.predictions[0];
  const required = ["probs", "blend_weights", "calibration", "ci", "top_drivers", "natural_language"];
  for (const key of required) {
    if (!(key in sample)) throw new Error(`Smoke test: prediction missing ${key}`);
  }
  if (!result.modelSummary?.bt?.coefficients) throw new Error("Smoke test: BT coefficients missing");
  if (!result.diagnostics?.metrics?.ensemble) throw new Error("Smoke test: diagnostics missing ensemble metrics");
  if (!Array.isArray(result.btDebug) || !result.btDebug.length) throw new Error("Smoke test: btDebug missing");

  result.context = [];
  await writeArtifacts(result);
  updateHistoricalArtifacts({ season, schedules });

  const indexPath = `artifacts/season_index_${season}.json`;
  if (!existsSync(indexPath)) throw new Error("Smoke test: season index missing");
  const indexData = JSON.parse(readFileSync(indexPath, "utf8"));
  if (indexData.latest_completed_week !== 3) throw new Error("Smoke test: season index latest week incorrect");
  if (!Array.isArray(indexData.weeks) || indexData.weeks.length !== 3)
    throw new Error("Smoke test: season index weeks incorrect");
  const week3Meta = indexData.weeks.find((w) => w.week === 3);
  if (!week3Meta?.completed) throw new Error("Smoke test: week 3 metadata missing completion");
  if (!week3Meta.metrics?.exists || !week3Meta.outcomes?.exists)
    throw new Error("Smoke test: week 3 metadata missing artifacts");

  const summaryPath = `artifacts/season_summary_${season}.json`;
  if (!existsSync(summaryPath)) throw new Error("Smoke test: season summary missing");
  const summaryData = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (summaryData.total_games < 2) throw new Error("Smoke test: season summary total games incorrect");
  if (!Array.isArray(summaryData.weekly_summaries) || summaryData.weekly_summaries.length !== 1)
    throw new Error("Smoke test: season summary weekly summaries incorrect");
  if (!Array.isArray(summaryData.week_metadata) || summaryData.week_metadata.length !== indexData.weeks.length)
    throw new Error("Smoke test: season summary metadata mismatch");
  const summaryWeek3 = summaryData.week_metadata.find((w) => w.week === 3);
  if (!summaryWeek3?.completed) throw new Error("Smoke test: summary missing completed week metadata");
  if (!Array.isArray(summaryData.weekly_game_counts) || summaryData.weekly_game_counts[0]?.games < 2)
    throw new Error("Smoke test: season summary game counts incorrect");

  console.log("Smoke test passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function maybeExerciseTankSources(season) {
  if (process.env.USE_TANK01_LOADERS?.toLowerCase() !== "true") return;
  const tasks = [
    loadSchedulesSource(season),
    loadTeamWeeklySource(season),
    loadPlayerWeeklySource(season),
    loadRostersWeeklySource(season),
    loadDepthChartsSource(season),
    loadInjuriesSource(season),
    loadBettingOddsSource(season),
    loadPlayerProjectionsSource(season)
  ];
  const names = [
    "schedules",
    "teamWeekly",
    "playerWeekly",
    "rosters",
    "depthCharts",
    "injuries",
    "odds",
    "projections"
  ];
  const results = await Promise.allSettled(tasks);
  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      const value = result.value;
      const count = Array.isArray(value) ? value.length : value?.length ?? 0;
      console.log(`[smoke] tank01 ${names[idx]} ok (${count})`);
    } else {
      console.warn(`[smoke] tank01 ${names[idx]} failed: ${result.reason?.message || result.reason}`);
    }
  });
}
