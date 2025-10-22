// trainer/contextPack.js
// Builds per-game context for a given week with rolling form, QB trends, injuries, venue, and market.

import fs from "node:fs";
import path from "node:path";
import {
  loadSchedules,
  loadTeamWeekly,
  loadPlayerWeekly,
  loadInjuries,
  loadESPNQBR,
  loadMarkets,
  loadWeather
} from "./dataSources.js";
import { loadElo } from "./eloLoader.js";
import { resolveCurrentWeek } from "../scripts/resolveWeek.js";
import { validateArtifact } from "./schemaValidator.js";
import { ZERO_SNAPSHOT, buildTeamInjuryIndex, getTeamInjurySnapshot } from "./injuryIndex.js";
import { normalizeTeam } from "./teamNormalizer.js";
import { artifactsRoot } from "./utils/paths.js";

const ARTIFACTS_DIR = artifactsRoot();
const INJURY_DATA_MIN_SEASON = 2009;

const NEUTRAL_WEATHER_TEMPLATE = Object.freeze({
  summary: "Neutral historical conditions",
  details: null,
  notes: null,
  temperature_f: 70,
  precipitation_chance: 0,
  wind_mph: 0,
  impact_score: 0,
  kickoff_display: null,
  location: null,
  forecast_provider: "neutral",
  forecast_links: [],
  icon: null,
  fetched_at: null,
  is_dome: null
});

const NEUTRAL_MARKET_TEMPLATE = Object.freeze({
  spread: 0,
  spread_home: 0,
  spread_away: 0,
  moneyline_home: 100,
  moneyline_away: 100,
  moneyline_draw: null,
  total: null,
  source: "neutral",
  fetched_at: null
});

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function clampProb(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(value, 0), 1);
}

function impliedMoneyline(line) {
  const ml = Number(line);
  if (!Number.isFinite(ml)) return null;
  const value = 1 / (1 + Math.pow(10, -ml / 100));
  return clampProb(value);
}

const normTeam = (value) => {
  const norm = normalizeTeam(value);
  if (norm) return norm;
  if (value == null) return null;
  const s = String(value).trim().toUpperCase();
  return s || null;
};

const envFlag = (name) => {
  const value = process.env[name];
  if (value == null) return false;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

function ensureArtifactsDir() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function neutralWeatherContext() {
  return {
    ...NEUTRAL_WEATHER_TEMPLATE,
    forecast_links: [],
    fetched_at: null
  };
}

function neutralMarketContext({ season, week, home, away }) {
  return enrichMarketProbabilities({
    ...NEUTRAL_MARKET_TEMPLATE,
    season,
    week,
    home_team: home,
    away_team: away
  });
}

function normaliseWeatherLocation(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;
  if (str.toLowerCase() === "in") return "Landover, MD";
  return str;
}

function enrichMarketProbabilities(market) {
  if (!market || typeof market !== "object") return market;
  const enriched = { ...market };
  if (Number.isFinite(enriched.spread_home)) {
    const spreadProb = sigmoid(enriched.spread_home / 7);
    enriched.implied_prob_spread_home = clampProb(spreadProb);
    enriched.implied_prob_spread_away = clampProb(1 - spreadProb);
  }
  if (Number.isFinite(enriched.moneyline_home)) {
    enriched.implied_prob_home = impliedMoneyline(enriched.moneyline_home);
  }
  if (Number.isFinite(enriched.moneyline_away)) {
    enriched.implied_prob_away = impliedMoneyline(-enriched.moneyline_away);
  }
  if (Number.isFinite(enriched.moneyline_draw)) {
    enriched.implied_prob_draw = impliedMoneyline(enriched.moneyline_draw);
  }
  return enriched;
}

function neutralInjurySnapshot() {
  return {
    ...ZERO_SNAPSHOT,
    players_out: [],
    player_positions: {},
    player_status: {}
  };
}

function filterSeasonWeek(rows, season, week) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => {
    if (!row || typeof row !== "object") return false;
    if (Number(row.season) !== season) return false;
    const candidates = [row.week, row.week_number, row.game_week, row.week_id];
    for (const candidate of candidates) {
      const wk = Number(candidate);
      if (Number.isFinite(wk)) {
        return wk === week;
      }
    }
    return true;
  });
}

function validateSnapshot(kind, payload, schemaName) {
  try {
    validateArtifact(schemaName, payload);
    return true;
  } catch (err) {
    console.warn(`[contextPack] ${kind} snapshot validation skipped: ${err?.message || err}`);
    return false;
  }
}

function writeCurrentSnapshot(kind, payload) {
  ensureArtifactsDir();
  const file = path.join(ARTIFACTS_DIR, `current_${kind}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function appendHistoricalSnapshot(kind, payload) {
  ensureArtifactsDir();
  const file = path.join(ARTIFACTS_DIR, `historical_${kind}.json`);
  let existing = [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) existing = parsed;
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(`[contextPack] Unable to read ${file}: ${err?.message || err}`);
    }
  }
  existing.push(payload);
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
}

function persistSnapshot(kind, rows, season, week, schemaName) {
  const payload = {
    season,
    week,
    generated_at: new Date().toISOString(),
    data: Array.isArray(rows) ? rows : []
  };
  if (!validateSnapshot(kind, payload, schemaName)) return;
  const serialised = JSON.parse(JSON.stringify(payload));
  writeCurrentSnapshot(kind, serialised);
  if (envFlag("HISTORICAL_APPEND")) {
    appendHistoricalSnapshot(kind, serialised);
  }
}

function toNum(v, def = null) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function rollingAvg(arr, k) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const s = Math.max(0, i - k + 1);
    const slice = arr.slice(s, i + 1)
      .map((val) => toNum(val, null))
      .filter((val) => Number.isFinite(val));
    if (!slice.length) {
      out.push(null);
      continue;
    }
    const sum = slice.reduce((acc, val) => acc + val, 0);
    out.push(sum / slice.length);
  }
  return out;
}

function gameKey(season, week, home, away) {
  return `${season}-W${String(week).padStart(2, "0")}-${home}-${away}`;
}

function pickValue(row, keys = []) {
  for (const key of keys) {
    if (row?.[key] != null && row[key] !== "") return row[key];
  }
  return null;
}

function extractWeeklySeries(rows, weeklyKeys = [], cumulativeKeys = []) {
  const weekly = rows.map((r) => pickValue(r, weeklyKeys));
  if (weekly.some((v) => v != null && v !== "")) {
    return weekly.map((v) => toNum(v, null));
  }
  const cumulative = rows.map((r) => pickValue(r, cumulativeKeys));
  const cumulativeNums = cumulative.map((v) => toNum(v, null));
  const out = [];
  let lastValid = null;
  for (let i = 0; i < cumulativeNums.length; i++) {
    const current = cumulativeNums[i];
    if (!Number.isFinite(current)) {
      out.push(null);
      continue;
    }
    if (!Number.isFinite(lastValid)) {
      out.push(current);
    } else {
      out.push(current - lastValid);
    }
    lastValid = current;
  }
  return out.map((v) => (Number.isFinite(v) ? v : null));
}

function buildInjuryMap(rows, season, week) {
  const out = new Map();
  for (const r of rows || []) {
    if (Number(r.season) !== season) continue;
    const wk = Number(r.week);
    if (Number.isFinite(wk) && wk > week) continue;
    const team = normTeam(r.team ?? r.team_abbr ?? r.team_code);
    if (!team) continue;
    const status = String(r.status || r.injury_status || "").toLowerCase();
    const player = r.player || r.player_name || r.gsis_id || "unknown";
    const bucket = status.includes("out") || status.includes("ir") || status.includes("susp") ? "out" :
      status.includes("question") || status.includes("doubt") || status.includes("probable") || status.includes("limited")
        ? "questionable"
        : null;
    if (!bucket) continue;
    if (!out.has(team)) out.set(team, { out: [], questionable: [] });
    out.get(team)[bucket].push(player);
  }
  return out;
}

function buildEloMap(rows, season, week) {
  const map = new Map();
  for (const r of rows || []) {
    if (Number(r.season) !== season) continue;
    const wk = Number(r.week);
    if (!Number.isFinite(wk) || wk !== week) continue;
    const home = normTeam(r.home_team ?? r.home ?? r.home_team_abbr);
    const away = normTeam(r.away_team ?? r.away ?? r.away_team_abbr);
    if (!home || !away) continue;
    const key = gameKey(season, wk, home, away);
    const homeE = toNum(r.elo_home ?? r.home_elo ?? r.elo_pre_home ?? r.elo_home_pre);
    const awayE = toNum(r.elo_away ?? r.away_elo ?? r.elo_pre_away ?? r.elo_away_pre);
    const spread = r.spread_home != null ? toNum(r.spread_home) : r.spread != null ? toNum(r.spread) : null;
    map.set(key, {
      home: homeE,
      away: awayE,
      diff: homeE - awayE,
      spread_home: Number.isFinite(spread) ? spread : null
    });
  }
  return map;
}

function cloneMarket(raw) {
  if (!raw || typeof raw !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(raw));
  } catch {
    return { ...raw };
  }
}

function buildMarketMap(rows, season, week) {
  const map = new Map();
  for (const r of rows || []) {
    if (Number(r.season) !== season) continue;
    const wk = Number(r.week);
    if (Number.isFinite(week) && Number.isFinite(wk) && wk !== week) continue;
    const home = normTeam(r.home_team ?? r.home ?? r.home_team_abbr);
    const away = normTeam(r.away_team ?? r.away ?? r.away_team_abbr);
    if (!home || !away) continue;
    const key = gameKey(season, Number.isFinite(wk) ? wk : week, home, away);
    const marketRaw = r.market || r.markets || null;
    if (!marketRaw || typeof marketRaw !== "object") continue;
    const market = cloneMarket(marketRaw) || {};
    if (market && !Number.isFinite(market.spread) && Number.isFinite(market.spread_home)) {
      market.spread = market.spread_home;
    }
    if (market && !Number.isFinite(market.total) && Number.isFinite(market.total_points)) {
      market.total = market.total_points;
    }
    market.rotowire_game_id = r.rotowire_game_id ?? r.game_id ?? r.gameID ?? null;
    market.market_url = r.market_url ?? market.market_url ?? null;
    market.home_team = home;
    market.away_team = away;
    market.season = season;
    market.week = Number.isFinite(wk) ? wk : week;
    if (!market.fetched_at) market.fetched_at = r.fetched_at ?? null;
    market.source = market.source ?? r.source ?? "rotowire";
    map.set(key, enrichMarketProbabilities(market));
  }
  return map;
}

function cleanWeatherLinks(links = []) {
  if (!Array.isArray(links)) return [];
  const out = [];
  for (const link of links) {
    if (!link || typeof link !== "object") continue;
    const url = link.url ?? link.href ?? null;
    if (!url) continue;
    out.push({
      label: link.label ?? link.name ?? null,
      url
    });
  }
  return out;
}

export function shapeWeatherContext(entry) {
  if (!entry || typeof entry !== "object") return null;
  const temp = Number(entry.temperature_f);
  const precip = Number(entry.precipitation_chance);
  const wind = Number(entry.wind_mph);
  const impact = Number(entry.impact_score);
  const shaped = {
    summary: entry.summary ?? null,
    details: entry.details ?? null,
    notes: entry.notes ?? null,
    temperature_f: Number.isFinite(temp) ? temp : null,
    precipitation_chance: Number.isFinite(precip) ? precip : null,
    wind_mph: Number.isFinite(wind) ? wind : null,
    impact_score: Number.isFinite(impact) ? impact : null,
    kickoff_display: entry.kickoff_display ?? null,
    location: normaliseWeatherLocation(entry.location ?? null),
    forecast_provider: entry.forecast_provider ?? null,
    forecast_links: cleanWeatherLinks(entry.forecast_links),
    icon: entry.icon ?? null,
    fetched_at: entry.fetched_at ?? null,
    is_dome: entry.is_dome ?? null
  };
  return shaped;
}

function buildWeatherMap(rows, season, week) {
  const map = new Map();
  for (const r of rows || []) {
    if (Number(r.season) !== season) continue;
    const wk = Number(r.week);
    if (Number.isFinite(week) && Number.isFinite(wk) && wk !== week) continue;
    const home = normTeam(r.home_team ?? r.home ?? r.home_team_abbr);
    const away = normTeam(r.away_team ?? r.away ?? r.away_team_abbr);
    if (!home || !away) continue;
    const key = gameKey(season, Number.isFinite(wk) ? wk : week, home, away);
    const shaped = shapeWeatherContext(r);
    if (!shaped) continue;
    map.set(key, shaped);
  }
  return map;
}

function buildQBRHistory(rows, season) {
  const map = new Map();
  for (const r of rows || []) {
    if (Number(r.season) !== season) continue;
    const wk = Number(r.week ?? r.game_week ?? r.week_number);
    if (!Number.isFinite(wk)) continue;
    const team = normTeam(r.team ?? r.team_abbr ?? r.recent_team ?? r.posteam);
    if (!team) continue;
    const qbr = toNum(r.qbr_total ?? r.qbr ?? r.total_qbr ?? r.qbr_raw ?? r.espn_qbr ?? r.qbr_offense);
    if (!map.has(team)) map.set(team, []);
    map.get(team).push({ week: wk, qbr });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.week - b.week);
  return map;
}

function latestQBR(entries = [], week) {
  if (!entries.length) return null;
  let val = null;
  for (const entry of entries) {
    if (Number.isFinite(week) && entry.week > week) break;
    val = entry.qbr;
  }
  return val ?? entries.at(-1)?.qbr ?? null;
}

export async function buildContextForWeek(season, week) {
  const y = Number(season);
  const w = Number(week);
  if (!Number.isFinite(y) || !Number.isFinite(w)) return [];

  const schedules = await loadSchedules(y);
  let teamWeekly = [];
  let playerWeekly = [];
  let injuries = [];
  let qbrRows = [];
  let eloRows = [];
  let marketRows = [];
  let weatherRows = [];
  try { teamWeekly = await loadTeamWeekly(y); } catch (err) { console.warn("teamWeekly load failed", err?.message ?? err); }
  try { playerWeekly = await loadPlayerWeekly(y); } catch (err) { console.warn("playerWeekly load failed", err?.message ?? err); }
  try { injuries = await loadInjuries(y); } catch (err) { console.warn("injuries load failed", err?.message ?? err); }
  try { qbrRows = await loadESPNQBR(y); } catch (err) { /* optional */ }
  try { eloRows = await loadElo(y); } catch (err) { console.warn("elo load failed", err?.message ?? err); }
  try { marketRows = await loadMarkets(y); } catch (err) { console.warn("market load failed", err?.message ?? err); }
  try { weatherRows = await loadWeather(y); } catch (err) { console.warn("weather load failed", err?.message ?? err); }

  let currentWeekResolved = null;
  try {
    currentWeekResolved = await resolveCurrentWeek({ season: y });
  } catch (err) {
    console.warn(`[contextPack] unable to resolve current week: ${err?.message || err}`);
  }

  const isHistoricalWeek = Number.isFinite(currentWeekResolved) && w < currentWeekResolved;
  const injuriesAvailable = !isHistoricalWeek && y >= INJURY_DATA_MIN_SEASON;
  if (!injuriesAvailable) injuries = [];
  const shouldPersistCurrent = !Number.isFinite(currentWeekResolved) || w >= currentWeekResolved;

  if (shouldPersistCurrent) {
    const injurySnapshot = filterSeasonWeek(injuries, y, w);
    const weatherSnapshot = filterSeasonWeek(weatherRows, y, w);
    const marketSnapshot = filterSeasonWeek(marketRows, y, w);
    persistSnapshot("injuries", injurySnapshot, y, w, "injury_pull");
    persistSnapshot("weather", weatherSnapshot, y, w, "weather_pull");
    persistSnapshot("markets", marketSnapshot, y, w, "market_pull");
  }

  const games = schedules.filter((g) => Number(g.season) === y && Number(g.week) === w);
  if (!games.length) return [];

  const byTeam = new Map();
  for (const row of teamWeekly || []) {
    if (Number(row.season) !== y) continue;
    const team = normTeam(row.team ?? row.team_abbr ?? row.recent_team ?? row.posteam);
    if (!team) continue;
    const wk = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(wk)) continue;
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push({ ...row, _week: wk });
  }

  const qbHistory = buildQBRHistory(qbrRows, y);
  const injuryMapRaw = buildInjuryMap(injuries, y, w);
  const injuryIndexRaw = buildTeamInjuryIndex(injuries, y);
  const injuryMap = injuriesAvailable ? injuryMapRaw : new Map();
  const injuryIndex = injuriesAvailable ? injuryIndexRaw : new Map();
  const eloMap = buildEloMap(eloRows, y, w);
  const marketMapRaw = buildMarketMap(marketRows, y, w);
  const weatherMapRaw = buildWeatherMap(weatherRows, y, w);
  const marketMap = isHistoricalWeek ? new Map() : marketMapRaw;
  const weatherMap = isHistoricalWeek ? new Map() : weatherMapRaw;

  for (const [team, rows] of byTeam.entries()) {
    rows.sort((a, b) => a._week - b._week);
    const yardsFor = extractWeeklySeries(rows, ["total_yards", "off_total_yards", "off_total_yds", "yards_gained"], ["off_total_yds_s2d", "total_yards_s2d"]);
    const yardsAgainst = extractWeeklySeries(rows, ["yards_allowed", "total_yards_allowed", "def_total_yards", "def_total_yds"], ["def_total_yds_s2d", "yards_allowed_s2d"]);
    const passYards = extractWeeklySeries(rows, ["passing_yards", "pass_yards", "pass_yds"], ["off_pass_yds_s2d"]);
    const passAtt = extractWeeklySeries(rows, ["pass_attempts", "passing_attempts", "attempts", "pass_att"], ["off_pass_att_s2d"]);
    const sacks = extractWeeklySeries(rows, ["sacks", "sacks_taken", "qb_sacked"], ["off_sacks_taken_s2d"]);

    const ypaSeries = passYards.map((yds, idx) => {
      const yards = toNum(yds, null);
      const attempts = toNum(passAtt[idx], 0);
      if (!Number.isFinite(yards) || attempts <= 0) return null;
      return yards / attempts;
    });
    const sackRateSeries = sacks.map((s, idx) => {
      const sackVal = toNum(s, null);
      const attempts = toNum(passAtt[idx], 0);
      const totalPlays = attempts + toNum(s, 0);
      if (!Number.isFinite(sackVal) || totalPlays <= 0) return null;
      return sackVal / totalPlays;
    });

    const roll3For = rollingAvg(yardsFor, 3);
    const roll5For = rollingAvg(yardsFor, 5);
    const roll3Against = rollingAvg(yardsAgainst, 3);
    const roll5Against = rollingAvg(yardsAgainst, 5);
    const roll3Ypa = rollingAvg(ypaSeries, 3);
    const roll5Ypa = rollingAvg(ypaSeries, 5);
    const roll3Sack = rollingAvg(sackRateSeries, 3);
    const roll5Sack = rollingAvg(sackRateSeries, 5);

    rows.forEach((row, idx) => {
      row._roll3_for = roll3For[idx];
      row._roll5_for = roll5For[idx];
      row._roll3_against = roll3Against[idx];
      row._roll5_against = roll5Against[idx];
      row._roll3_net =
        Number.isFinite(roll3For[idx]) && Number.isFinite(roll3Against[idx])
          ? roll3For[idx] - roll3Against[idx]
          : null;
      row._roll5_net =
        Number.isFinite(roll5For[idx]) && Number.isFinite(roll5Against[idx])
          ? roll5For[idx] - roll5Against[idx]
          : null;
      row._qb_ypa3 = roll3Ypa[idx];
      row._qb_ypa5 = roll5Ypa[idx];
      row._qb_sack3 = roll3Sack[idx];
      row._qb_sack5 = roll5Sack[idx];
    });
  }

  const out = [];
  for (const g of games) {
    const home = normTeam(g.home_team);
    const away = normTeam(g.away_team);
    if (!home || !away) continue;
    const gid = gameKey(y, w, home, away);

    const hRows = byTeam.get(home) || [];
    const aRows = byTeam.get(away) || [];
    const hLast = hRows.filter((r) => r._week <= w).at(-1) ?? hRows.at(-1) ?? {};
    const aLast = aRows.filter((r) => r._week <= w).at(-1) ?? aRows.at(-1) ?? {};

    const roof = String(g.roof ?? g.roof_type ?? "").toLowerCase();
    const surfaceRaw = g.surface ?? g.surface_type ?? g.surface_short ?? null;
    const isDome = roof.includes("dome") || roof.includes("closed") || roof.includes("roof");
    const isOutdoor = roof.includes("outdoor") || roof.includes("open") || (!roof && !isDome);

    const qbrHome = latestQBR(qbHistory.get(home) || [], w);
    const qbrAway = latestQBR(qbHistory.get(away) || [], w);

    const eloInfo = eloMap.get(gid) || null;
    let marketInfo;
    if (isHistoricalWeek) {
      marketInfo = neutralMarketContext({ season: y, week: w, home, away });
    } else {
      marketInfo = marketMap.get(gid) || null;
      if (!marketInfo && eloInfo && Number.isFinite(eloInfo.spread_home)) {
        marketInfo = {
          spread: eloInfo.spread_home,
          spread_home: eloInfo.spread_home,
          spread_away: Number.isFinite(eloInfo.spread_home) ? -eloInfo.spread_home : null,
          source: "elo",
          fetched_at: null,
          season: y,
          week: w,
          home_team: home,
          away_team: away
        };
      }
      marketInfo = enrichMarketProbabilities(marketInfo);
    }

    const weatherEntry = weatherMap.get(gid) || null;
    const weatherInfo = weatherEntry || (isHistoricalWeek ? neutralWeatherContext() : null);

    const injuryHome = injuriesAvailable
      ? getTeamInjurySnapshot(injuryIndex, y, w, home)
      : neutralInjurySnapshot();
    const injuryAway = injuriesAvailable
      ? getTeamInjurySnapshot(injuryIndex, y, w, away)
      : neutralInjurySnapshot();
    const injuryHomePrev = injuriesAvailable
      ? getTeamInjurySnapshot(injuryIndex, y, w - 1, home)
      : neutralInjurySnapshot();
    const injuryAwayPrev = injuriesAvailable
      ? getTeamInjurySnapshot(injuryIndex, y, w - 1, away)
      : neutralInjurySnapshot();

    out.push({
      game_id: gid,
      season: y,
      week: w,
      home_team: home,
      away_team: away,
      context: {
        rolling_strength: {
          home: {
            yds_for_3g: hLast._roll3_for ?? null,
            yds_for_5g: hLast._roll5_for ?? null,
            yds_against_3g: hLast._roll3_against ?? null,
            yds_against_5g: hLast._roll5_against ?? null,
            net_yds_3g: hLast._roll3_net ?? null,
            net_yds_5g: hLast._roll5_net ?? null
          },
          away: {
            yds_for_3g: aLast._roll3_for ?? null,
            yds_for_5g: aLast._roll5_for ?? null,
            yds_against_3g: aLast._roll3_against ?? null,
            yds_against_5g: aLast._roll5_against ?? null,
            net_yds_3g: aLast._roll3_net ?? null,
            net_yds_5g: aLast._roll5_net ?? null
          }
        },
        qb_form: {
          home: {
            ypa_3g: hLast._qb_ypa3 ?? null,
            ypa_5g: hLast._qb_ypa5 ?? null,
            sack_rate_3g: hLast._qb_sack3 ?? null,
            sack_rate_5g: hLast._qb_sack5 ?? null,
            qbr: qbrHome
          },
          away: {
            ypa_3g: aLast._qb_ypa3 ?? null,
            ypa_5g: aLast._qb_ypa5 ?? null,
            sack_rate_3g: aLast._qb_sack3 ?? null,
            sack_rate_5g: aLast._qb_sack5 ?? null,
            qbr: qbrAway
          }
        },
        injuries: {
          home_out: injuryMap.get(home)?.out ?? [],
          away_out: injuryMap.get(away)?.out ?? [],
          home_probable: injuryMap.get(home)?.questionable ?? [],
          away_probable: injuryMap.get(away)?.questionable ?? [],
          home_counts: {
            out: injuryHome.out,
            questionable: injuryHome.questionable,
            skill_out: injuryHome.skill_out,
            ol_out: injuryHome.ol_out,
            practice_dnp: injuryHome.practice_dnp,
            out_change: injuryHome.out - injuryHomePrev.out,
            skill_out_change: injuryHome.skill_out - injuryHomePrev.skill_out
          },
          away_counts: {
            out: injuryAway.out,
            questionable: injuryAway.questionable,
            skill_out: injuryAway.skill_out,
            ol_out: injuryAway.ol_out,
            practice_dnp: injuryAway.practice_dnp,
            out_change: injuryAway.out - injuryAwayPrev.out,
            skill_out_change: injuryAway.skill_out - injuryAwayPrev.skill_out
          }
        },
        venue: {
          is_dome: isDome,
          is_outdoor: isOutdoor,
          surface: surfaceRaw || null
        },
        elo: eloInfo,
        market: marketInfo,
        weather: weatherInfo
      }
    });
  }

  return out;
}

export default buildContextForWeek;
