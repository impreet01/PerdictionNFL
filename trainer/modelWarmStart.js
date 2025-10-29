import { promises as fs } from "node:fs";
import path from "node:path";

import { artifactsRoot } from "./utils/paths.js";

function getArtifactsDir() {
  return artifactsRoot();
}
const MODEL_REGEX = /^model_(\d{4})_W(\d{2})\.json$/;
const MODEL_PREFIX = "model";

function toWeekStamp(season, week) {
  return `${String(season).padStart(4, "0")}_W${String(week).padStart(2, "0")}`;
}

function modelArtifactPath(season, week) {
  const stamp = toWeekStamp(season, week);
  return path.join(getArtifactsDir(), `${MODEL_PREFIX}_${stamp}.json`);
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export async function listModelArtifacts() {
  try {
    const artifactsDir = getArtifactsDir();
    const entries = await fs.readdir(artifactsDir, { withFileTypes: true });
    return entries
      .filter((dirent) => dirent.isFile())
      .map((dirent) => dirent.name)
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
          path: path.join(artifactsDir, name)
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.season === b.season ? a.week - b.week : a.season - b.season));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function findLatestBefore(season, week) {
  if (!Number.isFinite(season) || !Number.isFinite(week)) return null;
  const entries = await listModelArtifacts();
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

export async function loadLogisticWarmStart({ season, week, features } = {}) {
  const targetSeason = Number(season);
  const targetWeek = Number(week);
  if (!Number.isFinite(targetSeason) || !Number.isFinite(targetWeek)) return null;
  const latest = await findLatestBefore(targetSeason, targetWeek);
  if (!latest) return null;
  console.log(
    `[modelWarmStart] Warm-starting logistic from ${latest.season} W${String(latest.week).padStart(2, "0")} at ${getArtifactsDir()}`
  );
  let parsed;
  try {
    const raw = await fs.readFile(latest.path, "utf8");
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

export async function shouldRetrain({ season, week, featureHash } = {}) {
  const targetSeason = Number(season);
  const targetWeek = Number(week);
  if (!Number.isFinite(targetSeason) || !Number.isFinite(targetWeek)) return true;
  const expectedHash = typeof featureHash === "string" && featureHash ? featureHash : null;
  if (!expectedHash) return true;
  try {
    const raw = await fs.readFile(modelArtifactPath(targetSeason, targetWeek), "utf8");
    const parsed = JSON.parse(raw);
    const storedHash =
      parsed?.feature_hash ?? parsed?.featureHash ?? parsed?.modelSummary?.feature_hash ?? null;
    if (!storedHash) return true;
    return storedHash !== expectedHash;
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    console.warn(
      `[modelWarmStart] Unable to read model artifact for ${targetSeason} week ${targetWeek}: ${err?.message || err}`
    );
    return true;
  }
}
