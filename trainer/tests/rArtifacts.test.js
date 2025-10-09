// trainer/tests/rArtifacts.test.js
// Validate that R-derived parquet artifacts can be consumed locally.

import assert from "node:assert/strict";
import path from "node:path";

import { loadPBP, loadFourthDown, loadPlayerWeekly, caches } from "../dataSources.js";
import { aggregatePBP } from "../featureBuild_pbp.js";
import { aggregateFourthDown } from "../featureBuild_fourthDown.js";
import { seedRArtifactsForTests } from "./helpers/rArtifactFixtures.js";

async function main() {
  const rootDir = path.resolve("artifacts", "r-data");
  process.env.R_ARTIFACTS_ROOT = rootDir;
  delete process.env.SKIP_R_INGEST;

  await seedRArtifactsForTests(rootDir);

  const season = 2023;

  const pbpRows = await loadPBP(season);
  assert.equal(pbpRows.length, 3, "pbp rows should come from generated parquet artifact");

  const pbpAgg = aggregatePBP({ rows: pbpRows, season });
  const kanWeek1 = pbpAgg.get("2023-1-KAN");
  assert.ok(kanWeek1, "aggregatePBP should include Kansas City week 1");
  for (const key of [
    "off_xyac_epa_per_play",
    "off_xyac_weight",
    "off_wp_mean",
    "off_wp_weight",
    "off_cpoe_mean",
    "off_cpoe_weight"
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(kanWeek1, key), `pbp aggregate missing ${key}`);
  }

  const fourthRows = await loadFourthDown(season);
  assert.equal(fourthRows.length, 3, "fourth-down rows should come from generated parquet artifact");

  const fourthAgg = aggregateFourthDown({ rows: fourthRows, season });
  const detWeek1 = fourthAgg.get("2023-1-DET");
  assert.ok(detWeek1, "aggregateFourthDown should include Detroit week 1");
  for (const key of [
    "fourth_down_align_rate",
    "fourth_down_align_weight",
    "fourth_down_aligned_delta_wp",
    "fourth_down_mismatch_delta_wp"
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(detWeek1, key), `fourth-down aggregate missing ${key}`);
  }

  const playerRows = await loadPlayerWeekly(season);
  assert(playerRows.length >= 4000, "playerWeekly rows should satisfy sanity threshold");

  caches.pbp.clear();
  caches.fourthDown.clear();
  caches.playerWeekly.clear();

  console.log("rArtifacts test passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
