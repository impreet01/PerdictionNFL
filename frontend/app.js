/*
 * Perdiction NFL Dashboard
 * ------------------------
 * This script powers the interactive experience for the dashboard. It loads
 * predictions and evaluation metrics from the ../artifacts directory,
 * visualises model performance with Chart.js, and keeps the interface
 * responsive and accessible for future contributors.
 */

const MODEL_CONFIG = [
  { key: "blended", metricsKey: "blended", label: "Hybrid v2 (Ensemble)", color: "#1f77b4" },
  { key: "logistic", metricsKey: "logistic", label: "Logistic Regression", color: "#ff7f0e" },
  { key: "tree", metricsKey: "decision_tree", label: "Decision Tree", color: "#2ca02c" },
  { key: "bt", metricsKey: "bt", label: "Bradley–Terry", color: "#d62728" },
  { key: "ann", metricsKey: "ann", label: "ANN", color: "#9467bd" },
];

const METRIC_LABELS = {
  accuracy: "Accuracy",
  auc: "AUC",
  brier: "Brier Score",
  logloss: "Log Loss",
};

const seasonsSelect = document.getElementById("season-select");
const weekSelect = document.getElementById("week-select");
const metricSelect = document.getElementById("metric-select");
const statusMessage = document.getElementById("status-message");
const searchInput = document.getElementById("team-filter");
const tableBody = document.querySelector("#predictions-table tbody");
const tableEmpty = document.getElementById("table-empty");
const weekChartCanvas = document.getElementById("week-chart");
const weekChartMessage = document.getElementById("week-chart-message");
const trendChartCanvas = document.getElementById("trend-chart");
const trendChartMessage = document.getElementById("trend-chart-message");

let predictionsCache = new Map();
let seasonMetricsCache = new Map();
let currentWeekMetrics = null;
let weekChart = null;
let trendChart = null;

// Kick off discovery when the DOM is ready.
document.addEventListener("DOMContentLoaded", () => {
  seasonsSelect.addEventListener("change", handleSeasonChange);
  weekSelect.addEventListener("change", loadWeekData);
  metricSelect.addEventListener("change", handleMetricChange);
  searchInput.addEventListener("input", filterTable);

  discoverSeasons();
});

/**
 * Attempt to auto-discover available seasons by probing for metrics files.
 * Falling back to sensible defaults keeps the UI usable even if new files
 * are introduced in the future.
 */
async function discoverSeasons() {
  const currentYear = new Date().getFullYear();
  const candidateSeasons = [];

  for (let year = 2010; year <= currentYear + 1; year += 1) {
    const url = `../artifacts/metrics_${year}.json`;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) continue;
      const data = await response.json();
      seasonMetricsCache.set(year, data);
      candidateSeasons.push(year);
    } catch (error) {
      // Swallow 404s and network issues; missing files are expected.
    }
  }

  // Ensure we have at least one season to display.
  if (candidateSeasons.length === 0) {
    const fallbackSeason = currentYear - 1;
    candidateSeasons.push(fallbackSeason);
    statusMessage.textContent =
      "Unable to locate season-level metrics files automatically. Showing fallback options.";
  }

  candidateSeasons.sort((a, b) => b - a);

  for (const season of candidateSeasons) {
    const option = document.createElement("option");
    option.value = season;
    option.textContent = season;
    seasonsSelect.append(option);
  }

  // Prefer the most recent season, otherwise pick the first available.
  const defaultSeason = candidateSeasons[0];
  seasonsSelect.value = defaultSeason;
  await handleSeasonChange();
}

/**
 * Update the week selector whenever a new season is chosen.
 */
async function handleSeasonChange() {
  const season = Number(seasonsSelect.value);
  if (!season) return;

  const seasonMetrics = await loadSeasonMetrics(season);
  populateWeekOptions(season, seasonMetrics);
  await loadWeekData();
}

/**
 * Populate week options up to the latest completed week while still allowing
 * users to explore future projections if they exist.
 */
function populateWeekOptions(season, seasonMetrics) {
  const maxWeeks = 23; // Covers regular season + postseason rounds.
  let latestCompletedWeek = seasonMetrics?.latest_completed_week ?? null;

  if (!latestCompletedWeek && Array.isArray(seasonMetrics?.weeks)) {
    latestCompletedWeek = seasonMetrics.weeks.reduce(
      (max, weekEntry) => Math.max(max, Number(weekEntry.week) || 0),
      0
    );
  }

  weekSelect.innerHTML = "";
  for (let week = 1; week <= maxWeeks; week += 1) {
    const option = document.createElement("option");
    option.value = week;
    let label = `Week ${week}`;
    if (latestCompletedWeek && week > latestCompletedWeek) {
      label += " (upcoming)";
    }
    option.textContent = label;
    weekSelect.append(option);
  }

  const defaultWeek = latestCompletedWeek || 1;
  weekSelect.value = String(defaultWeek);
}

/**
 * Load both predictions and metrics for the currently selected season/week.
 */
async function loadWeekData() {
  const season = Number(seasonsSelect.value);
  const week = Number(weekSelect.value);
  if (!season || !week) return;

  setStatus(`Loading Week ${week} data for ${season}…`);

  let predictions = [];
  let predictionsLoaded = false;
  try {
    predictions = await fetchPredictions(season, week);
    predictionsLoaded = Array.isArray(predictions) && predictions.length > 0;
  } catch (error) {
    console.error("Failed to load predictions", error);
  }
  renderPredictionsTable(predictions ?? []);

  currentWeekMetrics = null;
  try {
    currentWeekMetrics = await fetchWeekMetrics(season, week);
  } catch (error) {
    console.warn("Week-level metrics missing", error);
  }
  updateWeekChart();
  updateTrendChart();

  const parts = [];
  parts.push(
    predictionsLoaded
      ? "Predictions loaded successfully."
      : "Predictions are not yet available for this selection."
  );
  parts.push(
    currentWeekMetrics
      ? "Week-level metrics loaded."
      : "Week-level metrics will appear once games are completed."
  );
  if (seasonMetricsCache.get(season)?.weeks) {
    parts.push("Season trend metrics loaded.");
  } else {
    parts.push("Season trend metrics are not available yet.");
  }

  setStatus(parts.join(" "));
}

/**
 * Fetch predictions for a given season/week, using a simple in-memory cache.
 */
async function fetchPredictions(season, week) {
  const cacheKey = `${season}-W${week}`;
  if (predictionsCache.has(cacheKey)) {
    return predictionsCache.get(cacheKey);
  }

  const weekSlug = String(week).padStart(2, "0");
  const url = `../artifacts/predictions_${season}_W${weekSlug}.json`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Predictions not found for ${season} week ${week}`);
  }
  const data = await response.json();
  const safeData = Array.isArray(data) ? data : [];
  predictionsCache.set(cacheKey, safeData);
  return safeData;
}

/**
 * Fetch week-level metrics if available.
 */
async function fetchWeekMetrics(season, week) {
  const weekSlug = String(week).padStart(2, "0");
  const url = `../artifacts/metrics_${season}_W${weekSlug}.json`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Metrics not found for ${season} week ${week}`);
  }
  return response.json();
}

/**
 * Ensure we have the aggregated metrics for a season.
 */
async function loadSeasonMetrics(season) {
  if (seasonMetricsCache.has(season)) {
    return seasonMetricsCache.get(season);
  }
  const url = `../artifacts/metrics_${season}.json`;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("Season metrics not found");
    const data = await response.json();
    seasonMetricsCache.set(season, data);
    return data;
  } catch (error) {
    console.warn(`Unable to load metrics_${season}.json`, error);
    seasonMetricsCache.set(season, null);
    return null;
  }
}

/**
 * Render the predictions table with toggleable natural language details.
 */
function renderPredictionsTable(predictions) {
  tableBody.innerHTML = "";
  tableEmpty.hidden = predictions.length > 0;

  const fragment = document.createDocumentFragment();

  predictions.forEach((prediction, index) => {
    const dataRow = document.createElement("tr");
    dataRow.classList.add("data-row");
    const matchup = `${prediction?.away_team ?? "TBD"} @ ${
      prediction?.home_team ?? "TBD"
    }`;
    dataRow.dataset.teams = `${prediction?.away_team ?? ""} ${
      prediction?.home_team ?? ""
    }`.toLowerCase();

    const ensembleProbability = formatProbability(
      prediction?.probs?.blended ?? prediction?.forecast
    );
    const logisticProbability = formatProbability(prediction?.probs?.logistic);
    const treeProbability = formatProbability(
      prediction?.probs?.tree ?? prediction?.probs?.decision_tree
    );
    const btProbability = formatProbability(prediction?.probs?.bt);
    const annProbability = formatProbability(prediction?.probs?.ann);

    dataRow.innerHTML = `
      <td>${matchup}</td>
      <td>${ensembleProbability}</td>
      <td>${logisticProbability}</td>
      <td>${treeProbability}</td>
      <td>${btProbability}</td>
      <td>${annProbability}</td>
      <td><button class="toggle-details" type="button" aria-expanded="false" aria-controls="details-${index}">Show details</button></td>
    `;

    const detailsRow = document.createElement("tr");
    detailsRow.classList.add("details-row", "hidden");
    detailsRow.id = `details-${index}`;

    const detailsCell = document.createElement("td");
    detailsCell.colSpan = 7;

    const explanation = document.createElement("p");
    explanation.textContent =
      prediction?.natural_language ??
      "A natural language explanation will appear here when available.";
    detailsCell.append(explanation);

    const drivers = Array.isArray(prediction?.top_drivers)
      ? prediction.top_drivers
      : [];

    if (drivers.length > 0) {
      const listHeading = document.createElement("p");
      listHeading.textContent = "Top feature drivers";
      detailsCell.append(listHeading);

      const list = document.createElement("ul");
      drivers.forEach((driver) => {
        const item = document.createElement("li");
        const direction = driver?.direction ? `${driver.direction} impact` : "";
        const magnitude =
          typeof driver?.magnitude === "number"
            ? ` (magnitude ${driver.magnitude.toFixed(2)})`
            : "";
        const source = driver?.source ? ` via ${driver.source}` : "";
        item.textContent = `${driver?.feature ?? "Unknown feature"}: ${direction}${magnitude}${source}`;
        list.append(item);
      });
      detailsCell.append(list);
    } else {
      const placeholder = document.createElement("p");
      placeholder.textContent =
        "Contextual drivers such as injuries, weather, and market signals will appear once they are recorded.";
      detailsCell.append(placeholder);
    }

    detailsRow.append(detailsCell);

    const toggleButton = dataRow.querySelector(".toggle-details");
    toggleButton.addEventListener("click", () => {
      const isHidden = detailsRow.classList.toggle("hidden");
      toggleButton.setAttribute("aria-expanded", String(!isHidden));
      toggleButton.textContent = isHidden ? "Show details" : "Hide details";
    });

    fragment.append(dataRow, detailsRow);
  });

  tableBody.append(fragment);
  filterTable();
}

/**
 * Format a probability (0-1) into a percentage string.
 */
function formatProbability(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "&mdash;";
  }
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Filter the prediction rows based on a team abbreviation query.
 */
function filterTable() {
  const query = searchInput.value.trim().toLowerCase();
  let visibleRows = 0;

  tableBody.querySelectorAll("tr.data-row").forEach((row) => {
    const teams = row.dataset.teams ?? "";
    const matches = !query || teams.includes(query);
    row.classList.toggle("hidden", !matches);

    const detailsRow = row.nextElementSibling;
    if (detailsRow && detailsRow.classList.contains("details-row")) {
      const toggleButton = row.querySelector(".toggle-details");
      if (!matches) {
        detailsRow.classList.add("hidden");
        if (toggleButton) {
          toggleButton.setAttribute("aria-expanded", "false");
          toggleButton.textContent = "Show details";
        }
      } else if (toggleButton?.getAttribute("aria-expanded") === "true") {
        detailsRow.classList.remove("hidden");
      } else {
        detailsRow.classList.add("hidden");
      }
    }

    if (matches) visibleRows += 1;
  });

  const totalDataRows = tableBody.querySelectorAll("tr.data-row").length;
  tableEmpty.hidden = totalDataRows === 0 ? false : visibleRows > 0;
}

/**
 * Update the bar chart for the currently selected week.
 */
function updateWeekChart() {
  const metricKey = metricSelect.value;

  if (!currentWeekMetrics?.per_model) {
    weekChartMessage.textContent =
      "Week metrics will appear once the games are final and evaluation is complete.";
    if (weekChart) {
      weekChart.destroy();
      weekChart = null;
    }
    return;
  }

  weekChartMessage.textContent = "";

  const labels = [];
  const values = [];
  const colors = [];

  MODEL_CONFIG.forEach((model) => {
    const modelMetrics =
      currentWeekMetrics.per_model[model.metricsKey] ??
      currentWeekMetrics.per_model[model.key];
    if (modelMetrics && typeof modelMetrics[metricKey] === "number") {
      labels.push(model.label);
      values.push(modelMetrics[metricKey]);
      colors.push(model.color);
    }
  });

  if (labels.length === 0) {
    weekChartMessage.textContent =
      "The selected metric is not yet available for this week.";
    if (weekChart) {
      weekChart.destroy();
      weekChart = null;
    }
    return;
  }

  if (weekChart) weekChart.destroy();

  weekChart = new Chart(weekChartCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: METRIC_LABELS[metricKey] ?? metricKey,
          data: values,
          backgroundColor: colors,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: (value) => formatMetricValue(value, metricKey),
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) =>
              `${context.dataset.label}: ${formatMetricValue(context.parsed.y, metricKey)}`,
          },
        },
      },
    },
  });
}

/**
 * Update the season-long trend chart.
 */
function updateTrendChart() {
  const season = Number(seasonsSelect.value);
  const metricKey = metricSelect.value;
  const seasonMetrics = seasonMetricsCache.get(season);

  if (!seasonMetrics || !Array.isArray(seasonMetrics.weeks) || seasonMetrics.weeks.length === 0) {
    trendChartMessage.textContent =
      "Season trajectory metrics are not yet available for this season.";
    if (trendChart) {
      trendChart.destroy();
      trendChart = null;
    }
    return;
  }

  trendChartMessage.textContent = "";

  const sortedWeeks = [...seasonMetrics.weeks].sort(
    (a, b) => Number(a.week) - Number(b.week)
  );
  const weekLabels = sortedWeeks.map((week) => `W${String(week.week).padStart(2, "0")}`);

  const datasets = MODEL_CONFIG.map((model) => {
    const data = sortedWeeks.map((week) => {
      const perModel = week.per_model ?? {};
      const modelEntry = perModel[model.metricsKey] ?? perModel[model.key];
      const metricValue = modelEntry ? modelEntry[metricKey] : null;
      return typeof metricValue === "number" ? metricValue : null;
    });
    return {
      label: model.label,
      data,
      borderColor: model.color,
      backgroundColor: model.color,
      tension: 0.2,
      spanGaps: true,
    };
  });

  const hasAnyData = datasets.some((dataset) =>
    dataset.data.some((value) => typeof value === "number")
  );

  if (!hasAnyData) {
    trendChartMessage.textContent =
      "Season trajectory metrics are not yet available for this selection.";
    if (trendChart) {
      trendChart.destroy();
      trendChart = null;
    }
    return;
  }

  if (trendChart) trendChart.destroy();

  trendChart = new Chart(trendChartCanvas, {
    type: "line",
    data: {
      labels: weekLabels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: {
          beginAtZero: metricKey !== "logloss",
          ticks: {
            callback: (value) => formatMetricValue(value, metricKey),
          },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (context) =>
              `${context.dataset.label}: ${formatMetricValue(context.parsed.y, metricKey)}`,
          },
        },
      },
    },
  });
}

/**
 * Human-friendly formatting for metric values.
 */
function formatMetricValue(value, metricKey) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  const digits = metricKey === "logloss" ? 3 : 3;
  return value.toFixed(digits);
}

/**
 * React to metric selector changes by redrawing charts.
 */
function handleMetricChange() {
  updateWeekChart();
  updateTrendChart();
}

/**
 * Utility to update the status text for screen readers and users.
 */
function setStatus(message) {
  statusMessage.textContent = message;
}
