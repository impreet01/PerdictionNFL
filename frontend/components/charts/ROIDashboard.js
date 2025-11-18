/**
 * ROI Dashboard Component
 * Tracks hypothetical betting performance with Kelly criterion suggestions
 */

import { ChartHelpers, MODEL_COLORS, COLORS } from '../../utils/chartHelpers.js';
import { DataTransformers } from '../../utils/dataTransformers.js';
import { Calculations } from '../../utils/calculations.js';

export class ROIDashboard {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.charts = {
      roi: null,
      bankroll: null,
      thresholds: null
    };
    this.data = null;
    this.options = {
      initialBankroll: 1000,
      betSize: 100,
      modelKey: 'blended',
      ...options
    };
  }

  /**
   * Load predictions and calculate ROI data
   * @param {Array} predictions - All predictions with outcomes
   */
  async loadData(predictions) {
    this.predictions = predictions.filter(p => p.outcome);
    this.data = DataTransformers.toROIData(this.predictions, this.options.modelKey);
    this.render();
  }

  /**
   * Render all ROI dashboard charts
   */
  render() {
    if (!this.container || !this.data) return;

    this.renderROIChart();
    this.renderBankrollChart();
    this.renderSummaryCards();
  }

  /**
   * Render ROI by confidence threshold chart
   */
  renderROIChart() {
    const chartContainer = this.container.querySelector('#roi-threshold-chart');
    if (!chartContainer) return;

    if (this.charts.roi) {
      this.charts.roi.destroy();
    }

    const ctx = chartContainer.getContext('2d');
    const labels = this.data.map(d => `${(d.threshold * 100).toFixed(0)}%`);
    const roiValues = this.data.map(d => d.roi);
    const colors = roiValues.map(r => r >= 0 ? COLORS.success : COLORS.danger);

    this.charts.roi = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'ROI %',
          data: roiValues,
          backgroundColor: colors,
          borderColor: colors,
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'ROI by Confidence Threshold',
            font: { size: 14 }
          },
          tooltip: {
            callbacks: {
              afterLabel: (context) => {
                const d = this.data[context.dataIndex];
                return [
                  `Bets: ${d.bets}`,
                  `Win Rate: ${(d.winRate * 100).toFixed(1)}%`,
                  `Profit: $${d.profit.toFixed(2)}`
                ];
              }
            }
          }
        },
        scales: {
          y: {
            title: {
              display: true,
              text: 'ROI %'
            },
            ticks: {
              callback: (v) => `${v.toFixed(0)}%`
            }
          },
          x: {
            title: {
              display: true,
              text: 'Min. Confidence'
            }
          }
        }
      }
    });
  }

  /**
   * Render bankroll progression chart
   */
  renderBankrollChart() {
    const chartContainer = this.container.querySelector('#bankroll-chart');
    if (!chartContainer) return;

    if (this.charts.bankroll) {
      this.charts.bankroll.destroy();
    }

    const ctx = chartContainer.getContext('2d');

    // Find best performing threshold
    const bestThreshold = this.data.reduce((best, d) =>
      d.roi > best.roi ? d : best, this.data[0]);

    const labels = bestThreshold.bankroll.map((_, i) => i);

    this.charts.bankroll = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: `Bankroll (${(bestThreshold.threshold * 100).toFixed(0)}% threshold)`,
          data: bestThreshold.bankroll,
          borderColor: COLORS.info,
          backgroundColor: `${COLORS.info}20`,
          fill: true,
          tension: 0.1
        }, {
          label: 'Initial Bankroll',
          data: labels.map(() => this.options.initialBankroll),
          borderColor: COLORS.reference,
          borderDash: [5, 5],
          borderWidth: 1,
          fill: false,
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Bankroll Progression',
            font: { size: 14 }
          }
        },
        scales: {
          y: {
            title: {
              display: true,
              text: 'Bankroll ($)'
            },
            ticks: {
              callback: (v) => `$${v.toFixed(0)}`
            }
          },
          x: {
            title: {
              display: true,
              text: 'Bet Number'
            }
          }
        }
      }
    });
  }

  /**
   * Render summary metric cards
   */
  renderSummaryCards() {
    const cardsContainer = this.container.querySelector('#roi-summary-cards');
    if (!cardsContainer) return;

    // Calculate overall stats
    const best = this.data.reduce((b, d) => d.roi > b.roi ? d : b, this.data[0]);
    const totalBets = this.data[0].bets; // 50% threshold = all bets
    const optimalKelly = this.calculateOptimalKelly();

    const cards = [
      {
        title: 'Best ROI',
        value: `${best.roi.toFixed(1)}%`,
        subtitle: `@ ${(best.threshold * 100).toFixed(0)}% conf.`,
        color: best.roi >= 0 ? 'success' : 'danger'
      },
      {
        title: 'Best Win Rate',
        value: `${(best.winRate * 100).toFixed(1)}%`,
        subtitle: `${best.wins}/${best.bets} bets`,
        color: best.winRate >= 0.52 ? 'success' : 'warning'
      },
      {
        title: 'Max Profit',
        value: `$${best.profit.toFixed(0)}`,
        subtitle: `from $${this.options.initialBankroll}`,
        color: best.profit >= 0 ? 'success' : 'danger'
      },
      {
        title: 'Kelly Fraction',
        value: `${(optimalKelly * 100).toFixed(1)}%`,
        subtitle: 'Optimal bet size',
        color: optimalKelly > 0 ? 'info' : 'neutral'
      }
    ];

    cardsContainer.innerHTML = cards.map(card => `
      <div class="roi-card roi-card-${card.color}">
        <div class="roi-card-title">${card.title}</div>
        <div class="roi-card-value">${card.value}</div>
        <div class="roi-card-subtitle">${card.subtitle}</div>
      </div>
    `).join('');
  }

  /**
   * Calculate optimal Kelly criterion
   */
  calculateOptimalKelly() {
    // Use best performing threshold
    const best = this.data.reduce((b, d) => d.roi > b.roi ? d : b, this.data[0]);
    const probability = best.winRate;
    const odds = 1.91; // Standard -110 odds as decimal

    return Calculations.kellyCriterion(probability, odds);
  }

  /**
   * Render detailed bet history table
   */
  renderBetHistory(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const bets = this.getBetHistory();

    const html = `
      <div class="bet-history-table-wrapper">
        <table class="bet-history-table">
          <thead>
            <tr>
              <th>Game</th>
              <th>Pick</th>
              <th>Conf.</th>
              <th>Result</th>
              <th>P/L</th>
            </tr>
          </thead>
          <tbody>
            ${bets.slice(0, 50).map(bet => `
              <tr class="bet-${bet.won ? 'win' : 'loss'}">
                <td>${bet.away} @ ${bet.home}</td>
                <td>${bet.pick}</td>
                <td>${(bet.confidence * 100).toFixed(0)}%</td>
                <td>${bet.won ? 'W' : 'L'}</td>
                <td class="${bet.profit >= 0 ? 'positive' : 'negative'}">
                  ${bet.profit >= 0 ? '+' : ''}$${bet.profit.toFixed(0)}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    container.innerHTML = html;
  }

  /**
   * Get detailed bet history
   */
  getBetHistory() {
    const threshold = 0.55; // Use moderate threshold
    const bets = [];

    this.predictions.forEach(p => {
      const prob = p.probs?.[this.options.modelKey] ?? p.forecast;
      const actual = p.outcome === 'home' ? 1 : 0;

      if (prob >= threshold || prob <= (1 - threshold)) {
        const betOnHome = prob >= threshold;
        const won = (betOnHome && actual === 1) || (!betOnHome && actual === 0);

        bets.push({
          game: p.game_id,
          home: p.home_team,
          away: p.away_team,
          pick: betOnHome ? p.home_team : p.away_team,
          confidence: Math.abs(0.5 - prob) * 2,
          won,
          profit: won ? this.options.betSize * 0.91 : -this.options.betSize
        });
      }
    });

    return bets;
  }

  /**
   * Calculate risk-adjusted metrics
   */
  getRiskMetrics() {
    const best = this.data.reduce((b, d) => d.roi > b.roi ? d : b, this.data[0]);
    const returns = [];
    let cumulative = this.options.initialBankroll;

    best.bankroll.slice(1).forEach((value, i) => {
      const ret = (value - best.bankroll[i]) / best.bankroll[i];
      returns.push(ret);
      cumulative = value;
    });

    const avgReturn = returns.length > 0 ?
      returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = Math.sqrt(
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    ) || 1;

    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(returns.length) : 0;

    // Max drawdown
    let maxDrawdown = 0;
    let peak = this.options.initialBankroll;
    best.bankroll.forEach(value => {
      if (value > peak) peak = value;
      const drawdown = (peak - value) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    });

    return {
      sharpeRatio,
      maxDrawdown,
      avgReturn,
      volatility: stdDev,
      finalValue: best.bankroll[best.bankroll.length - 1]
    };
  }

  /**
   * Update with new model
   */
  updateModel(modelKey) {
    this.options.modelKey = modelKey;
    if (this.predictions) {
      this.data = DataTransformers.toROIData(this.predictions, modelKey);
      this.render();
    }
  }

  /**
   * Export ROI data
   */
  exportData() {
    const rows = ['Threshold,ROI,Profit,Bets,Wins,Win Rate'];

    this.data.forEach(d => {
      rows.push([
        `${(d.threshold * 100).toFixed(0)}%`,
        `${d.roi.toFixed(2)}%`,
        `$${d.profit.toFixed(2)}`,
        d.bets,
        d.wins,
        `${(d.winRate * 100).toFixed(1)}%`
      ].join(','));
    });

    return rows.join('\n');
  }

  /**
   * Destroy all charts
   */
  destroy() {
    Object.values(this.charts).forEach(chart => {
      if (chart) chart.destroy();
    });
    this.charts = { roi: null, bankroll: null, thresholds: null };
  }
}

export default ROIDashboard;
