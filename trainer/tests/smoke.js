import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSchedules } from "../dataSources.js";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "nfl-sched-cache-"));
  const cacheFile = join(tmp, "games.csv");
  const csv = [
    "season,week,home_team,away_team,home_score,away_score,season_type",
    "2023,1,KC,DET,20,21,REG"
  ].join("\n");
  writeFileSync(cacheFile, csv, "utf8");

  const rows = await loadSchedules({
    localPath: join(tmp, "missing.csv"),
    cachePath: cacheFile,
  });

  assert.equal(rows.length, 1, "should read cached schedule row");
  assert.equal(rows[0].home_team, "KC");
  assert.equal(rows[0].away_team, "DET");
  console.log("smoke: loadSchedules cache fallback ok");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
