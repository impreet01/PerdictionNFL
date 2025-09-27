// trainer/featureBuild.js
//
// Builds per-team rows with season-to-date (S2D) stats, opponent diffs, venue/home flag,
// rest, simple Elo, and "similar opponent (same venue)" aggregates.
// CRITICAL: Sets `win` from schedule final scores, per team perspective.
//           For games without final scores, sets win = null (excluded from training).
//
// Inputs:
//   teamWeekly: rows from nflverse team-week aggregate (includes season, week, team, s2d fields).
//   schedules:  full season schedule with scores when available.
//   prevTeamWeekly: prior-season teamWeekly (for simple Elo carryover).
//
// Output rows (per team, per game): fields named in FEATS plus metadata {season, week, team, opponent, home, win}.
//
// Assumptions:
//  - teamWeekly includes cumulative season-to-date fields for offense/defense (first downs, yards, turnovers, etc).
//  - schedules has: season, week, season_type, home_team, away_team, game_date, home_score/away_score when final.

const FEATS = [
  "off_1st_down_s2d","off_total_yds_s2d","off_rush_yds_s2d","off_pass_yds_s2d","off_turnovers_s2d",
  "def_1st_down_s2d","def_total_yds_s2d","def_rush_yds_s2d","def_pass_yds_s2d","def_turnovers_s2d",
  "wins_s2d","losses_s2d","home",
  "sim_winrate_same_loc_s2d","sim_pointdiff_same_loc_s2d","sim_count_same_loc_s2d",
  "off_total_yds_s2d_minus_opp","def_total_yds_s2d_minus_opp",
  "off_turnovers_s2d_minus_opp","def_turnovers_s2d_minus_opp",
  "elo_pre","elo_diff","rest_days","rest_diff"
];

function isReg(v){ if (v == null) return true; const s=String(v).trim().toUpperCase(); return s==="" || s.startsWith("REG"); }

function number(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function dateOnly(s){ return s ? String(s).slice(0,10) : null; }

function computeRest(prevDate, curDate){
  if (!prevDate || !curDate) return 0;
  const a = new Date(prevDate), b = new Date(curDate);
  const ms = b - a;
  return Math.round(ms / (24*3600*1000));
}

// naive Elo seed from prior season wins (or 1500 baseline)
function seedElo(team, prevTeamWeekly){
  const wins = (prevTeamWeekly || []).filter(r => r.team === team).reduce((s,r)=> s + number(r.wins_s2d), 0);
  if (!Number.isFinite(wins)) return 1500;
  return 1450 + 5 * wins; // modest spread
}

/**
 * Build a per-team lookup of last-played date (to compute rest).
 */
function buildLastDates(schedules, season){
  const m = new Map(); // team -> lastDate
  const reg = schedules.filter(g => number(g.season)===season && isReg(g.season_type));
  reg.sort((a,b)=> String(a.game_date || "").localeCompare(String(b.game_date || "")));
  for (const g of reg){
    const d = dateOnly(g.game_date);
    const H = g.home_team, A = g.away_team;
    if (H) m.set(H, d || m.get(H) || null);
    if (A) m.set(A, d || m.get(A) || null);
  }
  return m;
}

/**
 * Build "similar opponent (same venue)" aggregates from past completed games in current season so far.
 * Very simple heuristic: for each team, average point diff and win rate vs opponents whose
 * S2D yardage +/- turnovers profile is within a loose L1 distance band, evaluated at similar home/away.
 */
function buildSimilarOppAggregates(rowsSoFar){
  // index by team+home flag
  const byTeamHome = new Map(); // key: `${team}-${home}`, value: array of past rows with result (+1/-1)
  for (const r of rowsSoFar){
    if (!(r.win === 0 || r.win === 1)) continue;
    const key = `${r.team}-${r.home}`;
    const arr = byTeamHome.get(key) || [];
    // score diff proxy (not always present); use off/def S2D diffs as proxy
    const pointProxy = number(r.off_total_yds_s2d_minus_opp,0) - number(r.def_total_yds_s2d_minus_opp,0);
    arr.push({ r, pointProxy, win: r.win ? 1 : -1 });
    byTeamHome.set(key, arr);
  }

  function distance(a, b){
    let d=0;
    d += Math.abs(number(a.off_total_yds_s2d) - number(b.off_total_yds_s2d));
    d += Math.abs(number(a.def_total_yds_s2d) - number(b.def_total_yds_s2d));
    d += 50 * Math.abs(number(a.off_turnovers_s2d) - number(b.off_turnovers_s2d));
    d += 50 * Math.abs(number(a.def_turnovers_s2d) - number(b.def_turnovers_s2d));
    return d;
  }

  return function getAgg(team, home, candidate){
    const key = `${team}-${home}`;
    const pool = byTeamHome.get(key) || [];
    if (!pool.length) return { winrate: 0, pointdiff: 0, count: 0 };
    // dynamic band: median distance * 1.5
    const dists = pool.map(e => distance(e.r, candidate)).sort((a,b)=>a-b);
    const med = dists[Math.floor(dists.length/2)] || 0;
    const band = Math.max(50, med * 1.5);
    let sel = pool.filter(e => distance(e.r, candidate) <= band);
    if (!sel.length) sel = pool.slice(0, Math.min(5, pool.length));
    const winrate = sel.reduce((s,e)=> s + (e.win>0 ? 1:0), 0) / sel.length;
    const pointdiff = sel.reduce((s,e)=> s + e.pointProxy, 0) / sel.length;
    return { winrate, pointdiff, count: sel.length };
  };
}

/**
 * Main builder.
 */
export function buildFeatures({ teamWeekly, schedules, season, prevTeamWeekly }) {
  const rows = [];
  const reg = schedules.filter(g => number(g.season)===season && isReg(g.season_type));
  // Build quick lookup of teamWeekly by (team, week)
  const twByKey = new Map(); // `${team}-${week}` -> row
  for (const r of teamWeekly) {
    if (number(r.season)!==season) continue;
    const k = `${r.team}-${number(r.week)}`;
    twByKey.set(k, r);
  }

  // Precompute last dates for rest, and an Elo pre for each team per week (carry last known)
  const lastDateByTeam = new Map(); // mutable as we iterate weeks in order
  const eloByTeam = new Map();      // track evolving elo_pre per team (start at seed)
  // init seeds
  const seenTeams = new Set(reg.flatMap(g => [g.home_team, g.away_team]).filter(Boolean));
  for (const team of seenTeams) eloByTeam.set(team, seedElo(team, prevTeamWeekly));

  // Iterate weeks in order; within each week, iterate games in schedule order
  const weeks = [...new Set(reg.map(g => number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);

  // rows so far for similar-opp aggregates
  const rowsSoFar = [];

  for (const W of weeks){
    const gamesW = reg.filter(g => number(g.week)===W).sort((a,b)=> String(a.game_date||"").localeCompare(String(b.game_date||"")));
    // get accessor for "similar opp (same venue)" based ONLY on past completed rows
    const getAgg = buildSimilarOppAggregates(rowsSoFar);

    for (const g of gamesW){
      const H = g.home_team, A = g.away_team;
      const gameDate = dateOnly(g.game_date);

      // Pull team-week season-to-date rows for this week (S2D should reflect performance up to *this* week)
      const hTW = twByKey.get(`${H}-${W}`) || {};
      const aTW = twByKey.get(`${A}-${W}`) || {};

      // Rest days (days since last game) and rest diff
      const hPrev = lastDateByTeam.get(H) || null;
      const aPrev = lastDateByTeam.get(A) || null;
      const hRest = computeRest(hPrev, gameDate);
      const aRest = computeRest(aPrev, gameDate);
      const restDiff = (hRest||0) - (aRest||0);

      // Elo pre (simple, carried) and diff
      const hElo = number(eloByTeam.get(H), 1500);
      const aElo = number(eloByTeam.get(A), 1500);
      const eloDiff = hElo - aElo;

      // Build base per-team features (home perspective, then away perspective)
      function baseRow(me, op, isHome){
        const diff = (a,b)=> number(a,0) - number(b,0);
        const team = isHome ? H : A;
        const opp  = isHome ? A : H;

        // Similar-opponent aggregates (same venue)
        const agg = getAgg(team, isHome ? 1 : 0, {
          off_total_yds_s2d: number(me.off_total_yds_s2d),
          def_total_yds_s2d: number(me.def_total_yds_s2d),
          off_turnovers_s2d: number(me.off_turnovers_s2d),
          def_turnovers_s2d: number(me.def_turnovers_s2d)
        });

        return {
          season, week: W, team, opponent: opp, home: isHome ? 1 : 0,
          game_date: gameDate,

          off_1st_down_s2d: number(me.off_1st_down_s2d),
          off_total_yds_s2d: number(me.off_total_yds_s2d),
          off_rush_yds_s2d: number(me.off_rush_yds_s2d),
          off_pass_yds_s2d: number(me.off_pass_yds_s2d),
          off_turnovers_s2d: number(me.off_turnovers_s2d),

          def_1st_down_s2d: number(me.def_1st_down_s2d),
          def_total_yds_s2d: number(me.def_total_yds_s2d),
          def_rush_yds_s2d: number(me.def_rush_yds_s2d),
          def_pass_yds_s2d: number(me.def_pass_yds_s2d),
          def_turnovers_s2d: number(me.def_turnovers_s2d),

          wins_s2d: number(me.wins_s2d),
          losses_s2d: number(me.losses_s2d),

          // Similar opponents (same venue)
          sim_winrate_same_loc_s2d: number(agg.winrate),
          sim_pointdiff_same_loc_s2d: number(agg.pointdiff),
          sim_count_same_loc_s2d: number(agg.count),

          // Opponent diffs
          off_total_yds_s2d_minus_opp: diff(me.off_total_yds_s2d, op.off_total_yds_s2d),
          def_total_yds_s2d_minus_opp: diff(me.def_total_yds_s2d, op.def_total_yds_s2d),
          off_turnovers_s2d_minus_opp:  diff(me.off_turnovers_s2d,  op.off_turnovers_s2d),
          def_turnovers_s2d_minus_opp:  diff(me.def_turnovers_s2d,  op.def_turnovers_s2d),

          // Rest & Elo
          rest_days: isHome ? hRest : aRest,
          rest_diff: isHome ? restDiff : -restDiff,
          elo_pre: isHome ? hElo : aElo,
          elo_diff: isHome ? eloDiff : -eloDiff,

          // Label — set only from final scores if available; otherwise null
          win: deriveWinLabel(g, isHome)
        };
      }

      const hRow = baseRow(hTW, aTW, true);
      const aRow = baseRow(aTW, hTW, false);
      rows.push(hRow, aRow);

      // Update rolling “last played date” AFTER inserting rows
      if (gameDate){
        lastDateByTeam.set(H, gameDate);
        lastDateByTeam.set(A, gameDate);
      }

      // Update very-simplified Elo carry (only when final scores exist)
      const hs = finalScore(g, true);
      const as = finalScore(g, false);
      if (hs != null && as != null){
        const margin = hs - as;
        const K = 2.5; // tiny update — keep mild
        const expectedH = 1/(1+Math.pow(10, -(hElo - aElo)/400));
        const outcomeH = margin > 0 ? 1 : 0;
        const newHElo = hElo + K * (outcomeH - expectedH);
        const newAElo = aElo - K * (outcomeH - expectedH);
        eloByTeam.set(H, newHElo);
        eloByTeam.set(A, newAElo);
      }

      // Push completed rows (with win ∈ {0,1}) into rowsSoFar to fuel “similar opp” for later weeks
      if (hRow.win === 0 || hRow.win === 1) rowsSoFar.push(hRow);
      if (aRow.win === 0 || aRow.win === 1) rowsSoFar.push(aRow);
    }
  }

  return rows;
}

// --- helpers ---

function finalScore(g, home){
  const hs = g.home_score ?? g.home_points ?? g.home_pts;
  const as = g.away_score ?? g.away_points ?? g.away_pts;
  if (!Number.isFinite(Number(hs)) || !Number.isFinite(Number(as))) return null;
  return home ? Number(hs) : Number(as);
}

function deriveWinLabel(g, isHome){
  const hs = finalScore(g, true);
  const as = finalScore(g, false);
  if (hs == null || as == null) return null;
  if (hs === as) return null; // ignore ties if any
  const homeWon = hs > as ? 1 : 0;
  return isHome ? homeWon : (1 - homeWon);
}

export { FEATS };