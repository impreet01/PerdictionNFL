// trainer/explainRubric.js
import fs from "node:fs";

const DEFAULT_THRESHOLDS = Object.freeze({
  elo: 15,
  spread: 1.5,
  dYPA: 0.7,
  dSR: 0.02,
  dNet: 75,
  venue_dYPA: 0.5,
  venue_dSR: 0.03,
  grass_bad_net: -100,
  weather_impact: 0.5,
  weather_wind: 18,
  weather_precip: 60,
  weather_temp_low: 25,
  weather_temp_high: 95
});

const DEFAULT_WEIGHTS = Object.freeze({
  elo: 2.0,
  market: 1.5,
  qb_ypa: 1.5,
  qb_sack: 1.0,
  rolling_net: 1.0,
  injuries: 1.0,
  venue: 0.5,
  surface: 0.25,
  weather: 0.5
});

const THRESHOLD_PATH = "artifacts/explain_thresholds.json";
let activeThresholds = { ...DEFAULT_THRESHOLDS };

function ensureDirectory(filePath) {
  const parts = filePath.split("/").slice(0, -1);
  if (!parts.length) return;
  const dir = parts.join("/");
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(path) {
  try {
    const raw = fs.readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    console.warn(`[explainRubric] Unable to read ${path}: ${err?.message || err}`);
    return null;
  }
}

function writeJsonSafe(path, payload) {
  try {
    ensureDirectory(path);
    fs.writeFileSync(path, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn(`[explainRubric] Failed to persist ${path}: ${err?.message || err}`);
  }
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function quantile(sorted, pct, fallback) {
  if (!Array.isArray(sorted) || !sorted.length) return fallback;
  const clampedPct = clamp(pct, 0, 1);
  const idx = (sorted.length - 1) * clampedPct;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function cloneAndPrune(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const arr = value
      .map((item) => cloneAndPrune(item))
      .filter((item) => {
        if (item === null || item === undefined) return false;
        if (typeof item === "object" && !Array.isArray(item) && !Object.keys(item).length) return false;
        return true;
      });
    return arr.length ? arr : null;
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const cloned = cloneAndPrune(val);
    if (cloned === null || cloned === undefined) continue;
    if (typeof cloned === "object" && !Array.isArray(cloned) && !Object.keys(cloned).length) continue;
    out[key] = cloned;
  }
  return Object.keys(out).length ? out : null;
}

function sanitiseLocation(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;
  if (str.toLowerCase() === "in") return "Landover, MD";
  return str;
}

function sanitizeWeather(info) {
  if (!info || typeof info !== "object") return null;
  const allowedKeys = new Set([
    "summary",
    "details",
    "notes",
    "temperature_f",
    "precipitation_chance",
    "wind_mph",
    "impact_score",
    "kickoff_display",
    "location",
    "forecast_provider",
    "forecast_links",
    "icon",
    "fetched_at",
    "is_dome"
  ]);
  const out = {};
  for (const [key, value] of Object.entries(info)) {
    if (!allowedKeys.has(key)) continue;
    if (key === "forecast_links") {
      if (!Array.isArray(value)) continue;
      const links = value
        .map((link) => {
          if (!link || typeof link !== "object") return null;
          const label = link.label ?? link.text ?? null;
          const url = link.url ?? null;
          if (!url) return null;
          return label ? { label, url } : { url };
        })
        .filter(Boolean);
      if (links.length) out.forecast_links = links;
      continue;
    }
    if (value === null || value === undefined) continue;
    out[key] = key === "location" ? sanitiseLocation(value) : value;
  }
  return Object.keys(out).length ? out : null;
}

function buildContextSnapshot(cx) {
  const ctx = cx?.context;
  if (!ctx || typeof ctx !== "object") return null;
  const snapshot = {};
  const market = cloneAndPrune(ctx.market);
  const venue = cloneAndPrune(ctx.venue);
  const elo = cloneAndPrune(ctx.elo);
  const injuries = cloneAndPrune(ctx.injuries);
  const weather = sanitizeWeather(ctx.weather);
  if (elo) snapshot.elo = elo;
  if (market) snapshot.market = market;
  if (venue) snapshot.venue = venue;
  if (injuries) snapshot.injuries = injuries;
  if (weather) snapshot.weather = weather;
  return Object.keys(snapshot).length ? snapshot : null;
}

function pickTeam(g) {
  const p = g?.probs?.blended;
  if (typeof p === "number") return p >= 0.5 ? g.home_team : g.away_team;
  return g.home_team;
}

function describeDiff(value, label, goodHigh = true, unit = "") {
  const diff = Number(value || 0);
  const sign = diff > 0 ? "+" : diff < 0 ? "" : "±";
  const capped = Math.min(Math.abs(diff), 100);
  const absVal = capped.toFixed(2);
  const direction = diff === 0 ? "even" : diff > 0 ? "edge" : "deficit";
  const framing = diff === 0 ? "balanced" : diff > 0 === goodHigh ? "favorable" : "needs attention";
  const suffix = unit ? `${absVal}${unit}` : absVal;
  return `${label} ${direction} ${sign}${suffix} (${framing})`;
}

function describeRateDeviation(value, baseline, label, higherIsGood, threshold = 0.03) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return null;
  const diff = value - baseline;
  if (Math.abs(diff) < threshold) return null;
  const direction = diff > 0 ? "higher" : "lower";
  const diffPct = Math.abs(diff) * 100;
  const sentiment = diff > 0 === higherIsGood ? "favorable" : "needs attention";
  return `${label} is ${direction} than league average by ${diffPct.toFixed(1)}% (${sentiment}).`;
}

function describeNeutralPassRate(value, baseline, threshold = 0.05) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return null;
  const diff = value - baseline;
  if (Math.abs(diff) < threshold) return null;
  const orientation = diff > 0 ? "pass-heavy" : "run-leaning";
  const direction = diff > 0 ? "above" : "below";
  const diffPct = Math.abs(diff) * 100;
  return `Neutral pass rate is ${diffPct.toFixed(1)}% ${direction} league average (${orientation}).`;
}

export function extractFactorSignals(prediction, contextEntry) {
  if (!prediction || !contextEntry) return null;
  const ctx = contextEntry.context || {};
  const elo = ctx.elo || {};
  const market = ctx.market || {};
  const venue = ctx.venue || {};
  const weather = ctx.weather || {};
  const injuries = ctx.injuries || {};
  const qbH = ctx.qb_form?.home || {};
  const qbA = ctx.qb_form?.away || {};
  const rollH = ctx.rolling_strength?.home || {};
  const rollA = ctx.rolling_strength?.away || {};

  const pick = pickTeam(prediction);
  const homePick = pick === prediction.home_team;
  const pickSign = homePick ? 1 : -1;
  const diffForPick = pickSign * (elo.diff ?? 0);

  const spreadHome = Number.isFinite(market.spread_home) ? market.spread_home : null;
  const favoredHome = spreadHome != null ? spreadHome < 0 : null;
  const pickFavored = favoredHome != null ? favoredHome === homePick : null;
  const spreadMag = spreadHome != null ? Math.abs(spreadHome) : null;

  const dYPA = (homePick ? 1 : -1) * ((qbH.ypa_3g ?? 0) - (qbA.ypa_3g ?? 0));
  const dSR = (homePick ? 1 : -1) * ((qbH.sack_rate_3g ?? 0) - (qbA.sack_rate_3g ?? 0));
  const dNet = (homePick ? 1 : -1) * ((rollH.net_yds_3g ?? 0) - (rollA.net_yds_3g ?? 0));

  const weatherImpact = Number(weather.impact_score);
  const weatherWind = Number(weather.wind_mph);
  const weatherPrecip = Number(weather.precipitation_chance);
  const weatherTemp = Number(weather.temperature_f);

  return {
    eloDiff: diffForPick,
    spreadMagnitude: spreadMag,
    spreadAligned: pickFavored,
    dYPA,
    dSR,
    dNet,
    weatherImpact,
    weatherWind,
    weatherPrecip,
    weatherTemp,
    injuries,
    venue
  };
}

export function calibrateThresholds(samples = [], options = {}) {
  let candidates = Array.isArray(samples) ? samples.filter(Boolean) : [];
  if (!candidates.length) {
    const persisted = readJsonSafe(THRESHOLD_PATH);
    if (persisted && typeof persisted === "object") {
      activeThresholds = { ...DEFAULT_THRESHOLDS, ...persisted };
      return activeThresholds;
    }
    activeThresholds = { ...DEFAULT_THRESHOLDS };
    return activeThresholds;
  }

  const series = {
    elo: [],
    spread: [],
    dYPA: [],
    dSR: [],
    dNet: [],
    wind: [],
    precip: [],
    impact: [],
    tempLow: [],
    tempHigh: []
  };

  for (const sample of candidates) {
    const signals = sample.metrics || sample;
    if (!signals) continue;
    if (Number.isFinite(signals.eloDiff)) series.elo.push(Math.abs(signals.eloDiff));
    if (Number.isFinite(signals.spreadMagnitude)) series.spread.push(Math.abs(signals.spreadMagnitude));
    if (Number.isFinite(signals.dYPA)) series.dYPA.push(Math.abs(signals.dYPA));
    if (Number.isFinite(signals.dSR)) series.dSR.push(Math.abs(signals.dSR));
    if (Number.isFinite(signals.dNet)) series.dNet.push(Math.abs(signals.dNet));
    if (Number.isFinite(signals.weatherWind)) series.wind.push(Math.abs(signals.weatherWind));
    if (Number.isFinite(signals.weatherPrecip)) series.precip.push(Math.abs(signals.weatherPrecip));
    if (Number.isFinite(signals.weatherImpact)) series.impact.push(Math.abs(signals.weatherImpact));
    if (Number.isFinite(signals.weatherTemp)) {
      if (signals.weatherTemp <= 60) series.tempLow.push(signals.weatherTemp);
      if (signals.weatherTemp >= 75) series.tempHigh.push(signals.weatherTemp);
    }
  }

  const thresholds = { ...DEFAULT_THRESHOLDS };
  const sorted = (arr) => arr.slice().sort((a, b) => a - b);
  thresholds.elo = quantile(sorted(series.elo), 0.7, thresholds.elo);
  thresholds.spread = quantile(sorted(series.spread), 0.65, thresholds.spread);
  thresholds.dYPA = quantile(sorted(series.dYPA), 0.7, thresholds.dYPA);
  thresholds.dSR = quantile(sorted(series.dSR), 0.7, thresholds.dSR);
  thresholds.dNet = quantile(sorted(series.dNet), 0.7, thresholds.dNet);
  thresholds.weather_wind = quantile(sorted(series.wind), 0.75, thresholds.weather_wind);
  thresholds.weather_precip = quantile(sorted(series.precip), 0.75, thresholds.weather_precip);
  thresholds.weather_impact = quantile(sorted(series.impact), 0.75, thresholds.weather_impact);
  thresholds.weather_temp_low = quantile(sorted(series.tempLow), 0.4, thresholds.weather_temp_low);
  thresholds.weather_temp_high = quantile(sorted(series.tempHigh), 0.6, thresholds.weather_temp_high);

  activeThresholds = thresholds;
  if (options.persist) {
    writeJsonSafe(THRESHOLD_PATH, thresholds);
  }
  return activeThresholds;
}

export function getExplainThresholds() {
  return { ...activeThresholds };
}

function ensureThresholdsLoaded() {
  if (!activeThresholds || Object.keys(activeThresholds).length === 0) {
    calibrateThresholds();
  }
}

export function computeExplainArtifact({ season, week, predictions, context }) {
  ensureThresholdsLoaded();
  const thresholds = getExplainThresholds();
  const weights = { ...DEFAULT_WEIGHTS };
  const byId = new Map(context.map((c) => [c.game_id, c]));

  const games = predictions.map((g) => {
    const cx = byId.get(g.game_id) || null;
    const pick = pickTeam(g);
    const homePick = pick === g.home_team;

    const signals = extractFactorSignals(g, cx) || {};
    const elo = cx?.context?.elo || null;
    const market = cx?.context?.market || null;
    const venue = cx?.context?.venue || {};
    const weather = cx?.context?.weather || null;
    const inj = cx?.context?.injuries || {};
    const qbH = cx?.context?.qb_form?.home || {};
    const qbA = cx?.context?.qb_form?.away || {};
    const rollH = cx?.context?.rolling_strength?.home || {};
    const rollA = cx?.context?.rolling_strength?.away || {};

    const factors = [];
    let score = 0;
    const add = (name, vote, weight, reason) => {
      const v = Math.max(-1, Math.min(1, vote));
      score += v * weight;
      factors.push({ name, vote: v, weight, reason });
    };

    const voteThr = (x, thrPos, thrNeg = undefined) => {
      const thr = thrNeg == null ? thrPos : thrNeg;
      return x >= thrPos ? +1 : x <= -thr ? -1 : 0;
    };

    if (elo) {
      add(
        "elo",
        voteThr(signals.eloDiff ?? 0, thresholds.elo),
        weights.elo,
        `Elo ${signals.eloDiff >= 0 ? "+" : ""}${Math.round(signals.eloDiff ?? 0)} for ${pick}`
      );
    }
    if (market && Number.isFinite(market.spread_home)) {
      const favoredHome = market.spread_home < 0;
      const pickFavored = favoredHome === homePick;
      const mag = Math.abs(market.spread_home);
      const v = mag >= thresholds.spread ? (pickFavored ? +1 : -1) : 0;
      add(
        "market",
        v,
        weights.market,
        pickFavored
          ? `Market favors ${pick} by ${mag}`
          : `Market favors opponent by ${mag}`
      );
    }
    add(
      "qb_ypa",
      voteThr(signals.dYPA ?? 0, thresholds.dYPA),
      weights.qb_ypa,
      `ΔYPA ${signals.dYPA >= 0 ? "+" : ""}${(signals.dYPA ?? 0).toFixed(2)} last 3`
    );
    add(
      "qb_sack",
      (signals.dSR ?? 0) <= -thresholds.dSR ? +1 : (signals.dSR ?? 0) >= thresholds.dSR ? -1 : 0,
      weights.qb_sack,
      `ΔSR ${signals.dSR >= 0 ? "+" : ""}${(signals.dSR ?? 0).toFixed(3)} (lower better)`
    );
    add(
      "rolling_net",
      voteThr(signals.dNet ?? 0, thresholds.dNet),
      weights.rolling_net,
      `ΔNet ${signals.dNet >= 0 ? "+" : ""}${Math.round(signals.dNet ?? 0)} over 3g`
    );

    const starOutPick = (homePick ? inj.home_out : inj.away_out) || [];
    const starOutOpp = (!homePick ? inj.home_out : inj.away_out) || [];
    const starPickQB = starOutPick.some((p) => p.star || p.pos === "QB");
    const starOppQB = starOutOpp.some((p) => p.star || p.pos === "QB");
    let injVote = 0;
    if (starOppQB) injVote += 2;
    if (starPickQB) injVote -= 2;
    const nonQBStars = ["RB", "WR", "TE", "CB", "S", "EDGE", "LB", "DL"];
    const countStars = (arr) =>
      arr.filter((p) => (p.pos === "QB" ? false : p.star || nonQBStars.includes(p.pos))).length;
    injVote += Math.min(2, countStars(starOutOpp));
    injVote -= Math.min(2, countStars(starOutPick));
    if (injVote !== 0) add("injuries", Math.sign(injVote), weights.injuries, `star injuries net ${injVote > 0 ? "favor" : "hurt"} ${pick}`);

    if (venue?.is_dome) {
      const v = (signals.dYPA ?? 0) >= thresholds.venue_dYPA ? +1 : 0;
      add("venue", v, weights.venue, v ? "Dome + better YPA" : "Dome neutral");
    } else if (venue?.is_outdoor) {
      const v = (signals.dSR ?? 0) >= thresholds.venue_dSR ? -1 : 0;
      add("venue", v, weights.venue, v ? "Outdoor + worse sack rate" : "Outdoor neutral");
    }
    if (venue?.surface === "turf") {
      const v = (signals.dYPA ?? 0) >= thresholds.venue_dYPA ? +1 : 0;
      add("surface", v, weights.surface, v ? "Turf + better YPA" : "Turf neutral");
    } else if (venue?.surface === "grass") {
      const v = (signals.dNet ?? 0) <= thresholds.grass_bad_net ? -1 : 0;
      add("surface", v, weights.surface, v ? "Grass + worse recent net yards" : "Grass neutral");
    }

    if (weather) {
      const isDome = weather.is_dome ?? venue?.is_dome ?? null;
      const reasons = [];
      let vote = 0;
      if (isDome === true) {
        vote = +1;
        reasons.push("Indoor conditions limit weather risk");
      } else {
        const impact = Number(weather.impact_score);
        const wind = Number(weather.wind_mph);
        const precip = Number(weather.precipitation_chance);
        const temp = Number(weather.temperature_f);
        if (Number.isFinite(impact) && impact >= thresholds.weather_impact) {
          vote -= 1;
          reasons.push(`Impact score ${impact.toFixed(2)} signals adverse weather`);
        }
        if (Number.isFinite(wind) && wind >= thresholds.weather_wind) {
          vote -= 1;
          reasons.push(`Wind ${wind.toFixed(0)} mph exceeds threshold`);
        }
        if (Number.isFinite(precip) && precip >= thresholds.weather_precip) {
          vote -= 1;
          reasons.push(`Precipitation chance ${precip.toFixed(0)}% is elevated`);
        }
        if (Number.isFinite(temp) && temp <= thresholds.weather_temp_low) {
          vote -= 1;
          reasons.push(`Cold forecast ${temp.toFixed(0)}°F`);
        } else if (Number.isFinite(temp) && temp >= thresholds.weather_temp_high) {
          vote -= 1;
          reasons.push(`Heat forecast ${temp.toFixed(0)}°F`);
        }
        if (!reasons.length) {
          reasons.push("Outdoor forecast appears neutral");
        }
      }
      add("weather", vote, weights.weather, reasons.join("; "));
    }

    const leagueMeans = cx?.context?.league_means || {};
    const third = Number(cx?.context?.off_third_down_pct_s2d ?? 0);
    const red = Number(cx?.context?.off_red_zone_td_pct_s2d ?? 0);
    const sackRate = Number(cx?.context?.off_sack_rate_s2d ?? 0);
    const neutralPass = Number(cx?.context?.off_neutral_pass_rate_s2d ?? 0);
    const advClauses = [];
    const thirdStmt = describeRateDeviation(third, leagueMeans.off_third_down_pct_s2d, "Offensive 3rd-down conversion", true, 0.03);
    if (thirdStmt) advClauses.push(thirdStmt);
    const redStmt = describeRateDeviation(red, leagueMeans.off_red_zone_td_pct_s2d, "Red-zone TD rate", true, 0.03);
    if (redStmt) advClauses.push(redStmt);
    const sackStmt = describeRateDeviation(sackRate, leagueMeans.off_sack_rate_s2d, "Sack rate", false, 0.015);
    if (sackStmt) advClauses.push(sackStmt);
    const neutralStmt = describeNeutralPassRate(neutralPass, leagueMeans.off_neutral_pass_rate_s2d, 0.05);
    if (neutralStmt) advClauses.push(neutralStmt);

    const snapshot = buildContextSnapshot(cx);

    const gameEntry = {
      game_id: g.game_id,
      home_team: g.home_team,
      away_team: g.away_team,
      pick,
      blended: g?.probs?.blended ?? null,
      support_score: Math.round(score * 100) / 100,
      factors
    };
    if (snapshot) gameEntry.context = snapshot;
    if (advClauses.length) gameEntry.trend_notes = advClauses;
    return gameEntry;
  });

  return {
    season,
    week,
    rubric_version: "1.1.0",
    thresholds,
    weights,
    games
  };
}

export async function writeExplainArtifact({ season, week, predictions, context }) {
  ensureThresholdsLoaded();
  const out = computeExplainArtifact({ season, week, predictions, context });
  const name = `artifacts/explain_${season}_W${String(week).padStart(2, "0")}.json`;
  await fs.promises.writeFile(name, JSON.stringify(out, null, 2));
  return name;
}
