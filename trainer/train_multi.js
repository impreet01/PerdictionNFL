// trainer/train_multi.js
// Compatibility façade over the historical trainer while exposing a new
// cumulative→rolling orchestrator for experimentation.
// Run with: node trainer/train_multi.js --mode=daily
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatBatchWindowLog as legacyFormatBatchWindowLog,
  resolveHistoricalChunkSelection as legacyResolveHistoricalChunkSelection,
  runTraining as legacyRunTraining,
  writeArtifacts as legacyWriteArtifacts,
  updateHistoricalArtifacts as legacyUpdateHistoricalArtifacts,
} from './train_multiOLD.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_DIR = path.join(__dirname, '..', 'state');
const OUTPUTS_DIR = path.join(__dirname, '..', 'outputs');
const MODELS_DIR = path.join(__dirname, '..', 'models');

const STATE_FILE = path.join(STATE_DIR, 'model_state.json');
const LEGACY_STATE_CANDIDATES = [
  path.join(__dirname, '..', 'state', 'state.json'),
  path.join(__dirname, '..', 'state.json'),
  path.join(__dirname, '..', 'outputs', 'state.json'),
  path.join(__dirname, '..', 'artifacts', 'training_state.json'),
];
const PRED_DIR = (season) => path.join(OUTPUTS_DIR, String(season));
const WEEK_PRED_FILE = (season, week) =>
  path.join(PRED_DIR(season), `week_${String(week).padStart(2, '0')}_predictions.json`);

function ensureDirs() {
  [STATE_DIR, OUTPUTS_DIR, MODELS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
}

function loadLegacyStateFallback() {
  for (const candidate of LEGACY_STATE_CANDIDATES) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') continue;
      const seasons = Array.isArray(parsed?.bootstraps?.model_training?.seasons)
        ? parsed.bootstraps.model_training.seasons
        : [];
      const seasonNumbers = seasons
        .map((entry) => Number.parseInt(entry?.season ?? entry?.year, 10))
        .filter((season) => Number.isFinite(season));
      const lastSeason = Number.parseInt(parsed?.latest_runs?.model_training?.season, 10);
      const lastWeek = Number.parseInt(parsed?.latest_runs?.model_training?.week, 10);
      return {
        version: 1,
        trainedSeasons: Array.from(new Set(seasonNumbers)).sort((a, b) => a - b),
        lastSeason: Number.isFinite(lastSeason) ? lastSeason : null,
        lastWeek: Number.isFinite(lastWeek) ? lastWeek : null,
        modelSummary: {},
      };
    } catch (err) {
      console.warn(`[train_multi] Failed to read legacy state ${candidate}: ${err?.message ?? err}`);
    }
  }
  return null;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn(`[train_multi] Failed to read state/model_state.json: ${err?.message ?? err}`);
  }
  return (
    loadLegacyStateFallback() ?? {
      version: 1,
      trainedSeasons: [],
      lastSeason: null,
      lastWeek: null,
      modelSummary: {},
    }
  );
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function parseCliArgs(argv = []) {
  const options = {
    mode: 'daily',
    dataRoot: null,
    season: null,
    week: null,
    start: null,
    end: null,
    strictBatch: null,
    rolling: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string' || token.length === 0) continue;
    const match = token.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue ?? argv[i + 1];
    const lower = key.toLowerCase();
    switch (lower) {
      case 'mode':
        options.mode = (value ?? '').toString() || 'daily';
        if (!rawValue) i += 1;
        break;
      case 'dataroot':
      case 'data-root':
        options.dataRoot = value ? path.resolve(value) : null;
        if (!rawValue) i += 1;
        break;
      case 'season':
        options.season = value != null ? Number.parseInt(value, 10) : null;
        if (!rawValue) i += 1;
        break;
      case 'week':
        options.week = value != null ? Number.parseInt(value, 10) : null;
        if (!rawValue) i += 1;
        break;
      case 'start':
        options.start = value != null ? Number.parseInt(value, 10) : null;
        if (!rawValue) i += 1;
        break;
      case 'end':
        options.end = value != null ? Number.parseInt(value, 10) : null;
        if (!rawValue) i += 1;
        break;
      case 'strict-batch':
        options.strictBatch = true;
        break;
      case 'no-strict-batch':
        options.strictBatch = false;
        break;
      case 'rolling':
        options.rolling = true;
        break;
      case 'no-rolling':
        options.rolling = false;
        break;
      default:
        break;
    }
  }
  return options;
}

function resolveSeasonList({ season, start, end }) {
  const seasons = new Set();
  if (Number.isFinite(season)) seasons.add(season);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    for (let year = lo; year <= hi; year += 1) {
      seasons.add(year);
    }
  }
  if (!seasons.size) {
    const current = new Date().getFullYear();
    seasons.add(current);
  }
  return Array.from(seasons).sort((a, b) => a - b);
}

function selectWeeks({ weeks, explicitWeek }) {
  if (Number.isFinite(explicitWeek)) return [explicitWeek];
  if (Array.isArray(weeks) && weeks.length) return weeks;
  return [];
}

async function runRollingWeek({ season, week, state }) {
  const result = await legacyRunTraining({ season, week });
  if (!result || result.skipped) return null;

  ensureDirs();
  fs.mkdirSync(PRED_DIR(result.season), { recursive: true });
  const outputPath = WEEK_PRED_FILE(result.season, result.week);
  const payload = {
    season: result.season,
    week: result.week,
    predictions: result.predictions ?? null,
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

  try {
    await legacyWriteArtifacts(result);
  } catch (err) {
    console.warn(`[train_multi] Failed to write legacy artifacts: ${err?.message ?? err}`);
  }

  if (Array.isArray(result?.schedules) && result.schedules.length) {
    try {
      await legacyUpdateHistoricalArtifacts({ season: result.season, schedules: result.schedules });
    } catch (err) {
      console.warn(`[train_multi] Failed to update historical artifacts: ${err?.message ?? err}`);
    }
  }

  if (!state.trainedSeasons.includes(result.season)) {
    state.trainedSeasons.push(result.season);
    state.trainedSeasons.sort((a, b) => a - b);
  }
  state.lastSeason = result.season;
  state.lastWeek = result.week;
  state.modelSummary[result.season] = result.modelSummary ?? {};
  saveState(state);

  return result;
}

export async function main(options = {}) {
  const cli = parseCliArgs(options.argv ?? []);
  const resolved = {
    mode: options.mode ?? cli.mode ?? 'daily',
    dataRoot: options.dataRoot ?? cli.dataRoot ?? null,
    season: options.season ?? cli.season ?? null,
    week: options.week ?? cli.week ?? null,
    start: options.start ?? cli.start ?? null,
    end: options.end ?? cli.end ?? null,
  };

  const state = loadState();
  if (resolved.dataRoot) {
    process.env.DATA_ROOT = resolved.dataRoot;
  }
  const seasons = resolveSeasonList(resolved);
  const results = [];

  for (const season of seasons) {
    const weeks = selectWeeks({ weeks: resolved.week ? [resolved.week] : [], explicitWeek: resolved.week });
    const targets = weeks.length ? weeks : [null];
    for (const week of targets) {
      if (resolved.mode === 'daily' && Number.isFinite(week)) {
        const predPath = WEEK_PRED_FILE(season, week);
        if (fs.existsSync(predPath)) continue;
      }
      const outcome = await runRollingWeek({ season, week: week ?? undefined, state });
      if (outcome) results.push(outcome);
    }
  }

  saveState(state);
  return { state, results };
}

async function runLegacyCli(argv) {
  const legacyPath = path.join(__dirname, 'train_multiOLD.js');
  const args = [legacyPath, ...argv];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Legacy trainer exited with code ${code}`));
    });
  });
}

async function runCli() {
  const argv = process.argv.slice(2);
  const parsed = parseCliArgs(argv);
  const preferRolling =
    parsed.rolling === true || process.env.TRAIN_MULTI_ROLLING === '1' || process.env.TRAIN_MULTI_ROLLING === 'true';

  if (!preferRolling) {
    const filteredArgv = argv.filter((token) => token !== '--rolling' && token !== '--no-rolling');
    await runLegacyCli(filteredArgv);
    return;
  }

  try {
    await main({ ...parsed, argv });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export const formatBatchWindowLog = legacyFormatBatchWindowLog;
export const resolveHistoricalChunkSelection = legacyResolveHistoricalChunkSelection;
export const runTraining = legacyRunTraining;
export const writeArtifacts = legacyWriteArtifacts;
export const updateHistoricalArtifacts = legacyUpdateHistoricalArtifacts;
export { runWeeklyWorkflow } from './train_multiOLD.js';
