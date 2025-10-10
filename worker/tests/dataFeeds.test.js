import assert from "node:assert/strict";
import path from "node:path";

import {
  resolveSeason,
  loadPlayByPlaySeason,
  loadFourthDownSeason,
  loadPlayerWeeklySeason,
  loadSeedSimulationSummary,
  deriveAvailableWeeks,
  deriveAvailableTeams
} from "../handlers/dataFeeds.js";
import { seedRArtifactsForTests, seedSeedSimArtifacts } from "../../trainer/tests/helpers/rArtifactFixtures.js";

async function main() {
  const rootDir = path.resolve("artifacts", "r-data");
  process.env.R_ARTIFACTS_ROOT = rootDir;
  delete process.env.SKIP_R_INGEST;

  await seedRArtifactsForTests(rootDir);
  await seedSeedSimArtifacts(rootDir);

  const season = await resolveSeason("pbp");
  assert.equal(season, 2025, "resolveSeason should pick newest season from manifest");

  const pbpSeason = await loadPlayByPlaySeason(season);
  assert.equal(pbpSeason.rows.length, 3, "play-by-play rows should load from parquet");
  const pbpWeeks = deriveAvailableWeeks(pbpSeason.rows);
  assert.deepEqual(pbpWeeks, [1], "play-by-play weeks should contain seeded week");
  const pbpTeams = deriveAvailableTeams(pbpSeason.rows, { offenseKey: "posteam", defenseKey: "defteam" });
  assert(pbpTeams.includes("KAN"), "available teams should include Kansas City");

  const fourthSeason = await loadFourthDownSeason(season);
  assert.equal(fourthSeason.rows.length, 3, "fourth-down rows should load from parquet");
  const fourthTeams = deriveAvailableTeams(fourthSeason.rows, { offenseKey: "posteam", defenseKey: null, teamKey: "posteam" });
  assert(fourthTeams.includes("DET"), "fourth-down teams should include Detroit");

  const playerSeason = await loadPlayerWeeklySeason(season);
  assert.equal(playerSeason.rows.length, 4000, "player-weekly rows should load from parquet");

  const seedSummary = await loadSeedSimulationSummary({ season, week: 1 });
  assert.equal(seedSummary.rows.length, 2, "seed simulation rows should match fixture");
  assert.equal(seedSummary.week, 1, "seed simulation should report requested week");

  console.log("dataFeeds test passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
