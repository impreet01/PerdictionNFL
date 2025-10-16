// worker/worker.js
// Cloudflare Worker serving predictions, context, explain scorecards, models,
// diagnostics, metrics, outcomes, and history endpoints backed by GitHub artifacts.

const DEFAULT_REPO_USER = "impreet01";
const DEFAULT_REPO_NAME = "PerdictionNFL";
const DEFAULT_BRANCH = "main";
const DEFAULT_CACHE_TTL = 900;

const globalEnv = typeof process !== "undefined" && process?.env ? process.env : {};

const runtimeConfig = {
  repoUser: globalEnv.REPO_USER || DEFAULT_REPO_USER,
  repoName: globalEnv.REPO_NAME || DEFAULT_REPO_NAME,
  branch: globalEnv.REPO_BRANCH || globalEnv.BRANCH || DEFAULT_BRANCH,
  cacheTtl: Number(globalEnv.CACHE_TTL) > 0 ? Number(globalEnv.CACHE_TTL) : DEFAULT_CACHE_TTL
};

let artifactCache = null;

function bindArtifactCache(env = {}) {
  artifactCache = env && env.ARTIFACT_CACHE ? env.ARTIFACT_CACHE : null;
}

function resolveConfig() {
  const { repoUser, repoName, branch, cacheTtl } = runtimeConfig;
  return {
    repoUser,
    repoName,
    branch,
    cacheTtl,
    rawBase: `https://raw.githubusercontent.com/${repoUser}/${repoName}/${branch}/artifacts`,
    treeApi: `https://api.github.com/repos/${repoUser}/${repoName}/git/trees/${branch}?recursive=1`
  };
}

function applyRuntimeConfig(env = {}) {
  if (env.REPO_USER) runtimeConfig.repoUser = env.REPO_USER;
  if (env.REPO_NAME) runtimeConfig.repoName = env.REPO_NAME;
  if (env.REPO_BRANCH || env.BRANCH) runtimeConfig.branch = env.REPO_BRANCH || env.BRANCH;
  const ttl = Number(env.CACHE_TTL);
  if (Number.isFinite(ttl) && ttl > 0) runtimeConfig.cacheTtl = ttl;
  bindArtifactCache(env);
}

const CACHE_TTL = () => resolveConfig().cacheTtl;
const GH_HEADERS = { "User-Agent": "cf-worker" };

const RATE_BUCKETS = new Map();
const RATE_LIMIT_DEFAULT = 120;

function enforceRateLimit(request, env = {}) {
  const limit = Number(env.RATE_LIMIT_PER_MINUTE ?? RATE_LIMIT_DEFAULT);
  if (!Number.isFinite(limit) || limit <= 0) return;
  const windowMs = 60_000;
  const now = Date.now();
  const key =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "global";
  const bucket = RATE_BUCKETS.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  RATE_BUCKETS.set(key, bucket);
  if (bucket.count > limit) {
    throw new HttpError(429, "rate limit exceeded");
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function baseHeaders(status = 200, extra = {}) {
  const { cacheTtl } = resolveConfig();
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": status === 200 ? `public, max-age=${cacheTtl}` : "no-store",
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

const toInt = (value, field, defaultValue = 0) => {
  if (value == null || value === "") return defaultValue;
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
  const { treeApi } = resolveConfig();
  const resp = await fetch(treeApi, { headers: GH_HEADERS });
  if (!resp.ok) {
    throw new HttpError(resp.status || 502, `GitHub API list failed: ${resp.status}`);
  }

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    throw new HttpError(502, "Failed to parse GitHub listing");
  }

  if (!body || typeof body !== "object" || !Array.isArray(body.tree)) {
    throw new HttpError(502, "Unexpected GitHub tree response");
  }

  if (body.truncated) {
    throw new HttpError(502, "GitHub tree listing truncated; cannot load artifacts");
  }

  return body.tree
    .filter((item) => item?.type === "blob" && item?.path?.startsWith("artifacts/"))
    .map((item) => ({
      type: "file",
      name: item.path.slice("artifacts/".length)
    }));
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
  const { rawBase, cacheTtl } = resolveConfig();
  const url = `${rawBase}/${file}`;
  const cacheKey = `artifact:${file}`;
  if (artifactCache) {
    const cached = await artifactCache.get(cacheKey, { type: "json" }).catch(() => null);
    if (cached && typeof cached === "object" && cached.data != null) {
      return cached;
    }
  }
  const resp = await fetch(url, { cf: { cacheEverything: true, cacheTtl } });
  if (!resp.ok) {
    if (resp.status === 404) {
      throw new HttpError(404, `artifact not found: ${file}`);
    }
    throw new HttpError(502, `failed to fetch artifact ${file} (status ${resp.status})`);
  }
  const text = await resp.text();
  try {
    const data = JSON.parse(text);
    const result = {
      data,
      etag: resp.headers.get("etag"),
      lastModified: resp.headers.get("last-modified")
    };
    if (artifactCache) {
      await artifactCache.put(cacheKey, JSON.stringify(result), {
        expirationTtl: CACHE_TTL()
      });
    }
    return result;
  } catch (err) {
    throw new HttpError(502, `invalid JSON in artifact ${file}`);
  }
}

async function fetchResolvedJson(resolved) {
  const candidates = Array.isArray(resolved?.candidates) && resolved.candidates.length
    ? resolved.candidates
    : [resolved.file];
  let lastNotFoundError = null;
  for (const candidate of candidates) {
    try {
      const result = await fetchJsonFile(candidate);
      resolved.file = candidate;
      return result;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        lastNotFoundError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastNotFoundError || new HttpError(404, "artifact not found");
}

function preferHybridPredictionFile(listing, season, week, fallback) {
  if (!Array.isArray(listing)) {
    return fallback;
  }
  const paddedWeek = String(week).padStart(2, "0");
  const hybridName = `predictions_${season}_W${paddedWeek}_hybrid_v2.json`;
  const match = listing.find((item) => item?.name === hybridName && item?.type === "file");
  return match ? hybridName : fallback;
}

function buildWeekFilename(prefix, season, week) {
  const paddedWeek = String(week).padStart(2, "0");
  return `${prefix}_${season}_W${paddedWeek}.json`;
}

function buildWeekCandidates(prefix, season, week) {
  const baseFile = buildWeekFilename(prefix, season, week);
  if (prefix === "predictions") {
    const paddedWeek = String(week).padStart(2, "0");
    const hybridFile = `predictions_${season}_W${paddedWeek}_hybrid_v2.json`;
    return [hybridFile, baseFile];
  }
  return [baseFile];
}

async function resolveSeasonWeek(prefix, seasonParam, weekParam, listing) {
  const seasonInput = toInt(seasonParam, "season", null);
  const weekInput = toInt(weekParam, "week", null);
  let data = listing;
  let listingError = null;
  if (!data) {
    try {
      data = await listArtifacts();
    } catch (err) {
      listingError = err;
    }
  }

  if (!Array.isArray(data)) {
    if (listingError && seasonInput != null && weekInput != null && listingError.status === 403) {
      return {
        season: seasonInput,
        week: weekInput,
        file: buildWeekFilename(prefix, seasonInput, weekInput),
        candidates: buildWeekCandidates(prefix, seasonInput, weekInput),
        listing: null
      };
    }
    if (listingError) {
      throw listingError;
    }
  }

  const dataListing = Array.isArray(data) ? data : [];
  const parsed = parseWeekFiles(dataListing, prefix);
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
  let file = exact.name;
  if (prefix === "predictions") {
    file = preferHybridPredictionFile(dataListing, season, week, file);
  }
  return { season, week, file, candidates: [file], listing: dataListing };
}

async function resolveSeasonFile(prefix, seasonParam, listing) {
  const seasonInput = toInt(seasonParam, "season", null);
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
  const { data, etag, lastModified } = await fetchResolvedJson(resolved);
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

function parseCsvParam(raw) {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeTeamCodes(values) {
  return new Set(values.map((value) => value.toUpperCase()));
}

function normalizeStatuses(values) {
  return new Set(values.map((value) => value.toUpperCase()));
}

function paginateArray(source, url, options = {}) {
  const {
    defaultChunkSize = 1,
    maxChunkSize = 50,
    chunkParam = "chunk",
    sizeParam = "chunk_size"
  } = options;

  const rawChunk = url.searchParams.get(chunkParam);
  const rawSize = url.searchParams.get(sizeParam);

  let chunkSize = rawSize != null ? toInt(rawSize, sizeParam, defaultChunkSize) : defaultChunkSize;
  if (chunkSize == null || chunkSize <= 0) {
    throw new HttpError(400, `${sizeParam} must be a positive integer`);
  }
  if (chunkSize > maxChunkSize) {
    chunkSize = maxChunkSize;
  }

  let chunk = rawChunk != null ? toInt(rawChunk, chunkParam, 1) : 1;
  if (chunk == null || chunk <= 0) {
    throw new HttpError(400, `${chunkParam} must be a positive integer`);
  }

  const totalItems = Array.isArray(source) ? source.length : 0;
  const totalChunks = totalItems === 0 ? 0 : Math.ceil(totalItems / chunkSize);

  if (totalChunks > 0 && chunk > totalChunks) {
    throw new HttpError(400, `${chunkParam} must be between 1 and ${totalChunks}`);
  }

  const startIndex = totalChunks === 0 ? 0 : (chunk - 1) * chunkSize;
  const endIndex = totalChunks === 0 ? 0 : Math.min(startIndex + chunkSize, totalItems);
  const data = source.slice(startIndex, endIndex);

  const pagination = {
    chunk: totalChunks === 0 ? 0 : chunk,
    chunk_size: chunkSize,
    total_items: totalItems,
    total_chunks: totalChunks,
    has_next: totalChunks > 0 && chunk < totalChunks,
    has_previous: totalChunks > 0 && chunk > 1
  };
  if (pagination.has_next) {
    pagination.next_chunk = chunk + 1;
  }
  if (pagination.has_previous) {
    pagination.previous_chunk = chunk - 1;
  }

  return { data, pagination };
}

async function respondWithInjuries(url) {
  const resolved = await resolveSeasonWeek(
    "injuries",
    url.searchParams.get("season"),
    url.searchParams.get("week")
  );
  const { data, etag, lastModified } = await fetchResolvedJson(resolved);
  const source = Array.isArray(data) ? data : [];

  const filters = {};
  let filtered = source;

  const teamParam = url.searchParams.get("team");
  if (teamParam) {
    const teams = normalizeTeamCodes(parseCsvParam(teamParam));
    if (!teams.size) {
      throw new HttpError(400, "team query parameter must include at least one value");
    }
    filtered = filtered.filter((entry) => teams.has(String(entry.team || "").toUpperCase()));
    filters.teams = [...teams];
  }

  const statusParam = url.searchParams.get("status");
  if (statusParam) {
    const statuses = normalizeStatuses(parseCsvParam(statusParam));
    if (!statuses.size) {
      throw new HttpError(400, "status query parameter must include at least one value");
    }
    filtered = filtered.filter((entry) => statuses.has(String(entry.status || "").toUpperCase()));
    filters.statuses = [...statuses];
  }

  const limitParam = url.searchParams.get("limit");
  if (limitParam != null) {
    const limit = toInt(limitParam, "limit", null);
    if (limit == null || limit <= 0) {
      throw new HttpError(400, "limit must be a positive integer");
    }
    filtered = filtered.slice(0, limit);
    filters.limit = limit;
  }

  const { data: chunked, pagination } = paginateArray(filtered, url, {
    defaultChunkSize: 150,
    maxChunkSize: 500
  });

  const body = {
    season: resolved.season,
    week: resolved.week,
    data: chunked,
    pagination
  };
  if (Object.keys(filters).length) {
    body.filters = filters;
  }

  return json(body, 200, { headers: filterCacheHeaders({ etag, lastModified }) });
}

async function respondWithContext(url) {
  const resolved = await resolveSeasonWeek(
    "context",
    url.searchParams.get("season"),
    url.searchParams.get("week")
  );
  const { data, etag, lastModified } = await fetchResolvedJson(resolved);
  const source = Array.isArray(data) ? data : [];

  const filters = {};
  let filtered = source;

  const gameIdParam = url.searchParams.get("game_id");
  if (gameIdParam) {
    const normalizedGame = gameIdParam.trim();
    if (!normalizedGame) {
      throw new HttpError(400, "game_id query parameter must not be empty");
    }
    filtered = source.filter(
      (entry) => String(entry?.game_id || "").toUpperCase() === normalizedGame.toUpperCase()
    );
    if (!filtered.length) {
      throw new HttpError(404, `no context found for game_id ${normalizedGame}`);
    }
    filters.game_id = normalizedGame;
  } else {
    const teamParam = url.searchParams.get("team");
    if (teamParam) {
      const normalizedTeam = teamParam.trim().toUpperCase();
      if (!normalizedTeam) {
        throw new HttpError(400, "team query parameter must not be empty");
      }
      filtered = source.filter((entry) => {
        const home = String(entry?.home_team || "").toUpperCase();
        const away = String(entry?.away_team || "").toUpperCase();
        return home === normalizedTeam || away === normalizedTeam;
      });
      if (!filtered.length) {
        throw new HttpError(404, `no context found for team ${normalizedTeam}`);
      }
      filters.team = normalizedTeam;
    }
  }

  const filteredLength = filtered.length || 0;
  const defaultChunkSize = filters.game_id
    ? Math.max(1, filteredLength)
    : filters.team
      ? Math.min(Math.max(1, filteredLength), 3)
      : Math.min(Math.max(1, filteredLength), 2);
  const maxChunkSize = filters.game_id ? Math.max(1, filteredLength) : 4;

  const { data: chunked, pagination } = paginateArray(filtered, url, {
    defaultChunkSize,
    maxChunkSize
  });

  const body = {
    season: resolved.season,
    week: resolved.week,
    data: chunked,
    pagination
  };
  if (Object.keys(filters).length) {
    body.filters = filters;
  }
  if (!filters.game_id) {
    body.available_games = source.map((entry) => ({
      game_id: entry?.game_id ?? null,
      home_team: entry?.home_team ?? null,
      away_team: entry?.away_team ?? null
    }));
  }
  if (!filters.team && !filters.game_id) {
    const teams = new Set();
    for (const entry of source) {
      if (entry?.home_team) teams.add(String(entry.home_team).toUpperCase());
      if (entry?.away_team) teams.add(String(entry.away_team).toUpperCase());
    }
    body.available_teams = [...teams].sort();
  }

  return json(body, 200, { headers: filterCacheHeaders({ etag, lastModified }) });
}

async function healthResponse(url) {
  const listing = await listArtifacts();
  const predictions = parseWeekFiles(listing, "predictions");
  if (!predictions.length) {
    throw new HttpError(404, "no prediction artifacts found");
  }
  const seasonParam = url.searchParams.get("season");
  let season = toInt(seasonParam, "season", null);
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
      predictions_file: preferHybridPredictionFile(listing, season, p.week, p.name),
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
  let season = toInt(seasonParam, "season", null);
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
  const seasonFilter = seasonParam ? toInt(seasonParam, "season", null) : null;
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
  async fetch(req, env) {
    applyRuntimeConfig(env);
    if (req.method === "OPTIONS") {
      return corsPreflight();
    }
    enforceRateLimit(req, env);
    try {
      enforceRateLimit(req, env);
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
        return await respondWithContext(url);
      }
      if (path === "/context/current") {
        return await contextCurrentResponse();
      }
      if (path === "/injuries") {
        return await respondWithInjuries(url);
      }
      if (path === "/injuries/current") {
        return await respondWithInjuries(url);
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
