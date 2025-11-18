/**
 * Calibration Plot Component
 * Shows actual win rate vs predicted probability bins
 */

import { ChartHelpers, MODEL_COLORS, COLORS } from '../../utils/chartHelpers.js';
import { DataTransformers } from '../../utils/dataTransformers.js';
import { Calculations } from '../../utils/calculations.js';

export class CalibrationPlot {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.chart = null;
    this.data = null;
    this.calibrationMetrics = {};
    this.options = {
      numBins: 10,
      showMultipleModels: true,
      showConfidenceBands: true,
      selectedModels: ['blended'],
      ...options
    };
  }

  /**
   * Load predictions data and render calibration plot
   * @param {Array} predictions - All predictions with outcomes
   * @param {Array} modelKeys - Models to plot
   */
  async loadData(predictions, modelKeys = ['blended']) {
    this.predictions = predictions.filter(p => p.outcome);
    this.options.selectedModels = modelKeys;
    this.calculateCalibration();
    this.render();
  }

  /**
   * Calculate calibration data for all selected models
   */
  calculateCalibration() {
    this.data = {};
    this.calibrationMetrics = {};

    this.options.selectedModels.forEach(modelKey => {
      const bins = DataTransformers.toCalibrationData(this.predictions, modelKey);
      this.data[modelKey] = bins;

      // Calculate calibration metrics
      const predData = this.predictions
        .filter(p => p.probs?.[modelKey] !== undefined && p.outcome)
        .map(p => ({
          predicted: p.probs[modelKey],
          actual: p.outcome === 'home' ? 1 : 0
        }));

      this.calibrationMetrics[modelKey] = {
        ece: Calculations.expectedCalibrationError(predData, this.options.numBins),
        mce: Calculations.maxCalibrationError(predData, this.options.numBins),
        brier: Calculations.brierDecomposition(predData)
      };
    });
  }

  /**
   * Render the calibration plot
   */
  render() {
    if (!this.container || !this.data) return;

    if (this.chart) {
      this.chart.destroy();
    }

    const ctx = this.container.getContext('2d');
    const datasets = this.prepareDatasets();

    this.chart = new Chart(ctx, {
      type: 'scatter',
      data: { datasets },
      options: this.getChartOptions()
    });
  }

  /**
   * Prepare datasets for calibration plot
   */
  prepareDatasets() {
    const datasets = [];

    // Perfect calibration line
    datasets.push({
      label: 'Perfect Calibration',
      data: [
        { x: 0, y: 0 },
        { x: 1, y: 1 }
      ],
      type: 'line',
      borderColor: COLORS.reference,
      borderWidth: 1,
      borderDash: [5, 5],
      fill: false,
      pointRadius: 0,
      order: 10
    });

    // Add each model's calibration curve
    this.options.selectedModels.forEach((modelKey, index) => {
      const bins = this.data[modelKey];
      if (!bins) return;

      const color = MODEL_COLORS[modelKey] || `hsl(${index * 60}, 70%, 50%)`;
      const config = this.options.modelConfig?.find(m => m.key === modelKey);
      const label = config?.label || this.formatModelName(modelKey);

      // Main calibration points
      const calibrationPoints = bins
        .filter(bin => bin.count > 0)
        .map(bin => ({
          x: bin.avgPredicted,
          y: bin.actualWinRate,
          count: bin.count
        }));

      datasets.push({
        label: `${label} (n=${this.predictions.length})`,
        data: calibrationPoints,
        backgroundColor: color,
        borderColor: color,
        borderWidth: 2,
        pointRadius: (ctx) => {
          const point = calibrationPoints[ctx.dataIndex];
          return point ? Math.min(8, Math.max(4, Math.sqrt(point.count))) : 4;
        },
        pointHoverRadius: 8,
        showLine: true,
        tension: 0.2,
        fill: false,
        order: index
      });

      // Add confidence bands if enabled
      if (this.options.showConfidenceBands && modelKey === this.options.selectedModels[0]) {
        const { upper, lower } = this.calculateConfidenceBands(bins);

        if (upper.length > 0) {
          datasets.push({
            label: `${label} 95% CI`,
            data: upper,
            backgroundColor: `${color}15`,
            borderColor: 'transparent',
            fill: '+1',
            pointRadius: 0,
            showLine: true,
            tension: 0.2,
            order: 100
          });

          datasets.push({
            label: '_lower',
            data: lower,
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            fill: false,
            pointRadius: 0,
            showLine: true,
            tension: 0.2,
            order: 101
          });
        }
      }
    });

    return datasets;
  }

  /**
   * Calculate confidence bands using Wilson score interval
   */
  calculateConfidenceBands(bins) {
    const upper = [];
    const lower = [];

    bins.forEach(bin => {
      if (bin.count === 0) return;

      // Wilson score interval for binomial proportion
      const p = bin.actualWinRate;
      const n = bin.count;
      const z = 1.96; // 95% confidence

      const denominator = 1 + z * z / n;
      const center = (p + z * z / (2 * n)) / denominator;
      const margin = (z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denominator;

      upper.push({ x: bin.avgPredicted, y: Math.min(1, center + margin) });
      lower.push({ x: bin.avgPredicted, y: Math.max(0, center - margin) });
    });

    return { upper, lower };
  }

  /**
   * Get chart configuration options
   */
  getChartOptions() {
    const metrics = this.calibrationMetrics[this.options.selectedModels[0]];

    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: [
            'Prediction Calibration Plot',
            metrics ? `ECE: ${(metrics.ece * 100).toFixed(1)}% | MCE: ${(metrics.mce * 100).toFixed(1)}%` : ''
          ],
          font: { size: 14 }
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const point = context.raw;
              if (point.count !== undefined) {
                return [
                  `${context.dataset.label.split(' (')[0]}`,
                  `Predicted: ${(point.x * 100).toFixed(1)}%`,
                  `Actual: ${(point.y * 100).toFixed(1)}%`,
                  `Games: ${point.count}`
                ];
              }
              return context.dataset.label;
            }
          }
        },
        legend: {
          labels: {
            filter: (item) => !item.text.startsWith('_')
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: 1,
          title: {
            display: true,
            text: 'Predicted Probability',
            font: { size: 12 }
          },
          ticks: {
            callback: (value) => `${(value * 100).toFixed(0)}%`,
            stepSize: 0.1
          },
          grid: { color: COLORS.grid }
        },
        y: {
          type: 'linear',
          min: 0,
          max: 1,
          title: {
            display: true,
            text: 'Actual Win Rate',
            font: { size: 12 }
          },
          ticks: {
            callback: (value) => `${(value * 100).toFixed(0)}%`,
            stepSize: 0.1
          },
          grid: { color: COLORS.grid }
        }
      }
    };
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
   * Get calibration metrics summary
   */
  getMetricsSummary() {
    const summaries = [];

    Object.entries(this.calibrationMetrics).forEach(([modelKey, metrics]) => {
      const label = this.formatModelName(modelKey);
      summaries.push({
        model: label,
        ece: metrics.ece,
        mce: metrics.mce,
        brierScore: metrics.brier.brier,
        reliability: metrics.brier.reliability,
        resolution: metrics.brier.resolution,
        calibrationQuality: this.getCalibrationQuality(metrics.ece)
      });
    });

    return summaries;
  }

  /**
   * Determine calibration quality from ECE
   */
  getCalibrationQuality(ece) {
    if (ece < 0.02) return 'Excellent';
    if (ece < 0.05) return 'Good';
    if (ece < 0.10) return 'Fair';
    return 'Poor';
  }

  /**
   * Render metrics table alongside chart
   */
  renderMetricsTable(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const summaries = this.getMetricsSummary();

    const html = `
      <table class="calibration-metrics-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>ECE</th>
            <th>MCE</th>
            <th>Brier</th>
            <th>Quality</th>
          </tr>
        </thead>
        <tbody>
          ${summaries.map(s => `
            <tr>
              <td>${s.model}</td>
              <td>${(s.ece * 100).toFixed(2)}%</td>
              <td>${(s.mce * 100).toFixed(2)}%</td>
              <td>${s.brierScore.toFixed(3)}</td>
              <td class="quality-${s.calibrationQuality.toLowerCase()}">${s.calibrationQuality}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    container.innerHTML = html;
  }

  /**
   * Update with new model selection
   */
  updateModels(modelKeys) {
    this.options.selectedModels = modelKeys;
    this.calculateCalibration();
    this.render();
  }

  /**
   * Export calibration data
   */
  exportData() {
    const rows = ['Model,Bin,Predicted,Actual,Count'];

    Object.entries(this.data).forEach(([modelKey, bins]) => {
      bins.forEach((bin, i) => {
        if (bin.count > 0) {
          rows.push([
            modelKey,
            `${(bin.binStart * 100).toFixed(0)}-${(bin.binEnd * 100).toFixed(0)}%`,
            (bin.avgPredicted * 100).toFixed(1) + '%',
            (bin.actualWinRate * 100).toFixed(1) + '%',
            bin.count
          ].join(','));
        }
      });
    });

    return rows.join('\n');
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

export default CalibrationPlot;
