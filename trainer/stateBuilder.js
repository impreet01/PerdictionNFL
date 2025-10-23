import { loadSchedules, listDatasetSeasons } from "./dataSources.js";
import { isStrictBatch, clampSeasonsToStrictBounds } from "./lib/strictBatch.js";

const MIN_SEASON = 1999;

function normaliseSeason(value) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

function isRegularSeason(value) {
  if (value == null) return true;
  const str = String(value).trim().toUpperCase();
  return str === "" || str.startsWith("REG");
}

function parseScore(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function hasFinalScore(game) {
  const home = parseScore(game.home_score ?? game.home_points ?? game.home_pts);
  const away = parseScore(game.away_score ?? game.away_points ?? game.away_pts);
  return Number.isFinite(home) && Number.isFinite(away);
}

export async function discoverSeasonRange({ startSeason = null, endSeason = null } = {}) {
  let min = normaliseSeason(startSeason);
  let max = normaliseSeason(endSeason);
  if (min != null && max != null && min > max) {
    [min, max] = [max, min];
  }
  if (min == null || max == null) {
    const seasons = await listDatasetSeasons("teamWeekly").catch(() => []);
    if (!seasons.length) {
      const currentYear = new Date().getFullYear();
      min = min ?? MIN_SEASON;
      max = max ?? currentYear - 1;
    } else {
      const discoveredMin = seasons[0];
      const discoveredMax = seasons[seasons.length - 1];
      if (min == null) min = discoveredMin;
      if (max == null) max = discoveredMax;
    }
  }
  if (min == null) min = MIN_SEASON;
  if (max == null) max = min;
  if (min > max) [min, max] = [max, min];
  return { start: min, end: max };
}

export async function buildSeasonCoverageFromRaw({
  seasons = [],
  startSeason = null,
  endSeason = null
} = {}) {
  let targets = Array.isArray(seasons) ? seasons.map(normaliseSeason).filter((s) => s != null) : [];
  if (!targets.length) {
    const range = await discoverSeasonRange({ startSeason, endSeason });
    targets = [];
    for (let season = range.start; season <= range.end; season += 1) {
      targets.push(season);
    }
  }
  const unique = Array.from(new Set(targets)).sort((a, b) => a - b);
  const coverage = [];
  for (const season of unique) {
    if (season == null) continue;
    const fixture = globalThis.__STATE_BUILDER_FIXTURE__;
    if (fixture && Object.prototype.hasOwnProperty.call(fixture, season)) {
      const weeksRaw = fixture[season];
      const weeks = Array.isArray(weeksRaw)
        ? weeksRaw.map(normaliseSeason).filter((wk) => wk != null)
        : Array.isArray(weeksRaw?.weeks)
          ? weeksRaw.weeks.map(normaliseSeason).filter((wk) => wk != null)
          : [];
      if (weeks.length) {
        coverage.push({ season, weeks: Array.from(new Set(weeks)).sort((a, b) => a - b) });
        continue;
      }
    }
    const schedules = await loadSchedules(season).catch(() => []);
    if (!Array.isArray(schedules) || !schedules.length) continue;
    const weeks = new Set();
    for (const game of schedules) {
      if (!isRegularSeason(game.season_type ?? game.game_type ?? game.game_type2)) continue;
      const weekRaw = normaliseSeason(game.week ?? game.week_id);
      if (weekRaw == null || weekRaw <= 0) continue;
      if (!hasFinalScore(game)) continue;
      weeks.add(weekRaw);
    }
    if (!weeks.size) continue;
    coverage.push({ season, weeks: Array.from(weeks).sort((a, b) => a - b) });
  }
  return applyStrictCoverage(coverage);
}

export function mergeSeasonCoverage(existing = [], incoming = []) {
  const map = new Map();
  const add = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const season = normaliseSeason(entry.season ?? entry.year ?? entry.season_id);
    if (season == null) return;
    const weeks = Array.isArray(entry.weeks) ? entry.weeks.map(normaliseSeason).filter((wk) => wk != null) : [];
    const bucket = map.get(season) ?? new Set();
    for (const wk of weeks) {
      if (wk != null) bucket.add(wk);
    }
    map.set(season, bucket);
  };
  existing.forEach(add);
  incoming.forEach(add);
  const merged = Array.from(map.entries())
    .map(([season, weeks]) => ({ season, weeks: Array.from(weeks).sort((a, b) => a - b) }))
    .sort((a, b) => a.season - b.season);
  return applyStrictCoverage(merged);
}

export function seasonsInRangeMissing({ coverage = [], start, end }) {
  const startSeason = normaliseSeason(start);
  const endSeason = normaliseSeason(end);
  if (startSeason == null || endSeason == null) return [];
  const [low, high] = startSeason <= endSeason ? [startSeason, endSeason] : [endSeason, startSeason];
  const set = new Set(coverage.map((entry) => normaliseSeason(entry.season)).filter((s) => s != null));
  const missing = [];
  for (let season = low; season <= high; season += 1) {
    if (!set.has(season)) missing.push(season);
  }
  return missing;
}

function applyStrictCoverage(entries = []) {
  if (!isStrictBatch()) return entries;
  if (!Array.isArray(entries) || !entries.length) return [];
  const allowed = new Set(
    clampSeasonsToStrictBounds(
      entries
        .map((entry) => normaliseSeason(entry?.season ?? entry?.year ?? entry?.season_id))
        .filter((season) => season != null)
    )
  );
  if (!allowed.size) return [];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const season = normaliseSeason(entry.season ?? entry.year ?? entry.season_id);
      if (season == null || !allowed.has(season)) return null;
      const weeks = Array.isArray(entry.weeks)
        ? entry.weeks.map(normaliseSeason).filter((wk) => wk != null)
        : [];
      return { ...entry, season, weeks };
    })
    .filter(Boolean)
    .sort((a, b) => a.season - b.season);
}

export { MIN_SEASON };
