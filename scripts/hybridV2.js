import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, "..");
const ARTIFACT_DIR = path.join(ROOT_DIR, "artifacts");
const HYBRID_DIR = path.join(ARTIFACT_DIR, "hybrid_v2");

const EPS = 1e-6;
const MAX_SIGMOID = 40;

const fsp = fs.promises;

function padWeek(week) {
  return String(week).padStart(2, "0");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function sigmoid(x) {
  if (!Number.isFinite(x)) return 0.5;
  if (x >= MAX_SIGMOID) return 1;
  if (x <= -MAX_SIGMOID) return 0;
  return 1 / (1 + Math.exp(-x));
}

function compressProbability(p) {
  if (!Number.isFinite(p)) return 0.5;
  if (p > 0.85) {
    return p - 0.05 * (p - 0.85);
  }
  return p;
}

function safeProb(p) {
  if (!Number.isFinite(p)) return 0.5;
  if (p <= EPS) return EPS;
  if (p >= 1 - EPS) return 1 - EPS;
  return p;
}

function computeAuc(labels, scores) {
  const pairs = [];
  for (let i = 0; i < labels.length; i += 1) {
    const y = labels[i];
    if (y !== 0 && y !== 1) continue;
    const score = safeProb(scores[i]);
    pairs.push({ y, score });
  }
  const positives = pairs.filter((p) => p.y === 1).length;
  const negatives = pairs.length - positives;
  if (!positives || !negatives) return 0.5;
  pairs.sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i + 1;
    while (j < pairs.length && pairs[j].score === pairs[i].score) {
      j += 1;
    }
    const avgRank = (i + j + 1) / 2; // 1-indexed average
    for (let k = i; k < j; k += 1) {
      if (pairs[k].y === 1) {
        rankSum += avgRank;
      }
    }
    i = j;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function computeLogLoss(labels, scores) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < labels.length; i += 1) {
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
  for (let i = 0; i < labels.length; i += 1) {
    const y = labels[i];
    if (y !== 0 && y !== 1) continue;
    const diff = safeProb(scores[i]) - y;
    sum += diff * diff;
    count += 1;
  }
  if (!count) return 0;
  return sum / count;
}

function normalizeWeights(weights) {
  const entries = Object.entries(weights).filter(([, value]) => Number.isFinite(value) && value > 0);
  const total = entries.reduce((acc, [, value]) => acc + value, 0);
  if (total <= 0) {
    const fallback = 1 / 4;
    return { logistic: fallback, tree: fallback, bt: fallback, ann: fallback };
  }
  const normalized = {};
  for (const [key, value] of entries) {
    normalized[key] = value / total;
  }
  for (const key of ["logistic", "tree", "bt", "ann"]) {
    if (!Object.hasOwn(normalized, key)) {
      normalized[key] = 0;
    }
  }
  return normalized;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  if (!values.length) return 0;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function chooseNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function extractNetYards(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { net_yds_3g, net_yds_5g, yds_for_3g, yds_against_3g, yds_for_5g, yds_against_5g } = entry;
  if (Number.isFinite(net_yds_3g)) return net_yds_3g;
  if (Number.isFinite(net_yds_5g)) return net_yds_5g;
  if (Number.isFinite(yds_for_3g) && Number.isFinite(yds_against_3g)) {
    return yds_for_3g - yds_against_3g;
  }
  if (Number.isFinite(yds_for_5g) && Number.isFinite(yds_against_5g)) {
    return yds_for_5g - yds_against_5g;
  }
  return null;
}

function computeFeatureDrift(contextGames, outcomesGames, predictionGames) {
  const qbDiffs = [];
  const rushDiffs = [];
  const marketDiffs = [];
  const turnoverDiffs = [];

  const outcomeMap = new Map();
  if (Array.isArray(outcomesGames)) {
    for (const game of outcomesGames) {
      if (!game || !game.game_id) continue;
      const homeWin = game.actual?.home_win;
      if (homeWin === 0 || homeWin === 1) {
        outcomeMap.set(game.game_id, homeWin);
      }
    }
  }

  if (Array.isArray(contextGames)) {
    for (const ctx of contextGames) {
      if (!ctx || !ctx.game_id) continue;
      const qbHome = chooseNumber(ctx.context?.qb_form?.home?.ypa_3g, ctx.context?.qb_form?.home?.ypa_5g);
      const qbAway = chooseNumber(ctx.context?.qb_form?.away?.ypa_3g, ctx.context?.qb_form?.away?.ypa_5g);
      if (Number.isFinite(qbHome) && Number.isFinite(qbAway)) {
        qbDiffs.push(qbHome - qbAway);
      }
      const netHome = extractNetYards(ctx.context?.rolling_strength?.home);
      const netAway = extractNetYards(ctx.context?.rolling_strength?.away);
      if (Number.isFinite(netHome) && Number.isFinite(netAway)) {
        rushDiffs.push((netHome - netAway) * 0.001);
      }
      const market = ctx.context?.market;
      if (market && typeof market === "object") {
        const spreadDelta = chooseNumber(market.close_spread, market.spread, market.open_spread);
        if (Number.isFinite(spreadDelta)) {
          marketDiffs.push(spreadDelta * 0.01);
        }
      }
    }
  }

  if (Array.isArray(predictionGames)) {
    for (const game of predictionGames) {
      if (!game || !game.game_id) continue;
      const actual = outcomeMap.get(game.game_id);
      if (actual === 0 || actual === 1) {
        const bt = Number(game?.probs?.bt);
        if (Number.isFinite(bt)) {
          turnoverDiffs.push(actual - bt);
        }
      }
      const pre = Number(game?.calibration?.pre);
      const post = Number(game?.calibration?.post);
      if (Number.isFinite(pre) && Number.isFinite(post)) {
        marketDiffs.push(post - pre);
      }
      if (!rushDiffs.length) {
        const logistic = Number(game?.probs?.logistic);
        const tree = Number(game?.probs?.tree);
        if (Number.isFinite(logistic) && Number.isFinite(tree)) {
          rushDiffs.push(tree - logistic);
        }
      }
    }
  }

  return {
    qb_ypa_delta: average(qbDiffs) || 0,
    rush_epa_drift: average(rushDiffs) || 0,
    turnover_margin_drift: average(turnoverDiffs) || 0,
    market_shift: average(marketDiffs) || 0
  };
}

function updateWeights(baseWeights, auc) {
  const base = {
    logistic: Number(baseWeights?.logistic) || 0,
    tree: Number(baseWeights?.tree) || 0,
    bt: Number(baseWeights?.bt) || 0,
    ann: Number(baseWeights?.ann) || 0
  };
  const updated = {
    logistic: base.logistic * (auc > 0.7 ? 1 : 0.9),
    tree: base.tree * 1.05,
    bt: base.bt * 1.02,
    ann: Math.max(0.05, base.ann * (auc > 0 ? auc / 0.7 : 0))
  };
  return normalizeWeights(updated);
}

function fitCalibrationCurve(calibrationBins) {
  const data = (Array.isArray(calibrationBins) ? calibrationBins : []).filter((bin) => {
    const p = Number(bin?.p_mean);
    const y = Number(bin?.y_rate);
    const n = Number(bin?.n ?? bin?.count ?? bin?.total);
    return Number.isFinite(p) && Number.isFinite(y) && p > 0 && p < 1 && y >= 0 && y <= 1 && (n == null || n >= 0);
  });
  if (!data.length) {
    return { beta: 1, intercept: 0 };
  }
  let beta = 1;
  let intercept = 0;
  const maxIter = 1000;
  const lr = 0.1;
  const weightSum = data.reduce((acc, bin) => acc + (Number(bin?.n ?? bin?.count ?? 1) || 1), 0) || 1;
  for (let iter = 0; iter < maxIter; iter += 1) {
    let gradB = 0;
    let gradI = 0;
    let maxDelta = 0;
    for (const bin of data) {
      const x = safeProb(Number(bin.p_mean));
      const y = Math.min(1, Math.max(0, Number(bin.y_rate)));
      const weight = Number(bin?.n ?? bin?.count ?? 1) || 1;
      const pred = sigmoid(beta * x + intercept);
      const error = pred - y;
      gradB += weight * error * x;
      gradI += weight * error;
    }
    const stepB = (lr / weightSum) * gradB;
    const stepI = (lr / weightSum) * gradI;
    beta -= stepB;
    intercept -= stepI;
    maxDelta = Math.max(Math.abs(stepB), Math.abs(stepI));
    if (maxDelta < 1e-6) break;
  }
  return { beta, intercept };
}

async function loadJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function toCsvValue(value) {
  if (value == null) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return String(value);
  }
  const str = String(value);
  if (str.includes(",") || str.includes("\"")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function writeCsv(filePath, rows, header) {
  const lines = [];
  const keys = header || (rows.length ? Object.keys(rows[0]) : []);
  if (keys.length) {
    lines.push(keys.join(","));
    for (const row of rows) {
      const values = keys.map((key) => toCsvValue(row?.[key]));
      lines.push(values.join(","));
    }
  }
  await fsp.writeFile(filePath, `${lines.join("\n")}\n`);
}

async function appendPerformanceLog(filePath, record) {
  const header = [
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
  const headerLine = header.join(",");
  const nextLine = header
    .map((key) => {
      const value = record?.[key];
      if (value == null) return "";
      if (typeof value === "boolean") return value ? "true" : "false";
      return String(value);
    })
    .join(",");

  if (!fs.existsSync(filePath)) {
    await fsp.writeFile(filePath, `${headerLine}\n${nextLine}\n`);
    return;
  }

  const raw = await fsp.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let startIdx = 0;
  if (lines.length && lines[0] !== headerLine) {
    // ensure header present
    lines.unshift(headerLine);
  } else {
    startIdx = 1;
  }
  const filtered = [headerLine];
  for (let i = startIdx; i < lines.length; i += 1) {
    const parts = lines[i].split(",");
    const seasonVal = Number(parts[0]);
    const weekVal = Number(parts[1]);
    if (seasonVal === record.season && weekVal === record.week) {
      continue;
    }
    filtered.push(lines[i]);
  }
  filtered.push(nextLine);
  await fsp.writeFile(filePath, `${filtered.join("\n")}\n`);
}

async function main() {
  const args = parseArgs();
  const season = Number(args.season);
  const week = Number(args.week);
  if (!Number.isInteger(season) || !Number.isInteger(week)) {
    console.error("hybrid:v2 requires --season and --week integers");
    process.exit(1);
  }
  const nextWeek = week + 1;
  fs.mkdirSync(HYBRID_DIR, { recursive: true });

  const pad = padWeek(week);
  const padNext = padWeek(nextWeek);

  const predictionsPath = path.join(ARTIFACT_DIR, `predictions_${season}_W${pad}.json`);
  const outcomesPath = path.join(ARTIFACT_DIR, `outcomes_${season}_W${pad}.json`);
  const contextPath = path.join(ARTIFACT_DIR, `context_${season}_W${pad}.json`);
  const diagnosticsPath = path.join(ARTIFACT_DIR, `diagnostics_${season}_W${pad}.json`);
  const nextPredictionsPath = path.join(ARTIFACT_DIR, `predictions_${season}_W${padNext}.json`);
  const nextContextPath = path.join(ARTIFACT_DIR, `context_${season}_W${padNext}.json`);

  for (const file of [predictionsPath, outcomesPath, contextPath, diagnosticsPath, nextPredictionsPath, nextContextPath]) {
    if (!fs.existsSync(file)) {
      console.error(`Required artifact missing: ${file}`);
      process.exit(1);
    }
  }

  const [predictionsPrev, outcomesPrev, contextPrev, diagnostics, predictionsNext, contextNext] = await Promise.all([
    loadJson(predictionsPath),
    loadJson(outcomesPath),
    loadJson(contextPath),
    loadJson(diagnosticsPath),
    loadJson(nextPredictionsPath),
    loadJson(nextContextPath)
  ]);

  const actualMap = new Map();
  for (const outcome of outcomesPrev || []) {
    if (!outcome || !outcome.game_id) continue;
    const homeWin = outcome.actual?.home_win;
    if (homeWin === 0 || homeWin === 1) {
      actualMap.set(outcome.game_id, homeWin);
    }
  }

  const labels = [];
  const probs = [];
  for (const game of predictionsPrev || []) {
    if (!game || !game.game_id) continue;
    let actual = null;
    if (game.actual === 0 || game.actual === 1) {
      actual = game.actual;
    } else if (game.actual && typeof game.actual === "object" && (game.actual.home_win === 0 || game.actual.home_win === 1)) {
      actual = game.actual.home_win;
    } else {
      actual = actualMap.get(game.game_id);
    }
    const probability = Number(game?.forecast);
    const blended = Number(game?.probs?.blended);
    const pred = Number.isFinite(probability) ? probability : blended;
    if ((actual === 0 || actual === 1) && Number.isFinite(pred)) {
      labels.push(actual);
      probs.push(pred);
    }
  }

  const metrics = {
    auc: round(computeAuc(labels, probs)),
    logloss: round(computeLogLoss(labels, probs)),
    brier: round(computeBrier(labels, probs))
  };

  const drift = computeFeatureDrift(contextPrev, outcomesPrev, predictionsPrev);
  const contextAdjustment = round(
    0.25 * drift.qb_ypa_delta +
      0.15 * drift.market_shift -
      0.2 * drift.rush_epa_drift +
      0.1 * drift.turnover_margin_drift,
    6
  );

  const updatedWeights = updateWeights(diagnostics?.blend_weights, metrics.auc ?? 0);
  let weights = updatedWeights;
  let fallbackUsed = false;

  if (!Number.isFinite(metrics.auc) || metrics.auc < 0.7) {
    const prevWeightsPath = path.join(HYBRID_DIR, `hybrid_v2_weights_week${padWeek(Math.max(1, week - 1))}.json`);
    if (fs.existsSync(prevWeightsPath)) {
      const prevWeights = JSON.parse(fs.readFileSync(prevWeightsPath, "utf8"));
      if (prevWeights?.weights) {
        weights = normalizeWeights(prevWeights.weights);
        fallbackUsed = true;
      }
    }
  }

  const calibration = fitCalibrationCurve(diagnostics?.calibration_bins);
  let beta = calibration.beta;
  let intercept = calibration.intercept;
  let calibrationFallbackApplied = false;
  if (!Number.isFinite(beta) || beta < 0.9 || beta > 1.1 || !Number.isFinite(intercept)) {
    const prevCalibrationPath = path.join(HYBRID_DIR, `calibration_week${padWeek(Math.max(1, week - 1))}.json`);
    if (fs.existsSync(prevCalibrationPath)) {
      try {
        const prevCalibration = JSON.parse(fs.readFileSync(prevCalibrationPath, "utf8"));
        if (Number.isFinite(prevCalibration?.beta) && Number.isFinite(prevCalibration?.intercept)) {
          beta = prevCalibration.beta;
          intercept = prevCalibration.intercept;
          fallbackUsed = true;
          calibrationFallbackApplied = true;
        }
      } catch (err) {
        // ignore
      }
    }
  }
  if (!calibrationFallbackApplied) {
    if (!Number.isFinite(beta)) {
      beta = 1;
      fallbackUsed = true;
    } else if (beta < 0.9) {
      beta = 0.9;
      fallbackUsed = true;
    } else if (beta > 1.1) {
      beta = 1.1;
      fallbackUsed = true;
    }
    if (!Number.isFinite(intercept)) {
      intercept = 0;
      fallbackUsed = true;
    }
  }

  beta = round(beta, 6) ?? 1;
  intercept = round(intercept, 6) ?? 0;

  const nextRows = [];
  for (const game of predictionsNext || []) {
    if (!game || !game.game_id) continue;
    const predLogistic = Number(game?.probs?.logistic);
    const predTree = Number(game?.probs?.tree);
    const predBt = Number(game?.probs?.bt);
    const predAnn = Number(game?.probs?.ann);
    const baseScore = round(
      (weights.logistic || 0) * (Number.isFinite(predLogistic) ? predLogistic : 0.5) +
        (weights.tree || 0) * (Number.isFinite(predTree) ? predTree : 0.5) +
        (weights.bt || 0) * (Number.isFinite(predBt) ? predBt : 0.5) +
        (weights.ann || 0) * (Number.isFinite(predAnn) ? predAnn : 0.5),
      6
    );
    const adjusted = Number.isFinite(baseScore) && Number.isFinite(contextAdjustment)
      ? baseScore + contextAdjustment
      : baseScore;
    const calibrated = compressProbability(sigmoid((beta ?? 1) * (adjusted ?? 0.5) + (intercept ?? 0)));
    nextRows.push({
      season,
      week: nextWeek,
      game_id: game.game_id || null,
      home_team: game.home_team || null,
      away_team: game.away_team || null,
      forecast: round(calibrated, 6),
      base_score: baseScore,
      context_adjustment: contextAdjustment,
      qb_ypa_delta: round(drift.qb_ypa_delta, 6),
      rush_epa_drift: round(drift.rush_epa_drift, 6),
      turnover_drift: round(drift.turnover_margin_drift, 6),
      market_shift: round(drift.market_shift, 6),
      weight_logistic: round(weights.logistic, 6),
      weight_tree: round(weights.tree, 6),
      weight_bt: round(weights.bt, 6),
      weight_ann: round(weights.ann, 6),
      calibration_beta: beta,
      calibration_intercept: intercept
    });
  }

  const contextRows = [];
  for (const game of predictionsNext || []) {
    const ctx = Array.isArray(contextNext)
      ? contextNext.find((entry) => entry?.game_id === game?.game_id)
      : null;
    contextRows.push({
      season,
      week: nextWeek,
      game_id: game?.game_id || null,
      home_team: game?.home_team || null,
      away_team: game?.away_team || null,
      qb_ypa_home: round(chooseNumber(ctx?.context?.qb_form?.home?.ypa_3g, ctx?.context?.qb_form?.home?.ypa_5g), 6),
      qb_ypa_away: round(chooseNumber(ctx?.context?.qb_form?.away?.ypa_3g, ctx?.context?.qb_form?.away?.ypa_5g), 6),
      net_yds_home: round(extractNetYards(ctx?.context?.rolling_strength?.home), 6),
      net_yds_away: round(extractNetYards(ctx?.context?.rolling_strength?.away), 6),
      pred_logistic: Number.isFinite(game?.probs?.logistic) ? game.probs.logistic : "",
      pred_tree: Number.isFinite(game?.probs?.tree) ? game.probs.tree : "",
      pred_bt: Number.isFinite(game?.probs?.bt) ? game.probs.bt : "",
      pred_ann: Number.isFinite(game?.probs?.ann) ? game.probs.ann : ""
    });
  }

  const outcomesRows = [];
  for (const outcome of outcomesPrev || []) {
    outcomesRows.push({
      season,
      week,
      game_id: outcome?.game_id || null,
      home_team: outcome?.home_team || null,
      away_team: outcome?.away_team || null,
      home_points: Number.isFinite(outcome?.actual?.home_points) ? outcome.actual.home_points : "",
      away_points: Number.isFinite(outcome?.actual?.away_points) ? outcome.actual.away_points : "",
      home_win: outcome?.actual?.home_win
    });
  }

  const diagnosticsOutput = {
    season,
    week,
    metrics,
    drift: {
      qb_ypa_delta: round(drift.qb_ypa_delta, 6),
      rush_epa_drift: round(drift.rush_epa_drift, 6),
      turnover_margin_drift: round(drift.turnover_margin_drift, 6),
      market_shift: round(drift.market_shift, 6)
    },
    weights,
    calibration: {
      beta,
      intercept
    },
    context_adjustment: contextAdjustment,
    fallback_used: fallbackUsed,
    source: {
      diagnostics: path.basename(diagnosticsPath),
      predictions: path.basename(predictionsPath),
      outcomes: path.basename(outcomesPath)
    }
  };

  await Promise.all([
    writeJson(path.join(HYBRID_DIR, `diagnostics_week${pad}.json`), diagnosticsOutput),
    writeJson(
      path.join(HYBRID_DIR, `hybrid_v2_weights_week${pad}.json`),
      {
        season,
        week,
        weights,
        metrics,
        drift: diagnosticsOutput.drift,
        calibration: diagnosticsOutput.calibration,
        context_adjustment: contextAdjustment,
        fallback_used: fallbackUsed
      }
    ),
    writeJson(
      path.join(HYBRID_DIR, `calibration_week${pad}.json`),
      {
        season,
        week,
        beta,
        intercept,
        bins: diagnostics?.calibration_bins ?? []
      }
    ),
    writeCsv(path.join(HYBRID_DIR, `outcomes_week${pad}.csv`), outcomesRows, [
      "season",
      "week",
      "game_id",
      "home_team",
      "away_team",
      "home_points",
      "away_points",
      "home_win"
    ]),
    writeCsv(path.join(HYBRID_DIR, `context_week${padNext}.csv`), contextRows, [
      "season",
      "week",
      "game_id",
      "home_team",
      "away_team",
      "qb_ypa_home",
      "qb_ypa_away",
      "net_yds_home",
      "net_yds_away",
      "pred_logistic",
      "pred_tree",
      "pred_bt",
      "pred_ann"
    ]),
    writeCsv(path.join(HYBRID_DIR, `predictions_v2_${season}_W${padNext}.csv`), nextRows, [
      "season",
      "week",
      "game_id",
      "home_team",
      "away_team",
      "forecast",
      "base_score",
      "context_adjustment",
      "qb_ypa_delta",
      "rush_epa_drift",
      "turnover_drift",
      "market_shift",
      "weight_logistic",
      "weight_tree",
      "weight_bt",
      "weight_ann",
      "calibration_beta",
      "calibration_intercept"
    ])
  ]);

  await appendPerformanceLog(path.join(HYBRID_DIR, "performance_log.csv"), {
    season,
    week,
    auc: metrics.auc,
    logloss: metrics.logloss,
    brier: metrics.brier,
    qb_ypa_delta: round(drift.qb_ypa_delta, 6),
    rush_epa_drift: round(drift.rush_epa_drift, 6),
    turnover_drift: round(drift.turnover_margin_drift, 6),
    market_shift: round(drift.market_shift, 6),
    weight_logistic: round(weights.logistic, 6),
    weight_tree: round(weights.tree, 6),
    weight_bt: round(weights.bt, 6),
    weight_ann: round(weights.ann, 6),
    beta,
    intercept,
    context_adjustment: contextAdjustment,
    fallback_used: fallbackUsed
  });

  console.log(`Adaptive Hybrid v2 recalibrated for season ${season} week ${week}`);
  console.log(`Saved ${nextRows.length} predictions for week ${nextWeek}`);
}

main().catch((err) => {
  console.error("hybrid:v2 failed", err);
  process.exit(1);
});
