// trainer/featureBuild.js
//
// Robust feature builder with schema auto-mapping + week gating.
// - Maps our canonical feature names from a set of plausible NFLVerse aliases.
// - Sets labels (win) from schedule scores; leaves win=null for future/unplayed games.
// - Emits rows only when both teams have non-trivial (non-zero) S2D signal for that week,
//   avoiding bogus future weeks with all-zero features.
//
// Inputs:
//   teamWeekly: stats_team_week_<season>.csv parsed rows (nflverse).
//   schedules:  season schedule with scores when final.
//   prevTeamWeekly: previous-season team-week rows (for Elo seeding).
//
// Output: per-team rows with our canonical feature names + metadata.
//
// NOTE: Keep FEATS consistent with trainer/train_multi.js.

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
function num(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function dateOnly(s){ return s ? String(s).slice(0,10) : null; }

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
  if (hs === as) return null;
  const homeWon = hs > as ? 1 : 0;
  return isHome ? homeWon : (1 - homeWon);
}

function daysBetween(a, b){
  if (!a || !b) return 0;
  const A = new Date(a), B = new Date(b);
  return Math.round((B - A) / (24*3600*1000));
}

// ---- schema auto-mapper ------------------------------------------------------
// For each canonical key we want, list several likely aliases in nflverse team-week.
const ALIASES = {
  // offense s2d
  off_1st_down_s2d:       ["off_1st_down_s2d","off_1st_down","off_first_downs","first_downs_offense","off_first_downs_s2d"],
  off_total_yds_s2d:      ["off_total_yds_s2d","off_total_yards","total_yards_offense","off_tot_yds","off_net_yds","off_yds_s2d"],
  off_rush_yds_s2d:       ["off_rush_yds_s2d","off_rush_yards","rush_yards_offense","off_rush_yds","off_rush_yds_tot"],
  off_pass_yds_s2d:       ["off_pass_yds_s2d","off_pass_yards","pass_yards_offense","off_pass_yds","off_pass_yds_tot"],
  off_turnovers_s2d:      ["off_turnovers_s2d","giveaways_s2d","giveaways","off_turnovers","turnovers_offense_s2d"],

  // defense s2d
  def_1st_down_s2d:       ["def_1st_down_s2d","def_1st_down","def_first_downs","first_downs_defense","def_first_downs_s2d"],
  def_total_yds_s2d:      ["def_total_yds_s2d","yds_allowed_s2d","def_total_yards","total_yards_allowed","def_net_yds","def_yds_s2d"],
  def_rush_yds_s2d:       ["def_rush_yds_s2d","rush_yds_allowed_s2d","def_rush_yards","rush_yards_allowed","def_rush_yds_tot"],
  def_pass_yds_s2d:       ["def_pass_yds_s2d","pass_yds_allowed_s2d","def_pass_yards","pass_yards_allowed","def_pass_yds_tot"],
  def_turnovers_s2d:      ["def_turnovers_s2d","takeaways_s2d","takeaways","def_turnovers","turnovers_defense_s2d"],

  // record s2d
  wins_s2d:               ["wins_s2d","wins","w_s2d"],
  losses_s2d:             ["losses_s2d","losses","l_s2d"]
};

// Helper to get the first present alias on a row:
function getField(row, aliasList){
  for (const k of aliasList){
    if (row[k] != null && row[k] !== "") return Number(row[k]);
  }
  return 0;
}

// For a given team-week row, project to our canonical S2D feature space
function projectRow(r){
  const o = {};
  for (const [canon, alist] of Object.entries(ALIASES)){
    o[canon] = num(getField(r, alist), 0);
  }
  return o;
}
// quick check whether a projected S2D row has any non-trivial signal
function hasSignal(s2d){
  // if every numeric value is 0, treat as no signal
  return Object.values(s2d).some(v => Number(v) !== 0);
}

// ---- similar opponent aggregates (same venue) --------------------------------
function buildSimilarOppAgg(rowsSoFar){
  // index by team-home flag
  const idx = new Map();
  for (const r of rowsSoFar){
    if (!(r.win === 0 || r.win === 1)) continue;
    const key = `${r.team}-${r.home}`;
    const arr = idx.get(key) || [];
    const pointProxy = num(r.off_total_yds_s2d_minus_opp) - num(r.def_total_yds_s2d_minus_opp);
    arr.push({ r, pointProxy, win: r.win ? 1 : -1 });
    idx.set(key, arr);
  }
  function dist(a,b){
    let d=0;
    d += Math.abs(num(a.off_total_yds_s2d) - num(b.off_total_yds_s2d));
    d += Math.abs(num(a.def_total_yds_s2d) - num(b.def_total_yds_s2d));
    d += 50 * Math.abs(num(a.off_turnovers_s2d) - num(b.off_turnovers_s2d));
    d += 50 * Math.abs(num(a.def_turnovers_s2d) - num(b.def_turnovers_s2d));
    return d;
  }
  return function(team, home, candidate){
    const key = `${team}-${home}`;
    const pool = idx.get(key) || [];
    if (!pool.length) return { winrate: 0, pointdiff: 0, count: 0 };
    const dists = pool.map(e => dist(e.r, candidate)).sort((a,b)=>a-b);
    const med = dists[Math.floor(dists.length/2)] || 0;
    const band = Math.max(50, med * 1.5);
    let sel = pool.filter(e => dist(e.r, candidate) <= band);
    if (!sel.length) sel = pool.slice(0, Math.min(5, pool.length));
    const winrate = sel.reduce((s,e)=> s + (e.win>0 ? 1:0), 0) / sel.length;
    const pointdiff = sel.reduce((s,e)=> s + e.pointProxy, 0) / sel.length;
    return { winrate, pointdiff, count: sel.length };
  };
}

// ---- Elo seed (very light) ---------------------------------------------------
function seedElo(team, prevTeamWeekly){
  const wins = (prevTeamWeekly || []).filter(r => r.team === team).reduce((s,r)=> s + num(r.wins_s2d), 0);
  if (!Number.isFinite(wins)) return 1500;
  return 1450 + 5 * wins;
}

// ---- main --------------------------------------------------------------------
export function buildFeatures({ teamWeekly, schedules, season, prevTeamWeekly }){
  const out = [];
  const reg = schedules.filter(g => Number(g.season)===season && isReg(g.season_type));
  const weeks = [...new Set(reg.map(g => Number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);

  // team-week lookup
  const tw = new Map(); // `${team}-${week}` -> projected S2D object + raw row
  for (const r of teamWeekly){
    if (Number(r.season)!==season) continue;
    const key = `${r.team}-${Number(r.week)}`;
    tw.set(key, { s2d: projectRow(r), raw: r });
  }

  // last dates & elo trackers
  const lastDate = new Map();
  const elo = new Map();
  const teams = new Set(reg.flatMap(g => [g.home_team, g.away_team]).filter(Boolean));
  for (const t of teams) elo.set(t, seedElo(t, prevTeamWeekly));

  const rowsSoFar = [];

  for (const W of weeks){
    const games = reg.filter(g => Number(g.week)===W).sort((a,b)=> String(a.game_date||"").localeCompare(String(b.game_date||"")));
    const agg = buildSimilarOppAgg(rowsSoFar);

    for (const g of games){
      const H = g.home_team, A = g.away_team;
      const gd = dateOnly(g.game_date);

      const hKey = `${H}-${W}`, aKey = `${A}-${W}`;
      const hTW = tw.get(hKey)?.s2d || {};
      const aTW = tw.get(aKey)?.s2d || {};

      // WEEK GATING: skip if either team has no S2D signal yet (all zeros for that week)
      if (!hasSignal(hTW) || !hasSignal(aTW)) continue;

      // rest
      const hRest = daysBetween(lastDate.get(H) || null, gd);
      const aRest = daysBetween(lastDate.get(A) || null, gd);
      const restDiff = (hRest||0) - (aRest||0);

      const hElo = num(elo.get(H), 1500);
      const aElo = num(elo.get(A), 1500);
      const eloDiff = hElo - aElo;

      function mk(me, op, isHome){
        const team = isHome ? H : A;
        const opp  = isHome ? A : H;
        const diff = (a,b)=> num(a) - num(b);

        // similar opponents (same venue)
        const sim = agg(team, isHome ? 1 : 0, {
          off_total_yds_s2d: num(me.off_total_yds_s2d),
          def_total_yds_s2d: num(me.def_total_yds_s2d),
          off_turnovers_s2d: num(me.off_turnovers_s2d),
          def_turnovers_s2d: num(me.def_turnovers_s2d)
        });

        return {
          season, week: W, team, opponent: opp, home: isHome ? 1 : 0,
          game_date: gd,

          // canonical features from mapped S2D
          off_1st_down_s2d: num(me.off_1st_down_s2d),
          off_total_yds_s2d: num(me.off_total_yds_s2d),
          off_rush_yds_s2d: num(me.off_rush_yds_s2d),
          off_pass_yds_s2d: num(me.off_pass_yds_s2d),
          off_turnovers_s2d: num(me.off_turnovers_s2d),

          def_1st_down_s2d: num(me.def_1st_down_s2d),
          def_total_yds_s2d: num(me.def_total_yds_s2d),
          def_rush_yds_s2d: num(me.def_rush_yds_s2d),
          def_pass_yds_s2d: num(me.def_pass_yds_s2d),
          def_turnovers_s2d: num(me.def_turnovers_s2d),

          wins_s2d:   num(me.wins_s2d),
          losses_s2d: num(me.losses_s2d),

          // similar-opp (same venue)
          sim_winrate_same_loc_s2d: num(sim.winrate),
          sim_pointdiff_same_loc_s2d: num(sim.pointdiff),
          sim_count_same_loc_s2d: num(sim.count),

          // opponent differentials
          off_total_yds_s2d_minus_opp: diff(me.off_total_yds_s2d, op.off_total_yds_s2d),
          def_total_yds_s2d_minus_opp: diff(me.def_total_yds_s2d, op.def_total_yds_s2d),
          off_turnovers_s2d_minus_opp:  diff(me.off_turnovers_s2d,  op.off_turnovers_s2d),
          def_turnovers_s2d_minus_opp:  diff(me.def_turnovers_s2d,  op.def_turnovers_s2d),

          // rest & Elo
          rest_days: isHome ? hRest : aRest,
          rest_diff: isHome ? restDiff : -restDiff,
          elo_pre: isHome ? hElo : aElo,
          elo_diff: isHome ? eloDiff : -eloDiff,

          // label
          win: deriveWinLabel(g, isHome)
        };
      }

      const hRow = mk(hTW, aTW, true);
      const aRow = mk(aTW, hTW, false);
      out.push(hRow, aRow);

      // advance last-played
      if (gd){
        lastDate.set(H, gd);
        lastDate.set(A, gd);
      }

      // tiny Elo update when final exists
      const hs = finalScore(g, true);
      const as = finalScore(g, false);
      if (hs != null && as != null){
        const K = 2.5;
        const expectedH = 1/(1+Math.pow(10, -(hElo - aElo)/400));
        const outcomeH = hs > as ? 1 : 0;
        const d = K * (outcomeH - expectedH);
        elo.set(H, hElo + d);
        elo.set(A, aElo - d);
      }

      // add completed to history for future similar-opp calcs
      if (hRow.win === 0 || hRow.win === 1) rowsSoFar.push(hRow);
      if (aRow.win === 0 || aRow.win === 1) rowsSoFar.push(aRow);
    }
  }

  return out;
}

export { FEATS };
