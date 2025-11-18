/*
 * Perdiction NFL Intelligence Center
 * ----------------------------------
 * Powers the interactive dashboard with resilient artifact loading,
 * comprehensive analytics, and accessibility enhancements.
 */

const DEFAULT_MODEL_CONFIG = [
  { key: "blended", label: "Hybrid Ensemble", color: "#1f77b4", pinned: true },
  { key: "logistic", label: "Logistic Regression", color: "#ff7f0e" },
  { key: "tree", label: "Decision Tree", color: "#2ca02c", metricsKey: "decision_tree" },
  { key: "bt", label: "Bradley–Terry", color: "#d62728" },
  { key: "ann", label: "Neural Network", color: "#9467bd" },
  { key: "xgboost", label: "Gradient Boosting", color: "#8c564b" },
  { key: "ngs", label: "Next Gen Stats", color: "#17becf" },
  { key: "qbr", label: "QBR Blend", color: "#bcbd22" },
];

const MODEL_COLOR_POOL = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#17becf",
  "#bcbd22",
  "#7f7f7f",
];

const METRIC_LABELS = {
  accuracy: "Accuracy",
  auc: "AUC",
  brier: "Brier Score",
  logloss: "Log Loss",
};

const artifactCache = new Map();
const seasonMetricsCache = new Map();
const historyCache = new Map();

const state = {
  season: null,
  week: null,
  metric: "accuracy",
  predictions: [],
  weekMetrics: null,
  diagnostics: null,
  explanations: null,
  modelConfig: [],
  sort: { column: "blended", direction: "desc" },
  activeTab: "predictions",
  featureQuery: "",
  history: null,
};

const charts = {
  week: null,
  trend: null,
  blend: null,
  drivers: null,
  radar: null,
  history: null,
};

const seasonsSelect = document.getElementById("season-select");
const weekSelect = document.getElementById("week-select");
const metricSelect = document.getElementById("metric-select");
const statusMessage = document.getElementById("status-message");
const teamFilterInput = document.getElementById("team-filter");
const featureFilterInput = document.getElementById("feature-filter");
const modelTogglesContainer = document.getElementById("model-toggles");
const predictionsLoader = document.getElementById("predictions-loader");
const metricsLoader = document.getElementById("metrics-loader");
const tableHead = document.querySelector("#predictions-table thead");
const tableBody = document.querySelector("#predictions-table tbody");
const tableEmpty = document.getElementById("table-empty");
const tableSummary = document.getElementById("table-summary");
const weekChartCanvas = document.getElementById("week-chart");
const weekChartMessage = document.getElementById("week-chart-message");
const trendChartCanvas = document.getElementById("trend-chart");
const trendChartMessage = document.getElementById("trend-chart-message");
const blendChartCanvas = document.getElementById("blend-chart");
const blendChartMessage = document.getElementById("blend-chart-message");
const varianceHeatmap = document.getElementById("variance-heatmap");
const varianceMessage = document.getElementById("variance-message");
const seasonSummary = document.getElementById("season-summary");
const driversChartCanvas = document.getElementById("drivers-chart");
const driversMessage = document.getElementById("drivers-message");
const impactRadarCanvas = document.getElementById("impact-radar");
const impactRadarMessage = document.getElementById("impact-radar-message");
const thresholdTableBody = document.getElementById("threshold-table-body");
const thresholdMessage = document.getElementById("threshold-message");
const historyRange = document.getElementById("history-range");
const historyTeamSelect = document.getElementById("history-team-select");
const historyModelSelect = document.getElementById("history-model-select");
const historyMetricSelect = document.getElementById("history-metric-select");
const historyChartCanvas = document.getElementById("history-chart");
const historyChartMessage = document.getElementById("history-chart-message");
const toast = document.getElementById("toast");
const modal = document.getElementById("game-modal");
const modalBody = document.getElementById("modal-body");
const modalClose = document.getElementById("modal-close");
const themeToggle = document.getElementById("theme-toggle");

function init() {
  registerChartPlugins();
  configureTheme();
  bindTabNavigation();
  bindControls();
  state.modelConfig = DEFAULT_MODEL_CONFIG.map((model) => ({
    ...model,
    visible: true,
    metricsKey: model.metricsKey ?? model.key,
  }));
  populateModelToggles();
  discoverSeasons();
}

document.addEventListener("DOMContentLoaded", init);

function registerChartPlugins() {
  if (!window.Chart) return;
  const { Chart } = window;
  if (window["chartjs-plugin-zoom"]) {
    Chart.register(window["chartjs-plugin-zoom"]);
  }
  if (window["chartjs-plugin-annotation"]) {
    Chart.register(window["chartjs-plugin-annotation"]);
  }
  Chart.defaults.font.family = getComputedStyle(document.documentElement).getPropertyValue("--font-family");
}

function configureTheme() {
  const saved = localStorage.getItem("perdiction-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const initial = saved || (prefersDark ? "dark" : "light");
  applyTheme(initial);
  themeToggle?.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "light" ? "dark" : "light";
    applyTheme(next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("perdiction-theme", theme);
  if (theme === "dark") {
    themeToggle?.setAttribute("aria-pressed", "true");
    themeToggle?.querySelector(".theme-toggle__icon")?.replaceChildren(document.createTextNode("☀️"));
    themeToggle?.querySelector(".sr-only")?.replaceChildren(document.createTextNode("Disable dark mode"));
  } else {
    themeToggle?.setAttribute("aria-pressed", "false");
    themeToggle?.querySelector(".theme-toggle__icon")?.replaceChildren(document.createTextNode("🌙"));
    themeToggle?.querySelector(".sr-only")?.replaceChildren(document.createTextNode("Enable dark mode"));
  }
  refreshCharts();
}

function refreshCharts() {
  renderWeekChart();
  renderTrendChart();
  renderBlendChart();
  renderDriversChart();
  renderImpactRadar();
  renderHistoryChart();
}

function bindTabNavigation() {
  const tabs = Array.from(document.querySelectorAll(".tabs [role='tab']"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.id));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      if (event.key === "ArrowRight") {
        event.preventDefault();
        const next = tabs[(index + 1) % tabs.length];
        next.focus();
        activateTab(next.id);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        const prev = tabs[(index - 1 + tabs.length) % tabs.length];
        prev.focus();
        activateTab(prev.id);
      }
    });
  });
}

function activateTab(tabId) {
  const panels = document.querySelectorAll(".tab-panel");
  const tabs = document.querySelectorAll(".tabs [role='tab']");
  tabs.forEach((tab) => {
    const isActive = tab.id === tabId;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.setAttribute("tabindex", isActive ? "0" : "-1");
  });
  panels.forEach((panel) => {
    const isActive = `${panel.id}-btn` === tabId;
    panel.toggleAttribute("hidden", !isActive);
  });
  const newTab = tabId.replace("-btn", "");
  state.activeTab = newTab;
  if (newTab === "tab-metrics") {
    loadMetricsTab();
  } else if (newTab === "tab-explanations") {
    loadExplanationsTab();
  } else if (newTab === "tab-history") {
    loadHistoryTab();
  }
}

function bindControls() {
  seasonsSelect.addEventListener("change", () => {
    state.season = Number(seasonsSelect.value);
    loadSeasonContext();
  });
  weekSelect.addEventListener("change", () => {
    state.week = Number(weekSelect.value);
    loadWeekContext();
  });
  metricSelect.addEventListener("change", () => {
    state.metric = metricSelect.value;
    renderWeekChart();
    renderTrendChart();
    renderHistoryChart();
  });
  historyRange?.addEventListener("input", () => {
    renderTrendChart();
  });
  teamFilterInput.addEventListener("input", debounce(() => {
    renderPredictionsTable();
  }, 150));
  featureFilterInput.addEventListener("input", debounce(() => {
    state.featureQuery = featureFilterInput.value.trim().toLowerCase();
    renderPredictionsTable();
  }, 200));
  historyTeamSelect?.addEventListener("change", renderHistoryChart);
  historyModelSelect?.addEventListener("change", renderHistoryChart);
  historyMetricSelect?.addEventListener("change", renderHistoryChart);
  document.querySelectorAll(".chart-reset").forEach((button) => {
    button.addEventListener("click", () => {
      const chartKey = button.dataset.chart;
      if (chartKey && charts[chartKey]?.resetZoom) {
        charts[chartKey].resetZoom();
      }
    });
  });
  modalClose?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal?.getAttribute("aria-hidden") === "false") {
      closeModal();
    }
  });
}
async function discoverSeasons() {
  setStatus("Discovering available seasons…");
  const currentYear = new Date().getFullYear();
  const candidates = [];
  for (let season = 1999; season <= currentYear + 1; season += 1) {
    const data = await fetchSeasonMetrics(season, { silent: true });
    if (data) {
      candidates.push(season);
    }
  }
  if (candidates.length === 0) {
    const fallback = currentYear - 1;
    candidates.push(fallback);
    showToast("Season metrics were not located automatically; using fallback year.");
  }
  candidates.sort((a, b) => b - a);
  seasonsSelect.innerHTML = "";
  candidates.forEach((season) => {
    const option = document.createElement("option");
    option.value = String(season);
    option.textContent = season;
    seasonsSelect.append(option);
  });
  state.season = candidates[0];
  seasonsSelect.value = String(state.season);
  await loadSeasonContext();
}

async function loadSeasonContext() {
  const metrics = await fetchSeasonMetrics(state.season);
  populateWeekOptions(metrics);
  await loadWeekContext();
}

function populateWeekOptions(seasonMetrics) {
  weekSelect.innerHTML = "";
  const maxWeeks = 23;
  let latestCompletedWeek = seasonMetrics?.latest_completed_week ?? null;
  if (!latestCompletedWeek && Array.isArray(seasonMetrics?.weeks)) {
    latestCompletedWeek = seasonMetrics.weeks.reduce((acc, week) => {
      const weekNum = Number(week?.week);
      return Number.isFinite(weekNum) && weekNum > acc ? weekNum : acc;
    }, 0);
  }
  for (let week = 1; week <= maxWeeks; week += 1) {
    const option = document.createElement("option");
    option.value = String(week);
    let label = `Week ${week}`;
    if (latestCompletedWeek && week > latestCompletedWeek) {
      label += " (upcoming)";
    }
    option.textContent = label;
    weekSelect.append(option);
  }
  state.week = latestCompletedWeek || 1;
  weekSelect.value = String(state.week);
}

async function loadWeekContext() {
  if (!state.season || !state.week) return;
  setStatus(`Loading artifacts for ${state.season} Week ${state.week}…`);
  setLoader(predictionsLoader, true);
  try {
    const [predictions, weekMetrics, diagnostics, explanations] = await Promise.all([
      fetchPredictions(state.season, state.week),
      fetchWeekMetrics(state.season, state.week),
      fetchDiagnostics(state.season, state.week),
      fetchExplanations(state.season, state.week),
    ]);
    state.predictions = predictions ?? [];
    state.weekMetrics = weekMetrics ?? null;
    state.diagnostics = diagnostics ?? null;
    state.explanations = explanations ?? null;
    syncModelConfig();
    populateModelToggles();
    renderPredictionsTable();
    renderWeekChart();
    renderTrendChart();
    if (state.activeTab === "tab-metrics") {
      loadMetricsTab();
    }
    if (state.activeTab === "tab-explanations") {
      loadExplanationsTab();
    }
  } catch (error) {
    console.error("Failed to load week context", error);
    showToast(`Unable to load artifacts for ${state.season} W${state.week}.`);
  } finally {
    setLoader(predictionsLoader, false);
    setStatus(buildStatusMessage());
  }
}

async function loadMetricsTab() {
  setLoader(metricsLoader, true);
  try {
    const seasonMetrics = await fetchSeasonMetrics(state.season);
    renderSeasonSummary(seasonMetrics);
    renderBlendChart();
    renderVarianceHeatmap();
  } catch (error) {
    console.warn("Metrics tab load error", error);
    showToast("Season metrics are unavailable at the moment.");
  } finally {
    setLoader(metricsLoader, false);
  }
}

function loadExplanationsTab() {
  renderDriversChart();
  renderImpactRadar();
  renderThresholdTable();
}

async function loadHistoryTab() {
  if (historyCache.has("global")) {
    state.history = historyCache.get("global");
    populateHistorySelectors();
    renderHistoryChart();
    return;
  }
  try {
    const historyData = await fetchArtifact(
      "metrics-history",
      "../artifacts/metrics_history.json",
      { silent: true }
    );
    if (historyData) {
      state.history = historyData;
      historyCache.set("global", historyData);
      populateHistorySelectors();
      renderHistoryChart();
    } else {
      historyChartMessage.textContent = "Historical aggregates are not available yet.";
    }
  } catch (error) {
    console.warn("Unable to load history data", error);
    historyChartMessage.textContent = "Historical aggregates failed to load.";
  }
}

function populateModelToggles() {
  modelTogglesContainer.innerHTML = "";
  state.modelConfig.forEach((model, index) => {
    const wrapper = document.createElement("label");
    wrapper.className = "model-toggle";
    wrapper.style.display = "inline-flex";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "0.4rem";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = model.visible !== false;
    input.disabled = !!model.pinned;
    input.dataset.modelKey = model.key;
    input.addEventListener("change", () => {
      model.visible = input.checked;
      renderPredictionsTable();
      renderWeekChart();
      renderTrendChart();
      renderBlendChart();
    });
    const swatch = document.createElement("span");
    swatch.style.display = "inline-block";
    swatch.style.width = "0.75rem";
    swatch.style.height = "0.75rem";
    swatch.style.borderRadius = "999px";
    swatch.style.backgroundColor = model.color;
    wrapper.append(input, swatch, document.createTextNode(model.label));
    modelTogglesContainer.append(wrapper);
    if (index === 0 && model.pinned) {
      wrapper.setAttribute("aria-hidden", "true");
    }
  });
}

async function fetchPredictions(season, week) {
  const slug = String(week).padStart(2, "0");
  const url = `../artifacts/predictions_${season}_W${slug}.json`;
  const data = await fetchArtifact(`predictions-${season}-${slug}`, url, { silent: true });
  return Array.isArray(data) ? data : [];
}

async function fetchWeekMetrics(season, week) {
  const slug = String(week).padStart(2, "0");
  const url = `../artifacts/metrics_${season}_W${slug}.json`;
  const data = await fetchArtifact(`metrics-${season}-${slug}`, url, { silent: true });
  return data ?? null;
}

async function fetchDiagnostics(season, week) {
  const slug = String(week).padStart(2, "0");
  const url = `../artifacts/diagnostics_${season}_W${slug}.json`;
  const data = await fetchArtifact(`diagnostics-${season}-${slug}`, url, { silent: true });
  return data ?? null;
}

async function fetchExplanations(season, week) {
  const slug = String(week).padStart(2, "0");
  const url = `../artifacts/explain_${season}_W${slug}.json`;
  const data = await fetchArtifact(`explain-${season}-${slug}`, url, { silent: true });
  return data ?? null;
}

async function fetchSeasonMetrics(season, options = {}) {
  if (seasonMetricsCache.has(season)) {
    return seasonMetricsCache.get(season);
  }
  const url = `../artifacts/metrics_${season}.json`;
  try {
    const data = await fetchArtifact(`metrics-${season}`, url, options);
    if (data) {
      seasonMetricsCache.set(season, data);
      return data;
    }
  } catch (error) {
    if (!options.silent) {
      showToast(`Season metrics for ${season} failed to load.`);
    }
  }
  seasonMetricsCache.set(season, null);
  return null;
}

async function fetchArtifact(cacheKey, url, options = {}) {
  const { silent = false } = options;
  if (artifactCache.has(cacheKey)) {
    return artifactCache.get(cacheKey);
  }
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    const data = JSON.parse(text);
    artifactCache.set(cacheKey, data);
    return data;
  } catch (error) {
    console.warn(`Failed to fetch ${url}`, error);
    if (!silent) {
      showToast(`Unable to load ${url.split("/").pop()} (${error.message}).`);
    }
    artifactCache.set(cacheKey, null);
    return null;
  }
}
function syncModelConfig() {
  const probabilityKeys = new Set();
  state.predictions.forEach((prediction) => {
    const probs = prediction?.probs ?? {};
    Object.entries(probs).forEach(([key, value]) => {
      if (value && typeof value === "object" && "blended" in value) {
        probabilityKeys.add(`${key}.blended`);
      } else {
        probabilityKeys.add(key);
      }
    });
  });
  const metricsKeys = new Set();
  const perModel = state.weekMetrics?.per_model ?? {};
  Object.keys(perModel).forEach((key) => metricsKeys.add(key));
  const allKeys = new Set([...probabilityKeys].map((key) => key.split(".")[0]));
  metricsKeys.forEach((key) => allKeys.add(key));

  const updatedConfig = [];
  const seen = new Set();
  const palette = [...MODEL_COLOR_POOL];
  const ensureColor = () =>
    palette.length
      ? palette.shift()
      : `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;

  DEFAULT_MODEL_CONFIG.forEach((model) => {
    if (seen.has(model.key)) return;
    seen.add(model.key);
    if (allKeys.size && !allKeys.has(model.key) && !model.pinned) return;
    updatedConfig.push({
      ...model,
      visible: model.visible ?? true,
      metricsKey: model.metricsKey ?? model.key,
    });
  });

  allKeys.forEach((key) => {
    if (seen.has(key)) return;
    seen.add(key);
    updatedConfig.push({
      key,
      label: formatModelLabel(key),
      color: ensureColor(),
      visible: true,
      metricsKey: key,
    });
  });

  state.modelConfig = updatedConfig.map((model) => {
    const existing = state.modelConfig.find((item) => item.key === model.key);
    return { ...model, visible: existing ? existing.visible : model.visible };
  });
}

function renderPredictionsTable() {
  const columns = buildTableColumns();
  renderTableHead(columns);
  const filtered = filterPredictions();
  const sorted = sortPredictions(filtered, columns);
  tableBody.innerHTML = "";
  tableEmpty.hidden = sorted.length > 0;
  tableSummary.textContent = sorted.length
    ? `${sorted.length} matchups loaded`
    : "No matchups available";
  if (sorted.length === 0) return;

  const fragment = document.createDocumentFragment();
  sorted.forEach((prediction, index) => {
    const row = document.createElement("tr");
    row.className = "data-row";
    row.dataset.teams = `${prediction.away_team ?? ""} ${prediction.home_team ?? ""}`.toLowerCase();
    row.tabIndex = 0;
    row.addEventListener("click", () => openPredictionModal(prediction));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPredictionModal(prediction);
      }
    });

    columns.forEach((column) => {
      const cell = document.createElement("td");
      cell.dataset.column = column.id;
      cell.innerHTML = column.render(prediction, index);
      row.append(cell);
    });

    fragment.append(row);

    const detailRow = document.createElement("tr");
    detailRow.className = "details-row hidden";
    detailRow.id = `details-${index}`;
    const detailCell = document.createElement("td");
    detailCell.colSpan = columns.length;
    detailCell.append(buildDetailContent(prediction));
    detailRow.append(detailCell);
    fragment.append(detailRow);
  });

  tableBody.append(fragment);

  tableBody.querySelectorAll(".toggle-details").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const targetId = button.getAttribute("aria-controls");
      const row = document.getElementById(targetId);
      const isHidden = row?.classList.toggle("hidden");
      button.setAttribute("aria-expanded", String(!isHidden));
      button.textContent = isHidden ? "Show details" : "Hide details";
    });
  });
}

function buildTableColumns() {
  const visibleModels = state.modelConfig.filter((model) => model.visible || model.pinned);
  const columns = [
    {
      id: "matchup",
      label: "Matchup",
      sortable: true,
      getValue: (prediction) => `${prediction.away_team ?? "TBD"} @ ${prediction.home_team ?? "TBD"}`,
      render: (prediction, index) => {
        const matchup = `${prediction.away_team ?? "TBD"} @ ${prediction.home_team ?? "TBD"}`;
        return `
          <div class="matchup-cell">
            <strong>${matchup}</strong>
            <button class="toggle-details" type="button" aria-expanded="false" aria-controls="details-${index}">
              Show details
            </button>
          </div>
        `;
      },
    },
  ];

  visibleModels.forEach((model) => {
    columns.push({
      id: model.key,
      label: model.label,
      sortable: true,
      getValue: (prediction) => getProbability(prediction, model.key),
      render: (prediction) => formatProbability(getProbability(prediction, model.key)),
    });
  });

  columns.push({
    id: "sos",
    label: "SOS Adjusted",
    sortable: true,
    getValue: (prediction) => getAdjustedProbability(prediction),
    render: (prediction) => {
      const adjusted = getAdjustedProbability(prediction);
      const base = getProbability(prediction, "blended");
      const delta = adjusted != null && base != null ? adjusted - base : null;
      const deltaText = delta != null ? ` <span class="delta" aria-hidden="true">(${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp)</span>` : "";
      return `${formatProbability(adjusted)}${deltaText}`;
    },
  });

  columns.push({
    id: "confidence",
    label: "Confidence Interval",
    sortable: true,
    getValue: (prediction) => prediction?.confidence_interval?.mid ?? getProbability(prediction, "blended"),
    render: (prediction) => formatConfidenceInterval(prediction?.confidence_interval),
  });

  return columns;
}

function renderTableHead(columns) {
  tableHead.innerHTML = "";
  const headerRow = document.createElement("tr");
  columns.forEach((column) => {
    const th = document.createElement("th");
    th.scope = "col";
    if (column.sortable) {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `${column.label} ${renderSortIcon(column.id)}`;
      button.addEventListener("click", () => toggleSort(column.id));
      th.append(button);
    } else {
      th.textContent = column.label;
    }
    headerRow.append(th);
  });
  tableHead.append(headerRow);
}

function renderSortIcon(columnId) {
  if (state.sort.column !== columnId) return '<span aria-hidden="true">⇅</span>';
  return state.sort.direction === "asc"
    ? '<span aria-hidden="true">↑</span>'
    : '<span aria-hidden="true">↓</span>';
}

function toggleSort(columnId) {
  if (state.sort.column === columnId) {
    state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
  } else {
    state.sort.column = columnId;
    state.sort.direction = "desc";
  }
  renderPredictionsTable();
}

function filterPredictions() {
  const teamQuery = teamFilterInput.value.trim().toLowerCase();
  return state.predictions.filter((prediction) => {
    const teams = `${prediction.away_team ?? ""} ${prediction.home_team ?? ""}`.toLowerCase();
    return !teamQuery || teams.includes(teamQuery);
  });
}

function sortPredictions(predictions, columns) {
  const column = columns.find((col) => col.id === state.sort.column) ?? columns[0];
  const direction = state.sort.direction === "asc" ? 1 : -1;
  const getValue = column?.getValue ?? (() => 0);
  return [...predictions].sort((a, b) => {
    const valueA = getValue(a);
    const valueB = getValue(b);
    if (valueA == null && valueB == null) return 0;
    if (valueA == null) return 1;
    if (valueB == null) return -1;
    if (typeof valueA === "string" && typeof valueB === "string") {
      return valueA.localeCompare(valueB) * direction;
    }
    return (valueA - valueB) * direction;
  });
}

function buildDetailContent(prediction) {
  const container = document.createElement("div");
  container.className = "detail-content";
  const natural = prediction?.natural_language ?? "Narrative insights will appear when available.";
  const narrative = document.createElement("p");
  narrative.innerHTML = highlightText(natural, state.featureQuery);
  container.append(narrative);

  const ci = prediction?.confidence_interval;
  if (ci) {
    const ciPara = document.createElement("p");
    ciPara.textContent = `Confidence Interval: ${formatConfidenceInterval(ci)} (variance ${formatNumber(ci?.variance)})`;
    container.append(ciPara);
  }

  const diagnostics = prediction?.diagnostics ?? {};
  if (diagnostics?.variance) {
    const diag = document.createElement("p");
    diag.textContent = `Diagnostic variance: ${formatNumber(diagnostics.variance)} | Calibration: ${formatNumber(diagnostics?.calibration)}.`;
    container.append(diag);
  }

  const topDrivers = Array.isArray(prediction?.top_drivers) ? prediction.top_drivers : [];
  if (topDrivers.length > 0) {
    const listTitle = document.createElement("p");
    listTitle.textContent = "Top feature drivers:";
    container.append(listTitle);
    const list = document.createElement("ul");
    topDrivers.forEach((driver) => {
      const item = document.createElement("li");
      const direction = driver?.direction ? `${driver.direction} impact` : "";
      const magnitude = typeof driver?.magnitude === "number" ? `, magnitude ${driver.magnitude.toFixed(2)}` : "";
      const source = driver?.source ? ` • ${driver.source}` : "";
      const feature = driver?.feature ?? "Unknown feature";
      item.innerHTML = highlightText(`${feature}: ${direction}${magnitude}${source}`, state.featureQuery);
      list.append(item);
    });
    container.append(list);
  }

  const thresholds = prediction?.calibrated_thresholds;
  if (thresholds) {
    const thresholdInfo = document.createElement("p");
    thresholdInfo.textContent = `Threshold (win confidence): ${formatProbability(thresholds?.win ?? thresholds)}.`;
    container.append(thresholdInfo);
  }

  return container;
}

function openPredictionModal(prediction) {
  if (!prediction) return;
  modalBody.innerHTML = "";
  const header = document.createElement("div");
  header.className = "modal__summary";
  const matchup = `${prediction.away_team ?? "TBD"} @ ${prediction.home_team ?? "TBD"}`;
  const ensemble = formatProbability(getProbability(prediction, "blended"));
  const adjusted = formatProbability(getAdjustedProbability(prediction));
  const headerText = document.createElement("p");
  headerText.innerHTML = `<strong>${matchup}</strong><br/>Ensemble: ${ensemble} • SOS adjusted: ${adjusted}`;
  header.append(headerText);
  modalBody.append(header);

  if (prediction?.probs) {
    const table = document.createElement("table");
    table.className = "threshold-table";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Model</th><th>Probability</th><th>Notes</th></tr>";
    const tbody = document.createElement("tbody");
    state.modelConfig.forEach((model) => {
      const value = getProbability(prediction, model.key);
      if (value == null) return;
      const variance = prediction?.diagnostics?.[model.key]?.variance ?? prediction?.variance?.[model.key];
      const ci = prediction?.confidence_interval?.per_model?.[model.key];
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${model.label}</td>
        <td>${formatProbability(value)}</td>
        <td>${ci ? `CI ${formatConfidenceInterval(ci)}` : ""}${variance ? ` • Var ${formatNumber(variance)}` : ""}</td>
      `;
      tbody.append(row);
    });
    table.append(thead, tbody);
    modalBody.append(table);
  }

  const natural = document.createElement("p");
  natural.innerHTML = highlightText(
    prediction?.natural_language ?? "Narrative insights will appear when available.",
    state.featureQuery
  );
  modalBody.append(natural);

  const driversList = Array.isArray(prediction?.top_drivers) ? prediction.top_drivers : [];
  if (driversList.length > 0) {
    const heading = document.createElement("h4");
    heading.textContent = "Drivers";
    modalBody.append(heading);
    const list = document.createElement("ul");
    driversList.forEach((driver) => {
      const item = document.createElement("li");
      item.innerHTML = highlightText(
        `${driver?.feature ?? "Feature"}: ${driver?.direction ?? ""} (${formatNumber(driver?.magnitude)})`,
        state.featureQuery
      );
      list.append(item);
    });
    modalBody.append(list);
  }

  modal.setAttribute("aria-hidden", "false");
  modal.classList.add("fade-in");
  modalClose?.focus();
}

function closeModal() {
  modal.setAttribute("aria-hidden", "true");
}
function renderSeasonSummary(seasonMetrics) {
  seasonSummary.innerHTML = "";
  if (!seasonMetrics) {
    seasonSummary.innerHTML = "<p>Season metrics are not yet available.</p>";
    return;
  }
  const summaryItems = seasonMetrics?.season_summary ?? seasonMetrics?.summary ?? {};
  const entries = Object.entries(summaryItems);
  if (entries.length === 0) {
    seasonSummary.innerHTML = "<p>No summary metrics reported.</p>";
    return;
  }
  entries.forEach(([metricKey, metricValue]) => {
    const dt = document.createElement("dt");
    dt.textContent = METRIC_LABELS[metricKey] ?? formatModelLabel(metricKey);
    const dd = document.createElement("dd");
    dd.textContent = formatNumber(metricValue);
    seasonSummary.append(dt, dd);
  });
}

function renderWeekChart() {
  if (!weekChartCanvas) return;
  if (charts.week) {
    charts.week.destroy();
    charts.week = null;
  }
  if (!state.weekMetrics?.per_model) {
    weekChartMessage.textContent = "Week metrics will appear once evaluations are complete.";
    return;
  }
  weekChartMessage.textContent = "";
  const metricKey = state.metric;
  const labels = [];
  const data = [];
  const backgroundColor = [];
  state.modelConfig
    .filter((model) => model.visible || model.pinned)
    .forEach((model) => {
      const entry = state.weekMetrics.per_model[model.metricsKey] ?? state.weekMetrics.per_model[model.key];
      const value = entry ? entry[metricKey] : null;
      if (typeof value === "number") {
        labels.push(model.label);
        data.push(value);
        backgroundColor.push(model.color);
      }
    });
  if (labels.length === 0) {
    weekChartMessage.textContent = "No week-level metrics for the selected models.";
    return;
  }
  charts.week = new Chart(weekChartCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: METRIC_LABELS[metricKey] ?? metricKey,
          data,
          backgroundColor,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      scales: {
        y: {
          beginAtZero: metricKey !== "logloss",
          ticks: { callback: (value) => formatMetricValue(value, metricKey) },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => `${context.label}: ${formatMetricValue(context.parsed.y, metricKey)}`,
          },
        },
        zoom: {
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: "y",
          },
          pan: { enabled: true, mode: "y" },
          limits: { y: { min: "original", max: "original" } },
        },
      },
    },
  });
}

function renderTrendChart() {
  if (charts.trend) {
    charts.trend.destroy();
    charts.trend = null;
  }
  const seasonMetrics = seasonMetricsCache.get(state.season);
  if (!seasonMetrics?.weeks || seasonMetrics.weeks.length === 0) {
    trendChartMessage.textContent = "Season trajectory metrics are not available yet.";
    return;
  }
  trendChartMessage.textContent = "";
  const metricKey = state.metric;
  const maxWeek = Number(historyRange?.value ?? 23);
  const weeks = seasonMetrics.weeks
    .filter((week) => Number(week.week) <= maxWeek)
    .sort((a, b) => Number(a.week) - Number(b.week));
  const labels = weeks.map((week) => `W${String(week.week).padStart(2, "0")}`);
  const datasets = state.modelConfig
    .filter((model) => model.visible || model.pinned)
    .map((model) => ({
      label: model.label,
      data: weeks.map((week) => {
        const entry = week.per_model?.[model.metricsKey] ?? week.per_model?.[model.key];
        const value = entry ? entry[metricKey] : null;
        return typeof value === "number" ? value : null;
      }),
      borderColor: model.color,
      backgroundColor: model.color,
      tension: 0.25,
      spanGaps: true,
      pointRadius: 3,
    }))
    .filter((dataset) => dataset.data.some((value) => typeof value === "number"));
  if (datasets.length === 0) {
    trendChartMessage.textContent = "The selected models do not have season metrics yet.";
    return;
  }
  charts.trend = new Chart(trendChartCanvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      animation: { duration: 600 },
      scales: {
        y: {
          beginAtZero: metricKey !== "logloss",
          ticks: { callback: (value) => formatMetricValue(value, metricKey) },
        },
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatMetricValue(context.parsed.y, metricKey)}`,
          },
        },
        zoom: {
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: "xy",
          },
          pan: { enabled: true, mode: "xy" },
        },
      },
    },
  });
}

function renderBlendChart() {
  if (charts.blend) {
    charts.blend.destroy();
    charts.blend = null;
  }
  const blendWeights = state.weekMetrics?.blend_weights ?? state.explanations?.blend_weights;
  if (!blendWeights) {
    blendChartMessage.textContent = "Blend weights will appear when calibration data is available.";
    return;
  }
  blendChartMessage.textContent = "";
  const entries = Object.entries(blendWeights).filter(([, value]) => typeof value === "number");
  if (entries.length === 0) {
    blendChartMessage.textContent = "Blend weights are missing for this selection.";
    return;
  }
  const labels = entries.map(([modelKey]) => state.modelConfig.find((model) => model.key === modelKey)?.label ?? formatModelLabel(modelKey));
  const data = entries.map(([, value]) => value);
  const colors = entries.map(([modelKey], index) => {
    const model = state.modelConfig.find((item) => item.key === modelKey);
    return model?.color ?? MODEL_COLOR_POOL[index % MODEL_COLOR_POOL.length];
  });
  charts.blend = new Chart(blendChartCanvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: colors,
          hoverOffset: 12,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (context) => `${context.label}: ${(context.parsed * 100).toFixed(1)}%`,
          },
        },
      },
    },
  });
}

function renderVarianceHeatmap() {
  varianceHeatmap.innerHTML = "";
  if (!state.diagnostics?.oof_variance) {
    varianceMessage.textContent = "Variance diagnostics will populate after training completes.";
    return;
  }
  varianceMessage.textContent = "";
  const varianceData = state.diagnostics.oof_variance;
  const rows = Array.isArray(varianceData)
    ? varianceData
    : Object.entries(varianceData).map(([modelKey, value]) => ({ model: modelKey, value }));
  rows.forEach((row) => {
    const container = document.createElement("div");
    container.className = "heatmap__row";
    const modelCell = document.createElement("div");
    modelCell.className = "heatmap__cell";
    modelCell.textContent = state.modelConfig.find((model) => model.key === row.model)?.label ?? formatModelLabel(row.model);
    modelCell.style.background = "transparent";
    modelCell.style.textAlign = "left";
    container.append(modelCell);
    const values = Array.isArray(row.value) ? row.value : Object.entries(row.value ?? {});
    values.forEach((entry) => {
      const [segment, value] = Array.isArray(entry) ? entry : ["variance", entry];
      const cell = document.createElement("div");
      cell.className = "heatmap__cell";
      const numeric = typeof value === "number" ? value : Number(value?.variance ?? value);
      cell.textContent = `${segment}: ${formatNumber(numeric)}`;
      cell.style.background = heatmapColor(numeric);
      container.append(cell);
    });
    varianceHeatmap.append(container);
  });
}

function renderDriversChart() {
  if (charts.drivers) {
    charts.drivers.destroy();
    charts.drivers = null;
  }
  const drivers = state.explanations?.top_drivers_aggregate ?? aggregateDriversFromPredictions();
  if (!drivers || drivers.length === 0) {
    driversMessage.textContent = "Driver explanations will appear once available.";
    return;
  }
  driversMessage.textContent = "";
  const sorted = drivers
    .filter((driver) => typeof driver?.magnitude === "number")
    .sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude))
    .slice(0, 10);
  charts.drivers = new Chart(driversChartCanvas, {
    type: "bar",
    data: {
      labels: sorted.map((driver) => driver.feature ?? "Feature"),
      datasets: [
        {
          label: "Impact",
          data: sorted.map((driver) => driver.magnitude),
          backgroundColor: sorted.map((driver) => (driver.direction === "positive" ? "#2ca58d" : "#ff6b6b")),
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      animation: { duration: 600 },
      plugins: {
        tooltip: {
          callbacks: {
            label: (context) => `${context.label}: ${context.parsed.x.toFixed(3)}`,
          },
        },
        annotation: {
          annotations: {
            zero: {
              type: "line",
              xMin: 0,
              xMax: 0,
              borderColor: "#9aa7c3",
              borderWidth: 1,
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            callback: (value) => (typeof value === "number" ? value.toFixed(2) : value),
          },
        },
      },
    },
  });
}
function renderImpactRadar() {
  if (charts.radar) {
    charts.radar.destroy();
    charts.radar = null;
  }
  const impacts = state.explanations?.feature_impacts ?? buildFeatureImpactsFromPredictions();
  if (!impacts || impacts.length === 0) {
    impactRadarMessage.textContent = "Radar impacts will populate when explanations are available.";
    return;
  }
  impactRadarMessage.textContent = "";
  const labels = impacts.map((impact) => impact.feature ?? "Feature");
  const data = impacts.map((impact) => impact.score ?? impact.magnitude ?? 0);
  charts.radar = new Chart(impactRadarCanvas, {
    type: "radar",
    data: {
      labels,
      datasets: [
        {
          label: "Scaled impact",
          data,
          backgroundColor: "rgba(0, 119, 182, 0.2)",
          borderColor: "#0077b6",
          pointBackgroundColor: "#0077b6",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      scales: {
        r: {
          beginAtZero: true,
          ticks: { backdropColor: "transparent" },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (context) => `${context.label}: ${context.parsed.r.toFixed(2)}`,
          },
        },
      },
    },
  });
}

function renderThresholdTable() {
  thresholdTableBody.innerHTML = "";
  const thresholds = state.explanations?.calibrated_thresholds ?? state.predictions?.[0]?.calibrated_thresholds;
  if (!thresholds) {
    thresholdMessage.textContent = "Thresholds will appear once calibration artifacts are available.";
    return;
  }
  thresholdMessage.textContent = "";
  const entries = Array.isArray(thresholds)
    ? thresholds
    : Object.entries(thresholds).map(([modelKey, value]) => ({ model: modelKey, threshold: value }));
  entries.forEach((entry) => {
    const row = document.createElement("tr");
    const modelLabel = entry.model
      ? state.modelConfig.find((model) => model.key === entry.model)?.label ?? formatModelLabel(entry.model)
      : entry.label ?? "Model";
    const comment = entry.commentary ?? entry.comment ?? "";
    const thresholdValue = typeof entry.threshold === "number" ? entry.threshold : entry.value ?? entry;
    row.innerHTML = `
      <td>${modelLabel}</td>
      <td>${formatProbability(thresholdValue)}</td>
      <td>${comment}</td>
    `;
    thresholdTableBody.append(row);
  });
}

function populateHistorySelectors() {
  const entries = extractHistoryEntries(state.history);
  const teams = Array.from(new Set(entries.map((entry) => entry.team))).sort();
  const models = Array.from(new Set(entries.map((entry) => entry.model))).sort();
  if (historyTeamSelect && historyTeamSelect.options.length === 0) {
    historyTeamSelect.innerHTML = teams.map((team) => `<option value="${team}">${team}</option>`).join("");
  }
  if (historyModelSelect && historyModelSelect.options.length === 0) {
    historyModelSelect.innerHTML = models
      .map((modelKey) => {
        const label = state.modelConfig.find((model) => model.key === modelKey)?.label ?? formatModelLabel(modelKey);
        return `<option value="${modelKey}">${label}</option>`;
      })
      .join("");
  }
}

function renderHistoryChart() {
  if (!historyChartCanvas) return;
  if (charts.history) {
    charts.history.destroy();
    charts.history = null;
  }
  const entries = extractHistoryEntries(state.history);
  if (entries.length === 0) {
    historyChartMessage.textContent = "Historical trajectories are unavailable.";
    return;
  }
  const team = historyTeamSelect?.value || entries[0]?.team;
  const modelKey = historyModelSelect?.value || entries[0]?.model;
  const metric = historyMetricSelect?.value || state.metric;
  const filtered = entries
    .filter((entry) => (!team || entry.team === team) && (!modelKey || entry.model === modelKey))
    .sort((a, b) => Number(a.season) - Number(b.season));
  if (filtered.length === 0) {
    historyChartMessage.textContent = "No historical data for the selected filters.";
    return;
  }
  historyChartMessage.textContent = "";
  const labels = filtered.map((entry) => entry.season);
  const data = filtered.map((entry) => entry.metrics?.[metric]);
  const color = state.modelConfig.find((model) => model.key === modelKey)?.color ?? "#1f77b4";
  charts.history = new Chart(historyChartCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: `${formatModelLabel(modelKey)} • ${METRIC_LABELS[metric] ?? metric}`,
          data,
          borderColor: color,
          backgroundColor: color,
          tension: 0.2,
          spanGaps: true,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      animation: { duration: 600 },
      scales: {
        y: {
          beginAtZero: metric !== "logloss",
          ticks: { callback: (value) => formatMetricValue(value, metric) },
        },
      },
      plugins: {
        zoom: {
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: "xy",
          },
          pan: { enabled: true, mode: "xy" },
        },
      },
    },
  });
}

function aggregateDriversFromPredictions() {
  const accumulator = new Map();
  state.predictions.forEach((prediction) => {
    (prediction?.top_drivers ?? []).forEach((driver) => {
      if (!driver?.feature || typeof driver?.magnitude !== "number") return;
      const current = accumulator.get(driver.feature) || { feature: driver.feature, magnitude: 0, direction: driver.direction };
      current.magnitude += driver.magnitude;
      current.direction = driver.direction || current.direction;
      accumulator.set(driver.feature, current);
    });
  });
  return Array.from(accumulator.values());
}

function buildFeatureImpactsFromPredictions() {
  const drivers = aggregateDriversFromPredictions();
  const total = drivers.reduce((sum, driver) => sum + Math.abs(driver.magnitude), 0);
  if (total === 0) return [];
  return drivers.map((driver) => ({
    feature: driver.feature,
    score: Math.abs(driver.magnitude) / total,
  }));
}

function extractHistoryEntries(historyData) {
  if (!historyData) return [];
  if (Array.isArray(historyData.entries)) return historyData.entries;
  if (Array.isArray(historyData)) return historyData;
  if (historyData.teams) {
    const entries = [];
    Object.entries(historyData.teams).forEach(([team, models]) => {
      Object.entries(models ?? {}).forEach(([modelKey, metricsBySeason]) => {
        Object.entries(metricsBySeason ?? {}).forEach(([season, metrics]) => {
          entries.push({ team, model: modelKey, season, metrics });
        });
      });
    });
    return entries;
  }
  return [];
}

function getProbability(prediction, key) {
  if (!prediction?.probs) return null;
  const value = prediction.probs[key];
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    if (typeof value.blended === "number") return value.blended;
    if (typeof value.win === "number") return value.win;
  }
  return null;
}

function getAdjustedProbability(prediction) {
  if (prediction?.adjusted_probs?.sos?.blended != null) return prediction.adjusted_probs.sos.blended;
  if (prediction?.probs?.sos_adjusted?.blended != null) return prediction.probs.sos_adjusted.blended;
  if (prediction?.probs?.sos_adjusted != null && typeof prediction.probs.sos_adjusted === "number") {
    return prediction.probs.sos_adjusted;
  }
  return null;
}

function formatProbability(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatConfidenceInterval(ci) {
  if (!ci) return "—";
  const low = typeof ci.low === "number" ? (ci.low * 100).toFixed(1) : null;
  const high = typeof ci.high === "number" ? (ci.high * 100).toFixed(1) : null;
  if (low == null || high == null) {
    if (typeof ci.mid === "number") return `${(ci.mid * 100).toFixed(1)}%`;
    return "—";
  }
  return `${low}% – ${high}%`;
}

function formatNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

function formatMetricValue(value, metricKey) {
  if (typeof value !== "number" || Number.isNaN(value)) return "n/a";
  const precision = metricKey === "logloss" ? 3 : 3;
  return value.toFixed(precision);
}

function formatModelLabel(key) {
  if (!key) return "Model";
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function heatmapColor(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "var(--accent-soft)";
  const clamped = Math.max(0, Math.min(1, value));
  if (clamped < 0.33) return "var(--heatmap-low)";
  if (clamped < 0.66) return "var(--heatmap-mid)";
  return "var(--heatmap-high)";
}

function highlightText(text, query) {
  if (!query) return text;
  const pattern = new RegExp(`(${escapeRegExp(query)})`, "gi");
  return text.replace(pattern, '<mark>$1</mark>');
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function debounce(fn, delay = 200) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

function setLoader(element, isLoading) {
  if (!element) return;
  element.hidden = !isLoading;
  element.setAttribute("aria-hidden", String(!isLoading));
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  toast.dataset.visible = "true";
  setTimeout(() => {
    toast.dataset.visible = "false";
    toast.hidden = true;
  }, 4000);
}

function setStatus(message) {
  statusMessage.textContent = message;
}

function buildStatusMessage() {
  const parts = [];
  parts.push(
    state.predictions.length > 0
      ? "Predictions loaded successfully."
      : "Predictions are not yet available for this selection."
  );
  parts.push(
    state.weekMetrics
      ? "Week-level metrics loaded."
      : "Week-level metrics will appear once games are complete."
  );
  parts.push(
    seasonMetricsCache.get(state.season)?.weeks
      ? "Season trajectory metrics ready."
      : "Season trajectory metrics pending."
  );
  return parts.join(" ");
}

// Export state and functions globally for enhanced app integration
window.state = state;
window.charts = charts;
window.DEFAULT_MODEL_CONFIG = DEFAULT_MODEL_CONFIG;
window.seasonMetricsCache = seasonMetricsCache;
window.renderPredictions = renderPredictions;
window.loadWeekContext = loadWeekContext;
window.showToast = showToast;
