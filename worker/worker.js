// worker/worker.js
// Cloudflare Worker serving predictions, context, explain scorecards, models,
// diagnostics, metrics, outcomes, and history endpoints backed by GitHub artifacts.

const REPO_USER = "impreet01";
const REPO_NAME = "PerdictionNFL";
const BRANCH = "main";

const RAW_BASE = `https://raw.githubusercontent.com/${REPO_USER}/${REPO_NAME}/${BRANCH}/artifacts`;
const GH_API_LIST = `https://api.github.com/repos/${REPO_USER}/${REPO_NAME}/contents/artifacts?ref=${BRANCH}`;
const CACHE_TTL = 900;
const GH_HEADERS = { "User-Agent": "cf-worker" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function baseHeaders(status = 200, extra = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": status === 200 ? `public, max-age=${CACHE_TTL}` : "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "*",
    Vary: "Origin",
    ...extra
  };
}

function json(obj, status = 200, options = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: baseHeaders(status, options.headers)
  });
}

const toInt = (value, field) => {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new HttpError(400, `${field} must be an integer`);
  }
  return num;
};

const coerceInt = (value) => {
  const num = Number(value);
  return Number.isFinite(num) && Number.isInteger(num) ? num : null;
};

async function listArtifacts() {
  const resp = await fetch(GH_API_LIST, { headers: GH_HEADERS });
  if (!resp.ok) {
    throw new HttpError(resp.status || 502, `GitHub API list failed: ${resp.status}`);
  }
  try {
    return await resp.json();
  } catch (err) {
    throw new HttpError(502, "Failed to parse GitHub listing");
  }
}

function parseWeekFiles(listing, prefix) {
  const out = [];
  const regex = new RegExp(`^${prefix}_(\\d{4})_W(\\d{2})\\.json$`, "i");
  for (const item of listing || []) {
    if (!item || item.type !== "file") continue;
    const match = regex.exec(item.name);
    if (!match) continue;
    out.push({ season: Number(match[1]), week: Number(match[2]), name: item.name });
  }
  out.sort((a, b) => (b.season - a.season) || (b.week - a.week));
  return out;
}

function parseSeasonFiles(listing, prefix) {
  const out = [];
  const regex = new RegExp(`^${prefix}_(\\d{4})\\.json$`, "i");
  for (const item of listing || []) {
    if (!item || item.type !== "file") continue;
    const match = regex.exec(item.name);
    if (!match) continue;
    out.push({ season: Number(match[1]), name: item.name });
  }
  out.sort((a, b) => b.season - a.season);
  return out;
}

async function fetchJsonFile(file) {
  const url = `${RAW_BASE}/${file}`;
  const resp = await fetch(url, { cf: { cacheEverything: true, cacheTtl: CACHE_TTL } });
  if (!resp.ok) {
    if (resp.status === 404) {
      throw new HttpError(404, `artifact not found: ${file}`);
    }
    throw new HttpError(502, `failed to fetch artifact ${file} (status ${resp.status})`);
  }
  const text = await resp.text();
  try {
    const data = JSON.parse(text);
    return {
      data,
      etag: resp.headers.get("etag"),
      lastModified: resp.headers.get("last-modified")
    };
  } catch (err) {
    throw new HttpError(502, `invalid JSON in artifact ${file}`);
  }
}

async function resolveSeasonWeek(prefix, seasonParam, weekParam, listing) {
  const seasonInput = toInt(seasonParam, "season");
  const weekInput = toInt(weekParam, "week");
  const data = listing || (await listArtifacts());
  const parsed = parseWeekFiles(data, prefix);
  if (!parsed.length) {
    throw new HttpError(404, `no ${prefix} artifacts found`);
  }
  let season = seasonInput;
  let week = weekInput;
  if (season == null) {
    season = parsed[0].season;
  }
  const candidates = parsed.filter((p) => p.season === season);
  if (!candidates.length) {
    throw new HttpError(404, `no ${prefix} artifacts for season ${season}`);
  }
  if (week == null) {
    week = candidates[0].week;
  }
  const exact = candidates.find((p) => p.week === week);
  if (!exact) {
    throw new HttpError(404, `${prefix} artifact missing for season ${season} week ${week}`);
  }
  return { season, week, file: exact.name, listing: data };
}

async function resolveSeasonFile(prefix, seasonParam, listing) {
  const seasonInput = toInt(seasonParam, "season");
  const data = listing || (await listArtifacts());
  const parsed = parseSeasonFiles(data, prefix);
  if (!parsed.length) {
    throw new HttpError(404, `no ${prefix} artifacts found`);
  }
  let season = seasonInput;
  if (season == null) {
    season = parsed[0].season;
  }
  const exact = parsed.find((p) => p.season === season);
  if (!exact) {
    throw new HttpError(404, `no ${prefix} artifact for season ${season}`);
  }
  return { season, file: exact.name, listing: data };
}

async function respondWithArtifact(prefix, url, options = {}) {
  const resolved = await resolveSeasonWeek(
    prefix,
    url.searchParams.get("season"),
    url.searchParams.get("week"),
    options.listing
  );
  const { data, etag, lastModified } = await fetchJsonFile(resolved.file);
  return json(
    { season: resolved.season, week: resolved.week, data },
    200,
    { headers: filterCacheHeaders({ etag, lastModified }) }
  );
}

async function respondWithSeasonArtifact(prefix, url, options = {}) {
  const resolved = await resolveSeasonFile(prefix, url.searchParams.get("season"), options.listing);
  const { data, etag, lastModified } = await fetchJsonFile(resolved.file);
  return json(
    { season: resolved.season, data },
    200,
    { headers: filterCacheHeaders({ etag, lastModified }) }
  );
}

function filterCacheHeaders({ etag, lastModified }) {
  const headers = {};
  if (etag) headers.ETag = etag;
  if (lastModified) headers["Last-Modified"] = lastModified;
  return headers;
}

async function healthResponse(url) {
  const listing = await listArtifacts();
  const predictions = parseWeekFiles(listing, "predictions");
  if (!predictions.length) {
    throw new HttpError(404, "no prediction artifacts found");
  }
  const seasonParam = url.searchParams.get("season");
  let season = toInt(seasonParam, "season");
  if (season == null) {
    season = predictions[0].season;
  }
  const forSeason = predictions.filter((p) => p.season === season);
  if (!forSeason.length) {
    throw new HttpError(404, `no predictions for season ${season}`);
  }
  const modelMap = new Map(
    parseWeekFiles(listing, "model").map((m) => [`${m.season}-${m.week}`, m.name])
  );
  const injuriesMap = new Map(
    parseWeekFiles(listing, "injuries").map((entry) => [`${entry.season}-${entry.week}`, entry.name])
  );
  const weeks = [...forSeason]
    .sort((a, b) => a.week - b.week)
    .map((p) => ({
      week: p.week,
      predictions_file: p.name,
      model_file: modelMap.get(`${season}-${p.week}`) || null,
      injuries_file: injuriesMap.get(`${season}-${p.week}`) || null
    }));
  const latestWeek = weeks.length ? weeks[weeks.length - 1].week : null;
  return json({ season, latest_week: latestWeek, weeks });
}

async function weeksResponse(url) {
  const listing = await listArtifacts();
  const predictions = parseWeekFiles(listing, "predictions");
  if (!predictions.length) {
    throw new HttpError(404, "no prediction artifacts found");
  }
  const seasonParam = url.searchParams.get("season");
  let season = toInt(seasonParam, "season");
  if (season == null) {
    season = predictions[0].season;
  }
  const forSeason = predictions.filter((p) => p.season === season);
  if (!forSeason.length) {
    throw new HttpError(404, `no predictions for season ${season}`);
  }
  const weeks = [...new Set(forSeason.map((p) => p.week))].sort((a, b) => a - b);
  const latestWeek = weeks.length ? weeks[weeks.length - 1] : null;
  return json({ season, latest_week: latestWeek, weeks });
}

async function contextCurrentResponse() {
  const { data, etag, lastModified } = await fetchJsonFile("context_current.json");
  return json(
    {
      season: coerceInt(data?.season),
      built_through_week: coerceInt(data?.built_through_week),
      data
    },
    200,
    { headers: filterCacheHeaders({ etag, lastModified }) }
  );
}

async function artifactResponse(url) {
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    throw new HttpError(400, "path query parameter required");
  }
  const normalized = rawPath.replace(/^\/+/u, "");
  if (!normalized || normalized.includes("..")) {
    throw new HttpError(400, "invalid path");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) {
    throw new HttpError(400, "invalid path");
  }
  const relative = normalized.startsWith("artifacts/") ? normalized.slice("artifacts/".length) : normalized;
  const { data, etag, lastModified } = await fetchJsonFile(relative);
  return json(data, 200, { headers: filterCacheHeaders({ etag, lastModified }) });
}

async function leaderboardResponse(url) {
  const METRICS = new Set(["accuracy", "auc", "logloss", "brier"]);
  const metricParam = (url.searchParams.get("metric") || "accuracy").toLowerCase();
  if (!METRICS.has(metricParam)) {
    throw new HttpError(400, "metric must be one of accuracy, auc, logloss, brier");
  }
  const resolved = await resolveSeasonFile("metrics", url.searchParams.get("season"));
  const { data: metrics, etag, lastModified } = await fetchJsonFile(resolved.file);
  const cumulative = metrics?.cumulative;
  if (!cumulative || typeof cumulative !== "object") {
    throw new HttpError(404, `metrics cumulative section missing for season ${resolved.season}`);
  }
  const entries = Object.entries(cumulative)
    .map(([model, values]) => ({ model, value: values?.[metricParam] }))
    .filter((entry) => Number.isFinite(entry.value));
  const ascending = metricParam === "logloss" || metricParam === "brier";
  entries.sort((a, b) => (ascending ? a.value - b.value : b.value - a.value));
  return json(
    { season: resolved.season, metric: metricParam, leaderboard: entries },
    200,
    { headers: filterCacheHeaders({ etag, lastModified }) }
  );
}

function filterHistory(predictions, predicate) {
  const hits = [];
  for (const entry of predictions) {
    const arr = Array.isArray(entry.data) ? entry.data : [];
    for (const game of arr) {
      if (predicate(game)) {
        hits.push({ season: entry.season, week: entry.week, game });
      }
    }
  }
  hits.sort((a, b) => (a.season - b.season) || (a.week - b.week));
  return hits;
}

async function historyResponse(query, mode) {
  const listing = await listArtifacts();
  const parsed = parseWeekFiles(listing, "predictions");
  if (!parsed.length) {
    throw new HttpError(404, "no prediction artifacts found");
  }
  const seasonParam = query.get("season");
  const seasonFilter = seasonParam ? toInt(seasonParam, "season") : null;
  if (seasonFilter != null && !parsed.some((p) => p.season === seasonFilter)) {
    throw new HttpError(404, `no predictions for season ${seasonFilter}`);
  }
  const seasonsToLoad = seasonFilter != null
    ? [seasonFilter]
    : [...new Set(parsed.map((p) => p.season))].sort((a, b) => a - b);
  const payload = [];
  for (const item of parsed) {
    if (!seasonsToLoad.includes(item.season)) continue;
    const { data } = await fetchJsonFile(item.name).catch(() => ({ data: [] }));
    payload.push({ season: item.season, week: item.week, data: Array.isArray(data) ? data : [] });
  }
  let predicate;
  const filter = { season: seasonFilter };
  if (mode === "team") {
    const team = query.get("team");
    if (!team) {
      throw new HttpError(400, "team query parameter required");
    }
    const teamUpper = team.trim().toUpperCase();
    if (!teamUpper) {
      throw new HttpError(400, "team query parameter required");
    }
    filter.team = teamUpper;
    predicate = (game) =>
      game.home_team?.toUpperCase() === teamUpper || game.away_team?.toUpperCase() === teamUpper;
  } else {
    const home = query.get("home");
    const away = query.get("away");
    if (!home || !away) {
      throw new HttpError(400, "home and away query parameters required");
    }
    const homeUpper = home.trim().toUpperCase();
    const awayUpper = away.trim().toUpperCase();
    if (!homeUpper || !awayUpper) {
      throw new HttpError(400, "home and away query parameters required");
    }
    filter.home = homeUpper;
    filter.away = awayUpper;
    predicate = (game) =>
      game.home_team?.toUpperCase() === homeUpper && game.away_team?.toUpperCase() === awayUpper;
  }
  const filtered = filterHistory(payload, predicate).map((entry) => ({
    season: entry.season,
    week: entry.week,
    game_id: entry.game?.game_id ?? null,
    home_team: entry.game?.home_team ?? null,
    away_team: entry.game?.away_team ?? null,
    forecast: entry.game?.forecast ?? null,
    probs: entry.game?.probs ?? null,
    blend_weights: entry.game?.blend_weights ?? null,
    calibration: entry.game?.calibration ?? null,
    top_drivers: entry.game?.top_drivers ?? null,
    natural_language: entry.game?.natural_language ?? null,
    actual: entry.game?.actual ?? null
  }));
  return { filter, data: filtered };
}

function corsPreflight() {
  return new Response(null, { status: 204, headers: baseHeaders(204) });
}

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return corsPreflight();
    }
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/") {
        return json({ ok: true, message: "nfl predictions worker" });
      }
      if (path === "/health") {
        return await healthResponse(url);
      }
      if (path === "/status") {
        return await healthResponse(url);
      }
      if (path === "/weeks") {
        return await weeksResponse(url);
      }
      if (path === "/season/index") {
        return await respondWithSeasonArtifact("season_index", url);
      }
      if (path === "/season/summary") {
        return await respondWithSeasonArtifact("season_summary", url);
      }
      if (path === "/predictions") {
        return await respondWithArtifact("predictions", url);
      }
      if (path === "/predictions/current") {
        return await respondWithArtifact("predictions", url);
      }
      if (path === "/context") {
        return await respondWithArtifact("context", url);
      }
      if (path === "/context/current") {
        return await contextCurrentResponse();
      }
      if (path === "/injuries") {
        return await respondWithArtifact("injuries", url);
      }
      if (path === "/injuries/current") {
        return await respondWithArtifact("injuries", url);
      }
      if (path === "/weather") {
        return await respondWithArtifact("weather", url);
      }
      if (path === "/weather/current") {
        return await respondWithArtifact("weather", url);
      }
      if (path === "/explain") {
        return await respondWithArtifact("explain", url);
      }
      if (path === "/models") {
        return await respondWithArtifact("model", url);
      }
      if (path === "/diagnostics") {
        return await respondWithArtifact("diagnostics", url);
      }
      if (path === "/outcomes") {
        return await respondWithArtifact("outcomes", url);
      }
      if (path === "/metrics/week") {
        return await respondWithArtifact("metrics", url);
      }
      if (path === "/metrics/season") {
        return await respondWithSeasonArtifact("metrics", url);
      }
      if (path === "/leaderboard") {
        return await leaderboardResponse(url);
      }
      if (path === "/history/team") {
        const { filter, data } = await historyResponse(url.searchParams, "team");
        return json({ team: filter.team, season: filter.season, data });
      }
      if (path === "/history/game") {
        const { filter, data } = await historyResponse(url.searchParams, "matchup");
        return json({ home: filter.home, away: filter.away, season: filter.season, data });
      }
      if (path === "/artifact") {
        return await artifactResponse(url);
      }
      return json({ error: "Unknown endpoint" }, 404);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: String(err?.message || err) }, status);
    }
  }
};
