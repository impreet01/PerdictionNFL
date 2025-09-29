// trainer/tests/smoke.js
// Synthetic smoke test to ensure pipeline produces artifacts with required keys.

import { runTraining } from "../train_multi.js";

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

function makeTeamRow(season, week, team, opponent, totalYards, passYards, penalties, turnovers, possession) {
  return {
    season,
    week,
    team,
    opponent,
    passing_yards: passYards,
    rushing_yards: totalYards - passYards,
    penalty_yards: penalties,
    turnovers,
    time_of_possession: possession,
    def_interceptions: Math.max(0, 2 - turnovers),
    def_fumbles: 1
  };
}

async function main() {
  const season = 2023;
  const schedules = [
    makeGame(season, 1, "A", "B", 24, 20),
    makeGame(season, 1, "C", "D", 17, 21),
    makeGame(season, 2, "A", "C", 30, 27),
    makeGame(season, 2, "B", "D", 10, 14),
    makeGame(season, 3, "A", "D", 28, 31),
    makeGame(season, 3, "B", "C", 24, 17)
  ];
  const teamWeekly = [];
  for (const game of schedules) {
    const base = 350 + (game.week * 10);
    teamWeekly.push(
      makeTeamRow(season, game.week, game.home_team, game.away_team, base, base - 120, 60, 1, "30:00")
    );
    teamWeekly.push(
      makeTeamRow(season, game.week, game.away_team, game.home_team, base - 30, base - 150, 45, 2, "29:30")
    );
  }

  const result = await runTraining({
    season,
    week: 3,
    data: { schedules, teamWeekly, prevTeamWeekly: [] },
    options: {
      btBootstrapSamples: 20,
      annSeeds: 3,
      annMaxEpochs: 50,
      annCvMaxEpochs: 20,
      annCvSeeds: 2,
      weightStep: 0.1
    }
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
  console.log("Smoke test passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
