/**
 * NFL Analytics Platform - Enhanced App Integration
 * Standalone version without ES6 module imports for browser compatibility
 */

(function() {
  'use strict';

  // ===== UTILITY FUNCTIONS =====

  const MODEL_COLORS = {
    blended: '#1f77b4',
    logistic: '#ff7f0e',
    tree: '#2ca02c',
    bt: '#d62728',
    ann: '#9467bd',
    xgboost: '#8c564b',
    ngs: '#17becf',
    qbr: '#bcbd22'
  };

  const COLORS = {
    success: '#2ca58d',
    danger: '#ff6b6b',
    warning: '#ffa726',
    info: '#4dabf7',
    neutral: '#6c757d',
    reference: '#888888',
    grid: 'rgba(128, 128, 128, 0.1)'
  };

  // Calculations utility
  const Calculations = {
    brierDecomposition(predictions) {
      if (!predictions || predictions.length === 0) {
        return { brier: 0, reliability: 0, resolution: 0, uncertainty: 0 };
      }
      const n = predictions.length;
      const baseRate = predictions.reduce((sum, p) => sum + p.actual, 0) / n;
      const uncertainty = baseRate * (1 - baseRate);
      const bins = this.createProbabilityBins(predictions, 10);
      let reliability = 0;
      let resolution = 0;
      bins.forEach(bin => {
        if (bin.count > 0) {
          const avgPred = bin.sumPred / bin.count;
          const avgActual = bin.sumActual / bin.count;
          reliability += bin.count * Math.pow(avgPred - avgActual, 2);
          resolution += bin.count * Math.pow(avgActual - baseRate, 2);
        }
      });
      reliability /= n;
      resolution /= n;
      const brier = predictions.reduce((sum, p) =>
        sum + Math.pow(p.predicted - p.actual, 2), 0) / n;
      return { brier, reliability, resolution, uncertainty };
    },

    createProbabilityBins(predictions, numBins = 10) {
      const bins = Array.from({ length: numBins }, () => ({
        count: 0, sumPred: 0, sumActual: 0, predictions: []
      }));
      predictions.forEach(p => {
        const binIndex = Math.min(Math.floor(p.predicted * numBins), numBins - 1);
        bins[binIndex].count++;
        bins[binIndex].sumPred += p.predicted;
        bins[binIndex].sumActual += p.actual;
        bins[binIndex].predictions.push(p);
      });
      return bins;
    },

    expectedCalibrationError(predictions, numBins = 10) {
      const bins = this.createProbabilityBins(predictions, numBins);
      const n = predictions.length;
      return bins.reduce((ece, bin) => {
        if (bin.count === 0) return ece;
        const avgPred = bin.sumPred / bin.count;
        const avgActual = bin.sumActual / bin.count;
        return ece + (bin.count / n) * Math.abs(avgActual - avgPred);
      }, 0);
    },

    maxCalibrationError(predictions, numBins = 10) {
      const bins = this.createProbabilityBins(predictions, numBins);
      return bins.reduce((mce, bin) => {
        if (bin.count === 0) return mce;
        const avgPred = bin.sumPred / bin.count;
        const avgActual = bin.sumActual / bin.count;
        return Math.max(mce, Math.abs(avgActual - avgPred));
      }, 0);
    },

    matthewsCorrelation(predictions, threshold = 0.5) {
      let tp = 0, tn = 0, fp = 0, fn = 0;
      predictions.forEach(p => {
        const predicted = p.predicted >= threshold ? 1 : 0;
        if (predicted === 1 && p.actual === 1) tp++;
        else if (predicted === 0 && p.actual === 0) tn++;
        else if (predicted === 1 && p.actual === 0) fp++;
        else fn++;
      });
      const numerator = (tp * tn) - (fp * fn);
      const denominator = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
      return denominator === 0 ? 0 : numerator / denominator;
    },

    kellyCriterion(probability, odds) {
      const q = 1 - probability;
      const b = odds - 1;
      return Math.max(0, (b * probability - q) / b);
    },

    rollingAverage(values, window) {
      const result = [];
      for (let i = 0; i < values.length; i++) {
        const start = Math.max(0, i - window + 1);
        const slice = values.slice(start, i + 1);
        result.push(slice.reduce((a, b) => a + b, 0) / slice.length);
      }
      return result;
    }
  };

  // Data transformers
  const DataTransformers = {
    toCalibrationData(predictions, modelKey = 'blended') {
      const numBins = 10;
      const bins = Array.from({ length: numBins }, (_, i) => ({
        binStart: i / numBins,
        binEnd: (i + 1) / numBins,
        binMid: (i + 0.5) / numBins,
        count: 0,
        actualWins: 0,
        avgPredicted: 0
      }));

      predictions.forEach(p => {
        const prob = p.probs?.[modelKey] ?? p.forecast;
        const actual = p.outcome === 'home' ? 1 : (p.outcome === 'away' ? 0 : null);
        if (actual === null || typeof prob !== 'number') return;
        const binIndex = Math.min(Math.floor(prob * numBins), numBins - 1);
        bins[binIndex].count++;
        bins[binIndex].actualWins += actual;
        bins[binIndex].avgPredicted += prob;
      });

      bins.forEach(bin => {
        if (bin.count > 0) {
          bin.actualWinRate = bin.actualWins / bin.count;
          bin.avgPredicted = bin.avgPredicted / bin.count;
        } else {
          bin.actualWinRate = null;
          bin.avgPredicted = bin.binMid;
        }
      });

      return bins;
    },

    toSeasonAccuracyData(seasonMetrics) {
      if (!seasonMetrics?.weeks) return null;
      const weeks = seasonMetrics.weeks.map(w => `Week ${w.week}`);
      const models = {};

      seasonMetrics.weeks.forEach((week) => {
        if (!week.per_model) return;
        Object.entries(week.per_model).forEach(([modelKey, metrics]) => {
          if (!models[modelKey]) {
            models[modelKey] = {
              weekly: [], cumulative: [], totalCorrect: 0, totalGames: 0
            };
          }
          const accuracy = metrics.accuracy ?? 0;
          const n = metrics.n ?? 0;
          const correct = Math.round(accuracy * n);
          models[modelKey].weekly.push(accuracy);
          models[modelKey].totalCorrect += correct;
          models[modelKey].totalGames += n;
          models[modelKey].cumulative.push(
            models[modelKey].totalGames > 0
              ? models[modelKey].totalCorrect / models[modelKey].totalGames
              : 0
          );
        });
      });

      return { weeks, models };
    },

    toROIData(predictions, modelKey = 'blended') {
      const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75];
      return thresholds.map(threshold => {
        let profit = 0, bets = 0, wins = 0;
        const bankroll = [1000];

        predictions.forEach(p => {
          const prob = p.probs?.[modelKey] ?? p.forecast;
          const actual = p.outcome === 'home' ? 1 : (p.outcome === 'away' ? 0 : null);
          if (actual === null) return;
          if (prob >= threshold || prob <= (1 - threshold)) {
            const betOnHome = prob >= threshold;
            const won = (betOnHome && actual === 1) || (!betOnHome && actual === 0);
            const betSize = 100;
            bets++;
            if (won) {
              profit += betSize * 0.91;
              wins++;
            } else {
              profit -= betSize;
            }
            bankroll.push(bankroll[bankroll.length - 1] + (won ? betSize * 0.91 : -betSize));
          }
        });

        return {
          threshold,
          roi: bets > 0 ? (profit / (bets * 100)) * 100 : 0,
          profit, bets, wins,
          winRate: bets > 0 ? wins / bets : 0,
          bankroll
        };
      });
    },

    toSmartCardData(predictions, metrics) {
      if (!predictions || predictions.length === 0) {
        return { bestBets: [], upsetAlerts: [], consensus: 0, avgConfidence: 0 };
      }

      const bestBets = [...predictions]
        .sort((a, b) => {
          const aConf = Math.abs(0.5 - (a.probs?.blended ?? a.forecast));
          const bConf = Math.abs(0.5 - (b.probs?.blended ?? b.forecast));
          return bConf - aConf;
        })
        .slice(0, 3)
        .map(p => ({
          game: `${p.away_team} @ ${p.home_team}`,
          pick: (p.probs?.blended ?? p.forecast) >= 0.5 ? p.home_team : p.away_team,
          confidence: Math.abs(0.5 - (p.probs?.blended ?? p.forecast)) * 200
        }));

      const upsetAlerts = predictions
        .filter(p => {
          if (!p.probs) return false;
          const probs = Object.values(p.probs).filter(v => typeof v === 'number');
          const max = Math.max(...probs);
          const min = Math.min(...probs);
          return (max - min) > 0.3;
        })
        .slice(0, 3)
        .map(p => ({
          game: `${p.away_team} @ ${p.home_team}`,
          variance: p.diagnostics?.variance || 0
        }));

      let consensusSum = 0;
      predictions.forEach(p => {
        if (!p.probs) return;
        const probs = Object.values(p.probs).filter(v => typeof v === 'number');
        const allAgree = probs.every(prob => (prob >= 0.5) === (probs[0] >= 0.5));
        if (allAgree) consensusSum++;
      });
      const consensus = predictions.length > 0 ? (consensusSum / predictions.length) * 100 : 0;

      const avgConfidence = predictions.reduce((sum, p) => {
        return sum + Math.abs(0.5 - (p.probs?.blended ?? p.forecast)) * 200;
      }, 0) / predictions.length;

      return { bestBets, upsetAlerts, consensus, avgConfidence };
    }
  };

  // ===== ENHANCED STATE =====

  const enhancedState = {
    charts: {},
    allPredictions: [],
    isInitialized: false,
    analyticsLoaded: false,
    bettingLoaded: false
  };

  // ===== SMART CARDS =====

  function renderSmartCards() {
    const container = document.getElementById('smart-cards-container');
    if (!container || !window.state?.predictions) return;

    const data = DataTransformers.toSmartCardData(
      window.state.predictions,
      window.state.weekMetrics
    );

    const consensusColor = data.consensus >= 75 ? COLORS.success :
      data.consensus >= 50 ? COLORS.warning : COLORS.danger;

    container.innerHTML = `
      <div class="smart-cards-container">
        <div class="smart-card">
          <div class="card-header">
            <span class="card-icon">🎯</span>
            <h4>Top Picks</h4>
          </div>
          <div class="card-content">
            ${data.bestBets.length > 0 ? data.bestBets.map(bet => `
              <div class="bet-item">
                <span class="bet-pick">${bet.pick}</span>
                <span class="bet-game">${bet.game}</span>
                <div class="confidence-bar">
                  <div class="confidence-fill" style="width: ${bet.confidence}%"></div>
                </div>
              </div>
            `).join('') : '<p class="no-data">No games available</p>'}
          </div>
        </div>

        <div class="smart-card">
          <div class="card-header">
            <span class="card-icon">🤝</span>
            <h4>Model Consensus</h4>
          </div>
          <div class="card-content">
            <div class="performance-value" style="color: ${consensusColor}">
              ${data.consensus.toFixed(0)}%
            </div>
            <div class="performance-label">Agreement</div>
            <div class="avg-confidence">
              Avg Confidence: <strong>${data.avgConfidence.toFixed(1)}%</strong>
            </div>
          </div>
        </div>

        <div class="smart-card">
          <div class="card-header">
            <span class="card-icon">⚠️</span>
            <h4>Upset Alerts</h4>
          </div>
          <div class="card-content">
            ${data.upsetAlerts.length > 0 ? data.upsetAlerts.map(alert => `
              <div class="alert-item">
                <span class="alert-game">${alert.game}</span>
                <span class="alert-variance">High model disagreement</span>
              </div>
            `).join('') : `
              <p class="no-alerts">No upset alerts</p>
              <p class="alert-info">Models are in agreement</p>
            `}
          </div>
        </div>

        <div class="smart-card">
          <div class="card-header">
            <span class="card-icon">📊</span>
            <h4>Quick Stats</h4>
          </div>
          <div class="card-content">
            <div class="stats-grid">
              <div class="stat-item">
                <span class="stat-value">${window.state.predictions.length}</span>
                <span class="stat-label">Games</span>
              </div>
              <div class="stat-item">
                <span class="stat-value">${window.state.weekMetrics?.per_model?.blended?.n || 0}</span>
                <span class="stat-label">Predicted</span>
              </div>
              <div class="stat-item">
                <span class="stat-value">${((window.state.weekMetrics?.per_model?.blended?.accuracy || 0) * 100).toFixed(0)}%</span>
                <span class="stat-label">Accuracy</span>
              </div>
              <div class="stat-item">
                <span class="stat-value">${window.state.weekMetrics?.per_model?.blended?.brier?.toFixed(3) || '—'}</span>
                <span class="stat-label">Brier</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ===== ANALYTICS TAB =====

  async function loadAnalyticsData() {
    if (!window.state?.season) return;

    // Load all predictions for the season
    if (enhancedState.allPredictions.length === 0) {
      await loadSeasonPredictions();
    }

    // Render Season Accuracy Tracker
    renderAccuracyTracker();

    // Render Calibration Plot
    renderCalibrationPlot();

    // Render Performance Matrix
    renderPerformanceMatrix();

    // Render Predictive Metrics
    renderPredictiveMetrics();
  }

  async function loadSeasonPredictions() {
    if (!window.state?.season) return;

    const season = window.state.season;
    const predictions = [];
    const seasonMetrics = window.seasonMetricsCache?.get(season);

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

  function renderAccuracyTracker() {
    const canvas = document.getElementById('accuracy-tracker-chart');
    if (!canvas) return;

    const seasonMetrics = window.seasonMetricsCache?.get(window.state.season);
    const data = DataTransformers.toSeasonAccuracyData(seasonMetrics);
    if (!data) return;

    if (enhancedState.charts.accuracy) {
      enhancedState.charts.accuracy.destroy();
    }

    const ctx = canvas.getContext('2d');
    const datasets = [];

    Object.entries(data.models).forEach(([modelKey, modelData]) => {
      const color = MODEL_COLORS[modelKey] || '#666';
      datasets.push({
        label: modelKey,
        data: modelData.cumulative,
        borderColor: color,
        backgroundColor: `${color}20`,
        borderWidth: modelKey === 'blended' ? 3 : 2,
        tension: 0.3,
        fill: modelKey === 'blended'
      });
    });

    enhancedState.charts.accuracy = new Chart(ctx, {
      type: 'line',
      data: { labels: data.weeks, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Cumulative Model Accuracy Over Season'
          },
          annotation: {
            annotations: {
              baseline: {
                type: 'line',
                yMin: 0.5,
                yMax: 0.5,
                borderColor: COLORS.reference,
                borderWidth: 1,
                borderDash: [5, 5]
              }
            }
          }
        },
        scales: {
          y: {
            min: 0.4,
            max: 0.8,
            ticks: {
              callback: v => `${(v * 100).toFixed(0)}%`
            }
          }
        }
      }
    });
  }

  function renderCalibrationPlot() {
    const canvas = document.getElementById('calibration-chart');
    if (!canvas || enhancedState.allPredictions.length === 0) return;

    if (enhancedState.charts.calibration) {
      enhancedState.charts.calibration.destroy();
    }

    const modelKey = document.getElementById('calibration-model-select')?.value || 'blended';
    const bins = DataTransformers.toCalibrationData(enhancedState.allPredictions, modelKey);

    const ctx = canvas.getContext('2d');
    const calibrationPoints = bins
      .filter(bin => bin.count > 0)
      .map(bin => ({ x: bin.avgPredicted, y: bin.actualWinRate }));

    enhancedState.charts.calibration = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Perfect Calibration',
            data: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
            type: 'line',
            borderColor: COLORS.reference,
            borderDash: [5, 5],
            borderWidth: 1,
            fill: false,
            pointRadius: 0
          },
          {
            label: 'Actual Calibration',
            data: calibrationPoints,
            backgroundColor: MODEL_COLORS[modelKey],
            borderColor: MODEL_COLORS[modelKey],
            borderWidth: 2,
            showLine: true,
            tension: 0.2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Prediction Calibration'
          }
        },
        scales: {
          x: {
            min: 0, max: 1,
            title: { display: true, text: 'Predicted Probability' },
            ticks: { callback: v => `${(v * 100).toFixed(0)}%` }
          },
          y: {
            min: 0, max: 1,
            title: { display: true, text: 'Actual Win Rate' },
            ticks: { callback: v => `${(v * 100).toFixed(0)}%` }
          }
        }
      }
    });

    // Update metrics display
    const metricsContainer = document.getElementById('calibration-metrics');
    if (metricsContainer) {
      const predData = enhancedState.allPredictions
        .filter(p => p.probs?.[modelKey] !== undefined && p.outcome)
        .map(p => ({
          predicted: p.probs[modelKey],
          actual: p.outcome === 'home' ? 1 : 0
        }));

      const ece = Calculations.expectedCalibrationError(predData);
      const mce = Calculations.maxCalibrationError(predData);

      metricsContainer.innerHTML = `
        <div style="display: flex; gap: 1rem; font-size: 0.75rem;">
          <span>ECE: <strong>${(ece * 100).toFixed(1)}%</strong></span>
          <span>MCE: <strong>${(mce * 100).toFixed(1)}%</strong></span>
        </div>
      `;
    }
  }

  function renderPerformanceMatrix() {
    const container = document.getElementById('performance-matrix-container');
    if (!container || enhancedState.allPredictions.length === 0) return;

    // Group by confidence ranges
    const ranges = [
      { label: '50-55%', min: 0.50, max: 0.55 },
      { label: '55-60%', min: 0.55, max: 0.60 },
      { label: '60-65%', min: 0.60, max: 0.65 },
      { label: '65-70%', min: 0.65, max: 0.70 },
      { label: '70%+', min: 0.70, max: 1.00 }
    ];

    const matrix = ranges.map(range => {
      const games = enhancedState.allPredictions.filter(p => {
        const prob = p.probs?.blended ?? p.forecast;
        const normProb = Math.max(prob, 1 - prob);
        return normProb >= range.min && normProb < range.max && p.outcome;
      });

      let correct = 0;
      games.forEach(p => {
        const prob = p.probs?.blended ?? p.forecast;
        const actual = p.outcome === 'home' ? 1 : 0;
        if ((prob >= 0.5 && actual === 1) || (prob < 0.5 && actual === 0)) {
          correct++;
        }
      });

      const accuracy = games.length > 0 ? correct / games.length : null;
      return { range: range.label, accuracy, games: games.length };
    });

    container.innerHTML = `
      <table class="matrix-table">
        <thead>
          <tr>
            <th>Confidence</th>
            <th>Accuracy</th>
            <th>Games</th>
          </tr>
        </thead>
        <tbody>
          ${matrix.map(row => `
            <tr>
              <td>${row.range}</td>
              <td style="background: ${getHeatmapColor(row.accuracy)}">
                ${row.accuracy !== null ? `${(row.accuracy * 100).toFixed(1)}%` : '—'}
              </td>
              <td>${row.games}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function getHeatmapColor(value) {
    if (value === null) return 'transparent';
    const r = value < 0.5 ? 255 : Math.round(255 * (1 - (value - 0.5) * 2));
    const g = value > 0.5 ? 200 : Math.round(200 * value * 2);
    return `rgba(${r}, ${g}, 100, 0.3)`;
  }

  function renderPredictiveMetrics() {
    const container = document.getElementById('predictive-metrics-container');
    if (!container || enhancedState.allPredictions.length === 0) return;

    const modelKeys = ['blended', 'logistic', 'tree', 'ann'];
    const metrics = {};

    modelKeys.forEach(modelKey => {
      const predData = enhancedState.allPredictions
        .filter(p => p.probs?.[modelKey] !== undefined && p.outcome)
        .map(p => ({
          predicted: p.probs[modelKey],
          actual: p.outcome === 'home' ? 1 : 0
        }));

      if (predData.length === 0) return;

      const brier = Calculations.brierDecomposition(predData);
      const ece = Calculations.expectedCalibrationError(predData);
      const mcc = Calculations.matthewsCorrelation(predData);

      const accuracy = predData.filter(p =>
        (p.predicted >= 0.5 && p.actual === 1) ||
        (p.predicted < 0.5 && p.actual === 0)
      ).length / predData.length;

      metrics[modelKey] = { accuracy, brierScore: brier.brier, ece, mcc, n: predData.length };
    });

    container.innerHTML = `
      <div class="metrics-table-wrapper">
        <table class="metrics-table">
          <thead>
            <tr>
              <th>Metric</th>
              ${modelKeys.map(k => `<th>${k}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="metric-name">Accuracy</td>
              ${modelKeys.map(k => `<td>${metrics[k] ? `${(metrics[k].accuracy * 100).toFixed(1)}%` : '—'}</td>`).join('')}
            </tr>
            <tr>
              <td class="metric-name">Brier Score</td>
              ${modelKeys.map(k => `<td>${metrics[k] ? metrics[k].brierScore.toFixed(3) : '—'}</td>`).join('')}
            </tr>
            <tr>
              <td class="metric-name">ECE</td>
              ${modelKeys.map(k => `<td>${metrics[k] ? `${(metrics[k].ece * 100).toFixed(1)}%` : '—'}</td>`).join('')}
            </tr>
            <tr>
              <td class="metric-name">MCC</td>
              ${modelKeys.map(k => `<td>${metrics[k] ? metrics[k].mcc.toFixed(3) : '—'}</td>`).join('')}
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }

  // ===== BETTING TAB =====

  async function loadBettingData() {
    if (enhancedState.allPredictions.length === 0) {
      await loadSeasonPredictions();
    }

    if (enhancedState.allPredictions.length === 0) return;

    renderROIDashboard();
    renderBetHistory();
    updateRiskMetrics();
  }

  function renderROIDashboard() {
    const roiData = DataTransformers.toROIData(enhancedState.allPredictions, 'blended');

    // Summary cards
    const cardsContainer = document.getElementById('roi-summary-cards');
    if (cardsContainer) {
      const best = roiData.reduce((b, d) => d.roi > b.roi ? d : b, roiData[0]);

      cardsContainer.innerHTML = `
        <div class="roi-card roi-card-${best.roi >= 0 ? 'success' : 'danger'}">
          <div class="roi-card-title">Best ROI</div>
          <div class="roi-card-value">${best.roi.toFixed(1)}%</div>
          <div class="roi-card-subtitle">@ ${(best.threshold * 100).toFixed(0)}% conf.</div>
        </div>
        <div class="roi-card roi-card-${best.winRate >= 0.52 ? 'success' : 'warning'}">
          <div class="roi-card-title">Win Rate</div>
          <div class="roi-card-value">${(best.winRate * 100).toFixed(1)}%</div>
          <div class="roi-card-subtitle">${best.wins}/${best.bets} bets</div>
        </div>
        <div class="roi-card roi-card-${best.profit >= 0 ? 'success' : 'danger'}">
          <div class="roi-card-title">Profit</div>
          <div class="roi-card-value">$${best.profit.toFixed(0)}</div>
          <div class="roi-card-subtitle">from $1000</div>
        </div>
      `;
    }

    // ROI Chart
    const roiCanvas = document.getElementById('roi-threshold-chart');
    if (roiCanvas) {
      if (enhancedState.charts.roi) {
        enhancedState.charts.roi.destroy();
      }

      const ctx = roiCanvas.getContext('2d');
      enhancedState.charts.roi = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: roiData.map(d => `${(d.threshold * 100).toFixed(0)}%`),
          datasets: [{
            label: 'ROI %',
            data: roiData.map(d => d.roi),
            backgroundColor: roiData.map(d => d.roi >= 0 ? COLORS.success : COLORS.danger)
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: { display: true, text: 'ROI by Confidence Threshold' }
          },
          scales: {
            y: {
              ticks: { callback: v => `${v.toFixed(0)}%` }
            }
          }
        }
      });
    }

    // Bankroll Chart
    const bankrollCanvas = document.getElementById('bankroll-chart');
    if (bankrollCanvas) {
      if (enhancedState.charts.bankroll) {
        enhancedState.charts.bankroll.destroy();
      }

      const best = roiData.reduce((b, d) => d.roi > b.roi ? d : b, roiData[0]);
      const ctx = bankrollCanvas.getContext('2d');

      enhancedState.charts.bankroll = new Chart(ctx, {
        type: 'line',
        data: {
          labels: best.bankroll.map((_, i) => i),
          datasets: [{
            label: 'Bankroll',
            data: best.bankroll,
            borderColor: COLORS.info,
            backgroundColor: `${COLORS.info}20`,
            fill: true,
            tension: 0.1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: { display: true, text: 'Bankroll Progression' }
          },
          scales: {
            y: {
              ticks: { callback: v => `$${v.toFixed(0)}` }
            }
          }
        }
      });
    }
  }

  function renderBetHistory() {
    const container = document.getElementById('bet-history-container');
    if (!container) return;

    const threshold = 0.55;
    const bets = [];

    enhancedState.allPredictions.forEach(p => {
      const prob = p.probs?.blended ?? p.forecast;
      const actual = p.outcome === 'home' ? 1 : (p.outcome === 'away' ? 0 : null);
      if (actual === null) return;

      if (prob >= threshold || prob <= (1 - threshold)) {
        const betOnHome = prob >= threshold;
        const won = (betOnHome && actual === 1) || (!betOnHome && actual === 0);
        bets.push({
          home: p.home_team,
          away: p.away_team,
          pick: betOnHome ? p.home_team : p.away_team,
          won,
          profit: won ? 91 : -100
        });
      }
    });

    container.innerHTML = `
      <div class="bet-history-table-wrapper">
        <table class="bet-history-table">
          <thead>
            <tr>
              <th>Game</th>
              <th>Pick</th>
              <th>Result</th>
              <th>P/L</th>
            </tr>
          </thead>
          <tbody>
            ${bets.slice(-20).reverse().map(bet => `
              <tr class="bet-${bet.won ? 'win' : 'loss'}">
                <td>${bet.away} @ ${bet.home}</td>
                <td>${bet.pick}</td>
                <td>${bet.won ? 'W' : 'L'}</td>
                <td class="${bet.profit >= 0 ? 'positive' : 'negative'}">
                  ${bet.profit >= 0 ? '+' : ''}$${bet.profit}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function updateRiskMetrics() {
    const roiData = DataTransformers.toROIData(enhancedState.allPredictions, 'blended');
    const best = roiData.reduce((b, d) => d.roi > b.roi ? d : b, roiData[0]);

    // Calculate max drawdown
    let maxDrawdown = 0;
    let peak = 1000;
    best.bankroll.forEach(value => {
      if (value > peak) peak = value;
      const drawdown = (peak - value) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    });

    const sharpeEl = document.getElementById('sharpe-ratio');
    const drawdownEl = document.getElementById('max-drawdown');
    const winRateEl = document.getElementById('win-rate');

    if (sharpeEl) sharpeEl.textContent = (best.roi / 10).toFixed(2);
    if (drawdownEl) drawdownEl.textContent = `${(maxDrawdown * 100).toFixed(1)}%`;
    if (winRateEl) winRateEl.textContent = `${(best.winRate * 100).toFixed(1)}%`;
  }

  // ===== TAB HANDLING =====

  function handleTabChange(tabId) {
    // Show/hide tab panels
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.hidden = panel.id !== tabId;
    });

    // Update tab buttons
    document.querySelectorAll('.tab').forEach(tab => {
      const isActive = tab.getAttribute('aria-controls') === tabId;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive);
    });

    // Load data for specific tabs
    if (tabId === 'tab-analytics' && !enhancedState.analyticsLoaded) {
      loadAnalyticsData();
      enhancedState.analyticsLoaded = true;
    }

    if (tabId === 'tab-betting' && !enhancedState.bettingLoaded) {
      loadBettingData();
      enhancedState.bettingLoaded = true;
    }
  }

  // ===== INITIALIZATION =====

  function init() {
    console.log('Initializing enhanced NFL analytics platform...');

    // Bind tab clicks
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabId = e.target.getAttribute('aria-controls');
        handleTabChange(tabId);
      });
    });

    // Bind calibration model selector
    const calModelSelect = document.getElementById('calibration-model-select');
    calModelSelect?.addEventListener('change', () => {
      renderCalibrationPlot();
    });

    // Bind ROI model selector
    const roiModelSelect = document.getElementById('roi-model-select');
    roiModelSelect?.addEventListener('change', () => {
      renderROIDashboard();
      updateRiskMetrics();
    });

    // Wait for main app data then render smart cards
    const checkData = setInterval(() => {
      if (window.state?.predictions && window.state.predictions.length > 0) {
        clearInterval(checkData);
        renderSmartCards();
        enhancedState.isInitialized = true;
        console.log('Enhanced analytics platform ready');
      }
    }, 500);

    // Also update on data changes
    const originalLoadWeekContext = window.loadWeekContext;
    if (originalLoadWeekContext) {
      window.loadWeekContext = async function(...args) {
        await originalLoadWeekContext.apply(this, args);
        renderSmartCards();
        enhancedState.analyticsLoaded = false;
        enhancedState.bettingLoaded = false;
        enhancedState.allPredictions = [];
      };
    }
  }

  // Start initialization when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }

  // Export for debugging
  window.enhancedState = enhancedState;

})();
