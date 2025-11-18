/**
 * Performance Matrix Component
 * Heatmap showing model accuracy by team matchups and various dimensions
 */

import { ChartHelpers, MODEL_COLORS, COLORS } from '../../utils/chartHelpers.js';
import { DataTransformers } from '../../utils/dataTransformers.js';

export class PerformanceMatrix {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.data = null;
    this.options = {
      modelKey: 'blended',
      dimension: 'team', // 'team', 'division', 'spread', 'home_away'
      colorScheme: 'accuracy',
      ...options
    };
  }

  /**
   * Load predictions and build matrix
   * @param {Array} predictions - All predictions with outcomes
   */
  async loadData(predictions) {
    this.predictions = predictions.filter(p => p.outcome);
    this.buildMatrix();
    this.render();
  }

  /**
   * Build performance matrix based on selected dimension
   */
  buildMatrix() {
    switch (this.options.dimension) {
      case 'team':
        this.data = this.buildTeamMatrix();
        break;
      case 'division':
        this.data = this.buildDivisionMatrix();
        break;
      case 'spread':
        this.data = this.buildSpreadMatrix();
        break;
      case 'home_away':
        this.data = this.buildHomeAwayMatrix();
        break;
      default:
        this.data = this.buildTeamMatrix();
    }
  }

  /**
   * Build team vs team accuracy matrix
   */
  buildTeamMatrix() {
    const { teams, teamStats } = DataTransformers.toTeamPerformanceMatrix(
      this.predictions,
      this.options.modelKey
    );

    // Create summary by team
    const matrix = teams.map(team => {
      const stats = teamStats[team];
      const homeAcc = stats.homeTotal > 0 ? stats.homeCorrect / stats.homeTotal : null;
      const awayAcc = stats.awayTotal > 0 ? stats.awayCorrect / stats.awayTotal : null;
      const totalCorrect = stats.homeCorrect + stats.awayCorrect;
      const totalGames = stats.homeTotal + stats.awayTotal;
      const overall = totalGames > 0 ? totalCorrect / totalGames : null;

      return {
        team,
        home: homeAcc,
        away: awayAcc,
        overall,
        games: totalGames
      };
    });

    return {
      type: 'team',
      rows: matrix.sort((a, b) => (b.overall || 0) - (a.overall || 0)),
      columns: ['Team', 'Home', 'Away', 'Overall', 'Games']
    };
  }

  /**
   * Build division performance matrix
   */
  buildDivisionMatrix() {
    const divisions = {
      'AFC East': ['BUF', 'MIA', 'NE', 'NYJ'],
      'AFC North': ['BAL', 'CIN', 'CLE', 'PIT'],
      'AFC South': ['HOU', 'IND', 'JAX', 'TEN'],
      'AFC West': ['DEN', 'KC', 'LV', 'LAC'],
      'NFC East': ['DAL', 'NYG', 'PHI', 'WAS'],
      'NFC North': ['CHI', 'DET', 'GB', 'MIN'],
      'NFC South': ['ATL', 'CAR', 'NO', 'TB'],
      'NFC West': ['ARI', 'LAR', 'SF', 'SEA']
    };

    const divisionStats = {};

    // Initialize divisions
    Object.keys(divisions).forEach(div => {
      divisionStats[div] = {
        intra: { correct: 0, total: 0 },
        inter: { correct: 0, total: 0 },
        vsAFC: { correct: 0, total: 0 },
        vsNFC: { correct: 0, total: 0 }
      };
    });

    // Calculate stats
    this.predictions.forEach(p => {
      const prob = p.probs?.[this.options.modelKey] ?? p.forecast;
      const actual = p.outcome === 'home' ? 1 : 0;
      const correct = (prob >= 0.5 && actual === 1) || (prob < 0.5 && actual === 0);

      const homeDiv = this.getTeamDivision(p.home_team, divisions);
      const awayDiv = this.getTeamDivision(p.away_team, divisions);

      if (!homeDiv || !awayDiv) return;

      // Track for home team's division
      if (homeDiv === awayDiv) {
        divisionStats[homeDiv].intra.total++;
        if (correct) divisionStats[homeDiv].intra.correct++;
      } else {
        divisionStats[homeDiv].inter.total++;
        if (correct) divisionStats[homeDiv].inter.correct++;

        // Track conference matchups
        const homeConf = homeDiv.startsWith('AFC') ? 'AFC' : 'NFC';
        const awayConf = awayDiv.startsWith('AFC') ? 'AFC' : 'NFC';

        if (awayConf === 'AFC') {
          divisionStats[homeDiv].vsAFC.total++;
          if (correct) divisionStats[homeDiv].vsAFC.correct++;
        } else {
          divisionStats[homeDiv].vsNFC.total++;
          if (correct) divisionStats[homeDiv].vsNFC.correct++;
        }
      }
    });

    const matrix = Object.entries(divisionStats).map(([div, stats]) => ({
      division: div,
      intra: stats.intra.total > 0 ? stats.intra.correct / stats.intra.total : null,
      inter: stats.inter.total > 0 ? stats.inter.correct / stats.inter.total : null,
      vsAFC: stats.vsAFC.total > 0 ? stats.vsAFC.correct / stats.vsAFC.total : null,
      vsNFC: stats.vsNFC.total > 0 ? stats.vsNFC.correct / stats.vsNFC.total : null,
      games: stats.intra.total + stats.inter.total
    }));

    return {
      type: 'division',
      rows: matrix,
      columns: ['Division', 'Intra-Div', 'Inter-Div', 'vs AFC', 'vs NFC', 'Games']
    };
  }

  /**
   * Build spread range performance matrix
   */
  buildSpreadMatrix() {
    const spreadRanges = [
      { label: 'Toss-up (50-52%)', min: 0.50, max: 0.52 },
      { label: 'Slight (52-55%)', min: 0.52, max: 0.55 },
      { label: 'Moderate (55-60%)', min: 0.55, max: 0.60 },
      { label: 'Strong (60-65%)', min: 0.60, max: 0.65 },
      { label: 'Heavy (65-70%)', min: 0.65, max: 0.70 },
      { label: 'Lock (>70%)', min: 0.70, max: 1.00 }
    ];

    const matrix = spreadRanges.map(range => {
      const gamesInRange = this.predictions.filter(p => {
        const prob = p.probs?.[this.options.modelKey] ?? p.forecast;
        const normProb = Math.max(prob, 1 - prob); // Normalize to 50-100%
        return normProb >= range.min && normProb < range.max;
      });

      let correct = 0;
      gamesInRange.forEach(p => {
        const prob = p.probs?.[this.options.modelKey] ?? p.forecast;
        const actual = p.outcome === 'home' ? 1 : 0;
        if ((prob >= 0.5 && actual === 1) || (prob < 0.5 && actual === 0)) {
          correct++;
        }
      });

      const accuracy = gamesInRange.length > 0 ? correct / gamesInRange.length : null;
      const expectedAcc = (range.min + range.max) / 2;

      return {
        range: range.label,
        accuracy,
        expected: expectedAcc,
        delta: accuracy !== null ? accuracy - expectedAcc : null,
        games: gamesInRange.length
      };
    });

    return {
      type: 'spread',
      rows: matrix,
      columns: ['Confidence Range', 'Actual', 'Expected', 'Delta', 'Games']
    };
  }

  /**
   * Build home/away performance matrix
   */
  buildHomeAwayMatrix() {
    const scenarios = [
      { label: 'Home Favorite', filter: p => (p.probs?.[this.options.modelKey] ?? p.forecast) >= 0.5 },
      { label: 'Away Favorite', filter: p => (p.probs?.[this.options.modelKey] ?? p.forecast) < 0.5 },
      { label: 'Division Game', filter: p => DataTransformers.isDivisionGame(p) },
      { label: 'Non-Division', filter: p => !DataTransformers.isDivisionGame(p) }
    ];

    const matrix = scenarios.map(scenario => {
      const games = this.predictions.filter(scenario.filter);
      let correct = 0;

      games.forEach(p => {
        const prob = p.probs?.[this.options.modelKey] ?? p.forecast;
        const actual = p.outcome === 'home' ? 1 : 0;
        if ((prob >= 0.5 && actual === 1) || (prob < 0.5 && actual === 0)) {
          correct++;
        }
      });

      return {
        scenario: scenario.label,
        accuracy: games.length > 0 ? correct / games.length : null,
        correct,
        games: games.length
      };
    });

    return {
      type: 'home_away',
      rows: matrix,
      columns: ['Scenario', 'Accuracy', 'Correct', 'Games']
    };
  }

  /**
   * Get team's division
   */
  getTeamDivision(team, divisions) {
    for (const [div, teams] of Object.entries(divisions)) {
      if (teams.includes(team)) return div;
    }
    return null;
  }

  /**
   * Render the performance matrix
   */
  render() {
    if (!this.container || !this.data) return;

    const html = `
      <div class="performance-matrix">
        <div class="matrix-controls">
          <select id="matrix-dimension" class="matrix-select">
            <option value="team" ${this.options.dimension === 'team' ? 'selected' : ''}>By Team</option>
            <option value="division" ${this.options.dimension === 'division' ? 'selected' : ''}>By Division</option>
            <option value="spread" ${this.options.dimension === 'spread' ? 'selected' : ''}>By Confidence</option>
            <option value="home_away" ${this.options.dimension === 'home_away' ? 'selected' : ''}>By Scenario</option>
          </select>
        </div>
        <div class="matrix-table-wrapper">
          ${this.renderTable()}
        </div>
        <div class="matrix-legend">
          ${this.renderLegend()}
        </div>
      </div>
    `;

    this.container.innerHTML = html;

    // Bind dimension selector
    const selector = this.container.querySelector('#matrix-dimension');
    if (selector) {
      selector.addEventListener('change', (e) => {
        this.options.dimension = e.target.value;
        this.buildMatrix();
        this.render();
      });
    }
  }

  /**
   * Render matrix table
   */
  renderTable() {
    const { rows, columns } = this.data;

    return `
      <table class="matrix-table">
        <thead>
          <tr>
            ${columns.map(col => `<th>${col}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => this.renderRow(row)).join('')}
        </tbody>
      </table>
    `;
  }

  /**
   * Render single row based on matrix type
   */
  renderRow(row) {
    switch (this.data.type) {
      case 'team':
        return `
          <tr>
            <td class="team-cell">${row.team}</td>
            <td style="background: ${this.getCellColor(row.home)}">${this.formatCell(row.home)}</td>
            <td style="background: ${this.getCellColor(row.away)}">${this.formatCell(row.away)}</td>
            <td style="background: ${this.getCellColor(row.overall)}; font-weight: bold">${this.formatCell(row.overall)}</td>
            <td>${row.games}</td>
          </tr>
        `;

      case 'division':
        return `
          <tr>
            <td class="division-cell">${row.division}</td>
            <td style="background: ${this.getCellColor(row.intra)}">${this.formatCell(row.intra)}</td>
            <td style="background: ${this.getCellColor(row.inter)}">${this.formatCell(row.inter)}</td>
            <td style="background: ${this.getCellColor(row.vsAFC)}">${this.formatCell(row.vsAFC)}</td>
            <td style="background: ${this.getCellColor(row.vsNFC)}">${this.formatCell(row.vsNFC)}</td>
            <td>${row.games}</td>
          </tr>
        `;

      case 'spread':
        return `
          <tr>
            <td>${row.range}</td>
            <td style="background: ${this.getCellColor(row.accuracy)}">${this.formatCell(row.accuracy)}</td>
            <td>${this.formatCell(row.expected)}</td>
            <td class="${row.delta >= 0 ? 'positive' : 'negative'}">${row.delta !== null ? (row.delta >= 0 ? '+' : '') + (row.delta * 100).toFixed(1) + '%' : '—'}</td>
            <td>${row.games}</td>
          </tr>
        `;

      case 'home_away':
        return `
          <tr>
            <td>${row.scenario}</td>
            <td style="background: ${this.getCellColor(row.accuracy)}">${this.formatCell(row.accuracy)}</td>
            <td>${row.correct}</td>
            <td>${row.games}</td>
          </tr>
        `;

      default:
        return '';
    }
  }

  /**
   * Format cell value as percentage
   */
  formatCell(value) {
    if (value === null || value === undefined) return '—';
    return `${(value * 100).toFixed(1)}%`;
  }

  /**
   * Get cell background color based on value
   */
  getCellColor(value) {
    if (value === null || value === undefined) return 'transparent';
    return ChartHelpers.heatmapColor(value, this.options.colorScheme);
  }

  /**
   * Render color legend
   */
  renderLegend() {
    const stops = [0.4, 0.5, 0.6, 0.7, 0.8];
    return `
      <div class="legend-bar">
        ${stops.map(v => `
          <span class="legend-stop" style="background: ${this.getCellColor(v)}">
            ${(v * 100).toFixed(0)}%
          </span>
        `).join('')}
      </div>
      <div class="legend-labels">
        <span>Poor</span>
        <span>Excellent</span>
      </div>
    `;
  }

  /**
   * Update dimension
   */
  setDimension(dimension) {
    this.options.dimension = dimension;
    this.buildMatrix();
    this.render();
  }

  /**
   * Update model
   */
  setModel(modelKey) {
    this.options.modelKey = modelKey;
    this.buildMatrix();
    this.render();
  }

  /**
   * Export matrix data
   */
  exportData() {
    const { rows, columns } = this.data;
    const csvRows = [columns.join(',')];

    rows.forEach(row => {
      const values = [];
      switch (this.data.type) {
        case 'team':
          values.push(row.team, this.formatCell(row.home), this.formatCell(row.away),
            this.formatCell(row.overall), row.games);
          break;
        case 'division':
          values.push(row.division, this.formatCell(row.intra), this.formatCell(row.inter),
            this.formatCell(row.vsAFC), this.formatCell(row.vsNFC), row.games);
          break;
        case 'spread':
          values.push(row.range, this.formatCell(row.accuracy), this.formatCell(row.expected),
            row.delta !== null ? (row.delta * 100).toFixed(1) + '%' : '', row.games);
          break;
        case 'home_away':
          values.push(row.scenario, this.formatCell(row.accuracy), row.correct, row.games);
          break;
      }
      csvRows.push(values.join(','));
    });

    return csvRows.join('\n');
  }
}

export default PerformanceMatrix;
