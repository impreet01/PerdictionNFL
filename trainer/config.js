// trainer/config.js
// Centralized configuration loader merging JSON defaults with env overrides.

import fs from "node:fs";
import path from "node:path";

import loadTrainConfig from "./yamlConfig.js";

const CONFIG_ROOT = path.resolve("./configs");

const DEFAULT_ARTIFACTS_DIR = "artifacts";
const TEST_ARTIFACTS_DIR = ".test_artifacts";

function readJSONSafe(file) {
  try {
    const data = fs.readFileSync(file, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function mergeDeep(base, override) {
  if (Array.isArray(base) && Array.isArray(override)) {
    return override.slice();
  }
  if (typeof base !== "object" || base === null) return override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = mergeDeep(base[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function getEnvTrainDefaults() {
  const defaults = {
    paths: {
      artifacts: process.env.NODE_ENV === "test" ? TEST_ARTIFACTS_DIR : DEFAULT_ARTIFACTS_DIR
    }
  };

  const artifactsDir = typeof process.env.ARTIFACTS_DIR === "string" ? process.env.ARTIFACTS_DIR.trim() : "";
  if (artifactsDir) {
    defaults.paths.artifacts = artifactsDir;
  }

  return defaults;
}

function parseEnvJSON(key) {
  const raw = process.env[key];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Failed to parse ${key} as JSON: ${err.message}`);
    return undefined;
  }
}

export function loadConfig(name) {
  const base = readJSONSafe(path.join(CONFIG_ROOT, `${name}.json`));
  const envOverride = parseEnvJSON(`${name.toUpperCase()}_JSON`);
  return mergeDeep(base, envOverride || {});
}

function normalizeFlag(value) {
  if (value == null) return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim();
  if (text === "") return undefined;
  return /^(1|true|yes|on)$/i.test(text);
}

export function applyEnvOverrides(config) {
  const override = { ...config };
  const season = process.env.SEASON;
  if (season) {
    override.season = Number.parseInt(season, 10) || override.season;
  }
  const week = process.env.WEEK;
  if (week) {
    override.week = Number.parseInt(week, 10) || override.week;
  }
  const featureKeys = ["rolling", "expWeighted", "targetEncoding", "injuryContext", "marketContext", "weatherContext"];
  override.features = { ...(config.features || {}) };
  for (const key of featureKeys) {
    const value = normalizeFlag(process.env[`FEATURE_${key.toUpperCase()}`]);
    if (value !== undefined) override.features[key] = value;
  }
  override.models = { ...(config.models || {}) };
  for (const [modelKey, settings] of Object.entries(config.models || {})) {
    const enabledOverride = normalizeFlag(process.env[`${modelKey.toUpperCase()}_ENABLED`]);
    override.models[modelKey] = { ...settings };
    if (enabledOverride !== undefined) override.models[modelKey].enabled = enabledOverride;
    const l2Override = process.env[`${modelKey.toUpperCase()}_L2`];
    if (l2Override) override.models[modelKey].l2 = Number(l2Override);
  }
  const weightOverride = parseEnvJSON("ENSEMBLE_WEIGHTS");
  if (weightOverride && typeof weightOverride === "object") {
    override.ensemble = override.ensemble || {};
    override.ensemble.weights = { ...override.ensemble.weights, ...weightOverride };
  }
  return override;
}

export function getModelConfig() {
  const config = loadConfig("model");
  return applyEnvOverrides(config);
}

export function getDataConfig() {
  const config = loadConfig("data");
  const override = { ...config };
  const season = process.env.SEASON;
  if (season) override.season = Number(season);
  const week = process.env.WEEK;
  if (week) override.week = Number(week);
  const attempts = process.env.DATA_RETRY_ATTEMPTS;
  if (attempts) {
    override.retry = override.retry || {};
    override.retry.attempts = Number(attempts);
  }
  const backoff = process.env.DATA_RETRY_BACKOFF_MS;
  if (backoff) {
    override.retry = override.retry || {};
    override.retry.backoffMs = Number(backoff);
  }
  return override;
}

function buildTrainSettings() {
  const envDefaults = getEnvTrainDefaults();
  const yamlOverrides = loadTrainConfig();
  return mergeDeep(envDefaults, yamlOverrides || {});
}

const TRAIN_SETTINGS = buildTrainSettings();

export function getTrainSettings() {
  return TRAIN_SETTINGS;
}

export async function getConfig() {
  return {
    trainSettings: getTrainSettings()
  };
}

export default {
  getModelConfig,
  getDataConfig,
  trainSettings: TRAIN_SETTINGS
};
