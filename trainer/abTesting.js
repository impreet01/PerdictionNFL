// trainer/abTesting.js
// A/B testing framework for comparing model variants.
//
// This module provides:
// - Configuration-based variant selection
// - Side-by-side model comparison
// - Statistical significance testing
// - Variant performance tracking
// - Rollback support

import fs from "node:fs";
import path from "node:path";
import { loadABTestingConfig } from "./featureFlags.js";
import { compareModels, calculateSegmentMetrics } from "./analysis.js";

/**
 * Define model variants with their configurations.
 * Each variant can have different feature flags, model parameters, etc.
 */
export const VARIANTS = {
  baseline: {
    name: "Baseline",
    description: "Current production model with all existing features",
    features: {
      divisionalGames: false,
      travelDistance: false,
      enhancedHomeAway: false,
      additionalRollingWindows: false,
      interactionFeatures: false
    },
    models: {
      logistic: true,
      cart: true,
      bt: true,
      ann: true
    }
  },
  variant_a: {
    name: "Enhanced Features",
    description: "Baseline + divisional games + travel distance",
    features: {
      divisionalGames: true,
      travelDistance: true,
      enhancedHomeAway: false,
      additionalRollingWindows: false,
      interactionFeatures: false
    },
    models: {
      logistic: true,
      cart: true,
      bt: true,
      ann: true
    }
  },
  variant_b: {
    name: "Full Enhancement",
    description: "All enhanced features enabled",
    features: {
      divisionalGames: true,
      travelDistance: true,
      enhancedHomeAway: true,
      additionalRollingWindows: true,
      interactionFeatures: true
    },
    models: {
      logistic: true,
      cart: true,
      bt: true,
      ann: true
    }
  },
  variant_c: {
    name: "Logistic Only",
    description: "Only logistic regression with enhanced features",
    features: {
      divisionalGames: true,
      travelDistance: true,
      enhancedHomeAway: true,
      additionalRollingWindows: false,
      interactionFeatures: false
    },
    models: {
      logistic: true,
      cart: false,
      bt: false,
      ann: false
    }
  }
};

/**
 * Get current variant configuration.
 * @returns {Object} Variant configuration
 */
export function getCurrentVariant() {
  const config = loadABTestingConfig();

  if (!config.enabled) {
    return VARIANTS.baseline;
  }

  const variantName = config.variantName || "baseline";
  return VARIANTS[variantName] || VARIANTS.baseline;
}

/**
 * Get variant to compare against.
 * @returns {Object|null} Comparison variant or null
 */
export function getComparisonVariant() {
  const config = loadABTestingConfig();

  if (!config.enabled || !config.compareAgainst) {
    return null;
  }

  return VARIANTS[config.compareAgainst] || null;
}

/**
 * Load predictions for a specific variant.
 * @param {string} variantName - Variant name
 * @param {string} season - Season identifier
 * @param {number} week - Week number
 * @returns {Array|null} Predictions or null if not found
 */
export function loadVariantPredictions(variantName, season, week) {
  const filename = `predictions_${season}_W${week.toString().padStart(2, "0")}_${variantName}.json`;
  const filepath = path.resolve("artifacts", filename);

  try {
    const data = fs.readFileSync(filepath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Save predictions for a specific variant.
 * @param {Array} predictions - Predictions to save
 * @param {string} variantName - Variant name
 * @param {string} season - Season identifier
 * @param {number} week - Week number
 */
export function saveVariantPredictions(predictions, variantName, season, week) {
  const filename = `predictions_${season}_W${week.toString().padStart(2, "0")}_${variantName}.json`;
  const filepath = path.resolve("artifacts", filename);

  fs.writeFileSync(filepath, JSON.stringify(predictions, null, 2), "utf8");
  console.log(`✓ Saved ${variantName} predictions: ${filepath}`);
}

/**
 * Perform statistical significance test (McNemar's test for paired binary outcomes).
 * @param {Array} predictionsA - Predictions from variant A
 * @param {Array} predictionsB - Predictions from variant B
 * @returns {Object} Test results
 */
export function testSignificance(predictionsA, predictionsB) {
  if (!predictionsA || !predictionsB || predictionsA.length !== predictionsB.length) {
    return { significant: false, pValue: null, message: "Invalid or mismatched predictions" };
  }

  // Count disagreements
  let b = 0; // A correct, B incorrect
  let c = 0; // A incorrect, B correct

  for (let i = 0; i < predictionsA.length; i++) {
    const predA = predictionsA[i];
    const predB = predictionsB[i];

    if (!predA || !predB || predA.actual == null) continue;

    const correctA = (predA.forecast >= 0.5 && predA.actual === 1) || (predA.forecast < 0.5 && predA.actual === 0);
    const correctB = (predB.forecast >= 0.5 && predB.actual === 1) || (predB.forecast < 0.5 && predB.actual === 0);

    if (correctA && !correctB) b++;
    if (!correctA && correctB) c++;
  }

  // McNemar's test statistic with continuity correction
  const n = b + c;
  if (n < 10) {
    return {
      significant: false,
      pValue: null,
      message: "Sample size too small for reliable test (need at least 10 disagreements)",
      disagreements: { b, c, total: n }
    };
  }

  const chi2 = Math.pow(Math.abs(b - c) - 1, 2) / (b + c);
  const pValue = 1 - normalCDF(Math.sqrt(chi2));

  return {
    significant: pValue < 0.05,
    pValue: Number(pValue.toFixed(4)),
    chi2: Number(chi2.toFixed(4)),
    disagreements: { b, c, total: n },
    message: pValue < 0.05 ? "Statistically significant difference" : "No significant difference"
  };
}

/**
 * Approximate normal cumulative distribution function.
 * @param {number} z - Z-score
 * @returns {number} Probability
 */
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));

  return z > 0 ? 1 - prob : prob;
}

/**
 * Generate A/B testing report.
 * @param {Array} predictionsA - Predictions from variant A
 * @param {Array} predictionsB - Predictions from variant B
 * @param {string} variantNameA - Name of variant A
 * @param {string} variantNameB - Name of variant B
 * @returns {Object} A/B testing report
 */
export function generateABTestReport(predictionsA, predictionsB, variantNameA, variantNameB) {
  const comparison = compareModels(predictionsA, predictionsB, variantNameA, variantNameB);
  const significance = testSignificance(predictionsA, predictionsB);

  return {
    variants: {
      a: {
        name: variantNameA,
        config: VARIANTS[variantNameA] || {},
        metrics: comparison[variantNameA]
      },
      b: {
        name: variantNameB,
        config: VARIANTS[variantNameB] || {},
        metrics: comparison[variantNameB]
      }
    },
    comparison: comparison.differences,
    winner: comparison.winner,
    significance,
    recommendation: generateRecommendation(comparison, significance)
  };
}

/**
 * Generate recommendation based on A/B test results.
 * @param {Object} comparison - Comparison results
 * @param {Object} significance - Significance test results
 * @returns {string} Recommendation
 */
function generateRecommendation(comparison, significance) {
  if (!significance.significant) {
    return "No statistically significant difference detected. Continue with current variant or gather more data.";
  }

  const winner = comparison.winner;
  const logLossDiff = comparison.differences.logLoss;

  if (!logLossDiff || Math.abs(logLossDiff) < 0.01) {
    return `${winner} shows statistically significant improvement, but practical difference is minimal. Consider cost/complexity tradeoffs.`;
  }

  const improvement = Math.abs(logLossDiff * 100);

  return `${winner} shows statistically significant improvement with ${improvement.toFixed(2)}% better log loss. Recommend deploying ${winner}.`;
}

/**
 * Save A/B testing report to file.
 * @param {Object} report - A/B testing report
 * @param {string} season - Season identifier
 * @param {number} week - Week number
 */
export function saveABTestReport(report, season, week) {
  const filename = `ab_test_report_${season}_W${week.toString().padStart(2, "0")}.json`;
  const filepath = path.resolve("artifacts", filename);

  fs.writeFileSync(filepath, JSON.stringify(report, null, 2), "utf8");
  console.log(`✓ Saved A/B test report: ${filepath}`);

  return filepath;
}

/**
 * Check if A/B testing is currently enabled.
 * @returns {boolean}
 */
export function isABTestingEnabled() {
  const config = loadABTestingConfig();
  return config.enabled === true;
}

/**
 * Print A/B testing configuration.
 */
export function printABTestConfig() {
  const config = loadABTestingConfig();
  const current = getCurrentVariant();
  const comparison = getComparisonVariant();

  console.log("\n=== A/B Testing Configuration ===");
  console.log(`Enabled: ${config.enabled ? "✓ yes" : "✗ no"}`);
  console.log(`\nCurrent Variant: ${current.name}`);
  console.log(`  Description: ${current.description}`);
  console.log(`  Features: ${JSON.stringify(current.features, null, 2)}`);

  if (comparison) {
    console.log(`\nComparison Variant: ${comparison.name}`);
    console.log(`  Description: ${comparison.description}`);
    console.log(`  Features: ${JSON.stringify(comparison.features, null, 2)}`);
  } else {
    console.log("\nNo comparison variant configured");
  }

  console.log("===================================\n");
}

export default {
  VARIANTS,
  getCurrentVariant,
  getComparisonVariant,
  loadVariantPredictions,
  saveVariantPredictions,
  testSignificance,
  generateABTestReport,
  saveABTestReport,
  isABTestingEnabled,
  printABTestConfig
};
