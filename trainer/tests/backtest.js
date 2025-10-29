// trainer/tests/backtest.js
// Backtest ensemble performance across recent weeks and refresh explain thresholds.

import { runTraining } from "../train_multi.js";
import { loadSchedules, loadTeamWeekly } from "../dataSources.js";
import { buildContextForWeek } from "../contextPack.js";
import { extractFactorSignals, calibrateThresholds } from "../explainRubric.js";
import { logLoss, aucRoc, accuracy } from "../metrics.js";

function regression(points) {
  if (!points.length) return { slope: 1, intercept: 0 };
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const { x, y } of points) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = Math.max(1e-9, n * sumXX - sumX * sumX);
  const slope = denom === 0 ? 1 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function logisticFromElo(diff) {
  if (!Number.isFinite(diff)) return null;
  return 1 / (1 + Math.pow(10, -diff / 400));
}

function probabilityFromContext(prediction, ctxEntry) {
  if (!ctxEntry || !ctxEntry.context) return { elo: null, market: null };
  const ctx = ctxEntry.context;
  const elo = logisticFromElo(ctx.elo?.diff ?? null);
  let market = null;
  if (ctx.market) {
    const { implied_prob_home, implied_prob_away } = ctx.market;
    if (Number.isFinite(implied_prob_home) && Number.isFinite(implied_prob_away)) {
      market = implied_prob_home;
    } else if (Number.isFinite(ctx.market.spread_home)) {
      const spreadProb = 1 / (1 + Math.exp(-ctx.market.spread_home / 7));
      market = spreadProb;
    }
  }
  const homeTeam = prediction.home_team;
  const base = {
    elo: elo != null ? elo : null,
    market: market != null ? market : null
  };
  if (homeTeam !== prediction.home_team) return base;
  return base;
}

function selectBaselineProb(prob, pickHome) {
  if (!Number.isFinite(prob)) return null;
  return pickHome ? prob : 1 - prob;
}

async function main() {
  const season = Number(process.env.SEASON ?? new Date().getFullYear());
  const schedules = await loadSchedules(season);
  const teamWeekly = await loadTeamWeekly(season);
  let prev = [];
  try {
    prev = await loadTeamWeekly(season - 1);
  } catch (e) {
    prev = [];
  }

  const weeks = [...new Set(
    teamWeekly
      .filter((r) => Number(r.season) === season)
      .map((r) => Number(r.week))
      .filter(Number.isFinite)
  )].sort((a, b) => a - b);
  const maxWeek = weeks.length ? weeks[weeks.length - 1] : 0;
  const targetWeeks = weeks.filter((w) => w >= 2 && w <= Math.min(maxWeek, Number(process.env.BACKTEST_WEEKS ?? 8)));

  const results = [];
  const calibrationPoints = [];
  const calibrationSamples = [];
  const labelsAll = [];
  const blendAll = [];
  const eloPairs = [];
  const marketPairs = [];

  const baseOptions = {
    btBootstrapSamples: Number(process.env.BT_B ?? 300),
    annSeeds: Number(process.env.ANN_SEEDS ?? 7),
    annMaxEpochs: 150,
    annCvMaxEpochs: 90,
    annCvSeeds: 4,
    weightStep: 0.05
  };

  const weekOneRun = await runTraining({
    season,
    week: 1,
    data: { schedules, teamWeekly, prevTeamWeekly: prev },
    options: baseOptions
  });
  if (!Array.isArray(weekOneRun.predictions) || !weekOneRun.predictions.length) {
    throw new Error("Backtest: week 1 predictions missing");
  }
  const invalidWeekOne = weekOneRun.predictions?.filter((p) => {
    if (!Number.isFinite(p?.forecast)) return true;
    if (!p?.probs || typeof p.probs !== "object") return true;
    return Object.values(p.probs).some((v) => !Number.isFinite(v));
  });
  if (invalidWeekOne?.length) {
    throw new Error("Backtest: week 1 predictions contain non-finite probabilities");
  }

  for (const week of targetWeeks) {
    const run = await runTraining({
      season,
      week,
      data: { schedules, teamWeekly, prevTeamWeekly: prev },
      options: baseOptions
    });
    const context = await buildContextForWeek(season, week);
    const contextMap = new Map(context.map((c) => [c.game_id, c]));
    const actualRows = run.predictions.filter((p) => p.actual === 0 || p.actual === 1);
    if (!actualRows.length) continue;

    const logistic = actualRows.map((p) => p.probs.logistic);
    const tree = actualRows.map((p) => p.probs.tree);
    const bt = actualRows.map((p) => p.probs.bt);
    const ann = actualRows.map((p) => p.probs.ann);
    const blend = actualRows.map((p) => p.probs.blended);
    const labels = actualRows.map((p) => p.actual);
    const aligned = [logistic, tree, bt, ann, blend];
    if (aligned.some((arr) => arr.length !== labels.length)) {
      throw new Error(`Probability/label length mismatch for week ${week}`);
    }

    for (let i = 0; i < actualRows.length; i++) {
      const row = actualRows[i];
      const ctxEntry = contextMap.get(row.game_id) || null;
      const pickHome = row.probs.blended >= 0.5;
      const baselines = probabilityFromContext(row, ctxEntry);
      const eloProb = selectBaselineProb(baselines.elo, pickHome);
      const marketProb = selectBaselineProb(baselines.market, pickHome);
      if (Number.isFinite(eloProb)) {
        eloPairs.push({ label: labels[i], prob: eloProb });
      }
      if (Number.isFinite(marketProb)) {
        marketPairs.push({ label: labels[i], prob: marketProb });
      }
      labelsAll.push(labels[i]);
      blendAll.push(blend[i]);

      const signals = extractFactorSignals(row, ctxEntry);
      if (signals) {
        calibrationSamples.push({ metrics: signals });
      }
    }

    results.push({
      week,
      losses: {
        logistic: logLoss(labels, logistic),
        tree: logLoss(labels, tree),
        bt: logLoss(labels, bt),
        ann: logLoss(labels, ann),
        blended: logLoss(labels, blend)
      }
    });

    const bins = run.diagnostics?.calibration_bins || [];
    for (const b of bins) {
      if (b.mean_pred != null && b.empirical != null && b.count > 0) {
        calibrationPoints.push({ x: b.mean_pred, y: b.empirical });
      }
    }
  }

  if (!results.length) {
    console.log("No completed weeks available for backtest.");
    return;
  }

  const improvements = results
    .filter((r) => r.week >= 4 && r.losses.blended != null)
    .map((r) => {
      const indiv = [r.losses.logistic, r.losses.tree, r.losses.bt, r.losses.ann].filter((v) => v != null);
      const best = Math.min(...indiv);
      return { week: r.week, blended: r.losses.blended, best };
    });

  for (const entry of improvements) {
    if (!(entry.blended <= entry.best * 0.99)) {
      throw new Error(`Ensemble underperformed in week ${entry.week}: blended ${entry.blended} vs best ${entry.best}`);
    }
  }

  const reg = regression(calibrationPoints);
  if (Math.abs(reg.slope - 1) > 0.35 || Math.abs(reg.intercept) > 0.1) {
    throw new Error(`Calibration drift detected: slope=${reg.slope.toFixed(2)}, intercept=${reg.intercept.toFixed(2)}`);
  }

  const ensembleLogLoss = logLoss(labelsAll, blendAll);
  const ensembleAuc = aucRoc(labelsAll, blendAll);
  const ensembleAcc = accuracy(labelsAll, blendAll);

  const eloMetrics = {
    logloss: eloPairs.length ? logLoss(eloPairs.map((p) => p.label), eloPairs.map((p) => p.prob)) : null,
    auc: eloPairs.length ? aucRoc(eloPairs.map((p) => p.label), eloPairs.map((p) => p.prob)) : null,
    accuracy: eloPairs.length ? accuracy(eloPairs.map((p) => p.label), eloPairs.map((p) => p.prob)) : null
  };
  const marketMetrics = {
    logloss: marketPairs.length ? logLoss(marketPairs.map((p) => p.label), marketPairs.map((p) => p.prob)) : null,
    auc: marketPairs.length ? aucRoc(marketPairs.map((p) => p.label), marketPairs.map((p) => p.prob)) : null,
    accuracy: marketPairs.length ? accuracy(marketPairs.map((p) => p.label), marketPairs.map((p) => p.prob)) : null
  };

  if (ensembleLogLoss == null || ensembleAuc == null || ensembleAcc == null) {
    throw new Error("Ensemble metrics could not be computed for backtest");
  }
  if (ensembleLogLoss > 0.6 || ensembleAuc < 0.7 || ensembleAcc < 0.65) {
    throw new Error(
      `Ensemble quality regression detected: logloss=${ensembleLogLoss.toFixed(3)}, auc=${ensembleAuc.toFixed(3)}, acc=${(
        ensembleAcc * 100
      ).toFixed(2)}%`
    );
  }
  if (eloMetrics.logloss != null && ensembleLogLoss > eloMetrics.logloss * 1.01) {
    throw new Error(
      `Ensemble logloss ${ensembleLogLoss.toFixed(3)} failed to improve on Elo ${eloMetrics.logloss.toFixed(3)}`
    );
  }
  if (marketMetrics.logloss != null && ensembleLogLoss > marketMetrics.logloss * 1.01) {
    throw new Error(
      `Ensemble logloss ${ensembleLogLoss.toFixed(3)} failed to improve on market ${marketMetrics.logloss.toFixed(3)}`
    );
  }

  calibrateThresholds(calibrationSamples, { persist: true });

  console.log(
    JSON.stringify(
      {
        season,
        weeks: results.map((r) => r.week),
        losses: results,
        calibration: reg,
        ensemble: {
          logloss: ensembleLogLoss,
          auc: ensembleAuc,
          accuracy: ensembleAcc
        },
        baselines: {
          elo: eloMetrics,
          market: marketMetrics
        }
      },
      null,
      2
    )
  );
}

function isNetworkUnavailable(err) {
  if (!err || typeof err !== "object") return false;
  const codes = new Set();
  if (typeof err.code === "string") codes.add(err.code);
  const cause = err.cause;
  if (cause && typeof cause === "object") {
    if (typeof cause.code === "string") codes.add(cause.code);
    if (Array.isArray(cause.errors)) {
      for (const sub of cause.errors) {
        if (sub && typeof sub === "object" && typeof sub.code === "string") {
          codes.add(sub.code);
        }
      }
    }
  }
  return [...codes].some((code) => code && ["ENETUNREACH", "ECONNREFUSED", "EAI_AGAIN"].includes(code));
}

main().catch((err) => {
  if (isNetworkUnavailable(err)) {
    console.warn("[backtest] Network unavailable – skipping backtest assertions.");
    return;
  }
  console.error(err);
  process.exit(1);
});
