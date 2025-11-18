/**
 * Advanced Filters Component
 * Multi-dimensional filtering system for predictions
 */

export class AdvancedFilters {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.filters = {
      dateRange: { start: null, end: null },
      teams: [],
      divisions: [],
      conferences: [],
      gameType: 'all', // 'all', 'division', 'conference', 'inter-conference'
      confidence: { min: 0, max: 100 },
      outcome: 'all', // 'all', 'correct', 'incorrect', 'pending'
      models: []
    };
    this.options = {
      onFilterChange: () => {},
      availableTeams: [],
      availableWeeks: [],
      ...options
    };
    this.collapsed = false;
  }

  /**
   * Initialize and render filters
   */
  init() {
    this.render();
    this.bindEvents();
  }

  /**
   * Render the filter panel
   */
  render() {
    if (!this.container) return;

    const html = `
      <div class="advanced-filters ${this.collapsed ? 'collapsed' : ''}">
        <div class="filters-header">
          <h3>Advanced Filters</h3>
          <button class="toggle-filters" aria-label="Toggle filters">
            <span class="toggle-icon">${this.collapsed ? '▼' : '▲'}</span>
          </button>
        </div>

        <div class="filters-body">
          <div class="filter-row">
            <!-- Date Range -->
            <div class="filter-group">
              <label>Week Range</label>
              <div class="range-inputs">
                <select id="filter-week-start" class="filter-select">
                  <option value="">Start</option>
                  ${this.options.availableWeeks.map(w =>
                    `<option value="${w}">Week ${w}</option>`
                  ).join('')}
                </select>
                <span class="range-separator">to</span>
                <select id="filter-week-end" class="filter-select">
                  <option value="">End</option>
                  ${this.options.availableWeeks.map(w =>
                    `<option value="${w}">Week ${w}</option>`
                  ).join('')}
                </select>
              </div>
            </div>

            <!-- Team Selection -->
            <div class="filter-group">
              <label>Teams</label>
              <div class="team-select-wrapper">
                <input type="text" id="filter-team-search"
                  placeholder="Search teams..."
                  class="filter-input">
                <div class="team-dropdown" id="team-dropdown">
                  ${this.renderTeamOptions()}
                </div>
              </div>
              <div class="selected-teams" id="selected-teams">
                ${this.filters.teams.map(t => `
                  <span class="team-tag">${t}
                    <button class="remove-team" data-team="${t}">&times;</button>
                  </span>
                `).join('')}
              </div>
            </div>
          </div>

          <div class="filter-row">
            <!-- Division/Conference -->
            <div class="filter-group">
              <label>Game Type</label>
              <select id="filter-game-type" class="filter-select">
                <option value="all">All Games</option>
                <option value="division">Division Only</option>
                <option value="conference">Same Conference</option>
                <option value="inter-conference">Inter-Conference</option>
              </select>
            </div>

            <!-- Confidence Range -->
            <div class="filter-group">
              <label>Confidence Range</label>
              <div class="confidence-slider">
                <input type="range" id="filter-conf-min"
                  min="50" max="100" value="50" step="5">
                <span id="conf-min-value">50%</span>
                <span class="range-separator">-</span>
                <input type="range" id="filter-conf-max"
                  min="50" max="100" value="100" step="5">
                <span id="conf-max-value">100%</span>
              </div>
            </div>

            <!-- Outcome -->
            <div class="filter-group">
              <label>Outcome</label>
              <select id="filter-outcome" class="filter-select">
                <option value="all">All</option>
                <option value="correct">Correct</option>
                <option value="incorrect">Incorrect</option>
                <option value="pending">Pending</option>
              </select>
            </div>
          </div>

          <div class="filter-actions">
            <button id="apply-filters" class="btn btn-primary">Apply Filters</button>
            <button id="clear-filters" class="btn btn-secondary">Clear All</button>
            <button id="export-filtered" class="btn btn-outline">Export</button>
          </div>

          <div class="active-filters" id="active-filters">
            ${this.renderActiveFilters()}
          </div>
        </div>
      </div>
    `;

    this.container.innerHTML = html;
  }

  /**
   * Render team selection options
   */
  renderTeamOptions() {
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

    return Object.entries(divisions).map(([div, teams]) => `
      <div class="team-division">
        <div class="division-header">${div}</div>
        ${teams.map(team => `
          <label class="team-option">
            <input type="checkbox" value="${team}"
              ${this.filters.teams.includes(team) ? 'checked' : ''}>
            ${team}
          </label>
        `).join('')}
      </div>
    `).join('');
  }

  /**
   * Render active filter tags
   */
  renderActiveFilters() {
    const tags = [];

    if (this.filters.teams.length > 0) {
      tags.push(`Teams: ${this.filters.teams.join(', ')}`);
    }

    if (this.filters.gameType !== 'all') {
      tags.push(`Type: ${this.filters.gameType}`);
    }

    if (this.filters.confidence.min > 50 || this.filters.confidence.max < 100) {
      tags.push(`Confidence: ${this.filters.confidence.min}-${this.filters.confidence.max}%`);
    }

    if (this.filters.outcome !== 'all') {
      tags.push(`Outcome: ${this.filters.outcome}`);
    }

    if (tags.length === 0) {
      return '<span class="no-filters">No filters applied</span>';
    }

    return tags.map(tag => `
      <span class="filter-tag">${tag}</span>
    `).join('');
  }

  /**
   * Bind event handlers
   */
  bindEvents() {
    // Toggle collapse
    const toggleBtn = this.container.querySelector('.toggle-filters');
    toggleBtn?.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.render();
      this.bindEvents();
    });

    // Team search
    const teamSearch = this.container.querySelector('#filter-team-search');
    const teamDropdown = this.container.querySelector('#team-dropdown');

    teamSearch?.addEventListener('focus', () => {
      teamDropdown?.classList.add('visible');
    });

    teamSearch?.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const options = teamDropdown?.querySelectorAll('.team-option');
      options?.forEach(opt => {
        const team = opt.textContent.trim().toLowerCase();
        opt.style.display = team.includes(query) ? '' : 'none';
      });
    });

    // Team checkbox changes
    teamDropdown?.addEventListener('change', (e) => {
      if (e.target.type === 'checkbox') {
        const team = e.target.value;
        if (e.target.checked) {
          if (!this.filters.teams.includes(team)) {
            this.filters.teams.push(team);
          }
        } else {
          this.filters.teams = this.filters.teams.filter(t => t !== team);
        }
        this.updateSelectedTeams();
      }
    });

    // Remove team tags
    this.container.querySelectorAll('.remove-team').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const team = e.target.dataset.team;
        this.filters.teams = this.filters.teams.filter(t => t !== team);
        this.render();
        this.bindEvents();
      });
    });

    // Game type
    const gameType = this.container.querySelector('#filter-game-type');
    gameType?.addEventListener('change', (e) => {
      this.filters.gameType = e.target.value;
    });

    // Confidence sliders
    const confMin = this.container.querySelector('#filter-conf-min');
    const confMax = this.container.querySelector('#filter-conf-max');

    confMin?.addEventListener('input', (e) => {
      this.filters.confidence.min = parseInt(e.target.value);
      this.container.querySelector('#conf-min-value').textContent = `${e.target.value}%`;
    });

    confMax?.addEventListener('input', (e) => {
      this.filters.confidence.max = parseInt(e.target.value);
      this.container.querySelector('#conf-max-value').textContent = `${e.target.value}%`;
    });

    // Outcome
    const outcome = this.container.querySelector('#filter-outcome');
    outcome?.addEventListener('change', (e) => {
      this.filters.outcome = e.target.value;
    });

    // Apply filters
    this.container.querySelector('#apply-filters')?.addEventListener('click', () => {
      this.applyFilters();
    });

    // Clear filters
    this.container.querySelector('#clear-filters')?.addEventListener('click', () => {
      this.clearFilters();
    });

    // Export
    this.container.querySelector('#export-filtered')?.addEventListener('click', () => {
      this.options.onExport?.();
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!this.container?.contains(e.target)) {
        teamDropdown?.classList.remove('visible');
      }
    });
  }

  /**
   * Update selected teams display
   */
  updateSelectedTeams() {
    const container = this.container.querySelector('#selected-teams');
    if (container) {
      container.innerHTML = this.filters.teams.map(t => `
        <span class="team-tag">${t}
          <button class="remove-team" data-team="${t}">&times;</button>
        </span>
      `).join('');

      // Rebind remove buttons
      container.querySelectorAll('.remove-team').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const team = e.target.dataset.team;
          this.filters.teams = this.filters.teams.filter(t => t !== team);
          this.render();
          this.bindEvents();
        });
      });
    }
  }

  /**
   * Apply filters and notify parent
   */
  applyFilters() {
    this.options.onFilterChange(this.filters);
    this.updateActiveFilters();
  }

  /**
   * Clear all filters
   */
  clearFilters() {
    this.filters = {
      dateRange: { start: null, end: null },
      teams: [],
      divisions: [],
      conferences: [],
      gameType: 'all',
      confidence: { min: 50, max: 100 },
      outcome: 'all',
      models: []
    };
    this.render();
    this.bindEvents();
    this.options.onFilterChange(this.filters);
  }

  /**
   * Update active filters display
   */
  updateActiveFilters() {
    const container = this.container.querySelector('#active-filters');
    if (container) {
      container.innerHTML = this.renderActiveFilters();
    }
  }

  /**
   * Filter predictions based on current filters
   * @param {Array} predictions - All predictions
   * @returns {Array} Filtered predictions
   */
  filterPredictions(predictions) {
    return predictions.filter(p => {
      // Team filter
      if (this.filters.teams.length > 0) {
        if (!this.filters.teams.includes(p.home_team) &&
            !this.filters.teams.includes(p.away_team)) {
          return false;
        }
      }

      // Game type filter
      if (this.filters.gameType !== 'all') {
        const isDivision = this.isDivisionGame(p);
        const isSameConf = this.isSameConference(p);

        if (this.filters.gameType === 'division' && !isDivision) return false;
        if (this.filters.gameType === 'conference' && !isSameConf) return false;
        if (this.filters.gameType === 'inter-conference' && isSameConf) return false;
      }

      // Confidence filter
      const prob = p.probs?.blended ?? p.forecast;
      const confidence = Math.abs(0.5 - prob) * 200;
      if (confidence < this.filters.confidence.min ||
          confidence > this.filters.confidence.max) {
        return false;
      }

      // Outcome filter
      if (this.filters.outcome !== 'all') {
        const actual = p.outcome === 'home' ? 1 : (p.outcome === 'away' ? 0 : null);

        if (this.filters.outcome === 'pending' && actual !== null) return false;
        if (this.filters.outcome === 'correct') {
          if (actual === null) return false;
          const correct = (prob >= 0.5 && actual === 1) || (prob < 0.5 && actual === 0);
          if (!correct) return false;
        }
        if (this.filters.outcome === 'incorrect') {
          if (actual === null) return false;
          const correct = (prob >= 0.5 && actual === 1) || (prob < 0.5 && actual === 0);
          if (correct) return false;
        }
      }

      return true;
    });
  }

  /**
   * Check if game is division matchup
   */
  isDivisionGame(p) {
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

    for (const teams of Object.values(divisions)) {
      if (teams.includes(p.home_team) && teams.includes(p.away_team)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if same conference
   */
  isSameConference(p) {
    const afc = ['BUF', 'MIA', 'NE', 'NYJ', 'BAL', 'CIN', 'CLE', 'PIT',
                 'HOU', 'IND', 'JAX', 'TEN', 'DEN', 'KC', 'LV', 'LAC'];

    const homeAFC = afc.includes(p.home_team);
    const awayAFC = afc.includes(p.away_team);

    return homeAFC === awayAFC;
  }

  /**
   * Get current filter state
   */
  getFilters() {
    return { ...this.filters };
  }

  /**
   * Set filters programmatically
   */
  setFilters(filters) {
    this.filters = { ...this.filters, ...filters };
    this.render();
    this.bindEvents();
  }
}

export default AdvancedFilters;
