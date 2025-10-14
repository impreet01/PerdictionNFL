// trainer/train_multi.js
// Multi-model ensemble trainer with logistic+CART, Bradley-Terry, and ANN committee.

import fs from "node:fs";
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
  listDatasetSeasons
} from "./dataSources.js";
import { buildContextForWeek } from "./contextPack.js";
import { writeExplainArtifact } from "./explainRubric.js";
import { buildFeatures, FEATS as FEATS_BASE } from "./featureBuild.js";
import { buildBTFeatures, BT_FEATURES } from "./featureBuild_bt.js";
import { trainBTModel, predictBT, predictBTDeterministic } from "./model_bt.js";
import { trainANNCommittee, predictANNCommittee, gradientANNCommittee } from "./model_ann.js";
import { DecisionTreeClassifier as CART } from "ml-cart";
import { Matrix, SVD } from "ml-matrix";
import { logLoss, brier, accuracy, aucRoc, calibrationBins } from "./metrics.js";
import { buildSeasonDB, attachAdvWeeklyDiff, resolveSeasonList } from "./databases.js";
import {
  loadTrainingState,
  saveTrainingState,
  shouldRunHistoricalBootstrap,
  markBootstrapCompleted,
  recordLatestRun,
  BOOTSTRAP_KEYS,
  CURRENT_BOOTSTRAP_REVISION
} from "./trainingState.js";
import { ensureTrainingStateCurrent } from "./bootstrapState.js";

const { writeFileSync, mkdirSync, readFileSync, existsSync } = fs;

const ART_DIR = "artifacts";
mkdirSync(ART_DIR, { recursive: true });

const DEFAULT_MIN_TRAIN_SEASON = 2020;
const DEFAULT_MAX_TRAIN_SEASONS = Number.POSITIVE_INFINITY;

const envMinSeason = Number(process.env.MIN_TRAIN_SEASON);
const MIN_TRAIN_SEASON = Number.isFinite(envMinSeason) ? envMinSeason : DEFAULT_MIN_TRAIN_SEASON;

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
  return `${ART_DIR}/${prefix}_${weekStamp(season, week)}.json`;
}

function weekArtifactsExist(season, week) {
  return HISTORICAL_ARTIFACT_PREFIXES.every((prefix) => existsSync(artifactPath(prefix, season, week)));
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
  { steps = 3000, lr = 5e-3, l2 = 2e-4, featureLength } = {}
) {
  const n = X.length;
  const observedDim = X[0]?.length || 0;
  const dim = Number.isInteger(featureLength) && featureLength > 0 ? featureLength : observedDim;
  let w = new Array(dim).fill(0);
  let b = 0;
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

function kfoldIndices(n, k) {
  if (n <= 1) return [[...Array(n).keys()]];
  const folds = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) {
    folds[i % k].push(i);
  }
  return folds;
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
  return str || null;
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

  const skipSeasonDB = Boolean(options.skipSeasonDB);
  const DB = skipSeasonDB ? null : await buildSeasonDB(resolvedSeason);

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

  let injuryRows;
  if (data.injuries !== undefined) {
    injuryRows = data.injuries;
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
  const FEATS_ENR = expandFeats(FEATS_BASE, featureRows);

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
  const trainMatrix = matrixFromRows(trainRows, FEATS_ENR);
  const scaler = fitScaler(trainMatrix.length ? trainMatrix : [new Array(FEATS_ENR.length).fill(0)]);
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
      const scalerFold = fitScaler(Xtr.length ? Xtr : [new Array(FEATS_ENR.length).fill(0)]);
      const XtrS = applyScaler(Xtr, scalerFold);
      const XvaS = applyScaler(Xva, scalerFold);
      const logitModel = trainLogisticGD(XtrS, ytr, {
        steps: 2500,
        lr: 4e-3,
        l2: 2e-4,
        featureLength: FEATS_ENR.length
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

  // --- BEGIN: robust ANN OOF ---
  const annSeeds = options.annSeeds ?? Number(process.env.ANN_SEEDS ?? 5); // committee size
  const annMaxEpochs = options.annMaxEpochs ?? Number(process.env.ANN_MAX_EPOCHS ?? 250);
  const annCvSeeds = Math.max(3, Math.min(annSeeds, options.annCvSeeds ?? 5));
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
        maxEpochs: Math.min(annMaxEpochs, options.annCvMaxEpochs ?? 150),
        lr: 1e-3,
        patience: 10,
        timeLimitMs: options.annCvTimeLimit ?? 25000
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
      const model = trainBTModel(btTr);
      const preds = predictBTDeterministic(model, btVa);
      for (let j = 0; j < iva.length; j++) btOOF[iva[j]] = safeProb(preds[j]?.prob);
    }
  }

  const weightsGrid = enumerateWeights(options.weightStep ?? 0.05);
  const metrics = [];
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
    metrics.push({ weights: w, loss: logLoss(labels, blend) ?? Infinity });
  }
  metrics.sort((a, b) => a.loss - b.loss);
  const bestWeights = metrics[0]?.weights ?? defaultWeights();
  const clampedWeights = clampWeights(bestWeights, weeksSeen || 1);
  const oofBlendRaw = labels.map((_, i) =>
    toFiniteNumber(clampedWeights.logistic, 0) * safeProb(oofLogit[i]) +
    toFiniteNumber(clampedWeights.tree, 0) * safeProb(oofTree[i]) +
    toFiniteNumber(clampedWeights.bt, 0) * safeProb(btOOF[i]) +
    toFiniteNumber(clampedWeights.ann, 0) * safeProb(annOOF[i])
  );
  const oofBlend = oofBlendRaw.map(safeProb);
  const calibrator = plattCalibrate(oofBlend, labels);
  const oofBlendCal = oofBlend.map((p) => safeProb(applyPlatt(p, calibrator)));

  const logitModelFull = trainLogisticGD(trainStd, labels, {
    steps: 3500,
    lr: 4e-3,
    l2: 2e-4,
    featureLength: FEATS_ENR.length
  });
  const treeParams = chooseTreeParams(trainStd.length);
  const cartFull = new CART({ maxDepth: treeParams.depth, minNumSamples: treeParams.minSamples, gainFunction: "gini" });
  if (trainStd.length) cartFull.train(trainStd, labels);
  const leafStatsFull = buildLeafFreq(cartFull, trainStd, labels, laplaceAlpha(trainStd.length));
  // --- BEGIN: robust ANN full fit ---
  const annModelFull = trainANNCommittee(trainStd, labels, {
    seeds: options.annSeeds ?? Number(process.env.ANN_SEEDS ?? 5),
    maxEpochs: options.annMaxEpochs ?? Number(process.env.ANN_MAX_EPOCHS ?? 300),
    lr: 1e-3,
    patience: 12,
    timeLimitMs: options.annTimeLimit ?? 70000
  });
  // --- END: robust ANN full fit ---
  const btModelFull = trainBTModel(btTrainRows);

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
    const blended = safeProb(applyPlatt(preBlend, calibrator));
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
    calibration_beta: calibrator.beta ?? 0,
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
    .map((p) => safeProb(applyPlatt(p, calibrator)));
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

  return {
    season: resolvedSeason,
    week: resolvedWeek,
    predictions,
    modelSummary,
    diagnostics,
    btDebug,
    schedules
  };
}

export async function writeArtifacts(result) {
  const stamp = `${result.season}_W${String(result.week).padStart(2, "0")}`;
  writeFileSync(`${ART_DIR}/predictions_${stamp}.json`, JSON.stringify(result.predictions, null, 2));
  // 1) Build & write context pack
  const context = Array.isArray(result.context)
    ? result.context
    : await buildContextForWeek(result.season, result.week);
  await fs.promises.writeFile(
    `${ART_DIR}/context_${result.season}_W${String(result.week).padStart(2, "0")}.json`,
    JSON.stringify(context, null, 2)
  );

  // 2) Compute & write explanation scorecards
  await writeExplainArtifact({
    season: result.season,
    week: result.week,
    predictions: Array.isArray(result.predictions)
      ? result.predictions
      : result.predictions?.games || result.predictions,
    context
  });
  writeFileSync(`${ART_DIR}/model_${stamp}.json`, JSON.stringify(result.modelSummary, null, 2));
  writeFileSync(`${ART_DIR}/diagnostics_${stamp}.json`, JSON.stringify(result.diagnostics, null, 2));
  writeFileSync(`${ART_DIR}/bt_features_${stamp}.json`, JSON.stringify(result.btDebug, null, 2));
}

export function updateHistoricalArtifacts({ season, schedules }) {
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
    const predictionPath = `${ART_DIR}/${predictionFilename}`;
    const outcomesPath = `${ART_DIR}/${outcomesFilename}`;
    const metricsPath = `${ART_DIR}/${metricsFilename}`;

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

    writeFileSync(outcomesPath, JSON.stringify(outcomes, null, 2));

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

    writeFileSync(metricsPath, JSON.stringify(metricsPayload, null, 2));
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
    latest_completed_week: latestCompletedWeek,
    cumulative,
    weeks: weeklySummaries.map((entry) => ({ week: entry.week, per_model: entry.per_model }))
  };

  writeFileSync(`${ART_DIR}/metrics_${season}.json`, JSON.stringify(seasonMetrics, null, 2));

  const seasonIndex = {
    season,
    latest_completed_week: latestCompletedWeek,
    weeks: weekMetadata
  };

  writeFileSync(`${ART_DIR}/season_index_${season}.json`, JSON.stringify(seasonIndex, null, 2));

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

  writeFileSync(`${ART_DIR}/season_summary_${season}.json`, JSON.stringify(seasonSummary, null, 2));
}

async function loadSeasonData(season) {
  const schedules = await loadSchedules(season);
  const teamWeekly = await loadTeamWeekly(season);

  let teamGame;
  try {
    teamGame = await loadTeamGameAdvanced(season);
  } catch (err) {
    teamGame = [];
  }

  let prevTeamWeekly;
  const prevSeason = season - 1;
  if (prevSeason >= MIN_TRAIN_SEASON) {
    try {
      prevTeamWeekly = await loadTeamWeekly(prevSeason);
    } catch (err) {
      prevTeamWeekly = [];
    }
  } else {
    prevTeamWeekly = [];
  }

  let pbp;
  try {
    pbp = await loadPBP(season);
  } catch (err) {
    pbp = [];
  }

  let playerWeekly;
  try {
    playerWeekly = await loadPlayerWeekly(season);
  } catch (err) {
    playerWeekly = [];
  }

  let rosters;
  try {
    rosters = await loadRostersWeekly(season);
  } catch (err) {
    rosters = [];
  }

  let depthCharts;
  try {
    depthCharts = await loadDepthCharts(season);
  } catch (err) {
    depthCharts = [];
  }

  let injuries;
  try {
    injuries = await loadInjuries(season);
  } catch (err) {
    injuries = [];
  }

  let snapCounts;
  try {
    snapCounts = await loadSnapCounts(season);
  } catch (err) {
    snapCounts = [];
  }

  let pfrAdv;
  try {
    pfrAdv = await loadPFRAdvTeam(season);
  } catch (err) {
    pfrAdv = [];
  }

  let qbr;
  try {
    qbr = await loadESPNQBR(season);
  } catch (err) {
    qbr = [];
  }

  let officials;
  try {
    officials = await loadOfficials();
  } catch (err) {
    officials = [];
  }

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
    officials
  };
}

async function main() {
  const targetSeason = Number(process.env.SEASON ?? new Date().getFullYear());
  let weekEnv = Number(process.env.WEEK ?? 6);
  if (!Number.isFinite(weekEnv) || weekEnv < 1) weekEnv = 1;

  let state = loadTrainingState();
  const refreshResult = ensureTrainingStateCurrent({ state, silent: true });
  state = refreshResult.state;
  if (refreshResult.refreshed) {
    console.log(
      `[train] Refreshed cached training_state metadata from artifacts (revision ${CURRENT_BOOTSTRAP_REVISION}).`
    );
  } else if (refreshResult.error) {
    console.warn(
      `[train] Unable to refresh cached training_state metadata from artifacts (${refreshResult.error.message ?? refreshResult.error}). Proceeding with trainer bootstrap.`
    );
  }
  const lastModelRun = state?.latest_runs?.[BOOTSTRAP_KEYS.MODEL];
  const historicalOverride = shouldRewriteHistorical();
  const bootstrapRequired = shouldRunHistoricalBootstrap(state, BOOTSTRAP_KEYS.MODEL);
  const allowHistoricalRewrite = historicalOverride || bootstrapRequired;

  let seasonsInScope = [targetSeason];
  if (bootstrapRequired || allowHistoricalRewrite) {
    const discoveredSeasons = await listDatasetSeasons("teamWeekly").catch(() => []);
    seasonsInScope = await resolveSeasonList({
      targetSeason,
      includeAll: true,
      sinceSeason: MIN_TRAIN_SEASON,
      maxSeasons: Number.isFinite(MAX_TRAIN_SEASONS) ? MAX_TRAIN_SEASONS : null,
      availableSeasons: discoveredSeasons
    });
  }

  if (bootstrapRequired) {
    console.log(
      `[train] Historical bootstrap required (expected revision ${CURRENT_BOOTSTRAP_REVISION}). Replaying seasons: ${seasonsInScope.join(", ")}`
    );
  } else if (historicalOverride) {
    console.log(
      `[train] Historical rewrite requested via override flag. Processing seasons: ${seasonsInScope.join(", ")}`
    );
  } else {
    const resumeWeek = Number.isFinite(Number(lastModelRun?.week))
      ? Number(lastModelRun.week) + 1
      : 1;
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
  let latestTargetResult = null;

  for (const resolvedSeason of seasonsInScope) {
    const sharedData = await loadSeasonData(resolvedSeason);
    const seasonWeeks = [...new Set(
      sharedData.schedules
        .filter((game) => Number(game.season) === resolvedSeason && isRegularSeason(game.season_type))
        .map((game) => Number(game.week))
        .filter((wk) => Number.isFinite(wk) && wk >= 1)
    )].sort((a, b) => a - b);

    if (!seasonWeeks.length) {
      console.warn(`[train] no regular-season weeks found for season ${resolvedSeason}`);
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

    let latestSeasonResult = null;
    const processedWeeks = [];

    for (const wk of seasonWeeks) {
      if (wk < startWeek) continue;
      if (wk > finalWeek) break;
      const result = await runTraining({ season: resolvedSeason, week: wk, data: sharedData });
      const hasArtifacts = weekArtifactsExist(resolvedSeason, wk);
      const isTargetWeek = resolvedSeason === targetSeason && wk === finalWeek;
      if (!allowHistoricalRewrite && hasArtifacts && !isTargetWeek) {
        console.log(
          `[train] skipping artifact write for season ${resolvedSeason} week ${wk} (historical artifacts locked)`
        );
      } else {
        await writeArtifacts(result);
      }
      latestSeasonResult = result;
      processedWeeks.push(result.week);
      if (resolvedSeason === targetSeason) {
        latestTargetResult = result;
      }
      console.log(`Trained ensemble for season ${result.season} week ${result.week}`);
    }

    if (!latestSeasonResult) {
      const fallbackResult = await runTraining({ season: resolvedSeason, week: finalWeek, data: sharedData });
      const hasArtifacts = weekArtifactsExist(fallbackResult.season, fallbackResult.week);
      const isTargetWeek = fallbackResult.season === targetSeason && fallbackResult.week === finalWeek;
      if (!allowHistoricalRewrite && hasArtifacts && !isTargetWeek) {
        console.log(
          `[train] skipping artifact write for season ${fallbackResult.season} week ${fallbackResult.week} (historical artifacts locked)`
        );
      } else {
        await writeArtifacts(fallbackResult);
      }
      latestSeasonResult = fallbackResult;
      if (!processedWeeks.includes(fallbackResult.week)) processedWeeks.push(fallbackResult.week);
      if (resolvedSeason === targetSeason) {
        latestTargetResult = fallbackResult;
      }
      console.log(`Trained ensemble for season ${fallbackResult.season} week ${fallbackResult.week}`);
    }

    if (processedWeeks.length) {
      processedSeasons.push({ season: resolvedSeason, weeks: processedWeeks.slice().sort((a, b) => a - b) });
    }

    if (latestSeasonResult) {
      updateHistoricalArtifacts({ season: latestSeasonResult.season, schedules: latestSeasonResult.schedules });
    }
  }

  if (bootstrapRequired) {
    state = markBootstrapCompleted(state, BOOTSTRAP_KEYS.MODEL, {
      seasons: processedSeasons.map((entry) => ({
        season: entry.season,
        weeks: entry.weeks
      }))
    });
  }

  if (latestTargetResult) {
    state = recordLatestRun(state, BOOTSTRAP_KEYS.MODEL, {
      season: latestTargetResult.season,
      week: latestTargetResult.week
    });
  } else {
    state = recordLatestRun(state, BOOTSTRAP_KEYS.MODEL, {
      season: targetSeason,
      week: Math.max(1, Math.floor(weekEnv))
    });
  }

  saveTrainingState(state);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
