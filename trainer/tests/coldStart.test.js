import assert from "assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const fixturePath = path.join(repoRoot, "trainer", "tests", "mocks", "stateFixture.js");
const offlineFixturePath = path.join(repoRoot, "trainer", "tests", "mocks", "offlineFetch.js");
const tmp = path.join(repoRoot, ".test_artifacts", `coldStart-${process.pid}-${Date.now()}`);

const originalEnv = {
  ARTIFACTS_DIR: process.env.ARTIFACTS_DIR,
  BATCH_START: process.env.BATCH_START,
  BATCH_END: process.env.BATCH_END,
  BOOTSTRAP_RESET: process.env.BOOTSTRAP_RESET
};

const baseEnv = {
  ARTIFACTS_DIR: tmp,
  BATCH_START: "1999",
  BATCH_END: "2000",
  BOOTSTRAP_RESET: "1"
};

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
process.env.ARTIFACTS_DIR = tmp;
process.env.BATCH_START = baseEnv.BATCH_START;
process.env.BATCH_END = baseEnv.BATCH_END;
process.env.BOOTSTRAP_RESET = baseEnv.BOOTSTRAP_RESET;

function runCommand(command, args = [], { env: envOverrides = {}, cwd = repoRoot } = {}) {
  const env = { ...process.env, ...baseEnv, ...envOverrides };
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
  const statePath = path.join(tmp, "training_state.json");
  const raw = fs.readFileSync(statePath, "utf8");
  return JSON.parse(raw);
}

function cleanup() {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

(function runColdStartSuite() {
  try {
    runCommand("npm", ["run", "bootstrap:state", "--", "--start", "1999", "--end", "2000", "--reset"], {
      env: { NODE_OPTIONS: `--import=${fixturePath} --import=${offlineFixturePath}` }
    });

    const stateAfterBootstrap = readTrainingState();
    const modelSeasons = stateAfterBootstrap?.bootstraps?.model_training?.seasons ?? [];
    const coveredSeasons = modelSeasons.map((entry) => Number(entry.season)).sort((a, b) => a - b);
    assert.deepEqual(coveredSeasons, [1999, 2000], "bootstrap:state should include seasons 1999-2000");

    const trainEnvOverrides = {
      TRAINER_SMOKE_TEST: "1",
      CI_FAST: "1",
      MAX_WORKERS: "1",
      NODE_OPTIONS: `--import=${fixturePath} --import=${offlineFixturePath}`
    };
    const effectiveTrainEnv = { ...process.env, ...baseEnv, ...trainEnvOverrides };
    console.log(
      `[coldStart:test] ARTIFACTS_DIR=${effectiveTrainEnv.ARTIFACTS_DIR} BATCH_START=${effectiveTrainEnv.BATCH_START} BATCH_END=${effectiveTrainEnv.BATCH_END}`
    );
    runCommand(
      "npm",
      [
        "run",
        "train:multi",
        "--",
        "--start",
        "1999",
        "--end",
        "2000",
        "--artifactsDir",
        tmp
      ],
      {
        env: trainEnvOverrides
      }
    );

    const stateAfterTrain = readTrainingState();
    const finalSeasons = stateAfterTrain?.bootstraps?.model_training?.seasons ?? [];
    const finalCoverage = finalSeasons.map((entry) => Number(entry.season)).sort((a, b) => a - b);
    assert.deepEqual(finalCoverage, [1999, 2000], "train:multi should retain season coverage");

    const statusDir = path.join(tmp, ".status");
    const statusContents = fs.existsSync(statusDir)
      ? fs.readdirSync(statusDir).sort()
      : [];
    console.log(
      `[coldStart:test] STATUS_DIR=${statusDir} contents=${JSON.stringify(statusContents)}`
    );

    const status1999 = path.join(statusDir, "1999.done");
    const status2000 = path.join(statusDir, "2000.done");
    assert(fs.existsSync(status1999), "Season 1999 status marker missing");
    assert(fs.existsSync(status2000), "Season 2000 status marker missing");

    console.log("cold start bootstrap + training smoke tests passed");
  } finally {
    cleanup();
  }
})();
