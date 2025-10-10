import fs from "fs";
import path from "path";
import {
  loadTrainingState,
  saveTrainingState,
  shouldRunHistoricalBootstrap,
  markBootstrapCompleted,
  recordLatestRun,
  BOOTSTRAP_KEYS
} from "./trainingState.js";

const ARTIFACTS_DIR = path.resolve("artifacts");
const PREDICTION_PREFIX = "predictions";
const MODEL_PREFIX = "model";
const OUTCOME_PREFIX = "outcomes";
const DIAGNOSTIC_PREFIX = "diagnostics";
const CALIBRATION_WINDOW = 2;

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function formatWeek(week) {
  return String(week).padStart(2, "0");
}

function buildFileName(prefix, season, week, suffix = "") {
  const paddedWeek = formatWeek(week);
  return `${prefix}_${season}_W${paddedWeek}${suffix}.json`;
}

function requireJson(fileName) {
  const fullPath = path.join(ARTIFACTS_DIR, fileName);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Expected artifact missing: ${fileName}`);
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function loadJsonIfExists(fileName) {
  const fullPath = path.join(ARTIFACTS_DIR, fileName);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function normaliseWeights(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const keys = ["logistic", "tree", "bt", "ann"];
  const weights = {};
  let total = 0;
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value > 0) {
      weights[key] = value;
      total += value;
    } else {
      weights[key] = 0;
    }
  }
  if (total <= 0) {
    return null;
  }
  for (const key of keys) {
    weights[key] = weights[key] / total;
  }
  return weights;
}

function deriveBlendWeights({ season, week, model }) {
  const prevWeek = week - 1;
  if (prevWeek >= 1) {
    const diagnosticName = buildFileName(DIAGNOSTIC_PREFIX, season, prevWeek, "");
    const diagnostic = loadJsonIfExists(diagnosticName);
    const fromDiagnostics = normaliseWeights(diagnostic?.blend_weights);
    if (fromDiagnostics) {
      return fromDiagnostics;
    }
  }

  const fromModel = normaliseWeights(model?.ensemble?.blend_weights || model?.ensemble?.weights);
  if (fromModel) {
    return fromModel;
  }

  const fallback = { logistic: 0.25, tree: 0.25, bt: 0.25, ann: 0.25 };
  return fallback;
}

function collectCalibrationSamples({ season, week }) {
  const x = [];
  const y = [];
  const weeksUsed = [];

  for (let offset = 1; offset <= CALIBRATION_WINDOW; offset += 1) {
    const targetWeek = week - offset;
    if (targetWeek < 1) {
      continue;
    }
    const outcomeName = buildFileName(OUTCOME_PREFIX, season, targetWeek, "");
    const outcomeData = loadJsonIfExists(outcomeName);
    if (!Array.isArray(outcomeData) || !outcomeData.length) {
      continue;
    }
    weeksUsed.push(targetWeek);
    for (const game of outcomeData) {
      const predicted = Number(
        game?.predicted?.blended ??
          game?.predicted?.forecast ??
          game?.predicted?.logistic ??
          game?.forecast
      );
      const actual = Number(
        game?.actual?.home_win ??
          (game?.actual?.home_points != null && game?.actual?.away_points != null
            ? game.actual.home_points > game.actual.away_points
              ? 1
              : 0
            : null)
      );
      if (!Number.isFinite(predicted) || predicted < 0 || predicted > 1) {
        continue;
      }
      if (!Number.isFinite(actual)) {
        continue;
      }
      x.push(predicted);
      y.push(actual);
    }
  }

  return { x, y, weeksUsed };
}

function fitCalibration({ season, week }) {
  const { x, y, weeksUsed } = collectCalibrationSamples({ season, week });
  if (!x.length || !y.length) {
    return {
      beta: 1,
      intercept: 0,
      sampleSize: 0,
      weeksUsed
    };
  }
  const n = x.length;
  const mean = (arr) => arr.reduce((sum, value) => sum + value, 0) / arr.length;
  const mx = mean(x);
  const my = mean(y);
  const covariance = x.reduce((sum, value, idx) => sum + (value - mx) * (y[idx] - my), 0);
  const variance = x.reduce((sum, value) => sum + (value - mx) ** 2, 0);
  let beta = variance === 0 ? 0 : covariance / variance;
  if (!Number.isFinite(beta)) {
    beta = 0;
  }
  let intercept = my - beta * mx;
  if (!Number.isFinite(intercept)) {
    intercept = 0;
  }
  return { beta, intercept, sampleSize: n, weeksUsed };
}

function applyHybridV2(predictions, beta, intercept) {
  if (!Array.isArray(predictions)) {
    return predictions;
  }
  for (const entry of predictions) {
    const base = Number(entry?.forecast ?? entry?.probs?.blended);
    if (!Number.isFinite(base)) {
      continue;
    }
    const calibrated = sigmoid(beta * base + intercept);
    entry.forecast_hybrid_v2 = calibrated;
  }
  return predictions;
}

function persistCalibrationHistory({ season, week, beta, intercept, weights }) {
  const record = {
    week,
    beta,
    intercept,
    logistic: weights.logistic,
    tree: weights.tree,
    bt: weights.bt,
    ann: weights.ann,
    timestamp: new Date().toISOString()
  };
  const header = Object.keys(record).join(",");
  const row = Object.values(record)
    .map((value) => (typeof value === "number" ? value.toString() : value))
    .join(",");
  const csvPath = path.join(ARTIFACTS_DIR, `calibration_history_${season}.csv`);
  const needsHeader = !fs.existsSync(csvPath);
  const contents = `${needsHeader ? `${header}\n` : ""}${row}\n`;
  fs.appendFileSync(csvPath, contents, "utf8");
}

function discoverSeasonWeekPairs() {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    return [];
  }
  const entries = fs.readdirSync(ARTIFACTS_DIR);
  const modelPattern = new RegExp(`^${MODEL_PREFIX}_(\\d{4})_W(\\d{2})\\.json$`);
  const seasonMap = new Map();
  for (const entry of entries) {
    const match = entry.match(modelPattern);
    if (!match) continue;
    const season = Number(match[1]);
    const week = Number(match[2]);
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue;
    const predictionName = buildFileName(PREDICTION_PREFIX, season, week, "");
    if (!fs.existsSync(path.join(ARTIFACTS_DIR, predictionName))) continue;
    if (!seasonMap.has(season)) {
      seasonMap.set(season, new Set());
    }
    seasonMap.get(season).add(week);
  }
  return Array.from(seasonMap.entries())
    .map(([season, weeks]) => ({ season, weeks: Array.from(weeks).sort((a, b) => a - b) }))
    .sort((a, b) => a.season - b.season);
}

function runHybridBootstrap(state) {
  const discovered = discoverSeasonWeekPairs();
  const processed = [];
  for (const entry of discovered) {
    const completedWeeks = [];
    for (const week of entry.weeks) {
      try {
        runHybridV2(entry.season, week, { state, updateState: false });
        completedWeeks.push(week);
      } catch (err) {
        console.warn(
          `[hybrid/bootstrap] failed for season ${entry.season} week ${week}: ${err?.message || err}`
        );
      }
    }
    if (completedWeeks.length) {
      processed.push({ season: entry.season, weeks: completedWeeks });
    }
  }
  if (processed.length) {
    markBootstrapCompleted(state, BOOTSTRAP_KEYS.HYBRID, {
      seasons: processed.map(({ season, weeks }) => ({ season, weeks }))
    });
  }
  return processed;
}

export function runHybridV2(season, week, options = {}) {
  const { state: providedState = null, updateState = true } = options;
  if (!Number.isInteger(season) || season < 1900) {
    throw new Error(`Invalid season provided: ${season}`);
  }
  if (!Number.isInteger(week) || week < 1) {
    throw new Error(`Invalid week provided: ${week}`);
  }

  const modelFileName = buildFileName(MODEL_PREFIX, season, week, "");
  const predictionsFileName = buildFileName(PREDICTION_PREFIX, season, week, "");

  const model = requireJson(modelFileName);
  const predictions = requireJson(predictionsFileName);

  const weights = deriveBlendWeights({ season, week, model });
  const { beta, intercept } = fitCalibration({ season, week });

  model.ensemble = model.ensemble || {};
  model.ensemble.blend_weights = weights;
  model.ensemble.weights = weights;
  model.ensemble.calibration_beta = beta;
  model.ensemble.calibration_intercept = intercept;
  fs.writeFileSync(path.join(ARTIFACTS_DIR, modelFileName), JSON.stringify(model, null, 2));

  const calibratedPredictions = applyHybridV2(predictions, beta, intercept);
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, predictionsFileName),
    JSON.stringify(calibratedPredictions, null, 2)
  );

  persistCalibrationHistory({ season, week, beta, intercept, weights });

  if (updateState) {
    const state = providedState ?? loadTrainingState();
    recordLatestRun(state, BOOTSTRAP_KEYS.HYBRID, { season, week });
    saveTrainingState(state);
  }

  console.table({ season, week, beta, intercept, ...weights });
  console.log(
    `Hybrid v2 calibration complete for season ${season} week ${week} → updated ${modelFileName}, ${predictionsFileName}`
  );
  return { beta, intercept, weights };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const season = Number.parseInt(process.env.SEASON ?? new Date().getFullYear(), 10);
  const week = Number.parseInt(process.env.WEEK ?? "1", 10);
  let state = loadTrainingState();
  const bootstrapRequired = shouldRunHistoricalBootstrap(state, BOOTSTRAP_KEYS.HYBRID);

  if (bootstrapRequired) {
    const processed = runHybridBootstrap(state);
    if (processed.length) {
      const summary = processed
        .map((entry) => `${entry.season}:W${entry.weeks.join("/")}`)
        .join(", ");
      console.log(`[hybrid/bootstrap] completed initial calibration for ${summary}`);
    } else {
      console.log("[hybrid/bootstrap] no historical calibrations executed (missing artifacts?)");
    }
    saveTrainingState(state);
  }

  runHybridV2(season, week, { state });
}
