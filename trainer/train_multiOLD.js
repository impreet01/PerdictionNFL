// trainer/train_multi.js
// Multi-model ensemble trainer with logistic+CART, Bradley-Terry, and ANN committee.

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import crypto from "node:crypto";
import {
  loadSchedules,
  loadTeamWeekly,
  loadTeamGameAdvanced,
  loadPBP,
  loadPlayerWeekly,
  loadRostersWeekly,
  loadDepthCharts,
  loadInjuries,
  loadSnapCounts,
  loadPFRAdvTeam,       // kept for compatibility; now returns weekly array
  loadESPNQBR,
  loadOfficials,
  loadWeather,
  loadNextGenStats,
  loadParticipation,
  listDatasetSeasons
} from "./dataSources.js";
import { buildContextForWeek } from "./contextPack.js";
import { writeExplainArtifact, calibrateThresholds } from "./explainRubric.js";
import { buildFeatures, FEATS as FEATS_BASE } from "./featureBuild.js";
import { buildBTFeatures, BT_FEATURES } from "./featureBuild_bt.js";
import { trainBTModel, predictBT, predictBTDeterministic } from "./model_bt.js";
import { trainANNCommittee, predictANNCommittee, gradientANNCommittee } from "./model_ann.js";
import { isStrictBatch, getStrictBounds, clampSeasonsToStrictBounds } from "./lib/strictBatch.js";
import { DecisionTreeClassifier as CART } from "ml-cart";
import { Matrix, SVD } from "ml-matrix";
import { logLoss, brier, accuracy, aucRoc, calibrationBins } from "./metrics.js";
import { buildSeasonDB, attachAdvWeeklyDiff, resolveSeasonList } from "./databases.js";
import {
  loadTrainingState,
  saveTrainingState,
  shouldRunHistoricalBootstrap,
  markBootstrapCompleted,
  recordBootstrapChunk,
  recordLatestRun,
  BOOTSTRAP_KEYS,
  CURRENT_BOOTSTRAP_REVISION
} from "./trainingState.js";
import { ensureTrainingStateCurrent } from "./bootstrapState.js";
import { loadLogisticWarmStart, shouldRetrain } from "./modelWarmStart.js";
import { validateArtifact } from "./schemaValidator.js";
import { promote } from "./promotePreviousSeason.js";
import { resolveCalibration, hashCalibrationMeta } from "./calibrate.js";
import {
  buildSeasonCoverageFromRaw,
  mergeSeasonCoverage,
  seasonsInRangeMissing,
  MIN_SEASON as MIN_SEASON_CONSTANT
} from "./stateBuilder.js";
import { artp, artifactsRoot } from "./utils/paths.js";
import { isBefore, sortChronologically } from "./utils/temporalWindow.js";

function isDirectCliRun() {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const cli = process.argv[1] ? path.resolve(process.argv[1]) : "";
    return path.resolve(thisFile) === cli;
  } catch {
    return typeof require !== "undefined" && require.main === module;
  }
}

const { readFileSync, existsSync } = fs;

const HISTORICAL_BATCH_SIZE = Number.isFinite(Number(process.env.BATCH_SIZE))
  ? Math.max(1, Number(process.env.BATCH_SIZE))
  : 2;

const CI_FAST = process.env.CI_FAST === "1";
const MAX_WORKERS = Number.isFinite(Number(process.env.MAX_WORKERS))
  ? Math.max(1, Number(process.env.MAX_WORKERS))
  : 2;
const MAX_SEASONS_PER_CHUNK = CI_FAST ? 2 : 3;
const JSON_SPACE = CI_FAST ? undefined : 2;
const ANN_BASE_CONFIG = Object.freeze({
  seeds: Number.isFinite(Number(process.env.ANN_SEEDS))
    ? Math.max(1, Number(process.env.ANN_SEEDS))
    : 5,
  maxEpochs: Number.isFinite(Number(process.env.ANN_MAX_EPOCHS))
    ? Math.max(1, Number(process.env.ANN_MAX_EPOCHS))
    : 250,
  patience: 10,
  cvSeeds: 3,
  weightStep: 0.05,
  gridTopN: Number.POSITIVE_INFINITY,
  kfold: 5
});
const TRACE_ENABLED = process.env.TRAIN_TRACE === "1";
const trace = (...args) => {
  if (!TRACE_ENABLED) return;
  console.log("[train:trace]", ...args);
};
const warn = (...args) => {
  console.warn("[train:warn]", ...args);
};
const ANN_CONFIG = (() => {
  if (CI_FAST) {
    return {
      ...ANN_BASE_CONFIG,
      seeds: 1,
      maxEpochs: Math.min(ANN_BASE_CONFIG.maxEpochs, 15),
      patience: 3,
      cvSeeds: 1,
      weightStep: Math.max(ANN_BASE_CONFIG.weightStep, 0.15),
      gridTopN: 3,
      kfold: Math.min(3, ANN_BASE_CONFIG.kfold)
    };
  }
  return { ...ANN_BASE_CONFIG };
})();

const CHUNK_FILE_PREFIX = "model";
let ART_DIR = artifactsRoot();
let STATUS_DIR = path.join(ART_DIR, ".status");
let CHUNK_CACHE_DIR = path.join(ART_DIR, "chunks");
let CHECKPOINT_DIR = path.join(ART_DIR, "checkpoints");
let ANN_CHECKPOINT_PATH = path.join(CHECKPOINT_DIR, "ann_committee.json");

function refreshArtifactsPaths() {
  ART_DIR = artifactsRoot();
  STATUS_DIR = path.join(ART_DIR, ".status");
  CHUNK_CACHE_DIR = path.join(ART_DIR, "chunks");
  CHECKPOINT_DIR = path.join(ART_DIR, "checkpoints");
  ANN_CHECKPOINT_PATH = path.join(CHECKPOINT_DIR, "ann_committee.json");
  trace("artifacts:resolve", {
    cwd: process.cwd(),
    env: process.env.ARTIFACTS_DIR ?? null,
    resolved: ART_DIR
  });
}

refreshArtifactsPaths();
const FEATURE_STATS_PREFIX = "feature_stats_1999_";
const DEFAULT_CHUNK_SPAN = Math.min(
  MAX_SEASONS_PER_CHUNK,
  Number.isFinite(Number(process.env.HISTORICAL_CHUNK_SPAN))
    ? Math.max(1, Number(process.env.HISTORICAL_CHUNK_SPAN))
    : HISTORICAL_BATCH_SIZE
);

async function ensureArtifactsDir() {
  await fsp.mkdir(ART_DIR, { recursive: true });
}
const MODEL_PARAMS_PATH = "./config/modelParams.json";

async function ensureChunkCacheDir() {
  await fsp.mkdir(CHUNK_CACHE_DIR, { recursive: true });
}

function chunkLabel(start, end) {
  return `${start}-${end}`;
}

function chunkMetadataPath(label) {
  return path.join(CHUNK_CACHE_DIR, `${CHUNK_FILE_PREFIX}_${label}.json`);
}

function chunkDonePath(label) {
  return path.join(CHUNK_CACHE_DIR, `${CHUNK_FILE_PREFIX}_${label}.done`);
}

async function ensureCheckpointDir() {
  await fsp.mkdir(CHECKPOINT_DIR, { recursive: true });
}

async function loadAnnCheckpoint() {
  try {
    const raw = await fsp.readFile(ANN_CHECKPOINT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    trace("checkpoint:ann:load", {
      path: ANN_CHECKPOINT_PATH,
      hasModel: Boolean(parsed?.model),
      season: parsed?.season ?? null,
      chunk: parsed?.chunk ?? null
    });
    return { ...parsed, path: ANN_CHECKPOINT_PATH };
  } catch (err) {
    if (err?.code === "ENOENT") {
      trace("checkpoint:ann:load", { path: ANN_CHECKPOINT_PATH, missing: true });
      return null;
    }
    warn(`[train] Unable to load ANN checkpoint: ${err?.message || err}`);
    return null;
  }
}

async function saveAnnCheckpoint({ model, season, week, chunkSelection } = {}) {
  if (!model) return null;
  await ensureCheckpointDir();
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    season: Number.isFinite(season) ? season : null,
    week: Number.isFinite(week) ? week : null,
    chunk: chunkSelection
      ? {
          start: Number.isFinite(chunkSelection.start) ? chunkSelection.start : null,
          end: Number.isFinite(chunkSelection.end) ? chunkSelection.end : null
        }
      : null,
    model
  };
  await fsp.writeFile(ANN_CHECKPOINT_PATH, JSON.stringify(payload, null, JSON_SPACE));
  const chunkLabel = chunkSelection && Number.isFinite(chunkSelection.start) && Number.isFinite(chunkSelection.end)
    ? `${chunkSelection.start}-${chunkSelection.end}`
    : null;
  const seasonLog = Number.isFinite(payload.season) ? ` season ${payload.season}` : "";
  const weekLog = Number.isFinite(payload.week)
    ? ` week ${String(payload.week).padStart(2, "0")}`
    : "";
  const chunkLog = chunkLabel ? ` chunk ${chunkLabel}` : "";
  console.log(
    `[train] Saved ANN warm-start checkpoint to ${ANN_CHECKPOINT_PATH}${chunkLog}${seasonLog}${weekLog}.`
  );
  trace("checkpoint:ann:save", {
    path: ANN_CHECKPOINT_PATH,
    season: payload.season,
    week: payload.week,
    chunk: payload.chunk
  });
  return { ...payload, path: ANN_CHECKPOINT_PATH };
}

function expandSeasonsFromSelection(selection) {
  if (!selection || !Number.isFinite(selection.start) || !Number.isFinite(selection.end)) return [];
  const out = [];
  for (let s = selection.start; s <= selection.end; s += 1) out.push({ season: s });
  return out;
}

function normaliseChunkSeasonEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const normalised = [];
  for (const entry of entries) {
    if (entry == null) continue;
    if (typeof entry === "object") {
      const season = normaliseSeasonValue(entry);
      if (!Number.isFinite(season)) continue;
      const weeks = Array.isArray(entry.weeks)
        ? entry.weeks
            .map((wk) => Number.parseInt(wk, 10))
            .filter((wk) => Number.isFinite(wk))
            .sort((a, b) => a - b)
        : undefined;
      if (weeks && weeks.length) {
        normalised.push({ season, weeks });
      } else {
        normalised.push({ season });
      }
      continue;
    }
    const season = Number.parseInt(entry, 10);
    if (Number.isFinite(season)) {
      normalised.push({ season });
    }
  }
  normalised.sort((a, b) => a.season - b.season);
  return normalised;
}

async function finalizeStrictWindow({ chunkSelection, processedSeasons = [], state }) {
  if (!chunkSelection) return state;
  const label = chunkLabel(chunkSelection.start, chunkSelection.end);
  const fallback = expandSeasonsFromSelection(chunkSelection);
  const seasonsForRecordRaw = processedSeasons.length ? processedSeasons : fallback;
  const seasonsForRecord = normaliseChunkSeasonEntries(seasonsForRecordRaw);

  trace("finalizeStrictWindow", {
    label,
    seasons: seasonsForRecord.map((entry) => ({
      season: entry.season,
      weeks: Array.isArray(entry.weeks) ? entry.weeks : undefined
    })),
    source: processedSeasons.length ? "processed" : "fallback"
  });

  await writeChunkCache(label, {
    startSeason: chunkSelection.start,
    endSeason:   chunkSelection.end,
    seasons:     seasonsForRecord
  });

  state = recordBootstrapChunk(state, BOOTSTRAP_KEYS.MODEL, {
    startSeason: chunkSelection.start,
    endSeason:   chunkSelection.end,
    seasons:     seasonsForRecord
  });

  if (seasonsForRecord.length) {
    markSeasonStatusBatch(seasonsForRecord);
  }
  return state;
}

async function loadChunkCache(label) {
  try {
    const raw = await fsp.readFile(chunkMetadataPath(label), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.revision === CURRENT_BOOTSTRAP_REVISION) {
      return parsed;
    }
    return null;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function writeChunkCache(label, payload = {}) {
  await ensureChunkCacheDir();
  const record = {
    label,
    revision: CURRENT_BOOTSTRAP_REVISION,
    completed_at: new Date().toISOString(),
    ...payload
  };
  trace("chunk-cache:write", {
    label,
    donePath: chunkDonePath(label),
    seasons: Array.isArray(record.seasons)
      ? record.seasons.map((entry) => ({
          season: entry.season,
          weeks: Array.isArray(entry.weeks) ? entry.weeks : undefined
        }))
      : []
  });
  await fsp.writeFile(chunkMetadataPath(label), JSON.stringify(record, null, JSON_SPACE));
  await fsp.writeFile(chunkDonePath(label), `${record.completed_at}\n`);
  return record;
}

function seasonMetadataPath(season) {
  return path.join(CHUNK_CACHE_DIR, `season-${season}.json`);
}

function seasonDonePath(season) {
  return path.join(CHUNK_CACHE_DIR, `season-${season}.done`);
}

async function loadSeasonCache(season) {
  try {
    const raw = await fsp.readFile(seasonMetadataPath(season), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.revision === CURRENT_BOOTSTRAP_REVISION) {
      return parsed;
    }
    return null;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function writeSeasonCache({ season, weeks }) {
  if (!Number.isFinite(season) || !Array.isArray(weeks) || !weeks.length) return null;
  await ensureChunkCacheDir();
  const record = {
    season,
    weeks: Array.from(new Set(weeks)).sort((a, b) => a - b),
    revision: CURRENT_BOOTSTRAP_REVISION,
    updated_at: new Date().toISOString()
  };
  await fsp.writeFile(seasonMetadataPath(season), JSON.stringify(record, null, JSON_SPACE));
  await fsp.writeFile(seasonDonePath(season), `${record.updated_at}\n`);
  return record;
}

const MIN_SEASON = MIN_SEASON_CONSTANT;
const DEFAULT_MIN_TRAIN_SEASON = MIN_SEASON;
// GitHub Actions sets CI=true. When that flag is present we keep the bootstrap replay short
// so scheduled runs do not spend hours downloading two decades of data.
const DEFAULT_MAX_TRAIN_SEASONS = process.env.CI ? 4 : Number.POSITIVE_INFINITY;
const INJURY_DATA_MIN_SEASON = 2009;
const NEXTGEN_DATA_MIN_SEASON = 2016;

const seasonDbCache = new Map();
const seasonDataCache = new Map();

function normaliseSeason(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

const CLI_DEFAULT_STRICT_BATCH = process.env.CI ? true : false;

function parseCliArgs(argv = process.argv.slice(2)) {
  const arrayArgv = Array.isArray(argv) ? argv : [];
  const { values } = parseArgs({
    args: arrayArgv,
    options: {
      mode: { type: "string", short: "m" },
      dataRoot: { type: "string" },
      season: { type: "string" },
      week: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      artifactsDir: { type: "string" },
      strictBatch: { type: "boolean" }
    },
    allowPositionals: true,
    tokens: false,
    strict: false
  });
  return {
    mode: values.mode ?? null,
    dataRoot: values.dataRoot ?? null,
    season: values.season ?? null,
    week: values.week ?? null,
    start: values.start ?? null,
    end: values.end ?? null,
    artifactsDir: values.artifactsDir ?? null,
    strictBatch:
      typeof values.strictBatch === "boolean" ? values.strictBatch : CLI_DEFAULT_STRICT_BATCH
  };
}

function applyCliEnvOverrides({
  start,
  end,
  artifactsDir,
  mode,
  dataRoot,
  season,
  week
} = {}) {
  const assign = (key, value) => {
    if (value !== undefined && value !== null) {
      process.env[key] = String(value);
    }
  };
  assign("BATCH_START", start);
  assign("BATCH_END", end);
  assign("ARTIFACTS_DIR", artifactsDir);
  assign("MODE", mode);
  assign("TRAIN_MODE", mode);
  assign("DATA_ROOT", dataRoot);
  assign("SEASON", season);
  assign("WEEK", week);
}

function computeRequestedSeasons() {
  if (isStrictBatch()) {
    const { start, end } = getStrictBounds();
    const seasons = [];
    for (let y = start; y <= end; y += 1) seasons.push(y);
    return seasons;
  }

  const start = Number(process.env.BATCH_START || NaN);
  const end = Number(process.env.BATCH_END || NaN);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    const cur = new Date().getFullYear();
    return [cur];
  }

  const lo = Math.min(start, end);
  const hi = Math.max(start, end);

  const seasons = [];
  for (let y = lo; y <= hi; y += 1) seasons.push(y);
  return seasons;
}

export function formatBatchWindowLog({ chunkSelection, explicit }) {
  if (!chunkSelection) return null;
  const { start, end } = chunkSelection;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const label = `${start}–${end}`;
  if (explicit) {
    return `[train] Using explicit batch window: ${label}`;
  }
  return `[train] Using auto-resolved bootstrap window: ${label}`;
}

function normaliseChunkKey(entry) {
  const start = normaliseSeason(entry?.start_season ?? entry?.start ?? entry?.startSeason);
  const end = normaliseSeason(entry?.end_season ?? entry?.end ?? entry?.endSeason);
  return start !== null && end !== null ? `${start}-${end}` : null;
}

export function resolveHistoricalChunkSelection({
  uniqueSeasons = [],
  chunkSize = HISTORICAL_BATCH_SIZE,
  recordedChunks = [],
  explicitStart = null,
  explicitEnd = null,
  strictBatch = false,
  minSeason = MIN_SEASON,
  maxSeason = Number.POSITIVE_INFINITY
} = {}) {
  const seasons = Array.isArray(uniqueSeasons)
    ? Array.from(
        new Set(
          uniqueSeasons
            .map(normaliseSeason)
            .filter((season) => season !== null)
        )
      ).sort((a, b) => a - b)
    : [];
  const start = normaliseSeason(explicitStart);
  const end = normaliseSeason(explicitEnd);
  const explicit = start !== null && end !== null;
  const chunkSizeNormalised = Math.max(1, Math.min(MAX_SEASONS_PER_CHUNK, Math.floor(chunkSize)));
  const chunks = chunkSeasonList(seasons, chunkSizeNormalised);
  const completedKeys = new Set(
    Array.isArray(recordedChunks)
      ? recordedChunks.map(normaliseChunkKey).filter(Boolean)
      : []
  );
  const autoCandidate = chunks.length
    ? chunks.find((chunk) => !completedKeys.has(`${chunk.start}-${chunk.end}`)) ?? chunks[chunks.length - 1]
    : null;

  if (explicit) {
    if (start > end) {
      throw new Error(`[train] Invalid explicit batch window ${start}–${end}: start must be before end.`);
    }
    if (Number.isFinite(minSeason) && start < minSeason) {
      throw new Error(
        `[train] Explicit batch window ${start}–${end} begins before minimum supported season ${minSeason}.`
      );
    }
    if (Number.isFinite(maxSeason) && end > maxSeason) {
      throw new Error(
        `[train] Explicit batch window ${start}–${end} exceeds available historical range ending ${maxSeason}.`
      );
    }
    const expectedCount = end - start + 1;
    if (expectedCount > chunkSizeNormalised) {
      throw new Error(
        `[train] Explicit batch window ${start}–${end} spans ${expectedCount} seasons, exceeding chunk size ${chunkSizeNormalised}.`
      );
    }
    const seasonsInWindow = seasons.filter((season) => season >= start && season <= end);
    if (!seasonsInWindow.length) {
      throw new Error(`[train] Explicit batch window ${start}–${end} has no available seasons to train.`);
    }
    const seasonSet = new Set(seasonsInWindow);
    const missing = [];
    for (let season = start; season <= end; season += 1) {
      if (!seasonSet.has(season)) missing.push(season);
    }
    if (missing.length) {
      throw new Error(
        `[train] Explicit batch window ${start}–${end} missing seasons: ${missing.join(", ")}.`
      );
    }
    return {
      chunkSelection: {
        seasons: seasonsInWindow,
        start,
        end,
        source: "explicit"
      },
      explicit: true,
      autoCandidate
    };
  }

  if (autoCandidate) {
    return {
      chunkSelection: { ...autoCandidate, source: "auto" },
      explicit: false,
      autoCandidate
    };
  }

  return { chunkSelection: null, explicit: false, autoCandidate: null };
}

function chunkSeasonList(seasons, size = DEFAULT_CHUNK_SPAN) {
  if (!Array.isArray(seasons) || !seasons.length) return [];
  const chunkSize = Math.max(1, Math.min(MAX_SEASONS_PER_CHUNK, Math.floor(size)));
  const sorted = seasons
    .map(normaliseSeason)
    .filter((season) => season !== null)
    .sort((a, b) => a - b);
  const chunks = [];
  for (let i = 0; i < sorted.length; i += chunkSize) {
    const slice = sorted.slice(i, i + chunkSize);
    if (slice.length) {
      chunks.push({
        seasons: slice,
        start: slice[0],
        end: slice[slice.length - 1]
      });
    }
  }
  return chunks;
}

function cachePromise(cache, key, factory) {
  if (cache.has(key)) return cache.get(key);
  const promise = Promise.resolve().then(factory).then(
    (value) => {
      cache.set(key, Promise.resolve(value));
      return value;
    },
    (err) => {
      cache.delete(key);
      throw err;
    }
  );
  cache.set(key, promise);
  return promise;
}

async function getSeasonDB(season) {
  return cachePromise(seasonDbCache, season, () => buildSeasonDB(season));
}

function createLimiter(maxConcurrent) {
  const requested = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : 1;
  const limit = Math.max(1, Math.min(MAX_WORKERS, requested));
  let active = 0;
  const queue = [];

  const next = () => {
    if (!queue.length || active >= limit) return;
    const task = queue.shift();
    active += 1;
    Promise.resolve()
      .then(task.fn)
      .then(
        (value) => {
          active -= 1;
          task.resolve(value);
          next();
        },
        (err) => {
          active -= 1;
          task.reject(err);
          next();
        }
      );
  };

  return (fn) => {
    if (active < limit) {
      active += 1;
      return Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            active -= 1;
            next();
            return value;
          },
          (err) => {
            active -= 1;
            next();
            throw err;
          }
        );
    }

    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

const dataGapNotices = new Set();

function logDataCoverage(season) {
  if (season < 2001 && !dataGapNotices.has(`epa-${season}`)) {
    console.log(
      `[train] Season ${season}: Using basic yards fallback (EPA/play-by-play advanced features unavailable before 2001).`
    );
    dataGapNotices.add(`epa-${season}`);
  }
  if (season < INJURY_DATA_MIN_SEASON && !dataGapNotices.has(`inj-${season}`)) {
    console.log(
      `[train] Season ${season}: Injury reports unavailable; disabling injury-derived features until 2009.`
    );
    dataGapNotices.add(`inj-${season}`);
  }
  if (season < NEXTGEN_DATA_MIN_SEASON && !dataGapNotices.has(`ngs-${season}`)) {
    console.log(
      `[train] Season ${season}: Next Gen Stats not published; skipping speed/separation inputs until 2016.`
    );
    dataGapNotices.add(`ngs-${season}`);
  }
}

const envMinSeason = Number(process.env.MIN_TRAIN_SEASON);
const MIN_TRAIN_SEASON = Number.isFinite(envMinSeason)
  ? Math.min(envMinSeason, DEFAULT_MIN_TRAIN_SEASON)
  : DEFAULT_MIN_TRAIN_SEASON;

const envMaxSeasons = Number(process.env.MAX_TRAIN_SEASONS);
const MAX_TRAIN_SEASONS = Number.isFinite(envMaxSeasons) && envMaxSeasons > 0
  ? envMaxSeasons
  : DEFAULT_MAX_TRAIN_SEASONS;

const HISTORICAL_ARTIFACT_PREFIXES = [
  "predictions",
  "context",
  "explain",
  "model",
  "diagnostics",
  "bt_features"
];

function weekStamp(season, week) {
  return `${season}_W${String(week).padStart(2, "0")}`;
}

function artifactPath(prefix, season, week) {
  return path.join(ART_DIR, `${prefix}_${weekStamp(season, week)}.json`);
}

function weekArtifactsExist(season, week) {
  return HISTORICAL_ARTIFACT_PREFIXES.every((prefix) => existsSync(artifactPath(prefix, season, week)));
}

async function modelsForSeasonExist(season) {
  const seasonDir = path.join(ART_DIR, "models", String(season));
  try {
    const entries = await fsp.readdir(seasonDir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() || entry.isDirectory());
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

function ensureStatusDir() {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
}

function weekStatusPath(season, week) {
  return path.join(STATUS_DIR, `${season}-W${String(week).padStart(2, "0")}.done`);
}

function weekStatusExists(season, week) {
  return existsSync(weekStatusPath(season, week));
}

function markWeekStatus(season, week) {
  ensureStatusDir();
  fs.writeFileSync(weekStatusPath(season, week), new Date().toISOString());
}

function seasonStatusPath(season) {
  return path.join(STATUS_DIR, `${season}.done`);
}

function seasonStatusExists(season) {
  return existsSync(seasonStatusPath(season));
}

function markSeasonStatus(season) {
  ensureStatusDir();
  fs.writeFileSync(seasonStatusPath(season), new Date().toISOString());
}

function touchStrictBatchStatusIfAny() {
  if (!isStrictBatch()) return;
  const { start, end } = getStrictBounds();
  for (let s = start; s <= end; s++) {
    markSeasonStatus(s);
  }
}

function normaliseSeasonValue(entry) {
  if (entry == null) return null;
  if (Number.isFinite(entry)) return Number(entry);
  if (typeof entry === "string" && entry.trim()) {
    const parsed = Number.parseInt(entry.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof entry === "object") {
    const candidate = entry.season ?? entry.year ?? entry.season_id ?? null;
    if (Number.isFinite(candidate)) return Number(candidate);
    if (typeof candidate === "string") {
      const parsed = Number.parseInt(candidate, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function markSeasonStatusBatch(entries) {
  const seasons = new Set();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const season = normaliseSeasonValue(entry);
      if (Number.isFinite(season)) {
        seasons.add(season);
      }
    }
  }

  const requestedSeasons = computeRequestedSeasons();
  if (Array.isArray(requestedSeasons)) {
    for (const requested of requestedSeasons) {
      if (Number.isFinite(requested)) {
        seasons.add(requested);
      }
    }
  }

  let seasonList = Array.from(seasons);
  if (isStrictBatch()) {
    seasonList = clampSeasonsToStrictBounds(seasonList);
  }
  if (!seasonList.length) return;
  trace("season-status:markBatch", { seasons: seasonList });
  for (const season of seasonList) {
    markSeasonStatus(season);
  }
}

function filterCoverageEntries(entries = []) {
  if (!isStrictBatch()) return entries;
  const normalised = Array.isArray(entries)
    ? entries
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const season = normaliseSeasonValue(entry);
          if (!Number.isFinite(season)) return null;
          const weeks = Array.isArray(entry.weeks)
            ? entry.weeks
                .map((wk) => Number.parseInt(wk, 10))
                .filter((wk) => Number.isFinite(wk))
                .sort((a, b) => a - b)
            : [];
          return { ...entry, season, weeks };
        })
        .filter(Boolean)
    : [];
  if (!normalised.length) return [];
  const allowed = new Set(clampSeasonsToStrictBounds(normalised.map((entry) => entry.season)));
  if (!allowed.size) return [];
  return normalised.filter((entry) => allowed.has(entry.season));
}

function envFlag(name) {
  const value = process.env[name];
  if (value == null) return false;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function shouldRewriteHistorical() {
  const keys = [
    "REWRITE_HISTORICAL",
    "OVERWRITE_HISTORICAL",
    "REBUILD_HISTORICAL",
    "REGENERATE_HISTORICAL",
    "REGEN_HISTORICAL"
  ];
  return keys.some((key) => envFlag(key));
}

const FAST_MODE = CI_FAST || /^true$/i.test(String(process.env.CI ?? ""));
const DEFAULT_FETCH_CONCURRENCY = CI_FAST ? 2 : 4;
const DATA_FETCH_CONCURRENCY = Math.max(
  1,
  Math.min(
    MAX_WORKERS,
    Number.isFinite(Number(process.env.DATA_FETCH_CONCURRENCY))
      ? Math.max(1, Number(process.env.DATA_FETCH_CONCURRENCY))
      : DEFAULT_FETCH_CONCURRENCY
  )
);
const SEASON_BUILD_CONCURRENCY = Math.max(1, Math.min(MAX_WORKERS, CI_FAST ? 2 : 4));
const WEEK_TASK_CONCURRENCY = Math.max(1, Math.min(MAX_WORKERS, CI_FAST ? 2 : 4));

function loadModelParamsFile() {
  try {
    const raw = readFileSync(MODEL_PARAMS_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      warn(`[train] unable to read model params: ${err?.message || err}`);
    }
    return {};
  }
}

function deepMerge(target, source) {
  if (typeof target !== "object" || target === null) return source;
  if (typeof source !== "object" || source === null) return target;
  const out = Array.isArray(target) ? target.slice() : { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = deepMerge(out[key] ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function persistModelParams(updates = {}) {
  const current = loadModelParamsFile();
  const merged = deepMerge(current, updates);
  try {
    await fsp.writeFile(MODEL_PARAMS_PATH, JSON.stringify(merged, null, JSON_SPACE));
  } catch (err) {
    warn(`[train] unable to persist model params: ${err?.message || err}`);
  }
}

const toFiniteNumber = (value, fallback = 0.5) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const safeProb = (value) => {
  const num = toFiniteNumber(value, 0.5);
  if (!Number.isFinite(num)) return 0.5;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
};

const round3 = (x, fallback = 0.5) => {
  const num = toFiniteNumber(x, fallback);
  return Math.round(num * 1000) / 1000;
};

function matrixFromRows(rows, keys) {
  return rows.map((row) => keys.map((k) => Number(row[k] ?? 0)));
}

function fitScaler(X) {
  const d = X[0]?.length || 0;
  const mu = new Array(d).fill(0);
  const sd = new Array(d).fill(1);
  const n = Math.max(1, X.length);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < X.length; i++) s += X[i][j];
    mu[j] = s / n;
  }
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < X.length; i++) {
      const v = X[i][j] - mu[j];
      s += v * v;
    }
    sd[j] = Math.sqrt(s / n) || 1;
  }
  return { mu, sd };
}

function applyScaler(X, scaler) {
  if (!scaler) return X.map((row) => row.slice());
  const { mu, sd } = scaler;
  return X.map((row) => row.map((v, j) => (v - mu[j]) / (sd[j] || 1)));
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function trainLogisticGD(
  X,
  y,
  { steps = 3000, lr = 5e-3, l2 = 2e-4, featureLength, init } = {}
) {
  const n = X.length;
  const observedDim = X[0]?.length || 0;
  const dim = Number.isInteger(featureLength) && featureLength > 0 ? featureLength : observedDim;
  let w = new Array(dim).fill(0);
  let b = 0;
  if (init && Array.isArray(init.w)) {
    for (let j = 0; j < dim; j++) {
      const val = Number(init.w[j]);
      w[j] = Number.isFinite(val) ? val : 0;
    }
  }
  const initBias = init?.b ?? init?.bias;
  const initBiasNum = Number(initBias);
  if (Number.isFinite(initBiasNum)) {
    b = initBiasNum;
  }
  if (!n || !observedDim || !dim) return { w, b, neutral: true };
  for (let t = 0; t < steps; t++) {
    let gb = 0;
    const gw = new Array(dim).fill(0);
    for (let i = 0; i < n; i++) {
      const row = X[i] || [];
      let z = b;
      for (let j = 0; j < dim; j++) {
        const weight = w[j];
        const feature = Number(row[j] ?? 0);
        if (!Number.isFinite(weight) || !Number.isFinite(feature)) continue;
        z += weight * feature;
      }
      if (!Number.isFinite(z)) continue;
      const p = sigmoid(z);
      const err = p - y[i];
      gb += err;
      for (let j = 0; j < dim; j++) {
        const feature = Number(row[j] ?? 0);
        if (!Number.isFinite(feature)) continue;
        gw[j] += err * feature;
      }
    }
    gb /= Math.max(1, n);
    if (!Number.isFinite(gb)) gb = 0;
    for (let j = 0; j < dim; j++) {
      const grad = gw[j] / Math.max(1, n) + l2 * w[j];
      gw[j] = Number.isFinite(grad) ? grad : 0;
    }
    b -= lr * gb;
    if (!Number.isFinite(b)) b = 0;
    for (let j = 0; j < dim; j++) {
      w[j] -= lr * gw[j];
      if (!Number.isFinite(w[j])) w[j] = 0;
    }
  }
  return { w, b };
}

const predictLogit = (X, model = {}) => {
  const weights = Array.isArray(model.w) ? model.w : [];
  const bias = toFiniteNumber(model.b, 0);
  const dim = weights.length;
  if (!dim || model.neutral) return X.map(() => 0.5);
  return X.map((row = []) => {
    let z = bias;
    for (let j = 0; j < dim; j++) {
      const weight = toFiniteNumber(weights[j], 0);
      const feature = Number(row[j] ?? 0);
      if (!Number.isFinite(feature)) continue;
      z += weight * feature;
    }
    if (!Number.isFinite(z)) return 0.5;
    const prob = sigmoid(z);
    return Number.isFinite(prob) ? prob : 0.5;
  });
};

function leafPath(root, x) {
  let node = root;
  let path = "";
  for (let guard = 0; guard < 256; guard++) {
    if (!node) return path || "ROOT";
    if (!node.left && !node.right) return path || "ROOT";
    const col = node.splitColumn ?? node.attribute ?? node.index ?? node.feature;
    const thr = node.splitValue ?? node.threshold ?? node.split;
    if (col == null || thr == null) return path || "ROOT";
    const val = Number(x[col] ?? 0);
    const goLeft = val <= Number(thr);
    path += goLeft ? "L" : "R";
    node = goLeft ? node.left : node.right;
  }
  return path || "ROOT";
}

function buildLeafFreq(cart, Xtr, ytr, alpha) {
  let json;
  try {
    json = cart.toJSON();
  } catch (e) {
    json = null;
  }
  const root = json?.root || json;
  const freq = new Map();
  if (!root) {
    const n1 = ytr.reduce((s, v) => s + (v ? 1 : 0), 0);
    const n0 = ytr.length - n1;
    freq.set("ROOT", { n0, n1, alpha });
    return { root: null, freq, alpha };
  }
  for (let i = 0; i < Xtr.length; i++) {
    const p = leafPath(root, Xtr[i]);
    const rec = freq.get(p) || { n0: 0, n1: 0, alpha };
    if (ytr[i] === 1) rec.n1 += 1;
    else rec.n0 += 1;
    freq.set(p, rec);
  }
  return { root, freq, alpha };
}

function predictTree(cart, leafStats, X) {
  const { root, freq, alpha } = leafStats;
  if (!root) {
    const rec = freq.get("ROOT") || { n0: 0, n1: 0, alpha: 4 };
    const tot = rec.n0 + rec.n1;
    const p1 = (rec.n1 + rec.alpha) / (tot + 2 * rec.alpha);
    return X.map(() => p1);
  }
  return X.map((x) => {
    const path = leafPath(root, x);
    const rec = freq.get(path);
    if (!rec) return 0.5;
    const tot = rec.n0 + rec.n1;
    return (rec.n1 + alpha) / (tot + 2 * alpha);
  });
}

function chooseTreeParams(n) {
  const depth = Math.min(6, Math.max(3, Math.floor(2 + Math.log2(Math.max(16, n || 1)))));
  const minSamples = Math.min(32, Math.max(8, Math.floor(Math.max(8, (n || 1) / 18))));
  return { depth, minSamples };
}

function laplaceAlpha(n) {
  const approxWeeks = Math.max(2, Math.min(8, Math.round((n || 1) / 32)));
  return Math.max(2, Math.round(10 - 2 * approxWeeks));
}

function computeFeatureHash(features, extra = {}) {
  const payload = {
    version: 1,
    features: Array.isArray(features) ? [...features] : [],
    extra
  };
  const hash = crypto.createHash("sha1");
  hash.update(JSON.stringify(payload));
  return hash.digest("hex");
}

function kfoldIndices(n, k) {
  if (n <= 1) return [[...Array(n).keys()]];
  const folds = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) {
    folds[i % k].push(i);
  }
  return folds;
}

const ANN_EPOCH_OPTIONS = [100, 200, 300, 400, 500];
const ANN_DROPOUT_OPTIONS = [0.2, 0.35, 0.5];
const BT_LR_OPTIONS = [1e-3, 2.5e-3, 5e-3, 1e-2];
const BT_L2_OPTIONS = [1e-5, 5e-5, 1e-4, 1e-3];

async function tuneAnnHyperparams(trainStd, labels, folds, options = {}) {
  if (CI_FAST) return null;
  if (!Array.isArray(folds) || !folds.length || !trainStd?.length) return null;
  const seeds = Math.max(2, Math.min(options.annSeeds ?? 5, 5));
  let best = null;
  for (const epochs of ANN_EPOCH_OPTIONS) {
    for (const dropout of ANN_DROPOUT_OPTIONS) {
      const losses = [];
      for (const valIdx of folds) {
        const trainIdx = new Set(Array.from({ length: trainStd.length }, (_, i) => i).filter((i) => !valIdx.includes(i)));
        const Xtr = [];
        const ytr = [];
        const Xva = [];
        const yva = [];
        for (let i = 0; i < trainStd.length; i++) {
          if (trainIdx.has(i)) {
            Xtr.push(trainStd[i]);
            ytr.push(labels[i]);
          } else {
            Xva.push(trainStd[i]);
            yva.push(labels[i]);
          }
        }
        if (!Xtr.length || !Xva.length) continue;
        const model = trainANNCommittee(Xtr, ytr, {
          seeds: Math.min(seeds, 3),
          maxEpochs: epochs,
          dropout,
          lr: 1e-3,
          patience: 8,
          batchSize: options.annBatchSize ?? 32,
          l2: options.annL2 ?? 1e-4,
          timeLimitMs: options.annTuningTimeLimit ?? 20000,
          architecture: options.annArchitecture
        });
        const preds = predictANNCommittee(model, Xva);
        const loss = logLoss(yva, preds);
        if (Number.isFinite(loss)) losses.push(loss);
      }
      if (!losses.length) continue;
      const avg = losses.reduce((a, b) => a + b, 0) / losses.length;
      if (!best || avg < best.loss) {
        best = { loss: avg, epochs, dropout };
      }
    }
  }
  if (best) {
    await persistModelParams({ ann: { maxEpochs: best.epochs, dropout: best.dropout } });
  }
  return best;
}

async function tuneBTHyperparams(btTrainRows, folds, baseSteps) {
  if (CI_FAST) return null;
  if (!Array.isArray(folds) || !folds.length || !btTrainRows?.length) return null;
  let best = null;
  for (const lr of BT_LR_OPTIONS) {
    for (const l2 of BT_L2_OPTIONS) {
      const losses = [];
      for (const valIdx of folds) {
        const trainIdx = new Set(Array.from({ length: btTrainRows.length }, (_, i) => i).filter((i) => !valIdx.includes(i)));
        const trainSubset = [];
        const valSubset = [];
        for (let i = 0; i < btTrainRows.length; i++) {
          if (trainIdx.has(i)) trainSubset.push(btTrainRows[i]);
          else valSubset.push(btTrainRows[i]);
        }
        if (!trainSubset.length || !valSubset.length) continue;
        const model = trainBTModel(trainSubset, { steps: baseSteps, lr, l2 });
        const preds = predictBTDeterministic(model, valSubset).map((p) => safeProb(p?.prob));
        const labels = valSubset.map((r) => Number(r.label_win));
        const loss = logLoss(labels, preds);
        if (Number.isFinite(loss)) losses.push(loss);
      }
      if (!losses.length) continue;
      const avg = losses.reduce((a, b) => a + b, 0) / losses.length;
      if (!best || avg < best.loss) {
        best = { loss: avg, lr, l2 };
      }
    }
  }
  if (best) {
    await persistModelParams({ bt: { gd: { learningRate: best.lr, l2: best.l2 } } });
  }
  return best;
}

function enumerateWeights(step = 0.05) {
  const stepSize = Math.max(step, ANN_CONFIG.weightStep ?? step);
  const weights = [];
  for (let wl = 0; wl <= 1; wl += stepSize) {
    for (let wt = 0; wt <= 1 - wl; wt += stepSize) {
      for (let wb = 0; wb <= 1 - wl - wt; wb += stepSize) {
        const wa = 1 - wl - wt - wb;
        if (wa < -1e-9) continue;
        weights.push({ logistic: wl, tree: wt, bt: wb, ann: wa });
      }
    }
  }
  return weights;
}

function clampWeights(weights, weeks) {
  const w = { ...weights };
  if (weeks < 4) w.ann *= 0.5;
  if (weeks < 3) w.logistic *= 0.8;
  const total = w.logistic + w.tree + w.bt + w.ann;
  if (!total) return { logistic: 0.25, tree: 0.25, bt: 0.25, ann: 0.25 };
  return {
    logistic: w.logistic / total,
    tree: w.tree / total,
    bt: w.bt / total,
    ann: w.ann / total
  };
}

function computePCA(X, featureNames, top = 5) {
  if (!X?.length) return [];
  try {
    const mat = new Matrix(X);
    const svd = new SVD(mat, { computeLeftSingularVectors: false, autoTranspose: true });
    const V = svd.rightSingularVectors;
    const diag = svd.diagonal;
    const total = diag.reduce((s, v) => s + v * v, 0) || 1;
    const comps = [];
    for (let i = 0; i < Math.min(top, diag.length); i++) {
      const vec = V.getColumn(i);
      const loadings = featureNames.map((f, idx) => ({ feature: f, loading: vec[idx] }));
      loadings.sort((a, b) => Math.abs(b.loading) - Math.abs(a.loading));
      comps.push({
        component: i + 1,
        explained_variance: (diag[i] * diag[i]) / total,
        top_loadings: loadings.slice(0, 10)
      });
    }
    return comps;
  } catch (e) {
    return [];
  }
}

const FEATURE_LABELS = {
  off_turnovers_s2d: "offensive turnovers",
  def_turnovers_s2d: "defensive takeaways",
  off_total_yds_s2d: "offense yards",
  def_total_yds_s2d: "yards allowed",
  rest_diff: "rest advantage",
  off_third_down_pct_s2d: "3rd-down conversion rate",
  off_red_zone_td_pct_s2d: "red-zone TD rate",
  off_sack_rate_s2d: "sack rate",
  off_neutral_pass_rate_s2d: "neutral pass rate",
  off_third_down_pct_s2d_minus_opp: "3rd-down rate vs opp",
  off_red_zone_td_pct_s2d_minus_opp: "red-zone TD rate vs opp",
  off_sack_rate_s2d_minus_opp: "sack rate vs opp",
  off_neutral_pass_rate_s2d_minus_opp: "neutral pass rate vs opp",
  diff_total_yards: "total yards differential",
  diff_penalty_yards: "penalty yards differential",
  diff_turnovers: "turnover differential",
  diff_possession_seconds: "possession differential",
  diff_r_ratio: "r-ratio differential",
  diff_elo_pre: "Elo differential",
  off_epa_per_play_s2d: "offensive EPA/play (S2D)",
  off_epa_per_play_w3: "offensive EPA/play (3wk)",
  off_epa_per_play_w5: "offensive EPA/play (5wk)",
  off_epa_per_play_exp: "offensive EPA/play (exp)",
  off_success_rate_s2d: "offensive success rate (S2D)",
  off_success_rate_w3: "offensive success rate (3wk)",
  off_success_rate_w5: "offensive success rate (5wk)",
  off_success_rate_exp: "offensive success rate (exp)",
  def_epa_per_play_allowed_s2d: "defensive EPA/play allowed (S2D)",
  def_epa_per_play_allowed_w3: "defensive EPA/play allowed (3wk)",
  def_epa_per_play_allowed_w5: "defensive EPA/play allowed (5wk)",
  def_epa_per_play_allowed_exp: "defensive EPA/play allowed (exp)",
  def_success_rate_allowed_s2d: "defensive success rate allowed (S2D)",
  def_success_rate_allowed_w3: "defensive success rate allowed (3wk)",
  def_success_rate_allowed_w5: "defensive success rate allowed (5wk)",
  def_success_rate_allowed_exp: "defensive success rate allowed (exp)",
  rb_rush_share_s2d: "RB rush share (S2D)",
  rb_rush_share_w3: "RB rush share (3wk)",
  rb_rush_share_w5: "RB rush share (5wk)",
  rb_rush_share_exp: "RB rush share (exp)",
  wr_target_share_s2d: "WR target share (S2D)",
  wr_target_share_w3: "WR target share (3wk)",
  wr_target_share_w5: "WR target share (5wk)",
  wr_target_share_exp: "WR target share (exp)",
  te_target_share_s2d: "TE target share (S2D)",
  te_target_share_w3: "TE target share (3wk)",
  te_target_share_w5: "TE target share (5wk)",
  te_target_share_exp: "TE target share (exp)",
  qb_aypa_s2d: "QB air yards per attempt (S2D)",
  qb_aypa_w3: "QB air yards per attempt (3wk)",
  qb_aypa_w5: "QB air yards per attempt (5wk)",
  qb_aypa_exp: "QB air yards per attempt (exp)",
  qb_sack_rate_s2d: "QB sack rate (S2D)",
  qb_sack_rate_w3: "QB sack rate (3wk)",
  qb_sack_rate_w5: "QB sack rate (5wk)",
  qb_sack_rate_exp: "QB sack rate (exp)",
  roof_dome: "Dome roof flag",
  roof_outdoor: "Outdoor roof flag",
  weather_temp_f: "Forecast temperature (°F)",
  weather_wind_mph: "Forecast wind (mph)",
  weather_precip_pct: "Precipitation chance (%)",
  weather_impact_score: "Weather impact score",
  weather_extreme_flag: "Weather extreme flag"
};

function humanizeFeature(key) {
  return FEATURE_LABELS[key] || key;
}

const gamesPlayed = (row) => Math.max(1, Number(row.wins_s2d ?? 0) + Number(row.losses_s2d ?? 0));

function computeLeagueMeans(rows) {
  if (!rows?.length) return {};
  const sums = {
    off_total_yds_pg: 0,
    off_turnovers_pg: 0,
    off_third_down_pct_s2d: 0,
    off_red_zone_td_pct_s2d: 0,
    off_sack_rate_s2d: 0,
    off_neutral_pass_rate_s2d: 0
  };
  let count = 0;
  for (const row of rows) {
    const gp = gamesPlayed(row);
    sums.off_total_yds_pg += Number(row.off_total_yds_s2d ?? 0) / gp;
    sums.off_turnovers_pg += Number(row.off_turnovers_s2d ?? 0) / gp;
    sums.off_third_down_pct_s2d += Number(row.off_third_down_pct_s2d ?? 0);
    sums.off_red_zone_td_pct_s2d += Number(row.off_red_zone_td_pct_s2d ?? 0);
    sums.off_sack_rate_s2d += Number(row.off_sack_rate_s2d ?? 0);
    sums.off_neutral_pass_rate_s2d += Number(row.off_neutral_pass_rate_s2d ?? 0);
    count += 1;
  }
  if (!count) return {};
  return Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, v / count]));
}

function describeRateDeviation(value, baseline, label, higherIsGood, threshold = 0.03) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return null;
  const diff = value - baseline;
  if (Math.abs(diff) < threshold) return null;
  const direction = diff > 0 ? "higher" : "lower";
  const diffPct = Math.abs(diff) * 100;
  const sentiment = diff > 0 === higherIsGood ? "favorable" : "needs attention";
  return `${label} is ${direction} than league average by ${diffPct.toFixed(1)}% (${sentiment}).`;
}

function describeNeutralPassRate(value, baseline, threshold = 0.05) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return null;
  const diff = value - baseline;
  if (Math.abs(diff) < threshold) return null;
  const orientation = diff > 0 ? "pass-heavy" : "run-leaning";
  const direction = diff > 0 ? "above" : "below";
  const diffPct = Math.abs(diff) * 100;
  return `Neutral pass rate is ${diffPct.toFixed(1)}% ${direction} league average (${orientation}).`;
}

function describeDiff(value, label, goodHigh = true, unit = "") {
  const diff = Number(value || 0);
  const sign = diff > 0 ? "+" : diff < 0 ? "" : "±";
  const absVal = Math.abs(diff).toFixed(2);
  const direction = diff === 0 ? "even" : diff > 0 ? "edge" : "deficit";
  const framing = diff === 0 ? "balanced" : diff > 0 === goodHigh ? "favorable" : "needs attention";
  const suffix = unit ? `${absVal}${unit}` : absVal;
  return `${label} ${direction} ${sign}${suffix} (${framing})`;
}

function buildNarrative(game, probs, btFeatures, row, leagueMeans) {
  const items = [
    { key: "diff_turnovers", label: "Turnovers", goodHigh: true },
    { key: "diff_r_ratio", label: "R-ratio", goodHigh: true },
    { key: "diff_penalty_yards", label: "Penalty yards", goodHigh: false },
    { key: "diff_total_yards", label: "Total yards", goodHigh: true },
    { key: "diff_possession_seconds", label: "Possession time", goodHigh: true },
    { key: "diff_elo_pre", label: "Elo edge", goodHigh: true }
  ];
  items.sort((a, b) => Math.abs(btFeatures[b.key] ?? 0) - Math.abs(btFeatures[a.key] ?? 0));
  const diffClauses = items
    .slice(0, 3)
    .map((item) => describeDiff(btFeatures[item.key], item.label, item.goodHigh));

  const advClauses = [];
  const league = leagueMeans || {};
  const third = Number(row.off_third_down_pct_s2d ?? 0);
  const red = Number(row.off_red_zone_td_pct_s2d ?? 0);
  const sackRate = Number(row.off_sack_rate_s2d ?? 0);
  const neutralPass = Number(row.off_neutral_pass_rate_s2d ?? 0);
  const thirdStmt = describeRateDeviation(third, league.off_third_down_pct_s2d, "Offensive 3rd-down conversion", true, 0.03);
  if (thirdStmt) advClauses.push(thirdStmt);
  const redStmt = describeRateDeviation(red, league.off_red_zone_td_pct_s2d, "Red-zone TD rate", true, 0.03);
  if (redStmt) advClauses.push(redStmt);
  const sackStmt = describeRateDeviation(sackRate, league.off_sack_rate_s2d, "Sack rate", false, 0.015);
  if (sackStmt) advClauses.push(sackStmt);
  const neutralStmt = describeNeutralPassRate(neutralPass, league.off_neutral_pass_rate_s2d, 0.05);
  if (neutralStmt) advClauses.push(neutralStmt);

  const header = `${game.home_team} vs ${game.away_team}: logistic ${round3(probs.logistic * 100)}%, tree ${round3(probs.tree * 100)}%, BT ${round3(probs.bt * 100)}%, ANN ${round3(probs.ann * 100)}%, blended ${round3(probs.blended * 100)}%.`;
  const sections = [];
  if (diffClauses.length) sections.push(`Key differentials: ${diffClauses.join("; ")}.`);
  if (advClauses.length) sections.push(`Trend watch: ${advClauses.join(" ")}`);
  return `${header} ${sections.join(" ")}`.trim();
}

function buildTopDrivers({ logisticContribs, treeInfo, btContribs, annGrad }) {
  const drivers = [];
  logisticContribs
    .map((v) => ({ feature: humanizeFeature(v.feature), direction: v.value >= 0 ? "positive" : "negative", magnitude: Math.abs(v.value), source: "logit" }))
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 3)
    .forEach((d) => drivers.push(d));
  if (treeInfo) {
    drivers.push({
      feature: `CART leaf ${treeInfo.path}`,
      direction: treeInfo.winrate >= 0.5 ? "positive" : "negative",
      magnitude: Math.abs(treeInfo.winrate - 0.5),
      source: "tree"
    });
  }
  btContribs
    .map((v) => ({ feature: humanizeFeature(v.feature), direction: v.value >= 0 ? "positive" : "negative", magnitude: Math.abs(v.value), source: "bt" }))
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 2)
    .forEach((d) => drivers.push(d));
  annGrad
    .map((v) => ({ feature: humanizeFeature(v.feature), direction: v.value >= 0 ? "positive" : "negative", magnitude: Math.abs(v.value), source: "ann" }))
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 2)
    .forEach((d) => drivers.push(d));
  return drivers;
}

function defaultWeights() {
  return { logistic: 0.25, tree: 0.25, bt: 0.25, ann: 0.25 };
}

function ensureArray(arr, len, fill = 0.5) {
  if (arr.length === len) return arr;
  const out = new Array(len).fill(fill);
  for (let i = 0; i < Math.min(len, arr.length); i++) out[i] = arr[i];
  return out;
}

const makeGameId = (row) =>
  `${row.season}-W${String(row.week).padStart(2, "0")}-${row.team}-${row.opponent}`;

const normalizeTeamCode = (value) => {
  if (!value) return null;
  const str = String(value).trim().toUpperCase();
  if (str.length < 2) return null;
  return /^[A-Z]{2,4}$/.test(str) ? str : null;
};

const parseGameIdTeams = (gameId) => {
  if (!gameId) return { home: null, away: null };
  const parts = String(gameId).split("-");
  if (parts.length >= 4) {
    return { home: parts[2], away: parts[3] };
  }
  return { home: null, away: null };
};

const resolveTeamCode = (primary, fallback, gameId, role) => {
  const normalizedPrimary = normalizeTeamCode(primary);
  if (normalizedPrimary) return normalizedPrimary;

  const normalizedFallback = normalizeTeamCode(fallback);
  if (normalizedFallback) {
    if (primary != null && String(primary).trim() !== "" && String(primary).trim().toUpperCase() !== normalizedFallback) {
      warn(
        `[train] Normalized ${role} team code for ${gameId} from "${String(primary).trim()}" to "${normalizedFallback}".`
      );
    }
    return normalizedFallback;
  }

  warn(`[train] Unable to resolve ${role} team code for ${gameId}; defaulting to "UNK".`);
  return "UNK";
};

const isRegularSeason = (value) => {
  if (value == null) return true;
  const str = String(value).trim().toUpperCase();
  return str === "" || str.startsWith("REG");
};

const scheduleGameId = (season, week, home, away) =>
  `${season}-W${String(week).padStart(2, "0")}-${home}-${away}`;

const parseScore = (value) => {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
};

const scheduleScores = (game) => {
  const hs = parseScore(game.home_score ?? game.home_points ?? game.home_pts);
  const as = parseScore(game.away_score ?? game.away_points ?? game.away_pts);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
  return { hs, as };
};

const metricBlock = (actuals, preds) => ({
  logloss: logLoss(actuals, preds),
  brier: brier(actuals, preds),
  auc: aucRoc(actuals, preds),
  accuracy: accuracy(actuals, preds),
  n: preds.length
});

function expandFeats(baseFeats, sampleRows){
  const extra = new Set();
  for(const r of sampleRows){
    for(const k of Object.keys(r)){
      if(k.startsWith('diff_')) extra.add(k);
      // If you also want raw home_/away_ advanced keys, uncomment:
      // if(k.startsWith('home_') || k.startsWith('away_')) extra.add(k);
    }
  }
  return Array.from(new Set([...baseFeats, ...Array.from(extra)]));
}

export async function runTraining({ season, week, data = {}, options = {} } = {}) {
  const resolvedSeason = Number(season ?? process.env.SEASON ?? new Date().getFullYear());
  let resolvedWeek = Number(week ?? process.env.WEEK ?? 6);
  if (!Number.isFinite(resolvedWeek)) resolvedWeek = 6;

  const availability = data.availability && typeof data.availability === "object"
    ? data.availability
    : {};
  const defaultSkipSeasonDB =
    resolvedSeason < NEXTGEN_DATA_MIN_SEASON || availability.nextGen === false;
  const skipSeasonDB =
    options.skipSeasonDB != null ? Boolean(options.skipSeasonDB) : defaultSkipSeasonDB;
  const DB = skipSeasonDB ? null : await getSeasonDB(resolvedSeason);

  const historicalFeatureRows = Array.isArray(options?.historical?.featureRows)
    ? options.historical.featureRows
    : [];
  const historicalBTRows = Array.isArray(options?.historical?.btRows)
    ? options.historical.btRows
    : [];
  const annWarmStart = options?.annWarmStart ?? null;

  const schedules = data.schedules ?? (await loadSchedules(resolvedSeason));
  const teamWeekly = data.teamWeekly ?? (await loadTeamWeekly(resolvedSeason));
  let teamGame;
  if (data.teamGame !== undefined) {
    teamGame = data.teamGame;
  } else {
    try {
      teamGame = await loadTeamGameAdvanced(resolvedSeason);
    } catch (e) {
      teamGame = [];
    }
  }
  let prevTeamWeekly;
  if (data.prevTeamWeekly !== undefined) {
    prevTeamWeekly = data.prevTeamWeekly;
  } else {
    const prevSeason = resolvedSeason - 1;
    if (prevSeason >= MIN_TRAIN_SEASON) {
      try {
        prevTeamWeekly = await loadTeamWeekly(prevSeason);
      } catch (e) {
        prevTeamWeekly = [];
      }
    } else {
      prevTeamWeekly = [];
    }
  }

  let pbpData;
  if (data.pbp !== undefined) {
    pbpData = data.pbp;
  } else {
    try {
      pbpData = await loadPBP(resolvedSeason);
    } catch (e) {
      pbpData = [];
    }
  }

  let playerWeekly;
  if (data.playerWeekly !== undefined) {
    playerWeekly = data.playerWeekly;
  } else {
    try {
      playerWeekly = await loadPlayerWeekly(resolvedSeason);
    } catch (e) {
      playerWeekly = [];
    }
  }

  let weatherRows;
  if (data.weather !== undefined) {
    weatherRows = data.weather;
  } else {
    try {
      weatherRows = await loadWeather(resolvedSeason);
    } catch (e) {
      weatherRows = [];
    }
  }

  const injuriesEnabled =
    availability.injuries !== false && resolvedSeason >= INJURY_DATA_MIN_SEASON;
  let injuryRows;
  if (data.injuries !== undefined) {
    injuryRows = injuriesEnabled ? data.injuries : [];
  } else if (!injuriesEnabled) {
    injuryRows = [];
  } else {
    try {
      injuryRows = await loadInjuries(resolvedSeason);
    } catch (e) {
      injuryRows = [];
    }
  }

  const featureRows = buildFeatures({
    teamWeekly,
    teamGame,
    schedules,
    season: resolvedSeason,
    prevTeamWeekly,
    pbp: pbpData,
    playerWeekly,
    weather: weatherRows,
    injuries: injuryRows
  });
  const btRows = buildBTFeatures({
    teamWeekly,
    teamGame,
    schedules,
    season: resolvedSeason,
    prevTeamWeekly,
    injuries: injuryRows
  });

  const targetWindow = { season: resolvedSeason, week: resolvedWeek };
  const featureRowsChrono = sortChronologically(featureRows);
  const historicalFeatureRowsChrono = sortChronologically(historicalFeatureRows);
  const btRowsChrono = sortChronologically(btRows);
  const historicalBTRowsChrono = sortChronologically(historicalBTRows);

  // --- Enrich feature rows with PFR advanced weekly differentials ---
  if (DB) {
    for (const r of featureRows) {
      // r.team is home team for home=1 rows in your pipeline
      if (r.home === 1) {
        attachAdvWeeklyDiff(DB, r, r.week, r.team, r.opponent);
      } else {
        // away rows exist in featureRows too; safe to enrich anyway:
        attachAdvWeeklyDiff(DB, r, r.week, r.opponent, r.team);
      }
    }
  }

  // Determine the final FEATS list (union of base + discovered diff_*):
  const FEATS_ENR = expandFeats(FEATS_BASE, featureRows.concat(historicalFeatureRows));

  const warmStart = await loadLogisticWarmStart({ season: resolvedSeason, week: resolvedWeek, features: FEATS_ENR });
  if (warmStart?.meta) {
    const { season: srcSeason, week: srcWeek, matchedFeatures, totalFeatures } = warmStart.meta;
    const paddedWeek = String(srcWeek).padStart(2, "0");
    console.log(
      `[train] Warm-starting logistic regression from season ${srcSeason} week ${paddedWeek} (${matchedFeatures}/${totalFeatures} features aligned).`
    );
  }

  const btTrainRowsRaw = btRowsChrono.filter(
    (r) => (r.label_win === 0 || r.label_win === 1) && isBefore(targetWindow, r)
  );
  const historicalBtTrainRows = historicalBTRowsChrono.filter(
    (r) => (r.label_win === 0 || r.label_win === 1) && isBefore(targetWindow, r)
  );
  const btTestRowsRaw = btRowsChrono.filter(
    (r) => Number(r.season) === resolvedSeason && Number(r.week) === resolvedWeek
  );

  const btTrainMap = new Map(btTrainRowsRaw.map((r) => [r.game_id, r]));
  const btTestMap = new Map(btTestRowsRaw.map((r) => [r.game_id, r]));

  const historicalBtTrainMap = new Map(historicalBtTrainRows.map((r) => [r.game_id, r]));

  const trainRowsRaw = featureRowsChrono.filter(
    (r) => r.home === 1 && (r.win === 0 || r.win === 1) && isBefore(targetWindow, r)
  );
  const historicalTrainRowsRaw = historicalFeatureRowsChrono.filter(
    (r) => r.home === 1 && (r.win === 0 || r.win === 1) && isBefore(targetWindow, r)
  );
  const testRowsRaw = featureRowsChrono.filter(
    (r) => r.home === 1 && Number(r.season) === resolvedSeason && Number(r.week) === resolvedWeek
  );

  const historicalTrainGames = historicalTrainRowsRaw
    .map((row) => ({ row, bt: historicalBtTrainMap.get(makeGameId(row)) }))
    .filter((g) => g.bt);

  const currentTrainGames = trainRowsRaw
    .map((row) => ({ row, bt: btTrainMap.get(makeGameId(row)) }))
    .filter((g) => g.bt);
  const testGames = testRowsRaw
    .map((row) => ({ row, bt: btTestMap.get(makeGameId(row)) }))
    .filter((g) => g.bt);

  const mergedTrainGames = historicalTrainGames.concat(currentTrainGames);
  mergedTrainGames.sort((a, b) => {
    if (a.row.season === b.row.season) return a.row.week - b.row.week;
    return a.row.season - b.row.season;
  });

  const trainRows = mergedTrainGames.map((g) => g.row);
  const btTrainRows = mergedTrainGames.map((g) => g.bt);
  const testRows = testGames.map((g) => g.row);
  const btTestRows = testGames.map((g) => g.bt);

  const featureHash = computeFeatureHash(FEATS_ENR, {
    trainCount: trainRowsRaw.length + historicalTrainRowsRaw.length,
    testCount: testRowsRaw.length
  });
  const retrainRequired = await shouldRetrain({
    season: resolvedSeason,
    week: resolvedWeek,
    featureHash
  });
  if (!retrainRequired) {
    return {
      season: resolvedSeason,
      week: resolvedWeek,
      featureHash,
      schedules,
      skipped: true
    };
  }

  const leagueMeans = computeLeagueMeans(trainRows);

  const labels = trainRows.map((r) => Number(r.win));
  const weeksSeen = new Set(trainRows.map((r) => r.week)).size;
  const trainMatrix = matrixFromRows(trainRows, FEATS_ENR);
  const scaler = fitScaler(trainMatrix.length ? trainMatrix : [new Array(FEATS_ENR.length).fill(0)]);
  const trainStd = applyScaler(trainMatrix, scaler);

  const nTrain = trainRows.length;
  let folds = [];
  let oofLogit = [];
  let oofTree = [];
  if (nTrain >= 2) {
    const baseK = Math.min(5, Math.max(2, Math.floor(nTrain / 6)));
    const k = Math.min(baseK, ANN_CONFIG.kfold ?? baseK);
    folds = kfoldIndices(nTrain, k);
    oofLogit = new Array(nTrain).fill(0.5);
    oofTree = new Array(nTrain).fill(0.5);
    for (const valIdx of folds) {
      const trainIdx = new Set(Array.from({ length: nTrain }, (_, i) => i).filter((i) => !valIdx.includes(i)));
      const Xtr = [];
      const ytr = [];
      const Xva = [];
      const iva = [];
      for (let i = 0; i < nTrain; i++) {
        if (trainIdx.has(i)) {
          Xtr.push(trainMatrix[i]);
          ytr.push(labels[i]);
        } else {
          Xva.push(trainMatrix[i]);
          iva.push(i);
        }
      }
      const scalerFold = fitScaler(Xtr.length ? Xtr : [new Array(FEATS_ENR.length).fill(0)]);
      const XtrS = applyScaler(Xtr, scalerFold);
      const XvaS = applyScaler(Xva, scalerFold);
      const logitModel = trainLogisticGD(XtrS, ytr, {
        steps: FAST_MODE ? 900 : 2500,
        lr: FAST_MODE ? 3e-3 : 4e-3,
        l2: 2e-4,
        featureLength: FEATS_ENR.length,
        init: warmStart ? { w: warmStart.w, b: warmStart.b } : undefined
      });
      const params = chooseTreeParams(XtrS.length);
      const cart = new CART({ maxDepth: params.depth, minNumSamples: params.minSamples, gainFunction: "gini" });
      if (XtrS.length) cart.train(XtrS, ytr);
      const leafStats = buildLeafFreq(cart, XtrS, ytr, laplaceAlpha(XtrS.length));
      const pLog = predictLogit(XvaS, logitModel);
      const pTree = predictTree(cart, leafStats, XvaS);
      for (let j = 0; j < iva.length; j++) {
        oofLogit[iva[j]] = safeProb(pLog[j]);
        oofTree[iva[j]] = safeProb(pTree[j]);
      }
    }
  } else {
    oofLogit = ensureArray([], nTrain, 0.5);
    oofTree = ensureArray([], nTrain, 0.5);
  }

  const modelParamsFile = loadModelParamsFile();
  const annEpochFallback =
    options.annMaxEpochs ?? modelParamsFile?.ann?.maxEpochs ?? Number(process.env.ANN_MAX_EPOCHS ?? 250);
  const annTuning = CI_FAST
    ? null
    : await tuneAnnHyperparams(trainStd, labels, folds, {
        annSeeds: options.annCvSeeds ?? options.annSeeds,
        annBatchSize: modelParamsFile?.ann?.batchSize ?? 32,
        annL2: options.annL2,
        annArchitecture: options.annArchitecture
      });
  const tunedAnnEpochs = annTuning?.epochs ?? annEpochFallback;
  const tunedAnnDropout =
    annTuning?.dropout ?? options.annDropout ?? modelParamsFile?.ann?.dropout ?? 0.3;

  const annMaxEpochs = Math.min(tunedAnnEpochs, ANN_CONFIG.maxEpochs ?? tunedAnnEpochs);
  const annSeedsConfigured = options.annSeeds ?? ANN_CONFIG.seeds ?? 5;
  const annSeeds = CI_FAST ? ANN_CONFIG.seeds : annSeedsConfigured;
  const annCvSeeds = CI_FAST
    ? ANN_CONFIG.cvSeeds
    : Math.max(ANN_CONFIG.cvSeeds ?? 3, Math.min(annSeeds, options.annCvSeeds ?? ANN_CONFIG.cvSeeds ?? 3));
  const annPatience = ANN_CONFIG.patience ?? (CI_FAST ? 3 : 10);
  const annFullPatience = CI_FAST
    ? ANN_CONFIG.patience
    : Math.max(ANN_CONFIG.patience ?? 10, 12);
  const annBatchSize = options.annBatchSize ?? modelParamsFile?.ann?.batchSize ?? 32;
  const annL2 = options.annL2 ?? 1e-4;

  const btStepsConfigured = Number(
    process.env.BT_GD_STEPS ?? modelParamsFile?.bt?.gd?.steps ?? 2000
  );
  const btStepsBase = CI_FAST
    ? Math.min(btStepsConfigured, Number(process.env.CI_FAST_BT_STEPS ?? 1200))
    : btStepsConfigured;
  const btTuning = await tuneBTHyperparams(btTrainRows, folds, btStepsBase);
  const tunedBtLr = btTuning?.lr ?? options.btLearningRate ?? modelParamsFile?.bt?.gd?.learningRate ?? 5e-3;
  const tunedBtL2 = btTuning?.l2 ?? options.btL2 ?? modelParamsFile?.bt?.gd?.l2 ?? 1e-4;

  // --- BEGIN: robust ANN OOF ---
  const annOOF = new Array(nTrain).fill(0.5);

  if (nTrain >= 2) {
    const foldSets = folds.length ? folds : [Array.from({ length: nTrain }, (_, i) => i)];
    for (const valIdx of foldSets) {
      const trainIdx = new Set(Array.from({ length: nTrain }, (_, i) => i).filter((i) => !valIdx.includes(i)));
      const Xtr = [], ytr = [], Xva = [], iva = [];
      for (let i = 0; i < nTrain; i++) {
        if (trainIdx.has(i)) { Xtr.push(trainMatrix[i]); ytr.push(labels[i]); }
        else { Xva.push(trainMatrix[i]); iva.push(i); }
      }
      // per-fold scaler
      const scalerFold = fitScaler(Xtr.length ? Xtr : [new Array(FEATS_ENR.length).fill(0)]);
      const XtrS = applyScaler(Xtr, scalerFold);
      const XvaS = applyScaler(Xva, scalerFold);
      // train a small committee for OOF
      const annModel = trainANNCommittee(XtrS, ytr, {
        seeds: annCvSeeds,
        maxEpochs: Math.min(annMaxEpochs, options.annCvMaxEpochs ?? annMaxEpochs),
        lr: 1e-3,
        patience: annPatience,
        dropout: tunedAnnDropout,
        batchSize: annBatchSize,
        l2: annL2,
        timeLimitMs: CI_FAST ? 12000 : options.annCvTimeLimit ?? 25000,
        architecture: options.annArchitecture,
        warmStart: annWarmStart
      });
      const preds = predictANNCommittee(annModel, XvaS);
      for (let j = 0; j < iva.length; j++) annOOF[iva[j]] = safeProb(preds[j]);
    }
  }
  // --- END: robust ANN OOF ---

  const btOOF = new Array(nTrain).fill(0.5);
  if (btTrainRows.length && nTrain) {
    const foldSets = folds.length ? folds : [Array.from({ length: nTrain }, (_, i) => i)];
    for (const valIdx of foldSets) {
      const trainIdx = new Set(Array.from({ length: nTrain }, (_, i) => i).filter((i) => !valIdx.includes(i)));
      const btTr = [];
      const btVa = [];
      const iva = [];
      for (let i = 0; i < nTrain; i++) {
        if (trainIdx.has(i)) btTr.push(btTrainRows[i]);
        else {
          btVa.push(btTrainRows[i]);
          iva.push(i);
        }
      }
      const model = trainBTModel(btTr, { steps: btStepsBase, lr: tunedBtLr, l2: tunedBtL2 });
      const preds = predictBTDeterministic(model, btVa);
      for (let j = 0; j < iva.length; j++) btOOF[iva[j]] = safeProb(preds[j]?.prob);
    }
  }

  const weightStep = options.weightStep ?? ANN_CONFIG.weightStep ?? 0.05;
  const weightsGrid = enumerateWeights(weightStep);
  const metrics = [];
  const gridTopLimit = Number.isFinite(ANN_CONFIG.gridTopN)
    ? Math.max(1, ANN_CONFIG.gridTopN)
    : Number.POSITIVE_INFINITY;
  for (const w of weightsGrid) {
    const wLog = toFiniteNumber(w.logistic, 0);
    const wTree = toFiniteNumber(w.tree, 0);
    const wBt = toFiniteNumber(w.bt, 0);
    const wAnn = toFiniteNumber(w.ann, 0);
    const blend = labels
      .map(
        (_, i) =>
          wLog * safeProb(oofLogit[i]) +
          wTree * safeProb(oofTree[i]) +
          wBt * safeProb(btOOF[i]) +
          wAnn * safeProb(annOOF[i])
      )
      .map(safeProb);
    const entry = { weights: w, loss: logLoss(labels, blend) ?? Infinity };
    if (gridTopLimit !== Number.POSITIVE_INFINITY) {
      metrics.push(entry);
      metrics.sort((a, b) => a.loss - b.loss);
      if (metrics.length > gridTopLimit) metrics.length = gridTopLimit;
    } else {
      metrics.push(entry);
    }
  }
  if (gridTopLimit === Number.POSITIVE_INFINITY) metrics.sort((a, b) => a.loss - b.loss);
  const bestWeights = metrics[0]?.weights ?? defaultWeights();
  const clampedWeights = clampWeights(bestWeights, weeksSeen || 1);
  const oofBlendRaw = labels.map((_, i) =>
    toFiniteNumber(clampedWeights.logistic, 0) * safeProb(oofLogit[i]) +
    toFiniteNumber(clampedWeights.tree, 0) * safeProb(oofTree[i]) +
    toFiniteNumber(clampedWeights.bt, 0) * safeProb(btOOF[i]) +
    toFiniteNumber(clampedWeights.ann, 0) * safeProb(annOOF[i])
  );
  const oofBlend = oofBlendRaw.map(safeProb);
  const calibration = await resolveCalibration({
    probs: oofBlend,
    labels,
    season: resolvedSeason,
    week: resolvedWeek
  });
  const oofBlendCal = oofBlend.map((p) => safeProb(calibration.apply(p)));

  const logitModelFull = trainLogisticGD(trainStd, labels, {
    steps: FAST_MODE ? 1400 : 3500,
    lr: FAST_MODE ? 3e-3 : 4e-3,
    l2: 2e-4,
    featureLength: FEATS_ENR.length,
    init: warmStart ? { w: warmStart.w, b: warmStart.b } : undefined
  });
  const treeParams = chooseTreeParams(trainStd.length);
  const cartFull = new CART({ maxDepth: treeParams.depth, minNumSamples: treeParams.minSamples, gainFunction: "gini" });
  if (trainStd.length) cartFull.train(trainStd, labels);
  const leafStatsFull = buildLeafFreq(cartFull, trainStd, labels, laplaceAlpha(trainStd.length));
  // --- BEGIN: robust ANN full fit ---
  const annModelFull = trainANNCommittee(trainStd, labels, {
    seeds: annSeeds,
    maxEpochs: annMaxEpochs,
    lr: 1e-3,
    patience: annFullPatience,
    dropout: tunedAnnDropout,
    batchSize: annBatchSize,
    l2: annL2,
    timeLimitMs: CI_FAST ? 20000 : options.annTimeLimit ?? 70000,
    architecture: options.annArchitecture,
    warmStart: annWarmStart
  });
  // --- END: robust ANN full fit ---
  const btModelFull = trainBTModel(btTrainRows, {
    steps: btStepsBase,
    lr: tunedBtLr,
    l2: tunedBtL2
  });

  const testMatrix = matrixFromRows(testRows, FEATS_ENR);
  const testStd = applyScaler(testMatrix, scaler);
  const logitTest = predictLogit(testStd, logitModelFull).map(safeProb);
  const treeTest = predictTree(cartFull, leafStatsFull, testStd).map(safeProb);
  const annTest = predictANNCommittee(annModelFull, testStd).map(safeProb);
  const btBootstrap = options.btBootstrapSamples ?? Number(process.env.BT_B ?? 1000);
  const btPreds = predictBT({
    model: btModelFull,
    rows: btTestRows,
    historyRows: btTrainRows,
    bootstrap: btBootstrap,
    block: options.btBlockSize ?? 5,
    seed: options.btSeed ?? 17
  });
  const btMapPred = new Map(btPreds.map((p) => [p.game_id, p]));

  const predictions = [];
  for (let i = 0; i < testRows.length; i++) {
    const row = testRows[i];
    const btRow = btTestRows[i];
    const btInfo = btMapPred.get(btRow.game_id) || { prob: 0.5, ci90: [0.25, 0.75], features: btRow.features };
    const probs = {
      logistic: safeProb(logitTest[i]),
      tree: safeProb(treeTest[i]),
      bt: safeProb(btInfo.prob),
      ann: safeProb(annTest[i])
    };
    const weightLogistic = toFiniteNumber(clampedWeights.logistic, 0);
    const weightTree = toFiniteNumber(clampedWeights.tree, 0);
    const weightBt = toFiniteNumber(clampedWeights.bt, 0);
    const weightAnn = toFiniteNumber(clampedWeights.ann, 0);
    const preBlendRaw =
      weightLogistic * probs.logistic +
      weightTree * probs.tree +
      weightBt * probs.bt +
      weightAnn * probs.ann;
    const preBlend = safeProb(preBlendRaw);
    const blended = safeProb(calibration.apply(preBlend));
    probs.blended = blended;

    const contribLogit = logitModelFull.w.map((w, idx) => ({
      feature: FEATS_ENR[idx],
      value: (w || 0) * (testStd[i]?.[idx] ?? 0)
    }));
    const path = leafPath(leafStatsFull.root, testStd[i] || []);
    const leafRec = leafStatsFull.freq.get(path);
    const leafWin = leafRec
      ? (leafRec.n1 + leafStatsFull.alpha) / (leafRec.n0 + leafRec.n1 + 2 * leafStatsFull.alpha)
      : 0.5;
    const btStd = applyScaler([
      BT_FEATURES.map((k) => Number(btInfo.features?.[k] ?? 0))
    ], btModelFull.scaler)[0] || [];
    const contribBT = btModelFull.w.map((w, idx) => ({ feature: BT_FEATURES[idx], value: (w || 0) * (btStd[idx] ?? 0) }));
    const gradAnn = gradientANNCommittee(annModelFull, testStd[i] || []);
    const contribAnn = gradAnn.map((g, idx) => ({ feature: FEATS_ENR[idx], value: g }));
    const drivers = buildTopDrivers({
      logisticContribs: contribLogit,
      treeInfo: { path, winrate: leafWin },
      btContribs: contribBT,
      annGrad: contribAnn
    });

    const { home: gidHome, away: gidAway } = parseGameIdTeams(btRow.game_id);
    const homeTeam = resolveTeamCode(row.team, gidHome, btRow.game_id, "home");
    const awayTeam = resolveTeamCode(row.opponent, gidAway, btRow.game_id, "away");

    predictions.push({
      game_id: btRow.game_id,
      home_team: homeTeam,
      away_team: awayTeam,
      season: row.season,
      week: row.week,
      forecast: round3(blended),
      probs: {
        logistic: round3(probs.logistic),
        tree: round3(probs.tree),
        bt: round3(probs.bt),
        ann: round3(probs.ann),
        blended: round3(blended)
      },
      blend_weights: {
        logistic: round3(clampedWeights.logistic, 0),
        tree: round3(clampedWeights.tree, 0),
        bt: round3(clampedWeights.bt, 0),
        ann: round3(clampedWeights.ann, 0)
      },
      calibration: {
        pre: round3(preBlend),
        post: round3(blended)
      },
      ci: {
        bt90: btInfo.ci90?.map((v) => round3(v)) ?? [0.25, 0.75]
      },
      natural_language: buildNarrative(
        { home_team: homeTeam, away_team: awayTeam },
        probs,
        btRow.features,
        row,
        leagueMeans
      ),
      top_drivers: drivers,
      actual: btRow.label_win
    });
  }

  const metricsSummary = {
    logistic: {
      logloss: logLoss(labels, oofLogit),
      brier: brier(labels, oofLogit),
      auc: aucRoc(labels, oofLogit),
      accuracy: accuracy(labels, oofLogit)
    },
    tree: {
      logloss: logLoss(labels, oofTree),
      brier: brier(labels, oofTree),
      auc: aucRoc(labels, oofTree),
      accuracy: accuracy(labels, oofTree)
    },
    bt: {
      logloss: logLoss(labels, btOOF),
      brier: brier(labels, btOOF),
      auc: aucRoc(labels, btOOF),
      accuracy: accuracy(labels, btOOF)
    },
    ann: {
      logloss: logLoss(labels, annOOF),
      brier: brier(labels, annOOF),
      auc: aucRoc(labels, annOOF),
      accuracy: accuracy(labels, annOOF)
    },
    ensemble: {
      logloss: logLoss(labels, oofBlendCal),
      brier: brier(labels, oofBlendCal),
      auc: aucRoc(labels, oofBlendCal),
      accuracy: accuracy(labels, oofBlendCal)
    }
  };

  const diagnostics = {
    season: resolvedSeason,
    week: resolvedWeek,
    metrics: metricsSummary,
    blend_weights: clampedWeights,
    calibration_beta: calibration.meta?.beta ?? 0,
    calibration_meta: calibration.meta,
    calibration_hash: hashCalibrationMeta(calibration.meta),
    calibration_bins: calibrationBins(labels, oofBlendCal),
    n_train_rows: nTrain,
    weeks_seen: weeksSeen,
    training_weeks: [...new Set(trainRows.map((r) => r.week))].sort((a, b) => a - b)
  };

  diagnostics.ann_details = {
    committee_size: annModelFull?.models?.length ?? null,
    seeds: annModelFull?.seeds ?? null
  };
  diagnostics.oof_variance = {
    ann: (function () {
      if (!nTrain) return null;
      const m = annOOF.reduce((s, v) => s + v, 0) / Math.max(1, annOOF.length);
      const v = annOOF.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, annOOF.length);
      return { mean: m, var: v };
    })()
  };
  diagnostics.hyperparams = {
    ann: { epochs: annMaxEpochs, dropout: tunedAnnDropout },
    bt: { learningRate: tunedBtLr, l2: tunedBtL2, steps: btStepsBase }
  };

  const trainLogitFull = predictLogit(trainStd, logitModelFull).map(safeProb);
  const trainTreeFull = predictTree(cartFull, leafStatsFull, trainStd).map(safeProb);
  const trainAnnFull = predictANNCommittee(annModelFull, trainStd).map(safeProb);
  const trainBtFull = btTrainRows.length
    ? predictBTDeterministic(btModelFull, btTrainRows).map((p) => safeProb(p?.prob))
    : new Array(labels.length).fill(0.5);
  const weightLogistic = toFiniteNumber(clampedWeights.logistic, 0);
  const weightTree = toFiniteNumber(clampedWeights.tree, 0);
  const weightBt = toFiniteNumber(clampedWeights.bt, 0);
  const weightAnn = toFiniteNumber(clampedWeights.ann, 0);
  const trainBlendRawFull = labels.map(
    (_, i) =>
      weightLogistic * trainLogitFull[i] +
      weightTree * trainTreeFull[i] +
      weightBt * trainBtFull[i] +
      weightAnn * trainAnnFull[i]
  );
  const trainBlendFull = trainBlendRawFull
    .map(safeProb)
    .map((p) => safeProb(calibration.apply(p)));
  const latestTrainWeek = Math.max(0, ...trainRows.map((r) => Number(r.week) || 0));
  const errorIndices = [];
  for (let i = 0; i < trainRows.length; i++) {
    if (trainRows[i].week !== latestTrainWeek) continue;
    const actual = labels[i];
    if (actual !== 0 && actual !== 1) continue;
    const pred = trainBlendFull[i] ?? 0.5;
    const cls = pred >= 0.5 ? 1 : 0;
    if (cls !== actual) errorIndices.push(i);
  }
  if (errorIndices.length) {
    const agg = new Array(FEATS_ENR.length).fill(0);
    for (const idx of errorIndices) {
      const row = trainStd[idx] || [];
      for (let j = 0; j < FEATS_ENR.length; j++) {
        const contrib = Math.abs((logitModelFull.w[j] || 0) * (row[j] ?? 0));
        if (Number.isFinite(contrib)) agg[j] += contrib;
      }
    }
    const top = agg
      .map((score, idx) => ({ feature: FEATS_ENR[idx], score }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => humanizeFeature(item.feature));
    if (top.length) {
      diagnostics.error_notes = `Top features associated with errors this week were ${top.join(", ")}.`;
    }
  } else if (latestTrainWeek) {
    diagnostics.error_notes = "No standout feature-level errors detected for the latest completed week.";
  }

  const pca = computePCA(trainStd, FEATS_ENR);

  const featureStart = FEATS_ENR.indexOf("off_epa_per_play_s2d");
  const appendedFeatures = featureStart >= 0 ? FEATS_ENR.slice(featureStart) : [];

  const modelSummary = {
    season: resolvedSeason,
    week: resolvedWeek,
    generated_at: new Date().toISOString(),
    feature_hash: featureHash,
    logistic: {
      weights: logitModelFull.w,
      bias: logitModelFull.b,
      scaler,
      features: FEATS_ENR
    },
    decision_tree: {
      params: treeParams,
      alpha: leafStatsFull.alpha
    },
    bt: {
      coefficients: btModelFull.w,
      intercept: btModelFull.b,
      scaler: btModelFull.scaler,
      features: BT_FEATURES,
      hyperparams: {
        steps: btStepsBase,
        learningRate: tunedBtLr,
        l2: tunedBtL2
      }
    },
    ann: {
      seeds: annModelFull.seeds,
      architecture: annModelFull.architecture,
      committee_size: annModelFull.models.length,
      max_epochs: annMaxEpochs,
      dropout: tunedAnnDropout
    },
    ensemble: {
      weights: clampedWeights,
      calibration: calibration.meta,
      calibration_beta: calibration.meta?.beta ?? 0,
      calibration_hash: hashCalibrationMeta(calibration.meta),
      oof_variance: diagnostics.oof_variance
    },
    pca,
    feature_enrichment: {
      appended_features: appendedFeatures,
      pbp_rows: Array.isArray(pbpData) ? pbpData.length : 0,
      player_weekly_rows: Array.isArray(playerWeekly) ? playerWeekly.length : 0
    }
  };

  const btDebug = btTestRows.map((row) => ({
    game_id: row.game_id,
    season: row.season,
    week: row.week,
    home_team: row.home_team,
    away_team: row.away_team,
    features: row.features,
    home_context: row.home_context,
    away_context: row.away_context
  }));

  const featureStats = {
    features: Array.isArray(FEATS_ENR) ? [...FEATS_ENR] : [],
    mean: Array.isArray(scaler?.mu) ? [...scaler.mu] : [],
    std: Array.isArray(scaler?.sd) ? [...scaler.sd] : [],
    train_rows: trainRows.length,
    historical_rows: historicalTrainRowsRaw.length
  };

  const trainingMetadata = {
    featureStats,
    historical: {
      seasons: Array.isArray(options?.historical?.seasons) ? options.historical.seasons : [],
      rowCount: historicalTrainRowsRaw.length
    }
  };

  return {
    season: resolvedSeason,
    week: resolvedWeek,
    predictions,
    modelSummary,
    diagnostics,
    btDebug,
    schedules,
    featureHash,
    trainingMetadata,
    annModel: annModelFull
  };
}

export async function writeArtifacts(result) {
  const stamp = `${result.season}_W${String(result.week).padStart(2, "0")}`;
  await ensureArtifactsDir();
  validateArtifact("predictions", result.predictions);
  await fsp.writeFile(
    path.join(ART_DIR, `predictions_${stamp}.json`),
    JSON.stringify(result.predictions, null, JSON_SPACE)
  );
  // 1) Build & write context pack
  const skipContext = process.env.TRAINER_SMOKE_TEST === "1";
  const context = Array.isArray(result.context)
    ? result.context
    : skipContext
      ? []
      : await buildContextForWeek(result.season, result.week);
  await fs.promises.writeFile(
    path.join(ART_DIR, `context_${result.season}_W${String(result.week).padStart(2, "0")}.json`),
    JSON.stringify(context, null, JSON_SPACE)
  );

  // 2) Compute & write explanation scorecards
  calibrateThresholds();
  await writeExplainArtifact({
    season: result.season,
    week: result.week,
    predictions: Array.isArray(result.predictions)
      ? result.predictions
      : result.predictions?.games || result.predictions,
    context
  });
  const modelSummaryPayload = {
    ...(result.modelSummary ?? {}),
    generated_at: result.modelSummary?.generated_at ?? new Date().toISOString()
  };
  validateArtifact("model", modelSummaryPayload);
  await fsp.writeFile(
    path.join(ART_DIR, `model_${stamp}.json`),
    JSON.stringify(modelSummaryPayload, null, JSON_SPACE)
  );
  const diagnosticsPayload = {
    ...result.diagnostics,
    training_metadata: result.trainingMetadata ?? null
  };
  validateArtifact("diagnostics", diagnosticsPayload);
  await fsp.writeFile(
    path.join(ART_DIR, `diagnostics_${stamp}.json`),
    JSON.stringify(diagnosticsPayload, null, JSON_SPACE)
  );
  validateArtifact("bt_features", result.btDebug);
  await fsp.writeFile(
    path.join(ART_DIR, `bt_features_${stamp}.json`),
    JSON.stringify(result.btDebug, null, JSON_SPACE)
  );
}

export async function updateHistoricalArtifacts({ season, schedules }) {
  await ensureArtifactsDir();
  if (!Array.isArray(schedules) || !schedules.length) return;
  const seasonGames = schedules.filter(
    (game) => Number(game.season) === Number(season) && isRegularSeason(game.season_type)
  );
  if (!seasonGames.length) return;

  const weeks = [...new Set(seasonGames.map((g) => Number(g.week)).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );

  const aggregated = {
    actual: [],
    logistic: [],
    decision_tree: [],
    bt: [],
    ann: [],
    blended: []
  };
  const weeklySummaries = [];
  const weekMetadata = [];
  let latestCompletedWeek = 0;

  for (const week of weeks) {
    const games = seasonGames.filter((g) => Number(g.week) === week);
    if (!games.length) continue;

    const stamp = `${season}_W${String(week).padStart(2, "0")}`;
    const predictionFilename = `predictions_${stamp}.json`;
    const outcomesFilename = `outcomes_${stamp}.json`;
    const metricsFilename = `metrics_${stamp}.json`;
    const predictionPath = path.join(ART_DIR, predictionFilename);
    const outcomesPath = path.join(ART_DIR, outcomesFilename);
    const metricsPath = path.join(ART_DIR, metricsFilename);

    const metadataEntry = {
      week,
      stamp,
      scheduled_games: games.length,
      completed: false,
      status: "pending",
      predictions: {
        filename: predictionFilename,
        path: predictionPath,
        exists: existsSync(predictionPath)
      },
      outcomes: {
        filename: outcomesFilename,
        path: outcomesPath,
        exists: existsSync(outcomesPath)
      },
      metrics: {
        filename: metricsFilename,
        path: metricsPath,
        exists: existsSync(metricsPath)
      }
    };
    weekMetadata.push(metadataEntry);

    const allComplete = games.every((g) => scheduleScores(g));
    if (!allComplete) {
      metadataEntry.status = "awaiting_scores";
      continue;
    }
    if (!metadataEntry.predictions.exists) {
      metadataEntry.status = "missing_predictions";
      continue;
    }

    let preds;
    try {
      preds = JSON.parse(readFileSync(predictionPath, "utf8"));
    } catch (err) {
      metadataEntry.status = "invalid_predictions";
      continue;
    }
    if (!Array.isArray(preds) || !preds.length) {
      metadataEntry.status = "invalid_predictions";
      continue;
    }

    const actualMap = new Map();
    for (const game of games) {
      const home = normalizeTeamCode(game.home_team);
      const away = normalizeTeamCode(game.away_team);
      if (!home || !away) continue;
      const scores = scheduleScores(game);
      if (!scores) continue;
      if (scores.hs === scores.as) continue;
      const homeWin = scores.hs > scores.as ? 1 : 0;
      actualMap.set(scheduleGameId(season, week, home, away), {
        home_points: scores.hs,
        away_points: scores.as,
        home_win: homeWin
      });
    }

    const outcomes = [];
    const labels = [];
    const probBuckets = {
      logistic: [],
      decision_tree: [],
      bt: [],
      ann: [],
      blended: []
    };

    for (const pred of preds) {
      const actual = actualMap.get(pred.game_id);
      if (!actual) continue;
      const probs = pred.probs || {};
      const logistic = Number(probs.logistic ?? pred.forecast ?? 0.5);
      const tree = Number(probs.tree ?? probs.decision_tree ?? pred.forecast ?? 0.5);
      const bt = Number(probs.bt ?? pred.forecast ?? 0.5);
      const ann = Number(probs.ann ?? pred.forecast ?? 0.5);
      const blended = Number(probs.blended ?? pred.forecast ?? 0.5);
      labels.push(actual.home_win);
      probBuckets.logistic.push(logistic);
      probBuckets.decision_tree.push(tree);
      probBuckets.bt.push(bt);
      probBuckets.ann.push(ann);
      probBuckets.blended.push(blended);
      outcomes.push({
        game_id: pred.game_id,
        home_team: pred.home_team,
        away_team: pred.away_team,
        season: pred.season ?? season,
        week: pred.week ?? week,
        actual,
        predicted: {
          logistic,
          decision_tree: tree,
          bt,
          ann,
          blended
        }
      });
    }

    if (!outcomes.length) {
      metadataEntry.status = "no_evaluable_games";
      continue;
    }

    validateArtifact("outcomes", outcomes);
    await fsp.writeFile(outcomesPath, JSON.stringify(outcomes, null, JSON_SPACE));

    const perModel = {
      logistic: metricBlock(labels, probBuckets.logistic),
      decision_tree: metricBlock(labels, probBuckets.decision_tree),
      bt: metricBlock(labels, probBuckets.bt),
      ann: metricBlock(labels, probBuckets.ann),
      blended: metricBlock(labels, probBuckets.blended)
    };

    const metricsPayload = {
      season,
      week,
      per_model: perModel,
      calibration_bins: calibrationBins(labels, probBuckets.blended)
    };

    validateArtifact("metrics", metricsPayload);
    await fsp.writeFile(metricsPath, JSON.stringify(metricsPayload, null, JSON_SPACE));
    weeklySummaries.push(metricsPayload);
    latestCompletedWeek = Math.max(latestCompletedWeek, week);

    aggregated.actual.push(...labels);
    aggregated.logistic.push(...probBuckets.logistic);
    aggregated.decision_tree.push(...probBuckets.decision_tree);
    aggregated.bt.push(...probBuckets.bt);
    aggregated.ann.push(...probBuckets.ann);
    aggregated.blended.push(...probBuckets.blended);

    metadataEntry.completed = true;
    metadataEntry.status = "complete";
    metadataEntry.outcomes.exists = true;
    metadataEntry.metrics.exists = true;
    metadataEntry.games_evaluated = outcomes.length;
  }

  if (!latestCompletedWeek || !aggregated.actual.length) return;

  const cumulative = {
    logistic: metricBlock(aggregated.actual, aggregated.logistic),
    decision_tree: metricBlock(aggregated.actual, aggregated.decision_tree),
    bt: metricBlock(aggregated.actual, aggregated.bt),
    ann: metricBlock(aggregated.actual, aggregated.ann),
    blended: metricBlock(aggregated.actual, aggregated.blended)
  };

  const seasonMetrics = {
    season,
    week: 0,
    aggregation_scope: "season",
    latest_completed_week: latestCompletedWeek,
    per_model: cumulative,
    weeks: weeklySummaries.map((entry) => ({ week: entry.week, per_model: entry.per_model }))
  };

  validateArtifact("metrics", seasonMetrics);
  await fsp.writeFile(
    path.join(ART_DIR, `metrics_${season}.json`),
    JSON.stringify(seasonMetrics, null, JSON_SPACE)
  );

  const seasonIndex = {
    season,
    latest_completed_week: latestCompletedWeek,
    weeks: weekMetadata
  };

  validateArtifact("season_index", seasonIndex);
  await fsp.writeFile(
    path.join(ART_DIR, `season_index_${season}.json`),
    JSON.stringify(seasonIndex, null, JSON_SPACE)
  );

  const weeklyGameCounts = weeklySummaries.map((entry) => ({
    week: entry.week,
    games: entry.per_model?.blended?.n ?? entry.per_model?.logistic?.n ?? 0
  }));

  const seasonSummary = {
    season,
    latest_completed_week: latestCompletedWeek,
    completed_weeks: weeklySummaries.length,
    total_games: aggregated.actual.length,
    season_metrics: seasonMetrics,
    weekly_summaries: weeklySummaries,
    weekly_game_counts: weeklyGameCounts,
    week_metadata: weekMetadata
  };

  validateArtifact("season_summary", seasonSummary);
  await fsp.writeFile(
    path.join(ART_DIR, `season_summary_${season}.json`),
    JSON.stringify(seasonSummary, null, JSON_SPACE)
  );
}

async function loadSeasonData(season) {
  const limiter = createLimiter(DATA_FETCH_CONCURRENCY);
  const queueFetch = (factory, { fallback = [], onError } = {}) =>
    limiter(async () => {
      try {
        return await factory();
      } catch (err) {
        if (typeof onError === "function") {
          onError(err);
        }
        return typeof fallback === "function" ? fallback(err) : fallback;
      }
    });

  const schedulesPromise = queueFetch(() => loadSchedules(season), { fallback: [] });
  const teamWeeklyPromise = queueFetch(() => loadTeamWeekly(season), { fallback: [] });
  const teamGamePromise = queueFetch(() => loadTeamGameAdvanced(season), { fallback: [] });

  const prevSeason = season - 1;
  const prevTeamWeeklyPromise =
    prevSeason >= MIN_TRAIN_SEASON
      ? queueFetch(() => loadTeamWeekly(prevSeason), { fallback: [] })
      : Promise.resolve([]);

  const pbpPromise = queueFetch(() => loadPBP(season), { fallback: [] });
  const playerWeeklyPromise = queueFetch(() => loadPlayerWeekly(season), { fallback: [] });
  const rostersPromise = queueFetch(() => loadRostersWeekly(season), { fallback: [] });
  const depthChartsPromise = queueFetch(() => loadDepthCharts(season), { fallback: [] });
  const snapCountsPromise = queueFetch(() => loadSnapCounts(season), { fallback: [] });
  const participationPromise = queueFetch(() => loadParticipation(season), { fallback: [] });
  const weatherPromise = queueFetch(() => loadWeather(season), { fallback: [] });
  const pfrPromise = queueFetch(() => loadPFRAdvTeam(season), { fallback: [] });
  const qbrPromise = queueFetch(() => loadESPNQBR(season), { fallback: [] });
  const officialsPromise = queueFetch(() => loadOfficials(), { fallback: [] });

  let injuriesEnabled = season >= INJURY_DATA_MIN_SEASON;
  const injuriesPromise = injuriesEnabled
    ? queueFetch(() => loadInjuries(season), {
        fallback: [],
        onError: () => {
          injuriesEnabled = false;
        }
      })
    : Promise.resolve([]);

  let nextGenEnabled = season >= NEXTGEN_DATA_MIN_SEASON;
  const ngsPassingPromise = nextGenEnabled
    ? queueFetch(() => loadNextGenStats(season, "passing"), {
        fallback: [],
        onError: () => {
          nextGenEnabled = false;
        }
      })
    : Promise.resolve([]);
  const ngsRushingPromise = nextGenEnabled
    ? queueFetch(() => loadNextGenStats(season, "rushing"), {
        fallback: [],
        onError: () => {
          nextGenEnabled = false;
        }
      })
    : Promise.resolve([]);
  const ngsReceivingPromise = nextGenEnabled
    ? queueFetch(() => loadNextGenStats(season, "receiving"), {
        fallback: [],
        onError: () => {
          nextGenEnabled = false;
        }
      })
    : Promise.resolve([]);

  const [
    schedules,
    teamWeekly,
    teamGame,
    prevTeamWeekly,
    pbp,
    playerWeekly,
    rosters,
    depthCharts,
    injuries,
    snapCounts,
    participation,
    weatherRows,
    pfrAdv,
    qbr,
    officials,
    ngsPassing,
    ngsRushing,
    ngsReceiving
  ] = await Promise.all([
    schedulesPromise,
    teamWeeklyPromise,
    teamGamePromise,
    prevTeamWeeklyPromise,
    pbpPromise,
    playerWeeklyPromise,
    rostersPromise,
    depthChartsPromise,
    injuriesPromise,
    snapCountsPromise,
    participationPromise,
    weatherPromise,
    pfrPromise,
    qbrPromise,
    officialsPromise,
    ngsPassingPromise,
    ngsRushingPromise,
    ngsReceivingPromise
  ]);

  const availability = {
    injuries: injuriesEnabled && Array.isArray(injuries),
    nextGen: nextGenEnabled && Array.isArray(ngsPassing)
  };

  return {
    schedules,
    teamWeekly,
    teamGame,
    prevTeamWeekly,
    pbp,
    playerWeekly,
    rosters,
    depthCharts,
    injuries,
    snapCounts,
    pfrAdv,
    qbr,
    officials,
    participation,
    weather: weatherRows,
    nextGenStats: {
      passing: ngsPassing,
      rushing: ngsRushing,
      receiving: ngsReceiving
    },
    availability
  };
}

function loadSeasonDataCached(season) {
  return cachePromise(seasonDataCache, season, () => loadSeasonData(season));
}

async function buildHistoricalTrainingSet({ minSeason = MIN_SEASON, maxSeason } = {}) {
  const start = Number.isFinite(minSeason) ? Math.max(MIN_SEASON, Math.floor(minSeason)) : MIN_SEASON;
  const end = Number.isFinite(maxSeason) ? Math.floor(maxSeason) : start - 1;
  if (!Number.isFinite(end) || end < start) {
    return { featureRows: [], btRows: [], seasons: [] };
  }
  const featureRows = [];
  const btRows = [];
  const seasons = [];
  for (let season = start; season <= end; season += 1) {
    try {
      const shared = await loadSeasonDataCached(season);
      const featureSeason = buildFeatures({
        teamWeekly: shared.teamWeekly,
        teamGame: shared.teamGame,
        schedules: shared.schedules,
        season,
        prevTeamWeekly: shared.prevTeamWeekly,
        pbp: shared.pbp,
        playerWeekly: shared.playerWeekly,
        weather: shared.weather,
        injuries: shared.injuries
      });
      const btSeason = buildBTFeatures({
        teamWeekly: shared.teamWeekly,
        teamGame: shared.teamGame,
        schedules: shared.schedules,
        season,
        prevTeamWeekly: shared.prevTeamWeekly,
        injuries: shared.injuries
      });
      let db = null;
      try {
        db = await getSeasonDB(season);
      } catch (err) {
        db = null;
      }
      if (db) {
        for (const row of featureSeason) {
          if (row.home === 1) {
            attachAdvWeeklyDiff(db, row, row.week, row.team, row.opponent);
          } else {
            attachAdvWeeklyDiff(db, row, row.week, row.opponent, row.team);
          }
        }
      }
      featureRows.push(...featureSeason);
      btRows.push(...btSeason);
      seasons.push(season);
    } catch (err) {
      warn(`[train] Failed to build historical rows for season ${season}: ${err?.message ?? err}`);
    }
  }
  return { featureRows, btRows, seasons };
}

async function persistWeeklyFeatureStats({ season, week, featureStats, historicalSeasons }) {
  if (!featureStats) return null;
  const commonDir = artp("models", "common");
  await fsp.mkdir(commonDir, { recursive: true });
  const suffix = week === 1
    ? `${season - 1}`
    : `${season}_${String(Math.max(1, week - 1)).padStart(2, "0")}`;
  const targetPath = path.join(commonDir, `${FEATURE_STATS_PREFIX}${suffix}.json`);
  const payload = {
    version: 1,
    generated_at: new Date().toISOString(),
    season,
    week,
    trained_window: {
      start_season: MIN_SEASON,
      end_season: week === 1 ? season - 1 : season,
      through_week: week === 1 ? null : Math.max(1, week - 1)
    },
    historical_seasons: Array.isArray(historicalSeasons) ? historicalSeasons : [],
    features: featureStats.features,
    mean: featureStats.mean,
    std: featureStats.std,
    train_rows: featureStats.train_rows,
    historical_rows: featureStats.historical_rows
  };
  await fsp.writeFile(targetPath, JSON.stringify(payload, null, JSON_SPACE));
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { path: targetPath, hash };
}

/**
 * Chunked training: process season batches sequentially to avoid CI timeouts.
 */
async function runWeeklyWorkflow({ season, week }) {
  if (!Number.isFinite(season) || !Number.isFinite(week)) {
    throw new Error("[train] Weekly workflow requires numeric season and week.");
  }

  const prevSeason = season - 1;
  const promoted = await promote({ prevSeason, nextSeason: season });
  if (week === 1 && !promoted) {
    throw new Error(`[train] Unable to promote final ensemble from season ${prevSeason}: promotion failed.`);
  }
    if (!promoted) {
      warn(`[train] Promotion skipped for season ${season}; continuing with existing seeds.`);
    } else {
      console.log(`[train] Promotion complete for season ${season} using finals from ${prevSeason}.`);
    }

    const weeklyAnnCheckpoint = await loadAnnCheckpoint();
    let weeklyAnnWarmStart = weeklyAnnCheckpoint?.model ?? null;
    if (weeklyAnnWarmStart) {
      const seasonLog = Number.isFinite(weeklyAnnCheckpoint?.season)
        ? ` season ${weeklyAnnCheckpoint.season}`
        : "";
      const weekLog = Number.isFinite(weeklyAnnCheckpoint?.week)
        ? ` week ${String(weeklyAnnCheckpoint.week).padStart(2, "0")}`
        : "";
      console.log(`[train] Weekly workflow: restored ANN warm-start${seasonLog}${weekLog}.`);
    }

    const historicalMax = Math.max(MIN_SEASON, season - 1);
  const compactHistory = process.env.TRAINER_SMOKE_TEST === "1";
  const historicalMin = compactHistory ? Math.max(MIN_SEASON, historicalMax) : MIN_SEASON;
  const historical = await buildHistoricalTrainingSet({ minSeason: historicalMin, maxSeason: historicalMax });

  const seasonData = await loadSeasonDataCached(season);
  if (compactHistory) {
    const trainingMetadata = {
      featureStats: {
        features: [...FEATS_BASE],
        mean: new Array(FEATS_BASE.length).fill(0),
        std: new Array(FEATS_BASE.length).fill(1),
        train_rows: 8,
        historical_rows: 8
      },
      historical: {
        seasons: [prevSeason],
        rowCount: 8
      }
    };
    const syntheticResult = {
      season,
      week,
      predictions: [],
      modelSummary: {
        season,
        week,
        ensemble: {
          weights: defaultWeights(),
          calibration: { type: "league_prior", source: "synthetic" },
          calibration_beta: 0,
          calibration_hash: hashCalibrationMeta({ type: "league_prior", source: "synthetic" }),
          oof_variance: null
        }
      },
      diagnostics: {
        season,
        week,
        metrics: {},
        blend_weights: defaultWeights(),
        calibration_beta: 0,
        calibration_bins: [],
        n_train_rows: 0,
        weeks_seen: 0,
        training_weeks: [],
        training_metadata: trainingMetadata
      },
      btDebug: [],
      schedules: seasonData.schedules ?? [],
      featureHash: `synthetic-${season}-${week}`,
      trainingMetadata
    };
    const statsRecordSynthetic = await persistWeeklyFeatureStats({
      season,
      week,
      featureStats: trainingMetadata.featureStats,
      historicalSeasons: trainingMetadata.historical.seasons
    });
    if (statsRecordSynthetic?.path) {
      console.log(`[train] Synthetic feature stats persisted to ${statsRecordSynthetic.path}`);
    }
    await writeArtifacts(syntheticResult);
    let stateSynthetic = loadTrainingState();
    const bootstrapSynthetic = stateSynthetic?.bootstraps?.[BOOTSTRAP_KEYS.MODEL] ?? null;
    const syntheticRevision = bootstrapSynthetic?.revision ?? bootstrapSynthetic?.seedRevision ?? null;
    stateSynthetic.weekly_seed = {
      season,
      seededFrom: prevSeason,
      seedRevision: syntheticRevision ?? null,
      featureStatsHash: statsRecordSynthetic?.hash ?? null,
      calibrationHash: syntheticResult.modelSummary?.ensemble?.calibration_hash ?? null
    };
    stateSynthetic = recordLatestRun(stateSynthetic, BOOTSTRAP_KEYS.MODEL, { season, week, weekly: true });
    saveTrainingState(stateSynthetic);
    return syntheticResult;
  }
  const trainingResult = await runTraining({
    season,
    week,
    data: seasonData,
    options: {
      historical: {
        featureRows: historical.featureRows,
        btRows: historical.btRows,
        seasons: historical.seasons
      },
      annWarmStart: weeklyAnnWarmStart
    }
  });

  if (!trainingResult || trainingResult.skipped) {
    throw new Error(`[train] Weekly training failed to produce a model for season ${season} week ${week}.`);
  }

  if (trainingResult.annModel) {
    weeklyAnnWarmStart = trainingResult.annModel;
    await saveAnnCheckpoint({ model: weeklyAnnWarmStart, season, week });
  }

  const statsRecord = await persistWeeklyFeatureStats({
    season,
    week,
    featureStats: trainingResult.trainingMetadata?.featureStats ?? null,
    historicalSeasons: historical.seasons
  });
  if (statsRecord?.path) {
    console.log(`[train] Feature stats persisted to ${statsRecord.path}`);
  }

  await writeArtifacts(trainingResult);

  let state = loadTrainingState();
  const bootstrapRecord = state?.bootstraps?.[BOOTSTRAP_KEYS.MODEL] ?? null;
  const seedRevision = bootstrapRecord?.revision ?? bootstrapRecord?.seedRevision ?? null;
  const calibrationHash =
    trainingResult.modelSummary?.ensemble?.calibration_hash ??
    hashCalibrationMeta(trainingResult.modelSummary?.ensemble?.calibration ?? null);
  state.weekly_seed = {
    season,
    seededFrom: season - 1,
    seedRevision: seedRevision ?? null,
    featureStatsHash: statsRecord?.hash ?? state.weekly_seed?.featureStatsHash ?? null,
    calibrationHash: calibrationHash ?? state.weekly_seed?.calibrationHash ?? null
  };
  state = recordLatestRun(state, BOOTSTRAP_KEYS.MODEL, { season, week, weekly: true });
  saveTrainingState(state);

  return trainingResult;
}

export async function mainOld(options = {}) {
  applyCliEnvOverrides(options);
  refreshArtifactsPaths();

  await ensureArtifactsDir();
  await ensureChunkCacheDir();
  const targetSeason = Number(process.env.SEASON ?? new Date().getFullYear());
  let weekEnv = Number(process.env.WEEK ?? 6);
  if (!Number.isFinite(weekEnv) || weekEnv < 1) weekEnv = 1;
  const targetWeek = Math.max(1, Math.floor(weekEnv));
  const historicalUpperBound = Number.isFinite(targetSeason)
    ? Math.max(targetSeason - 1, MIN_SEASON)
    : null;

  let state = loadTrainingState();
  const refreshResult = ensureTrainingStateCurrent({ state, silent: true });
  state = refreshResult.state;
  if (refreshResult.refreshed) {
    console.log(
      `[train] Refreshed cached training_state metadata from artifacts (revision ${CURRENT_BOOTSTRAP_REVISION}).`
    );
  } else if (refreshResult.error) {
    warn(
      `[train] Unable to refresh cached training_state metadata from artifacts (${refreshResult.error.message ?? refreshResult.error}). Proceeding with trainer bootstrap.`
    );
  }

  const weeklySeason = Number.parseInt(process.env.SEASON ?? "", 10);
  const weeklyWeek = Number.parseInt(process.env.WEEK ?? "", 10);
  const weeklyMode = Number.isFinite(weeklySeason) && Number.isFinite(weeklyWeek);
  if (weeklyMode && !shouldRunHistoricalBootstrap(state, BOOTSTRAP_KEYS.MODEL)) {
    await runWeeklyWorkflow({ season: weeklySeason, week: weeklyWeek });
    touchStrictBatchStatusIfAny();
    return;
  }
  const lastModelRun = state?.latest_runs?.[BOOTSTRAP_KEYS.MODEL];
  const historicalOverride = shouldRewriteHistorical();
  const bootstrapRequired = shouldRunHistoricalBootstrap(state, BOOTSTRAP_KEYS.MODEL, {
    minSeason: MIN_SEASON,
    requiredThroughSeason: historicalUpperBound
  });
  const allowHistoricalRewrite = historicalOverride || bootstrapRequired;

  const previousSeason = Number.isFinite(targetSeason) ? targetSeason - 1 : null;
  const shouldPromoteSeed =
    Number.isFinite(targetSeason) &&
    Number.isFinite(previousSeason) &&
    targetWeek === 1 &&
    !historicalOverride;

  if (shouldPromoteSeed && !isStrictBatch()) {
    const hasModels = await modelsForSeasonExist(targetSeason);
    if (!hasModels) {
      const promoted = await promote({ prevSeason: previousSeason, nextSeason: targetSeason });
      if (!promoted) {
        throw new Error(
          `[train] Unable to promote final ensemble from season ${previousSeason}. Expected ${artp(
            "models",
            String(previousSeason),
            "final"
          )} to exist. Restore prior-season finals before running Week 1.`
        );
      }
      console.log(`[train] Promoted final ensemble from ${previousSeason} → ${targetSeason}/week-00.`);
      state = loadTrainingState();
    }
  }

  const strictBatch =
    typeof options.strictBatch === "boolean" ? options.strictBatch : CLI_DEFAULT_STRICT_BATCH;
  const cliBatchStart = options.start ?? null;
  const cliBatchEnd = options.end ?? null;
  const explicitStart = normaliseSeason(process.env.BATCH_START ?? cliBatchStart);
  const explicitEnd = normaliseSeason(process.env.BATCH_END ?? cliBatchEnd);
  const explicitWindow =
    explicitStart !== null && explicitEnd !== null ? { start: explicitStart, end: explicitEnd } : null;

  let seasonsInScope = [targetSeason];
  if (bootstrapRequired || allowHistoricalRewrite) {
    const discoveredSeasons = await listDatasetSeasons("teamWeekly").catch(() => []);
    seasonsInScope = await resolveSeasonList({
      targetSeason,
      includeAll: true,
      sinceSeason: bootstrapRequired ? MIN_SEASON : MIN_TRAIN_SEASON,
      maxSeasons: Number.isFinite(MAX_TRAIN_SEASONS) ? MAX_TRAIN_SEASONS : null,
      availableSeasons: discoveredSeasons
    });
  }

  let uniqueSeasons = Array.from(
    new Set(
      seasonsInScope
        .map((season) => Number.parseInt(season, 10))
        .filter((season) => Number.isFinite(season))
    )
  ).sort((a, b) => a - b);
  if (isStrictBatch()) {
    uniqueSeasons = clampSeasonsToStrictBounds(uniqueSeasons);
  }

  let stateCoverage = Array.isArray(state?.bootstraps?.[BOOTSTRAP_KEYS.MODEL]?.seasons)
    ? state.bootstraps[BOOTSTRAP_KEYS.MODEL].seasons
    : [];
  stateCoverage = filterCoverageEntries(stateCoverage);

  if (explicitWindow) {
    if (isStrictBatch()) {
      uniqueSeasons = uniqueSeasons.filter(
        (season) => season >= explicitWindow.start && season <= explicitWindow.end
      );
    }
    const missingSeasons = seasonsInRangeMissing({
      coverage: stateCoverage,
      start: explicitWindow.start,
      end: explicitWindow.end
    });
    if (missingSeasons.length) {
      console.log(
        `[train] Explicit window ${explicitWindow.start}–${explicitWindow.end} not in training_state; bootstrapping raw season index and proceeding.`
      );
      const rawCoverage = await buildSeasonCoverageFromRaw({ seasons: missingSeasons });
      if (rawCoverage.length) {
        const merged = mergeSeasonCoverage(stateCoverage, rawCoverage);
        state = markBootstrapCompleted(state, BOOTSTRAP_KEYS.MODEL, {
          seasons: merged,
          bootstrap_source: "raw-bootstrap",
          chunks: state?.bootstraps?.[BOOTSTRAP_KEYS.MODEL]?.chunks
        });
        saveTrainingState(state);
        stateCoverage = filterCoverageEntries(merged);
      } else {
        throw new Error(
          `[train] Unable to derive raw coverage for explicit window ${explicitWindow.start}–${explicitWindow.end}. Ensure raw schedules/outcomes are available for the requested seasons.`
        );
      }
    }
    const coverageSeasons = stateCoverage
      .map((entry) => Number.parseInt(entry?.season, 10))
      .filter((season) => Number.isFinite(season));
    const coverageSet = new Set(uniqueSeasons);
    for (let season = explicitWindow.start; season <= explicitWindow.end; season += 1) {
      coverageSet.add(season);
    }
    for (const season of coverageSeasons) {
      if (season >= explicitWindow.start && season <= explicitWindow.end && !coverageSet.has(season)) {
        coverageSet.add(season);
      }
    }
    uniqueSeasons = Array.from(coverageSet).sort((a, b) => a - b);
  }

  const recordedChunks = Array.isArray(state?.bootstraps?.[BOOTSTRAP_KEYS.MODEL]?.chunks)
    ? state.bootstraps[BOOTSTRAP_KEYS.MODEL].chunks
    : [];
  let chunkResolution = { chunkSelection: null, explicit: false, autoCandidate: null };
  if ((bootstrapRequired || historicalOverride || explicitWindow) && uniqueSeasons.length) {
    chunkResolution = resolveHistoricalChunkSelection({
      uniqueSeasons,
      chunkSize: HISTORICAL_BATCH_SIZE,
      recordedChunks,
      explicitStart,
      explicitEnd,
      strictBatch,
      minSeason: MIN_SEASON,
      maxSeason: historicalUpperBound ?? Number.POSITIVE_INFINITY
    });
  }
  let chunkSelection = chunkResolution.chunkSelection;
  trace("chunk-selection:resolved", {
    explicitWindow: explicitWindow
      ? { start: explicitWindow.start, end: explicitWindow.end }
      : null,
    chunkSelection: chunkSelection
      ? { start: chunkSelection.start, end: chunkSelection.end }
      : null,
    strictBatch,
    bootstrapRequired,
    historicalOverride,
    recordedChunkCount: Array.isArray(recordedChunks) ? recordedChunks.length : 0
  });
  if (explicitWindow) {
    if (!chunkSelection) {
      const label = `${explicitWindow.start}–${explicitWindow.end}`;
      throw new Error(`[train] Explicit batch window ${label} requested but no matching seasons were resolved.`);
    }
    if (chunkSelection.start !== explicitWindow.start || chunkSelection.end !== explicitWindow.end) {
      const attempted = `${chunkSelection.start}–${chunkSelection.end}`;
      throw new Error(
        `Explicit batch window ${explicitWindow.start}–${explicitWindow.end} provided but resolver attempted ${attempted}. Refusing to override.`
      );
    }
  }

  const resolvedWindowLog = formatBatchWindowLog({
    chunkSelection,
    explicit: Boolean(chunkResolution.explicit)
  });
  if (resolvedWindowLog) {
    console.log(resolvedWindowLog);
  }
  if (chunkResolution.explicit && chunkResolution.autoCandidate) {
    const { start: autoStart, end: autoEnd } = chunkResolution.autoCandidate;
    if (autoStart !== chunkSelection.start || autoEnd !== chunkSelection.end) {
      console.log(
        `[train] Training state indicates next pending bootstrap chunk ${autoStart}-${autoEnd}; explicit batch window ${chunkSelection.start}-${chunkSelection.end} will be used instead.`
      );
    }
  }

  const activeChunkLabel = chunkSelection ? chunkLabel(chunkSelection.start, chunkSelection.end) : null;

  const activeSeasons = computeRequestedSeasons();
  trace("active-seasons", {
    explicit: Boolean(explicitWindow),
    activeSeasons,
    chunkLabel: activeChunkLabel
  });

  console.log(`[train:init] ARTIFACTS_DIR=${ART_DIR}`);
  console.log(`[train:init] STATUS_DIR=${path.join(ART_DIR, ".status")}`);
  console.log(
    `[train:init] Active seasons (unfiltered): ${JSON.stringify(activeSeasons)}; BATCH_START=${process.env.BATCH_START}, BATCH_END=${process.env.BATCH_END}`
  );

  if (activeChunkLabel && !historicalOverride) {
    const cachedChunk = await loadChunkCache(activeChunkLabel);
    trace("chunk-cache:lookup", {
      label: activeChunkLabel,
      hit: Boolean(cachedChunk),
      seasons: cachedChunk?.seasons?.length ?? 0
    });
    if (cachedChunk) {
      if (cachedChunk?.seasons?.length) {
        markSeasonStatusBatch(cachedChunk.seasons);
      }
      try {
        const normalizedSeasons = new Set();
        if (Array.isArray(cachedChunk?.seasons)) {
          for (const entry of cachedChunk.seasons) {
            const season = normaliseSeasonValue(entry);
            if (Number.isFinite(season)) {
              normalizedSeasons.add(season);
            }
          }
        }
        if (!normalizedSeasons.size && chunkSelection?.start != null && chunkSelection?.end != null) {
          for (let season = chunkSelection.start; season <= chunkSelection.end; season += 1) {
            if (Number.isFinite(season)) {
              normalizedSeasons.add(season);
            }
          }
        }
        for (const season of normalizedSeasons) {
          markSeasonStatus(season);
        }
      } catch (err) {
        warn(
          `[train] Unable to update cached chunk status markers: ${err?.message || err}`
        );
      }
      console.log(
        `[train] Historical bootstrap chunk ${chunkSelection.start}-${chunkSelection.end} already cached – skipping.`
      );
      const processedSeasonsForFinalize =
        Array.isArray(cachedChunk?.seasons) && cachedChunk.seasons.length
          ? cachedChunk.seasons
          : Array.from(normalizedSeasons);
      state = await finalizeStrictWindow({
        chunkSelection,
        processedSeasons: processedSeasonsForFinalize,
        state
      });
      saveTrainingState(state);
      touchStrictBatchStatusIfAny();
      return;
    }
  }

  const requestedRangeLabel = explicitWindow
    ? `${explicitWindow.start}-${explicitWindow.end}`
    : "auto";

  if (!activeSeasons.length) {
    trace("active-seasons:empty", {
      chunkSelection: chunkSelection
        ? { start: chunkSelection.start, end: chunkSelection.end }
        : null,
      bootstrapRequired
    });
    if (bootstrapRequired) {
      console.log(
        `[train] Historical bootstrap already satisfied for requested chunk range ${requestedRangeLabel}.`
      );
    }
    const strictSeasonsFallback = chunkSelection ? expandSeasonsFromSelection(chunkSelection) : [];
    state = await finalizeStrictWindow({
      chunkSelection,
      processedSeasons: [],
      state
    });
    if (chunkSelection) {
      console.log(
        `[train] Chunk ${chunkSelection.start}-${chunkSelection.end}: recorded ${strictSeasonsFallback.length} seasons.`
      );
    }
    saveTrainingState(state);
    touchStrictBatchStatusIfAny();
    return;
  }

  if (bootstrapRequired && chunkSelection) {
    console.log(
      `[train] Historical bootstrap chunk ${chunkSelection.start}-${chunkSelection.end} (${activeSeasons.length} seasons, batch size ${HISTORICAL_BATCH_SIZE}).`
    );
  } else if (bootstrapRequired) {
    console.log(
      `[train] Historical bootstrap required (expected revision ${CURRENT_BOOTSTRAP_REVISION}). Replaying seasons: ${activeSeasons.join(", ")}`
    );
  } else if (historicalOverride) {
    console.log(
      `[train] Historical rewrite requested via override flag. Processing seasons: ${activeSeasons.join(", ")}`
    );
  } else {
    const resumeWeek = Number.isFinite(Number(lastModelRun?.week)) ? Number(lastModelRun.week) + 1 : 1;
    if (lastModelRun?.season) {
      console.log(
        `[train] Cached bootstrap ${CURRENT_BOOTSTRAP_REVISION} detected. Resuming from season ${lastModelRun.season} week ${resumeWeek}.`
      );
    } else {
      console.log(
        `[train] Cached bootstrap ${CURRENT_BOOTSTRAP_REVISION} detected. No prior run recorded; training target season ${targetSeason}.`
      );
    }
  }

  const processedSeasons = [];
  const seasonWeekMax = new Map();
  let latestTargetResult = null;

  const annCheckpoint = await loadAnnCheckpoint();
  let annWarmStartModel = annCheckpoint?.model ?? null;
  if (annWarmStartModel) {
    const chunkInfo = annCheckpoint?.chunk;
    const chunkLabelLog = chunkInfo && Number.isFinite(chunkInfo.start) && Number.isFinite(chunkInfo.end)
      ? `${chunkInfo.start}-${chunkInfo.end}`
      : "previous run";
    const seasonLog = Number.isFinite(annCheckpoint?.season) ? ` season ${annCheckpoint.season}` : "";
    const weekLog = Number.isFinite(annCheckpoint?.week)
      ? ` week ${String(annCheckpoint.week).padStart(2, "0")}`
      : "";
    console.log(`[train] Restored ANN warm-start checkpoint from ${chunkLabelLog}${seasonLog}${weekLog}.`);
  }

  const smokeTest = process.env.TRAINER_SMOKE_TEST === "1";

  const loadLimiter = createLimiter(SEASON_BUILD_CONCURRENCY);
  const seasonLoadPromises = new Map();
  if (!smokeTest) {
    for (const season of activeSeasons) {
      seasonLoadPromises.set(season, loadLimiter(() => loadSeasonDataCached(season)));
    }
  }
  if (!smokeTest && bootstrapRequired && activeSeasons.length > 1) {
    await Promise.all(seasonLoadPromises.values());
  }

  const weekLimiter = createLimiter(WEEK_TASK_CONCURRENCY);

    for (const resolvedSeason of activeSeasons) {
      let _seasonMarked = false;
      const _markSeasonOnce = () => {
        if (_seasonMarked) return false;
        markSeasonStatus(resolvedSeason);
        _seasonMarked = true;
        return true;
      };

      try {
        if (annWarmStartModel) {
          console.log(
            `[train] Season ${resolvedSeason}: continuing ANN warm-start from prior checkpoint.`
          );
        } else {
          console.log(`[train] Season ${resolvedSeason}: ANN warm-start not found; initialising fresh.`);
        }
        if (smokeTest) {
          processedSeasons.push({ season: resolvedSeason, weeks: [1] });
          seasonWeekMax.set(resolvedSeason, 1);
          if (_markSeasonOnce() && !historicalOverride) {
            console.log(`[train] Season ${resolvedSeason}: status marked (smoke test).`);
        }
        continue;
      }
      logDataCoverage(resolvedSeason);
      const sharedData = await (seasonLoadPromises.get(resolvedSeason) ?? loadSeasonDataCached(resolvedSeason));
      const cachedSeason = !historicalOverride ? await loadSeasonCache(resolvedSeason) : null;
      const seasonMarkerExists = !historicalOverride && seasonStatusExists(resolvedSeason);
      const isTargetSeason = resolvedSeason === targetSeason && !bootstrapRequired;
      if (seasonMarkerExists && cachedSeason?.weeks?.length && !isTargetSeason) {
        console.log(
          `[train] Season ${resolvedSeason}: season completion marker detected – skipping.`
        );
        processedSeasons.push({ season: resolvedSeason, weeks: cachedSeason.weeks });
        const cachedMaxWeek = cachedSeason.weeks[cachedSeason.weeks.length - 1];
        if (Number.isFinite(cachedMaxWeek)) {
          seasonWeekMax.set(resolvedSeason, cachedMaxWeek);
        }
        if (_markSeasonOnce()) {
          console.log(`[train] Season ${resolvedSeason}: status marked (skip: cached).`);
        }
        continue;
      }
      if (cachedSeason?.weeks?.length && !historicalOverride && !isTargetSeason) {
        console.log(
          `[train] Season ${resolvedSeason}: previously completed (${cachedSeason.weeks.length} weeks) – skipping.`
        );
        processedSeasons.push({ season: resolvedSeason, weeks: cachedSeason.weeks });
        const cachedMaxWeek = cachedSeason.weeks[cachedSeason.weeks.length - 1];
        if (Number.isFinite(cachedMaxWeek)) {
          seasonWeekMax.set(resolvedSeason, cachedMaxWeek);
        }
        if (_markSeasonOnce()) {
          console.log(`[train] Season ${resolvedSeason}: status marked (skip: cached).`);
        }
        continue;
      }
      const seasonWeeks = [...new Set(
        sharedData.schedules
          .filter((game) => Number(game.season) === resolvedSeason && isRegularSeason(game.season_type))
          .map((game) => Number(game.week))
          .filter((wk) => Number.isFinite(wk) && wk >= 1)
      )].sort((a, b) => a - b);

      if (!seasonWeeks.length) {
        warn(`[train] Season ${resolvedSeason}: no regular-season weeks found. Skipping.`);
        if (_markSeasonOnce() && !historicalOverride) {
          console.log(`[train] Season ${resolvedSeason}: marked complete (no weeks).`);
        }
        continue;
      }

      const maxAvailableWeek = seasonWeeks[seasonWeeks.length - 1];
      const finalWeek = resolvedSeason === targetSeason && !bootstrapRequired
        ? Math.min(Math.max(1, Math.floor(weekEnv)), maxAvailableWeek)
        : maxAvailableWeek;

      let startWeek = seasonWeeks[0];
      if (!allowHistoricalRewrite && lastModelRun?.season === resolvedSeason) {
        const priorWeek = Number.parseInt(lastModelRun?.week ?? "", 10);
        if (Number.isFinite(priorWeek)) {
          const desiredWeek = Math.max(1, Math.min(finalWeek, priorWeek + 1));
          const idx = seasonWeeks.findIndex((wk) => wk >= desiredWeek);
          startWeek = idx === -1 ? finalWeek : seasonWeeks[idx];
        }
      }

      const trainWeek = async (wk, { isTargetWeek }) => {
        if (!historicalOverride && weekStatusExists(resolvedSeason, wk)) {
          console.log(
            `[train] Season ${resolvedSeason} week ${wk}: completion marker detected – skipping.`
          );
          return {
            season: resolvedSeason,
            week: wk,
            schedules: sharedData.schedules,
            skipped: true
          };
        }
        const hasArtifacts = weekArtifactsExist(resolvedSeason, wk);
        if (!historicalOverride && hasArtifacts && !isTargetWeek) {
          console.log(
            `[train] Season ${resolvedSeason} week ${wk}: cached artifacts detected – skipping retrain.`
          );
          markWeekStatus(resolvedSeason, wk);
          return {
            season: resolvedSeason,
            week: wk,
            schedules: sharedData.schedules,
            skipped: true
          };
        }
        const result = await runTraining({
          season: resolvedSeason,
          week: wk,
          data: sharedData,
          options: { annWarmStart: annWarmStartModel }
        });
        if (!result?.skipped && result?.annModel) {
          annWarmStartModel = result.annModel;
          await saveAnnCheckpoint({
            model: annWarmStartModel,
            season: resolvedSeason,
            week: wk,
            chunkSelection
          });
        }
        if (!allowHistoricalRewrite && hasArtifacts && !isTargetWeek) {
          console.log(
            `[train] skipping artifact write for season ${resolvedSeason} week ${wk} (historical artifacts locked)`
          );
        } else if (!result?.skipped) {
          await writeArtifacts(result);
        }
        if (result?.skipped) {
          console.log(`Skipped ensemble retrain for season ${resolvedSeason} week ${wk}`);
          markWeekStatus(resolvedSeason, wk);
        } else {
          console.log(`Trained ensemble for season ${result.season} week ${result.week}`);
          markWeekStatus(resolvedSeason, wk);
        }
        return result;
      };

        let weekResults = [];
        for (const wk of seasonWeeks) {
          if (wk < startWeek) continue;
          if (wk > finalWeek) break;
          const isTargetWeek = resolvedSeason === targetSeason && wk === finalWeek;
          const result = await weekLimiter(() => trainWeek(wk, { isTargetWeek }));
          if (result) weekResults.push(result);
        }

        weekResults.sort((a, b) => a.week - b.week);

        if (!weekResults.length && Number.isFinite(finalWeek)) {
          const fallbackResult = await weekLimiter(() => trainWeek(finalWeek, { isTargetWeek: true }));
          weekResults = fallbackResult ? [fallbackResult] : [];
        }

      if (!weekResults.length) {
        warn(`[train] Season ${resolvedSeason}: no evaluable weeks after filtering.`);
        if (_markSeasonOnce() && !historicalOverride) {
          console.log(`[train] Season ${resolvedSeason}: marked complete (no evaluable weeks).`);
        }
        continue;
      }

      const processedWeeks = Array.from(new Set(weekResults.map((entry) => entry.week))).sort((a, b) => a - b);
      processedSeasons.push({ season: resolvedSeason, weeks: processedWeeks });
      const maxWeek = processedWeeks[processedWeeks.length - 1];
      if (Number.isFinite(maxWeek)) {
        seasonWeekMax.set(resolvedSeason, maxWeek);
      }

      if (processedWeeks.length) {
        await writeSeasonCache({ season: resolvedSeason, weeks: processedWeeks });
        if (_markSeasonOnce() && !historicalOverride) {
          console.log(`[train] Season ${resolvedSeason}: status marked (processed weeks).`);
        }
      }

      if (resolvedSeason === targetSeason) {
        latestTargetResult = weekResults[weekResults.length - 1];
      }

      const latestSeasonResult = weekResults[weekResults.length - 1];
      if (latestSeasonResult) {
        await updateHistoricalArtifacts({ season: latestSeasonResult.season, schedules: latestSeasonResult.schedules });
      }
    } finally {
      if (_markSeasonOnce() && !historicalOverride) {
        console.log(`[train] Season ${resolvedSeason}: status marked (finalize).`);
      }
    }
  }

  state = await finalizeStrictWindow({ chunkSelection, processedSeasons, state });
  if (chunkSelection) {
    const seasonsForLog = processedSeasons.length
      ? processedSeasons
      : expandSeasonsFromSelection(chunkSelection);
    console.log(
      `[train] Chunk ${chunkSelection.start}-${chunkSelection.end}: recorded ${seasonsForLog.length} seasons.`
    );
  }

  if (!historicalOverride) {
    const markEntries = [];

    if (Array.isArray(activeSeasons)) {
      for (const season of activeSeasons) {
        if (Number.isFinite(season)) {
          markEntries.push({ season });
        }
      }
    }

    if (processedSeasons.length) {
      markEntries.push(...processedSeasons);
    }

    if (chunkSelection?.seasons?.length) {
      markEntries.push(...chunkSelection.seasons);
    }

    markSeasonStatusBatch(markEntries);

    const bootstrapCoverage = Array.isArray(state?.bootstraps?.[BOOTSTRAP_KEYS.MODEL]?.seasons)
      ? state.bootstraps[BOOTSTRAP_KEYS.MODEL].seasons
      : [];
    if (bootstrapCoverage.length) {
      const coverageSeasons = bootstrapCoverage
        .map((entry) => normaliseSeasonValue(entry))
        .filter((season) => Number.isFinite(season));
      if (coverageSeasons.length) {
        markSeasonStatusBatch(coverageSeasons);
      }
    }
  }

  if (bootstrapRequired) {
    const bootstrapRecord = state?.bootstraps?.[BOOTSTRAP_KEYS.MODEL] ?? {};
    const historicalSeasonsNeeded = uniqueSeasons.filter((season) =>
      historicalUpperBound === null ? true : season <= historicalUpperBound
    );
    const aggregate = new Map();
    const recordChunks = Array.isArray(bootstrapRecord.chunks) ? bootstrapRecord.chunks : [];
    const mergeSeasonEntry = (entry) => {
      const season = normaliseSeason(entry?.season);
      if (season === null) return;
      const bucket = aggregate.get(season) ?? new Set();
      const weeks = Array.isArray(entry?.weeks) ? entry.weeks : [];
      for (const wk of weeks) {
        const wkNum = Number.parseInt(wk, 10);
        if (Number.isFinite(wkNum)) bucket.add(wkNum);
      }
      aggregate.set(season, bucket);
    };
    for (const chunk of recordChunks) {
      if (Array.isArray(chunk?.seasons)) {
        chunk.seasons.forEach(mergeSeasonEntry);
      }
    }
    processedSeasons.forEach(mergeSeasonEntry);

    const coverageComplete = historicalSeasonsNeeded.every((season) => aggregate.has(season));
    if (coverageComplete) {
      const seasonsPayload = Array.from(aggregate.entries())
        .map(([season, weeks]) => ({ season, weeks: Array.from(weeks).sort((a, b) => a - b) }))
        .sort((a, b) => a.season - b.season);
      state = markBootstrapCompleted(state, BOOTSTRAP_KEYS.MODEL, {
        seasons: seasonsPayload,
        chunks: recordChunks
      });
      console.log(
        `[train] Historical bootstrap revision ${CURRENT_BOOTSTRAP_REVISION} now covers seasons ${seasonsPayload[0]?.season ?? ""}-${seasonsPayload[seasonsPayload.length - 1]?.season ?? ""}.`
      );
    }
  }

  const runSummary = latestTargetResult
    ? { season: latestTargetResult.season, week: latestTargetResult.week }
    : { season: targetSeason, week: Math.max(1, Math.floor(weekEnv)) };

  if (seasonWeekMax.size) {
    runSummary.by_season = Object.fromEntries(
      Array.from(seasonWeekMax.entries())
        .filter(([season, week]) => Number.isFinite(season) && Number.isFinite(week))
        .sort((a, b) => a[0] - b[0])
    );
  }

  state = recordLatestRun(state, BOOTSTRAP_KEYS.MODEL, runSummary);

  saveTrainingState(state);
}

if (isDirectCliRun()) {
  const cli = parseCliArgs();
  mainOld(cli).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { runWeeklyWorkflow };

