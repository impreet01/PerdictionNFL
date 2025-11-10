// trainer/featureBuild_enhanced.js
// Enhanced feature engineering module for backward-compatible improvements.
//
// This module adds new features when enabled via feature flags:
// - Divisional game indicators
// - Travel distance calculations
// - Enhanced home/away splits
// - Additional rolling windows (10, 12 games)
// - Interaction features
//
// All features are optional and controlled by feature flags in config/modelParams.json

import { isDivisionalGame, isConferenceGame, calculateTravelDistance } from "./nflReference.js";
import { loadFeatureFlags } from "./featureFlags.js";

/**
 * List of enhanced features that can be added.
 * These are in addition to the existing 105 base features.
 */
export const ENHANCED_FEATURES = [
  // Divisional/Conference indicators
  "is_divisional_game",
  "is_conference_game",

  // Travel distance
  "travel_distance_miles",
  "travel_distance_category", // 0: <500mi, 1: 500-1500mi, 2: >1500mi

  // Enhanced home/away context
  "home_win_pct",
  "away_win_pct",
  "home_point_diff_avg",
  "away_point_diff_avg",

  // Additional rolling windows (10, 12 games)
  "off_epa_per_play_w10",
  "off_epa_per_play_w12",
  "def_epa_per_play_allowed_w10",
  "def_epa_per_play_allowed_w12",

  // Interaction features
  "rest_days_x_travel_distance",
  "elo_diff_x_is_divisional",
  "off_epa_x_def_epa_opp"
];

/**
 * Add divisional game indicators to a row.
 * @param {Object} row - Feature row
 * @param {string} homeTeam - Home team abbreviation
 * @param {string} awayTeam - Away team abbreviation
 * @returns {Object} Row with divisional features added
 */
function addDivisionalFeatures(row, homeTeam, awayTeam) {
  row.is_divisional_game = isDivisionalGame(homeTeam, awayTeam) ? 1 : 0;
  row.is_conference_game = isConferenceGame(homeTeam, awayTeam) ? 1 : 0;
  return row;
}

/**
 * Add travel distance features to a row.
 * @param {Object} row - Feature row
 * @param {string} awayTeam - Away team abbreviation
 * @param {string} homeTeam - Home team abbreviation
 * @returns {Object} Row with travel features added
 */
function addTravelFeatures(row, awayTeam, homeTeam) {
  const distance = calculateTravelDistance(awayTeam, homeTeam);

  if (distance !== null) {
    row.travel_distance_miles = distance;

    // Categorize distance: 0: short (<500mi), 1: medium (500-1500mi), 2: long (>1500mi)
    if (distance < 500) {
      row.travel_distance_category = 0;
    } else if (distance < 1500) {
      row.travel_distance_category = 1;
    } else {
      row.travel_distance_category = 2;
    }
  } else {
    row.travel_distance_miles = 0;
    row.travel_distance_category = 0;
  }

  return row;
}

/**
 * Calculate additional rolling window features from history.
 * @param {Array} history - Array of historical game stats
 * @param {number} windowSize - Window size (e.g., 10, 12)
 * @returns {Object} Rolling window statistics
 */
function calculateRollingWindow(history, windowSize) {
  if (!history || history.length === 0) {
    return { offEpa: 0, defEpa: 0, successRate: 0 };
  }

  const slice = history.slice(-windowSize);
  const count = slice.length;

  if (count === 0) {
    return { offEpa: 0, defEpa: 0, successRate: 0 };
  }

  const offEpaSum = slice.reduce((sum, g) => sum + (g.off_epa_per_play || 0), 0);
  const defEpaSum = slice.reduce((sum, g) => sum + (g.def_epa_per_play_allowed || 0), 0);
  const successSum = slice.reduce((sum, g) => sum + (g.off_success_rate || 0), 0);

  return {
    offEpa: offEpaSum / count,
    defEpa: defEpaSum / count,
    successRate: successSum / count
  };
}

/**
 * Add enhanced home/away context features.
 * @param {Object} row - Feature row
 * @param {Object} teamHistory - Team's game history
 * @returns {Object} Row with home/away features added
 */
function addEnhancedHomeAwayFeatures(row, teamHistory) {
  if (!teamHistory || teamHistory.length === 0) {
    row.home_win_pct = 0;
    row.away_win_pct = 0;
    row.home_point_diff_avg = 0;
    row.away_point_diff_avg = 0;
    return row;
  }

  const homeGames = teamHistory.filter((g) => g.is_home === 1);
  const awayGames = teamHistory.filter((g) => g.is_home === 0);

  // Home win percentage
  if (homeGames.length > 0) {
    const homeWins = homeGames.filter((g) => g.won === 1).length;
    row.home_win_pct = homeWins / homeGames.length;

    const homePointDiffSum = homeGames.reduce((sum, g) => sum + (g.point_diff || 0), 0);
    row.home_point_diff_avg = homePointDiffSum / homeGames.length;
  } else {
    row.home_win_pct = 0;
    row.home_point_diff_avg = 0;
  }

  // Away win percentage
  if (awayGames.length > 0) {
    const awayWins = awayGames.filter((g) => g.won === 1).length;
    row.away_win_pct = awayWins / awayGames.length;

    const awayPointDiffSum = awayGames.reduce((sum, g) => sum + (g.point_diff || 0), 0);
    row.away_point_diff_avg = awayPointDiffSum / awayGames.length;
  } else {
    row.away_win_pct = 0;
    row.away_point_diff_avg = 0;
  }

  return row;
}

/**
 * Add additional rolling window features (W10, W12).
 * @param {Object} row - Feature row
 * @param {Array} history - Team's game history
 * @returns {Object} Row with additional rolling features added
 */
function addAdditionalRollingWindows(row, history) {
  const w10 = calculateRollingWindow(history, 10);
  const w12 = calculateRollingWindow(history, 12);

  row.off_epa_per_play_w10 = w10.offEpa;
  row.off_epa_per_play_w12 = w12.offEpa;
  row.def_epa_per_play_allowed_w10 = w10.defEpa;
  row.def_epa_per_play_allowed_w12 = w12.defEpa;

  return row;
}

/**
 * Add interaction features (products of existing features).
 * @param {Object} row - Feature row
 * @returns {Object} Row with interaction features added
 */
function addInteractionFeatures(row) {
  // Rest days × travel distance
  const restDays = row.rest_days || 0;
  const travelDist = row.travel_distance_miles || 0;
  row.rest_days_x_travel_distance = restDays * travelDist;

  // ELO diff × is divisional
  const eloDiff = row.elo_diff || 0;
  const isDivisional = row.is_divisional_game || 0;
  row.elo_diff_x_is_divisional = eloDiff * isDivisional;

  // Offensive EPA × Opponent defensive EPA
  const offEpa = row.off_epa_per_play_s2d || 0;
  const defEpaOpp = row.def_epa_per_play_allowed_s2d || 0; // This is actually opponent's def EPA
  row.off_epa_x_def_epa_opp = offEpa * defEpaOpp;

  return row;
}

/**
 * Enhance a feature row with additional features based on flags.
 * @param {Object} row - Base feature row (from featureBuild.js)
 * @param {string} homeTeam - Home team abbreviation
 * @param {string} awayTeam - Away team abbreviation
 * @param {Object} teamHistory - Team's historical game data
 * @param {Object} opponentHistory - Opponent's historical game data
 * @returns {Object} Enhanced feature row
 */
export function enhanceFeatures(row, homeTeam, awayTeam, teamHistory = null, opponentHistory = null) {
  const flags = loadFeatureFlags();
  const enhanced = { ...row };

  // Add divisional game indicators
  if (flags.divisionalGames) {
    addDivisionalFeatures(enhanced, homeTeam, awayTeam);
  }

  // Add travel distance features
  if (flags.travelDistance) {
    addTravelFeatures(enhanced, awayTeam, homeTeam);
  }

  // Add enhanced home/away features
  if (flags.enhancedHomeAway && teamHistory) {
    addEnhancedHomeAwayFeatures(enhanced, teamHistory);
  }

  // Add additional rolling windows
  if (flags.additionalRollingWindows && teamHistory) {
    addAdditionalRollingWindows(enhanced, teamHistory);
  }

  // Add interaction features
  if (flags.interactionFeatures) {
    addInteractionFeatures(enhanced);
  }

  return enhanced;
}

/**
 * Get list of currently enabled enhanced features.
 * @returns {Array<string>} List of enhanced feature names that are enabled
 */
export function getEnabledEnhancedFeatures() {
  const flags = loadFeatureFlags();
  const enabled = [];

  if (flags.divisionalGames) {
    enabled.push("is_divisional_game", "is_conference_game");
  }

  if (flags.travelDistance) {
    enabled.push("travel_distance_miles", "travel_distance_category");
  }

  if (flags.enhancedHomeAway) {
    enabled.push("home_win_pct", "away_win_pct", "home_point_diff_avg", "away_point_diff_avg");
  }

  if (flags.additionalRollingWindows) {
    enabled.push(
      "off_epa_per_play_w10",
      "off_epa_per_play_w12",
      "def_epa_per_play_allowed_w10",
      "def_epa_per_play_allowed_w12"
    );
  }

  if (flags.interactionFeatures) {
    enabled.push("rest_days_x_travel_distance", "elo_diff_x_is_divisional", "off_epa_x_def_epa_opp");
  }

  return enabled;
}

/**
 * Get total feature count including enhanced features.
 * @param {number} baseCount - Base feature count (default 105)
 * @returns {number} Total feature count
 */
export function getTotalFeatureCount(baseCount = 105) {
  const enhancedCount = getEnabledEnhancedFeatures().length;
  return baseCount + enhancedCount;
}

export default {
  ENHANCED_FEATURES,
  enhanceFeatures,
  getEnabledEnhancedFeatures,
  getTotalFeatureCount
};
