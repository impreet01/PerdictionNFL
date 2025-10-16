// trainer/model_bt.js
// Bradley-Terry style logistic model with bootstrap simulation

import modelParams from "../config/modelParams.json" with { type: "json" };
import { BT_FEATURES } from "./featureBuild_bt.js";

/**
 * Clamp a value to a finite floating point number.
 * @param {unknown} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
export const toFiniteNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

/**
 * Clamp a probability to the [0, 1] interval and ensure it is finite.
 * @param {unknown} value
 * @returns {number}
 */
const safeProb = (value) => {
  const num = toFiniteNumber(value, 0.5);
  if (!Number.isFinite(num)) return 0.5;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
};

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

const fitScaler = (X) => {
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
};

const applyScaler = (X, scaler) => {
  if (!scaler) return X.map((row) => row.slice());
  const { mu, sd } = scaler;
  return X.map((row) => row.map((v, j) => (v - mu[j]) / (sd[j] || 1)));
};

const GD_CONFIG = modelParams?.bt?.gd || {};
const DEFAULT_GD_STEPS = Number(process.env.BT_GD_STEPS ?? GD_CONFIG.steps ?? 2000);
const DEFAULT_GD_LR = Number(process.env.BT_GD_LR ?? GD_CONFIG.learningRate ?? 5e-3);
const DEFAULT_GD_L2 = Number(process.env.BT_GD_L2 ?? GD_CONFIG.l2 ?? 1e-4);
const DEFAULT_GD_BATCH = Number(process.env.BT_GD_BATCH ?? GD_CONFIG.batchSize ?? 128);

function trainLogisticGD(
  X,
  y,
  {
    steps = DEFAULT_GD_STEPS,
    lr = DEFAULT_GD_LR,
    l2 = DEFAULT_GD_L2,
    featureLength,
    batchSize = DEFAULT_GD_BATCH
  } = {}
) {
  const n = X.length;
  const observedDim = X[0]?.length || 0;
  const dim = Number.isInteger(featureLength) && featureLength > 0 ? featureLength : observedDim;
  let w = new Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.01);
  let b = 0;
  if (!n || !observedDim || !dim) return { w, b, neutral: true };
  const effectiveBatch = Math.max(1, Math.min(n, Math.round(batchSize)));
  const batchesPerEpoch = Math.ceil(n / effectiveBatch);
  for (let t = 0; t < steps; t++) {
    for (let batchIdx = 0; batchIdx < batchesPerEpoch; batchIdx++) {
      const start = batchIdx * effectiveBatch;
      const end = Math.min(n, start + effectiveBatch);
      let gb = 0;
      const gw = new Array(dim).fill(0);
      for (let i = start; i < end; i++) {
        const row = X[i] || [];
        let z = b;
        for (let j = 0; j < dim; j++) {
          const weight = toFiniteNumber(w[j]);
          const feature = toFiniteNumber(row[j]);
          z += weight * feature;
        }
        if (!Number.isFinite(z)) continue;
        const p = sigmoid(z);
        const err = p - y[i];
        gb += err;
        for (let j = 0; j < dim; j++) {
          const feature = toFiniteNumber(row[j]);
          gw[j] += err * feature;
        }
      }
      const denom = Math.max(1, end - start);
      gb = Number.isFinite(gb) ? gb / denom : 0;
      for (let j = 0; j < dim; j++) {
        const grad = Number.isFinite(gw[j]) ? gw[j] / denom + l2 * toFiniteNumber(w[j]) : l2 * toFiniteNumber(w[j]);
        gw[j] = Number.isFinite(grad) ? grad : 0;
      }
      b -= lr * gb;
      if (!Number.isFinite(b)) b = 0;
      for (let j = 0; j < dim; j++) {
        w[j] -= lr * gw[j];
        if (!Number.isFinite(w[j])) w[j] = 0;
      }
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

const rowsToMatrix = (rows) =>
  rows.map((r) => BT_FEATURES.map((k) => toFiniteNumber(r.features?.[k], 0)));

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function descriptorFromContext(context = {}) {
  return {
    elo: num(context.elo_pre, 1500),
    total_yards: num(context.total_yards, 350),
    penalty_yards: num(context.penalty_yards, 50),
    turnovers: num(context.turnovers, 1.5),
    possession_seconds: num(context.possession_seconds, 1800),
    r_ratio: num(context.r_ratio, 0.5),
    plays: num(context.offensive_plays, 65)
  };
}

function normalizeActual(actual = {}) {
  const total = num(actual.total_yards);
  const pass = num(actual.pass_yards);
  const ratio = total ? pass / total : num(actual.r_ratio, 0.5);
  return {
    total_yards: total,
    penalty_yards: num(actual.penalty_yards),
    turnovers: num(actual.turnovers),
    possession_seconds: num(actual.possession_seconds),
    r_ratio: ratio
  };
}

export function trainBTModel(trainRows, { steps, lr, l2 } = {}) {
  const X = rowsToMatrix(trainRows);
  const y = trainRows.map((r) => toFiniteNumber(r.label_win, 0));
  const scaler = fitScaler(X);
  const Xs = applyScaler(X, scaler);
  const model = trainLogisticGD(Xs, y, { steps, lr, l2, featureLength: BT_FEATURES.length });
  return { ...model, scaler, features: BT_FEATURES.slice() };
}

function percentile(sorted, pct) {
  if (!sorted.length) return 0.5;
  const idx = (sorted.length - 1) * pct;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function sampleRecent(historyEntries, k, rng) {
  if (!historyEntries?.length) return null;
  const limit = Math.min(historyEntries.length, Math.max(k * 2, k));
  const pool = historyEntries.slice(-limit);
  if (!pool.length) return null;
  const sample = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(rng() * pool.length);
    const chosen = pool[idx];
    if (chosen?.actual) sample.push(chosen.actual);
  }
  return sample.length ? sample : null;
}

function averageStats(samples) {
  if (!samples || !samples.length) return null;
  const agg = {
    total_yards: 0,
    penalty_yards: 0,
    turnovers: 0,
    possession_seconds: 0,
    r_ratio: 0
  };
  for (const s of samples) {
    agg.total_yards += Number(s.total_yards ?? 0);
    agg.penalty_yards += Number(s.penalty_yards ?? 0);
    agg.turnovers += Number(s.turnovers ?? 0);
    agg.possession_seconds += Number(s.possession_seconds ?? 0);
    agg.r_ratio += Number(s.r_ratio ?? 0);
  }
  const n = samples.length;
  return {
    total_yards: agg.total_yards / n,
    penalty_yards: agg.penalty_yards / n,
    turnovers: agg.turnovers / n,
    possession_seconds: agg.possession_seconds / n,
    r_ratio: agg.r_ratio / n
  };
}

function defaultRng(seed = 1234567) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function buildHistory(rows) {
  const history = new Map();
  for (const row of rows) {
    const season = Number(row.season);
    const week = Number(row.week);
    const push = (team, opponent, location, context, opponentContext, actual) => {
      if (!team || !actual) return;
      const arr = history.get(team) || [];
      arr.push({
        season,
        week,
        opponent,
        location,
        teamDescriptor: descriptorFromContext(context || {}),
        opponentDescriptor: descriptorFromContext(opponentContext || {}),
        actual: normalizeActual(actual)
      });
      history.set(team, arr);
    };
    push(row.home_team, row.away_team, 'home', row.home_context, row.away_context, row.home_actual);
    push(row.away_team, row.home_team, 'away', row.away_context, row.home_context, row.away_actual);
  }
  for (const arr of history.values()) {
    arr.sort((a, b) => {
      const s = (a.season ?? 0) - (b.season ?? 0);
      if (s !== 0) return s;
      return (a.week ?? 0) - (b.week ?? 0);
    });
  }
  return history;
}

function weeksBetween(targetSeason, targetWeek, season, week) {
  if (!Number.isFinite(targetSeason) || !Number.isFinite(targetWeek)) return 0;
  if (!Number.isFinite(season) || !Number.isFinite(week)) return 0;
  const deltaSeasons = targetSeason - season;
  const deltaWeeks = targetWeek - week;
  return deltaSeasons * 18 + deltaWeeks;
}

function similarityWeight(entry, target) {
  if (!entry || !target) return 0;
  const dims = [
    { key: 'elo', scale: 400 },
    { key: 'total_yards', scale: 150 },
    { key: 'penalty_yards', scale: 60 },
    { key: 'turnovers', scale: 2.5 },
    { key: 'possession_seconds', scale: 600 },
    { key: 'r_ratio', scale: 0.25 },
    { key: 'plays', scale: 20 }
  ];
  let dist2 = 0;
  for (const dim of dims) {
    const a = entry.opponentDescriptor?.[dim.key] ?? 0;
    const b = target.descriptor?.[dim.key] ?? 0;
    const diff = (a - b) / dim.scale;
    dist2 += diff * diff;
  }
  if (entry.location !== target.location) {
    dist2 += 0.5;
  }
  const recencyWeeks = weeksBetween(target.season, target.week, entry.season, entry.week);
  const recency = Math.exp(-Math.max(0, recencyWeeks) / 24);
  const kernel = Math.exp(-dist2);
  return kernel * recency;
}

function weightedSampleEntries(entries, target, k, rng) {
  if (!entries?.length) return null;
  const weights = entries.map((entry) => similarityWeight(entry, target));
  const positive = weights.filter((w) => w > 0);
  if (!positive.length) return null;
  const total = weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const sample = [];
  for (let i = 0; i < k; i++) {
    let u = rng() * total;
    let chosen = entries[entries.length - 1];
    for (let j = 0; j < entries.length; j++) {
      u -= weights[j];
      if (u <= 0) {
        chosen = entries[j];
        break;
      }
    }
    if (chosen?.actual) sample.push(chosen.actual);
  }
  return sample.length ? sample : null;
}

function drawHistorySamples(entries, target, block, rng) {
  const weighted = weightedSampleEntries(entries, target, block, rng);
  if (weighted && weighted.length) return weighted;
  return sampleRecent(entries, block, rng);
}

function buildFeatureVector({
  model,
  baseFeatures,
  homeAvg,
  awayAvg,
  row
}) {
  const featureKeys = Array.isArray(model?.features) && model.features.length ? model.features : BT_FEATURES;
  return featureKeys.map((key) => {
    if (key.startsWith("diff_")) {
      const name = key.replace(/^diff_/, "");
      const home = homeAvg && name in homeAvg ? toFiniteNumber(homeAvg[name], 0) : null;
      const away = awayAvg && name in awayAvg ? toFiniteNumber(awayAvg[name], 0) : null;
      if (home !== null && away !== null) {
        return home - away;
      }
      return toFiniteNumber(baseFeatures[key], 0);
    }
    if (key.startsWith("home_")) {
      const stat = key.replace(/^home_/, "");
      return toFiniteNumber(homeAvg?.[stat], baseFeatures[key]);
    }
    if (key.startsWith("away_")) {
      const stat = key.replace(/^away_/, "");
      return toFiniteNumber(awayAvg?.[stat], baseFeatures[key]);
    }
    return toFiniteNumber(baseFeatures[key], 0);
  });
}

export function predictBT({
  model,
  rows,
  historyRows,
  bootstrap = Number(process.env.BT_B ?? 1000),
  block = 5,
  seed = 7
}) {
  const history = buildHistory(historyRows || []);
  const scaler = model.scaler;
  const coeffs = model.w;
  const rng = defaultRng(seed);
  const preds = [];
  for (const row of rows) {
    const base = (Array.isArray(model.features) ? model.features : BT_FEATURES).map((k) =>
      toFiniteNumber(row.features?.[k], 0)
    );
    const standardizedBase = applyScaler([base], scaler)[0];
    const baseProb = safeProb(
      sigmoid(standardizedBase.reduce((s, v, idx) => s + v * coeffs[idx], 0) + model.b)
    );
    const hHist = history.get(row.home_team) || [];
    const aHist = history.get(row.away_team) || [];
    const homeTarget = {
      descriptor: descriptorFromContext(row.away_context || {}),
      location: 'home',
      season: Number(row.season),
      week: Number(row.week)
    };
    const awayTarget = {
      descriptor: descriptorFromContext(row.home_context || {}),
      location: 'away',
      season: Number(row.season),
      week: Number(row.week)
    };
    const probs = [];
    const iterations = Math.max(1, Math.min(500, Math.round(bootstrap)));
    for (let i = 0; i < iterations; i++) {
      const hSample = drawHistorySamples(hHist, homeTarget, block, rng);
      const aSample = drawHistorySamples(aHist, awayTarget, block, rng);
      if (!hSample || !aSample) {
        probs.push(baseProb);
        continue;
      }
      const hAvg = averageStats(hSample);
      const aAvg = averageStats(aSample);
      if (!hAvg || !aAvg) {
        probs.push(baseProb);
        continue;
      }
      const featVec = buildFeatureVector({
        model,
        baseFeatures: row.features || {},
        homeAvg: hAvg,
        awayAvg: aAvg,
        row
      });
      const expectedLen = Array.isArray(coeffs) && coeffs.length ? coeffs.length : BT_FEATURES.length;
      while (featVec.length < expectedLen) featVec.push(0);
      if (featVec.length > expectedLen) featVec.length = expectedLen;
      const std = applyScaler([featVec], scaler)[0];
      const prob = sigmoid(std.reduce((s, v, idx) => s + v * coeffs[idx], 0) + model.b);
      probs.push(safeProb(prob));
    }
    probs.sort((a, b) => a - b);
    const mean = safeProb(probs.reduce((s, v) => s + v, 0) / Math.max(1, probs.length));
    const lo = safeProb(percentile(probs, 0.05));
    const hi = safeProb(percentile(probs, 0.95));
    preds.push({
      game_id: row.game_id,
      prob: mean,
      ci90: [lo, hi],
      base_prob: baseProb,
      bootstrap_samples: probs.length,
      features: BT_FEATURES.reduce((acc, k, idx) => ({ ...acc, [k]: base[idx] }), {})
    });
  }
  return preds;
}

export function predictBTDeterministic(model, rows) {
  const X = rowsToMatrix(rows);
  const Xs = applyScaler(X, model.scaler);
  const probs = predictLogit(Xs, model);
  return rows.map((row, i) => ({ game_id: row.game_id, prob: probs[i] }));
}
