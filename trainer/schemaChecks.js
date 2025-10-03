// trainer/schemaChecks.js
//
// Runtime row validation for adapted public API datasets. Throws descriptive
// errors when canonical fields are missing or invalid to surface integration
// issues early in the ingest pipeline.

const ensureProp = (row, key) => {
  if (!(key in row)) throw new Error(`Missing required field "${key}"`);
};

const ensureFinite = (row, key) => {
  ensureProp(row, key);
  const value = row[key];
  if (!Number.isFinite(value)) {
    throw new Error(`Expected finite numeric value for "${key}" got ${value}`);
  }
};

export function assertScheduleRow(row) {
  if (!row || typeof row !== "object") throw new Error("Schedule row must be object");
  ensureProp(row, "season");
  ensureProp(row, "week");
  ensureProp(row, "season_type");
  ensureProp(row, "home_team");
  ensureProp(row, "away_team");
  if (!Number.isFinite(Number(row.season))) throw new Error(`Invalid season ${row.season}`);
  if (!Number.isFinite(Number(row.week))) throw new Error(`Invalid week ${row.week}`);
  if (typeof row.home_team !== "string" || !row.home_team) {
    throw new Error(`Invalid home_team ${row.home_team}`);
  }
  if (typeof row.away_team !== "string" || !row.away_team) {
    throw new Error(`Invalid away_team ${row.away_team}`);
  }
  if (row.home_points != null && !Number.isFinite(Number(row.home_points))) {
    throw new Error(`home_points must be number or null: ${row.home_points}`);
  }
  if (row.away_points != null && !Number.isFinite(Number(row.away_points))) {
    throw new Error(`away_points must be number or null: ${row.away_points}`);
  }
}

const TEAM_WEEKLY_NUMERIC = [
  "wins_s2d",
  "losses_s2d",
  "off_total_yds_s2d",
  "off_rush_yds_s2d",
  "off_pass_yds_s2d",
  "off_turnovers_s2d",
  "def_total_yds_s2d",
  "def_rush_yds_s2d",
  "def_pass_yds_s2d",
  "def_turnovers_s2d",
  "off_third_down_pct_s2d",
  "off_red_zone_td_pct_s2d",
  "off_sack_rate_s2d",
  "off_neutral_pass_rate_s2d"
];

export function assertTeamWeeklyRow(row) {
  if (!row || typeof row !== "object") throw new Error("TeamWeekly row must be object");
  ["season", "week", "team", "opponent", "home"].forEach((key) => ensureProp(row, key));
  if (!Number.isFinite(Number(row.season))) throw new Error(`Invalid season ${row.season}`);
  if (!Number.isFinite(Number(row.week))) throw new Error(`Invalid week ${row.week}`);
  if (typeof row.team !== "string" || !row.team) throw new Error(`Invalid team ${row.team}`);
  if (row.opponent != null && typeof row.opponent !== "string" && row.opponent !== null) {
    throw new Error(`Invalid opponent ${row.opponent}`);
  }
  const homeFlag = Number(row.home);
  if (!(homeFlag === 0 || homeFlag === 1)) {
    throw new Error(`home must be 0 or 1: ${row.home}`);
  }
  for (const key of TEAM_WEEKLY_NUMERIC) {
    ensureFinite(row, key);
  }
}

const BT_FEATURE_KEYS = [
  "diff_total_yards",
  "diff_penalty_yards",
  "diff_turnovers",
  "diff_possession_seconds",
  "diff_r_ratio",
  "diff_elo_pre"
];

export function assertBTFeatureRow(row) {
  if (!row || typeof row !== "object") throw new Error("BT feature row must be object");
  ["season", "week", "home_team", "away_team", "game_id", "features"].forEach((key) =>
    ensureProp(row, key)
  );
  if (!Number.isFinite(Number(row.season))) throw new Error(`Invalid season ${row.season}`);
  if (!Number.isFinite(Number(row.week))) throw new Error(`Invalid week ${row.week}`);
  if (typeof row.home_team !== "string" || !row.home_team) {
    throw new Error(`Invalid home_team ${row.home_team}`);
  }
  if (typeof row.away_team !== "string" || !row.away_team) {
    throw new Error(`Invalid away_team ${row.away_team}`);
  }
  if (typeof row.game_id !== "string" || !row.game_id) {
    throw new Error(`Invalid game_id ${row.game_id}`);
  }
  if (!row.features || typeof row.features !== "object") {
    throw new Error("features must be object");
  }
  for (const key of BT_FEATURE_KEYS) {
    ensureFinite(row.features, key);
  }
}
