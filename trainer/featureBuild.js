// trainer/featureBuild.js
//
// Robust feature builder that auto-detects NFLVerse team-week schema using regex,
// backfills missing S2D from latest prior week, and always emits rows for scheduled games.
// Labels (win) are derived from final scores; unplayed games have win=null.
//
// Inputs:
//   teamWeekly: parsed rows from stats_team_week_<season>.csv (NFLVerse)
//   schedules : season schedule (with scores if final)
//   prevTeamWeekly: previous season team-week rows (for Elo seed)
// Output: per-team rows with canonical features used by the models.

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
const num = (v, d=0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const dateOnly = s => s ? String(s).slice(0,10) : null;

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
  if (hs === as) return null; // ties rare; ignore
  const homeWon = hs > as ? 1 : 0;
  return isHome ? homeWon : (1 - homeWon);
}
function daysBetween(a, b){
  if (!a || !b) return 0;
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// --- schema auto-detector ----------------------------------------------------
// We discover the best matching column for each canonical key from *actual* headers.
// Patterns try to be flexible about word order and underscores.
function buildSchemaDetector(sampleRow){
  const keys = Object.keys(sampleRow || {}).map(k => [k, k.toLowerCase()]);
  const find = (...regexes) => {
    for (const [orig, lower] of keys) {
      for (const rx of regexes) {
        if (rx.test(lower)) return orig;
      }
    }
    return null;
  };

  // Canonical -> column name in source (or null if not found)
  const map = {
    // offense S2D
    off_1st_down_s2d:  find(/off.*(1st|first).*down.*(s2d|tot|cum)?/i, /(first|1st).*down.*off/i),
    off_total_yds_s2d: find(/off.*(total|net).*yds|off.*yds.*(s2d|tot|cum)|total.*yards.*off/i),
    off_rush_yds_s2d:  find(/off.*rush.*yds|rush.*yards.*off/i),
    off_pass_yds_s2d:  find(/off.*pass.*yds|pass.*yards.*off/i),
    off_turnovers_s2d: find(/off.*(to|turnover).*s2d|giveaway.*(s2d|tot|cum)|off.*turnover/i),

    // defense S2D
    def_1st_down_s2d:  find(/def.*(1st|first).*down.*(s2d|tot|cum)?/i, /(first|1st).*down.*def/i),
    def_total_yds_s2d: find(/def.*(total|net).*yds|yds.*allowed.*(s2d|tot|cum)|total.*yards.*allowed/i),
    def_rush_yds_s2d:  find(/def.*rush.*yds|rush.*yds.*allowed/i),
    def_pass_yds_s2d:  find(/def.*pass.*yds|pass.*yds.*allowed/i),
    def_turnovers_s2d: find(/def.*(to|turnover).*s2d|takeaway.*(s2d|tot|cum)|def.*turnover/i),

    // record S2D
    wins_s2d:          find(/wins.*(s2d|tot|cum)?$|^wins$/i, /\bw_s2d\b/i),
    losses_s2d:        find(/loss(es)?(.*(s2d|tot|cum))?$|^losses$/i, /\bl_s2d\b/i),

    // identity
    team:              find(/^team$|team_?abbr|club|franchise|^tm$/i),
    week:              find(/^week$|week_num|^wk$/i),
    season:            find(/^season$|^year$/i),
  };

  return (row) => {
    const out = {};
    for (const [canon, col] of Object.entries(map)) {
      out[canon] = col ? row[col] : undefined;
    }
    return out;
  };
}

// Backfill: if (team, week) S2D missing, use latest prior <= week; else zeros.
function latestAtOrBefore(mapByTeamWeek, team, week){
  for (let w=week; w>=1; w--){
    const got = mapByTeamWeek.get(`${team}-${w}`);
    if (got) return got;
  }
  return null;
}

// Tiny Elo seed from previous season wins (very mild spread)
function seedElo(team, prevTeamWeekly){
  const wins = (prevTeamWeekly || []).filter(r => r.team === team).reduce((s,r)=> s + num(r.wins_s2d), 0);
  if (!Number.isFinite(wins)) return 1500;
  return 1450 + 5 * wins;
}

// Similar-opponent aggregates (same venue) using completed rows so far
function buildSimilarOppAgg(rowsSoFar){
  const idx = new Map(); // key: `${team}-${home}` -> [{r, pointProxy, win}]
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

export function buildFeatures({ teamWeekly, schedules, season, prevTeamWeekly }){
  const out = [];
  const reg = schedules.filter(g => Number(g.season)===season && isReg(g.season_type));
  const weeks = [...new Set(reg.map(g => Number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  if (!teamWeekly || !teamWeekly.length) return out;

  // Build detector from the first row
  const detect = buildSchemaDetector(teamWeekly[0]);

  // Build (team,week) -> projected S2D object
  const twMap = new Map();
  for (const r of teamWeekly){
    if (Number(detect(r).season) !== season) continue;
    const team = detect(r).team ?? r.team;
    const week = Number(detect(r).week ?? r.week);
    if (!team || !Number.isFinite(week)) continue;

    const proj = {
      off_1st_down_s2d:  num(detect(r).off_1st_down_s2d),
      off_total_yds_s2d: num(detect(r).off_total_yds_s2d),
      off_rush_yds_s2d:  num(detect(r).off_rush_yds_s2d),
      off_pass_yds_s2d:  num(detect(r).off_pass_yds_s2d),
      off_turnovers_s2d: num(detect(r).off_turnovers_s2d),

      def_1st_down_s2d:  num(detect(r).def_1st_down_s2d),
      def_total_yds_s2d: num(detect(r).def_total_yds_s2d),
      def_rush_yds_s2d:  num(detect(r).def_rush_yds_s2d),
      def_pass_yds_s2d:  num(detect(r).def_pass_yds_s2d),
      def_turnovers_s2d: num(detect(r).def_turnovers_s2d),

      wins_s2d:          num(detect(r).wins_s2d),
      losses_s2d:        num(detect(r).losses_s2d),
    };
    twMap.set(`${team}-${week}`, proj);
  }

  // Backfill helper that returns S2D for (team, week), falling back to latest prior
  function s2dFor(team, week){
    const found = latestAtOrBefore(twMap, team, week);
    return found || {
      off_1st_down_s2d:0, off_total_yds_s2d:0, off_rush_yds_s2d:0, off_pass_yds_s2d:0, off_turnovers_s2d:0,
      def_1st_down_s2d:0, def_total_yds_s2d:0, def_rush_yds_s2d:0, def_pass_yds_s2d:0, def_turnovers_s2d:0,
      wins_s2d:0, losses_s2d:0
    };
  }

  // rest + elo trackers
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

      const hS2D = s2dFor(H, W);
      const aS2D = s2dFor(A, W);

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

        // similar-opp (same venue), use core S2D signals
        const sim = agg(team, isHome ? 1 : 0, {
          off_total_yds_s2d: num(me.off_total_yds_s2d),
          def_total_yds_s2d: num(me.def_total_yds_s2d),
          off_turnovers_s2d: num(me.off_turnovers_s2d),
          def_turnovers_s2d: num(me.def_turnovers_s2d)
        });

        return {
          season: season, week: W, team, opponent: opp, home: isHome ? 1 : 0,
          game_date: gd,

          off_1st_down_s2d:  num(me.off_1st_down_s2d),
          off_total_yds_s2d: num(me.off_total_yds_s2d),
          off_rush_yds_s2d:  num(me.off_rush_yds_s2d),
          off_pass_yds_s2d:  num(me.off_pass_yds_s2d),
          off_turnovers_s2d: num(me.off_turnovers_s2d),

          def_1st_down_s2d:  num(me.def_1st_down_s2d),
          def_total_yds_s2d: num(me.def_total_yds_s2d),
          def_rush_yds_s2d:  num(me.def_rush_yds_s2d),
          def_pass_yds_s2d:  num(me.def_pass_yds_s2d),
          def_turnovers_s2d: num(me.def_turnovers_s2d),

          wins_s2d:   num(me.wins_s2d),
          losses_s2d: num(me.losses_s2d),

          sim_winrate_same_loc_s2d:   num(sim.winrate),
          sim_pointdiff_same_loc_s2d: num(sim.pointdiff),
          sim_count_same_loc_s2d:     num(sim.count),

          off_total_yds_s2d_minus_opp: diff(me.off_total_yds_s2d, op.off_total_yds_s2d),
          def_total_yds_s2d_minus_opp: diff(me.def_total_yds_s2d, op.def_total_yds_s2d),
          off_turnovers_s2d_minus_opp:  diff(me.off_turnovers_s2d,  op.off_turnovers_s2d),
          def_turnovers_s2d_minus_opp:  diff(me.def_turnovers_s2d,  op.def_turnovers_s2d),

          rest_days: isHome ? hRest : aRest,
          rest_diff: isHome ? restDiff : -restDiff,
          elo_pre:   isHome ? hElo : aElo,
          elo_diff:  isHome ? eloDiff : -eloDiff,

          win: deriveWinLabel(g, isHome)
        };
      }

      const hRow = mk(hS2D, aS2D, true);
      const aRow = mk(aS2D, hS2D, false);
      out.push(hRow, aRow);

      // advance last played
      if (gd){ lastDate.set(H, gd); lastDate.set(A, gd); }

      // tiny Elo update on final
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

      if (hRow.win === 0 || hRow.win === 1) rowsSoFar.push(hRow);
      if (aRow.win === 0 || aRow.win === 1) rowsSoFar.push(aRow);
    }
  }

  return out;
}

export { FEATS };
