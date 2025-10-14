import fs from "node:fs";
import path from "node:path";

const ARTIFACTS_DIR = path.resolve("artifacts");
const MODEL_REGEX = /^model_(\d{4})_W(\d{2})\.json$/;

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function listModelArtifacts() {
  try {
    return fs
      .readdirSync(ARTIFACTS_DIR)
      .map((name) => {
        const match = name.match(MODEL_REGEX);
        if (!match) return null;
        const season = Number(match[1]);
        const week = Number(match[2]);
        if (!Number.isFinite(season) || !Number.isFinite(week)) return null;
        return {
          season,
          week,
          name,
          path: path.join(ARTIFACTS_DIR, name)
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.season === b.season ? a.week - b.week : a.season - b.season));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

function findLatestBefore(season, week) {
  if (!Number.isFinite(season) || !Number.isFinite(week)) return null;
  const entries = listModelArtifacts();
  let latest = null;
  for (const entry of entries) {
    if (entry.season > season) break;
    const isBeforeSameSeason = entry.season === season && entry.week < week;
    const isBeforePastSeason = entry.season < season;
    if (!isBeforeSameSeason && !isBeforePastSeason) continue;
    if (!latest) {
      latest = entry;
    } else if (entry.season > latest.season || (entry.season === latest.season && entry.week > latest.week)) {
      latest = entry;
    }
  }
  return latest;
}

function mapWeightsToFeatures(weights = [], fromFeatures = [], toFeatures = []) {
  if (!Array.isArray(toFeatures) || !toFeatures.length) return null;
  if (!Array.isArray(fromFeatures) || !fromFeatures.length) return null;
  const index = new Map();
  for (let i = 0; i < fromFeatures.length && i < weights.length; i += 1) {
    const feature = fromFeatures[i];
    if (typeof feature !== "string") continue;
    if (!index.has(feature)) index.set(feature, i);
  }
  const mapped = new Array(toFeatures.length).fill(0);
  let matched = 0;
  for (let i = 0; i < toFeatures.length; i += 1) {
    const feature = toFeatures[i];
    if (typeof feature !== "string") continue;
    if (!index.has(feature)) continue;
    const sourceIdx = index.get(feature);
    const value = toFiniteNumber(weights[sourceIdx], 0);
    mapped[i] = value;
    matched += 1;
  }
  if (matched === 0) return null;
  return { weights: mapped, matched };
}

export function loadLogisticWarmStart({ season, week, features } = {}) {
  const targetSeason = Number(season);
  const targetWeek = Number(week);
  if (!Number.isFinite(targetSeason) || !Number.isFinite(targetWeek)) return null;
  const latest = findLatestBefore(targetSeason, targetWeek);
  if (!latest) return null;
  let parsed;
  try {
    const raw = fs.readFileSync(latest.path, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[modelWarmStart] Unable to load ${latest.name}: ${err?.message || err}`);
    return null;
  }
  const logistic = parsed?.logistic;
  const weightVector = Array.isArray(logistic?.weights) ? logistic.weights : null;
  const featureList = Array.isArray(logistic?.features) ? logistic.features : null;
  if (!weightVector || !featureList) return null;
  const aligned = mapWeightsToFeatures(weightVector, featureList, Array.isArray(features) ? features : []);
  if (!aligned) return null;
  const biasCandidate = logistic?.bias ?? logistic?.b ?? 0;
  const bias = toFiniteNumber(biasCandidate, 0);
  return {
    w: aligned.weights,
    b: bias,
    meta: {
      season: latest.season,
      week: latest.week,
      path: latest.path,
      matchedFeatures: aligned.matched,
      totalFeatures: Array.isArray(features) ? features.length : aligned.weights.length
    }
  };
}
