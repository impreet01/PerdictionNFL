import fs from "fs";
import path from "path";
import {
  loadTrainingState,
  saveTrainingState,
  markBootstrapCompleted,
  recordLatestRun,
  BOOTSTRAP_KEYS,
  CURRENT_BOOTSTRAP_REVISION
} from "./trainingState.js";

const ARTIFACTS_DIR = path.resolve("artifacts");
const STATE_PATH = path.join(ARTIFACTS_DIR, "training_state.json");

function ensureArtifactsDir() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    throw new Error(
      `[bootstrap] artifacts directory missing at ${ARTIFACTS_DIR}. Run the trainer once manually or restore artifacts before bootstrapping.`
    );
  }
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

function parseLatestRunCandidate(run) {
  if (!run || typeof run !== "object") return null;
  const season = Number.parseInt(run.season ?? run.season_id ?? run.year, 10);
  const week = Number.parseInt(run.week ?? run.week_id, 10);
  if (!Number.isFinite(season) || !Number.isFinite(week)) return null;
  return { season, week };
}

function selectLatestFromBootstrap(state, key) {
  const seasons = state?.bootstraps?.[key]?.seasons;
  if (!Array.isArray(seasons) || seasons.length === 0) return null;
  return selectLatestRun(
    seasons
      .filter((entry) => entry && typeof entry === "object" && Array.isArray(entry.weeks) && entry.weeks.length)
      .map((entry) => ({
        season: Number.parseInt(entry.season, 10),
        weeks: entry.weeks.map((wk) => Number.parseInt(wk, 10)).filter((wk) => Number.isFinite(wk)).sort((a, b) => a - b)
      }))
      .filter((entry) => Number.isFinite(entry.season) && entry.weeks.length)
  );
}

function areLatestRunsAligned(state) {
  const keys = [BOOTSTRAP_KEYS.MODEL, BOOTSTRAP_KEYS.HYBRID];
  return keys.every((key) => {
    const expected = selectLatestFromBootstrap(state, key);
    if (!expected) return true;
    const recorded = parseLatestRunCandidate(state?.latest_runs?.[key]);
    if (!recorded) return false;
    return recorded.season === expected.season && recorded.week === expected.week;
  });
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

function applyBootstrapMetadata(state, { modelSeasons, hybridSeasons }) {
  markBootstrapCompleted(state, BOOTSTRAP_KEYS.MODEL, {
    seasons: modelSeasons,
    bootstrap_source: "artifact-scan"
  });

  const latestModel = selectLatestRun(modelSeasons);
  if (latestModel) {
    recordLatestRun(state, BOOTSTRAP_KEYS.MODEL, latestModel);
  }

  if (hybridSeasons.length) {
    markBootstrapCompleted(state, BOOTSTRAP_KEYS.HYBRID, {
      seasons: hybridSeasons,
      bootstrap_source: "artifact-scan"
    });
  }

  const hybridLatestFromLog = discoverHybridLatestFromLog();
  const hybridLatest = hybridLatestFromLog || selectLatestRun(hybridSeasons);
  if (hybridLatest) {
    recordLatestRun(state, BOOTSTRAP_KEYS.HYBRID, hybridLatest);
  }
}

export function isTrainingStateCurrent(state) {
  const modelUpToDate = hasCurrentRevision(state, BOOTSTRAP_KEYS.MODEL);
  const hybridUpToDate = hasCurrentRevision(state, BOOTSTRAP_KEYS.HYBRID);
  return modelUpToDate && hybridUpToDate;
}

export function refreshTrainingStateFromArtifacts(existingState = null) {
  ensureArtifactsDir();
  const entries = fs.readdirSync(ARTIFACTS_DIR);
  const predictionPattern = /^predictions_(\d{4})_W(\d{2})\.json$/;
  const predictionsSet = new Set(entries.filter((entry) => predictionPattern.test(entry)));

  const modelMap = buildSeasonWeekMap(entries, predictionPattern);
  if (modelMap.size === 0) {
    throw new Error(
      `[bootstrap] No prediction artifacts found in ${ARTIFACTS_DIR}. Restore artifacts before bootstrapping training state.`
    );
  }

  const hybridMap = discoverHybridSeasons(entries, predictionsSet);

  const state = existingState ?? loadTrainingState();

  const modelSeasons = serialiseSeasonMap(modelMap);
  const hybridSeasons = serialiseSeasonMap(hybridMap);

  applyBootstrapMetadata(state, { modelSeasons, hybridSeasons });

  saveTrainingState(state);
  return { state, modelSeasons, hybridSeasons };
}

export function ensureTrainingStateCurrent({ state = null, silent = false } = {}) {
  const baseState = state ?? loadTrainingState();
  const bootstrapCurrent = isTrainingStateCurrent(baseState);
  const latestAligned = bootstrapCurrent && areLatestRunsAligned(baseState);

  if (bootstrapCurrent && latestAligned) {
    return { state: baseState, refreshed: false };
  }

  try {
    const result = refreshTrainingStateFromArtifacts(baseState);
    return { state: result.state, refreshed: true };
  } catch (err) {
    if (silent) {
      return { state: baseState, refreshed: false, error: err };
    }
    throw err;
  }
}

export function getArtifactsDir() {
  return ARTIFACTS_DIR;
}

export function getTrainingStatePath() {
  return STATE_PATH;
}
