// trainer/tests/smoke.js
// Synthetic smoke test to ensure pipeline produces artifacts with required keys.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artp } from "../utils/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const artifactsDir = path.join(repoRoot, ".test_artifacts", `smoke-${process.pid}-${Date.now()}`);
process.env.ARTIFACTS_DIR = artifactsDir;

const { runTraining, writeArtifacts, updateHistoricalArtifacts } = await import("../train_multi.js");

// Use realistic team abbreviations so downstream normalization logic that
// expects 2-4 character codes (see normalizeTeamCode in train_multi.js)
// succeeds. Single-character placeholders caused the historical artifact
// builder to bail early, which meant summary/index files were never
// generated.
const teams = ["NE", "BUF", "KC", "PHI"];

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
  try {
    const season = 2023;
    rmSync(artifactsDir, { recursive: true, force: true });
    mkdirSync(artifactsDir, { recursive: true });
    const schedules = [
      makeGame(season, 1, "NE", "BUF", 24, 20),
      makeGame(season, 1, "KC", "PHI", 17, 21),
      makeGame(season, 2, "NE", "KC", 30, 27),
      makeGame(season, 2, "BUF", "PHI", 10, 14),
      makeGame(season, 3, "NE", "PHI", 28, 31),
      makeGame(season, 3, "BUF", "KC", 24, 17)
    ];
    const teamWeekly = [];
    const teamGame = [];
    for (const game of schedules) {
      const base = 350 + game.week * 10;
      teamWeekly.push(
        makeTeamRow(season, game.week, game.home_team, game.away_team, base, base - 120, 60, 1, "30:00")
      );
      teamWeekly.push(
        makeTeamRow(season, game.week, game.away_team, game.home_team, base - 30, base - 150, 45, 2, "29:30")
      );
      const thirdAttHome = 12 + game.week;
      const thirdAttAway = 11 + game.week;
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

    const options = {
      btBootstrapSamples: 20,
      annSeeds: 3,
      annMaxEpochs: 50,
      annCvMaxEpochs: 20,
      annCvSeeds: 2,
      weightStep: 0.1,
      skipSeasonDB: true
    };

    const week1 = await runTraining({
      season,
      week: 1,
      data: { schedules, teamWeekly, teamGame, prevTeamWeekly: [] },
      options
    });

    if (!Array.isArray(week1.predictions) || !week1.predictions.length) {
      throw new Error("Smoke test: week 1 predictions missing");
    }
    const hasNonFinite = week1.predictions.some((p) => {
      if (!Number.isFinite(p?.forecast)) return true;
      if (!p?.probs || typeof p.probs !== "object") return true;
      return Object.values(p.probs).some((v) => !Number.isFinite(v));
    });
    if (hasNonFinite) throw new Error("Smoke test: week 1 predictions must be finite");

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
    if (!Array.isArray(result.btDebug) || !result.btDebug.length)
      throw new Error("Smoke test: btDebug missing");

    result.context = [];
    await writeArtifacts(result);
    await updateHistoricalArtifacts({ season, schedules });

    const indexPath = artp(`season_index_${season}.json`);
    if (!existsSync(indexPath)) throw new Error("Smoke test: season index missing");
    const indexData = JSON.parse(readFileSync(indexPath, "utf8"));
    if (indexData.latest_completed_week !== 3) throw new Error("Smoke test: season index latest week incorrect");
    if (!Array.isArray(indexData.weeks) || indexData.weeks.length !== 3)
      throw new Error("Smoke test: season index weeks incorrect");
    const week3Meta = indexData.weeks.find((w) => w.week === 3);
    if (!week3Meta?.completed) throw new Error("Smoke test: week 3 metadata missing completion");
    if (!week3Meta.metrics?.exists || !week3Meta.outcomes?.exists)
      throw new Error("Smoke test: week 3 metadata missing artifacts");

    const summaryPath = artp(`season_summary_${season}.json`);
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
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
