import fs from "fs";
import path from "path";

const ARTIFACTS_DIR = path.resolve("artifacts");
const STATE_PATH = path.join(ARTIFACTS_DIR, "training_state.json");
export const CURRENT_BOOTSTRAP_REVISION = "2025-historical-bootstrap-v1";
export const BOOTSTRAP_KEYS = Object.freeze({
  MODEL: "model_training",
  HYBRID: "hybrid_v2"
});

function ensureArtifactsDir() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

export function loadTrainingState() {
  ensureArtifactsDir();
  if (!fs.existsSync(STATE_PATH)) {
    return { schema_version: 1, bootstraps: {}, latest_runs: {} };
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
  return { schema_version: 1, bootstraps: {}, latest_runs: {} };
}

export function saveTrainingState(state) {
  ensureArtifactsDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
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

export function shouldRunHistoricalBootstrap(state, key) {
  if (shouldForceBootstrap()) return true;
  const record = state?.bootstraps?.[key];
  if (!record) return true;
  if (record.revision !== CURRENT_BOOTSTRAP_REVISION) return true;
  return false;
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
  state.latest_runs[key] = {
    ...details,
    timestamp: new Date().toISOString()
  };
  return state;
}

export function getStatePath() {
  return STATE_PATH;
}
