import fs from "node:fs/promises";

import { ensure as ensureArtifact, loadParquetRecords, readManifest, ensureSeedSimulation } from "../../trainer/rArtifacts.js";
import { loadPBP, loadFourthDown, loadPlayerWeekly } from "../../trainer/dataSources.js";

const DEFAULT_MAX_AGE_MS = Number.isFinite(Number(process.env.WORKER_DATASET_MAX_AGE_MS))
  ? Number(process.env.WORKER_DATASET_MAX_AGE_MS)
  : 6 * 60 * 60 * 1000;

const manifestCache = new Map();

function toInt(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

async function withSkipRIngest(callback) {
  const previous = process.env.SKIP_R_INGEST;
  process.env.SKIP_R_INGEST = "1";
  try {
    return await callback();
  } finally {
    if (previous == null) {
      delete process.env.SKIP_R_INGEST;
    } else {
      process.env.SKIP_R_INGEST = previous;
    }
  }
}

async function loadDatasetWithEnsure(dataset, season, fallbackLoader, options = {}) {
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : DEFAULT_MAX_AGE_MS;
  try {
    const { parquetPath } = await ensureArtifact(dataset, season, { maxAgeMs, rootDir: options.rootDir });
    return await loadParquetRecords(parquetPath);
  } catch (err) {
    if (!fallbackLoader) throw err;
    return await withSkipRIngest(() => fallbackLoader(err));
  }
}

async function getManifest(dataset) {
  if (manifestCache.has(dataset)) {
    return manifestCache.get(dataset);
  }
  const manifest = await readManifest(dataset).catch(() => null);
  manifestCache.set(dataset, manifest);
  return manifest;
}

export async function resolveSeason(dataset, requestedSeason) {
  const parsed = toInt(requestedSeason);
  if (parsed != null) return parsed;
  const manifest = await getManifest(dataset);
  if (manifest?.seasons?.length) {
    const seasons = manifest.seasons
      .map((value) => toInt(value))
      .filter((value) => Number.isFinite(value));
    if (seasons.length) {
      return Math.max(...seasons);
    }
  }
  const now = new Date();
  return now.getUTCFullYear();
}

export async function loadPlayByPlaySeason(season, options = {}) {
  const rows = await loadDatasetWithEnsure(
    "pbp",
    season,
    () => loadPBP(season),
    options
  );
  return { season, rows };
}

export async function loadFourthDownSeason(season, options = {}) {
  const rows = await loadDatasetWithEnsure(
    "fourth-down",
    season,
    () => loadFourthDown(season),
    options
  );
  return { season, rows };
}

export async function loadPlayerWeeklySeason(season, options = {}) {
  const rows = await loadDatasetWithEnsure(
    "playerWeekly",
    season,
    () => loadPlayerWeekly(season),
    options
  );
  return { season, rows };
}

async function readSeedManifest(manifestPath) {
  if (!manifestPath) return null;
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function loadSeedSimulationSummary({ season, week, sims, maxAgeMs, rootDir } = {}) {
  const seasonValue = toInt(season);
  if (seasonValue == null) {
    throw new Error("loadSeedSimulationSummary requires a numeric season");
  }
  const ensureResult = await ensureSeedSimulation(seasonValue, {
    week,
    sims,
    maxAgeMs,
    rootDir
  });
  const rows = await loadParquetRecords(ensureResult.parquetPath);
  const manifest = await readSeedManifest(ensureResult.manifestPath);
  return {
    season: seasonValue,
    week: week == null ? null : toInt(week),
    rows,
    manifest,
    suffix: ensureResult.suffix
  };
}

export function deriveAvailableWeeks(rows, accessor = (row) => row?.week) {
  const weeks = new Set();
  for (const row of rows || []) {
    const value = toInt(accessor(row));
    if (value != null) weeks.add(value);
  }
  return [...weeks].sort((a, b) => a - b);
}

export function deriveAvailableTeams(rows, options = {}) {
  const { offenseKey = "posteam", defenseKey = "defteam", teamKey = "team" } = options;
  const teams = new Set();
  for (const row of rows || []) {
    if (row && offenseKey && row[offenseKey]) teams.add(String(row[offenseKey]).toUpperCase());
    if (row && defenseKey && row[defenseKey]) teams.add(String(row[defenseKey]).toUpperCase());
    if (row && teamKey && row[teamKey]) teams.add(String(row[teamKey]).toUpperCase());
  }
  return [...teams].sort();
}

export default {
  resolveSeason,
  loadPlayByPlaySeason,
  loadFourthDownSeason,
  loadPlayerWeeklySeason,
  loadSeedSimulationSummary,
  deriveAvailableWeeks,
  deriveAvailableTeams
};
