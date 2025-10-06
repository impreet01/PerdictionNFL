import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const ARTIFACT_DIR = path.join(ROOT_DIR, "artifacts");
const HYBRID_DIR = path.join(ARTIFACT_DIR, "hybrid_v2");

const EPS = 1e-12;
const DRIFT_LIMIT_DEFAULT = 5;

function padWeek(week) {
  return String(week).padStart(2, "0");
}

function safeProb(value) {
  if (!Number.isFinite(value)) return 0.5;
  if (value <= EPS) return EPS;
  if (value >= 1 - EPS) return 1 - EPS;
  return value;
}

function sigmoid(x) {
  if (!Number.isFinite(x)) return 0.5;
  if (x >= 40) return 1;
  if (x <= -40) return 0;
  return 1 / (1 + Math.exp(-x));
}

function computeAuc(labels, scores) {
  const paired = labels
    .map((label, idx) => ({ label, score: safeProb(scores[idx]) }))
    .filter((entry) => entry.label === 0 || entry.label === 1);
  const positives = paired.filter((p) => p.label === 1).length;
  const negatives = paired.filter((p) => p.label === 0).length;
  if (!positives || !negatives) return 0.5;
  const sorted = [...paired]
    .map((entry, idx) => ({ ...entry, idx }))
    .sort((a, b) => a.score - b.score);
  let i = 0;
  let rankSumPos = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].score === sorted[i].score) {
      j += 1;
    }
    const avgRank = (i + j + 1) / 2; // 1-indexed average rank for the tie block
    for (let k = i; k < j; k++) {
      if (sorted[k].label === 1) {
        rankSumPos += avgRank;
      }
    }
    i = j;
  }
  const auc = (rankSumPos - (positives * (positives + 1)) / 2) / (positives * negatives);
  return Math.max(0, Math.min(1, auc));
}

function computeLogLoss(labels, scores) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    const y = labels[i];
    if (y !== 0 && y !== 1) continue;
    const p = safeProb(scores[i]);
    sum += y * Math.log(p) + (1 - y) * Math.log(1 - p);
    count += 1;
  }
  if (!count) return 0;
  return -sum / count;
}

function computeBrier(labels, scores) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    const y = labels[i];
    if (y !== 0 && y !== 1) continue;
    const p = safeProb(scores[i]);
    const diff = p - y;
    sum += diff * diff;
    count += 1;
  }
  if (!count) return 0;
  return sum / count;
}

function calibrationBins(labels, scores, binCount = 10) {
  const bins = Array.from({ length: binCount }, () => ({
    count: 0,
    sumPred: 0,
    sumActual: 0
  }));
  for (let i = 0; i < labels.length; i++) {
    const y = labels[i];
    if (y !== 0 && y !== 1) continue;
    const p = safeProb(scores[i]);
    const idx = Math.min(binCount - 1, Math.floor(p * binCount));
    const bin = bins[idx];
    bin.count += 1;
    bin.sumPred += p;
    bin.sumActual += y;
  }
  return bins.map((bin, index) => ({
    bin: index,
    count: bin.count,
    mean_pred: bin.count ? bin.sumPred / bin.count : null,
    mean_actual: bin.count ? bin.sumActual / bin.count : null
  }));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const withoutPrefix = arg.slice(2);
    if (withoutPrefix.includes("=")) {
      const [rawKey, ...rest] = withoutPrefix.split("=");
      const key = rawKey;
      const value = rest.join("=");
      options[key] = value === "" ? true : value;
      continue;
    }
    const key = withoutPrefix;
    const value = args[i + 1];
    if (value && !value.startsWith("--")) {
      options[key] = value;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

async function readJson(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function writeCsv(filePath, rows, headers) {
  if (!rows.length) {
    await fs.promises.writeFile(filePath, "");
    return;
  }
  const header = headers || Object.keys(rows[0]);
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((h) => formatCsvCell(row[h])).join(","));
  }
  await fs.promises.writeFile(filePath, `${lines.join("\n")}\n`);
}

function formatCsvCell(value) {
  if (value == null) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return value.toString();
  }
  if (typeof value === "string") {
    if (/[,"\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return JSON.stringify(value);
}

function listWeekArtifacts(prefix, ext = ".json") {
  const regex = new RegExp(`^${prefix}_(\\d{4})_W(\\d{2})${ext.replace(/\\./g, "\\.")}$`, "i");
  const files = fs.existsSync(ARTIFACT_DIR) ? fs.readdirSync(ARTIFACT_DIR) : [];
  const matches = [];
  for (const file of files) {
    const match = regex.exec(file);
    if (!match) continue;
    matches.push({
      file,
      season: Number(match[1]),
      week: Number(match[2])
    });
  }
  matches.sort((a, b) => (b.season - a.season) || (b.week - a.week));
  return matches;
}

function resolveSeasonWeek(argsSeason, argsWeek) {
  const listing = listWeekArtifacts("outcomes");
  if (!listing.length) {
    throw new Error("No outcomes artifacts found to resolve season/week");
  }
  let season = argsSeason != null ? Number(argsSeason) : null;
  let week = argsWeek != null ? Number(argsWeek) : null;
  if (season == null || Number.isNaN(season)) {
    season = listing[0].season;
  }
  const candidates = listing.filter((item) => item.season === season);
  if (!candidates.length) {
    throw new Error(`No outcomes for season ${season}`);
  }
  if (week == null || Number.isNaN(week)) {
    week = candidates[0].week;
  }
  const exact = candidates.find((item) => item.week === week);
  if (!exact) {
    throw new Error(`Outcomes missing for season ${season} week ${week}`);
  }
  return { season, week };
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(array) {
  const filtered = array.filter((v) => Number.isFinite(v));
  if (!filtered.length) return 0;
  return filtered.reduce((sum, v) => sum + v, 0) / filtered.length;
}

function clamp(value, limit = DRIFT_LIMIT_DEFAULT) {
  if (!Number.isFinite(value)) return 0;
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}

function loadPrevious(path) {
  if (!fs.existsSync(path)) return null;
  try {
    const raw = fs.readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function computeDrift({ season, week }) {
  const qbContextFile = path.join(ARTIFACT_DIR, `context_${season}_W${padWeek(week)}.json`);
  const btFile = path.join(ARTIFACT_DIR, `bt_features_${season}_W${padWeek(week)}.json`);
  const prevBtFile = path.join(ARTIFACT_DIR, `bt_features_${season}_W${padWeek(Math.max(1, week - 1))}.json`);
  let qbDelta = 0;
  if (fs.existsSync(qbContextFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(qbContextFile, "utf8"));
      const deltas = [];
      for (const game of Array.isArray(data) ? data : []) {
        const home = game?.context?.qb_form?.home?.ypa_3g;
        const away = game?.context?.qb_form?.away?.ypa_3g;
        if (Number.isFinite(home) && Number.isFinite(away)) {
          deltas.push(home - away);
        }
      }
      qbDelta = clamp(mean(deltas), 5);
    } catch (err) {
      qbDelta = 0;
    }
  }
  const rushCurr = [];
  const rushPrev = [];
  const turnoverCurr = [];
  const turnoverPrev = [];
  const marketCurr = [];
  const marketPrev = [];
  if (fs.existsSync(btFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(btFile, "utf8"));
      for (const game of Array.isArray(data) ? data : []) {
        const features = game?.features || {};
        if (Number.isFinite(features.diff_r_ratio)) rushCurr.push(features.diff_r_ratio);
        if (Number.isFinite(features.diff_turnovers)) turnoverCurr.push(features.diff_turnovers);
        if (Number.isFinite(features.diff_elo_pre)) marketCurr.push(features.diff_elo_pre);
      }
    } catch (err) {
      /* noop */
    }
  }
  if (fs.existsSync(prevBtFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(prevBtFile, "utf8"));
      for (const game of Array.isArray(data) ? data : []) {
        const features = game?.features || {};
        if (Number.isFinite(features.diff_r_ratio)) rushPrev.push(features.diff_r_ratio);
        if (Number.isFinite(features.diff_turnovers)) turnoverPrev.push(features.diff_turnovers);
        if (Number.isFinite(features.diff_elo_pre)) marketPrev.push(features.diff_elo_pre);
      }
    } catch (err) {
      /* noop */
    }
  }
  const rushDrift = clamp(mean(rushCurr) - mean(rushPrev), 5);
  const turnoverDrift = clamp(mean(turnoverCurr) - mean(turnoverPrev), 5);
  const marketShift = clamp(mean(marketCurr) - mean(marketPrev), 10);
  return {
    qb_ypa_delta: round(qbDelta, 6),
    rush_epa_drift: round(rushDrift, 6),
    turnover_drift: round(turnoverDrift, 6),
    market_shift: round(marketShift, 6)
  };
}

function updateWeights(baseWeights, auc, fallbackWeights) {
  const safeBase = {
    logistic: Number(baseWeights?.logistic) || 0,
    tree: Number(baseWeights?.tree) || 0,
    bt: Number(baseWeights?.bt) || 0,
    ann: Number(baseWeights?.ann) || 0
  };
  let updated = {
    logistic: safeBase.logistic * (auc > 0.7 ? 1 : 0.9),
    tree: safeBase.tree * 1.05,
    bt: safeBase.bt * 1.02,
    ann: Math.max(0.05, safeBase.ann * (auc / 0.7 || 0))
  };
  const total = Object.values(updated).reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  if (!total || !Number.isFinite(total) || total <= 0) {
    if (fallbackWeights) return fallbackWeights;
    return safeBase;
  }
  updated = Object.fromEntries(
    Object.entries(updated).map(([k, v]) => [k, round(v / total, 6)])
  );
  return updated;
}

function fitCalibration(labels, baseScores, initial = { beta: 1, intercept: 0 }) {
  let beta = Number(initial?.beta) || 1;
  let intercept = Number(initial?.intercept) || 0;
  for (let iter = 0; iter < 25; iter++) {
    let gradB = 0;
    let gradI = 0;
    let hBB = 0;
    let hII = 0;
    let hBI = 0;
    for (let i = 0; i < labels.length; i++) {
      const y = labels[i];
      if (y !== 0 && y !== 1) continue;
      const x = baseScores[i] ?? 0;
      const z = intercept + beta * x;
      const p = sigmoid(z);
      const diff = p - y;
      gradB += diff * x;
      gradI += diff;
      const w = p * (1 - p);
      hBB += w * x * x;
      hII += w;
      hBI += w * x;
    }
    const det = hBB * hII - hBI * hBI;
    if (Math.abs(det) < 1e-6) break;
    const stepB = (hII * gradB - hBI * gradI) / det;
    const stepI = (hBB * gradI - hBI * gradB) / det;
    beta -= stepB;
    intercept -= stepI;
    if (Math.abs(stepB) < 1e-6 && Math.abs(stepI) < 1e-6) break;
  }
  return { beta, intercept };
}

function applyCompression(prob) {
  if (!Number.isFinite(prob)) return 0.5;
  if (prob <= 0.85) return prob;
  return prob - 0.05 * (prob - 0.85);
}

function deriveBaseScores(outcomes, weights) {
  const scores = [];
  for (const game of outcomes) {
    const preds = game?.predicted || {};
    const base =
      (Number(preds.logistic) || 0.5) * (weights.logistic || 0) +
      (Number(preds.decision_tree) || 0.5) * (weights.tree || 0) +
      (Number(preds.bt) || 0.5) * (weights.bt || 0) +
      (Number(preds.ann) || 0.5) * (weights.ann || 0);
    scores.push(base);
  }
  return scores;
}

function mapOutcomes(outcomes) {
  const actuals = [];
  const blended = [];
  const byId = new Map();
  for (const game of outcomes) {
    const actual = Number(game?.actual?.home_win);
    actuals.push(Number.isFinite(actual) ? actual : null);
    const pred = Number(game?.predicted?.blended);
    blended.push(Number.isFinite(pred) ? pred : null);
    if (game?.game_id) byId.set(game.game_id, game);
  }
  return { actuals, blended, byId };
}

function computeContextAdjustment(drift) {
  const qb = Number(drift.qb_ypa_delta) || 0;
  const market = Number(drift.market_shift) || 0;
  const rush = Number(drift.rush_epa_drift) || 0;
  const turnover = Number(drift.turnover_drift) || 0;
  return round(0.25 * qb + 0.15 * market - 0.2 * rush + 0.1 * turnover, 6);
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

async function appendPerformanceLog(entry) {
  const logPath = path.join(HYBRID_DIR, "performance_log.csv");
  const headers = [
    "season",
    "week",
    "auc",
    "logloss",
    "brier",
    "qb_ypa_delta",
    "rush_epa_drift",
    "turnover_drift",
    "market_shift",
    "weight_logistic",
    "weight_tree",
    "weight_bt",
    "weight_ann",
    "beta",
    "intercept",
    "context_adjustment",
    "fallback_used"
  ];
  const exists = fs.existsSync(logPath);
  const line = headers
    .map((key) => formatCsvCell(entry[key]))
    .join(",");
  if (!exists) {
    await fs.promises.writeFile(logPath, `${headers.join(",")}\n${line}\n`);
  } else {
    await fs.promises.appendFile(logPath, `${line}\n`);
  }
}

function buildContextCsvRows(context) {
  const rows = [];
  for (const game of Array.isArray(context) ? context : []) {
    rows.push({
      season: game?.season ?? "",
      week: game?.week ?? "",
      game_id: game?.game_id ?? "",
      home_team: game?.home_team ?? "",
      away_team: game?.away_team ?? "",
      home_qb_ypa_3g: toNumber(game?.context?.qb_form?.home?.ypa_3g),
      away_qb_ypa_3g: toNumber(game?.context?.qb_form?.away?.ypa_3g),
      home_net_yds_3g: toNumber(game?.context?.rolling_strength?.home?.net_yds_3g),
      away_net_yds_3g: toNumber(game?.context?.rolling_strength?.away?.net_yds_3g)
    });
  }
  return rows;
}

function buildOutcomesCsvRows(outcomes) {
  const rows = [];
  for (const game of outcomes) {
    rows.push({
      season: game?.season ?? "",
      week: game?.week ?? "",
      game_id: game?.game_id ?? "",
      home_team: game?.home_team ?? "",
      away_team: game?.away_team ?? "",
      home_points: toNumber(game?.actual?.home_points),
      away_points: toNumber(game?.actual?.away_points),
      home_win: toNumber(game?.actual?.home_win),
      blended_pred: toNumber(game?.predicted?.blended)
    });
  }
  return rows;
}

function buildPredictionsCsvRows(predictions, outputs) {
  const rows = [];
  for (const game of predictions) {
    const derived = outputs.get(game.game_id);
    if (!derived) continue;
    rows.push({
      season: game?.season ?? "",
      week: game?.week ?? "",
      game_id: game?.game_id ?? "",
      home_team: game?.home_team ?? "",
      away_team: game?.away_team ?? "",
      forecast: round(derived.prob, 6),
      base_score: round(derived.base_score, 6),
      context_adjustment: round(derived.context_adjustment, 6),
      qb_ypa_delta: round(derived.drivers.qb_ypa_delta, 6),
      rush_epa_drift: round(derived.drivers.rush_epa_drift, 6),
      turnover_drift: round(derived.drivers.turnover_drift, 6),
      market_shift: round(derived.drivers.market_shift, 6),
      calibration_beta: round(derived.calibration.beta, 6),
      calibration_intercept: round(derived.calibration.intercept, 6),
      weight_logistic: round(derived.weights.logistic, 6),
      weight_tree: round(derived.weights.tree, 6),
      weight_bt: round(derived.weights.bt, 6),
      weight_ann: round(derived.weights.ann, 6)
    });
  }
  return rows;
}

function applyHybrid(probabilities, weights, calibration, contextAdjustment) {
  const baseScore =
    (Number(probabilities.logistic) || 0.5) * (weights.logistic || 0) +
    (Number(probabilities.tree) || Number(probabilities.decision_tree) || 0.5) * (weights.tree || 0) +
    (Number(probabilities.bt) || 0.5) * (weights.bt || 0) +
    (Number(probabilities.ann) || 0.5) * (weights.ann || 0);
  const adjusted = baseScore + contextAdjustment;
  const raw = sigmoid(calibration.intercept + calibration.beta * adjusted);
  const prob = applyCompression(raw);
  return { baseScore, prob };
}

async function main() {
  const args = parseArgs();
  const { season, week } = resolveSeasonWeek(args.season, args.week);
  ensureDir(HYBRID_DIR);
  const outcomesFile = path.join(ARTIFACT_DIR, `outcomes_${season}_W${padWeek(week)}.json`);
  const diagnosticsFile = path.join(ARTIFACT_DIR, `diagnostics_${season}_W${padWeek(week)}.json`);
  const contextNextFile = path.join(ARTIFACT_DIR, `context_${season}_W${padWeek(week + 1)}.json`);
  const predictionsNextFile = path.join(ARTIFACT_DIR, `predictions_${season}_W${padWeek(week + 1)}.json`);

  if (!fs.existsSync(outcomesFile)) throw new Error(`Missing outcomes file ${outcomesFile}`);
  if (!fs.existsSync(diagnosticsFile)) throw new Error(`Missing diagnostics file ${diagnosticsFile}`);
  const hasNextPredictions = fs.existsSync(predictionsNextFile);
  const hasNextContext = fs.existsSync(contextNextFile);

  if (!hasNextPredictions) {
    console.warn(`Upcoming week predictions not found at ${predictionsNextFile}; skipping prediction exports.`);
  }
  if (!hasNextContext) {
    console.warn(`Upcoming week context not found at ${contextNextFile}; skipping context exports.`);
  }

  const outcomes = await readJson(outcomesFile);
  const diagnostics = await readJson(diagnosticsFile);
  const { actuals, blended, byId } = mapOutcomes(outcomes);

  const auc = round(computeAuc(actuals, blended), 6);
  const logloss = round(computeLogLoss(actuals, blended), 6);
  const brier = round(computeBrier(actuals, blended), 6);
  const bins = calibrationBins(actuals, blended);

  const drift = computeDrift({ season, week });
  const updatedWeights = updateWeights(diagnostics?.blend_weights, auc, null);
  const baseScores = deriveBaseScores(outcomes, updatedWeights);
  let calibration = fitCalibration(actuals, baseScores, {
    beta: diagnostics?.calibration_beta ?? 1,
    intercept: 0
  });
  const contextAdjustment = computeContextAdjustment(drift);

  const prevWeightsPath = path.join(HYBRID_DIR, `hybrid_v2_weights_week${padWeek(Math.max(1, week - 1))}.json`);
  const prevCalibrationPath = path.join(HYBRID_DIR, `calibration_week${padWeek(Math.max(1, week - 1))}.json`);
  const prevWeights = loadPrevious(prevWeightsPath)?.weights ?? diagnostics?.blend_weights ?? updatedWeights;
  const prevCalibration = loadPrevious(prevCalibrationPath) ?? { beta: diagnostics?.calibration_beta ?? 1, intercept: 0 };
  const prevDiagnosticsPath = path.join(ARTIFACT_DIR, `diagnostics_${season}_W${padWeek(Math.max(1, week - 1))}.json`);
  const prevDiagnostics = loadPrevious(prevDiagnosticsPath);

  const validation = {
    auc_ok: auc >= 0.7,
    training_rows_increase:
      diagnostics?.n_train_rows == null || prevDiagnostics?.n_train_rows == null
        ? true
        : diagnostics.n_train_rows > prevDiagnostics.n_train_rows,
    calibration_slope_ok: calibration.beta >= 0.9 && calibration.beta <= 1.1
  };

  let fallbackUsed = false;
  if (!validation.auc_ok || !validation.training_rows_increase || !validation.calibration_slope_ok) {
    fallbackUsed = true;
  }

  if (fallbackUsed) {
    calibration = {
      beta: prevCalibration.beta ?? 1,
      intercept: prevCalibration.intercept ?? 0
    };
  }
  const weights = fallbackUsed ? prevWeights : updatedWeights;

  const nextPredictions = hasNextPredictions ? await readJson(predictionsNextFile) : [];
  const nextContext = hasNextContext ? await readJson(contextNextFile) : [];

  const outputs = new Map();
  for (const game of nextPredictions) {
    const { baseScore, prob } = applyHybrid(game.probs || {}, weights, calibration, contextAdjustment);
    outputs.set(game.game_id, {
      base_score: baseScore,
      prob,
      context_adjustment: contextAdjustment,
      drivers: {
        qb_ypa_delta: drift.qb_ypa_delta ?? 0,
        rush_epa_drift: drift.rush_epa_drift ?? 0,
        turnover_drift: drift.turnover_drift ?? 0,
        market_shift: drift.market_shift ?? 0
      },
      weights,
      calibration,
      actual_reference: byId.get(game.game_id) ?? null
    });
  }

  const predictionsCsv = hasNextPredictions ? buildPredictionsCsvRows(nextPredictions, outputs) : [];
  const outcomesCsv = buildOutcomesCsvRows(outcomes);
  const contextCsv = hasNextContext ? buildContextCsvRows(nextContext) : [];

  const diagnosticsOutput = {
    season,
    week,
    metrics: { auc, logloss, brier },
    drift,
    weights,
    calibration,
    context_adjustment: contextAdjustment,
    validation: {
      ...validation,
      fallback_used: fallbackUsed
    },
    bins
  };

  const weightsOutput = { season, week, weights, source: fallbackUsed ? "fallback" : "updated" };
  const calibrationOutput = { season, week, beta: calibration.beta, intercept: calibration.intercept, bins };

  await writeJson(path.join(HYBRID_DIR, `diagnostics_week${padWeek(week)}.json`), diagnosticsOutput);
  await writeJson(path.join(HYBRID_DIR, `hybrid_v2_weights_week${padWeek(week)}.json`), weightsOutput);
  await writeJson(path.join(HYBRID_DIR, `calibration_week${padWeek(week)}.json`), calibrationOutput);
  await writeCsv(path.join(HYBRID_DIR, `outcomes_week${padWeek(week)}.csv`), outcomesCsv);
  if (hasNextContext) {
    await writeCsv(path.join(HYBRID_DIR, `context_week${padWeek(week + 1)}.csv`), contextCsv);
  }
  if (hasNextPredictions) {
    const predictionsFile = `predictions_v2_${season}_W${padWeek(week + 1)}.csv`;
    await writeCsv(path.join(HYBRID_DIR, predictionsFile), predictionsCsv);
    await writeCsv(path.join(ARTIFACT_DIR, predictionsFile), predictionsCsv);
  }

  await appendPerformanceLog({
    season,
    week,
    auc,
    logloss,
    brier,
    qb_ypa_delta: drift.qb_ypa_delta,
    rush_epa_drift: drift.rush_epa_drift,
    turnover_drift: drift.turnover_drift,
    market_shift: drift.market_shift,
    weight_logistic: weights.logistic,
    weight_tree: weights.tree,
    weight_bt: weights.bt,
    weight_ann: weights.ann,
    beta: calibration.beta,
    intercept: calibration.intercept,
    context_adjustment: contextAdjustment,
    fallback_used: fallbackUsed
  });

  console.log(
    JSON.stringify(
      {
        season,
        week,
        auc,
        logloss,
        brier,
        drift,
        weights,
        calibration,
        context_adjustment: contextAdjustment,
        fallback_used: fallbackUsed
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
