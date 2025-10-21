import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  BOOTSTRAP_KEYS,
  CURRENT_BOOTSTRAP_REVISION,
  loadTrainingState,
  saveTrainingState
} from "./trainingState.js";
import { canReuseModel, mapModelRevision } from "./modelRevision.js";

import { artifactsRoot } from "./utils/paths.js";

const MODELS_ROOT = path.resolve(artifactsRoot(), "models");
const JSON_SPACE = process.env.CI ? undefined : 2;
const FEATURE_STATS_PREFIX = "feature_stats_1999_";

function toRelativeModelPath(targetPath) {
  const relative = path.relative(MODELS_ROOT, targetPath);
  return relative.split(path.sep).join("/");
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

async function listDirectory(targetPath) {
  try {
    return await fsp.readdir(targetPath, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

function normaliseSeason(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureDir(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true });
}

function hashPayload(payload) {
  if (payload == null) return null;
  try {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch (err) {
    console.warn(`[promote] Failed to hash payload: ${err?.message ?? err}`);
    return null;
  }
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function deriveSchemaHash(payload) {
  return (
    payload?.schema_hash ??
    payload?.schemaHash ??
    payload?.meta?.schema_hash ??
    payload?.meta?.schemaHash ??
    null
  );
}

function deriveCalibrationHash(payload) {
  if (!payload || typeof payload !== "object") return null;
  const calibration =
    payload.calibration ??
    payload.calibrator ??
    payload.meta?.calibration ??
    payload?.summary?.calibration ??
    null;
  if (!calibration) return null;
  return hashPayload(calibration);
}

async function copyJson({
  sourcePath,
  destPath,
  prevRevision,
  currentRevision,
  schemaHashTarget
}) {
  let parsed;
  try {
    parsed = await readJson(sourcePath);
  } catch (err) {
    if (err?.name === "SyntaxError") {
      console.warn(`[promote] Invalid JSON in ${sourcePath}; copying raw.`);
      await fsp.copyFile(sourcePath, destPath);
      return { schemaHash: null, calibrationHash: null };
    }
    throw err;
  }

  const schemaHash = deriveSchemaHash(parsed);
  const reuseOk = canReuseModel(prevRevision, currentRevision, {
    previous: schemaHash,
    expected: schemaHashTarget ?? schemaHash
  });
  const payload = reuseOk
    ? parsed
    : mapModelRevision(parsed, {
        fromRevision: prevRevision,
        toRevision: currentRevision,
        filePath: sourcePath
      }) ?? parsed;

  await fsp.writeFile(destPath, JSON.stringify(payload, null, JSON_SPACE));
  return { schemaHash: deriveSchemaHash(payload), calibrationHash: deriveCalibrationHash(payload) };
}

async function copyRecursive({
  sourceDir,
  destDir,
  prevRevision,
  currentRevision,
  files,
  schemaHashTarget
}) {
  const entries = await listDirectory(sourceDir);
  let calibrationHash = null;
  let schemaHash = null;

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await ensureDir(destPath);
      const nested = await copyRecursive({
        sourceDir: sourcePath,
        destDir: destPath,
        prevRevision,
        currentRevision,
        files,
        schemaHashTarget
      });
      calibrationHash = calibrationHash ?? nested.calibrationHash ?? null;
      schemaHash = schemaHash ?? nested.schemaHash ?? null;
      continue;
    }
    if (!entry.isFile()) continue;
    await ensureDir(path.dirname(destPath));
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === ".json") {
      const { schemaHash: mappedSchemaHash, calibrationHash: mappedCalHash } = await copyJson({
        sourcePath,
        destPath,
        prevRevision,
        currentRevision,
        schemaHashTarget
      });
      calibrationHash = calibrationHash ?? mappedCalHash ?? null;
      schemaHash = schemaHash ?? mappedSchemaHash ?? null;
    } else {
      await fsp.copyFile(sourcePath, destPath);
    }
    files.push(toRelativeModelPath(destPath));
  }

  return { calibrationHash, schemaHash };
}

async function directoryHasContent(targetPath) {
  const entries = await listDirectory(targetPath);
  return entries.some((entry) => entry.isFile() || entry.isDirectory());
}

async function discoverFeatureStats(prevSeason) {
  if (!Number.isFinite(prevSeason)) return null;
  const commonDir = path.join(MODELS_ROOT, "common");
  const entries = await listDirectory(commonDir);
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(FEATURE_STATS_PREFIX))
    .map((entry) => {
      const rawSeason = entry.name.slice(FEATURE_STATS_PREFIX.length).replace(/\.json$/i, "");
      const season = Number.parseInt(rawSeason, 10);
      return { season, name: entry.name };
    })
    .filter((entry) => Number.isFinite(entry.season) && entry.season <= prevSeason)
    .sort((a, b) => b.season - a.season);
  if (!candidates.length) return null;
  const chosen = candidates[0];
  const filePath = path.join(commonDir, chosen.name);
  return { filePath, season: chosen.season };
}

async function ensureFeatureStatsPromoted({ statsInfo, targetDir }) {
  if (!statsInfo) return { filePath: null, hash: null };
  const destPath = path.join(targetDir, "feature_stats.json");
  try {
    await fsp.copyFile(statsInfo.filePath, destPath);
  } catch (err) {
    console.warn(`[promote] Failed to copy feature stats: ${err?.message ?? err}`);
  }
  let raw;
  try {
    raw = await fsp.readFile(statsInfo.filePath, "utf8");
  } catch (err) {
    console.warn(`[promote] Unable to read feature stats for hashing: ${err?.message ?? err}`);
    return { filePath: statsInfo.filePath, hash: null };
  }
  return { filePath: statsInfo.filePath, hash: hashPayload(raw) };
}

export async function promote({ prevSeason, nextSeason, destDir, allowRevMap = true } = {}) {
  const previous = normaliseSeason(prevSeason);
  const next = normaliseSeason(nextSeason);
  if (!Number.isFinite(previous) || !Number.isFinite(next)) {
    throw new Error("[promote] prevSeason and nextSeason must be valid integers.");
  }
  if (next <= previous) {
    throw new Error("[promote] nextSeason must be greater than prevSeason.");
  }

  const sourceDir = path.join(MODELS_ROOT, String(previous), "final");
  const targetDir = destDir ? path.resolve(destDir) : path.join(MODELS_ROOT, String(next), "week-00");
  const sourceExists = await pathExists(sourceDir);
  if (!sourceExists) {
    return false;
  }

  const state = loadTrainingState();
  const bootstrapRecord = state?.bootstraps?.[BOOTSTRAP_KEYS.MODEL] ?? {};
  const prevRevision = bootstrapRecord?.revision ?? null;
  const currentRevision = CURRENT_BOOTSTRAP_REVISION;
  const schemaHashTarget = bootstrapRecord?.schemaHash ?? null;

  let files = [];
  let calibrationHash = null;
  let schemaHash = schemaHashTarget ?? null;

  const alreadyHasContent = await directoryHasContent(targetDir);
  if (alreadyHasContent) {
    console.log(`[promote] Destination ${targetDir} already contains files – refreshing metadata.`);
    try {
      const existing = await readJson(path.join(targetDir, "ensemble.json"));
      calibrationHash = deriveCalibrationHash(existing);
      schemaHash = schemaHash ?? deriveSchemaHash(existing) ?? null;
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`[promote] Unable to inspect existing ensemble: ${err?.message ?? err}`);
      }
    }
  } else {
    await ensureDir(targetDir);
    const results = await copyRecursive({
      sourceDir,
      destDir: targetDir,
      prevRevision: allowRevMap ? prevRevision : null,
      currentRevision,
      files,
      schemaHashTarget
    });
    files.sort();
    calibrationHash = results.calibrationHash ?? null;
    schemaHash = results.schemaHash ?? schemaHash;
    if (!files.length) {
      console.warn(`[promote] No files discovered under ${sourceDir}; nothing promoted.`);
      return false;
    }
  }

  const statsInfo = await discoverFeatureStats(previous);
  const { hash: featureStatsHash } = await ensureFeatureStatsPromoted({ statsInfo, targetDir });

  state.bootstraps = state.bootstraps || {};
  const updatedRecord = {
    ...bootstrapRecord,
    seededFrom: previous,
    seedRevision: prevRevision ?? null,
    seedFiles: files.length ? files : bootstrapRecord?.seedFiles ?? [],
    seedPromotedAt: new Date().toISOString(),
    revision: bootstrapRecord?.revision ?? CURRENT_BOOTSTRAP_REVISION,
    schemaHash: schemaHash ?? bootstrapRecord?.schemaHash ?? null
  };
  state.bootstraps[BOOTSTRAP_KEYS.MODEL] = updatedRecord;

  state.weekly_seed = {
    season: next,
    seededFrom: previous,
    seedRevision: updatedRecord.seedRevision ?? updatedRecord.revision ?? null,
    featureStatsHash: featureStatsHash ?? null,
    calibrationHash: calibrationHash ?? null
  };

  saveTrainingState(state);
  return true;
}

export default promote;
