// trainer/featureBuild.js
//
// Build season-to-date (S2D) features from NFLVerse team-week PER-GAME stats.
// Derive defensive "allowed" values from the opponent row for the same game/week.
// Always emit rows for weeks that exist in the data; DO NOT fabricate future weeks.
// Win label only when final scores exist in schedule; otherwise win=null.

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
const num = (v,d=0)=>{ const n=Number(v); return Number.isFinite(n)?n:d; };
const dateOnly = s => s ? String(s).slice(0,10) : null;

function finalScores(g){
  const hs = g.home_score ?? g.home_points ?? g.home_pts;
  const as = g.away_score ?? g.away_points ?? g.away_pts;
  if (!Number.isFinite(Number(hs)) || !Number.isFinite(Number(as))) return null;
  return { hs: Number(hs), as: Number(as) };
}
function winLabel(g, isHome){
  const fs = finalScores(g); if (!fs) return null;
  if (fs.hs === fs.as) return null;
  const homeWon = fs.hs > fs.as ? 1 : 0;
  return isHome ? homeWon : (1 - homeWon);
}

function daysBetween(a, b){
  if (!a || !b) return 0;
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// Build an index: season-week-team -> row
function indexTeamWeek(rows, season){
  const idx = new Map();
  for (const r of rows){
    if (Number(r.season) !== season) continue;
    const key = `${r.season}-${r.week}-${r.team}`;
    idx.set(key, r);
  }
  return idx;
}

// Compute per-row offensive and defensive per-game metrics we need
function perGameSignals(r, oppRow){
  // Offense
  const passYds = num(r.passing_yards);
  const rushYds = num(r.rushing_yards);
  const offTotal = passYds + rushYds;

  const passFD = num(r.passing_first_downs);
  const rushFD = num(r.rushing_first_downs);
  const recvFD = num(r.receiving_first_downs);
  const offFD = passFD + rushFD + recvFD;

  const offINT = num(r.passing_interceptions);
  const offFumLost = num(r.rushing_fumbles_lost) + num(r.receiving_fumbles_lost) + num(r.sack_fumbles_lost);
  const offTO = offINT + offFumLost;

  // Defense (allowed) via opponent offense row
  const oppPassYds = oppRow ? num(oppRow.passing_yards) : 0;
  const oppRushYds = oppRow ? num(oppRow.rushing_yards) : 0;
  const defTotalAllowed = oppPassYds + oppRushYds;

  const oppPassFD = oppRow ? num(oppRow.passing_first_downs) : 0;
  const oppRushFD = oppRow ? num(oppRow.rushing_first_downs) : 0;
  const oppRecvFD = oppRow ? num(oppRow.receiving_first_downs) : 0;
  const defFDAllowed = oppPassFD + oppRushFD + oppRecvFD;

  // Takeaways (made by defense)
  const defINT = num(r.def_interceptions);
  // "def_fumbles" = fumbles recovered; if not precise in your source, this is a decent proxy
  const defFum = num(r.def_fumbles);
  const defTO = defINT + defFum;

  return {
    offFD, offTotal, rushYds, passYds, offTO,
    defFDAllowed, defTotalAllowed, defRushAllowed: oppRushYds, defPassAllowed: oppPassYds, defTO
  };
}

// Tiny Elo seed: previous season wins (if prev season provided), otherwise 1500
function seedElo(team, prevTeamWeekly){
  const wins = (prevTeamWeekly||[]).filter(r => r.team===team).reduce((s,r)=> s + num(r.wins,0), 0);
  return Number.isFinite(wins) ? 1450 + 5*wins : 1500;
}

// Similar-opponent aggregates (same venue) based on rows with labels so far
function buildSimilarAgg(rowsSoFar){
  const idx = new Map(); // key `${team}-${home}` -> rows
  for (const r of rowsSoFar){
    if (!(r.win===0 || r.win===1)) continue;
    const key = `${r.team}-${r.home}`;
    const arr = idx.get(key) || [];
    arr.push(r); idx.set(key, arr);
  }
  function dist(a,b){
    let d=0;
    d += Math.abs(num(a.off_total_yds_s2d) - num(b.off_total_yds_s2d));
    d += Math.abs(num(a.def_total_yds_s2d) - num(b.def_total_yds_s2d));
    d += 50*Math.abs(num(a.off_turnovers_s2d) - num(b.off_turnovers_s2d));
    d += 50*Math.abs(num(a.def_turnovers_s2d) - num(b.def_turnovers_s2d));
    return d;
  }
  return function(team, home, candidate){
    const pool = idx.get(`${team}-${home}`) || [];
    if (!pool.length) return { winrate: 0, pointdiff: 0, count: 0 };
    const dists = pool.map(e => dist(e, candidate)).sort((a,b)=>a-b);
    const med = dists[Math.floor(dists.length/2)] || 0;
    const band = Math.max(50, med*1.5);
    let sel = pool.filter(e => dist(e, candidate) <= band);
    if (!sel.length) sel = pool.slice(0, Math.min(5, pool.length));
    const winrate = sel.reduce((s,e)=> s + (e.win?1:0), 0) / sel.length;
    const pointdiff = sel.reduce((s,e)=> s + ((num(e.off_total_yds_s2d)-num(e.def_total_yds_s2d))), 0) / sel.length;
    return { winrate, pointdiff, count: sel.length };
  };
}

export function buildFeatures({ teamWeekly, schedules, season, prevTeamWeekly }){
  const out = [];
  // Keep REG only, index by (season,week,team) for opponent lookup
  const regSched = schedules.filter(g => Number(g.season)===season && isReg(g.season_type));
  const tw = (teamWeekly||[]).filter(r => Number(r.season)===season);
  if (!tw.length) return out;

  const twIdx = indexTeamWeek(tw, season);
  const weeks = [...new Set(tw.map(r => Number(r.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  const teams = new Set(regSched.flatMap(g => [g.home_team, g.away_team]).filter(Boolean));
  const lastDate = new Map();
  const elo = new Map(); for (const t of teams) elo.set(t, seedElo(t, prevTeamWeekly));

  // S2D accumulators: team -> rolled sums by week
  const roll = new Map(); // team -> {week -> s2d object}
  for (const team of teams) roll.set(team, new Map());

  const rowsSoFar = [];
  for (const W of weeks){
    const games = regSched.filter(g => Number(g.week)===W);
    if (!games.length) continue;

    for (const g of games){
      const H = g.home_team, A = g.away_team;
      const gd = dateOnly(g.game_date);

      // source rows for this (season, week) for each team
      const hRow = twIdx.get(`${season}-${W}-${H}`) || null;
      const aRow = twIdx.get(`${season}-${W}-${A}`) || null;

      // opponent rows for defensive derivations
      // (note: we want the opponent's offensive stats)
      const hOpp = aRow;
      const aOpp = hRow;

      const hPG = perGameSignals(hRow||{}, hOpp||{});
      const aPG = perGameSignals(aRow||{}, aOpp||{});

      // roll S2D
      function updateRoll(team, prev, pg){
        const s = { ...prev };
        s.off_1st_down_s2d = num(prev.off_1st_down_s2d) + num(pg.offFD);
        s.off_total_yds_s2d = num(prev.off_total_yds_s2d) + num(pg.offTotal);
        s.off_rush_yds_s2d = num(prev.off_rush_yds_s2d) + num(pg.rushYds);
        s.off_pass_yds_s2d = num(prev.off_pass_yds_s2d) + num(pg.passYds);
        s.off_turnovers_s2d = num(prev.off_turnovers_s2d) + num(pg.offTO);

        s.def_1st_down_s2d = num(prev.def_1st_down_s2d) + num(pg.defFDAllowed);
        s.def_total_yds_s2d = num(prev.def_total_yds_s2d) + num(pg.defTotalAllowed);
        s.def_rush_yds_s2d = num(prev.def_rush_yds_s2d) + num(pg.defRushAllowed);
        s.def_pass_yds_s2d = num(prev.def_pass_yds_s2d) + num(pg.defPassAllowed);
        s.def_turnovers_s2d = num(prev.def_turnovers_s2d) + num(pg.defTO);
        return s;
      }
      const hPrev = roll.get(H).get(W-1) || {};
      const aPrev = roll.get(A).get(W-1) || {};
      const hS2D = updateRoll(H, hPrev, hPG);
      const aS2D = updateRoll(A, aPrev, aPG);
      roll.get(H).set(W, hS2D);
      roll.get(A).set(W, aS2D);

      // record S2D wins/losses from schedule final
      const fs = finalScores(g);
      if (fs){
        const hWin = fs.hs > fs.as ? 1 : 0;
        const aWin = 1 - hWin;
        hS2D.wins_s2d   = num(hPrev.wins_s2d)   + hWin;
        hS2D.losses_s2d = num(hPrev.losses_s2d) + (1-hWin);
        aS2D.wins_s2d   = num(aPrev.wins_s2d)   + aWin;
        aS2D.losses_s2d = num(aPrev.losses_s2d) + (1-aWin);
      } else {
        hS2D.wins_s2d   = num(hPrev.wins_s2d);
        hS2D.losses_s2d = num(hPrev.losses_s2d);
        aS2D.wins_s2d   = num(aPrev.wins_s2d);
        aS2D.losses_s2d = num(aPrev.losses_s2d);
      }

      const hRest = daysBetween(lastDate.get(H) || null, gd);
      const aRest = daysBetween(lastDate.get(A) || null, gd);
      const restDiff = (hRest||0) - (aRest||0);

      const hElo = num(elo.get(H), 1500);
      const aElo = num(elo.get(A), 1500);
      const eloDiff = hElo - aElo;

      function mkRow(team, opp, isHome, me, op){
        // simple similar-opp placeholder (optional; can enrich later)
        const sim_winrate_same_loc_s2d = 0;
        const sim_pointdiff_same_loc_s2d = 0;
        const sim_count_same_loc_s2d = 0;

        const row = {
          season, week: W, team, opponent: opp, home: isHome ? 1 : 0,
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

          sim_winrate_same_loc_s2d,
          sim_pointdiff_same_loc_s2d,
          sim_count_same_loc_s2d,

          off_total_yds_s2d_minus_opp: num(me.off_total_yds_s2d) - num(op.off_total_yds_s2d),
          def_total_yds_s2d_minus_opp: num(me.def_total_yds_s2d) - num(op.def_total_yds_s2d),
          off_turnovers_s2d_minus_opp:  num(me.off_turnovers_s2d) -  num(op.off_turnovers_s2d),
          def_turnovers_s2d_minus_opp:  num(me.def_turnovers_s2d) -  num(op.def_turnovers_s2d),

          rest_days: isHome ? hRest : aRest,
          rest_diff: isHome ? restDiff : -restDiff,
          elo_pre:   isHome ? hElo : aElo,
          elo_diff:  isHome ? eloDiff : -eloDiff,

          win: winLabel(g, isHome)
        };
        return row;
      }

      const hBuilt = mkRow(H, A, true,  hS2D, aS2D);
      const aBuilt = mkRow(A, H, false, aS2D, hS2D);
      out.push(hBuilt, aBuilt);

      if (gd){ lastDate.set(H, gd); lastDate.set(A, gd); }

      const fs2 = finalScores(g);
      if (fs2){
        // tiny Elo update
        const K = 2.5;
        const expectedH = 1/(1+Math.pow(10, -(hElo - aElo)/400));
        const outcomeH = fs2.hs > fs2.as ? 1 : 0;
        const d = K*(outcomeH - expectedH);
        elo.set(H, hElo + d); elo.set(A, aElo - d);
      }

      if (hBuilt.win===0 || hBuilt.win===1) rowsSoFar.push(hBuilt);
      if (aBuilt.win===0 || aBuilt.win===1) rowsSoFar.push(aBuilt);
    }
  }

  return out;
}

export { FEATS };
