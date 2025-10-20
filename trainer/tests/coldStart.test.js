import assert from "assert/strict";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const artifactsDir = path.join(repoRoot, "artifacts");
const fixturePath = path.join(repoRoot, "trainer", "tests", "mocks", "stateFixture.js");

function runCommand(command, args = [], { env: envOverrides = {}, cwd = repoRoot } = {}) {
  const env = { ...process.env, ...envOverrides };
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    const message = [
      `${command} ${args.join(" ")} failed with code ${result.status}`,
      result.stdout,
      result.stderr
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(message);
  }
  return result;
}

function readTrainingState() {
  const statePath = path.join(artifactsDir, "training_state.json");
  const raw = fs.readFileSync(statePath, "utf8");
  return JSON.parse(raw);
}

(function runColdStartSuite() {
  fs.rmSync(artifactsDir, { recursive: true, force: true });

  runCommand("npm", ["run", "bootstrap:state", "--", "--start", "1999", "--end", "2000"], {
    env: {
      BATCH_START: "1999",
      BATCH_END: "2000",
      NODE_OPTIONS: `--import=${fixturePath}`
    }
  });

  const stateAfterBootstrap = readTrainingState();
  const modelSeasons = stateAfterBootstrap?.bootstraps?.model_training?.seasons ?? [];
  const coveredSeasons = modelSeasons.map((entry) => Number(entry.season)).sort((a, b) => a - b);
  assert.deepEqual(
    coveredSeasons,
    [1999, 2000],
    "bootstrap:state should include seasons 1999-2000"
  );

  runCommand("npm", ["run", "train:multi", "--", "--start", "1999", "--end", "2000"], {
    env: {
      BATCH_START: "1999",
      BATCH_END: "2000",
      TRAINER_SMOKE_TEST: "1",
      CI_FAST: "1",
      MAX_WORKERS: "1",
      NODE_OPTIONS: `--import=${fixturePath}`
    }
  });

  const stateAfterTrain = readTrainingState();
  const finalSeasons = stateAfterTrain?.bootstraps?.model_training?.seasons ?? [];
  const finalCoverage = finalSeasons.map((entry) => Number(entry.season)).sort((a, b) => a - b);
  assert.deepEqual(finalCoverage, [1999, 2000], "train:multi should retain season coverage");

  const status1999 = path.join(artifactsDir, ".status", "1999.done");
  const status2000 = path.join(artifactsDir, ".status", "2000.done");
  assert(fs.existsSync(status1999), "Season 1999 status marker missing");
  assert(fs.existsSync(status2000), "Season 2000 status marker missing");

  console.log("cold start bootstrap + training smoke tests passed");
})();
