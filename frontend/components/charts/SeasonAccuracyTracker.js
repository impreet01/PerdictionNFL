/**
 * Season Accuracy Tracker Component
 * Displays cumulative accuracy over all weeks with separate lines for each model
 */

import { ChartHelpers, MODEL_COLORS, COLORS } from '../../utils/chartHelpers.js';
import { DataTransformers } from '../../utils/dataTransformers.js';
import { Calculations } from '../../utils/calculations.js';

export class SeasonAccuracyTracker {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.chart = null;
    this.data = null;
    this.options = {
      showConfidenceIntervals: true,
      showRollingAverage: false,
      rollingWindow: 3,
      modelConfig: [],
      ...options
    };
  }

  /**
   * Load season data and render chart
   * @param {Object} seasonMetrics - Season metrics with weekly breakdown
   */
  async loadData(seasonMetrics) {
    this.data = DataTransformers.toSeasonAccuracyData(seasonMetrics);
    if (this.data) {
      this.render();
    }
  }

  /**
   * Render the accuracy tracker chart
   */
  render() {
    if (!this.container || !this.data) return;

    // Destroy existing chart
    if (this.chart) {
      this.chart.destroy();
    }

    const ctx = this.container.getContext('2d');
    const datasets = this.prepareDatasets();

    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: this.data.weeks,
        datasets: datasets
      },
      options: this.getChartOptions()
    });
  }

  /**
   * Prepare datasets for each model
   */
  prepareDatasets() {
    const datasets = [];
    const visibleModels = this.options.modelConfig
      .filter(m => m.visible !== false)
      .map(m => m.key);

    Object.entries(this.data.models).forEach(([modelKey, modelData]) => {
      // Skip if model not visible
      if (visibleModels.length > 0 && !visibleModels.includes(modelKey)) return;

      const color = MODEL_COLORS[modelKey] || '#666666';
      const config = this.options.modelConfig.find(m => m.key === modelKey);
      const label = config?.label || this.formatModelName(modelKey);

      // Main cumulative accuracy line
      datasets.push(ChartHelpers.createLineDataset(
        label,
        modelData.cumulative,
        color,
        {
          fill: modelKey === 'blended',
          borderWidth: modelKey === 'blended' ? 3 : 2,
          pointRadius: 4,
          pointHoverRadius: 6
        }
      ));

      // Add confidence intervals if enabled
      if (this.options.showConfidenceIntervals && modelKey === 'blended') {
        const { upper, lower } = this.calculateConfidenceBands(modelData);

        datasets.push({
          label: `${label} (95% CI Upper)`,
          data: upper,
          borderColor: 'transparent',
          backgroundColor: `${color}15`,
          fill: '+1',
          pointRadius: 0,
          showLine: true
        });

        datasets.push({
          label: `${label} (95% CI Lower)`,
          data: lower,
          borderColor: 'transparent',
          backgroundColor: 'transparent',
          fill: false,
          pointRadius: 0
        });
      }

      // Add rolling average if enabled
      if (this.options.showRollingAverage) {
        const rollingData = Calculations.rollingAverage(
          modelData.weekly,
          this.options.rollingWindow
        );

        datasets.push({
          label: `${label} (${this.options.rollingWindow}-week avg)`,
          data: rollingData,
          borderColor: color,
          borderDash: [5, 5],
          borderWidth: 1,
          fill: false,
          pointRadius: 0
        });
      }
    });

    return datasets;
  }

  /**
   * Calculate confidence bands for cumulative accuracy
   */
  calculateConfidenceBands(modelData) {
    const upper = [];
    const lower = [];
    let totalGames = 0;
    let totalCorrect = 0;

    modelData.weekly.forEach((accuracy, i) => {
      // Estimate games per week (approximately 14-16)
      const weekGames = 15;
      totalGames += weekGames;
      totalCorrect += Math.round(accuracy * weekGames);

      const cumAccuracy = totalCorrect / totalGames;
      const ci = Calculations.confidenceInterval(
        cumAccuracy,
        Math.sqrt(cumAccuracy * (1 - cumAccuracy)),
        totalGames,
        0.95
      );

      upper.push(Math.min(1, ci.upper));
      lower.push(Math.max(0, ci.lower));
    });

    return { upper, lower };
  }

  /**
   * Get chart configuration options
   */
  getChartOptions() {
    return ChartHelpers.lineChartOptions({
      plugins: {
        title: {
          display: true,
          text: 'Cumulative Model Accuracy Over Season',
          font: { size: 16, weight: 'bold' }
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const value = context.parsed.y;
              return `${context.dataset.label}: ${(value * 100).toFixed(1)}%`;
            },
            afterLabel: (context) => {
              const weekIndex = context.dataIndex;
              const modelKey = this.getModelKeyFromLabel(context.dataset.label);
              if (modelKey && this.data.models[modelKey]) {
                const model = this.data.models[modelKey];
                return `Total: ${model.totalCorrect}/${model.totalGames} games`;
              }
              return '';
            }
          }
        },
        legend: {
          position: 'top',
          labels: {
            filter: (legendItem) => {
              // Hide confidence interval bands from legend
              return !legendItem.text.includes('CI');
            }
          }
        },
        annotation: {
          annotations: {
            baseline: {
              type: 'line',
              yMin: 0.5,
              yMax: 0.5,
              borderColor: COLORS.reference,
              borderWidth: 1,
              borderDash: [5, 5],
              label: {
                display: true,
                content: 'Random (50%)',
                position: 'start',
                backgroundColor: 'transparent',
                color: COLORS.neutral,
                font: { size: 10 }
              }
            }
          }
        }
      },
      scales: {
        y: {
          min: 0.4,
          max: 0.8,
          title: {
            display: true,
            text: 'Cumulative Accuracy',
            font: { size: 12 }
          },
          ticks: {
            callback: (value) => `${(value * 100).toFixed(0)}%`
          }
        },
        x: {
          title: {
            display: true,
            text: 'Week',
            font: { size: 12 }
          }
        }
      }
    });
  }

  /**
   * Format model key to display name
   */
  formatModelName(key) {
    const names = {
      blended: 'Hybrid Ensemble',
      logistic: 'Logistic Regression',
      tree: 'Decision Tree',
      bt: 'Bradley-Terry',
      ann: 'Neural Network',
      xgboost: 'Gradient Boosting'
    };
    return names[key] || key.charAt(0).toUpperCase() + key.slice(1);
  }

  /**
   * Get model key from dataset label
   */
  getModelKeyFromLabel(label) {
    const config = this.options.modelConfig.find(m => m.label === label);
    if (config) return config.key;

    // Fallback: try to match formatted names
    const key = Object.entries({
      blended: 'Hybrid Ensemble',
      logistic: 'Logistic Regression',
      tree: 'Decision Tree',
      bt: 'Bradley-Terry',
      ann: 'Neural Network',
      xgboost: 'Gradient Boosting'
    }).find(([k, v]) => label.includes(v))?.[0];

    return key;
  }

  /**
   * Update chart with new options
   */
  update(options) {
    this.options = { ...this.options, ...options };
    if (this.data) {
      this.render();
    }
  }

  /**
   * Toggle model visibility
   */
  toggleModel(modelKey, visible) {
    const config = this.options.modelConfig.find(m => m.key === modelKey);
    if (config) {
      config.visible = visible;
      this.render();
    }
  }

  /**
   * Export chart data to CSV
   */
  exportData() {
    if (!this.data) return '';

    const headers = ['Week', ...Object.keys(this.data.models)];
    const rows = this.data.weeks.map((week, i) => {
      const values = Object.values(this.data.models).map(m =>
        (m.cumulative[i] * 100).toFixed(2) + '%'
      );
      return [week, ...values].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Get trend analysis for models
   */
  getTrendAnalysis() {
    const analysis = {};

    Object.entries(this.data.models).forEach(([modelKey, modelData]) => {
      const trend = Calculations.trendDetection(modelData.cumulative);
      const variance = Calculations.varianceAnalysis(modelData.weekly);

      analysis[modelKey] = {
        trend: trend.trend,
        trendConfidence: trend.confidence,
        slope: trend.slope,
        stability: 1 - variance.cv,
        finalAccuracy: modelData.cumulative[modelData.cumulative.length - 1]
      };
    });

    return analysis;
  }

  /**
   * Destroy chart instance
   */
  destroy() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }
}

export default SeasonAccuracyTracker;
