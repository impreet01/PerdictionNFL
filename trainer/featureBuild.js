// trainer/featureBuild.js
// Pre-game Season-To-Date features with Week-1 carry-in from prior season,
// plus similar-opponent (same venue), opponent differentials, Elo, and rest-days.

function parseDate(d) {
  if (!d) return null;
  const t = String(d).trim();
  const dt = new Date(t);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// Accept REG season rows generously: if season_type is missing/blank, treat as REG.
// Accept values like "REG", "Regular", "regular", etc.
function isRegSeasonValue(v) {
  if (v == null) return true; // treat missing as REG
  const s = String(v).trim().toUpperCase();
  if (s === "") return true;
  return s.startsWith("REG"); // "REG", "REGULAR", etc.
}

function offenseFromRow(r) {
  const passY = Number(r.passing_yards ?? 0);
  const rushY = Number(r.rushing_yards ?? 0);
  const off_total_yds = passY + rushY;
  const off_rush_yds  = rushY;
  const off_pass_yds  = passY;
  const off_1st_down  = Number(r.passing_first_downs ?? 0) + Number(r.rushing_first_downs ?? 0) + Number(r.receiving_first_downs ?? 0);
  const off_turnovers = Number(r.passing_interceptions ?? 0)
                      + Number(r.rushing_fumbles_lost ?? 0)
                      + Number(r.receiving_fumbles_lost ?? 0)
                      + Number(r.sack_fumbles_lost ?? 0);
  return { off_total_yds, off_rush_yds, off_pass_yds, off_1st_down, off_turnovers };
}

function defenseAllowedFromPair(teamRowRaw, oppRowRaw) {
  const oppOff = offenseFromRow(oppRowRaw);
  const def_total_yds = oppOff.off_total_yds;
  const def_rush_yds  = oppOff.off_rush_yds;
  const def_pass_yds  = oppOff.off_pass_yds;
  const def_1st_down  = oppOff.off_1st_down;
  const def_turnovers = Number(teamRowRaw.def_interceptions ?? 0) + Number(teamRowRaw.fumble_recovery_opp ?? 0);
  return { def_total_yds, def_rush_yds, def_pass_yds, def_1st_down, def_turnovers };
}

// ---------- Prior-season baselines (per-team per-game averages; prior "REG") ----------
function buildPrevSeasonBaselines(prevTeamWeekly, prevSeason, schedulesAll) {
  if (!Array.isArray(prevTeamWeekly) || !prevTeamWeekly.length) return { byTeam: {}, league: null };

  const prevSchedByKey = {};
  for (const g of schedulesAll) {
    if (Number(g.season) !== Number(prevSeason)) continue;
    if (!isRegSeasonValue(g.season_type)) continue;
    prevSchedByKey[`${g.season}|${g.week}|${g.home_team}|${g.away_team}`] = g;
  }

  const prevByKeyRaw = {};
  for (const r of prevTeamWeekly) {
    if (Number(r.season) !== Number(prevSeason)) continue;
    if (!isRegSeasonValue(r.season_type)) continue;
    prevByKeyRaw[`${r.season}|${r.week}|${r.team}`] = r;
  }

  const rows = [];
  for (const r of prevTeamWeekly) {
    if (Number(r.season) !== Number(prevSeason)) continue;
    if (!isRegSeasonValue(r.season_type)) continue;

    const wk  = Number(r.week);
    const tm  = r.team;
    const opp = r.opponent_team;

    const keyHome = `${prevSeason}|${wk}|${tm}|${opp}`;
    const keyAway = `${prevSeason}|${wk}|${opp}|${tm}`;
    const home = prevSchedByKey[keyHome] ? 1 : (prevSchedByKey[keyAway] ? 0 : 0);

    const pointsFor     = Number(r.points_for ?? r.points ?? 0);
    const pointsAgainst = Number(r.points_against ?? r.points_allowed ?? 0);
    const win = pointsFor >= pointsAgainst ? 1 : 0;

    const off = offenseFromRow(r);
    const oppRaw = prevByKeyRaw[`${prevSeason}|${wk}|${opp}`];
    if (!oppRaw) continue;
    const def = defenseAllowedFromPair(r, oppRaw);

    rows.push({ season: prevSeason, week: wk, team: tm, opponent: opp, home, win, points_for: pointsFor, points_against: pointsAgainst, ...off, ...def });
  }

  if (!rows.length) return { byTeam: {}, league: null };

  const byTeamAgg = {};
  for (const r of rows) {
    const t = r.team;
    if (!byTeamAgg[t]) byTeamAgg[t] = {
      n:0, wins:0, losses:0,
      off_1st_down:0, off_total_yds:0, off_rush_yds:0, off_pass_yds:0, off_turnovers:0,
      def_1st_down:0, def_total_yds:0, def_rush_yds:0, def_pass_yds:0, def_turnovers:0
    };
    const a = byTeamAgg[t];
    a.n += 1;
    a.wins += r.win ? 1 : 0;
    a.losses += r.win ? 0 : 1;

    a.off_1st_down  += r.off_1st_down;
    a.off_total_yds += r.off_total_yds;
    a.off_rush_yds  += r.off_rush_yds;
    a.off_pass_yds  += r.off_pass_yds;
    a.off_turnovers += r.off_turnovers;

    a.def_1st_down  += r.def_1st_down;
    a.def_total_yds += r.def_total_yds;
    a.def_rush_yds  += r.def_rush_yds;
    a.def_pass_yds  += r.def_pass_yds;
    a.def_turnovers += r.def_turnovers;
  }

  // League means (per game)
  let league = null;
  {
    let nGames = 0;
    const sum = {
      off_1st_down:0, off_total_yds:0, off_rush_yds:0, off_pass_yds:0, off_turnovers:0,
      def_1st_down:0, def_total_yds:0, def_rush_yds:0, def_pass_yds:0, def_turnovers:0
    };
    for (const t of Object.keys(byTeamAgg)) {
      const a = byTeamAgg[t]; if (!a.n) continue;
      nGames += a.n;
      sum.off_1st_down  += a.off_1st_down;
      sum.off_total_yds += a.off_total_yds;
      sum.off_rush_yds  += a.off_rush_yds;
      sum.off_pass_yds  += a.off_pass_yds;
      sum.off_turnovers += a.off_turnovers;

      sum.def_1st_down  += a.def_1st_down;
      sum.def_total_yds += a.def_total_yds;
      sum.def_rush_yds  += a.def_rush_yds;
      sum.def_pass_yds  += a.def_pass_yds;
      sum.def_turnovers += a.def_turnovers;
    }
    if (nGames > 0) {
      league = {};
      for (const k of Object.keys(sum)) league[k] = sum[k] / nGames;
    }
  }

  const byTeam = {};
  for (const t of Object.keys(byTeamAgg)) {
    const a = byTeamAgg[t];
    if (!a.n) continue;
    byTeam[t] = {
      off_1st_down_s2d:  a.off_1st_down  / a.n,
      off_total_yds_s2d: a.off_total_yds / a.n,
      off_rush_yds_s2d:  a.off_rush_yds  / a.n,
      off_pass_yds_s2d:  a.off_pass_yds  / a.n,
      off_turnovers_s2d: a.off_turnovers / a.n,
      def_1st_down_s2d:  a.def_1st_down  / a.n,
      def_total_yds_s2d: a.def_total_yds / a.n,
      def_rush_yds_s2d:  a.def_rush_yds  / a.n,
      def_pass_yds_s2d:  a.def_pass_yds  / a.n,
      def_turnovers_s2d: a.def_turnovers / a.n,
      wins_s2d: a.wins,
      losses_s2d: a.losses
    };
  }

  return { byTeam, league };
}

export function buildFeatures({ teamWeekly, schedules, season, prevTeamWeekly }) {
  const prevSeason = Number(season) - 1;

  // schedules index for current season REG only (schedules are well-formed)
  const schedByKey = {};
  const weekGames = {};
  for (const g of schedules) {
    if (Number(g.season) !== Number(season)) continue;
    if (!isRegSeasonValue(g.season_type)) continue;
    const home = g.home_team, away = g.away_team;
    const key = `${g.season}|${g.week}|${home}|${away}`;
    schedByKey[key] = g;
    const wkKey = `${g.season}|${g.week}`;
    if (!weekGames[wkKey]) weekGames[wkKey] = [];
    const date = parseDate(g.gameday || g.game_date || g.game_datetime || g.game_time);
    weekGames[wkKey].push({ home, away, date });
  }

  // previous-season baselines
  const { byTeam: prevBaseByTeam, league: prevLeagueMean } =
    buildPrevSeasonBaselines(prevTeamWeekly || [], prevSeason, schedules);

  // raw index (current season; RELAXED season_type check)
  const byKeyRaw = {};
  for (const r of teamWeekly) {
    if (Number(r.season) !== Number(season)) continue;
    if (!isRegSeasonValue(r.season_type)) continue; // relaxed (missing => true)
    byKeyRaw[`${r.season}|${r.week}|${r.team}`] = r;
  }

  // base rows: offense/label/home/date
  const base = [];
  for (const r of teamWeekly) {
    if (Number(r.season) !== Number(season)) continue;
    if (!isRegSeasonValue(r.season_type)) continue;

    const wk  = Number(r.week);
    const tm  = r.team;
    const opp = r.opponent_team;

    const keyHome = `${season}|${wk}|${tm}|${opp}`;
    const keyAway = `${season}|${wk}|${opp}|${tm}`;
    const home = schedByKey[keyHome] ? 1 : (schedByKey[keyAway] ? 0 : 0);

    const pointsFor     = Number(r.points_for ?? r.points ?? 0);
    const pointsAgainst = Number(r.points_against ?? r.points_allowed ?? 0);
    const win = pointsFor >= pointsAgainst ? 1 : 0;

    const off = offenseFromRow(r);

    const schedHome = schedByKey[keyHome] || null;
    const schedAway = schedByKey[keyAway] || null;
    const date = parseDate(
      (schedHome && (schedHome.gameday || schedHome.game_date || schedHome.game_datetime)) ||
      (schedAway && (schedAway.gameday || schedAway.game_date || schedAway.game_datetime))
    );

    base.push({
      season: Number(season),
      week: wk,
      team: tm,
      opponent: opp,
      home,
      game_date: date ? date.toISOString() : null,
      win,
      points_for: pointsFor,
      points_against: pointsAgainst,
      ...off
    });
  }

  // add defense allowed from opponent
  const out = [];
  for (const row of base) {
    const teamRowRaw = byKeyRaw[`${season}|${row.week}|${row.team}`];
    const oppRowRaw  = byKeyRaw[`${season}|${row.week}|${row.opponent}`];
    if (!teamRowRaw || !oppRowRaw) continue;
    const def = defenseAllowedFromPair(teamRowRaw, oppRowRaw);
    out.push({ ...row, ...def });
  }

  // S2D with Week-1 carry-in
  const grouped = {};
  for (const r of out) {
    const k = `${r.season}|${r.team}`;
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(r);
  }

  const s2dRows = [];
  for (const k of Object.keys(grouped)) {
    const arr = grouped[k].sort((a,b)=> a.week - b.week);
    let n = 0;
    const cum = {
      off_1st_down:0, off_total_yds:0, off_rush_yds:0, off_pass_yds:0, off_turnovers:0,
      def_1st_down:0, def_total_yds:0, def_rush_yds:0, def_pass_yds:0, def_turnovers:0
    };
    let wins=0, losses=0;
    let lastDate = null;

    for (const r of arr) {
      const hasHistory = n > 0;

      const curDate = r.game_date ? new Date(r.game_date) : null;
      let rest_days = null;
      if (hasHistory && lastDate && curDate) {
        const diffMs = curDate.getTime() - lastDate.getTime();
        rest_days = Math.max(0, Math.round(diffMs / (1000*60*60*24)));
      }

      let row = {
        ...r,
        off_1st_down_s2d: hasHistory ? cum.off_1st_down / n : null,
        off_total_yds_s2d: hasHistory ? cum.off_total_yds / n : null,
        off_rush_yds_s2d: hasHistory ? cum.off_rush_yds / n : null,
        off_pass_yds_s2d: hasHistory ? cum.off_pass_yds / n : null,
        off_turnovers_s2d: hasHistory ? cum.off_turnovers / n : null,
        def_1st_down_s2d: hasHistory ? cum.def_1st_down / n : null,
        def_total_yds_s2d: hasHistory ? cum.def_total_yds / n : null,
        def_rush_yds_s2d: hasHistory ? cum.def_rush_yds / n : null,
        def_pass_yds_s2d: hasHistory ? cum.def_pass_yds / n : null,
        def_turnovers_s2d: hasHistory ? cum.def_turnovers / n : null,
        wins_s2d: hasHistory ? wins : null,
        losses_s2d: hasHistory ? losses : null,
        rest_days
      };

      if (!hasHistory && r.week === 1) {
        const teamBase = prevBaseByTeam[r.team];
        const L = prevLeagueMean;
        const fill = (k) => {
          if (teamBase && Number.isFinite(teamBase[k])) return teamBase[k];
          if (L) {
            const rawKey = k.replace("_s2d",""); // e.g., off_total_yds
            if (Number.isFinite(L[rawKey])) return L[rawKey];
          }
          return 0;
        };
        row = {
          ...row,
          off_1st_down_s2d:  fill("off_1st_down_s2d"),
          off_total_yds_s2d: fill("off_total_yds_s2d"),
          off_rush_yds_s2d:  fill("off_rush_yds_s2d"),
          off_pass_yds_s2d:  fill("off_pass_yds_s2d"),
          off_turnovers_s2d: fill("off_turnovers_s2d"),
          def_1st_down_s2d:  fill("def_1st_down_s2d"),
          def_total_yds_s2d: fill("def_total_yds_s2d"),
          def_rush_yds_s2d:  fill("def_rush_yds_s2d"),
          def_pass_yds_s2d:  fill("def_pass_yds_s2d"),
          def_turnovers_s2d: fill("def_turnovers_s2d"),
          wins_s2d: (teamBase && Number.isFinite(teamBase.wins_s2d)) ? teamBase.wins_s2d : 0,
          losses_s2d: (teamBase && Number.isFinite(teamBase.losses_s2d)) ? teamBase.losses_s2d : 0
        };
      }

      s2dRows.push(row);

      // update cumulative
      n += 1;
      cum.off_1st_down += r.off_1st_down;
      cum.off_total_yds += r.off_total_yds;
      cum.off_rush_yds  += r.off_rush_yds;
      cum.off_pass_yds  += r.off_pass_yds;
      cum.off_turnovers += r.off_turnovers;
      cum.def_1st_down  += r.def_1st_down;
      cum.def_total_yds += r.def_total_yds;
      cum.def_rush_yds  += r.def_rush_yds;
      cum.def_pass_yds  += r.def_pass_yds;
      cum.def_turnovers += r.def_turnovers;

      if (r.win) wins += 1; else losses += 1;
      if (curDate) lastDate = curDate;
    }
  }

  const finalRows = s2dRows;

  // opponent S2D index
  const s2dIndex = {};
  for (const r of finalRows) s2dIndex[`${r.season}|${r.week}|${r.team}`] = r;

  // similar-opponent (same venue)
  const OPP_S2D = [
    "off_total_yds_s2d","off_rush_yds_s2d","off_pass_yds_s2d","off_turnovers_s2d",
    "def_total_yds_s2d","def_rush_yds_s2d","def_pass_yds_s2d","def_turnovers_s2d",
    "off_1st_down_s2d","def_1st_down_s2d"
  ];
  function buildOppVec(oppRow) {
    if (!oppRow) return null;
    const v = [];
    for (const k of OPP_S2D) {
      const val = Number(oppRow[k]);
      if (!Number.isFinite(val)) return null;
      v.push(val);
    }
    const norm = Math.sqrt(v.reduce((s,x)=>s+x*x,0)) || 1;
    return v.map(x => x / norm);
  }
  function cosine(u, v) {
    if (!u || !v) return null;
    let dot=0; for (let i=0;i<u.length;i++) dot += u[i]*v[i];
    return dot;
  }

  const byTeam = {};
  for (const r of finalRows) {
    const key = `${r.season}|${r.team}`;
    if (!byTeam[key]) byTeam[key] = [];
    byTeam[key].push(r);
  }
  for (const k of Object.keys(byTeam)) byTeam[k].sort((a,b)=> a.week - b.week);

  const TOP_K = 6;
  const withSimilar = [];
  for (const teamKey of Object.keys(byTeam)) {
    const arr = byTeam[teamKey];
    for (let idx = 0; idx < arr.length; idx++) {
      const cur = arr[idx];
      const curOpp = s2dIndex[`${cur.season}|${cur.week}|${cur.opponent}`];
      const curOppVec = buildOppVec(curOpp);

      const cands = [];
      for (let j = 0; j < idx; j++) {
        const prev = arr[j];
        if (prev.home !== cur.home) continue;
        const prevOpp = s2dIndex[`${prev.season}|${prev.week}|${prev.opponent}`];
        const prevOppVec = buildOppVec(prevOpp);
        if (!curOppVec || !prevOppVec) continue;
        const sim = cosine(curOppVec, prevOppVec);
        if (sim == null || sim <= 0) continue;
        const pdiff = Number(prev.points_for) - Number(prev.points_against);
        cands.push({ sim, win: prev.win, pdiff });
      }
      cands.sort((a,b)=> b.sim - a.sim);
      const top = cands.slice(0, TOP_K);

      let wsum = 0, wwins = 0, wpdiff = 0, count = 0;
      for (const c of top) {
        const w = Math.max(c.sim, 1e-6);
        wsum += w; wwins += w*c.win; wpdiff += w*c.pdiff; count += 1;
      }
      const sim_winrate = wsum > 0 ? (wwins/wsum) : 0;
      const sim_pdiff   = wsum > 0 ? (wpdiff/wsum) : 0;

      withSimilar.push({
        ...cur,
        sim_winrate_same_loc_s2d: sim_winrate,
        sim_pointdiff_same_loc_s2d: sim_pdiff,
        sim_count_same_loc_s2d: count
      });
    }
  }

  // opponent-adjusted DIFFERENTIALS
  const withDiffs = withSimilar.map(r => {
    const opp = s2dIndex[`${r.season}|${r.week}|${r.opponent}`];
    const diff = (a,b)=> (Number(a??0) - Number(b??0)) || 0;
    return {
      ...r,
      off_total_yds_s2d_minus_opp: diff(r.off_total_yds_s2d, opp?.off_total_yds_s2d),
      def_total_yds_s2d_minus_opp: diff(r.def_total_yds_s2d, opp?.def_total_yds_s2d),
      off_turnovers_s2d_minus_opp:  diff(r.off_turnovers_s2d,  opp?.off_turnovers_s2d),
      def_turnovers_s2d_minus_opp:  diff(r.def_turnovers_s2d,  opp?.def_turnovers_s2d),
      rest_diff: (Number(r.rest_days ?? 0) - Number(opp?.rest_days ?? 0))
    };
  });

  // Elo (pre-game)
  const ELO_INIT = 1500, HFA = 55, K = 20;
  const teamElo = {};
  const getElo = t => (t in teamElo ? teamElo[t] : (teamElo[t] = ELO_INIT));
  const expected = (A,B) => 1/(1+Math.pow(10,(B-A)/400));

  const idxRow = {};
  for (const r of withDiffs) idxRow[`${r.season}|${r.week}|${r.team}`] = r;

  const weeksSorted = [...new Set(withDiffs.map(r=> r.week))].sort((a,b)=> a-b);
  for (const wk of weeksSorted) {
    const games = (weekGames[`${season}|${wk}`] || []);
    // assign pre-game Elo
    for (const g of games) {
      const home = g.home, away = g.away;
      const rh = idxRow[`${season}|${wk}|${home}`], ra = idxRow[`${season}|${wk}|${away}`];
      if (!rh || !ra) continue;
      const eloH = getElo(home), eloA = getElo(away);
      rh.elo_pre = eloH + HFA; ra.elo_pre = eloA;
      rh.elo_diff = (rh.elo_pre - (ra.elo_pre ?? eloA));
      ra.elo_diff = (ra.elo_pre - (rh.elo_pre ?? eloH+HFA));
    }
    // update post-game Elo using margin
    for (const g of games) {
      const home = g.home, away = g.away;
      const rh = idxRow[`${season}|${wk}|${home}`], ra = idxRow[`${season}|${wk}|${away}`];
      if (!rh || !ra) continue;
      const ph = Number(rh.points_for ?? 0), pa = Number(rh.points_against ?? 0);
      const margin = ph - pa;
      const eloH0 = getElo(home), eloA0 = getElo(away);
      const expH = expected(eloH0 + HFA, eloA0);
      const scoreH = margin > 0 ? 1 : (margin < 0 ? 0 : 0.5);
      const marginMult = Math.log(Math.abs(margin) + 1) * (2.2 / ((Math.abs((eloH0 - eloA0))/1000) + 2.2));
      const kAdj = K * (1 + marginMult);
      teamElo[home] = eloH0 + kAdj * (scoreH - expH);
      teamElo[away] = eloA0 + kAdj * ((1 - scoreH) - (1 - expH));
    }
  }
  for (const r of withDiffs) {
    if (!Number.isFinite(r.elo_pre)) r.elo_pre = ELO_INIT;
    if (!Number.isFinite(r.elo_diff)) r.elo_diff = 0;
  }

  return withDiffs;
}
