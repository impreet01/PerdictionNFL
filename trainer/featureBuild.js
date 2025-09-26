// trainer/featureBuild.js
// Build pre-game Season-To-Date (S2D) features aligned to the paper,
// and add "similar-opponent, same-venue" historical features.
//
// Inputs expected per team-week row (from stats_team_week_<season>.csv):
//   season, week, team, season_type, opponent_team,
//   passing_yards, rushing_yards,
//   passing_first_downs, rushing_first_downs, receiving_first_downs,
//   passing_interceptions, rushing_fumbles_lost, receiving_fumbles_lost, sack_fumbles_lost,
//   def_interceptions, fumble_recovery_opp,
//   points_for (or points), points_against (or points_allowed)
//
// We derive per game (pre-game S2D):
//   off_total_yds_s2d, off_rush_yds_s2d, off_pass_yds_s2d, off_1st_down_s2d, off_turnovers_s2d,
//   def_total_yds_s2d, def_rush_yds_s2d, def_pass_yds_s2d, def_1st_down_s2d, def_turnovers_s2d,
//   wins_s2d, losses_s2d, home (1/0), win (label), points_for, points_against
//
// NEW similarity features (computed from prior games only, same venue):
//   sim_winrate_same_loc_s2d         (0..1 weighted win rate vs similar opponents)
//   sim_pointdiff_same_loc_s2d       (weighted average points_for - points_against)
//   sim_count_same_loc_s2d           (# of prior games used in similarity set)

export function buildFeatures({ teamWeekly, schedules, season }) {
  // Index schedules (REG only) by (season|week|home_team|away_team)
  const sched = {};
  for (const g of schedules) {
    if (g.season !== season || String(g.season_type).toUpperCase() !== "REG") continue;
    const key = `${g.season}|${g.week}|${g.home_team}|${g.away_team}`;
    sched[key] = g;
  }

  // Quick index of raw teamWeekly rows by (season|week|team)
  const byKeyRaw = {};
  for (const r of teamWeekly) {
    if (r.season !== season || String(r.season_type).toUpperCase() !== "REG") continue;
    byKeyRaw[`${r.season}|${r.week}|${r.team}`] = r;
  }

  // ---- Offense & label helpers ----
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
    // Allowed yards/first downs come from opponent's offense
    const oppOff = offenseFromRow(oppRowRaw);
    const def_total_yds = oppOff.off_total_yds;
    const def_rush_yds  = oppOff.off_rush_yds;
    const def_pass_yds  = oppOff.off_pass_yds;
    const def_1st_down  = oppOff.off_1st_down;

    // Takeaways from team defensive stats
    const def_turnovers = Number(teamRowRaw.def_interceptions ?? 0) + Number(teamRowRaw.fumble_recovery_opp ?? 0);
    return { def_total_yds, def_rush_yds, def_pass_yds, def_1st_down, def_turnovers };
  }

  // ---- Base rows with offense + labels + home ----
  const base = [];
  for (const r of teamWeekly) {
    if (r.season !== season || String(r.season_type).toUpperCase() !== "REG") continue;

    const wk  = r.week;
    const tm  = r.team;
    const opp = r.opponent_team;

    // venue via schedules
    const keyHome = `${season}|${wk}|${tm}|${opp}`;
    const keyAway = `${season}|${wk}|${opp}|${tm}`;
    const home = sched[keyHome] ? 1 : (sched[keyAway] ? 0 : 0);

    const pointsFor     = Number(r.points_for ?? r.points ?? 0);
    const pointsAgainst = Number(r.points_against ?? r.points_allowed ?? 0);
    const win = pointsFor >= pointsAgainst ? 1 : 0;

    const off = offenseFromRow(r);

    base.push({
      season,
      week: wk,
      team: tm,
      opponent: opp,
      home,
      win,
      points_for: pointsFor,
      points_against: pointsAgainst,
      ...off
    });
  }

  // ---- Enrich with defense allowed using opponent's offense that week ----
  const out = [];
  for (const row of base) {
    const teamRowRaw = byKeyRaw[`${season}|${row.week}|${row.team}`];
    const oppRowRaw  = byKeyRaw[`${season}|${row.week}|${row.opponent}`];
    if (!teamRowRaw || !oppRowRaw) continue;
    const def = defenseFromPair(teamRowRaw, oppRowRaw);
    out.push({ ...row, ...def });
  }

  // ---- Compute S2D (averages through prior games) and record to date ----
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

    for (const r of arr) {
      const hasHistory = n > 0;
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
        losses_s2d: hasHistory ? losses : null
      });

      // update cumulative AFTER pushing (no leakage)
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
    }
  }

  // drop week-1 rows (no S2D history)
  const finalRows = s2dRows.filter(r => r.off_total_yds_s2d != null);

  // ---- Build an index to access the opponent's S2D for a given (season,week,team) ----
  const s2dIndex = {};
  for (const r of finalRows) {
    s2dIndex[`${r.season}|${r.week}|${r.team}`] = r;
  }

  // ---- Add Similar-Opponent Same-Venue features (historical only) ----
  // similarity vector uses opponent's S2D profile
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
      if (!Number.isFinite(val)) return null; // require all components
      v.push(val);
    }
    // L2 normalize for cosine similarity stability
    const norm = Math.sqrt(v.reduce((s,x)=>s+x*x,0)) || 1;
    return v.map(x => x / norm);
  }

  function cosine(u, v) {
    if (!u || !v) return null;
    let dot=0;
    for (let i=0;i<u.length;i++) dot += u[i]*v[i];
    return dot; // since both are normalized
  }

  // group finalRows again by team for chronological access
  const byTeam = {};
  for (const r of finalRows) {
    const key = `${r.season}|${r.team}`;
    if (!byTeam[key]) byTeam[key] = [];
    byTeam[key].push(r);
  }
  for (const key of Object.keys(byTeam)) {
    byTeam[key].sort((a,b)=> a.week - b.week);
  }

  const TOP_K = 6; // use top-6 most similar prior games at same venue

  const enriched = [];
  for (const teamKey of Object.keys(byTeam)) {
    const arr = byTeam[teamKey];
    for (let idx = 0; idx < arr.length; idx++) {
      const cur = arr[idx];

      // current opponent S2D vector (pre-game of current week)
      const curOpp = s2dIndex[`${cur.season}|${cur.week}|${cur.opponent}`];
      const curOppVec = buildOppVec(curOpp);

      // scan prior games for same venue
      const cands = [];
      for (let j = 0; j < idx; j++) {
        const prev = arr[j];
        if (prev.home !== cur.home) continue; // same venue only

        const prevOpp = s2dIndex[`${prev.season}|${prev.week}|${prev.opponent}`];
        const prevOppVec = buildOppVec(prevOpp);
        if (!curOppVec || !prevOppVec) continue;

        const sim = cosine(curOppVec, prevOppVec);
        if (sim == null || sim <= 0) continue; // ignore dissimilar or negative cosine
        const pdiff = Number(prev.points_for) - Number(prev.points_against);
        cands.push({ sim, win: prev.win, pdiff });
      }

      // take top-K by similarity
      cands.sort((a,b)=> b.sim - a.sim);
      const top = cands.slice(0, TOP_K);

      let wsum = 0, wwins = 0, wpdiff = 0, count = 0;
      for (const c of top) {
        const w = Math.max(c.sim, 1e-6); // nonzero
        wsum += w;
        wwins += w * c.win;
        wpdiff += w * c.pdiff;
        count += 1;
      }

      const sim_winrate = wsum > 0 ? (wwins / wsum) : 0;
      const sim_pdiff   = wsum > 0 ? (wpdiff / wsum) : 0;

      enriched.push({
        ...cur,
        sim_winrate_same_loc_s2d: sim_winrate,        // 0..1
        sim_pointdiff_same_loc_s2d: sim_pdiff,        // can be +/- points
        sim_count_same_loc_s2d: count                 // integer
      });
    }
  }

  return enriched;
}
