import assert from "assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const fixturePath = path.join(repoRoot, "trainer", "tests", "mocks", "stateFixture.js");

function runNode(args, { env: envOverrides = {}, cwd = repoRoot } = {}) {
  const env = { ...process.env, ...envOverrides };
  const res = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"]
  });
  if (res.status !== 0) {
    throw new Error(["node", ...args].join(" ") + ` failed: ${res.status}`);
  }
  return res;
}

(function runStatusMarkerRegression() {
  const tmp = path.join(repoRoot, ".test_artifacts", `status-skip-${process.pid}-${Date.now()}`);
  const envBase = {
    ARTIFACTS_DIR: tmp,
    // Pick a very old slice that will usually have zero evaluable weeks in our trimmed test fixtures.
    BATCH_START: "1999",
    BATCH_END: "2000",
    // Do not force any historical rewrite flags; we are testing explicit window behavior.
    CI_FAST: "1",
    TRAINER_SMOKE_TEST: "1",
    MAX_WORKERS: "1",
    NODE_OPTIONS: `--import=${fixturePath}`
  };

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  try {
    const entry = path.join(repoRoot, "trainer", "train_multi.js");
    console.log("status marker skip: invoking trainer");
    runNode([entry], { env: envBase });
    console.log("status marker skip: trainer exited");

    const s1999 = path.join(tmp, ".status", "1999.done");
    const s2000 = path.join(tmp, ".status", "2000.done");

    assert(fs.existsSync(s1999), "Expected .status/1999.done to be created on skip");
    assert(fs.existsSync(s2000), "Expected .status/2000.done to be created on skip");

    console.log("status marker skip regression passed");
  } finally {
    // Keep artifacts for debugging if desired; comment out to remove automatically.
    // fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
