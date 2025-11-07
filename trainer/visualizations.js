// trainer/visualizations.js
// Visualization tools for model analysis and reporting.
//
// This module generates HTML/SVG visualizations for:
// - Calibration plots (reliability diagrams)
// - Confusion matrices
// - Feature importance charts
// - Learning curves
// - Performance comparison dashboards
//
// All visualizations are generated as standalone HTML files that can be
// opened in a browser or embedded in reports.

import fs from "node:fs";
import path from "node:path";
import { loadAnalysisFlags } from "./featureFlags.js";
import { calculateCalibrationError } from "./analysis.js";

/**
 * Generate HTML wrapper for visualizations.
 * @param {string} title - Chart title
 * @param {string} svgContent - SVG content
 * @param {Object} data - Optional data to include as JSON
 * @returns {string} Complete HTML document
 */
function generateHTML(title, svgContent, data = null) {
  const dataScript = data ? `<script>const chartData = ${JSON.stringify(data, null, 2)};</script>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      margin: 20px;
      background-color: #f5f5f5;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background-color: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
    }
    .subtitle {
      color: #666;
      margin-bottom: 30px;
    }
    svg {
      max-width: 100%;
      height: auto;
    }
    .axis-label {
      font-size: 12px;
      fill: #666;
    }
    .grid-line {
      stroke: #e0e0e0;
      stroke-width: 1;
    }
    .perfect-calibration {
      stroke: #999;
      stroke-width: 2;
      stroke-dasharray: 5,5;
    }
    .calibration-curve {
      stroke: #2563eb;
      stroke-width: 3;
      fill: none;
    }
    .data-point {
      fill: #2563eb;
      opacity: 0.7;
    }
    .bar {
      fill: #2563eb;
      opacity: 0.8;
    }
    .bar:hover {
      opacity: 1;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <div class="subtitle">Generated: ${new Date().toISOString()}</div>
    ${svgContent}
  </div>
  ${dataScript}
</body>
</html>`;
}

/**
 * Generate calibration plot (reliability diagram).
 * @param {Array} predictions - Array of prediction objects
 * @param {Object} options - Chart options
 * @returns {string} HTML content
 */
export function generateCalibrationPlot(predictions, options = {}) {
  const {
    width = 800,
    height = 600,
    numBins = 10,
    title = "Calibration Plot (Reliability Diagram)"
  } = options;

  const calibration = calculateCalibrationError(predictions, numBins);

  if (!calibration.bins || calibration.bins.length === 0) {
    return generateHTML(title, "<p>No data available for calibration plot.</p>");
  }

  const margin = { top: 40, right: 40, bottom: 60, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  // SVG elements
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;

  // Background
  svg += `<rect width="${width}" height="${height}" fill="white"/>`;

  // Chart area
  const chartX = margin.left;
  const chartY = margin.top;

  // Grid lines
  for (let i = 0; i <= 10; i++) {
    const x = chartX + (i / 10) * chartWidth;
    const y = chartY + (i / 10) * chartHeight;

    svg += `<line x1="${x}" y1="${chartY}" x2="${x}" y2="${chartY + chartHeight}" class="grid-line"/>`;
    svg += `<line x1="${chartX}" y1="${y}" x2="${chartX + chartWidth}" y2="${y}" class="grid-line"/>`;
  }

  // Perfect calibration line (diagonal)
  svg += `<line x1="${chartX}" y1="${chartY + chartHeight}" x2="${chartX + chartWidth}" y2="${chartY}" class="perfect-calibration"/>`;

  // Plot calibration bins
  const points = [];
  for (const bin of calibration.bins) {
    if (bin.count === 0) continue;

    const x = chartX + bin.avgPredicted * chartWidth;
    const y = chartY + (1 - bin.avgActual) * chartHeight;

    points.push({ x, y, bin });

    // Data point
    const radius = Math.sqrt(bin.count) * 2;
    svg += `<circle cx="${x}" cy="${y}" r="${Math.max(3, radius)}" class="data-point"/>`;

    // Label with count
    svg += `<text x="${x}" y="${y - radius - 5}" text-anchor="middle" font-size="10" fill="#666">${bin.count}</text>`;
  }

  // Connect points with line
  if (points.length > 1) {
    let pathData = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      pathData += ` L ${points[i].x} ${points[i].y}`;
    }
    svg += `<path d="${pathData}" class="calibration-curve"/>`;
  }

  // Axes
  svg += `<line x1="${chartX}" y1="${chartY}" x2="${chartX}" y2="${chartY + chartHeight}" stroke="black" stroke-width="2"/>`;
  svg += `<line x1="${chartX}" y1="${chartY + chartHeight}" x2="${chartX + chartWidth}" y2="${chartY + chartHeight}" stroke="black" stroke-width="2"/>`;

  // Axis labels
  svg += `<text x="${chartX + chartWidth / 2}" y="${chartY + chartHeight + 40}" text-anchor="middle" class="axis-label" font-size="14" font-weight="bold">Predicted Probability</text>`;
  svg += `<text x="${chartX - 40}" y="${chartY + chartHeight / 2}" text-anchor="middle" class="axis-label" font-size="14" font-weight="bold" transform="rotate(-90 ${chartX - 40} ${chartY + chartHeight / 2})">Observed Frequency</text>`;

  // Tick labels
  for (let i = 0; i <= 10; i++) {
    const value = i / 10;
    const x = chartX + (i / 10) * chartWidth;
    const y = chartY + chartHeight;

    svg += `<text x="${x}" y="${y + 20}" text-anchor="middle" class="axis-label">${value.toFixed(1)}</text>`;
    svg += `<text x="${chartX - 10}" y="${chartY + (1 - i / 10) * chartHeight + 5}" text-anchor="end" class="axis-label">${value.toFixed(1)}</text>`;
  }

  // ECE annotation
  svg += `<text x="${chartX + chartWidth - 10}" y="${chartY + 20}" text-anchor="end" font-size="12" fill="#666">ECE: ${calibration.ece?.toFixed(4) || "N/A"}</text>`;
  svg += `<text x="${chartX + chartWidth - 10}" y="${chartY + 40}" text-anchor="end" font-size="12" fill="#666">MCE: ${calibration.mce?.toFixed(4) || "N/A"}</text>`;

  svg += "</svg>";

  return generateHTML(title, svg, { calibration, predictions: predictions.length });
}

/**
 * Generate confusion matrix visualization.
 * @param {Array} predictions - Array of prediction objects
 * @param {Object} options - Chart options
 * @returns {string} HTML content
 */
export function generateConfusionMatrix(predictions, options = {}) {
  const {
    width = 600,
    height = 600,
    threshold = 0.5,
    title = "Confusion Matrix"
  } = options;

  // Calculate confusion matrix
  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (const pred of predictions) {
    const predicted = pred.forecast >= threshold ? 1 : 0;
    const actual = pred.actual;

    if (predicted === 1 && actual === 1) tp++;
    else if (predicted === 1 && actual === 0) fp++;
    else if (predicted === 0 && actual === 0) tn++;
    else if (predicted === 0 && actual === 1) fn++;
  }

  const total = tp + fp + tn + fn;
  const margin = { top: 60, right: 40, bottom: 60, left: 100 };
  const cellSize = 200;

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="${width}" height="${height}" fill="white"/>`;

  const startX = margin.left;
  const startY = margin.top;

  // Define cells
  const cells = [
    { row: 0, col: 0, value: tp, label: "TP", color: "#22c55e" },
    { row: 0, col: 1, value: fp, label: "FP", color: "#ef4444" },
    { row: 1, col: 0, value: fn, label: "FN", color: "#ef4444" },
    { row: 1, col: 1, value: tn, label: "TN", color: "#22c55e" }
  ];

  // Draw cells
  for (const cell of cells) {
    const x = startX + cell.col * cellSize;
    const y = startY + cell.row * cellSize;
    const opacity = total > 0 ? cell.value / total : 0;

    svg += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${cell.color}" opacity="${Math.max(0.3, opacity)}" stroke="black" stroke-width="2"/>`;
    svg += `<text x="${x + cellSize / 2}" y="${y + cellSize / 2 - 20}" text-anchor="middle" font-size="48" font-weight="bold" fill="black">${cell.value}</text>`;
    svg += `<text x="${x + cellSize / 2}" y="${y + cellSize / 2 + 20}" text-anchor="middle" font-size="18" fill="black">${cell.label}</text>`;
    svg += `<text x="${x + cellSize / 2}" y="${y + cellSize / 2 + 45}" text-anchor="middle" font-size="14" fill="#666">${total > 0 ? ((cell.value / total) * 100).toFixed(1) : 0}%</text>`;
  }

  // Labels
  svg += `<text x="${startX - 20}" y="${startY + cellSize / 2}" text-anchor="end" font-size="16" font-weight="bold">Actual: 1</text>`;
  svg += `<text x="${startX - 20}" y="${startY + cellSize + cellSize / 2}" text-anchor="end" font-size="16" font-weight="bold">Actual: 0</text>`;
  svg += `<text x="${startX + cellSize / 2}" y="${startY - 20}" text-anchor="middle" font-size="16" font-weight="bold">Pred: 1</text>`;
  svg += `<text x="${startX + cellSize + cellSize / 2}" y="${startY - 20}" text-anchor="middle" font-size="16" font-weight="bold">Pred: 0</text>`;

  // Metrics
  const accuracy = total > 0 ? (tp + tn) / total : 0;
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1 = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  svg += `<text x="${startX}" y="${startY + cellSize * 2 + 40}" font-size="14" fill="#333">Accuracy: ${(accuracy * 100).toFixed(2)}%</text>`;
  svg += `<text x="${startX + 200}" y="${startY + cellSize * 2 + 40}" font-size="14" fill="#333">Precision: ${(precision * 100).toFixed(2)}%</text>`;
  svg += `<text x="${startX}" y="${startY + cellSize * 2 + 60}" font-size="14" fill="#333">Recall: ${(recall * 100).toFixed(2)}%</text>`;
  svg += `<text x="${startX + 200}" y="${startY + cellSize * 2 + 60}" font-size="14" fill="#333">F1 Score: ${f1.toFixed(4)}</text>`;

  svg += "</svg>";

  return generateHTML(title, svg, { tp, fp, tn, fn, accuracy, precision, recall, f1 });
}

/**
 * Generate feature importance bar chart.
 * @param {Array} importances - Array of {feature, importance} objects
 * @param {Object} options - Chart options
 * @returns {string} HTML content
 */
export function generateFeatureImportancePlot(importances, options = {}) {
  const {
    width = 800,
    height = 600,
    topN = 20,
    title = "Feature Importance (Top 20)"
  } = options;

  if (!importances || importances.length === 0) {
    return generateHTML(title, "<p>No feature importance data available.</p>");
  }

  const topFeatures = importances.slice(0, topN);
  const margin = { top: 40, right: 40, bottom: 60, left: 200 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const barHeight = chartHeight / topN;
  const maxImportance = Math.max(...topFeatures.map((f) => f.importance));

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="${width}" height="${height}" fill="white"/>`;

  // Draw bars
  topFeatures.forEach((feature, idx) => {
    const barWidth = (feature.importance / maxImportance) * chartWidth;
    const y = margin.top + idx * barHeight;

    svg += `<rect x="${margin.left}" y="${y}" width="${barWidth}" height="${barHeight - 2}" class="bar"/>`;
    svg += `<text x="${margin.left - 5}" y="${y + barHeight / 2 + 5}" text-anchor="end" font-size="11" fill="#333">${feature.feature}</text>`;
    svg += `<text x="${margin.left + barWidth + 5}" y="${y + barHeight / 2 + 5}" font-size="10" fill="#666">${feature.importance.toFixed(4)}</text>`;
  });

  // Axis
  svg += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + chartHeight}" stroke="black" stroke-width="2"/>`;
  svg += `<line x1="${margin.left}" y1="${margin.top + chartHeight}" x2="${margin.left + chartWidth}" y2="${margin.top + chartHeight}" stroke="black" stroke-width="2"/>`;

  svg += "</svg>";

  return generateHTML(title, svg, { features: topFeatures });
}

/**
 * Save visualization to file.
 * @param {string} html - HTML content
 * @param {string} filename - Output filename
 * @param {string} outputDir - Output directory (default: artifacts/visualizations)
 */
export function saveVisualization(html, filename, outputDir = "artifacts/visualizations") {
  const dir = path.resolve(outputDir);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, html, "utf8");

  return filepath;
}

/**
 * Generate all visualizations for a set of predictions.
 * @param {Array} predictions - Array of prediction objects
 * @param {Object} model - Model object (optional)
 * @param {Array<string>} featureNames - Feature names (optional)
 * @param {string} season - Season identifier
 * @param {number} week - Week number
 * @returns {Object} Paths to generated visualizations
 */
export function generateAllVisualizations(predictions, model = null, featureNames = null, season = null, week = null) {
  const flags = loadAnalysisFlags();
  const outputs = {};

  const identifier = season && week ? `${season}_W${week}` : "latest";

  // Calibration plot
  if (flags.enableCalibrationPlots) {
    const calibPlot = generateCalibrationPlot(predictions);
    outputs.calibrationPlot = saveVisualization(calibPlot, `calibration_${identifier}.html`);
    console.log(`✓ Generated calibration plot: ${outputs.calibrationPlot}`);
  }

  // Confusion matrix
  if (flags.enableConfusionMatrix) {
    const confMatrix = generateConfusionMatrix(predictions);
    outputs.confusionMatrix = saveVisualization(confMatrix, `confusion_matrix_${identifier}.html`);
    console.log(`✓ Generated confusion matrix: ${outputs.confusionMatrix}`);
  }

  // Feature importance
  if (flags.enableFeatureImportance && model && featureNames) {
    const { trackFeatureImportance } = await import("./analysis.js");
    const importance = trackFeatureImportance(model, featureNames);

    if (importance.length > 0) {
      const featurePlot = generateFeatureImportancePlot(importance);
      outputs.featureImportance = saveVisualization(featurePlot, `feature_importance_${identifier}.html`);
      console.log(`✓ Generated feature importance: ${outputs.featureImportance}`);
    }
  }

  return outputs;
}

export default {
  generateCalibrationPlot,
  generateConfusionMatrix,
  generateFeatureImportancePlot,
  saveVisualization,
  generateAllVisualizations
};
