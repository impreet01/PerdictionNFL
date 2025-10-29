import assert from "assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const artifactsDir = path.join(repoRoot, ".test_artifacts", `cumulative-${process.pid}-${Date.now()}`);

function cleanup() {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
}

function makeGame({ season, week, home, away, homeScore, awayScore }) {
  return {
    season,
    week,
    game_id: `${season}-W${String(week).padStart(2, "0")}-${home}-${away}`,
    home_team: home,
    away_team: away,
    home_score: homeScore,
    away_score: awayScore,
    season_type: "REG"
  };
}

function makeTeamRow({ season, week, team, opponent, yards, passYards, penalties, turnovers }) {
  return {
    season,
    week,
    team,
    opponent,
    passing_yards: passYards,
    rushing_yards: yards - passYards,
    penalty_yards: penalties,
    turnovers,
    time_of_possession: "30:00",
    def_interceptions: Math.max(0, 2 - turnovers),
    def_fumbles: 1
  };
}

function makeTeamGameRow({ season, week, team, thirdAtt, thirdConv, redAtt, redTd, passAtt, rushAtt, sacksTaken }) {
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

function buildSeason(season, matchups) {
  const schedules = [];
  const teamWeekly = [];
  const teamGame = [];
  for (const matchup of matchups) {
    schedules.push(
      makeGame({ season, week: matchup.week, home: matchup.home, away: matchup.away, homeScore: matchup.homeScore, awayScore: matchup.awayScore })
    );
    const base = 320 + matchup.week * 5;
    teamWeekly.push(
      makeTeamRow({ season, week: matchup.week, team: matchup.home, opponent: matchup.away, yards: base, passYards: base - 110, penalties: 40, turnovers: 1 })
    );
    teamWeekly.push(
      makeTeamRow({ season, week: matchup.week, team: matchup.away, opponent: matchup.home, yards: base - 25, passYards: base - 145, penalties: 55, turnovers: 2 })
    );
    const thirdAttHome = 10 + matchup.week;
    const thirdAttAway = 9 + matchup.week;
    teamGame.push(
      makeTeamGameRow({
        season,
        week: matchup.week,
        team: matchup.home,
        thirdAtt: thirdAttHome,
        thirdConv: Math.floor(thirdAttHome * 0.5),
        redAtt: 4 + matchup.week,
        redTd: 3 + matchup.week,
        passAtt: 30 + matchup.week,
        rushAtt: 25 + matchup.week,
        sacksTaken: 2
      })
    );
    teamGame.push(
      makeTeamGameRow({
        season,
        week: matchup.week,
        team: matchup.away,
        thirdAtt: thirdAttAway,
        thirdConv: Math.floor(thirdAttAway * 0.45),
        redAtt: 3 + matchup.week,
        redTd: 2 + matchup.week,
        passAtt: 28 + matchup.week,
        rushAtt: 27 + matchup.week,
        sacksTaken: 3
      })
    );
  }
  return { schedules, teamWeekly, teamGame };
}

(async () => {
  try {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    fs.mkdirSync(artifactsDir, { recursive: true });
    process.env.ARTIFACTS_DIR = artifactsDir;

    const { runTraining, writeArtifacts, refreshArtifactPaths } = await import("../train_multi.js");
    const { buildFeatures } = await import("../featureBuild.js");
    const { buildBTFeatures } = await import("../featureBuild_bt.js");
    refreshArtifactPaths();

    const season2024 = buildSeason(2024, [
      { week: 17, home: "NE", away: "BUF", homeScore: 24, awayScore: 20 },
      { week: 18, home: "KC", away: "PHI", homeScore: 31, awayScore: 27 }
    ]);
    const season2025 = buildSeason(2025, [
      { week: 1, home: "NE", away: "PHI", homeScore: 27, awayScore: 23 }
    ]);

    const historicalFeatureRows = buildFeatures({
      teamWeekly: season2024.teamWeekly,
      teamGame: season2024.teamGame,
      schedules: season2024.schedules,
      season: 2024,
      prevTeamWeekly: [],
      pbp: [],
      playerWeekly: [],
      weather: [],
      injuries: []
    });
    const historicalBTRows = buildBTFeatures({
      teamWeekly: season2024.teamWeekly,
      teamGame: season2024.teamGame,
      schedules: season2024.schedules,
      season: 2024,
      prevTeamWeekly: [],
      injuries: []
    });

    const result2024 = await runTraining({
      season: 2024,
      week: 18,
      data: {
        schedules: season2024.schedules,
        teamWeekly: season2024.teamWeekly,
        teamGame: season2024.teamGame,
        prevTeamWeekly: [],
        pbp: [],
        playerWeekly: [],
        weather: [],
        injuries: []
      },
      options: { skipSeasonDB: true }
    });
    result2024.context = [];
    await writeArtifacts(result2024);

    const result2025 = await runTraining({
      season: 2025,
      week: 1,
      data: {
        schedules: season2025.schedules,
        teamWeekly: season2025.teamWeekly,
        teamGame: season2025.teamGame,
        prevTeamWeekly: season2024.teamWeekly,
        pbp: [],
        playerWeekly: [],
        weather: [],
        injuries: []
      },
      options: {
        skipSeasonDB: true,
        historical: {
          featureRows: historicalFeatureRows,
          btRows: historicalBTRows,
          seasons: [2024]
        }
      }
    });
    result2025.context = [];
    await writeArtifacts(result2025);

    const model2025Path = path.join(artifactsDir, "model_2025_W01.json");
    assert(fs.existsSync(model2025Path), "model_2025_W01.json should exist");
    const model2025 = JSON.parse(fs.readFileSync(model2025Path, "utf8"));
    const span = model2025?.train_span ?? {};
    const weeksBySeason = span?.weeks_by_season ?? {};
    const currentSeasonWeeks = weeksBySeason["2025"] ?? [];
    assert.equal(
      Array.isArray(currentSeasonWeeks) ? currentSeasonWeeks.length : 0,
      0,
      "Week-1 train_span should exclude current-season weeks"
    );
    assert(
      Array.isArray(span?.seasons) && span.seasons.includes(2024),
      "train_span.seasons should include prior season"
    );

    console.log("cumulative window metadata test passed");
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
