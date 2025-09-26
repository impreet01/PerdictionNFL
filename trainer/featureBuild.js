// trainer/featureBuild.js
// Build pre-game Season-To-Date (S2D) features aligned to the paper,
// add "similar-opponent, same-venue" features, opponent-adjusted DIFFERENTIALS,
// pre-game Elo ratings, and rest-days features.
//
// Inputs expected (team-week CSV: stats_team_week_<season>.csv):
//   season, week, team, season_type, opponent_team,
//   passing_yards, rushing_yards,
//   passing_first_downs, rushing_first_downs, receiving_first_downs,
//   passing_interceptions, rushing_fumbles_lost, receiving_fumbles_lost, sack_fumbles_lost,
//   def_interceptions, fumble_recovery_opp,
//   points_for (or points), points_against (or points_allowed)
//
// From schedules (games.csv) we need: season, week, season_type, home_team, away_team, gameday (or game_date), game_id
//
// Derived:
//   - Paper S2D features (off/def yards, 1st downs, turnovers, wins_s2d, losses_s2d, home, label win)
//   - Similar-opponent, same-venue features: sim_winrate_same_loc_s2d, sim_pointdiff_same_loc_s2d, sim_count_same_loc_s2d
//   - Opponent-adjusted DIFFERENTIALS: *_s2d_minus_opp
//   - Pre-game Elo ratings: elo_pre, elo_diff (team minus opponent); margin-aware, no leakage
//   - Rest days features: rest_days, opp_rest_days, rest_diff

function parseDate(d) {
  // Robust parse: try common fields and formats
  if (!d) return null;
  const t = String(d).trim();
  // Some files use YYYY-MM-DD, some have time too
  const dt = new Date(t);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function buildFeatures({ teamWeekly, schedules, season }) {
  // ---------------- Schedules index ----------------
  const schedByKey = {};
  const weekGames = {}; // season|week -> [{home, away, date}]
  for (const g of schedules) {
    if (Number(g.season) !== Number(season)) continue;
    if (String(g.season_type).toUpperCase() !== "REG") continue;
    const home = g.home_team;
    const away = g.away_team;
    const key = `${g.season}|${g.week}|${home}|${away}`;
    schedByKey[key] = g;

    const wkKey = `${g.season}|${g.week}`;
    if (!weekGames[wkKey]) weekGames[wkKey] = [];
    const date = parseDate(g.gameday || g.game_date || g.game_datetime || g.game_time);
    weekGames[wkKey].push({ home, away, date });
  }

  // ---------------- Quick index of raw team-week rows ----------------
  const byKeyRaw = {};
  for (const r of teamWeekly) {
    if (Number(r.season) !== Number(season)) continue;
    if (String(r.season_type).toUpperCase() !== "REG") continue;
    byKeyRaw[`${r.season}|${r.week}|${r.team}`] = r;
  }

  // ---------------- Helpers ----------------
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
  function defenseFromPair(teamRowRaw, oppRowRaw) {
    const oppOff = offenseFromRow(oppRowRaw);
    const def_total_yds = oppOff.off_total_yds;
    const def_rush_yds  = oppOff.off_rush_yds;
    const def_pass_yds  = oppOff.off_pass_yds;
    const def_1st_down  = oppOff.off_1st_down;
    const def_turnovers = Number(teamRowRaw.def_interceptions ?? 0) + Number(teamRowRaw.fumble_recovery_opp ?? 0);
    return { def_total_yds, def_rush_yds, def_pass_yds, def_1st_down, def_turnovers };
  }

  // ---------------- Base rows: offense, label, home, points ----------------
  const base = [];
  for (const r of teamWeekly) {
    if (Number(r.season) !== Number(season)) continue;
    if (String(r.season_type).toUpperCase() !== "REG") continue;

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

    // rest-day date lookup
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

  // ---------------- Add defense allowed (from opponent's offense) ----------------
  const out = [];
  for (const row of base) {
    const teamRowRaw = byKeyRaw[`${season}|${row.week}|${row.team}`];
    const oppRowRaw  = byKeyRaw[`${season}|${row.week}|${row.opponent}`];
    if (!teamRowRaw || !oppRowRaw) continue;
    const def = defenseFromPair(teamRowRaw, oppRowRaw);
    out.push({ ...row, ...def });
  }

  // ---------------- Season-to-date (pre-game) ----------------
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

      // rest days (since last game)
      const curDate = r.game_date ? new Date(r.game_date) : null;
      let rest_days = null;
      if (hasHistory && lastDate && curDate) {
        const diffMs = curDate.getTime() - lastDate.getTime();
        rest_days = Math.max(0, Math.round(diffMs / (1000*60*60*24)));
      }

      s2dRows.push({
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
        rest_days // may be null for first game
      });

      // update cumulative AFTER (no leakage)
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

  // drop rows without S2D history
  const finalRows = s2dRows.filter(r => r.off_total_yds_s2d != null);

  // ---------------- Index for opponent S2D ----------------
  const s2dIndex = {};
  for (const r of finalRows) s2dIndex[`${r.season}|${r.week}|${r.team}`] = r;

  // ---------------- Similar-opponent, same-venue features ----------------
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
      const sim_pdiff = wsum > 0 ? (wpdiff/wsum) : 0;

      withSimilar.push({
        ...cur,
        sim_winrate_same_loc_s2d: sim_winrate,
        sim_pointdiff_same_loc_s2d: sim_pdiff,
        sim_count_same_loc_s2d: count
      });
    }
  }

  // ---------------- Opponent-adjusted DIFFERENTIALS (team S2D minus opponent S2D) ----------------
  const withDiffs = withSimilar.map(r => {
    const opp = s2dIndex[`${r.season}|${r.week}|${r.opponent}`];
    function diff(a,b){ const A=Number(a??0), B=Number(b??0); return (Number.isFinite(A)&&Number.isFinite(B))? (A-B):0; }
    return {
      ...r,
      off_total_yds_s2d_minus_opp: diff(r.off_total_yds_s2d, opp?.off_total_yds_s2d),
      def_total_yds_s2d_minus_opp: diff(r.def_total_yds_s2d, opp?.def_total_yds_s2d),
      off_turnovers_s2d_minus_opp:  diff(r.off_turnovers_s2d,  opp?.off_turnovers_s2d),
      def_turnovers_s2d_minus_opp:  diff(r.def_turnovers_s2d,  opp?.def_turnovers_s2d),
      rest_diff: (Number(r.rest_days ?? 0) - Number(opp?.rest_days ?? 0))
    };
  });

  // ---------------- Pre-game Elo ratings (no leakage) ----------------
  // Process week by week; assign elo_pre for both teams before updating with result
  const ELO_INIT = 1500;
  const HFA = 55;      // home-field advantage in Elo points
  const K = 20;        // base K
  const teamElo = {};  // team -> current elo

  function getElo(t){ if (!(t in teamElo)) teamElo[t] = ELO_INIT; return teamElo[t]; }
  function expected(eloA, eloB){ return 1/(1+Math.pow(10, (eloB - eloA)/400)); }

  // Build quick map: (season|week|team) -> mutable row to attach elo_pre
  const idxRow = {};
  for (const r of withDiffs) idxRow[`${r.season}|${r.week}|${r.team}`] = r;

  const weeksSorted = [...new Set(withDiffs.map(r=> r.week))].sort((a,b)=> a-b);
  for (const wk of weeksSorted) {
    const games = (weekGames[`${season}|${wk}`] || []);
    // assign pre-game elo
    for (const g of games) {
      const home = g.home, away = g.away;
      const homeRow = idxRow[`${season}|${wk}|${home}`];
      const awayRow = idxRow[`${season}|${wk}|${away}`];
      if (!homeRow || !awayRow) continue; // safety
      const eloH = getElo(home), eloA = getElo(away);
      homeRow.elo_pre = eloH + HFA;
      awayRow.elo_pre = eloA;
      homeRow.elo_diff = (homeRow.elo_pre - (awayRow.elo_pre ?? eloA));
      awayRow.elo_diff = (awayRow.elo_pre - (homeRow.elo_pre ?? eloH+HFA));
    }
    // update post-game using margin
    for (const g of games) {
      const home = g.home, away = g.away;
      const homeRow = idxRow[`${season}|${wk}|${home}`];
      const awayRow = idxRow[`${season}|${wk}|${away}`];
      if (!homeRow || !awayRow) continue;
      const ph = Number(homeRow.points_for ?? 0);
      const pa = Number(homeRow.points_against ?? 0);
      const margin = ph - pa;

      const eloH_before = getElo(home);
      const eloA_before = getElo(away);
      const expH = expected(eloH_before + HFA, eloA_before);
      const scoreH = margin > 0 ? 1 : (margin < 0 ? 0 : 0.5);

      const marginMult = Math.log(Math.abs(margin) + 1) * (2.2 / ((Math.abs((eloH_before - eloA_before))/1000) + 2.2));
      const kAdj = K * (1 + marginMult);

      const newH = eloH_before + kAdj * (scoreH - expH);
      const newA = eloA_before + kAdj * ((1 - scoreH) - (1 - expH));

      teamElo[home] = newH;
      teamElo[away] = newA;
    }
  }

  // default elo_pre/diff if missing (early weeks)
  for (const r of withDiffs) {
    if (!Number.isFinite(r.elo_pre)) r.elo_pre = ELO_INIT;
    if (!Number.isFinite(r.elo_diff)) r.elo_diff = 0;
  }

  return withDiffs;
}
