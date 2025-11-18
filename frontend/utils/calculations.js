/**
 * NFL Analytics Platform - Statistical Calculations
 * Provides advanced metrics and statistical functions for model evaluation
 */

export const Calculations = {
  /**
   * Calculate Brier Score decomposition (reliability, resolution, uncertainty)
   * @param {Array} predictions - Array of {predicted: 0-1, actual: 0|1}
   * @returns {Object} {brier, reliability, resolution, uncertainty}
   */
  brierDecomposition(predictions) {
    if (!predictions || predictions.length === 0) {
      return { brier: 0, reliability: 0, resolution: 0, uncertainty: 0 };
    }

    const n = predictions.length;
    const baseRate = predictions.reduce((sum, p) => sum + p.actual, 0) / n;
    const uncertainty = baseRate * (1 - baseRate);

    // Group predictions into bins
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

  /**
   * Create probability bins for calibration analysis
   * @param {Array} predictions - Array of predictions
   * @param {number} numBins - Number of bins (default 10)
   * @returns {Array} Bins with count, sumPred, sumActual
   */
  createProbabilityBins(predictions, numBins = 10) {
    const bins = Array.from({ length: numBins }, () => ({
      count: 0,
      sumPred: 0,
      sumActual: 0,
      predictions: []
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

  /**
   * Calculate Expected Calibration Error (ECE)
   * @param {Array} predictions - Array of predictions
   * @param {number} numBins - Number of bins
   * @returns {number} ECE value
   */
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

  /**
   * Calculate Maximum Calibration Error (MCE)
   * @param {Array} predictions - Array of predictions
   * @param {number} numBins - Number of bins
   * @returns {number} MCE value
   */
  maxCalibrationError(predictions, numBins = 10) {
    const bins = this.createProbabilityBins(predictions, numBins);

    return bins.reduce((mce, bin) => {
      if (bin.count === 0) return mce;
      const avgPred = bin.sumPred / bin.count;
      const avgActual = bin.sumActual / bin.count;
      return Math.max(mce, Math.abs(avgActual - avgPred));
    }, 0);
  },

  /**
   * Calculate Matthews Correlation Coefficient
   * @param {Array} predictions - Array of {predicted: 0-1, actual: 0|1}
   * @param {number} threshold - Classification threshold (default 0.5)
   * @returns {number} MCC value (-1 to 1)
   */
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

  /**
   * Calculate Cohen's Kappa for agreement
   * @param {Array} predictions - Array of predictions
   * @param {number} threshold - Classification threshold
   * @returns {number} Kappa value
   */
  cohensKappa(predictions, threshold = 0.5) {
    const n = predictions.length;
    let tp = 0, tn = 0, fp = 0, fn = 0;

    predictions.forEach(p => {
      const predicted = p.predicted >= threshold ? 1 : 0;
      if (predicted === 1 && p.actual === 1) tp++;
      else if (predicted === 0 && p.actual === 0) tn++;
      else if (predicted === 1 && p.actual === 0) fp++;
      else fn++;
    });

    const po = (tp + tn) / n; // Observed agreement
    const pe = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n); // Expected agreement

    return pe === 1 ? 1 : (po - pe) / (1 - pe);
  },

  /**
   * Calculate Area Under Precision-Recall Curve (AUPRC)
   * @param {Array} predictions - Array of predictions sorted by predicted value desc
   * @returns {number} AUPRC value
   */
  areaUnderPRCurve(predictions) {
    const sorted = [...predictions].sort((a, b) => b.predicted - a.predicted);
    const totalPositives = sorted.filter(p => p.actual === 1).length;

    if (totalPositives === 0) return 0;

    let auprc = 0;
    let truePositives = 0;
    let prevRecall = 0;

    sorted.forEach((p, i) => {
      if (p.actual === 1) {
        truePositives++;
        const precision = truePositives / (i + 1);
        const recall = truePositives / totalPositives;
        auprc += precision * (recall - prevRecall);
        prevRecall = recall;
      }
    });

    return auprc;
  },

  /**
   * Calculate ROI for hypothetical betting
   * @param {Array} predictions - Array with predicted, actual, and odds
   * @param {number} threshold - Confidence threshold for betting
   * @param {number} betSize - Base bet size
   * @returns {Object} {roi, profit, wins, losses, totalBets}
   */
  calculateROI(predictions, threshold = 0.55, betSize = 100) {
    let profit = 0;
    let wins = 0;
    let losses = 0;

    const qualifyingBets = predictions.filter(p =>
      p.predicted >= threshold || p.predicted <= (1 - threshold)
    );

    qualifyingBets.forEach(p => {
      const betOnHome = p.predicted >= threshold;
      const won = (betOnHome && p.actual === 1) || (!betOnHome && p.actual === 0);

      // Simplified odds calculation (moneyline approximation)
      const impliedOdds = betOnHome ? p.predicted : (1 - p.predicted);
      const payout = betSize * (1 / impliedOdds - 1);

      if (won) {
        profit += payout;
        wins++;
      } else {
        profit -= betSize;
        losses++;
      }
    });

    const totalBets = wins + losses;
    const roi = totalBets > 0 ? (profit / (totalBets * betSize)) * 100 : 0;

    return { roi, profit, wins, losses, totalBets };
  },

  /**
   * Calculate Kelly Criterion for optimal bet sizing
   * @param {number} probability - Win probability
   * @param {number} odds - Decimal odds
   * @returns {number} Fraction of bankroll to bet
   */
  kellyCriterion(probability, odds) {
    const q = 1 - probability;
    const b = odds - 1;
    return Math.max(0, (b * probability - q) / b);
  },

  /**
   * Calculate rolling average
   * @param {Array} values - Array of numbers
   * @param {number} window - Window size
   * @returns {Array} Rolling averages
   */
  rollingAverage(values, window) {
    const result = [];
    for (let i = 0; i < values.length; i++) {
      const start = Math.max(0, i - window + 1);
      const slice = values.slice(start, i + 1);
      result.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    return result;
  },

  /**
   * Calculate cumulative accuracy
   * @param {Array} weeklyResults - Array of {correct, total} per week
   * @returns {Array} Cumulative accuracy per week
   */
  cumulativeAccuracy(weeklyResults) {
    let totalCorrect = 0;
    let totalGames = 0;

    return weeklyResults.map(week => {
      totalCorrect += week.correct;
      totalGames += week.total;
      return totalGames > 0 ? totalCorrect / totalGames : 0;
    });
  },

  /**
   * Calculate variance/stability metric
   * @param {Array} values - Array of numbers
   * @returns {Object} {mean, variance, stdDev, cv}
   */
  varianceAnalysis(values) {
    const n = values.length;
    if (n === 0) return { mean: 0, variance: 0, stdDev: 0, cv: 0 };

    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);
    const cv = mean !== 0 ? stdDev / mean : 0;

    return { mean, variance, stdDev, cv };
  },

  /**
   * Detect trend in time series (improving/declining)
   * @param {Array} values - Array of numbers
   * @returns {Object} {slope, trend, confidence}
   */
  trendDetection(values) {
    const n = values.length;
    if (n < 2) return { slope: 0, trend: 'stable', confidence: 0 };

    const x = Array.from({ length: n }, (_, i) => i);
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator += (x[i] - xMean) * (values[i] - yMean);
      denominator += Math.pow(x[i] - xMean, 2);
    }

    const slope = denominator !== 0 ? numerator / denominator : 0;

    // Calculate R-squared for confidence
    const yPredicted = x.map(xi => yMean + slope * (xi - xMean));
    const ssRes = values.reduce((sum, y, i) => sum + Math.pow(y - yPredicted[i], 2), 0);
    const ssTot = values.reduce((sum, y) => sum + Math.pow(y - yMean, 2), 0);
    const rSquared = ssTot !== 0 ? 1 - (ssRes / ssTot) : 0;

    let trend = 'stable';
    if (slope > 0.001) trend = 'improving';
    else if (slope < -0.001) trend = 'declining';

    return { slope, trend, confidence: rSquared };
  },

  /**
   * Calculate confidence interval
   * @param {number} mean - Sample mean
   * @param {number} stdDev - Standard deviation
   * @param {number} n - Sample size
   * @param {number} confidence - Confidence level (0.95 for 95%)
   * @returns {Object} {lower, upper}
   */
  confidenceInterval(mean, stdDev, n, confidence = 0.95) {
    // Z-scores for common confidence levels
    const zScores = { 0.90: 1.645, 0.95: 1.96, 0.99: 2.576 };
    const z = zScores[confidence] || 1.96;
    const margin = z * (stdDev / Math.sqrt(n));

    return {
      lower: mean - margin,
      upper: mean + margin
    };
  }
};

export default Calculations;
