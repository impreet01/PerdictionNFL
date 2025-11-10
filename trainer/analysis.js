// trainer/analysis.js
// Enhanced analysis and reporting tools for model performance evaluation.
//
// This module provides:
// - ROI/betting metrics calculations
// - Segmented performance reports (favorites/underdogs, home/away, divisional, etc.)
// - Feature importance tracking
// - Error analysis
// - Enhanced calibration metrics

import { logLoss, brier, accuracy, aucRoc } from "./metrics.js";
import { loadAnalysisFlags } from "./featureFlags.js";
import { isDivisionalGame } from "./nflReference.js";

/**
 * Calculate ROI (Return on Investment) for betting scenarios.
 * @param {Array} predictions - Array of prediction objects with forecast, actual, etc.
 * @param {number} threshold - Confidence threshold for placing bets (default 0.55)
 * @returns {Object} ROI metrics
 */
export function calculateROI(predictions, threshold = 0.55) {
  let totalBets = 0;
  let totalWins = 0;
  let totalUnits = 0;
  let profitUnits = 0;

  for (const pred of predictions) {
    if (pred.forecast >= threshold) {
      totalBets += 1;
      totalUnits += 1;

      if (pred.actual === 1) {
        totalWins += 1;
        profitUnits += 0.91; // Standard -110 odds payout
      } else {
        profitUnits -= 1;
      }
    }
  }

  const winRate = totalBets > 0 ? totalWins / totalBets : 0;
  const roi = totalUnits > 0 ? (profitUnits / totalUnits) * 100 : 0;

  return {
    totalBets,
    totalWins,
    winRate: Number(winRate.toFixed(4)),
    totalUnits,
    profitUnits: Number(profitUnits.toFixed(2)),
    roi: Number(roi.toFixed(2)),
    breakEvenRate: 0.524 // Need 52.4% to break even at -110 odds
  };
}

/**
 * Segment predictions by various criteria.
 * @param {Array} predictions - Array of prediction objects
 * @returns {Object} Segmented prediction arrays
 */
export function segmentPredictions(predictions) {
  const segments = {
    all: predictions,
    favorites: predictions.filter((p) => p.forecast >= 0.5),
    underdogs: predictions.filter((p) => p.forecast < 0.5),
    homeTeams: predictions.filter((p) => p.home === 1 || p.home_team === p.team),
    awayTeams: predictions.filter((p) => p.home === 0 || p.away_team === p.team),
    divisionalGames: [],
    nonDivisionalGames: [],
    highConfidence: predictions.filter((p) => p.forecast >= 0.65 || p.forecast <= 0.35),
    mediumConfidence: predictions.filter((p) => p.forecast > 0.45 && p.forecast < 0.65),
    tossups: predictions.filter((p) => p.forecast >= 0.45 && p.forecast <= 0.55)
  };

  // Divisional game segmentation (requires home_team and away_team fields)
  for (const pred of predictions) {
    if (pred.home_team && pred.away_team) {
      if (isDivisionalGame(pred.home_team, pred.away_team)) {
        segments.divisionalGames.push(pred);
      } else {
        segments.nonDivisionalGames.push(pred);
      }
    }
  }

  // Week ranges
  segments.earlyWeeks = predictions.filter((p) => p.week >= 1 && p.week <= 6);
  segments.midWeeks = predictions.filter((p) => p.week >= 7 && p.week <= 13);
  segments.lateWeeks = predictions.filter((p) => p.week >= 14);

  return segments;
}

/**
 * Calculate metrics for a segment of predictions.
 * @param {Array} segment - Array of predictions
 * @returns {Object} Metrics for the segment
 */
export function calculateSegmentMetrics(segment) {
  if (!segment || segment.length === 0) {
    return {
      count: 0,
      logLoss: null,
      brier: null,
      accuracy: null,
      auc: null
    };
  }

  const yTrue = segment.map((p) => p.actual);
  const probs = segment.map((p) => p.forecast);

  return {
    count: segment.length,
    logLoss: logLoss(yTrue, probs),
    brier: brier(yTrue, probs),
    accuracy: accuracy(yTrue, probs),
    auc: aucRoc(yTrue, probs)
  };
}

/**
 * Generate segmented performance report.
 * @param {Array} predictions - Array of prediction objects
 * @returns {Object} Segmented performance report
 */
export function generateSegmentedReport(predictions) {
  const segments = segmentPredictions(predictions);
  const report = {};

  for (const [segmentName, segmentData] of Object.entries(segments)) {
    report[segmentName] = calculateSegmentMetrics(segmentData);
  }

  return report;
}

/**
 * Calculate calibration error (Expected Calibration Error - ECE).
 * @param {Array} predictions - Array of prediction objects
 * @param {number} numBins - Number of calibration bins (default 10)
 * @returns {Object} Calibration metrics
 */
export function calculateCalibrationError(predictions, numBins = 10) {
  if (!predictions || predictions.length === 0) {
    return { ece: null, mce: null, bins: [] };
  }

  const bins = Array.from({ length: numBins }, (_, i) => ({
    lower: i / numBins,
    upper: (i + 1) / numBins,
    predictions: [],
    avgPredicted: 0,
    avgActual: 0,
    count: 0,
    error: 0
  }));

  // Assign predictions to bins
  for (const pred of predictions) {
    const prob = pred.forecast;
    const binIdx = Math.min(numBins - 1, Math.floor(prob * numBins));
    bins[binIdx].predictions.push(pred);
  }

  // Calculate bin statistics
  let ece = 0;
  let mce = 0;

  for (const bin of bins) {
    if (bin.predictions.length === 0) continue;

    bin.count = bin.predictions.length;
    bin.avgPredicted = bin.predictions.reduce((sum, p) => sum + p.forecast, 0) / bin.count;
    bin.avgActual = bin.predictions.reduce((sum, p) => sum + p.actual, 0) / bin.count;
    bin.error = Math.abs(bin.avgPredicted - bin.avgActual);

    ece += (bin.count / predictions.length) * bin.error;
    mce = Math.max(mce, bin.error);
  }

  return {
    ece: Number(ece.toFixed(4)),
    mce: Number(mce.toFixed(4)),
    bins: bins.map((b) => ({
      lower: b.lower,
      upper: b.upper,
      count: b.count,
      avgPredicted: Number(b.avgPredicted.toFixed(4)),
      avgActual: Number(b.avgActual.toFixed(4)),
      error: Number(b.error.toFixed(4))
    }))
  };
}

/**
 * Perform error analysis to identify patterns in mispredictions.
 * @param {Array} predictions - Array of prediction objects
 * @returns {Object} Error analysis results
 */
export function analyzeErrors(predictions) {
  if (!predictions || predictions.length === 0) {
    return { topErrors: [], errorPatterns: {} };
  }

  // Calculate prediction errors
  const errors = predictions.map((pred) => ({
    ...pred,
    error: Math.abs(pred.forecast - pred.actual),
    correct: (pred.forecast >= 0.5 && pred.actual === 1) || (pred.forecast < 0.5 && pred.actual === 0)
  }));

  // Sort by error magnitude
  const topErrors = errors
    .sort((a, b) => b.error - a.error)
    .slice(0, 20)
    .map((e) => ({
      game_id: e.game_id,
      forecast: e.forecast,
      actual: e.actual,
      error: Number(e.error.toFixed(4)),
      home_team: e.home_team,
      away_team: e.away_team,
      week: e.week
    }));

  // Identify error patterns
  const errorPatterns = {
    overconfidentWins: errors.filter((e) => e.forecast >= 0.65 && e.actual === 0).length,
    overconfidentLosses: errors.filter((e) => e.forecast <= 0.35 && e.actual === 1).length,
    tossupMisses: errors.filter((e) => e.forecast >= 0.45 && e.forecast <= 0.55 && !e.correct).length,
    favoriteUpsets: errors.filter((e) => e.forecast >= 0.6 && e.actual === 0).length,
    underdogWins: errors.filter((e) => e.forecast <= 0.4 && e.actual === 1).length
  };

  return {
    topErrors,
    errorPatterns,
    totalErrors: errors.filter((e) => !e.correct).length,
    errorRate: Number((errors.filter((e) => !e.correct).length / errors.length).toFixed(4))
  };
}

/**
 * Track feature importance from model coefficients or weights.
 * @param {Object} model - Model object with coefficients or feature importances
 * @param {Array<string>} featureNames - List of feature names
 * @returns {Array<Object>} Feature importance rankings
 */
export function trackFeatureImportance(model, featureNames) {
  if (!model || !featureNames) {
    return [];
  }

  let importances = [];

  // Logistic regression: use coefficient magnitudes
  if (model.theta) {
    importances = featureNames.map((name, idx) => ({
      feature: name,
      importance: Math.abs(model.theta[idx] || 0),
      coefficient: model.theta[idx] || 0
    }));
  }
  // Decision tree: use feature importance scores
  else if (model.featureImportance) {
    importances = featureNames.map((name, idx) => ({
      feature: name,
      importance: model.featureImportance[idx] || 0,
      coefficient: null
    }));
  }
  // Generic: assume coefficients array
  else if (Array.isArray(model)) {
    importances = featureNames.map((name, idx) => ({
      feature: name,
      importance: Math.abs(model[idx] || 0),
      coefficient: model[idx] || 0
    }));
  }

  // Sort by importance descending
  return importances.sort((a, b) => b.importance - a.importance);
}

/**
 * Generate comprehensive analysis report.
 * @param {Array} predictions - Array of prediction objects
 * @param {Object} model - Model object (optional)
 * @param {Array<string>} featureNames - Feature names (optional)
 * @returns {Object} Comprehensive analysis report
 */
export function generateAnalysisReport(predictions, model = null, featureNames = null) {
  const flags = loadAnalysisFlags();
  const report = {
    summary: calculateSegmentMetrics(predictions)
  };

  // ROI metrics
  if (flags.enableROIMetrics) {
    report.roi = {
      threshold_55: calculateROI(predictions, 0.55),
      threshold_60: calculateROI(predictions, 0.60),
      threshold_65: calculateROI(predictions, 0.65)
    };
  }

  // Segmented reports
  if (flags.enableSegmentedReports) {
    report.segments = generateSegmentedReport(predictions);
  }

  // Calibration analysis
  report.calibration = calculateCalibrationError(predictions);

  // Error analysis
  report.errors = analyzeErrors(predictions);

  // Feature importance
  if (flags.enableFeatureImportance && model && featureNames) {
    const importance = trackFeatureImportance(model, featureNames);
    report.featureImportance = {
      top20: importance.slice(0, 20),
      all: importance
    };
  }

  return report;
}

/**
 * Compare two models or variants (for A/B testing).
 * @param {Array} predictionsA - Predictions from model A
 * @param {Array} predictionsB - Predictions from model B
 * @param {string} nameA - Name of model A
 * @param {string} nameB - Name of model B
 * @returns {Object} Comparison report
 */
export function compareModels(predictionsA, predictionsB, nameA = "Model A", nameB = "Model B") {
  const metricsA = calculateSegmentMetrics(predictionsA);
  const metricsB = calculateSegmentMetrics(predictionsB);

  const comparison = {
    [nameA]: metricsA,
    [nameB]: metricsB,
    differences: {
      logLoss: metricsA.logLoss !== null && metricsB.logLoss !== null
        ? Number((metricsB.logLoss - metricsA.logLoss).toFixed(4))
        : null,
      brier: metricsA.brier !== null && metricsB.brier !== null
        ? Number((metricsB.brier - metricsA.brier).toFixed(4))
        : null,
      accuracy: metricsA.accuracy !== null && metricsB.accuracy !== null
        ? Number((metricsB.accuracy - metricsA.accuracy).toFixed(4))
        : null,
      auc: metricsA.auc !== null && metricsB.auc !== null
        ? Number((metricsB.auc - metricsA.auc).toFixed(4))
        : null
    },
    winner: null
  };

  // Determine winner (lower log loss is better)
  if (metricsA.logLoss !== null && metricsB.logLoss !== null) {
    comparison.winner = metricsA.logLoss < metricsB.logLoss ? nameA : nameB;
  }

  return comparison;
}

export default {
  calculateROI,
  segmentPredictions,
  calculateSegmentMetrics,
  generateSegmentedReport,
  calculateCalibrationError,
  analyzeErrors,
  trackFeatureImportance,
  generateAnalysisReport,
  compareModels
};
