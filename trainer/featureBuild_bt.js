// trainer/featureBuild_bt.js
//
// Build Bradley-Terry feature set using nflverse team-week stats.
// Output one row per game (home-team perspective) with differential features.

const BT_FEATURES = [
  "diff_total_yards",
  "diff_penalty_yards",
  "diff_turnovers",
  "diff_possession_seconds",
  "diff_r_ratio",
  "delta_power_rank"
];

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const parsePossession = (value) => {
  if (!value) return 0;
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(":").map((p) => Number(p));
  if (parts.length === 2 && parts.every((v) => Number.isFinite(v))) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3 && parts.every((v) => Number.isFinite(v))) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
};

const finalScores = (g) => {
  const hs = g.home_score ?? g.home_points ?? g.home_pts;
  const as = g.away_score ?? g.away_points ?? g.away_pts;
  if (!Number.isFinite(Number(hs)) || !Number.isFinite(Number(as))) return null;
  return { hs: Number(hs), as: Number(as) };
};

const winLabel = (g) => {
  const fs = finalScores(g);
  if (!fs) return null;
  if (fs.hs === fs.as) return null;
  return fs.hs > fs.as ? 1 : 0;
};

const isReg = (v) => {
  if (v == null) return true;
  const s = String(v).trim().toUpperCase();
  return s === "" || s.startsWith("REG");
};

function baseStats(row = {}) {
  const pass = num(row.passing_yards ?? row.pass_yards ?? row.pass_yds);
  const rush = num(row.rushing_yards ?? row.rush_yards ?? row.rush_yds);
  const totalRaw = row.total_yards ?? row.total_yards_gained ?? row.total_yds;
  const total = num(totalRaw, pass + rush);
  const penalties = num(row.penalty_yards ?? row.penalties_yards ?? row.penalty_yards_y);
  const turnovers = num(
    row.turnovers ??
      row.turnover ??
      row.turnovers_total ??
      (row.interceptions ?? row.passing_interceptions ?? 0) +
        (row.fumbles_lost ?? row.rushing_fumbles_lost ?? 0) +
        (row.receiving_fumbles_lost ?? 0) +
        (row.sack_fumbles_lost ?? 0)
  );
  const poss = parsePossession(
    row.possession_time ?? row.time_of_possession ?? row.time_possession ?? row.possession_seconds
  );
  const sacks = num(row.sacks ?? row.sack_total ?? row.qb_sacked ?? row.sacks_taken);
  const plays = num(row.offensive_plays ?? row.offensive_plays_run ?? 0);
  return {
    total_yards: total,
    pass_yards: pass,
    rush_yards: rush,
    penalty_yards: penalties,
    turnovers,
    possession_seconds: poss,
    sacks,
    offensive_plays: plays
  };
}

function blend(currentAvg, prevAvg, week) {
  const prevWeight = Math.max(0, 0.8 - 0.2 * (week - 1));
  const currWeight = 1 - prevWeight;
  const blendField = (k) => prevWeight * num(prevAvg?.[k]) + currWeight * num(currentAvg?.[k]);
  const total = blendField("total_yards");
  const pass = blendField("pass_yards");
  const ratio = total ? pass / total : 0;
  return {
    total_yards: total,
    penalty_yards: blendField("penalty_yards"),
    turnovers: blendField("turnovers"),
    possession_seconds: blendField("possession_seconds"),
    r_ratio: ratio,
    sacks: blendField("sacks"),
    offensive_plays: blendField("offensive_plays")
  };
}

function avgFromTotals(totals) {
  const games = Math.max(1, totals.games || 0);
  return {
    total_yards: num(totals.total_yards) / games,
    penalty_yards: num(totals.penalty_yards) / games,
    turnovers: num(totals.turnovers) / games,
    possession_seconds: num(totals.possession_seconds) / games,
    pass_yards: num(totals.pass_yards) / games,
    sacks: num(totals.sacks) / games,
    offensive_plays: num(totals.offensive_plays) / games
  };
}

function enrichWithRatio(avg) {
  const total = num(avg.total_yards);
  const pass = num(avg.pass_yards);
  return { ...avg, r_ratio: total ? pass / total : 0 };
}

function seedPrevAverages(prevTeamWeekly) {
  const byTeam = new Map();
  for (const row of prevTeamWeekly || []) {
    const team = row.team || row.team_abbr || row.team_code;
    if (!team) continue;
    const stats = baseStats(row);
    const prev = byTeam.get(team) || { games: 0, total_yards: 0, penalty_yards: 0, turnovers: 0, possession_seconds: 0, pass_yards: 0, sacks: 0, offensive_plays: 0 };
    prev.games += 1;
    prev.total_yards += stats.total_yards;
    prev.penalty_yards += stats.penalty_yards;
    prev.turnovers += stats.turnovers;
    prev.possession_seconds += stats.possession_seconds;
    prev.pass_yards += stats.pass_yards;
    prev.sacks += stats.sacks;
    prev.offensive_plays += stats.offensive_plays;
    byTeam.set(team, prev);
  }
  const out = new Map();
  for (const [team, totals] of byTeam.entries()) {
    out.set(team, enrichWithRatio(avgFromTotals(totals)));
  }
  return out;
}

function mkGameId(season, week, home, away) {
  return `${season}-W${String(week).padStart(2, "0")}-${home}-${away}`;
}

export function buildBTFeatures({ schedules, teamWeekly, season, prevTeamWeekly }) {
  const regSched = (schedules || []).filter(
    (g) => Number(g.season) === Number(season) && isReg(g.season_type)
  );
  const weeks = [...new Set(regSched.map((g) => Number(g.week)).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );

  const twSeason = (teamWeekly || []).filter((r) => Number(r.season) === Number(season));
  const twIdx = new Map();
  for (const row of twSeason) {
    const team = row.team || row.team_abbr || row.team_code;
    if (!team) continue;
    const week = Number(row.week);
    const key = `${season}-${week}-${team}`;
    twIdx.set(key, row);
  }

  const prevMap = seedPrevAverages(prevTeamWeekly);
  const rolling = new Map();
  const out = [];

  for (const team of new Set(regSched.flatMap((g) => [g.home_team, g.away_team]).filter(Boolean))) {
    rolling.set(team, {
      games: 0,
      total_yards: 0,
      penalty_yards: 0,
      turnovers: 0,
      possession_seconds: 0,
      pass_yards: 0,
      sacks: 0,
      offensive_plays: 0
    });
  }

  for (const W of weeks) {
    const games = regSched.filter((g) => Number(g.week) === W);
    if (!games.length) continue;

    for (const g of games) {
      const home = g.home_team;
      const away = g.away_team;
      if (!home || !away) continue;
      const hKeyPrev = `${season}-${W}-${home}`;
      const aKeyPrev = `${season}-${W}-${away}`;
      const hRow = twIdx.get(hKeyPrev) || {};
      const aRow = twIdx.get(aKeyPrev) || {};
      const hActual = baseStats(hRow);
      const aActual = baseStats(aRow);

      const hTotals = rolling.get(home) || { games: 0 };
      const aTotals = rolling.get(away) || { games: 0 };
      const hAvg = enrichWithRatio(avgFromTotals(hTotals));
      const aAvg = enrichWithRatio(avgFromTotals(aTotals));

      const hPrev = prevMap.get(home) || enrichWithRatio({
        total_yards: 0,
        penalty_yards: 0,
        turnovers: 0,
        possession_seconds: 0,
        pass_yards: 0,
        sacks: 0,
        offensive_plays: 0
      });
      const aPrev = prevMap.get(away) || enrichWithRatio({
        total_yards: 0,
        penalty_yards: 0,
        turnovers: 0,
        possession_seconds: 0,
        pass_yards: 0,
        sacks: 0,
        offensive_plays: 0
      });

      const hBlend = blend({ ...hAvg, r_ratio: hAvg.r_ratio }, hPrev, W);
      const aBlend = blend({ ...aAvg, r_ratio: aAvg.r_ratio }, aPrev, W);

      const hPower = num(
        g.elo1_pre ?? g.elo1_post ?? g.elo1 ?? g.elo ?? g.elo_prob1 ?? g.elo_home ?? 1500,
        1500
      );
      const aPower = num(
        g.elo2_pre ?? g.elo2_post ?? g.elo2 ?? g.elo ?? g.elo_prob2 ?? g.elo_away ?? 1500,
        1500
      );

      const features = {
        diff_total_yards: num(hBlend.total_yards) - num(aBlend.total_yards),
        diff_penalty_yards: num(hBlend.penalty_yards) - num(aBlend.penalty_yards),
        diff_turnovers: num(hBlend.turnovers) - num(aBlend.turnovers),
        diff_possession_seconds: num(hBlend.possession_seconds) - num(aBlend.possession_seconds),
        diff_r_ratio: num(hBlend.r_ratio) - num(aBlend.r_ratio),
        delta_power_rank: hPower - aPower
      };

      const label = winLabel(g);
      const game_id = mkGameId(season, W, home, away);

      out.push({
        season: Number(season),
        week: Number(W),
        game_id,
        home_team: home,
        away_team: away,
        features,
        label_win: label,
        home_context: { ...hBlend, power_rank: hPower },
        away_context: { ...aBlend, power_rank: aPower },
        home_actual: { ...hActual, r_ratio: hActual.total_yards ? hActual.pass_yards / hActual.total_yards : 0 },
        away_actual: { ...aActual, r_ratio: aActual.total_yards ? aActual.pass_yards / aActual.total_yards : 0 }
      });

      // update rolling + history with actual stats after emitting row (so next week sees them)
      const hRoll = rolling.get(home);
      if (hRoll) {
        hRoll.games += 1;
        hRoll.total_yards += hActual.total_yards;
        hRoll.penalty_yards += hActual.penalty_yards;
        hRoll.turnovers += hActual.turnovers;
        hRoll.possession_seconds += hActual.possession_seconds;
        hRoll.pass_yards += hActual.pass_yards;
        hRoll.sacks += hActual.sacks;
        hRoll.offensive_plays += hActual.offensive_plays;
      }
      const aRoll = rolling.get(away);
      if (aRoll) {
        aRoll.games += 1;
        aRoll.total_yards += aActual.total_yards;
        aRoll.penalty_yards += aActual.penalty_yards;
        aRoll.turnovers += aActual.turnovers;
        aRoll.possession_seconds += aActual.possession_seconds;
        aRoll.pass_yards += aActual.pass_yards;
        aRoll.sacks += aActual.sacks;
        aRoll.offensive_plays += aActual.offensive_plays;
      }

    }
  }

  return out;
}

export { BT_FEATURES };
