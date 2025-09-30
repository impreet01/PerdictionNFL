// trainer/explainRubric.js
import fs from "node:fs";

export function computeExplainArtifact({ season, week, predictions, context }) {
  const byId = new Map(context.map(c => [c.game_id, c]));
  const thresholds = { elo: 15, spread: 1.5, dYPA: 0.7, dSR: 0.02, dNet: 75, venue_dYPA: 0.5, venue_dSR: 0.03, grass_bad_net: -100 };
  const weights    = { elo: 2.0, market: 1.5, qb_ypa: 1.5, qb_sack: 1.0, rolling_net: 1.0, injuries: 1.0, venue: 0.5, surface: 0.25 };

  const games = predictions.map(g => {
    const cx = byId.get(g.game_id) || null;
    const pick = pickTeam(g);
    const homePick = (pick === g.home_team);

    const elo = cx?.context?.elo || null;
    const market = cx?.context?.market || null;
    const venue = cx?.context?.venue || {};
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

    return {
      game_id: g.game_id,
      home_team: g.home_team,
      away_team: g.away_team,
      pick,
      blended: g?.probs?.blended ?? null,
      support_score: Math.round(score * 100) / 100,
      factors
    };
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
