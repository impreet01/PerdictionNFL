import fs from "node:fs";
import path from "node:path";
import {
  BOOTSTRAP_KEYS,
  CURRENT_BOOTSTRAP_REVISION,
  loadTrainingState,
  markBootstrapCompleted,
  recordLatestRun,
  saveTrainingState
} from "../trainer/trainingState.js";
import { getArtifactsDir, getTrainingStatePath } from "../trainer/bootstrapState.js";
import {
  buildSeasonCoverageFromRaw,
  discoverSeasonRange,
  mergeSeasonCoverage,
  MIN_SEASON
} from "../trainer/stateBuilder.js";

const ARTIFACTS_DIR = getArtifactsDir();
const STATE_PATH = getTrainingStatePath();

function parseCliArgs(argv = []) {
  const args = { start: undefined, end: undefined, reset: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--start" && i + 1 < argv.length) {
      args.start = argv[i + 1];
      i += 1;
    } else if (token === "--end" && i + 1 < argv.length) {
      args.end = argv[i + 1];
      i += 1;
    } else if (token === "--reset") {
      args.reset = true;
    } else if (token.startsWith("--reset=")) {
      const [, value] = token.split("=", 2);
      if (value != null) {
        args.reset = /^(1|true|yes|on)$/i.test(value);
      }
    }
  }
  return args;
}

const CLI_ARGS = parseCliArgs(process.argv.slice(2));
const START = Number(process.env.BATCH_START ?? CLI_ARGS.start);
const END = Number(process.env.BATCH_END ?? CLI_ARGS.end);
const RESET = process.env.BOOTSTRAP_RESET === "1" || CLI_ARGS.reset === true;

function parseExplicitChunkRange() {
  if (Number.isFinite(START) && Number.isFinite(END)) {
    const lower = Math.min(START, END);
    const upper = Math.max(START, END);
    return { start: lower, end: upper };
  }
  return null;
}

function filterSeasonsByRange(seasons, range) {
  if (!Array.isArray(seasons) || !range) return seasons;
  return seasons.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = Number(entry.season);
    if (!Number.isFinite(value)) return false;
    return value >= range.start && value <= range.end;
  });
}

function ensureArtifactsDir() {
  if (fs.existsSync(ARTIFACTS_DIR)) {
    return true;
  }
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  return false;
}

function buildSeasonWeekMap(entries, pattern) {
  const map = new Map();
  for (const entry of entries) {
    const match = entry.match(pattern);
    if (!match) continue;
    const season = Number.parseInt(match[1], 10);
    const week = Number.parseInt(match[2], 10);
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue;
    if (!map.has(season)) {
      map.set(season, new Set());
    }
    map.get(season).add(week);
  }
  return map;
}

function serialiseSeasonMap(map) {
  return Array.from(map.entries())
    .map(([season, weeks]) => ({ season, weeks: Array.from(weeks).sort((a, b) => a - b) }))
    .sort((a, b) => a.season - b.season);
}

function selectLatestRun(serialised) {
  if (!serialised.length) return null;
  return serialised.reduce((latest, entry) => {
    if (!entry.weeks.length) return latest;
    const candidate = { season: entry.season, week: entry.weeks[entry.weeks.length - 1] };
    if (!latest) return candidate;
    if (candidate.season > latest.season) return candidate;
    if (candidate.season === latest.season && candidate.week > latest.week) return candidate;
    return latest;
  }, null);
}

function discoverHybridSeasons(entries, predictionsSet) {
  const pattern = /^model_(\d{4})_W(\d{2})\.json$/;
  const map = new Map();
  for (const entry of entries) {
    const match = entry.match(pattern);
    if (!match) continue;
    const season = Number.parseInt(match[1], 10);
    const week = Number.parseInt(match[2], 10);
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue;
    const predictionName = `predictions_${match[1]}_W${match[2]}.json`;
    if (!predictionsSet.has(predictionName)) continue;
    if (!map.has(season)) {
      map.set(season, new Set());
    }
    map.get(season).add(week);
  }
  return map;
}

function resolveHybridLogPath() {
  const candidates = [
    ["hybrid_v2", "performance_log.csv"],
    ["hybrid", "performance_log.csv"],
    ["reports", "hybrid_v2", "performance_log.csv"],
    ["reports", "hybrid", "performance_log.csv"]
  ];

  for (const segments of candidates) {
    const candidate = path.join(ARTIFACTS_DIR, ...segments);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function discoverHybridLatestFromLog() {
  const logPath = resolveHybridLogPath();
  if (!logPath) return null;
  const rows = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/);
  if (rows.length <= 1) return null;
  let latest = null;
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const [seasonRaw, weekRaw] = row.split(/,/, 3);
    const season = Number.parseInt(seasonRaw, 10);
    const week = Number.parseInt(weekRaw, 10);
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue;
    if (!latest) {
      latest = { season, week };
      continue;
    }
    if (season > latest.season || (season === latest.season && week > latest.week)) {
      latest = { season, week };
    }
  }
  return latest;
}

function hasCurrentRevision(state, key) {
  if (!state?.bootstraps || typeof state.bootstraps !== "object") return false;
  const record = state.bootstraps[key];
  if (!record) return key !== BOOTSTRAP_KEYS.MODEL;
  return record.revision === CURRENT_BOOTSTRAP_REVISION;
}

async function resolveRawCoverage({ chunkRange = null } = {}) {
  if (chunkRange) {
    const coverage = await buildSeasonCoverageFromRaw({
      startSeason: chunkRange.start,
      endSeason: chunkRange.end
    });
    return { coverage, range: chunkRange, mode: "chunk" };
  }

  const range = await discoverSeasonRange();
  const coverage = await buildSeasonCoverageFromRaw({ startSeason: range.start, endSeason: range.end });
  return { coverage, range, mode: "full" };
}

async function main() {
  ensureArtifactsDir();
  const statePreviouslyExisted = fs.existsSync(STATE_PATH);
  if (RESET && statePreviouslyExisted) {
    fs.rmSync(STATE_PATH, { force: true });
  }
  const stateExisted = !RESET && statePreviouslyExisted;

  let state = loadTrainingState();

  const entries = fs.existsSync(ARTIFACTS_DIR) ? fs.readdirSync(ARTIFACTS_DIR) : [];
  const predictionPattern = /^predictions_(\d{4})_W(\d{2})\.json$/;
  const predictionsSet = new Set(entries.filter((entry) => predictionPattern.test(entry)));

  const modelMap = buildSeasonWeekMap(entries, predictionPattern);
  const artifactSeasons = serialiseSeasonMap(modelMap);

  const chunkRange = parseExplicitChunkRange();
  const { coverage: rawCoverage, range: targetRange, mode } = await resolveRawCoverage({ chunkRange });

  if (mode === "chunk") {
    console.log(`[bootstrap] Building training_state (chunk) ${targetRange.start}–${targetRange.end}`);
  } else {
    const currentSeason = new Date().getFullYear();
    console.log(`[bootstrap] Building training_state (full) ${MIN_SEASON}–${currentSeason}`);
  }

  let modelSeasons = mergeSeasonCoverage(rawCoverage, artifactSeasons);
  if (mode === "chunk") {
    modelSeasons = filterSeasonsByRange(modelSeasons, targetRange);
  }
  const bootstrapSource = artifactSeasons.length ? "artifact-scan" : "cold-start";

  if (!artifactSeasons.length && !rawCoverage.length) {
    const rangeLabel = mode === "chunk" ? `${targetRange.start}–${targetRange.end}` : "available season range";
    throw new Error(
      `[bootstrap] Unable to derive raw coverage for ${rangeLabel}. Ensure schedules/outcomes datasets are available before bootstrapping training state.`
    );
  }

  if (!artifactSeasons.length) {
    console.log("[bootstrap] Building training_state from raw sources (cold start).");
  }

  if (stateExisted) {
    const modelUpToDate = hasCurrentRevision(state, BOOTSTRAP_KEYS.MODEL);
    const hybridUpToDate = hasCurrentRevision(state, BOOTSTRAP_KEYS.HYBRID);
    if (modelUpToDate && hybridUpToDate && artifactSeasons.length) {
      console.log(
        `[bootstrap] training_state.json already present at ${STATE_PATH} (revision ${CURRENT_BOOTSTRAP_REVISION}); skipping.`
      );
      return;
    }
    if (!artifactSeasons.length) {
      console.log("[bootstrap] training_state.json will be rebuilt from raw coverage.");
    } else {
      console.log("[bootstrap] Existing training_state.json has outdated bootstrap metadata; refreshing.");
    }
  }

  const hybridMap = discoverHybridSeasons(entries, predictionsSet);

  markBootstrapCompleted(state, BOOTSTRAP_KEYS.MODEL, {
    seasons: modelSeasons,
    bootstrap_source: bootstrapSource
  });

  const latestModel = selectLatestRun(modelSeasons);
  if (latestModel) {
    recordLatestRun(state, BOOTSTRAP_KEYS.MODEL, latestModel);
  }

  let hybridSeasons = serialiseSeasonMap(hybridMap);
  if (mode === "chunk") {
    hybridSeasons = filterSeasonsByRange(hybridSeasons, targetRange);
  }
  if (hybridSeasons.length) {
    markBootstrapCompleted(state, BOOTSTRAP_KEYS.HYBRID, { seasons: hybridSeasons, bootstrap_source: "artifact-scan" });
  }

  const hybridLatestFromLog = discoverHybridLatestFromLog();
  const hybridLatestInRange =
    mode === "chunk" && hybridLatestFromLog
      ? Number(hybridLatestFromLog.season) >= targetRange.start &&
        Number(hybridLatestFromLog.season) <= targetRange.end
        ? hybridLatestFromLog
        : null
      : hybridLatestFromLog;
  const hybridLatest = hybridLatestInRange || selectLatestRun(hybridSeasons);
  if (hybridLatest) {
    recordLatestRun(state, BOOTSTRAP_KEYS.HYBRID, hybridLatest);
  }

  saveTrainingState(state);
  console.log(
    `[bootstrap] Synthesised training_state.json (revision ${CURRENT_BOOTSTRAP_REVISION}) from available coverage.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
