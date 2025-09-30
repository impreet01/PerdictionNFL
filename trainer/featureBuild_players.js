// trainer/featureBuild_players.js
// Aggregate player-week data into team usage metrics.

const isReg = (v) => {
  if (v == null) return true;
  const s = String(v).trim().toUpperCase();
  return s === "" || s.startsWith("REG");
};

const num = (value, def = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
};

const normTeam = (value) => {
  if (!value) return null;
  const s = String(value).trim().toUpperCase();
  return s || null;
};

const normPos = (value) => {
  if (!value) return "";
  return String(value).trim().toUpperCase();
};

function ensure(map, key) {
  if (!map.has(key)) {
    map.set(key, {
      team_rush_att: 0,
      rb_rush_att: 0,
      total_targets: 0,
      wr_targets: 0,
      te_targets: 0,
      qb_pass_att: 0,
      qb_air_yards: 0,
      qb_pass_yards: 0,
      qb_sacks: 0
    });
  }
  return map.get(key);
}

const pick = (row, keys, def = 0) => {
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") return row[key];
  }
  return def;
};

export function aggregatePlayerUsage({ rows = [], season }) {
  const seasonNum = Number(season);
  const out = new Map();
  if (!Number.isFinite(seasonNum)) return out;

  for (const row of rows) {
    if (Number(row.season) !== seasonNum) continue;
    if (!isReg(row.season_type)) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;

    const team = normTeam(row.recent_team ?? row.team ?? row.team_abbr ?? row.posteam);
    if (!team) continue;

    const pos = normPos(row.position ?? row.player_position ?? row.pos);
    const key = `${seasonNum}-${week}-${team}`;
    const rec = ensure(out, key);

    const rushAtt = num(
      pick(row, ["rushing_attempts", "rush_attempts", "carries", "rushing_att", "rush_att"]),
      0
    );
    const targets = num(pick(row, ["targets", "receiving_targets", "rec_targets", "target"], 0), 0);
    const passAtt = num(
      pick(row, ["pass_attempts", "passing_attempts", "attempts", "attempts_pass", "att_pass"]),
      0
    );
    const airYards = num(
      pick(row, ["air_yards", "passing_air_yards", "pass_air_yards", "air_yds"], 0),
      0
    );
    const passYds = num(pick(row, ["passing_yards", "pass_yards", "pass_yds"], 0), 0);
    const sacks = num(pick(row, ["sacks", "qb_sacked", "sacked", "sacks_taken"], 0), 0);

    rec.team_rush_att += rushAtt;
    rec.total_targets += targets;

    if (pos === "RB") {
      rec.rb_rush_att += rushAtt;
    }
    if (pos === "WR") {
      rec.wr_targets += targets;
    }
    if (pos === "TE") {
      rec.te_targets += targets;
    }
    if (pos === "QB") {
      rec.qb_pass_att += passAtt;
      rec.qb_air_yards += airYards;
      rec.qb_pass_yards += passYds;
      rec.qb_sacks += sacks;
    }
  }

  for (const [key, rec] of out.entries()) {
    const rushTotal = rec.team_rush_att || 0;
    const targetTotal = rec.total_targets || 0;
    const qbAtt = rec.qb_pass_att || 0;
    const dropbacks = qbAtt + (rec.qb_sacks || 0);
    const airBasis = rec.qb_air_yards || rec.qb_pass_yards || 0;

    out.set(key, {
      rb_rush_share: rushTotal ? rec.rb_rush_att / rushTotal : 0,
      rb_rush_weight: rushTotal,
      wr_target_share: targetTotal ? rec.wr_targets / targetTotal : 0,
      te_target_share: targetTotal ? rec.te_targets / targetTotal : 0,
      target_weight: targetTotal,
      qb_aypa: qbAtt ? airBasis / qbAtt : 0,
      qb_aypa_weight: qbAtt,
      qb_sack_rate: dropbacks ? rec.qb_sacks / dropbacks : 0,
      qb_sack_rate_weight: dropbacks
    });
  }

  return out;
}

export default aggregatePlayerUsage;
