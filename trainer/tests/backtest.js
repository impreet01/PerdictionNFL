// trainer/tests/backtest.js
// Backtest ensemble performance across recent weeks.

import { runTraining } from "../train_multi.js";
import { loadSchedules, loadTeamWeekly } from "../dataSources.js";

const logloss = (probs, labels) => {
  if (!labels.length) return null;
  const eps = 1e-12;
  let sum = 0;
  for (let i = 0; i < labels.length; i++) {
    const p = Math.min(Math.max(probs[i], eps), 1 - eps);
    sum += -(labels[i] * Math.log(p) + (1 - labels[i]) * Math.log(1 - p));
  }
  return sum / labels.length;
};

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
  const slope = (n * sumXY - sumX * sumY) / Math.max(1e-9, n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
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

  const weeks = [...new Set(teamWeekly.filter((r) => Number(r.season) === season).map((r) => Number(r.week)).filter(Number.isFinite))].sort((a, b) => a - b);
  const maxWeek = weeks.length ? weeks[weeks.length - 1] : 0;
  const targetWeeks = weeks.filter((w) => w >= 2 && w <= Math.min(maxWeek, Number(process.env.BACKTEST_WEEKS ?? 8)));

  const results = [];
  const calibrationPoints = [];

  for (const week of targetWeeks) {
    const run = await runTraining({
      season,
      week,
      data: { schedules, teamWeekly, prevTeamWeekly: prev },
      options: {
        btBootstrapSamples: Number(process.env.BT_B ?? 300),
        annSeeds: Number(process.env.ANN_SEEDS ?? 7),
        annMaxEpochs: 150,
        annCvMaxEpochs: 90,
        annCvSeeds: 4,
        weightStep: 0.05
      }
    });
    const actualRows = run.predictions.filter((p) => p.actual === 0 || p.actual === 1);
    if (!actualRows.length) continue;
    const logistic = actualRows.map((p) => p.probs.logistic);
    const tree = actualRows.map((p) => p.probs.tree);
    const bt = actualRows.map((p) => p.probs.bt);
    const ann = actualRows.map((p) => p.probs.ann);
    const blend = actualRows.map((p) => p.probs.blended);
    const labels = actualRows.map((p) => p.actual);
    results.push({
      week,
      losses: {
        logistic: logloss(logistic, labels),
        tree: logloss(tree, labels),
        bt: logloss(bt, labels),
        ann: logloss(ann, labels),
        blended: logloss(blend, labels)
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

  const improvements = results.filter((r) => r.week >= 4 && r.losses.blended != null).map((r) => {
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

  console.log(JSON.stringify({
    season,
    weeks: results.map((r) => r.week),
    losses: results,
    calibration: reg
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
