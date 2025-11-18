/**
 * Predictive Power Metrics Component
 * Displays advanced statistical metrics for model evaluation
 */

import { ChartHelpers, MODEL_COLORS, COLORS } from '../../utils/chartHelpers.js';
import { Calculations } from '../../utils/calculations.js';

export class PredictivePowerMetrics {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.data = null;
    this.chart = null;
    this.options = {
      selectedModels: ['blended', 'logistic', 'tree', 'ann'],
      ...options
    };
  }

  /**
   * Load predictions and calculate metrics
   * @param {Array} predictions - All predictions with outcomes
   */
  async loadData(predictions) {
    this.predictions = predictions.filter(p => p.outcome);
    this.calculateMetrics();
    this.render();
  }

  /**
   * Calculate all predictive power metrics for each model
   */
  calculateMetrics() {
    this.data = {};

    this.options.selectedModels.forEach(modelKey => {
      const predData = this.predictions
        .filter(p => p.probs?.[modelKey] !== undefined)
        .map(p => ({
          predicted: p.probs[modelKey],
          actual: p.outcome === 'home' ? 1 : 0
        }));

      if (predData.length === 0) return;

      // Calculate all metrics
      const brier = Calculations.brierDecomposition(predData);
      const ece = Calculations.expectedCalibrationError(predData);
      const mce = Calculations.maxCalibrationError(predData);
      const mcc = Calculations.matthewsCorrelation(predData);
      const kappa = Calculations.cohensKappa(predData);
      const auprc = Calculations.areaUnderPRCurve(predData);

      // Calculate basic metrics
      const accuracy = predData.filter(p =>
        (p.predicted >= 0.5 && p.actual === 1) ||
        (p.predicted < 0.5 && p.actual === 0)
      ).length / predData.length;

      const logLoss = predData.reduce((sum, p) => {
        const pred = Math.max(0.001, Math.min(0.999, p.predicted));
        return sum - (p.actual * Math.log(pred) + (1 - p.actual) * Math.log(1 - pred));
      }, 0) / predData.length;

      this.data[modelKey] = {
        accuracy,
        logLoss,
        brierScore: brier.brier,
        reliability: brier.reliability,
        resolution: brier.resolution,
        uncertainty: brier.uncertainty,
        ece,
        mce,
        mcc,
        kappa,
        auprc,
        n: predData.length
      };
    });
  }

  /**
   * Render the metrics dashboard
   */
  render() {
    if (!this.container || !this.data) return;

    const html = `
      <div class="predictive-power-dashboard">
        <h3 class="dashboard-title">Predictive Power Metrics</h3>

        <div class="metrics-grid">
          ${this.renderMetricCards()}
        </div>

        <div class="metrics-comparison">
          <h4>Model Comparison</h4>
          <canvas id="metrics-radar-chart"></canvas>
        </div>

        <div class="metrics-table-section">
          <h4>Detailed Metrics</h4>
          ${this.renderMetricsTable()}
        </div>

        <div class="metrics-explanations">
          ${this.renderExplanations()}
        </div>
      </div>
    `;

    this.container.innerHTML = html;
    this.renderRadarChart();
  }

  /**
   * Render metric summary cards
   */
  renderMetricCards() {
    const primaryModel = this.data['blended'] || Object.values(this.data)[0];
    if (!primaryModel) return '';

    const cards = [
      {
        title: 'Brier Score',
        value: primaryModel.brierScore.toFixed(3),
        subtitle: this.getBrierQuality(primaryModel.brierScore),
        icon: '📊',
        tooltip: 'Lower is better. Measures prediction accuracy (0-1 scale).'
      },
      {
        title: 'MCC',
        value: primaryModel.mcc.toFixed(3),
        subtitle: this.getMCCQuality(primaryModel.mcc),
        icon: '📈',
        tooltip: 'Matthews Correlation Coefficient (-1 to 1). Higher is better.'
      },
      {
        title: 'ECE',
        value: `${(primaryModel.ece * 100).toFixed(1)}%`,
        subtitle: this.getECEQuality(primaryModel.ece),
        icon: '🎯',
        tooltip: 'Expected Calibration Error. Lower is better.'
      },
      {
        title: 'AUPRC',
        value: primaryModel.auprc.toFixed(3),
        subtitle: this.getAUPRCQuality(primaryModel.auprc),
        icon: '📉',
        tooltip: 'Area Under Precision-Recall Curve. Higher is better.'
      }
    ];

    return cards.map(card => `
      <div class="metric-card" title="${card.tooltip}">
        <div class="metric-icon">${card.icon}</div>
        <div class="metric-title">${card.title}</div>
        <div class="metric-value">${card.value}</div>
        <div class="metric-subtitle quality-${card.subtitle.toLowerCase()}">${card.subtitle}</div>
      </div>
    `).join('');
  }

  /**
   * Render detailed metrics table
   */
  renderMetricsTable() {
    const metrics = [
      { key: 'accuracy', label: 'Accuracy', format: 'percent' },
      { key: 'logLoss', label: 'Log Loss', format: 'decimal' },
      { key: 'brierScore', label: 'Brier Score', format: 'decimal' },
      { key: 'reliability', label: 'Reliability', format: 'decimal' },
      { key: 'resolution', label: 'Resolution', format: 'decimal' },
      { key: 'ece', label: 'ECE', format: 'percent' },
      { key: 'mce', label: 'MCE', format: 'percent' },
      { key: 'mcc', label: 'MCC', format: 'decimal' },
      { key: 'kappa', label: "Cohen's Kappa", format: 'decimal' },
      { key: 'auprc', label: 'AUPRC', format: 'decimal' }
    ];

    const modelKeys = Object.keys(this.data);

    return `
      <div class="metrics-table-wrapper">
        <table class="metrics-table">
          <thead>
            <tr>
              <th>Metric</th>
              ${modelKeys.map(k => `<th>${this.formatModelName(k)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${metrics.map(m => `
              <tr>
                <td class="metric-name">${m.label}</td>
                ${modelKeys.map(k => {
                  const value = this.data[k]?.[m.key];
                  const formatted = this.formatMetricValue(value, m.format);
                  const best = this.isBestValue(m.key, value);
                  return `<td class="${best ? 'best-value' : ''}">${formatted}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Render radar chart comparing models
   */
  renderRadarChart() {
    const canvas = this.container.querySelector('#metrics-radar-chart');
    if (!canvas || Object.keys(this.data).length === 0) return;

    if (this.chart) {
      this.chart.destroy();
    }

    const ctx = canvas.getContext('2d');
    const labels = ['Accuracy', 'Calibration', 'Discrimination', 'Precision', 'Reliability'];

    const datasets = Object.entries(this.data).map(([modelKey, metrics]) => {
      const color = MODEL_COLORS[modelKey] || '#666';

      // Normalize metrics to 0-1 scale for radar
      const data = [
        metrics.accuracy,
        1 - metrics.ece, // Invert ECE
        metrics.mcc * 0.5 + 0.5, // MCC from -1,1 to 0,1
        metrics.auprc,
        1 - metrics.reliability * 10 // Invert and scale reliability
      ];

      return {
        label: this.formatModelName(modelKey),
        data,
        backgroundColor: `${color}30`,
        borderColor: color,
        borderWidth: 2,
        pointBackgroundColor: color
      };
    });

    this.chart = new Chart(ctx, {
      type: 'radar',
      data: { labels, datasets },
      options: ChartHelpers.radarOptions({
        scales: {
          r: {
            min: 0,
            max: 1,
            ticks: {
              stepSize: 0.2,
              display: false
            }
          }
        },
        plugins: {
          legend: {
            position: 'bottom'
          }
        }
      })
    });
  }

  /**
   * Render metric explanations
   */
  renderExplanations() {
    return `
      <details class="metric-explanations">
        <summary>Metric Explanations</summary>
        <dl>
          <dt>Brier Score</dt>
          <dd>Mean squared difference between predicted probabilities and actual outcomes. Lower is better. Decomposes into reliability, resolution, and uncertainty.</dd>

          <dt>Expected Calibration Error (ECE)</dt>
          <dd>Weighted average of the difference between predicted probability and actual frequency across bins. Measures how well-calibrated predictions are.</dd>

          <dt>Matthews Correlation Coefficient (MCC)</dt>
          <dd>Correlation between predicted and actual binary classifications. Ranges from -1 (inverse) to +1 (perfect). Balanced measure that works well with imbalanced data.</dd>

          <dt>Cohen's Kappa</dt>
          <dd>Agreement measure that accounts for chance agreement. Values above 0.6 indicate substantial agreement.</dd>

          <dt>AUPRC</dt>
          <dd>Area Under the Precision-Recall Curve. Better than AUC-ROC for imbalanced datasets. Higher values indicate better ranking of positive examples.</dd>

          <dt>Resolution</dt>
          <dd>Measures how much predictions deviate from the base rate. Higher resolution means predictions are more "decisive".</dd>

          <dt>Reliability</dt>
          <dd>Measures calibration error. Lower is better - predictions that say 70% should win 70% of the time.</dd>
        </dl>
      </details>
    `;
  }

  /**
   * Format metric value
   */
  formatMetricValue(value, format) {
    if (value === undefined || value === null) return '—';

    switch (format) {
      case 'percent':
        return `${(value * 100).toFixed(1)}%`;
      case 'decimal':
        return value.toFixed(3);
      default:
        return value.toString();
    }
  }

  /**
   * Format model name
   */
  formatModelName(key) {
    const names = {
      blended: 'Ensemble',
      logistic: 'Logistic',
      tree: 'Tree',
      bt: 'B-T',
      ann: 'ANN',
      xgboost: 'XGB'
    };
    return names[key] || key;
  }

  /**
   * Check if value is best among models
   */
  isBestValue(metricKey, value) {
    if (value === undefined || value === null) return false;

    const allValues = Object.values(this.data)
      .map(d => d[metricKey])
      .filter(v => v !== undefined);

    // For some metrics, lower is better
    const lowerIsBetter = ['brierScore', 'logLoss', 'ece', 'mce', 'reliability'];

    if (lowerIsBetter.includes(metricKey)) {
      return value === Math.min(...allValues);
    }
    return value === Math.max(...allValues);
  }

  /**
   * Get quality label for Brier score
   */
  getBrierQuality(score) {
    if (score < 0.15) return 'Excellent';
    if (score < 0.20) return 'Good';
    if (score < 0.25) return 'Fair';
    return 'Poor';
  }

  /**
   * Get quality label for MCC
   */
  getMCCQuality(mcc) {
    if (mcc > 0.5) return 'Strong';
    if (mcc > 0.3) return 'Moderate';
    if (mcc > 0.1) return 'Weak';
    return 'None';
  }

  /**
   * Get quality label for ECE
   */
  getECEQuality(ece) {
    if (ece < 0.02) return 'Excellent';
    if (ece < 0.05) return 'Good';
    if (ece < 0.10) return 'Fair';
    return 'Poor';
  }

  /**
   * Get quality label for AUPRC
   */
  getAUPRCQuality(auprc) {
    if (auprc > 0.8) return 'Excellent';
    if (auprc > 0.6) return 'Good';
    if (auprc > 0.4) return 'Fair';
    return 'Poor';
  }

  /**
   * Export metrics data
   */
  exportData() {
    const metrics = Object.keys(Object.values(this.data)[0] || {});
    const rows = ['Model,' + metrics.join(',')];

    Object.entries(this.data).forEach(([model, data]) => {
      const values = metrics.map(m => {
        const v = data[m];
        return typeof v === 'number' ? v.toFixed(4) : v;
      });
      rows.push(`${model},${values.join(',')}`);
    });

    return rows.join('\n');
  }

  /**
   * Destroy chart
   */
  destroy() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }
}

export default PredictivePowerMetrics;
