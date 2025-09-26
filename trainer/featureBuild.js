// trainer/featureBuild.js
// Build pre-game Season-To-Date (S2D) features aligned to the paper, using columns found in stats_team_week_<season>.csv.
//
// Inputs required on each row (team-week):
//   season, week, team, season_type, opponent_team,
//   passing_yards, rushing_yards,
//   passing_first_downs, rushing_first_downs, receiving_first_downs,
//   passing_interceptions, rushing_fumbles_lost, receiving_fumbles_lost, sack_fumbles_lost,
//   def_interceptions, fumble_recovery_opp
//
// We derive:
//   off_total_yds, off_rush_yds, off_pass_yds, off_1st_down, off_turnovers,
//   def_total_yds, def_rush_yds, def_pass_yds, def_1st_down, def_turnovers,
//   win (points_for >= points_against), home (1/0), opponent
//
// Defensive "allowed" stats are computed by looking at the OPPONENT's offensive stats for that same game.

export function buildFeatures({ teamWeekly, schedules, season }) {
  // Index schedules (REG only) by (season, week, home_team, away_team)
  const sched = {};
  for (const g of schedules) {
    if (g.season !== season || g.season_type !== "REG") continue;
    // key by game_id for safety, also by week+teams
    const key = `${g.season}|${g.week}|${g.home_team}|${g.away_team}`;
    sched[key] = g;
  }

  // Build quick index of teamWeekly rows by (season, week, team)
  const byKey = {};
  for (const r of teamWeekly) {
    if (r.season !== season || r.season_type !== "REG") continue;
    byKey[`${r.season}|${r.week}|${r.team}`] = r;
  }

  // Helper to compute offense-side aggregates from a row
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

  // Defense "allowed" is opponent offense; defense takeaways from def_* stats
  function defenseFromPair(teamRow, oppRow) {
    // Allowed yards/first downs from opponent offense
    const oppOff = offenseFromRow(oppRow);
    const def_total_yds = oppOff.off_total_yds;
    const def_rush_yds  = oppOff.off_rush_yds;
    const def_pass_yds  = oppOff.off_pass_yds;
    const def_1st_down  = oppOff.off_1st_down;

    // Takeaways from team defensive stats + ball recovery context
    const def_turnovers = Number(teamRow.def_interceptions ?? 0) + Number(teamRow.fumble_recovery_opp ?? 0);

    return { def_total_yds, def_rush_yds, def_pass_yds, def_1st_down, def_turnovers };
  }

  // Build base rows with offense + labels, then enrich defense using opponent rows
  const base = [];
  for (const r of teamWeekly) {
    if (r.season !== season || r.season_type !== "REG") continue;

    // determine home via schedules
    let home = null;
    // find schedule row by matching team/opponent that week
    const wk = r.week;
    const tm = r.team;
    const opp = r.opponent_team;
    const keyHome = `${season}|${wk}|${tm}|${opp}`;
    const keyAway = `${season}|${wk}|${opp}|${tm}`;
    if (sched[keyHome]) home = 1;
    else if (sched[keyAway]) home = 0;
    else home = null; // should be rare; schedules file normally has both teams

    // outcome label (prefer points if present; otherwise skip label)
    const pointsFor = Number(r.points_for ?? r.points ?? 0);
    const pointsAgainst = Number(r.points_against ?? r.points_allowed ?? 0);
    const win = pointsFor >= pointsAgainst ? 1 : 0;

    const off = offenseFromRow(r);

    base.push({
      season,
      week: wk,
      team: tm,
      opponent: opp,
      home: home ?? 0, // default 0 if unknown
      win,
      ...off
    });
  }

  // Enrich with defense allowed by joining the opponent's row
  const out = [];
  for (const row of base) {
    const oppRow = byKey[`${season}|${row.week}|${row.opponent}`];
    if (!oppRow) continue; // skip if opponent row missing (should not happen)
    const def = defenseFromPair(byKey[`${season}|${row.week}|${row.team}`], oppRow);
    out.push({ ...row, ...def });
  }

  // Now compute S2D (averages THROUGH prior games) and record to date
  // Group by team in season, sort by week
  const grouped = {};
  for (const r of out) {
    const k = `${r.season}|${r.team}`;
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(r);
  }

  const finalRows = [];
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
      finalRows.push({
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

      // update cumulative AFTER pushing (so current game not leaked)
      n += 1;
      cum.off_1st_down += r.off_1st_down;
      cum.off_total_yds += r.off_total_yds;
      cum.off_rush_yds += r.off_rush_yds;
      cum.off_pass_yds += r.off_pass_yds;
      cum.off_turnovers += r.off_turnovers;
      cum.def_1st_down += r.def_1st_down;
      cum.def_total_yds += r.def_total_yds;
      cum.def_rush_yds += r.def_rush_yds;
      cum.def_pass_yds += r.def_pass_yds;
      cum.def_turnovers += r.def_turnovers;

      if (r.win) wins += 1; else losses += 1;
    }
  }

  // drop week-1 rows (no S2D history)
  return finalRows.filter(r => r.off_total_yds_s2d != null);
}
