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

function runNode(args, env = {}) {
  const res = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (res.status !== 0) {
    throw new Error(`node ${args.join(" ")} failed: ${res.status}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  return res;
}

const tmp = path.join(repoRoot, ".test_artifacts", `status-skip-${Date.now()}`);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const originalArtifactsDir = process.env.ARTIFACTS_DIR;
const originalRotowireDir = process.env.ROTOWIRE_ARTIFACTS_DIR;
process.env.ARTIFACTS_DIR = tmp;
process.env.ROTOWIRE_ARTIFACTS_DIR = tmp;
const trainingStateSrc = path.join(repoRoot, "artifacts", "training_state.json");
if (fs.existsSync(trainingStateSrc)) {
  fs.copyFileSync(trainingStateSrc, path.join(tmp, "training_state.json"));
}

try {
  runNode([path.join(repoRoot, "trainer", "train_multi.js")], {
    ARTIFACTS_DIR: tmp,
    ROTOWIRE_ARTIFACTS_DIR: tmp,
    CI_FAST: "1",
    BATCH_START: "1999",
    BATCH_END: "2000",
    TRAINER_SMOKE_TEST: "1",
    MAX_WORKERS: "1",
    NODE_OPTIONS: `--import=${fixturePath} --import=${offlineFixturePath}`
  });
  const s1999 = path.join(tmp, ".status", "1999.done");
  const s2000 = path.join(tmp, ".status", "2000.done");
  assert(fs.existsSync(s1999), "expected .status/1999.done to exist");
  assert(fs.existsSync(s2000), "expected .status/2000.done to exist");
  console.log("statusMarkersOnSkip: PASS");
} catch (err) {
  console.error("statusMarkersOnSkip: FAIL");
  console.error(err);
  process.exitCode = 1;
} finally {
  if (originalArtifactsDir === undefined) {
    delete process.env.ARTIFACTS_DIR;
  } else {
    process.env.ARTIFACTS_DIR = originalArtifactsDir;
  }
  if (originalRotowireDir === undefined) {
    delete process.env.ROTOWIRE_ARTIFACTS_DIR;
  } else {
    process.env.ROTOWIRE_ARTIFACTS_DIR = originalRotowireDir;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
