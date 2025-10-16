import fs from "fs";
import path from "path";
import {
  BOOTSTRAP_KEYS,
  CURRENT_BOOTSTRAP_REVISION,
  loadTrainingState,
  markBootstrapCompleted,
  recordLatestRun,
  saveTrainingState
} from "../trainer/trainingState.js";
import {
  ensureTrainingStateCurrent,
  getArtifactsDir,
  getTrainingStatePath,
  isTrainingStateCurrent
} from "../trainer/bootstrapState.js";

const ARTIFACTS_DIR = getArtifactsDir();
const STATE_PATH = getTrainingStatePath();

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

function main() {
  const artifactsAlreadyPresent = ensureArtifactsDir();
  const stateExisted = fs.existsSync(STATE_PATH);

  let state = loadTrainingState();

  if (!artifactsAlreadyPresent) {
    saveTrainingState(state);
    console.warn(
      `[bootstrap] artifacts directory missing at ${ARTIFACTS_DIR}. Created it automatically; run the trainer or restore artifacts before bootstrapping.`
    );
    return;
  }

  const entries = fs.readdirSync(ARTIFACTS_DIR);
  const predictionPattern = /^predictions_(\d{4})_W(\d{2})\.json$/;
  const predictionsSet = new Set(entries.filter((entry) => predictionPattern.test(entry)));

  const modelMap = buildSeasonWeekMap(entries, predictionPattern);
  if (modelMap.size === 0) {
    saveTrainingState(state);
    console.warn(
      `[bootstrap] No prediction artifacts found in ${ARTIFACTS_DIR}. Restore artifacts before bootstrapping training state.`
    );
    return;
  }

  if (stateExisted) {
    const modelUpToDate = hasCurrentRevision(state, BOOTSTRAP_KEYS.MODEL);
    const hybridUpToDate = hasCurrentRevision(state, BOOTSTRAP_KEYS.HYBRID);
    if (modelUpToDate && hybridUpToDate) {
      console.log(
        `[bootstrap] training_state.json already present at ${STATE_PATH} (revision ${CURRENT_BOOTSTRAP_REVISION}); skipping.`
      );
      return;
    }
    console.log("[bootstrap] Existing training_state.json has outdated bootstrap metadata; refreshing.");
  }

  const hybridMap = discoverHybridSeasons(entries, predictionsSet);

  const modelSeasons = serialiseSeasonMap(modelMap);
  markBootstrapCompleted(state, BOOTSTRAP_KEYS.MODEL, { seasons: modelSeasons, bootstrap_source: "artifact-scan" });

  const latestModel = selectLatestRun(modelSeasons);
  if (latestModel) {
    recordLatestRun(state, BOOTSTRAP_KEYS.MODEL, latestModel);
  }

  const hybridSeasons = serialiseSeasonMap(hybridMap);
  if (hybridSeasons.length) {
    markBootstrapCompleted(state, BOOTSTRAP_KEYS.HYBRID, { seasons: hybridSeasons, bootstrap_source: "artifact-scan" });
  }

  const hybridLatestFromLog = discoverHybridLatestFromLog();
  const hybridLatest = hybridLatestFromLog || selectLatestRun(hybridSeasons);
  if (hybridLatest) {
    recordLatestRun(state, BOOTSTRAP_KEYS.HYBRID, hybridLatest);
  }

  saveTrainingState(state);
  console.log(
    `[bootstrap] Synthesised training_state.json (revision ${CURRENT_BOOTSTRAP_REVISION}) from existing artifacts.`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
