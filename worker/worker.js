// worker/worker.js
// Cloudflare Worker serving predictions, models, diagnostics, and history endpoints.

const REPO_USER = "impreet01";
const REPO_NAME = "PerdictionNFL";
const BRANCH = "main";

const RAW_BASE = `https://raw.githubusercontent.com/${REPO_USER}/${REPO_NAME}/${BRANCH}/artifacts`;
const GH_API_LIST = `https://api.github.com/repos/${REPO_USER}/${REPO_NAME}/contents/artifacts?ref=${BRANCH}`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=900" : "no-store"
    }
  });

async function listArtifacts() {
  const resp = await fetch(GH_API_LIST, { headers: { "User-Agent": "cf-worker" } });
  if (!resp.ok) throw new Error(`GitHub API list failed: ${resp.status}`);
  return resp.json();
}

function parseFiles(listing, prefix) {
  const out = [];
  const regex = new RegExp(`^${prefix}_(\\d{4})_W(\\d{2})\\.json$`, "i");
  for (const item of listing || []) {
    if (!item || item.type !== "file") continue;
    const m = regex.exec(item.name);
    if (!m) continue;
    out.push({ season: Number(m[1]), week: Number(m[2]), name: item.name });
  }
  out.sort((a, b) => (b.season - a.season) || (b.week - a.week));
  return out;
}

async function resolveSeasonWeek(prefix, seasonParam, weekParam) {
  let season = seasonParam ? Number(seasonParam) : null;
  let week = weekParam ? Number(weekParam) : null;
  if (Number.isFinite(season) && Number.isFinite(week)) return { season, week };
  const listing = await listArtifacts();
  const parsed = parseFiles(listing, prefix);
  if (!parsed.length) throw new Error(`no ${prefix} artifacts found`);
  if (!Number.isFinite(season)) {
    season = parsed[0].season;
  }
  const forSeason = parsed.filter((r) => r.season === season);
  if (!forSeason.length) throw new Error(`no ${prefix} artifacts for season ${season}`);
  if (!Number.isFinite(week)) {
    week = forSeason[0].week;
  }
  return { season, week };
}

async function fetchArtifact(prefix, season, week) {
  const file = `${prefix}_${season}_W${String(week).padStart(2, "0")}.json`;
  const url = `${RAW_BASE}/${file}`;
  const resp = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 900 } });
  if (!resp.ok) throw new Error(`artifact not found for ${season} W${week}`);
  return resp.json();
}

function filterHistory(predictions, predicate) {
  const hits = [];
  for (const entry of predictions) {
    const arr = Array.isArray(entry.data) ? entry.data : [];
    for (const game of arr) {
      if (predicate(game)) {
        hits.push({
          season: entry.season,
          week: entry.week,
          game
        });
      }
    }
  }
  hits.sort((a, b) => (a.season - b.season) || (a.week - b.week));
  return hits;
}

async function historyResponse(query, mode) {
  const team = query.get("team");
  const home = query.get("home");
  const away = query.get("away");
  const seasonParam = query.get("season");
  const listing = await listArtifacts();
  const parsed = parseFiles(listing, "predictions");
  const seasons = seasonParam ? [Number(seasonParam)] : [...new Set(parsed.map((p) => p.season))];
  const payload = [];
  for (const season of seasons) {
    const weeks = parsed.filter((p) => p.season === season);
    for (const wk of weeks) {
      const data = await fetchArtifact("predictions", wk.season, wk.week).catch(() => []);
      payload.push({ season: wk.season, week: wk.week, data });
    }
  }
  let filtered;
  if (mode === "team") {
    if (!team) throw new Error("team query parameter required");
    const teamUpper = team.toUpperCase();
    filtered = filterHistory(payload, (game) =>
      game.home_team?.toUpperCase() === teamUpper || game.away_team?.toUpperCase() === teamUpper
    );
  } else {
    if (!home || !away) throw new Error("home and away query parameters required");
    const homeUpper = home.toUpperCase();
    const awayUpper = away.toUpperCase();
    filtered = filterHistory(payload, (game) =>
      game.home_team?.toUpperCase() === homeUpper && game.away_team?.toUpperCase() === awayUpper
    );
  }
  return filtered.map((entry) => ({
    season: entry.season,
    week: entry.week,
    home_team: entry.game.home_team,
    away_team: entry.game.away_team,
    probs: entry.game.probs,
    blend_weights: entry.game.blend_weights,
    calibration: entry.game.calibration,
    top_drivers: entry.game.top_drivers,
    natural_language: entry.game.natural_language,
    actual: entry.game.actual
  }));
}

export default {
  async fetch(req) {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/predictions") {
        const { season, week } = await resolveSeasonWeek("predictions", url.searchParams.get("season"), url.searchParams.get("week"));
        const data = await fetchArtifact("predictions", season, week);
        return json({ season, week, data });
      }
      if (path === "/models") {
        const { season, week } = await resolveSeasonWeek("model", url.searchParams.get("season"), url.searchParams.get("week"));
        const data = await fetchArtifact("model", season, week);
        return json({ season, week, data });
      }
      if (path === "/diagnostics") {
        const { season, week } = await resolveSeasonWeek("diagnostics", url.searchParams.get("season"), url.searchParams.get("week"));
        const data = await fetchArtifact("diagnostics", season, week);
        return json({ season, week, data });
      }
      if (path === "/history/team") {
        const data = await historyResponse(url.searchParams, "team");
        return json({ data });
      }
      if (path === "/history/game") {
        const data = await historyResponse(url.searchParams, "matchup");
        return json({ data });
      }
      return json({ error: "Unknown endpoint" }, 404);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
  }
};
