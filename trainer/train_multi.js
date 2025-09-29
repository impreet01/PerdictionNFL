// trainer/train_multi.js
// Multi-model ensemble trainer with logistic+CART, Bradley-Terry, and ANN committee.

import { loadSchedules, loadTeamWeekly, loadTeamGameAdvanced } from "./dataSources.js";
import { buildFeatures, FEATS } from "./featureBuild.js";
import { buildBTFeatures, BT_FEATURES } from "./featureBuild_bt.js";
import { trainBTModel, predictBT, predictBTDeterministic } from "./model_bt.js";
import { trainANNCommittee, predictANNCommittee, gradientANNCommittee } from "./model_ann.js";
import { DecisionTreeClassifier as CART } from "ml-cart";
import { writeFileSync, mkdirSync } from "fs";
import { Matrix, SVD } from "ml-matrix";

const ART_DIR = "artifacts";
mkdirSync(ART_DIR, { recursive: true });

const round3 = (x) => Math.round(Number(x) * 1000) / 1000;

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

function trainLogisticGD(X, y, { steps = 3000, lr = 5e-3, l2 = 2e-4 } = {}) {
  const n = X.length;
  const d = X[0]?.length || 0;
  let w = new Array(d).fill(0);
  let b = 0;
  if (!n || !d) return { w, b };
  for (let t = 0; t < steps; t++) {
    let gb = 0;
    const gw = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, v, idx) => s + v * w[idx], 0) + b;
      const p = sigmoid(z);
      const err = p - y[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
    }
    gb /= Math.max(1, n);
    for (let j = 0; j < d; j++) gw[j] = gw[j] / Math.max(1, n) + l2 * w[j];
    b -= lr * gb;
    for (let j = 0; j < d; j++) w[j] -= lr * gw[j];
  }
  return { w, b };
}

const predictLogit = (X, model) => X.map((row) => sigmoid(row.reduce((s, v, idx) => s + v * model.w[idx], 0) + model.b));

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

function kfoldIndices(n, k) {
  if (n <= 1) return [[...Array(n).keys()]];
  const folds = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) {
    folds[i % k].push(i);
  }
  return folds;
}

const logloss = (probs, labels) => {
  if (!labels.length) return null;
  let s = 0;
  const eps = 1e-12;
  for (let i = 0; i < labels.length; i++) {
    const p = Math.min(Math.max(probs[i], eps), 1 - eps);
    s += -(labels[i] * Math.log(p) + (1 - labels[i]) * Math.log(1 - p));
  }
  return s / labels.length;
};

const brier = (probs, labels) => {
  if (!labels.length) return null;
  let s = 0;
  for (let i = 0; i < labels.length; i++) {
    const diff = probs[i] - labels[i];
    s += diff * diff;
  }
  return s / labels.length;
};

function auc(probs, labels) {
  const pairs = probs.map((p, i) => ({ p, y: labels[i] }));
  const pos = pairs.filter((r) => r.y === 1);
  const neg = pairs.filter((r) => r.y === 0);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  let ties = 0;
  for (const a of pos) {
    for (const b of neg) {
      if (a.p > b.p) wins += 1;
      else if (a.p === b.p) ties += 1;
    }
  }
  return (wins + 0.5 * ties) / (pos.length * neg.length);
}

function calibrationBins(probs, labels, bins = 10) {
  if (!labels.length) return [];
  const binCounts = Array.from({ length: bins }, () => ({ sum: 0, count: 0, actual: 0 }));
  for (let i = 0; i < labels.length; i++) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(probs[i] * bins)));
    binCounts[idx].sum += probs[i];
    binCounts[idx].actual += labels[i];
    binCounts[idx].count += 1;
  }
  return binCounts.map((b, idx) => ({
    lower: idx / bins,
    upper: (idx + 1) / bins,
    mean_pred: b.count ? b.sum / b.count : null,
    empirical: b.count ? b.actual / b.count : null,
    count: b.count
  }));
}

function enumerateWeights(step = 0.05) {
  const weights = [];
  for (let wl = 0; wl <= 1; wl += step) {
    for (let wt = 0; wt <= 1 - wl; wt += step) {
      for (let wb = 0; wb <= 1 - wl - wt; wb += step) {
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

function plattCalibrate(probs, labels) {
  if (!labels.length) return { beta: 0 };
  const logits = probs.map((p) => {
    const eps = 1e-12;
    const v = Math.min(Math.max(p, eps), 1 - eps);
    return Math.log(v / (1 - v));
  });
  let beta = 0;
  for (let iter = 0; iter < 200; iter++) {
    let grad = 0;
    let hess = 0;
    for (let i = 0; i < labels.length; i++) {
      const z = logits[i] + beta;
      const p = 1 / (1 + Math.exp(-z));
      grad += p - labels[i];
      hess += p * (1 - p);
    }
    if (Math.abs(grad) < 1e-6) break;
    beta -= grad / Math.max(1e-6, hess);
  }
  return { beta };
}

function applyPlatt(prob, calibrator) {
  const eps = 1e-12;
  const v = Math.min(Math.max(prob, eps), 1 - eps);
  const logit = Math.log(v / (1 - v));
  const z = logit + (calibrator?.beta ?? 0);
  return 1 / (1 + Math.exp(-z));
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
  diff_elo_pre: "Elo differential"
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

export async function runTraining({ season, week, data = {}, options = {} } = {}) {
  const resolvedSeason = Number(season ?? process.env.SEASON ?? new Date().getFullYear());
  let resolvedWeek = Number(week ?? process.env.WEEK ?? 6);
  if (!Number.isFinite(resolvedWeek)) resolvedWeek = 6;

  const schedules = data.schedules ?? (await loadSchedules());
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
    try {
      prevTeamWeekly = await loadTeamWeekly(resolvedSeason - 1);
    } catch (e) {
      prevTeamWeekly = [];
    }
  }

  const featureRows = buildFeatures({
    teamWeekly,
    teamGame,
    schedules,
    season: resolvedSeason,
    prevTeamWeekly
  });
  const btRows = buildBTFeatures({
    teamWeekly,
    teamGame,
    schedules,
    season: resolvedSeason,
    prevTeamWeekly
  });

  const btTrainRowsRaw = btRows.filter(
    (r) => r.season === resolvedSeason && r.week < resolvedWeek && (r.label_win === 0 || r.label_win === 1)
  );
  const btTestRowsRaw = btRows.filter((r) => r.season === resolvedSeason && r.week === resolvedWeek);

  const btTrainMap = new Map(btTrainRowsRaw.map((r) => [r.game_id, r]));
  const btTestMap = new Map(btTestRowsRaw.map((r) => [r.game_id, r]));

  const trainRowsRaw = featureRows.filter(
    (r) => r.season === resolvedSeason && r.week < resolvedWeek && r.home === 1 && (r.win === 0 || r.win === 1)
  );
  const testRowsRaw = featureRows.filter(
    (r) => r.season === resolvedSeason && r.week === resolvedWeek && r.home === 1
  );

  const trainGames = trainRowsRaw
    .map((row) => ({ row, bt: btTrainMap.get(makeGameId(row)) }))
    .filter((g) => g.bt);
  const testGames = testRowsRaw
    .map((row) => ({ row, bt: btTestMap.get(makeGameId(row)) }))
    .filter((g) => g.bt);

  const trainRows = trainGames.map((g) => g.row);
  const btTrainRows = trainGames.map((g) => g.bt);
  const testRows = testGames.map((g) => g.row);
  const btTestRows = testGames.map((g) => g.bt);
  const leagueMeans = computeLeagueMeans(trainRows);

  const labels = trainRows.map((r) => Number(r.win));
  const weeksSeen = new Set(trainRows.map((r) => r.week)).size;
  const trainMatrix = matrixFromRows(trainRows, FEATS);
  const scaler = fitScaler(trainMatrix.length ? trainMatrix : [new Array(FEATS.length).fill(0)]);
  const trainStd = applyScaler(trainMatrix, scaler);

  const nTrain = trainRows.length;
  let folds = [];
  let oofLogit = [];
  let oofTree = [];
  if (nTrain >= 2) {
    const k = Math.min(5, Math.max(2, Math.floor(nTrain / 6)));
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
      const scalerFold = fitScaler(Xtr.length ? Xtr : [new Array(FEATS.length).fill(0)]);
      const XtrS = applyScaler(Xtr, scalerFold);
      const XvaS = applyScaler(Xva, scalerFold);
      const logitModel = trainLogisticGD(XtrS, ytr, { steps: 2500, lr: 4e-3, l2: 2e-4 });
      const params = chooseTreeParams(XtrS.length);
      const cart = new CART({ maxDepth: params.depth, minNumSamples: params.minSamples, gainFunction: "gini" });
      if (XtrS.length) cart.train(XtrS, ytr);
      const leafStats = buildLeafFreq(cart, XtrS, ytr, laplaceAlpha(XtrS.length));
      const pLog = predictLogit(XvaS, logitModel);
      const pTree = predictTree(cart, leafStats, XvaS);
      for (let j = 0; j < iva.length; j++) {
        oofLogit[iva[j]] = pLog[j];
        oofTree[iva[j]] = pTree[j];
      }
    }
  } else {
    oofLogit = ensureArray([], nTrain, 0.5);
    oofTree = ensureArray([], nTrain, 0.5);
  }

  const annSeeds = options.annSeeds ?? Number(process.env.ANN_SEEDS ?? 15);
  const annMaxEpochs = options.annMaxEpochs ?? Number(process.env.ANN_MAX_EPOCHS ?? 200);
  const annCvSeeds = Math.max(3, Math.min(annSeeds, options.annCvSeeds ?? 5));
  const annOOF = new Array(nTrain).fill(0.5);
  if (nTrain >= 2) {
    const foldSets = folds.length ? folds : [Array.from({ length: nTrain }, (_, i) => i)];
    for (const valIdx of foldSets) {
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
      const scalerFold = fitScaler(Xtr.length ? Xtr : [new Array(FEATS.length).fill(0)]);
      const XtrS = applyScaler(Xtr, scalerFold);
      const XvaS = applyScaler(Xva, scalerFold);
      const annModel = trainANNCommittee(XtrS, ytr, {
        seeds: annCvSeeds,
        maxEpochs: Math.min(annMaxEpochs, options.annCvMaxEpochs ?? 120),
        lr: 1e-3,
        patience: 8,
        timeLimitMs: options.annCvTimeLimit ?? 20000
      });
      const preds = predictANNCommittee(annModel, XvaS);
      for (let j = 0; j < iva.length; j++) annOOF[iva[j]] = preds[j];
    }
  }

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
      const model = trainBTModel(btTr);
      const preds = predictBTDeterministic(model, btVa);
      for (let j = 0; j < iva.length; j++) btOOF[iva[j]] = preds[j]?.prob ?? 0.5;
    }
  }

  const weightsGrid = enumerateWeights(options.weightStep ?? 0.05);
  const metrics = [];
  for (const w of weightsGrid) {
    const blend = labels.map((_, i) =>
      w.logistic * (oofLogit[i] ?? 0.5) +
      w.tree * (oofTree[i] ?? 0.5) +
      w.bt * (btOOF[i] ?? 0.5) +
      w.ann * (annOOF[i] ?? 0.5)
    );
    metrics.push({ weights: w, loss: logloss(blend, labels) ?? Infinity });
  }
  metrics.sort((a, b) => a.loss - b.loss);
  const bestWeights = metrics[0]?.weights ?? defaultWeights();
  const clampedWeights = clampWeights(bestWeights, weeksSeen || 1);
  const oofBlend = labels.map((_, i) =>
    clampedWeights.logistic * (oofLogit[i] ?? 0.5) +
    clampedWeights.tree * (oofTree[i] ?? 0.5) +
    clampedWeights.bt * (btOOF[i] ?? 0.5) +
    clampedWeights.ann * (annOOF[i] ?? 0.5)
  );
  const calibrator = plattCalibrate(oofBlend, labels);
  const oofBlendCal = oofBlend.map((p) => applyPlatt(p, calibrator));

  const logitModelFull = trainLogisticGD(trainStd, labels, { steps: 3500, lr: 4e-3, l2: 2e-4 });
  const treeParams = chooseTreeParams(trainStd.length);
  const cartFull = new CART({ maxDepth: treeParams.depth, minNumSamples: treeParams.minSamples, gainFunction: "gini" });
  if (trainStd.length) cartFull.train(trainStd, labels);
  const leafStatsFull = buildLeafFreq(cartFull, trainStd, labels, laplaceAlpha(trainStd.length));
  const annModelFull = trainANNCommittee(trainStd, labels, {
    seeds: annSeeds,
    maxEpochs: annMaxEpochs,
    lr: 1e-3,
    patience: 10,
    timeLimitMs: options.annTimeLimit ?? 60000
  });
  const btModelFull = trainBTModel(btTrainRows);

  const testMatrix = matrixFromRows(testRows, FEATS);
  const testStd = applyScaler(testMatrix, scaler);
  const logitTest = predictLogit(testStd, logitModelFull);
  const treeTest = predictTree(cartFull, leafStatsFull, testStd);
  const annTest = predictANNCommittee(annModelFull, testStd);
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
      logistic: logitTest[i] ?? 0.5,
      tree: treeTest[i] ?? 0.5,
      bt: btInfo.prob ?? 0.5,
      ann: annTest[i] ?? 0.5
    };
    const preBlend =
      clampedWeights.logistic * probs.logistic +
      clampedWeights.tree * probs.tree +
      clampedWeights.bt * probs.bt +
      clampedWeights.ann * probs.ann;
    const blended = applyPlatt(preBlend, calibrator);
    probs.blended = blended;

    const contribLogit = logitModelFull.w.map((w, idx) => ({
      feature: FEATS[idx],
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
    const contribAnn = gradAnn.map((g, idx) => ({ feature: FEATS[idx], value: g }));
    const drivers = buildTopDrivers({
      logisticContribs: contribLogit,
      treeInfo: { path, winrate: leafWin },
      btContribs: contribBT,
      annGrad: contribAnn
    });

    predictions.push({
      game_id: btRow.game_id,
      home_team: row.team,
      away_team: row.opponent,
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
        logistic: round3(clampedWeights.logistic),
        tree: round3(clampedWeights.tree),
        bt: round3(clampedWeights.bt),
        ann: round3(clampedWeights.ann)
      },
      calibration: {
        pre: round3(preBlend),
        post: round3(blended)
      },
      ci: {
        bt90: btInfo.ci90?.map((v) => round3(v)) ?? [0.25, 0.75]
      },
      natural_language: buildNarrative(
        { home_team: row.team, away_team: row.opponent },
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
      logloss: logloss(oofLogit, labels),
      brier: brier(oofLogit, labels),
      auc: auc(oofLogit, labels)
    },
    tree: {
      logloss: logloss(oofTree, labels),
      brier: brier(oofTree, labels),
      auc: auc(oofTree, labels)
    },
    bt: {
      logloss: logloss(btOOF, labels),
      brier: brier(btOOF, labels),
      auc: auc(btOOF, labels)
    },
    ann: {
      logloss: logloss(annOOF, labels),
      brier: brier(annOOF, labels),
      auc: auc(annOOF, labels)
    },
    ensemble: {
      logloss: logloss(oofBlendCal, labels),
      brier: brier(oofBlendCal, labels),
      auc: auc(oofBlendCal, labels)
    }
  };

  const diagnostics = {
    season: resolvedSeason,
    week: resolvedWeek,
    metrics: metricsSummary,
    blend_weights: clampedWeights,
    calibration_beta: calibrator.beta ?? 0,
    calibration_bins: calibrationBins(oofBlendCal, labels),
    n_train_rows: nTrain,
    weeks_seen: weeksSeen,
    training_weeks: [...new Set(trainRows.map((r) => r.week))].sort((a, b) => a - b)
  };

  const pca = computePCA(trainStd, FEATS);

  const modelSummary = {
    season: resolvedSeason,
    week: resolvedWeek,
    generated_at: new Date().toISOString(),
    logistic: {
      weights: logitModelFull.w,
      bias: logitModelFull.b,
      scaler,
      features: FEATS
    },
    decision_tree: {
      params: treeParams,
      alpha: leafStatsFull.alpha
    },
    bt: {
      coefficients: btModelFull.w,
      intercept: btModelFull.b,
      scaler: btModelFull.scaler,
      features: BT_FEATURES
    },
    ann: {
      seeds: annModelFull.seeds,
      architecture: annModelFull.architecture,
      committee_size: annModelFull.models.length
    },
    ensemble: {
      weights: clampedWeights,
      calibration_beta: calibrator.beta ?? 0
    },
    pca
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

  return {
    season: resolvedSeason,
    week: resolvedWeek,
    predictions,
    modelSummary,
    diagnostics,
    btDebug
  };
}

function writeArtifacts(result) {
  const stamp = `${result.season}_W${String(result.week).padStart(2, "0")}`;
  writeFileSync(`${ART_DIR}/predictions_${stamp}.json`, JSON.stringify(result.predictions, null, 2));
  writeFileSync(`${ART_DIR}/model_${stamp}.json`, JSON.stringify(result.modelSummary, null, 2));
  writeFileSync(`${ART_DIR}/diagnostics_${stamp}.json`, JSON.stringify(result.diagnostics, null, 2));
  writeFileSync(`${ART_DIR}/bt_features_${stamp}.json`, JSON.stringify(result.btDebug, null, 2));
}

async function main() {
  const season = Number(process.env.SEASON ?? new Date().getFullYear());
  const weekEnv = Number(process.env.WEEK ?? 6);
  const result = await runTraining({ season, week: weekEnv });
  writeArtifacts(result);
  console.log(`Trained ensemble for season ${result.season} week ${result.week}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
