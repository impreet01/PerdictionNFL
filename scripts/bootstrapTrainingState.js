import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BOOTSTRAP_KEYS, CURRENT_BOOTSTRAP_REVISION } from "../trainer/trainingState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DIRECTORIES = ["state", "outputs", "models", ".cache"].map((dir) => path.join(ROOT_DIR, dir));
const STATE_FILE_PATH = path.join(ROOT_DIR, "state", "model_state.json");
const LEGACY_STATE_PATH = path.join(ROOT_DIR, "artifacts", "training_state.json");
const DEFAULT_ARTIFACTS_STATE = {
  schema_version: 1,
  bootstraps: {},
  latest_runs: {}
};
const DEFAULT_STATE = {
  version: 1,
  trainedSeasons: [],
  lastSeason: null,
  lastWeek: null,
  modelSummary: {}
};

function ensureDirectories() {
  for (const dir of DIRECTORIES) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureStateFile() {
  if (fs.existsSync(STATE_FILE_PATH)) {
    return;
  }
  const contents = `${JSON.stringify(DEFAULT_STATE, null, 2)}\n`;
  fs.writeFileSync(STATE_FILE_PATH, contents, "utf8");
}

function parseCliArgs(argv = []) {
  const envStart = Number.parseInt(process.env.BATCH_START ?? "", 10);
  const envEnd = Number.parseInt(process.env.BATCH_END ?? "", 10);
  const result = {
    reset: false,
    artifactsDir: process.env.ARTIFACTS_DIR ?? null,
    start: Number.isFinite(envStart) ? envStart : null,
    end: Number.isFinite(envEnd) ? envEnd : null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string") continue;
    if (token === "--reset") {
      result.reset = true;
      continue;
    }
    if (token === "--start") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(value)) result.start = value;
      i += 1;
      continue;
    }
    if (token === "--end") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(value)) result.end = value;
      i += 1;
      continue;
    }
    if (token === "--artifactsDir" || token === "--artifacts-dir") {
      const value = argv[i + 1];
      if (typeof value === "string" && value) {
        result.artifactsDir = value;
      }
      i += 1;
      continue;
    }
    if (token.startsWith("--start=")) {
      const [, raw] = token.split("=");
      const value = Number.parseInt(raw, 10);
      if (Number.isFinite(value)) result.start = value;
      continue;
    }
    if (token.startsWith("--end=")) {
      const [, raw] = token.split("=");
      const value = Number.parseInt(raw, 10);
      if (Number.isFinite(value)) result.end = value;
      continue;
    }
    if (token.startsWith("--artifactsDir=") || token.startsWith("--artifacts-dir=")) {
      const [, raw] = token.split("=");
      if (raw) result.artifactsDir = raw;
    }
  }
  if (!result.artifactsDir) {
    result.artifactsDir = path.join(ROOT_DIR, "artifacts");
  }
  result.artifactsDir = path.resolve(result.artifactsDir);
  return result;
}

function buildCoverage({ start, end }) {
  const seasons = new Set();
  if (Number.isFinite(start) && Number.isFinite(end)) {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    for (let season = lo; season <= hi; season += 1) seasons.add(season);
  } else if (Number.isFinite(start)) {
    seasons.add(start);
  } else if (Number.isFinite(end)) {
    seasons.add(end);
  }
  const fixture = globalThis.__STATE_BUILDER_FIXTURE__ ?? {};
  return Array.from(seasons)
    .sort((a, b) => a - b)
    .map((season) => {
      const weeks = Array.isArray(fixture[season])
        ? fixture[season].map((wk) => Number.parseInt(wk, 10)).filter((wk) => Number.isFinite(wk)).sort((a, b) => a - b)
        : [];
      return { season, weeks };
    });
}

function ensureLegacyTrainingState({ artifactsDir, reset, start, end }) {
  const target = path.join(artifactsDir, "training_state.json");
  if (reset) {
    fs.rmSync(target, { force: true });
  }
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const legacyDefault = fs.existsSync(LEGACY_STATE_PATH)
    ? JSON.parse(fs.readFileSync(LEGACY_STATE_PATH, "utf8"))
    : { ...DEFAULT_ARTIFACTS_STATE };
  const coverage = buildCoverage({ start, end });
  const modelKey = BOOTSTRAP_KEYS.MODEL;
  legacyDefault.bootstraps = legacyDefault.bootstraps && typeof legacyDefault.bootstraps === "object"
    ? { ...legacyDefault.bootstraps }
    : {};
  legacyDefault.bootstraps[modelKey] = {
    revision: CURRENT_BOOTSTRAP_REVISION,
    bootstrap_source: "bootstrap-script",
    seasons: coverage,
    chunks: coverage.length
      ? [
          {
            start_season: coverage[0].season,
            end_season: coverage[coverage.length - 1].season,
            seasons: coverage
          }
        ]
      : []
  };
  const latest = coverage.length
    ? {
        season: coverage[coverage.length - 1].season,
        week: coverage[coverage.length - 1].weeks.slice(-1)[0] ?? null
      }
    : null;
  legacyDefault.latest_runs = legacyDefault.latest_runs && typeof legacyDefault.latest_runs === "object"
    ? { ...legacyDefault.latest_runs }
    : {};
  if (latest) {
    legacyDefault.latest_runs[modelKey] = latest;
  }
  const payload = `${JSON.stringify(legacyDefault, null, 2)}\n`;
  fs.writeFileSync(target, payload, "utf8");
}

function main() {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    ensureDirectories();
    ensureStateFile();
    ensureLegacyTrainingState(cli);
  } catch (error) {
    console.error("Failed to bootstrap training state:", error);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
