// trainer/train_multi.js
// ESM. Run with: node trainer/train_multi.js --mode=daily
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFeaturesForSeason } from './featureBuild.js';
import { buildFeaturesForBacktest } from './featureBuild_bt.js';
import { loadContextPacks } from './contextPack.js';
import { loadDataSources } from './dataSources.js';
import { assertSchema } from './schemaValidator.js';
import { ModelProvider } from './utils/modelProvider.js'; // new small adapter (below)
import { logger } from './utils/logger.js';              // simple wrapper around console
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
const PRED_DIR = (season) => path.join(OUTPUTS_DIR, String(season));
const WEEK_PRED_FILE = (season, week) => path.join(PRED_DIR(season), `week_${week}_predictions.json`);

function ensureDirs() {
  [STATE_DIR, OUTPUTS_DIR, MODELS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {
      version: 1,
      trainedSeasons: [],
      lastSeason: null,
      lastWeek: null,
      modelSummary: {},
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function listAvailableSeasons(dataRoot) {
  // If you already have a function for this, call it. Otherwise infer from folder names under data/.
  const root = dataRoot ?? path.join(__dirname, '..', 'data');
  if (!fs.existsSync(root)) return [];
  const dirs = fs.readdirSync(root).filter((x) => /^\d{4}$/.test(x)).map(Number);
  return dirs.sort((a, b) => a - b);
}

function listWeeksForSeason(dataRoot, season) {
  // If you already track weeks, use that. Else infer from files under data/<season>/...
  const seasonDir = path.join(dataRoot ?? path.join(__dirname, '..', 'data'), String(season));
  if (!fs.existsSync(seasonDir)) return [];
  // naive: look for any week_* files
  const weeks = new Set();
  for (const f of fs.readdirSync(seasonDir)) {
    const m = f.match(/week[_-]?(\d{1,2})/i);
    if (m) weeks.add(Number(m[1]));
  }
  return [...weeks].sort((a, b) => a - b);
}

async function main() {
  ensureDirs();

  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v = true] = a.includes('=') ? a.split('=') : a.split('--').filter(Boolean);
      return [k.replace(/^--/, ''), v];
    })
  );
  const mode = args.mode ?? 'daily';
  const dataRoot = args.dataRoot ? path.resolve(args.dataRoot) : path.join(__dirname, '..', 'data');

  logger.info(`Mode: ${mode}`);
  logger.info(`Data root: ${dataRoot}`);

  // Load support systems
  const ctx = await loadContextPacks({ dataRoot });
  const sources = await loadDataSources({ dataRoot });
  assertSchema(ctx, 'contextPack'); // no-op if already validated
  assertSchema(sources, 'dataSources');

  const seasons = listAvailableSeasons(dataRoot);
  if (seasons.length === 0) {
    logger.warn('No seasons found under data/. Exiting.');
    process.exit(0);
  }

  const state = loadState();
  const model = new ModelProvider({
    modelsDir: MODELS_DIR,
    seed: 42, // deterministic
    log: logger,
  });

  // 1) Train cumulatively on prior seasons
  for (const season of seasons) {
    const already = state.trainedSeasons.includes(season);
    const weeks = listWeeksForSeason(dataRoot, season);

    if (!weeks.length) {
      logger.warn(`No weeks for season ${season}; skipping`);
      continue;
    }

    // Build features for the whole season (or only up to last completed week)
    const feat = await buildFeaturesForSeason({
      season,
      weeks,
      ctx,
      sources,
      dataRoot,
      outputsDir: OUTPUTS_DIR,
    });

    // Defensive schema check(s)
    assertSchema(feat.meta, 'featuresMeta');
    assertSchema(feat.frame, 'featuresFrame');

    // Train/Update cumulative model
    logger.info(`Training on season ${season} (${weeks.length} weeks)`);
    await model.fitIncremental(feat.frame, feat.meta);

    if (!already) {
      state.trainedSeasons.push(season);
      state.trainedSeasons.sort((a, b) => a - b);
    }
    state.lastSeason = season;
    state.lastWeek = Math.max(...weeks);

    // Persist intermediate state
    state.modelSummary[season] = await model.summarize();
    saveState(state);
  }

  // 2) If we are in the latest season, roll forward week-by-week predictions
  const latestSeason = Math.max(...seasons);
  const latestWeeks = listWeeksForSeason(dataRoot, latestSeason);
  if (latestWeeks.length) {
    for (const week of latestWeeks) {
      const predPath = WEEK_PRED_FILE(latestSeason, week);
      if (fs.existsSync(predPath) && mode === 'daily') {
        logger.info(`Week ${week} predictions exist; skipping (daily mode).`);
        continue;
      }

      const featBT = await buildFeaturesForBacktest({
        season: latestSeason,
        week,
        ctx,
        sources,
        dataRoot,
        outputsDir: OUTPUTS_DIR,
      });

      assertSchema(featBT.meta, 'featuresMeta');
      assertSchema(featBT.frame, 'featuresFrame');

      const preds = await model.predict(featBT.frame, featBT.meta);
      fs.mkdirSync(PRED_DIR(latestSeason), { recursive: true });
      fs.writeFileSync(predPath, JSON.stringify({ season: latestSeason, week, preds }, null, 2));
      logger.info(`Wrote predictions → ${path.relative(__dirname, predPath)}`);
    }
  }

  // 3) Save final state
  saveState(state);
  logger.info('Training + prediction complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export const formatBatchWindowLog = legacyFormatBatchWindowLog;
export const resolveHistoricalChunkSelection = legacyResolveHistoricalChunkSelection;
export const runTraining = legacyRunTraining;
export const writeArtifacts = legacyWriteArtifacts;
export const updateHistoricalArtifacts = legacyUpdateHistoricalArtifacts;
