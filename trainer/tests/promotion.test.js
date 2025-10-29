import assert from "assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const fixturePath = path.join(repoRoot, "trainer", "tests", "mocks", "stateFixture.js");
const artifactsDir = path.join(repoRoot, ".test_artifacts", `promotion-${process.pid}-${Date.now()}`);
const sampleArtifactsDir = path.join(repoRoot, "artifacts");

const originalEnv = {
  ARTIFACTS_DIR: process.env.ARTIFACTS_DIR
};

const baseEnv = { ARTIFACTS_DIR: artifactsDir };

const EXCLUDED_SEED_FILES = new Set(["historical_bootstrap.tgz"]);
const EXCLUDED_SEED_EXTENSIONS = new Set([".tgz"]);

function shouldExcludeSeedFile(source) {
  const baseName = path.basename(source);
  if (EXCLUDED_SEED_FILES.has(baseName)) {
    return true;
  }
  const extension = path.extname(baseName);
  return EXCLUDED_SEED_EXTENSIONS.has(extension);
}

function seedArtifacts() {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.cpSync(sampleArtifactsDir, artifactsDir, {
    recursive: true,
    filter: (source) => !shouldExcludeSeedFile(source)
  });
}

seedArtifacts();
process.env.ARTIFACTS_DIR = artifactsDir;

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
  const statePath = path.join(artifactsDir, "training_state.json");
  const raw = fs.readFileSync(statePath, "utf8");
  return JSON.parse(raw);
}

function cleanup() {
  fs.rmSync(artifactsDir, { recursive: true, force: true });
  if (originalEnv.ARTIFACTS_DIR === undefined) {
    delete process.env.ARTIFACTS_DIR;
  } else {
    process.env.ARTIFACTS_DIR = originalEnv.ARTIFACTS_DIR;
  }
}

(function runPromotionSuite() {
  try {
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

    const warmStartModelPath = path.join(artifactsDir, "model_2024_W18.json");
    fs.writeFileSync(
      warmStartModelPath,
      JSON.stringify(
        {
          season: 2024,
          week: 18,
          logistic: {
            weights: [0.05, -0.12, 0.08],
            bias: 0.01,
            features: ["home", "elo_diff", "rest_diff"]
          }
        },
        null,
        2
      )
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

    const predictionsPath = path.join(artifactsDir, "predictions_2025_W01.json");
    if (fs.existsSync(predictionsPath)) {
      const predictions = JSON.parse(fs.readFileSync(predictionsPath, "utf8"));
      const predictionRows = Array.isArray(predictions)
        ? predictions
        : Array.isArray(predictions.games)
          ? predictions.games
          : [];
      const forecastValues = predictionRows.map((row) => Number(row.forecast ?? row.probs?.blended ?? 0.5));
      if (forecastValues.length) {
        const uniqueForecasts = new Set(forecastValues.map((v) => v.toFixed(3)));
        assert(
          uniqueForecasts.size > 1 || (uniqueForecasts.size === 1 && [...uniqueForecasts][0] !== "0.500"),
          "Week-1 forecasts should not all collapse to 0.500"
        );
      }
    }

    const diagnosticsPath = path.join(artifactsDir, "diagnostics_2025_W01.json");
    const trainingMeta = fs.existsSync(diagnosticsPath)
      ? JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"))?.training_metadata ?? {}
      : {};
    if (trainingMeta && Object.keys(trainingMeta).length > 0) {
      assert(trainingMeta?.historical?.rowCount > 0, "Week-1 training should include historical rows");
      assert(trainingMeta?.featureStats?.historical_rows > 0, "Historical row count should be reflected in feature stats");
    }

    const modelPath = path.join(artifactsDir, "model_2025_W01.json");
    assert(fs.existsSync(modelPath), "Week-1 model artifact missing");
    const modelPayload = JSON.parse(fs.readFileSync(modelPath, "utf8"));
    assert.equal(
      modelPayload?.warmStartedFrom,
      "model_2024_W18",
      "Week-1 model should record warm-start source"
    );

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

    const historicalSeasons = Array.isArray(trainingMeta?.historical?.seasons)
      ? trainingMeta.historical.seasons.map((s) => Number(s)).sort((a, b) => a - b)
      : [];
    if (historicalSeasons.length) {
      assert(historicalSeasons.includes(2024), "Historical seasons should include the prior year for warm start");
    }

    seedArtifacts();
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
        ...baseEnv,
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
  } finally {
    cleanup();
  }
})();
