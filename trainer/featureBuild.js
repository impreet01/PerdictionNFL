// trainer/featureBuild.js
//
// Build season-to-date (S2D) features from nflverse team-week and team-game datasets.
// Includes baseline cumulative stats plus advanced situational rates derived from team_game.
// Defensive "allowed" values are taken from the opponent row in the same game/week.
// Only generates rows for actual games (no fabrication of future weeks).

export const FEATS = [
  "off_1st_down_s2d",
  "off_total_yds_s2d",
  "off_rush_yds_s2d",
  "off_pass_yds_s2d",
  "off_turnovers_s2d",
  "def_1st_down_s2d",
  "def_total_yds_s2d",
  "def_rush_yds_s2d",
  "def_pass_yds_s2d",
  "def_turnovers_s2d",
  "wins_s2d",
  "losses_s2d",
  "home",
  "sim_winrate_same_loc_s2d",
  "sim_pointdiff_same_loc_s2d",
  "sim_count_same_loc_s2d",
  "off_total_yds_s2d_minus_opp",
  "def_total_yds_s2d_minus_opp",
  "off_turnovers_s2d_minus_opp",
  "def_turnovers_s2d_minus_opp",
  "elo_pre",
  "elo_diff",
  "rest_days",
  "rest_diff",
  "off_third_down_att_s2d",
  "off_third_down_conv_s2d",
  "off_third_down_pct_s2d",
  "off_red_zone_att_s2d",
  "off_red_zone_td_s2d",
  "off_red_zone_td_pct_s2d",
  "off_dropbacks_s2d",
  "off_sacks_taken_s2d",
  "off_sack_rate_s2d",
  "off_pass_att_s2d",
  "off_rush_att_s2d",
  "off_neutral_pass_rate_s2d",
  "off_third_down_pct_s2d_minus_opp",
  "off_red_zone_td_pct_s2d_minus_opp",
  "off_sack_rate_s2d_minus_opp",
  "off_neutral_pass_rate_s2d_minus_opp"
];

const isReg = (v) => {
  if (v == null) return true;
  const s = String(v).trim().toUpperCase();
  return s === "" || s.startsWith("REG");
};

const num = (value, def = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
};

const dateOnly = (value) => (value ? String(value).slice(0, 10) : null);

const normTeam = (value) => {
  if (!value) return null;
  const s = String(value).trim().toUpperCase();
  return s || null;
};

function finalScores(game) {
  const hs = game.home_score ?? game.home_points ?? game.home_pts;
  const as = game.away_score ?? game.away_points ?? game.away_pts;
  if (!Number.isFinite(Number(hs)) || !Number.isFinite(Number(as))) return null;
  return { hs: Number(hs), as: Number(as) };
}

function winLabel(game, isHome) {
  const scores = finalScores(game);
  if (!scores) return null;
  if (scores.hs === scores.as) return null;
  const homeWon = scores.hs > scores.as ? 1 : 0;
  return isHome ? homeWon : 1 - homeWon;
}

const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  return Math.round((new Date(b) - new Date(a)) / 86_400_000);
};

function indexTeamWeek(rows = [], season) {
  const idx = new Map();
  for (const row of rows) {
    if (Number(row.season) !== Number(season)) continue;
    const team = normTeam(row.team ?? row.team_abbr ?? row.team_code);
    if (!team) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;
    idx.set(`${season}-${week}-${team}`, row);
  }
  return idx;
}

function indexTeamGame(rows = [], season) {
  const idx = new Map();
  for (const row of rows) {
    if (Number(row.season) !== Number(season)) continue;
    const team = normTeam(row.team ?? row.team_abbr ?? row.team_code ?? row.posteam);
    if (!team) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;
    idx.set(`${season}-${week}-${team}`, row);
  }
  return idx;
}

function perGameSignals(row = {}, oppRow = {}) {
  const passYds = num(row.passing_yards ?? row.pass_yards ?? row.pass_yds);
  const rushYds = num(row.rushing_yards ?? row.rush_yards ?? row.rush_yds);
  const offTotal = passYds + rushYds;

  const passFD = num(row.passing_first_downs ?? row.pass_first_downs);
  const rushFD = num(row.rushing_first_downs ?? row.rush_first_downs);
  const recvFD = num(row.receiving_first_downs ?? row.rec_first_downs);
  const offFD = passFD + rushFD + recvFD;

  const offINT = num(row.passing_interceptions ?? row.interceptions ?? row.pass_int);
  const offFumLost =
    num(row.rushing_fumbles_lost ?? row.rush_fumbles_lost ?? row.fumbles_lost) +
    num(row.receiving_fumbles_lost ?? row.rec_fumbles_lost) +
    num(row.sack_fumbles_lost);
  const offTO = offINT + offFumLost;

  const oppPassYds = num(oppRow.passing_yards ?? oppRow.pass_yards ?? oppRow.pass_yds);
  const oppRushYds = num(oppRow.rushing_yards ?? oppRow.rush_yards ?? oppRow.rush_yds);
  const defTotalAllowed = oppPassYds + oppRushYds;

  const oppPassFD = num(oppRow.passing_first_downs ?? oppRow.pass_first_downs);
  const oppRushFD = num(oppRow.rushing_first_downs ?? oppRow.rush_first_downs);
  const oppRecvFD = num(oppRow.receiving_first_downs ?? oppRow.rec_first_downs);
  const defFDAllowed = oppPassFD + oppRushFD + oppRecvFD;

  const defINT = num(row.def_interceptions ?? row.def_int);
  const defFum = num(row.def_fumbles ?? row.def_fumbles_recovered ?? row.fumbles_forced);
  const defTO = defINT + defFum;

  return {
    offFD,
    offTotal,
    rushYds,
    passYds,
    offTO,
    defFDAllowed,
    defTotalAllowed,
    defRushAllowed: oppRushYds,
    defPassAllowed: oppPassYds,
    defTO
  };
}

function pick(row, keys = []) {
  for (const key of keys) {
    if (row && row[key] != null && row[key] !== "") return row[key];
  }
  return 0;
}

function advancedSignals(row = {}) {
  const thirdAtt = num(pick(row, [
    "third_down_att",
    "third_down_attempts",
    "third_down_attempt",
    "third_downs_att",
    "third_downs"
  ]));
  const thirdConv = num(pick(row, [
    "third_down_conv",
    "third_down_conversions",
    "third_down_success",
    "third_downs_conv",
    "third_downs_made"
  ]));
  const redAtt = num(pick(row, [
    "red_zone_att",
    "red_zone_attempts",
    "red_zone_trips",
    "redzone_att",
    "rz_att"
  ]));
  const redTD = num(pick(row, [
    "red_zone_td",
    "red_zone_tds",
    "red_zone_touchdowns",
    "redzone_td",
    "rz_td",
    "rz_tds"
  ]));
  const passAtt = num(pick(row, [
    "pass_att",
    "pass_attempts",
    "passing_attempts",
    "attempts_pass",
    "attempt_pass"
  ]));
  const rushAtt = num(pick(row, [
    "rush_att",
    "rush_attempts",
    "rushing_attempts",
    "attempts_rush",
    "attempt_rush"
  ]));
  const sacksTaken = num(pick(row, [
    "sacks_taken",
    "qb_sacked",
    "sacks",
    "sacks_allowed",
    "times_sacked"
  ]));

  return {
    thirdAtt,
    thirdConv,
    redAtt,
    redTD,
    passAtt,
    rushAtt,
    sacksTaken
  };
}

function updateAdvanced(prev = {}, metrics = {}) {
  const thirdAtt = num(prev.off_third_down_att_s2d) + num(metrics.thirdAtt);
  const thirdConv = num(prev.off_third_down_conv_s2d) + num(metrics.thirdConv);
  const redAtt = num(prev.off_red_zone_att_s2d) + num(metrics.redAtt);
  const redTD = num(prev.off_red_zone_td_s2d) + num(metrics.redTD);
  const passAtt = num(prev.off_pass_att_s2d) + num(metrics.passAtt);
  const rushAtt = num(prev.off_rush_att_s2d) + num(metrics.rushAtt);
  const sacks = num(prev.off_sacks_taken_s2d) + num(metrics.sacksTaken);
  const dropbacks = passAtt + sacks;
  const neutralDenom = passAtt + rushAtt;

  return {
    off_third_down_att_s2d: thirdAtt,
    off_third_down_conv_s2d: thirdConv,
    off_third_down_pct_s2d: thirdAtt ? thirdConv / thirdAtt : 0,
    off_red_zone_att_s2d: redAtt,
    off_red_zone_td_s2d: redTD,
    off_red_zone_td_pct_s2d: redAtt ? redTD / redAtt : 0,
    off_pass_att_s2d: passAtt,
    off_rush_att_s2d: rushAtt,
    off_sacks_taken_s2d: sacks,
    off_dropbacks_s2d: dropbacks,
    off_sack_rate_s2d: dropbacks ? sacks / dropbacks : 0,
    off_neutral_pass_rate_s2d: neutralDenom ? passAtt / neutralDenom : 0
  };
}

function zeroAdvanced() {
  return {
    off_third_down_att_s2d: 0,
    off_third_down_conv_s2d: 0,
    off_third_down_pct_s2d: 0,
    off_red_zone_att_s2d: 0,
    off_red_zone_td_s2d: 0,
    off_red_zone_td_pct_s2d: 0,
    off_pass_att_s2d: 0,
    off_rush_att_s2d: 0,
    off_sacks_taken_s2d: 0,
    off_dropbacks_s2d: 0,
    off_sack_rate_s2d: 0,
    off_neutral_pass_rate_s2d: 0
  };
}

function seedElo(team, prevTeamWeekly) {
  const wins = (prevTeamWeekly || [])
    .filter((row) => normTeam(row.team) === team)
    .reduce((sum, row) => sum + num(row.wins ?? row.win ?? 0), 0);
  return Number.isFinite(wins) ? 1450 + 5 * wins : 1500;
}

export function buildFeatures({ teamWeekly, teamGame = [], schedules, season, prevTeamWeekly }) {
  const seasonNum = Number(season);
  if (!Number.isFinite(seasonNum)) return [];

  const regSched = (schedules || []).filter(
    (game) => Number(game.season) === seasonNum && isReg(game.season_type)
  );
  if (!regSched.length) return [];

  const weeks = [...new Set(regSched.map((g) => Number(g.week)).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );

  const teams = new Set(
    regSched
      .flatMap((g) => [normTeam(g.home_team), normTeam(g.away_team)])
      .filter((t) => t)
  );

  const twIdx = indexTeamWeek(teamWeekly || [], seasonNum);
  const tgIdx = indexTeamGame(teamGame || [], seasonNum);

  const lastDate = new Map();
  const elo = new Map();
  for (const team of teams) {
    elo.set(team, seedElo(team, prevTeamWeekly));
  }

  const roll = new Map();
  const advRoll = new Map();
  for (const team of teams) {
    roll.set(team, new Map());
    advRoll.set(team, new Map());
  }

  const out = [];

  for (const week of weeks) {
    const games = regSched.filter((g) => Number(g.week) === week);
    if (!games.length) continue;

    for (const game of games) {
      const home = normTeam(game.home_team);
      const away = normTeam(game.away_team);
      if (!home || !away) continue;

      const gameDate = dateOnly(game.game_date);

      const hKey = `${seasonNum}-${week}-${home}`;
      const aKey = `${seasonNum}-${week}-${away}`;
      const hRow = twIdx.get(hKey) || {};
      const aRow = twIdx.get(aKey) || {};
      const hAdvRow = tgIdx.get(hKey) || {};
      const aAdvRow = tgIdx.get(aKey) || {};

      const hOppRow = aRow;
      const aOppRow = hRow;

      const hSignals = perGameSignals(hRow, hOppRow);
      const aSignals = perGameSignals(aRow, aOppRow);
      const hAdvSignals = advancedSignals(hAdvRow);
      const aAdvSignals = advancedSignals(aAdvRow);

      const hPrev = roll.get(home).get(week - 1) || {};
      const aPrev = roll.get(away).get(week - 1) || {};

      const updateRoll = (prev, sig) => ({
        off_1st_down_s2d: num(prev.off_1st_down_s2d) + num(sig.offFD),
        off_total_yds_s2d: num(prev.off_total_yds_s2d) + num(sig.offTotal),
        off_rush_yds_s2d: num(prev.off_rush_yds_s2d) + num(sig.rushYds),
        off_pass_yds_s2d: num(prev.off_pass_yds_s2d) + num(sig.passYds),
        off_turnovers_s2d: num(prev.off_turnovers_s2d) + num(sig.offTO),
        def_1st_down_s2d: num(prev.def_1st_down_s2d) + num(sig.defFDAllowed),
        def_total_yds_s2d: num(prev.def_total_yds_s2d) + num(sig.defTotalAllowed),
        def_rush_yds_s2d: num(prev.def_rush_yds_s2d) + num(sig.defRushAllowed),
        def_pass_yds_s2d: num(prev.def_pass_yds_s2d) + num(sig.defPassAllowed),
        def_turnovers_s2d: num(prev.def_turnovers_s2d) + num(sig.defTO),
        wins_s2d: num(prev.wins_s2d),
        losses_s2d: num(prev.losses_s2d)
      });

      const hS2D = updateRoll(hPrev, hSignals);
      const aS2D = updateRoll(aPrev, aSignals);
      roll.get(home).set(week, hS2D);
      roll.get(away).set(week, aS2D);

      const hAdvPrev = advRoll.get(home).get(week - 1) || zeroAdvanced();
      const aAdvPrev = advRoll.get(away).get(week - 1) || zeroAdvanced();
      const hAdvS2D = updateAdvanced(hAdvPrev, hAdvSignals);
      const aAdvS2D = updateAdvanced(aAdvPrev, aAdvSignals);
      advRoll.get(home).set(week, hAdvS2D);
      advRoll.get(away).set(week, aAdvS2D);

      const scores = finalScores(game);
      if (scores) {
        const homeWin = scores.hs > scores.as ? 1 : 0;
        const awayWin = 1 - homeWin;
        hS2D.wins_s2d = num(hPrev.wins_s2d) + homeWin;
        hS2D.losses_s2d = num(hPrev.losses_s2d) + (1 - homeWin);
        aS2D.wins_s2d = num(aPrev.wins_s2d) + awayWin;
        aS2D.losses_s2d = num(aPrev.losses_s2d) + (1 - awayWin);
      } else {
        hS2D.wins_s2d = num(hPrev.wins_s2d);
        hS2D.losses_s2d = num(hPrev.losses_s2d);
        aS2D.wins_s2d = num(aPrev.wins_s2d);
        aS2D.losses_s2d = num(aPrev.losses_s2d);
      }

      const homeRest = daysBetween(lastDate.get(home) || null, gameDate);
      const awayRest = daysBetween(lastDate.get(away) || null, gameDate);
      const restDiff = (homeRest || 0) - (awayRest || 0);

      const homeElo = num(elo.get(home), 1500);
      const awayElo = num(elo.get(away), 1500);
      const eloDiff = homeElo - awayElo;

      const mkRow = (team, opp, isHome, me, op, advMe, advOp) => {
        const adv = advMe || zeroAdvanced();
        const advOpp = advOp || zeroAdvanced();
        return {
          season: seasonNum,
          week,
          team,
          opponent: opp,
          home: isHome ? 1 : 0,
          game_date: gameDate,
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
          wins_s2d: num(me.wins_s2d),
          losses_s2d: num(me.losses_s2d),
          sim_winrate_same_loc_s2d: 0,
          sim_pointdiff_same_loc_s2d: 0,
          sim_count_same_loc_s2d: 0,
          off_total_yds_s2d_minus_opp: num(me.off_total_yds_s2d) - num(op.off_total_yds_s2d),
          def_total_yds_s2d_minus_opp: num(me.def_total_yds_s2d) - num(op.def_total_yds_s2d),
          off_turnovers_s2d_minus_opp: num(me.off_turnovers_s2d) - num(op.off_turnovers_s2d),
          def_turnovers_s2d_minus_opp: num(me.def_turnovers_s2d) - num(op.def_turnovers_s2d),
          rest_days: isHome ? homeRest : awayRest,
          rest_diff: isHome ? restDiff : -restDiff,
          elo_pre: isHome ? homeElo : awayElo,
          elo_diff: isHome ? eloDiff : -eloDiff,
          off_third_down_att_s2d: num(adv.off_third_down_att_s2d),
          off_third_down_conv_s2d: num(adv.off_third_down_conv_s2d),
          off_third_down_pct_s2d: num(adv.off_third_down_pct_s2d),
          off_red_zone_att_s2d: num(adv.off_red_zone_att_s2d),
          off_red_zone_td_s2d: num(adv.off_red_zone_td_s2d),
          off_red_zone_td_pct_s2d: num(adv.off_red_zone_td_pct_s2d),
          off_dropbacks_s2d: num(adv.off_dropbacks_s2d),
          off_sacks_taken_s2d: num(adv.off_sacks_taken_s2d),
          off_sack_rate_s2d: num(adv.off_sack_rate_s2d),
          off_pass_att_s2d: num(adv.off_pass_att_s2d),
          off_rush_att_s2d: num(adv.off_rush_att_s2d),
          off_neutral_pass_rate_s2d: num(adv.off_neutral_pass_rate_s2d),
          off_third_down_pct_s2d_minus_opp: num(adv.off_third_down_pct_s2d) - num(advOpp.off_third_down_pct_s2d),
          off_red_zone_td_pct_s2d_minus_opp: num(adv.off_red_zone_td_pct_s2d) - num(advOpp.off_red_zone_td_pct_s2d),
          off_sack_rate_s2d_minus_opp: num(adv.off_sack_rate_s2d) - num(advOpp.off_sack_rate_s2d),
          off_neutral_pass_rate_s2d_minus_opp:
            num(adv.off_neutral_pass_rate_s2d) - num(advOpp.off_neutral_pass_rate_s2d),
          win: winLabel(game, isHome)
        };
      };

      const homeRow = mkRow(home, away, true, hS2D, aS2D, hAdvS2D, aAdvS2D);
      const awayRow = mkRow(away, home, false, aS2D, hS2D, aAdvS2D, hAdvS2D);
      out.push(homeRow, awayRow);

      if (gameDate) {
        lastDate.set(home, gameDate);
        lastDate.set(away, gameDate);
      }

      if (scores) {
        const K = 2.5;
        const expectedHome = 1 / (1 + Math.pow(10, -(homeElo - awayElo) / 400));
        const outcomeHome = scores.hs > scores.as ? 1 : 0;
        const delta = K * (outcomeHome - expectedHome);
        elo.set(home, homeElo + delta);
        elo.set(away, awayElo - delta);
      }
    }
  }

  return out;
}
