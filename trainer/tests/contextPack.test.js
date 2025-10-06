import assert from "node:assert/strict";
import { buildContextForWeek } from "../contextPack.js";

function makeTeamRow({
  season,
  week,
  team,
  passYards,
  rushYards,
  passAllowed,
  rushAllowed,
  passAtt,
  sacks
}) {
  return {
    season,
    week,
    team,
    passing_yards: passYards,
    rushing_yards: rushYards,
    passing_yards_allowed: passAllowed,
    rushing_yards_allowed: rushAllowed,
    pass_attempts: passAtt,
    sacks
  };
}

function makeOffenseOnlyRow({ season, week, team, opponent, passYards, rushYards, passAtt, sacks }) {
  return {
    season,
    week,
    team,
    opponent_team: opponent,
    passing_yards: passYards,
    rushing_yards: rushYards,
    pass_attempts: passAtt,
    sacks
  };
}

(async () => {
  const season = 2025;
  const week = 4;
  const schedules = [
    {
      season,
      week,
      home_team: "ARI",
      away_team: "SEA",
      roof: "outdoor"
    }
  ];

  const teamWeekly = [
    makeTeamRow({
      season,
      week: 1,
      team: "ARI",
      passYards: 260,
      rushYards: 140,
      passAllowed: 210,
      rushAllowed: 140,
      passAtt: 30,
      sacks: 2
    }),
    makeTeamRow({
      season,
      week: 2,
      team: "ARI",
      passYards: 250,
      rushYards: 130,
      passAllowed: 220,
      rushAllowed: 140,
      passAtt: 29,
      sacks: 3
    }),
    makeTeamRow({
      season,
      week: 3,
      team: "ARI",
      passYards: 270,
      rushYards: 150,
      passAllowed: 200,
      rushAllowed: 130,
      passAtt: 31,
      sacks: 1
    }),
    makeTeamRow({
      season,
      week: 1,
      team: "SEA",
      passYards: 255,
      rushYards: 135,
      passAllowed: 215,
      rushAllowed: 145,
      passAtt: 28,
      sacks: 2
    }),
    makeTeamRow({
      season,
      week: 2,
      team: "SEA",
      passYards: 265,
      rushYards: 145,
      passAllowed: 225,
      rushAllowed: 145,
      passAtt: 30,
      sacks: 2
    }),
    makeTeamRow({
      season,
      week: 3,
      team: "SEA",
      passYards: 260,
      rushYards: 145,
      passAllowed: 220,
      rushAllowed: 145,
      passAtt: 29,
      sacks: 1
    })
  ];

  const context = await buildContextForWeek(season, week, {
    schedules,
    teamWeekly,
    playerWeekly: [],
    injuries: [],
    qbrRows: [],
    eloRows: [],
    marketRows: []
  });

  assert.strictEqual(context.length, 1, "Expected one matchup in test context");
  const matchup = context[0];
  const { home, away } = matchup.context.rolling_strength;

  assert(Number.isFinite(home.yds_for_3g), "Home rolling yards for should be finite");
  assert(Number.isFinite(home.net_yds_3g), "Home rolling net yards should be finite");
  assert(Number.isFinite(away.yds_for_3g), "Away rolling yards for should be finite");
  assert(Number.isFinite(away.net_yds_3g), "Away rolling net yards should be finite");

  const expectedHomeFor = ((260 + 140) + (250 + 130) + (270 + 150)) / 3;
  const expectedHomeAgainst = ((210 + 140) + (220 + 140) + (200 + 130)) / 3;
  const expectedAwayFor = ((255 + 135) + (265 + 145) + (260 + 145)) / 3;
  const expectedAwayAgainst = ((215 + 145) + (225 + 145) + (220 + 145)) / 3;

  assert(Math.abs(home.yds_for_3g - expectedHomeFor) < 1e-9, "Home rolling offense mismatch");
  assert(Math.abs(home.yds_against_3g - expectedHomeAgainst) < 1e-9, "Home rolling defense mismatch");
  assert(Math.abs(away.yds_for_3g - expectedAwayFor) < 1e-9, "Away rolling offense mismatch");
  assert(Math.abs(away.yds_against_3g - expectedAwayAgainst) < 1e-9, "Away rolling defense mismatch");

  console.log("contextPack rolling strength test passed");
})();

(async () => {
  const season = 2026;
  const week = 3;
  const schedules = [
    {
      season,
      week,
      home_team: "AAA",
      away_team: "BBB",
      roof: "outdoor"
    }
  ];

  const teamWeekly = [
    makeOffenseOnlyRow({
      season,
      week: 1,
      team: "AAA",
      opponent: "BBB",
      passYards: 250,
      rushYards: 100,
      passAtt: 30,
      sacks: 2
    }),
    makeOffenseOnlyRow({
      season,
      week: 2,
      team: "AAA",
      opponent: "BBB",
      passYards: 260,
      rushYards: 90,
      passAtt: 31,
      sacks: 1
    }),
    makeOffenseOnlyRow({
      season,
      week: 3,
      team: "AAA",
      opponent: "BBB",
      passYards: 270,
      rushYards: 95,
      passAtt: 32,
      sacks: 1
    }),
    makeOffenseOnlyRow({
      season,
      week: 1,
      team: "BBB",
      opponent: "AAA",
      passYards: 220,
      rushYards: 110,
      passAtt: 28,
      sacks: 3
    }),
    makeOffenseOnlyRow({
      season,
      week: 2,
      team: "BBB",
      opponent: "AAA",
      passYards: 225,
      rushYards: 120,
      passAtt: 29,
      sacks: 2
    }),
    makeOffenseOnlyRow({
      season,
      week: 3,
      team: "BBB",
      opponent: "AAA",
      passYards: 210,
      rushYards: 115,
      passAtt: 30,
      sacks: 2
    })
  ];

  const context = await buildContextForWeek(season, week, {
    schedules,
    teamWeekly,
    playerWeekly: [],
    injuries: [],
    qbrRows: [],
    eloRows: [],
    marketRows: []
  });

  assert.strictEqual(context.length, 1, "Expected one matchup in fallback test");
  const matchup = context[0];
  const { home, away } = matchup.context.rolling_strength;

  const expectedHomeFor = (350 + 350 + 365) / 3;
  const expectedHomeAgainst = (330 + 345 + 325) / 3;
  const expectedAwayFor = expectedHomeAgainst;
  const expectedAwayAgainst = expectedHomeFor;

  assert(Math.abs(home.yds_for_3g - expectedHomeFor) < 1e-9, "Home offense fallback mismatch");
  assert(Math.abs(home.yds_against_3g - expectedHomeAgainst) < 1e-9, "Home defense fallback mismatch");
  assert(Math.abs(away.yds_for_3g - expectedAwayFor) < 1e-9, "Away offense fallback mismatch");
  assert(Math.abs(away.yds_against_3g - expectedAwayAgainst) < 1e-9, "Away defense fallback mismatch");

  console.log("contextPack defense fallback test passed");
})();
