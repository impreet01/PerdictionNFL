// trainer/featureFlags.js
// Feature flags and configuration management for backward-compatible improvements.
//
// This module provides:
// - Feature flag management with environment variable overrides
// - Model enable/disable toggles
// - A/B testing configuration
// - Analysis feature controls
//
// Environment variable overrides:
//   FEATURE_DIVISIONAL_GAMES=true|false
//   FEATURE_TRAVEL_DISTANCE=true|false
//   FEATURE_ENHANCED_HOME_AWAY=true|false
//   FEATURE_ADDITIONAL_ROLLING_WINDOWS=true|false
//   FEATURE_INTERACTION_FEATURES=true|false
//
//   ANALYSIS_ROI_METRICS=true|false
//   ANALYSIS_SEGMENTED_REPORTS=true|false
//   ANALYSIS_FEATURE_IMPORTANCE=true|false
//   ANALYSIS_CALIBRATION_PLOTS=true|false
//   ANALYSIS_CONFUSION_MATRIX=true|false
//
//   MODEL_LOGISTIC_ENABLED=true|false
//   MODEL_CART_ENABLED=true|false
//   MODEL_BT_ENABLED=true|false
//   MODEL_ANN_ENABLED=true|false
//
//   AB_TESTING_ENABLED=true|false
//   AB_TESTING_VARIANT=baseline|variant_a|variant_b|...
//   AB_TESTING_COMPARE_AGAINST=baseline|variant_a|...

import modelParams from "../config/modelParams.json" with { type: "json" };

/**
 * Normalize a value to a boolean flag.
 * @param {unknown} value
 * @returns {boolean|undefined}
 */
function normalizeFlag(value) {
  if (value == null) return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (text === "") return undefined;
  return /^(1|true|yes|on)$/i.test(text);
}

/**
 * Get a feature flag value with environment variable override.
 * @param {string} envVarName - Environment variable name
 * @param {boolean} defaultValue - Default value from config
 * @returns {boolean}
 */
function getFeatureFlag(envVarName, defaultValue = false) {
  const envValue = normalizeFlag(process.env[envVarName]);
  return envValue !== undefined ? envValue : defaultValue;
}

/**
 * Load feature flags from config with environment overrides.
 * @returns {Object} Feature flags configuration
 */
export function loadFeatureFlags() {
  const config = modelParams.features || {};

  return {
    divisionalGames: getFeatureFlag("FEATURE_DIVISIONAL_GAMES", config.divisionalGames),
    travelDistance: getFeatureFlag("FEATURE_TRAVEL_DISTANCE", config.travelDistance),
    enhancedHomeAway: getFeatureFlag("FEATURE_ENHANCED_HOME_AWAY", config.enhancedHomeAway),
    additionalRollingWindows: getFeatureFlag("FEATURE_ADDITIONAL_ROLLING_WINDOWS", config.additionalRollingWindows),
    interactionFeatures: getFeatureFlag("FEATURE_INTERACTION_FEATURES", config.interactionFeatures)
  };
}

/**
 * Load analysis feature flags from config with environment overrides.
 * @returns {Object} Analysis configuration
 */
export function loadAnalysisFlags() {
  const config = modelParams.analysis || {};

  return {
    enableROIMetrics: getFeatureFlag("ANALYSIS_ROI_METRICS", config.enableROIMetrics ?? true),
    enableSegmentedReports: getFeatureFlag("ANALYSIS_SEGMENTED_REPORTS", config.enableSegmentedReports ?? true),
    enableFeatureImportance: getFeatureFlag("ANALYSIS_FEATURE_IMPORTANCE", config.enableFeatureImportance ?? true),
    enableCalibrationPlots: getFeatureFlag("ANALYSIS_CALIBRATION_PLOTS", config.enableCalibrationPlots ?? false),
    enableConfusionMatrix: getFeatureFlag("ANALYSIS_CONFUSION_MATRIX", config.enableConfusionMatrix ?? false)
  };
}

/**
 * Load model enable/disable flags from config with environment overrides.
 * @returns {Object} Model configuration
 */
export function loadModelFlags() {
  const config = modelParams.models || {};

  return {
    logistic: getFeatureFlag("MODEL_LOGISTIC_ENABLED", config.logistic?.enabled ?? true),
    cart: getFeatureFlag("MODEL_CART_ENABLED", config.cart?.enabled ?? true),
    bt: getFeatureFlag("MODEL_BT_ENABLED", config.bt?.enabled ?? true),
    ann: getFeatureFlag("MODEL_ANN_ENABLED", config.ann?.enabled ?? true)
  };
}

/**
 * Load A/B testing configuration from config with environment overrides.
 * @returns {Object} A/B testing configuration
 */
export function loadABTestingConfig() {
  const config = modelParams.abTesting || {};

  return {
    enabled: getFeatureFlag("AB_TESTING_ENABLED", config.enabled ?? false),
    variantName: process.env.AB_TESTING_VARIANT || config.variantName || "baseline",
    compareAgainst: process.env.AB_TESTING_COMPARE_AGAINST || config.compareAgainst || null
  };
}

/**
 * Get all configuration in a single object.
 * @returns {Object} Complete configuration
 */
export function getAllConfig() {
  return {
    features: loadFeatureFlags(),
    analysis: loadAnalysisFlags(),
    models: loadModelFlags(),
    abTesting: loadABTestingConfig()
  };
}

/**
 * Check if a specific feature is enabled.
 * @param {string} featureName - Feature name (e.g., "divisionalGames")
 * @returns {boolean}
 */
export function isFeatureEnabled(featureName) {
  const flags = loadFeatureFlags();
  return flags[featureName] === true;
}

/**
 * Check if a specific model is enabled.
 * @param {string} modelName - Model name (e.g., "logistic", "cart", "bt", "ann")
 * @returns {boolean}
 */
export function isModelEnabled(modelName) {
  const flags = loadModelFlags();
  return flags[modelName] === true;
}

/**
 * Check if a specific analysis feature is enabled.
 * @param {string} analysisName - Analysis feature name (e.g., "enableROIMetrics")
 * @returns {boolean}
 */
export function isAnalysisEnabled(analysisName) {
  const flags = loadAnalysisFlags();
  return flags[analysisName] === true;
}

/**
 * Print current configuration to console (useful for debugging).
 */
export function printConfig() {
  const config = getAllConfig();
  console.log("\n=== Feature Flags Configuration ===");
  console.log("\nFeatures:");
  for (const [key, value] of Object.entries(config.features)) {
    console.log(`  ${key}: ${value ? "✓ enabled" : "✗ disabled"}`);
  }
  console.log("\nAnalysis:");
  for (const [key, value] of Object.entries(config.analysis)) {
    console.log(`  ${key}: ${value ? "✓ enabled" : "✗ disabled"}`);
  }
  console.log("\nModels:");
  for (const [key, value] of Object.entries(config.models)) {
    console.log(`  ${key}: ${value ? "✓ enabled" : "✗ disabled"}`);
  }
  console.log("\nA/B Testing:");
  console.log(`  enabled: ${config.abTesting.enabled ? "✓ yes" : "✗ no"}`);
  console.log(`  variant: ${config.abTesting.variantName}`);
  console.log(`  compareAgainst: ${config.abTesting.compareAgainst || "none"}`);
  console.log("\n===================================\n");
}

/**
 * Get list of enabled features.
 * @returns {Array<string>} List of enabled feature names
 */
export function getEnabledFeatures() {
  const flags = loadFeatureFlags();
  return Object.entries(flags)
    .filter(([_, enabled]) => enabled)
    .map(([name, _]) => name);
}

/**
 * Get list of enabled models.
 * @returns {Array<string>} List of enabled model names
 */
export function getEnabledModels() {
  const flags = loadModelFlags();
  return Object.entries(flags)
    .filter(([_, enabled]) => enabled)
    .map(([name, _]) => name);
}

export default {
  loadFeatureFlags,
  loadAnalysisFlags,
  loadModelFlags,
  loadABTestingConfig,
  getAllConfig,
  isFeatureEnabled,
  isModelEnabled,
  isAnalysisEnabled,
  printConfig,
  getEnabledFeatures,
  getEnabledModels
};
