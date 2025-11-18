/**
 * NFL Analytics Platform - Enhanced App Integration
 * Integrates new analytics components with the existing app
 */

// Import components (these will be loaded as modules)
import { SeasonAccuracyTracker } from './components/charts/SeasonAccuracyTracker.js';
import { CalibrationPlot } from './components/charts/CalibrationPlot.js';
import { ROIDashboard } from './components/charts/ROIDashboard.js';
import { PerformanceMatrix } from './components/charts/PerformanceMatrix.js';
import { PredictivePowerMetrics } from './components/analytics/PredictivePowerMetrics.js';
import { AdvancedFilters } from './components/filters/AdvancedFilters.js';
import { SmartCards } from './components/cards/SmartCard.js';

// Enhanced state to track new components
const enhancedState = {
  components: {
    accuracyTracker: null,
    calibrationPlot: null,
    roiDashboard: null,
    performanceMatrix: null,
    predictiveMetrics: null,
    advancedFilters: null,
    smartCards: null
  },
  allPredictions: [], // Store all season predictions for analytics
  isInitialized: false
};

/**
 * Initialize enhanced components
 */
async function initEnhanced() {
  if (enhancedState.isInitialized) return;

  console.log('Initializing enhanced analytics platform...');

  // Wait for main app to be ready
  await waitForMainApp();

  // Initialize components
  initSmartCards();
  initAdvancedFilters();
  initAnalyticsTab();
  initBettingTab();

  // Add event listeners for new tabs
  bindEnhancedEvents();

  enhancedState.isInitialized = true;
  console.log('Enhanced analytics platform initialized');
}

/**
 * Wait for main app to be ready
 */
function waitForMainApp() {
  return new Promise((resolve) => {
    const checkReady = () => {
      if (window.state && window.state.season) {
        resolve();
      } else {
        setTimeout(checkReady, 100);
      }
    };
    checkReady();
  });
}

/**
 * Initialize Smart Cards
 */
function initSmartCards() {
  const container = document.getElementById('smart-cards-container');
  if (!container) return;

  enhancedState.components.smartCards = new SmartCards('smart-cards-container');

  // Load initial data if available
  if (window.state?.predictions && window.state?.weekMetrics) {
    enhancedState.components.smartCards.loadData(
      window.state.predictions,
      window.state.weekMetrics,
      window.state.seasonMetrics
    );
  }
}

/**
 * Initialize Advanced Filters
 */
function initAdvancedFilters() {
  const container = document.getElementById('advanced-filters-container');
  if (!container) return;

  // Get available weeks from current season
  const availableWeeks = window.state?.seasonMetrics?.weeks?.map(w => w.week) || [];

  enhancedState.components.advancedFilters = new AdvancedFilters('advanced-filters-container', {
    availableWeeks,
    onFilterChange: handleFilterChange,
    onExport: handleExport
  });

  enhancedState.components.advancedFilters.init();
}

/**
 * Handle filter changes
 */
function handleFilterChange(filters) {
  console.log('Filters changed:', filters);

  if (!window.state?.predictions) return;

  const filteredPredictions = enhancedState.components.advancedFilters
    .filterPredictions(window.state.predictions);

  // Update table with filtered data
  // This integrates with the existing renderPredictions function
  if (window.renderPredictions) {
    const originalPredictions = window.state.predictions;
    window.state.predictions = filteredPredictions;
    window.renderPredictions();
    window.state.predictions = originalPredictions;
  }
}

/**
 * Handle export
 */
function handleExport() {
  if (!window.state?.predictions) return;

  const filters = enhancedState.components.advancedFilters.getFilters();
  const filteredPredictions = enhancedState.components.advancedFilters
    .filterPredictions(window.state.predictions);

  // Create CSV
  const csv = predictionsToCSV(filteredPredictions);

  // Download
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `predictions_${window.state.season}_W${window.state.week}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Convert predictions to CSV
 */
function predictionsToCSV(predictions) {
  const headers = ['Game', 'Home', 'Away', 'Season', 'Week', 'Blended', 'Outcome', 'Correct'];
  const rows = predictions.map(p => {
    const prob = p.probs?.blended ?? p.forecast;
    const actual = p.outcome === 'home' ? 1 : (p.outcome === 'away' ? 0 : null);
    const correct = actual !== null ?
      ((prob >= 0.5 && actual === 1) || (prob < 0.5 && actual === 0) ? 'Yes' : 'No') : '';

    return [
      p.game_id,
      p.home_team,
      p.away_team,
      p.season,
      p.week,
      `${(prob * 100).toFixed(1)}%`,
      p.outcome || '',
      correct
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Initialize Analytics Tab
 */
function initAnalyticsTab() {
  // Season Accuracy Tracker
  enhancedState.components.accuracyTracker = new SeasonAccuracyTracker('accuracy-tracker-chart', {
    showConfidenceIntervals: true,
    modelConfig: window.state?.modelConfig || []
  });

  // Calibration Plot
  enhancedState.components.calibrationPlot = new CalibrationPlot('calibration-chart', {
    showConfidenceBands: true
  });

  // Performance Matrix
  enhancedState.components.performanceMatrix = new PerformanceMatrix('performance-matrix-container', {
    modelKey: 'blended'
  });

  // Predictive Power Metrics
  enhancedState.components.predictiveMetrics = new PredictivePowerMetrics('predictive-metrics-container', {
    selectedModels: ['blended', 'logistic', 'tree', 'ann']
  });

  // Bind analytics tab controls
  bindAnalyticsControls();
}

/**
 * Initialize Betting Tab
 */
function initBettingTab() {
  enhancedState.components.roiDashboard = new ROIDashboard('roi-dashboard-container', {
    initialBankroll: 1000,
    betSize: 100,
    modelKey: 'blended'
  });

  // Bind betting tab controls
  bindBettingControls();
}

/**
 * Bind analytics tab controls
 */
function bindAnalyticsControls() {
  // Confidence intervals toggle
  const ciToggle = document.getElementById('show-confidence-intervals');
  ciToggle?.addEventListener('change', (e) => {
    if (enhancedState.components.accuracyTracker) {
      enhancedState.components.accuracyTracker.update({
        showConfidenceIntervals: e.target.checked
      });
    }
  });

  // Rolling average toggle
  const raToggle = document.getElementById('show-rolling-average');
  raToggle?.addEventListener('change', (e) => {
    if (enhancedState.components.accuracyTracker) {
      enhancedState.components.accuracyTracker.update({
        showRollingAverage: e.target.checked
      });
    }
  });

  // Calibration model select
  const calModelSelect = document.getElementById('calibration-model-select');
  calModelSelect?.addEventListener('change', (e) => {
    if (enhancedState.components.calibrationPlot) {
      enhancedState.components.calibrationPlot.updateModels([e.target.value]);
    }
  });

  // Reset zoom buttons
  document.querySelectorAll('.chart-reset[data-chart="accuracy-tracker"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (enhancedState.components.accuracyTracker?.chart) {
        enhancedState.components.accuracyTracker.chart.resetZoom();
      }
    });
  });
}

/**
 * Bind betting tab controls
 */
function bindBettingControls() {
  // ROI model select
  const roiModelSelect = document.getElementById('roi-model-select');
  roiModelSelect?.addEventListener('change', (e) => {
    if (enhancedState.components.roiDashboard) {
      enhancedState.components.roiDashboard.updateModel(e.target.value);
      updateRiskMetrics();
    }
  });
}

/**
 * Update risk metrics display
 */
function updateRiskMetrics() {
  if (!enhancedState.components.roiDashboard) return;

  const metrics = enhancedState.components.roiDashboard.getRiskMetrics();

  const sharpeEl = document.getElementById('sharpe-ratio');
  const drawdownEl = document.getElementById('max-drawdown');
  const winRateEl = document.getElementById('win-rate');
  const volatilityEl = document.getElementById('volatility');

  if (sharpeEl) sharpeEl.textContent = metrics.sharpeRatio.toFixed(2);
  if (drawdownEl) drawdownEl.textContent = `${(metrics.maxDrawdown * 100).toFixed(1)}%`;
  if (winRateEl) winRateEl.textContent = `${(metrics.avgReturn * 100).toFixed(1)}%`;
  if (volatilityEl) volatilityEl.textContent = `${(metrics.volatility * 100).toFixed(2)}%`;
}

/**
 * Bind enhanced events
 */
function bindEnhancedEvents() {
  // Listen for tab changes
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      const tabId = e.target.getAttribute('aria-controls');
      handleTabChange(tabId);
    });
  });

  // Listen for data updates from main app
  // Override loadWeekContext to also update enhanced components
  const originalLoadWeekContext = window.loadWeekContext;
  if (originalLoadWeekContext) {
    window.loadWeekContext = async function(...args) {
      await originalLoadWeekContext.apply(this, args);
      await updateEnhancedComponents();
    };
  }

  // Listen for season changes
  const seasonSelect = document.getElementById('season-select');
  seasonSelect?.addEventListener('change', async () => {
    // Wait for main app to load data
    setTimeout(async () => {
      await loadSeasonPredictions();
      await updateEnhancedComponents();
    }, 500);
  });
}

/**
 * Handle tab changes
 */
function handleTabChange(tabId) {
  // Load data for analytics and betting tabs on first view
  if (tabId === 'tab-analytics' && !enhancedState.analyticsLoaded) {
    loadAnalyticsData();
    enhancedState.analyticsLoaded = true;
  }

  if (tabId === 'tab-betting' && !enhancedState.bettingLoaded) {
    loadBettingData();
    enhancedState.bettingLoaded = true;
  }
}

/**
 * Load all predictions for current season
 */
async function loadSeasonPredictions() {
  if (!window.state?.season) return;

  const season = window.state.season;
  const predictions = [];

  // Load all weeks
  const seasonMetrics = window.state.seasonMetrics;
  if (!seasonMetrics?.weeks) return;

  for (const week of seasonMetrics.weeks) {
    try {
      const response = await fetch(`../artifacts/predictions_${season}_W${week.week}.json`);
      if (response.ok) {
        const weekPredictions = await response.json();
        predictions.push(...weekPredictions);
      }
    } catch (e) {
      console.warn(`Failed to load week ${week.week}:`, e);
    }
  }

  enhancedState.allPredictions = predictions;
}

/**
 * Load analytics data
 */
async function loadAnalyticsData() {
  if (!window.state?.seasonMetrics) return;

  // Ensure we have all predictions
  if (enhancedState.allPredictions.length === 0) {
    await loadSeasonPredictions();
  }

  // Load Season Accuracy Tracker
  if (enhancedState.components.accuracyTracker) {
    enhancedState.components.accuracyTracker.loadData(window.state.seasonMetrics);
  }

  // Load Calibration Plot
  if (enhancedState.components.calibrationPlot && enhancedState.allPredictions.length > 0) {
    enhancedState.components.calibrationPlot.loadData(enhancedState.allPredictions, ['blended']);
  }

  // Load Performance Matrix
  if (enhancedState.components.performanceMatrix && enhancedState.allPredictions.length > 0) {
    enhancedState.components.performanceMatrix.loadData(enhancedState.allPredictions);
  }

  // Load Predictive Power Metrics
  if (enhancedState.components.predictiveMetrics && enhancedState.allPredictions.length > 0) {
    enhancedState.components.predictiveMetrics.loadData(enhancedState.allPredictions);
  }
}

/**
 * Load betting data
 */
async function loadBettingData() {
  // Ensure we have all predictions
  if (enhancedState.allPredictions.length === 0) {
    await loadSeasonPredictions();
  }

  // Load ROI Dashboard
  if (enhancedState.components.roiDashboard && enhancedState.allPredictions.length > 0) {
    enhancedState.components.roiDashboard.loadData(enhancedState.allPredictions);

    // Render bet history
    enhancedState.components.roiDashboard.renderBetHistory('bet-history-container');

    // Update risk metrics
    updateRiskMetrics();
  }
}

/**
 * Update enhanced components when data changes
 */
async function updateEnhancedComponents() {
  // Update Smart Cards
  if (enhancedState.components.smartCards && window.state?.predictions) {
    enhancedState.components.smartCards.loadData(
      window.state.predictions,
      window.state.weekMetrics,
      window.state.seasonMetrics
    );
  }

  // Reset loaded flags to reload on next tab view
  enhancedState.analyticsLoaded = false;
  enhancedState.bettingLoaded = false;

  // Clear cached predictions
  enhancedState.allPredictions = [];
}

/**
 * Export enhanced state for debugging
 */
window.enhancedState = enhancedState;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initEnhanced);
} else {
  // Small delay to ensure main app initializes first
  setTimeout(initEnhanced, 100);
}

export { initEnhanced, enhancedState };
