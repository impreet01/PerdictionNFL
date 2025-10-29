import assert from "assert/strict";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ARTIFACTS_DIR = path.join(PROJECT_ROOT, ".test_artifacts", "cumulative-run");

async function runCumulativeRolling() {
  await fsp.rm(ARTIFACTS_DIR, { recursive: true, force: true });

  const env = {
    ...process.env,
    NODE_ENV: "test",
    CI_FAST: "1",
    SEASON: "2025",
    BATCH_START: "1",
    BATCH_END: "1",
    ARTIFACTS_DIR,
    TZ: "UTC"
  };

  const { stdout, stderr } = await execFileAsync("node", ["trainer/train_multi.js"], {
    cwd: PROJECT_ROOT,
    env,
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024
  });

  process.stdout.write(stdout);
  process.stderr.write(stderr);
}

async function assertPredictions() {
  const predictionsPath = path.join(
    ARTIFACTS_DIR,
    "predictions",
    "predictions_2025_W01.csv"
  );

  try {
    await fsp.access(predictionsPath);
  } catch (err) {
    assert.fail(`Expected predictions CSV at ${predictionsPath} to be created.`);
  }

  const csv = await fsp.readFile(predictionsPath, "utf8");
  const rows = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  assert(rows.length >= 2, "Predictions CSV should contain a header and at least one row of data.");
  console.log(`[cumulativeRolling.test] predictions rows=${rows.length}`);
}

await runCumulativeRolling();
await assertPredictions();
