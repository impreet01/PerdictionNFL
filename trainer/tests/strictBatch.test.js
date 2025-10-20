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

(function runStrictBatchSuite() {
  fs.rmSync(artifactsDir, { recursive: true, force: true });

  runCommand("npm", ["run", "bootstrap:state"], {
    env: {
      BATCH_START: "2001",
      BATCH_END: "2002",
      NODE_OPTIONS: `--import=${fixturePath}`
    }
  });

  const initialState = readTrainingState();
  const initialSeasons = (initialState?.bootstraps?.model_training?.seasons ?? []).map((entry) => Number(entry.season));
  assert.deepEqual(initialSeasons, [2001, 2002], "bootstrap should record explicit seasons only");

  runCommand("npm", ["run", "train:multi", "--", "--start", "2001", "--end", "2002"], {
    env: {
      BATCH_START: "2001",
      BATCH_END: "2002",
      TRAINER_SMOKE_TEST: "1",
      CI_FAST: "1",
      MAX_WORKERS: "1",
      NODE_OPTIONS: `--import=${fixturePath}`
    }
  });

  const chunkDir = path.join(artifactsDir, "chunks");
  const chunkFiles = fs.existsSync(chunkDir)
    ? fs.readdirSync(chunkDir).filter((name) => name.startsWith("model_") && name.endsWith(".done"))
    : [];
  assert.deepEqual(chunkFiles, ["model_2001-2002.done"], "Trainer should only emit the requested chunk marker");

  const finalState = readTrainingState();
  const finalSeasons = (finalState?.bootstraps?.model_training?.seasons ?? []).map((entry) => Number(entry.season));
  assert.deepEqual(finalSeasons, [2001, 2002], "training_state should remain scoped to the explicit window");

  console.log("strict batch window tests passed");
})();
