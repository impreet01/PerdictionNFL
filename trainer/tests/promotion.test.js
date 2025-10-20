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

(function runPromotionSuite() {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  const finalDir = path.join(artifactsDir, "models", "2024", "final");
  fs.mkdirSync(finalDir, { recursive: true });
  const ensemblePath = path.join(finalDir, "ensemble.json");
  const subDir = path.join(finalDir, "components");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(
    ensemblePath,
    JSON.stringify({ season: 2024, week: 18, model_revision: "legacy" }, null, 2)
  );
  fs.writeFileSync(
    path.join(subDir, "weights.json"),
    JSON.stringify({ name: "logistic", weights: [0.1, 0.2, 0.3] }, null, 2)
  );

  runCommand("npm", ["run", "bootstrap:state"], {
    env: {
      BATCH_START: "2024",
      BATCH_END: "2025",
      NODE_OPTIONS: `--import=${fixturePath}`
    }
  });

  runCommand("npm", ["run", "train:multi"], {
    env: {
      TRAINER_SMOKE_TEST: "1",
      CI_FAST: "1",
      MAX_WORKERS: "1",
      SEASON: "2025",
      WEEK: "1",
      NODE_OPTIONS: `--import=${fixturePath}`
    }
  });

  const promotedDir = path.join(artifactsDir, "models", "2025", "week-00");
  const promotedEnsemble = path.join(promotedDir, "ensemble.json");
  const promotedSub = path.join(promotedDir, "components", "weights.json");
  assert(fs.existsSync(promotedEnsemble), "Promoted ensemble.json missing");
  assert(fs.existsSync(promotedSub), "Promoted submodel weights missing");

  const state = readTrainingState();
  const modelRecord = state?.bootstraps?.model_training ?? {};
  assert.equal(modelRecord.seededFrom, 2024, "training_state should record seed season");
  assert.equal(
    modelRecord.seedRevision,
    state?.bootstraps?.model_training?.revision,
    "seedRevision should reflect prior bootstrap revision"
  );
  const seedFiles = Array.isArray(modelRecord.seedFiles) ? modelRecord.seedFiles : [];
  assert(seedFiles.includes("2025/week-00/ensemble.json"), "seedFiles should include promoted ensemble");
  assert(seedFiles.includes("2025/week-00/components/weights.json"), "seedFiles should include promoted components");

  // Negative scenario: promotion should fail clearly when prior finals are absent.
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  runCommand("npm", ["run", "bootstrap:state"], {
    env: {
      BATCH_START: "2024",
      BATCH_END: "2025",
      NODE_OPTIONS: `--import=${fixturePath}`
    }
  });
  const failure = spawnSync("npm", ["run", "train:multi"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TRAINER_SMOKE_TEST: "1",
      CI_FAST: "1",
      MAX_WORKERS: "1",
      SEASON: "2025",
      WEEK: "1",
      NODE_OPTIONS: `--import=${fixturePath}`
    },
    encoding: "utf8"
  });
  assert.notEqual(failure.status, 0, "Week-1 training should fail when promotion assets are missing");
  const combinedOutput = `${failure.stdout}\n${failure.stderr}`;
  assert(
    combinedOutput.includes("Unable to promote final ensemble"),
    `Expected promotion failure message, received:\n${combinedOutput}`
  );

  console.log("promotion rollover tests passed");
})();
