// trainer/model_bt.js
// Bradley-Terry style logistic model with bootstrap simulation

import { BT_FEATURES } from "./featureBuild_bt.js";

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

function trainLogisticGD(X, y, { steps = 2000, lr = 5e-3, l2 = 1e-4 } = {}) {
  const n = X.length;
  const d = X[0]?.length || 0;
  let w = new Array(d).fill(0);
  let b = 0;
  for (let t = 0; t < steps; t++) {
    let gb = 0;
    const gw = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      const z = xi.reduce((s, v, idx) => s + v * w[idx], 0) + b;
      const p = sigmoid(z);
      const err = p - y[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * xi[j];
    }
    gb /= Math.max(1, n);
    for (let j = 0; j < d; j++) gw[j] = gw[j] / Math.max(1, n) + l2 * w[j];
    b -= lr * gb;
    for (let j = 0; j < d; j++) w[j] -= lr * gw[j];
  }
  return { w, b };
}

const predictLogit = (X, model) => {
  const { w, b } = model;
  return X.map((row) => sigmoid(row.reduce((s, v, idx) => s + v * w[idx], 0) + b));
};

const rowsToMatrix = (rows) => rows.map((r) => BT_FEATURES.map((k) => Number(r.features?.[k] ?? 0)));

export function trainBTModel(trainRows, { steps, lr, l2 } = {}) {
  const X = rowsToMatrix(trainRows);
  const y = trainRows.map((r) => Number(r.label_win ?? 0));
  const scaler = fitScaler(X);
  const Xs = applyScaler(X, scaler);
  const model = trainLogisticGD(Xs, y, { steps, lr, l2 });
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

function sampleRecent(history, k, rng) {
  if (!history?.length) return null;
  const pool = history.slice(-Math.min(k, history.length));
  if (!pool.length) return null;
  const sample = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(rng() * pool.length);
    sample.push(pool[idx]);
  }
  return sample;
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
    const push = (team, actual) => {
      if (!team || !actual) return;
      const arr = history.get(team) || [];
      arr.push({
        total_yards: Number(actual.total_yards ?? 0),
        penalty_yards: Number(actual.penalty_yards ?? 0),
        turnovers: Number(actual.turnovers ?? 0),
        possession_seconds: Number(actual.possession_seconds ?? 0),
        r_ratio: Number(actual.r_ratio ?? 0)
      });
      history.set(team, arr);
    };
    push(row.home_team, row.home_actual);
    push(row.away_team, row.away_actual);
  }
  return history;
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
    const base = BT_FEATURES.map((k) => Number(row.features?.[k] ?? 0));
    const standardizedBase = applyScaler([base], scaler)[0];
    const baseProb = sigmoid(
      standardizedBase.reduce((s, v, idx) => s + v * coeffs[idx], 0) + model.b
    );
    const hHist = history.get(row.home_team) || [];
    const aHist = history.get(row.away_team) || [];
    const probs = [];
    const iterations = Math.max(1, Math.round(bootstrap));
    for (let i = 0; i < iterations; i++) {
      const hSample = sampleRecent(hHist, block, rng);
      const aSample = sampleRecent(aHist, block, rng);
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
      const featVec = [
        Number(hAvg.total_yards ?? 0) - Number(aAvg.total_yards ?? 0),
        Number(hAvg.penalty_yards ?? 0) - Number(aAvg.penalty_yards ?? 0),
        Number(hAvg.turnovers ?? 0) - Number(aAvg.turnovers ?? 0),
        Number(hAvg.possession_seconds ?? 0) - Number(aAvg.possession_seconds ?? 0),
        Number(hAvg.r_ratio ?? 0) - Number(aAvg.r_ratio ?? 0),
        Number(row.features?.diff_elo_pre ?? 0)
      ];
      const std = applyScaler([featVec], scaler)[0];
      const prob = sigmoid(std.reduce((s, v, idx) => s + v * coeffs[idx], 0) + model.b);
      probs.push(prob);
    }
    probs.sort((a, b) => a - b);
    const mean = probs.reduce((s, v) => s + v, 0) / Math.max(1, probs.length);
    const lo = percentile(probs, 0.05);
    const hi = percentile(probs, 0.95);
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
