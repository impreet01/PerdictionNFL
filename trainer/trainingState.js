import fs from "fs";
import path from "path";

const ARTIFACTS_DIR = path.resolve("artifacts");
const STATE_PATH = path.join(ARTIFACTS_DIR, "training_state.json");
export const CURRENT_BOOTSTRAP_REVISION = "2025-historical-bootstrap-v1";
export const BOOTSTRAP_KEYS = Object.freeze({
  MODEL: "model_training",
  HYBRID: "hybrid_v2"
});

const MODEL_PATTERN = /^model_(\d{4})_W(\d{1,2})\.json$/;

const EMPTY_STATE = Object.freeze({ schema_version: 1, bootstraps: {}, latest_runs: {} });

function ensureArtifactsDir() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

export function loadTrainingState() {
  ensureArtifactsDir();
  if (!fs.existsSync(STATE_PATH)) {
    saveTrainingState({ ...EMPTY_STATE });
    return { ...EMPTY_STATE };
  }
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (!parsed.bootstraps || typeof parsed.bootstraps !== "object") parsed.bootstraps = {};
      if (!parsed.latest_runs || typeof parsed.latest_runs !== "object") parsed.latest_runs = {};
      if (!parsed.schema_version) parsed.schema_version = 1;
      return parsed;
    }
  } catch (err) {
    console.warn(`[trainingState] failed to read state (${err?.message || err}). Reinitialising.`);
  }
  saveTrainingState({ ...EMPTY_STATE });
  return { ...EMPTY_STATE };
}

export function saveTrainingState(state) {
  ensureArtifactsDir();
  const payload = state && typeof state === "object" ? state : { ...EMPTY_STATE };
  fs.writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2));
}

export function envFlag(name) {
  const value = process.env[name];
  if (value == null) return false;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

const FORCE_KEYS = [
  "REWRITE_HISTORICAL",
  "OVERWRITE_HISTORICAL",
  "REBUILD_HISTORICAL",
  "REGENERATE_HISTORICAL",
  "REGEN_HISTORICAL",
  "FORCE_HISTORICAL_BOOTSTRAP"
];

export function shouldForceBootstrap() {
  return FORCE_KEYS.some((key) => envFlag(key));
}

function normaliseSeasonEntries(record) {
  if (!record || typeof record !== "object") return [];
  const seasons = Array.isArray(record.seasons) ? record.seasons : [];
  return seasons
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const season = Number.parseInt(entry.season ?? entry.year ?? entry.season_id, 10);
      if (!Number.isFinite(season)) return null;
      const weeks = Array.isArray(entry.weeks)
        ? entry.weeks
            .map((wk) => Number.parseInt(wk, 10))
            .filter((wk) => Number.isFinite(wk))
            .sort((a, b) => a - b)
        : [];
      return { season, weeks };
    })
    .filter(Boolean)
    .sort((a, b) => a.season - b.season);
}

function hasCoverageForRange(entries, { minSeason, maxSeason }) {
  if (!entries.length) return false;
  const coverage = new Map(entries.map((entry) => [entry.season, entry]));
  const lower = Number.isFinite(minSeason) ? minSeason : entries[0].season;
  const upper = Number.isFinite(maxSeason)
    ? Math.max(maxSeason, lower)
    : entries[entries.length - 1].season;
  for (let season = lower; season <= upper; season += 1) {
    if (!coverage.has(season)) return false;
  }
  return true;
}

export function shouldRunHistoricalBootstrap(state, key, { minSeason = DEFAULT_MIN_BOOTSTRAP_SEASON, requiredThroughSeason = null } = {}) {
  if (shouldForceBootstrap()) return true;
  if (key === BOOTSTRAP_KEYS.MODEL && !hasModelArtifactsOnDisk()) return true;
  const record = state?.bootstraps?.[key];
  if (!record) return true;
  if (record.revision !== CURRENT_BOOTSTRAP_REVISION) return true;
  const entries = normaliseSeasonEntries(record);
  if (!entries.length) return true;

  const latestRun = state?.latest_runs?.[key];
  const bySeasonRaw = latestRun?.by_season && typeof latestRun.by_season === "object"
    ? latestRun.by_season
    : null;
  if (bySeasonRaw) {
    const merged = new Map(entries.map((entry) => [entry.season, { ...entry }]));
    for (const [seasonKey, weekValue] of Object.entries(bySeasonRaw)) {
      const season = Number.parseInt(seasonKey, 10);
      if (!Number.isFinite(season)) continue;
      if (!merged.has(season)) {
        merged.set(season, { season, weeks: [] });
      }
      const week = Number.parseInt(weekValue, 10);
      if (Number.isFinite(week)) {
        const entry = merged.get(season);
        if (!entry.weeks.includes(week)) {
          entry.weeks.push(week);
          entry.weeks.sort((a, b) => a - b);
        }
      }
    }
    entries.splice(0, entries.length, ...Array.from(merged.values()).sort((a, b) => a.season - b.season));
  }

  if (Number.isFinite(minSeason) && entries[0].season > minSeason) {
    return true;
  }

  const coverageOk = hasCoverageForRange(entries, {
    minSeason: Number.isFinite(minSeason) ? minSeason : entries[0].season,
    maxSeason: Number.isFinite(requiredThroughSeason) ? requiredThroughSeason : null
  });
  if (!coverageOk) return true;

  if (Number.isFinite(requiredThroughSeason)) {
    const lastCovered = entries[entries.length - 1].season;
    if (lastCovered < requiredThroughSeason) return true;
  }

  if (!latestRun || typeof latestRun !== "object") return true;

  return false;
}

function hasModelArtifactsOnDisk() {
  try {
    const entries = fs.readdirSync(ARTIFACTS_DIR, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && MODEL_PATTERN.test(entry.name));
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export function markBootstrapCompleted(state, key, details = {}) {
  if (!state || typeof state !== "object") return state;
  if (!state.bootstraps || typeof state.bootstraps !== "object") {
    state.bootstraps = {};
  }
  state.bootstraps[key] = {
    revision: CURRENT_BOOTSTRAP_REVISION,
    completed_at: new Date().toISOString(),
    ...details
  };
  return state;
}

export function recordLatestRun(state, key, details = {}) {
  if (!state || typeof state !== "object") return state;
  if (!state.latest_runs || typeof state.latest_runs !== "object") {
    state.latest_runs = {};
  }

  const next = { ...details };
  const season = Number.parseInt(details.season ?? details.season_id, 10);
  const week = Number.parseInt(details.week ?? details.week_id, 10);
  const prevRecord = state.latest_runs[key];
  const bySeason = prevRecord?.by_season && typeof prevRecord.by_season === "object"
    ? { ...prevRecord.by_season }
    : {};

  if (Number.isFinite(season) && Number.isFinite(week)) {
    const prevWeek = Number.parseInt(bySeason[season], 10);
    bySeason[season] = Number.isFinite(prevWeek) ? Math.max(prevWeek, week) : week;
    next.season = season;
    next.week = week;
  }

  if (Object.keys(bySeason).length) {
    next.by_season = bySeason;
  }

  next.timestamp = new Date().toISOString();
  state.latest_runs[key] = next;
  return state;
}

export function getStatePath() {
  return STATE_PATH;
}
