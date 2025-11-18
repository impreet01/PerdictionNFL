/**
 * Smart Cards System
 * Quick stats cards with best bets, upset alerts, and key metrics
 */

import { ChartHelpers, COLORS } from '../../utils/chartHelpers.js';
import { DataTransformers } from '../../utils/dataTransformers.js';

export class SmartCards {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.data = null;
    this.sparklines = [];
    this.options = {
      showSparklines: true,
      animateValues: true,
      ...options
    };
  }

  /**
   * Load predictions and metrics to generate cards
   * @param {Array} predictions - Current week predictions
   * @param {Object} metrics - Week/season metrics
   * @param {Object} seasonData - Season-level data for trends
   */
  async loadData(predictions, metrics, seasonData) {
    this.predictions = predictions;
    this.metrics = metrics;
    this.seasonData = seasonData;
    this.data = DataTransformers.toSmartCardData(predictions, metrics);
    this.render();
  }

  /**
   * Render all smart cards
   */
  render() {
    if (!this.container) return;

    const html = `
      <div class="smart-cards-container">
        ${this.renderBestBetsCard()}
        ${this.renderConsensusCard()}
        ${this.renderUpsetAlertCard()}
        ${this.renderPerformanceCard()}
        ${this.renderQuickStatsCard()}
      </div>
    `;

    this.container.innerHTML = html;

    if (this.options.showSparklines) {
      this.renderSparklines();
    }

    if (this.options.animateValues) {
      this.animateNumbers();
    }
  }

  /**
   * Render best bets card
   */
  renderBestBetsCard() {
    const { bestBets } = this.data;

    return `
      <div class="smart-card best-bets-card">
        <div class="card-header">
          <span class="card-icon">🎯</span>
          <h4>Top Picks</h4>
        </div>
        <div class="card-content">
          ${bestBets.length > 0 ? bestBets.map(bet => `
            <div class="bet-item">
              <span class="bet-pick">${bet.pick}</span>
              <span class="bet-game">${bet.game}</span>
              <div class="confidence-bar">
                <div class="confidence-fill" style="width: ${bet.confidence}%"></div>
                <span class="confidence-value">${bet.confidence.toFixed(0)}%</span>
              </div>
            </div>
          `).join('') : '<p class="no-data">No games available</p>'}
        </div>
      </div>
    `;
  }

  /**
   * Render consensus indicator card
   */
  renderConsensusCard() {
    const { consensus, avgConfidence } = this.data;
    const consensusLevel = this.getConsensusLevel(consensus);

    return `
      <div class="smart-card consensus-card">
        <div class="card-header">
          <span class="card-icon">🤝</span>
          <h4>Model Consensus</h4>
        </div>
        <div class="card-content">
          <div class="gauge-container">
            <div class="consensus-gauge">
              <svg viewBox="0 0 100 60" class="gauge-svg">
                <path d="M 10 50 A 40 40 0 0 1 90 50"
                  fill="none" stroke="#e0e0e0" stroke-width="8"/>
                <path d="M 10 50 A 40 40 0 0 1 90 50"
                  fill="none" stroke="${this.getConsensusColor(consensus)}"
                  stroke-width="8"
                  stroke-dasharray="${consensus * 1.26}, 126"
                  class="gauge-fill"/>
              </svg>
              <div class="gauge-value animate-number" data-value="${consensus}">
                ${consensus.toFixed(0)}%
              </div>
            </div>
          </div>
          <div class="consensus-label">${consensusLevel}</div>
          <div class="avg-confidence">
            Avg Confidence: <strong>${avgConfidence.toFixed(1)}%</strong>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render upset alert card
   */
  renderUpsetAlertCard() {
    const { upsetAlerts } = this.data;

    return `
      <div class="smart-card upset-alert-card">
        <div class="card-header">
          <span class="card-icon">⚠️</span>
          <h4>Upset Alerts</h4>
        </div>
        <div class="card-content">
          ${upsetAlerts.length > 0 ? upsetAlerts.map(alert => `
            <div class="alert-item">
              <span class="alert-game">${alert.game}</span>
              <span class="alert-variance">High model disagreement</span>
            </div>
          `).join('') : `
            <p class="no-alerts">No upset alerts this week</p>
            <p class="alert-info">Models are in agreement</p>
          `}
        </div>
      </div>
    `;
  }

  /**
   * Render performance card with sparkline
   */
  renderPerformanceCard() {
    const accuracy = this.metrics?.per_model?.blended?.accuracy || 0;
    const trend = this.getTrendFromSeasonData();

    return `
      <div class="smart-card performance-card">
        <div class="card-header">
          <span class="card-icon">📈</span>
          <h4>Season Performance</h4>
        </div>
        <div class="card-content">
          <div class="performance-value animate-number" data-value="${accuracy * 100}">
            ${(accuracy * 100).toFixed(1)}%
          </div>
          <div class="performance-label">Current Accuracy</div>
          <div class="sparkline-container">
            <canvas id="performance-sparkline" height="40"></canvas>
          </div>
          <div class="trend-indicator ${trend.direction}">
            <span class="trend-icon">${trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'}</span>
            <span class="trend-text">${trend.label}</span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render quick stats card
   */
  renderQuickStatsCard() {
    const blendedMetrics = this.metrics?.per_model?.blended || {};
    const gamesThisWeek = this.predictions?.length || 0;

    return `
      <div class="smart-card quick-stats-card">
        <div class="card-header">
          <span class="card-icon">📊</span>
          <h4>Quick Stats</h4>
        </div>
        <div class="card-content">
          <div class="stats-grid">
            <div class="stat-item">
              <span class="stat-value">${gamesThisWeek}</span>
              <span class="stat-label">Games</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${blendedMetrics.n || 0}</span>
              <span class="stat-label">Predicted</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${(blendedMetrics.auc * 100 || 0).toFixed(0)}%</span>
              <span class="stat-label">AUC</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${blendedMetrics.brier?.toFixed(3) || '—'}</span>
              <span class="stat-label">Brier</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render sparklines for trend visualization
   */
  renderSparklines() {
    const sparklineCanvas = this.container.querySelector('#performance-sparkline');
    if (!sparklineCanvas || !this.seasonData?.weeks) return;

    const ctx = sparklineCanvas.getContext('2d');
    const weeklyAccuracy = this.seasonData.weeks.map(w =>
      w.per_model?.blended?.accuracy || 0
    );

    if (weeklyAccuracy.length === 0) return;

    const config = ChartHelpers.sparklineConfig(weeklyAccuracy, COLORS.info);
    const chart = new Chart(ctx, config);
    this.sparklines.push(chart);
  }

  /**
   * Animate number values
   */
  animateNumbers() {
    const elements = this.container.querySelectorAll('.animate-number');

    elements.forEach(el => {
      const finalValue = parseFloat(el.dataset.value);
      const duration = 1000;
      const startTime = performance.now();

      const animate = (currentTime) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Ease out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const currentValue = finalValue * eased;

        el.textContent = `${currentValue.toFixed(1)}%`;

        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };

      requestAnimationFrame(animate);
    });
  }

  /**
   * Get consensus level description
   */
  getConsensusLevel(consensus) {
    if (consensus >= 90) return 'Very High Agreement';
    if (consensus >= 75) return 'High Agreement';
    if (consensus >= 60) return 'Moderate Agreement';
    if (consensus >= 40) return 'Mixed Signals';
    return 'High Disagreement';
  }

  /**
   * Get consensus color
   */
  getConsensusColor(consensus) {
    if (consensus >= 75) return COLORS.success;
    if (consensus >= 50) return COLORS.warning;
    return COLORS.danger;
  }

  /**
   * Get trend from season data
   */
  getTrendFromSeasonData() {
    if (!this.seasonData?.weeks || this.seasonData.weeks.length < 3) {
      return { direction: 'neutral', label: 'Not enough data' };
    }

    const recent = this.seasonData.weeks.slice(-3);
    const recentAvg = recent.reduce((sum, w) =>
      sum + (w.per_model?.blended?.accuracy || 0), 0) / recent.length;

    const older = this.seasonData.weeks.slice(-6, -3);
    if (older.length === 0) {
      return { direction: 'neutral', label: 'Stable' };
    }

    const olderAvg = older.reduce((sum, w) =>
      sum + (w.per_model?.blended?.accuracy || 0), 0) / older.length;

    const diff = recentAvg - olderAvg;

    if (diff > 0.02) return { direction: 'up', label: 'Improving' };
    if (diff < -0.02) return { direction: 'down', label: 'Declining' };
    return { direction: 'neutral', label: 'Stable' };
  }

  /**
   * Refresh cards with new data
   */
  refresh(predictions, metrics, seasonData) {
    this.destroy();
    this.loadData(predictions, metrics, seasonData);
  }

  /**
   * Export card data
   */
  exportData() {
    return {
      bestBets: this.data.bestBets,
      consensus: this.data.consensus,
      avgConfidence: this.data.avgConfidence,
      upsetAlerts: this.data.upsetAlerts,
      metrics: this.metrics?.per_model?.blended
    };
  }

  /**
   * Destroy sparkline charts
   */
  destroy() {
    this.sparklines.forEach(chart => chart.destroy());
    this.sparklines = [];
  }
}

export default SmartCards;
