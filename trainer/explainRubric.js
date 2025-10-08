// trainer/explainRubric.js
import fs from "node:fs";

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
    out[key] = value;
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

export function computeExplainArtifact({ season, week, predictions, context }) {
  const byId = new Map(context.map(c => [c.game_id, c]));
  const thresholds = {
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
  };
  const weights    = {
    elo: 2.0,
    market: 1.5,
    qb_ypa: 1.5,
    qb_sack: 1.0,
    rolling_net: 1.0,
    injuries: 1.0,
    venue: 0.5,
    surface: 0.25,
    weather: 0.5
  };

  const games = predictions.map(g => {
    const cx = byId.get(g.game_id) || null;
    const pick = pickTeam(g);
    const homePick = (pick === g.home_team);

    const elo = cx?.context?.elo || null;
    const market = cx?.context?.market || null;
    const venue = cx?.context?.venue || {};
    const weather = cx?.context?.weather || null;
    const inj = cx?.context?.injuries || {};
    const qbH = cx?.context?.qb_form?.home || {};
    const qbA = cx?.context?.qb_form?.away || {};
    const rollH = cx?.context?.rolling_strength?.home || {};
    const rollA = cx?.context?.rolling_strength?.away || {};

    const pickSign = homePick ? +1 : -1;
    const dYPA = (homePick ? 1 : -1) * ((qbH.ypa_3g ?? 0) - (qbA.ypa_3g ?? 0));
    const dSR  = (homePick ? 1 : -1) * ((qbH.sack_rate_3g ?? 0) - (qbA.sack_rate_3g ?? 0));
    const dNet = (homePick ? 1 : -1) * ((rollH.net_yds_3g ?? 0) - (rollA.net_yds_3g ?? 0));

    const factors = [];
    let score = 0;
    const add = (name, vote, weight, reason) => { const v=Math.max(-1,Math.min(1,vote)); score += v*weight; factors.push({name, vote:v, weight, reason}); };
    const voteThr = (x, thrPos, thrNeg=undefined) => { const thr = thrNeg==null?thrPos:thrNeg; return x>=thrPos?+1:x<=-thr?-1:0; };

    if (elo) {
      const diffForPick = pickSign * (elo.diff ?? 0);
      add("elo", voteThr(diffForPick, thresholds.elo), weights.elo, `Elo ${diffForPick>=0?"+":""}${Math.round(diffForPick)} for ${pick}`);
    }
    if (market && Number.isFinite(market.spread_home)) {
      const favoredHome = market.spread_home < 0;
      const pickFavored = favoredHome === homePick;
      const mag = Math.abs(market.spread_home);
      const v = mag >= thresholds.spread ? (pickFavored ? +1 : -1) : 0;
      add("market", v, weights.market, pickFavored ? `Market favors ${pick} by ${mag}` : `Market favors opponent by ${mag}`);
    }
    add("qb_ypa", voteThr(dYPA, thresholds.dYPA), weights.qb_ypa, `ΔYPA ${dYPA>=0?"+":""}${dYPA.toFixed(2)} last 3`);
    add("qb_sack", dSR<=-thresholds.dSR?+1:(dSR>=thresholds.dSR?-1:0), weights.qb_sack, `ΔSR ${dSR>=0?"+":""}${dSR.toFixed(3)} (lower better)`);
    add("rolling_net", voteThr(dNet, thresholds.dNet), weights.rolling_net, `ΔNet ${dNet>=0?"+":""}${Math.round(dNet)} over 3g`);

    const starOutPick = (homePick ? inj.home_out : inj.away_out) || [];
    const starOutOpp  = (!homePick ? inj.home_out : inj.away_out) || [];
    const starPickQB = starOutPick.some(p => (p.star || p.pos === "QB"));
    const starOppQB  = starOutOpp.some(p => (p.star || p.pos === "QB"));
    let injVote = 0;
    if (starOppQB) injVote += +2;
    if (starPickQB) injVote += -2;
    const nonQBStars = ["RB","WR","TE","CB","S","EDGE","LB","DL"];
    const countStars = (arr) => arr.filter(p => p.pos === "QB" ? false : (p.star || nonQBStars.includes(p.pos))).length;
    injVote += Math.min(2, countStars(starOutOpp));
    injVote -= Math.min(2, countStars(starOutPick));
    if (injVote !== 0) add("injuries", Math.sign(injVote), weights.injuries, `star injuries net ${injVote>0?"favor":"hurt"} ${pick}`);

    if (venue?.is_dome) {
      const v = dYPA >= thresholds.venue_dYPA ? +1 : 0;
      add("venue", v, weights.venue, v ? "Dome + better YPA" : "Dome neutral");
    } else if (venue?.is_outdoor) {
      const v = dSR >= thresholds.venue_dSR ? -1 : 0;
      add("venue", v, weights.venue, v ? "Outdoor + worse sack rate" : "Outdoor neutral");
    }
    if (venue?.surface === "turf") {
      const v = dYPA >= thresholds.venue_dYPA ? +1 : 0;
      add("surface", v, weights.surface, v ? "Turf + better YPA" : "Turf neutral");
    } else if (venue?.surface === "grass") {
      const v = dNet <= thresholds.grass_bad_net ? -1 : 0;
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
    return gameEntry;
  });

  return {
    season, week,
    rubric_version: "1.0.0",
    thresholds, weights,
    games
  };
}

export async function writeExplainArtifact({ season, week, predictions, context }) {
  const out = computeExplainArtifact({ season, week, predictions, context });
  const name = `artifacts/explain_${season}_W${String(week).padStart(2,"0")}.json`;
  await fs.promises.writeFile(name, JSON.stringify(out, null, 2));
  return name;
}

function pickTeam(g) {
  const p = g?.probs?.blended;
  if (typeof p === "number") return p >= 0.5 ? g.home_team : g.away_team;
  return g.home_team;
}
