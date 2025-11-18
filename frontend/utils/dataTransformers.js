/**
 * NFL Analytics Platform - Data Transformers
 * Functions to transform raw data into visualization-ready formats
 */

export const DataTransformers = {
  /**
   * Transform predictions data for calibration plot
   * @param {Array} predictions - Raw predictions array
   * @param {string} modelKey - Model to analyze
   * @returns {Object} Calibration data with bins
   */
  toCalibrationData(predictions, modelKey = 'blended') {
    const numBins = 10;
    const bins = Array.from({ length: numBins }, (_, i) => ({
      binStart: i / numBins,
      binEnd: (i + 1) / numBins,
      binMid: (i + 0.5) / numBins,
      count: 0,
      actualWins: 0,
      avgPredicted: 0,
      predictions: []
    }));

    predictions.forEach(p => {
      const prob = p.probs?.[modelKey] ?? p.forecast;
      const actual = p.outcome === 'home' ? 1 : (p.outcome === 'away' ? 0 : null);

      if (actual === null || typeof prob !== 'number') return;

      const binIndex = Math.min(Math.floor(prob * numBins), numBins - 1);
      bins[binIndex].count++;
      bins[binIndex].actualWins += actual;
      bins[binIndex].avgPredicted += prob;
      bins[binIndex].predictions.push({ prob, actual, game: p });
    });

    // Calculate averages
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

  /**
   * Transform season metrics for accuracy tracker
   * @param {Object} seasonMetrics - Season metrics with weekly data
   * @returns {Object} Formatted data for line chart
   */
  toSeasonAccuracyData(seasonMetrics) {
    if (!seasonMetrics?.weeks) return null;

    const weeks = seasonMetrics.weeks.map(w => `Week ${w.week}`);
    const models = {};

    // Initialize model data
    seasonMetrics.weeks.forEach((week, index) => {
      if (!week.per_model) return;

      Object.entries(week.per_model).forEach(([modelKey, metrics]) => {
        if (!models[modelKey]) {
          models[modelKey] = {
            weekly: [],
            cumulative: [],
            totalCorrect: 0,
            totalGames: 0
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

  /**
   * Transform predictions for ROI analysis
   * @param {Array} predictions - All predictions with outcomes
   * @param {string} modelKey - Model to analyze
   * @returns {Object} ROI data by threshold
   */
  toROIData(predictions, modelKey = 'blended') {
    const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75];
    const results = thresholds.map(threshold => {
      let profit = 0;
      let bets = 0;
      let wins = 0;
      let bankroll = [1000];

      predictions.forEach(p => {
        const prob = p.probs?.[modelKey] ?? p.forecast;
        const actual = p.outcome === 'home' ? 1 : (p.outcome === 'away' ? 0 : null);

        if (actual === null) return;

        // Bet if confidence exceeds threshold
        if (prob >= threshold || prob <= (1 - threshold)) {
          const betOnHome = prob >= threshold;
          const won = (betOnHome && actual === 1) || (!betOnHome && actual === 0);
          const betSize = 100;

          bets++;
          if (won) {
            profit += betSize * 0.91; // Standard -110 odds
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
        profit,
        bets,
        wins,
        winRate: bets > 0 ? wins / bets : 0,
        bankroll
      };
    });

    return results;
  },

  /**
   * Transform data for team performance matrix
   * @param {Array} allPredictions - All historical predictions
   * @param {string} modelKey - Model to analyze
   * @returns {Object} Matrix data {teams, matrix}
   */
  toTeamPerformanceMatrix(allPredictions, modelKey = 'blended') {
    const teamStats = {};

    allPredictions.forEach(p => {
      const homeTeam = p.home_team;
      const awayTeam = p.away_team;
      const prob = p.probs?.[modelKey] ?? p.forecast;
      const actual = p.outcome === 'home' ? 1 : (p.outcome === 'away' ? 0 : null);

      if (actual === null) return;

      // Initialize teams
      [homeTeam, awayTeam].forEach(team => {
        if (!teamStats[team]) {
          teamStats[team] = {
            homeCorrect: 0, homeTotal: 0,
            awayCorrect: 0, awayTotal: 0,
            vsTeams: {}
          };
        }
      });

      // Track home team stats
      const homeCorrect = (prob >= 0.5 && actual === 1) || (prob < 0.5 && actual === 0);
      teamStats[homeTeam].homeTotal++;
      if (homeCorrect) teamStats[homeTeam].homeCorrect++;

      // Track away team stats
      const awayCorrect = (prob < 0.5 && actual === 0) || (prob >= 0.5 && actual === 1);
      teamStats[awayTeam].awayTotal++;
      if (awayCorrect) teamStats[awayTeam].awayCorrect++;

      // Track head-to-head
      if (!teamStats[homeTeam].vsTeams[awayTeam]) {
        teamStats[homeTeam].vsTeams[awayTeam] = { correct: 0, total: 0 };
      }
      teamStats[homeTeam].vsTeams[awayTeam].total++;
      if (homeCorrect) teamStats[homeTeam].vsTeams[awayTeam].correct++;
    });

    const teams = Object.keys(teamStats).sort();

    return { teams, teamStats };
  },

  /**
   * Transform predictions for win probability timeline
   * @param {Array} predictions - Predictions with timestamps
   * @returns {Object} Timeline data
   */
  toWinProbabilityTimeline(predictions) {
    return predictions.map(p => ({
      gameId: p.game_id,
      home: p.home_team,
      away: p.away_team,
      timestamp: p.game_datetime || p.week,
      probability: p.probs?.blended ?? p.forecast,
      confidence: p.confidence_interval || { low: 0.4, high: 0.6 },
      actual: p.outcome
    }));
  },

  /**
   * Aggregate predictions by various dimensions
   * @param {Array} predictions - All predictions
   * @param {string} dimension - Aggregation dimension
   * @returns {Object} Aggregated stats
   */
  aggregateByDimension(predictions, dimension) {
    const groups = {};

    predictions.forEach(p => {
      let key;
      switch (dimension) {
        case 'week':
          key = `Week ${p.week}`;
          break;
        case 'division':
          key = this.isDivisionGame(p) ? 'Division' : 'Non-Division';
          break;
        case 'primetime':
          key = this.isPrimetimeGame(p) ? 'Primetime' : 'Regular';
          break;
        case 'spread':
          const spread = Math.abs(0.5 - (p.probs?.blended ?? p.forecast)) * 100;
          key = spread < 5 ? 'Close (<5)' : spread < 15 ? 'Medium (5-15)' : 'Large (>15)';
          break;
        default:
          key = 'all';
      }

      if (!groups[key]) {
        groups[key] = { correct: 0, total: 0, predictions: [] };
      }

      const prob = p.probs?.blended ?? p.forecast;
      const actual = p.outcome === 'home' ? 1 : (p.outcome === 'away' ? 0 : null);

      if (actual !== null) {
        groups[key].total++;
        if ((prob >= 0.5 && actual === 1) || (prob < 0.5 && actual === 0)) {
          groups[key].correct++;
        }
        groups[key].predictions.push(p);
      }
    });

    // Calculate accuracy for each group
    Object.values(groups).forEach(group => {
      group.accuracy = group.total > 0 ? group.correct / group.total : 0;
    });

    return groups;
  },

  /**
   * Check if game is division matchup
   */
  isDivisionGame(prediction) {
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
      if (teams.includes(prediction.home_team) && teams.includes(prediction.away_team)) {
        return true;
      }
    }
    return false;
  },

  /**
   * Check if game is primetime (placeholder - would need actual game time)
   */
  isPrimetimeGame(prediction) {
    // This would need actual game datetime
    // For now, approximate based on week patterns
    return false;
  },

  /**
   * Transform feature drivers for impact visualization
   * @param {Array} drivers - Top drivers array
   * @returns {Object} Formatted for radar/bar charts
   */
  toFeatureImpactData(drivers) {
    if (!drivers || !Array.isArray(drivers)) return { labels: [], values: [], directions: [] };

    return {
      labels: drivers.map(d => d.feature || d.name),
      values: drivers.map(d => Math.abs(d.magnitude || d.value || 0)),
      directions: drivers.map(d => d.direction || (d.magnitude >= 0 ? 'positive' : 'negative')),
      sources: drivers.map(d => d.source || 'unknown')
    };
  },

  /**
   * Calculate smart card metrics
   * @param {Array} predictions - Current week predictions
   * @param {Object} metrics - Week metrics
   * @returns {Object} Smart card data
   */
  toSmartCardData(predictions, metrics) {
    if (!predictions || predictions.length === 0) {
      return {
        bestBets: [],
        upsetAlerts: [],
        consensus: 0,
        avgConfidence: 0
      };
    }

    // Best bets (highest confidence)
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

    // Upset alerts (high disagreement between models)
    const upsetAlerts = predictions
      .filter(p => {
        if (!p.probs) return false;
        const probs = Object.values(p.probs).filter(v => typeof v === 'number');
        const max = Math.max(...probs);
        const min = Math.min(...probs);
        return (max - min) > 0.3; // High variance
      })
      .slice(0, 3)
      .map(p => ({
        game: `${p.away_team} @ ${p.home_team}`,
        variance: p.diagnostics?.variance || 0
      }));

    // Model consensus (average agreement)
    let consensusSum = 0;
    predictions.forEach(p => {
      if (!p.probs) return;
      const probs = Object.values(p.probs).filter(v => typeof v === 'number');
      const allAgree = probs.every(prob => (prob >= 0.5) === (probs[0] >= 0.5));
      if (allAgree) consensusSum++;
    });
    const consensus = predictions.length > 0 ? (consensusSum / predictions.length) * 100 : 0;

    // Average confidence
    const avgConfidence = predictions.reduce((sum, p) => {
      return sum + Math.abs(0.5 - (p.probs?.blended ?? p.forecast)) * 200;
    }, 0) / predictions.length;

    return { bestBets, upsetAlerts, consensus, avgConfidence };
  },

  /**
   * Transform for exportable CSV format
   * @param {Array} predictions - Predictions to export
   * @returns {string} CSV string
   */
  toCSV(predictions) {
    if (!predictions || predictions.length === 0) return '';

    const headers = [
      'Game ID', 'Home Team', 'Away Team', 'Season', 'Week',
      'Blended Prob', 'Outcome', 'Correct'
    ];

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
        (prob * 100).toFixed(1) + '%',
        p.outcome || '',
        correct
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }
};

export default DataTransformers;
