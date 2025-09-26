// trainer/featureBuild.js
// Build pre-game Season-To-Date (S2D) features aligned to the paper.

/**
 * Build features:
 *  - Offensive: first downs, total yards, rush yards, pass yards, turnovers (giveaways)
 *  - Defensive allowed: first downs, total yards, rush yards, pass yards, turnovers (takeaways)
 *  - wins_s2d, losses_s2d, home (1/0), opponent
 * Input rows expected from nflverse team weekly stats + schedules.
 */

export function buildFeatures({ teamWeekly, schedules, season }) {
  // Index schedules by game_id for the target season REG
  const games = {};
  for (const g of schedules) {
    if (g.season === season && g.season_type === "REG") games[g.game_id] = g;
  }

  // Map nflverse team weekly columns -> canonical names.
  // Adjust these if nflverse changes names.
  const map = {
    off_total_yds: "team_total_yards",
    off_rush_yds: "team_rush_yards",
    off_pass_yds: "team_pass_yards",
    off_1st_down: "team_first_downs",
    off_turnovers: "team_turnovers",       // giveaways
    def_total_yds: "opp_total_yards",
    def_rush_yds: "opp_rush_yards",
    def_pass_yds: "opp_pass_yards",
    def_1st_down: "opp_first_downs",
    def_turnovers: "team_takeaways"        // takeaways
  };

  // Build per-team per-week rows
  const byTeam = {};
  for (const r of teamWeekly) {
    if (r.season !== season || r.season_type !== "REG") continue;
    const g = games[r.game_id];
    if (!g) continue;
    const team = r.team;
    const isHome = g.home_team === team ? 1 : 0;
    const opponent = isHome ? g.away_team : g.home_team;

    const row = {
      season,
      week: r.week,
      team,
      opponent,
      home: isHome,
      // label: did this team win?
      win: Number(r.points_for) >= Number(r.points_against) ? 1 : 0,

      off_total_yds: Number(r[map.off_total_yds] ?? r["team_total_yards"] ?? r["total_yards"] ?? 0),
      off_rush_yds: Number(r[map.off_rush_yds] ?? r["team_rush_yards"] ?? 0),
      off_pass_yds: Number(r[map.off_pass_yds] ?? r["team_pass_yards"] ?? 0),
      off_1st_down: Number(r[map.off_1st_down] ?? r["team_first_downs"] ?? 0),
      off_turnovers: Number(r[map.off_turnovers] ?? r["turnovers"] ?? r["team_turnovers"] ?? 0),

      def_total_yds: Number(r[map.def_total_yds] ?? r["opp_total_yards"] ?? 0),
      def_rush_yds: Number(r[map.def_rush_yds] ?? r["opp_rush_yards"] ?? 0),
      def_pass_yds: Number(r[map.def_pass_yds] ?? r["opp_pass_yards"] ?? 0),
      def_1st_down: Number(r[map.def_1st_down] ?? r["opp_first_downs"] ?? 0),
      def_turnovers: Number(r[map.def_turnovers] ?? r["takeaways"] ?? r["team_takeaways"] ?? 0)
    };

    if (!byTeam[team]) byTeam[team] = [];
    byTeam[team].push(row);
  }

  // Compute S2D (averages through prior games) + wins/losses to date
  const out = [];
  for (const team of Object.keys(byTeam)) {
    const arr = byTeam[team].sort((a, b) => a.week - b.week);
    let n = 0;
    const cum = {
      off_1st_down: 0, off_total_yds: 0, off_rush_yds: 0, off_pass_yds: 0, off_turnovers: 0,
      def_1st_down: 0, def_total_yds: 0, def_rush_yds: 0, def_pass_yds: 0, def_turnovers: 0
    };
    let wins = 0, losses = 0;

    for (const r of arr) {
      const hasHistory = n > 0;
      out.push({
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
      // update after
      n += 1;
      for (const k of Object.keys(cum)) cum[k] += r[k];
      if (r.win) wins += 1; else losses += 1;
    }
  }

  return out.filter(r => r.off_total_yds_s2d != null);
}