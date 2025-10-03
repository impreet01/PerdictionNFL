// trainer/apiAdapter.js
//
// Adapter layer translating public API payloads into canonical row shapes
// expected by the rest of the training pipeline.
//
// Each function accepts raw API payloads (typically arrays or nested
// arrays/objects) and returns arrays of plain objects with strictly defined
// properties. These rows are subsequently validated by schemaChecks before
// being consumed by feature builders or models.

const DEFAULT_WARNINGS = new Set();

const warnDefault = (field, reason) => {
  if (DEFAULT_WARNINGS.has(field)) return;
  DEFAULT_WARNINGS.add(field);
  const suffix = reason ? ` (${reason})` : "";
  console.warn(`[apiAdapter] defaulting ${field}${suffix}`);
};

const num = (value, def = 0, field) => {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    if (field) warnDefault(field, `value=${value}`);
    return def;
  }
  return n;
};

const int = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};

const pick = (row, keys = []) => {
  if (!row) return undefined;
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") return row[key];
  }
  return undefined;
};

const parseBoolean = (value) => {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  if (["home", "h", "true", "1", "yes"].includes(s)) return true;
  if (["away", "a", "false", "0", "no"].includes(s)) return false;
  return null;
};

const parseSeasonType = (value) => {
  const s = String(value ?? "").trim().toUpperCase();
  if (!s) return "REG";
  if (s.startsWith("REG")) return "REG";
  if (s.startsWith("POST") || s.includes("PLAY")) return "POST";
  if (s.startsWith("PRE") || s.includes("EXH")) return "PRE";
  return s;
};

const isFinalStatus = (value) => {
  if (value === true) return true;
  if (value === false) return false;
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return false;
  return [
    "final",
    "complete",
    "completed",
    "closed",
    "finished",
    "post",
    "fulltime",
    "ended"
  ].some((needle) => s.includes(needle));
};

const parsePossessionSeconds = (value) => {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const s = String(value).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(":").map((part) => Number(part));
  if (parts.length === 2 && parts.every((p) => Number.isFinite(p))) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3 && parts.every((p) => Number.isFinite(p))) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
};

const sanitizeArray = (input) => {
  if (Array.isArray(input)) return input;
  if (input == null) return [];
  if (Array.isArray(input?.data)) return input.data;
  if (Array.isArray(input?.items)) return input.items;
  if (Array.isArray(input?.games)) return input.games;
  if (Array.isArray(input?.events)) return input.events;
  if (Array.isArray(input?.rows)) return input.rows;
  return [];
};

const DEFAULT_TEAM_MAP = {
  JAC: "JAX",
  JAX: "JAX",
  JAGS: "JAX",
  JAGUARS: "JAX",
  WSH: "WAS",
  WAS: "WAS",
  COMMANDERS: "WAS",
  LVR: "LV",
  LV: "LV",
  OAK: "LV",
  RAIDERS: "LV",
  LAC: "LAC",
  SD: "LAC",
  SDG: "LAC",
  CHARGERS: "LAC",
  STL: "LA",
  LAR: "LA",
  LA: "LA",
  RAMS: "LA",
  GNB: "GB",
  GBP: "GB",
  GREENBAY: "GB",
  NOR: "NO",
  NOS: "NO",
  NO: "NO",
  NOP: "NO",
  TAM: "TB",
  TBB: "TB",
  TB: "TB",
  TPA: "TB",
  ARZ: "ARI",
  ARI: "ARI",
  PHO: "ARI",
  AZ: "ARI",
  SFO: "SF",
  SF: "SF",
  SANFRAN: "SF",
  NEP: "NE",
  NE: "NE",
  NWE: "NE",
  KAN: "KC",
  KC: "KC",
  NYG: "NYG",
  NYJ: "NYJ",
  NYJETS: "NYJ",
  NYJ_: "NYJ",
  NYJETS_: "NYJ",
  ATL: "ATL",
  BAL: "BAL",
  BUF: "BUF",
  CAR: "CAR",
  CHI: "CHI",
  CIN: "CIN",
  CLE: "CLE",
  DAL: "DAL",
  DEN: "DEN",
  DET: "DET",
  HOU: "HOU",
  IND: "IND",
  MIA: "MIA",
  MIN: "MIN",
  PHI: "PHI",
  PIT: "PIT",
  SEA: "SEA",
  TEN: "TEN",
  TENN: "TEN",
  TEXANS: "HOU",
  TITANS: "TEN",
  SEAHAWKS: "SEA"
};

export function normalizeTeamCode(value) {
  if (!value) return null;
  const raw = String(value).trim().toUpperCase();
  if (!raw) return null;
  if (DEFAULT_TEAM_MAP[raw]) return DEFAULT_TEAM_MAP[raw];
  if (raw.length <= 4) return raw;
  // try to take last token
  const parts = raw.split(/[^A-Z0-9]+/).filter(Boolean);
  const guess = parts[parts.length - 1];
  if (guess && DEFAULT_TEAM_MAP[guess]) return DEFAULT_TEAM_MAP[guess];
  return guess || raw.slice(0, 3);
}

const extractTeam = (row, keys) => {
  const value = pick(row, keys);
  return normalizeTeamCode(value);
};

const determineHomeFlag = (row, team, opponent) => {
  const explicit = parseBoolean(
    pick(row, [
      "home",
      "is_home",
      "isHome",
      "homeTeam",
      "home_team_indicator",
      "homeAway",
      "team_type"
    ])
  );
  if (explicit != null) return explicit ? 1 : 0;
  const homeCandidate = extractTeam(row, [
    "home_team",
    "homeTeam",
    "home_abbr",
    "homeTeamAbbr",
    "team_home"
  ]);
  if (homeCandidate && team && homeCandidate === team) return 1;
  if (homeCandidate && opponent && homeCandidate === opponent) return 0;
  // fall back: assume first listed team is home
  return 0;
};

const determineOpponent = (row, team) => {
  const opponent = extractTeam(row, [
    "opponent",
    "opponent_team",
    "opponent_team_abbr",
    "opponentAbbr",
    "opp_team",
    "oppTeam",
    "away_team",
    "awayTeam",
    "team_opponent",
    "opp"
  ]);
  if (opponent) return opponent;
  const home = extractTeam(row, ["home_team", "homeTeam"]);
  const away = extractTeam(row, ["away_team", "awayTeam"]);
  if (team && home && team !== home) return home;
  if (team && away && team !== away) return away;
  return null;
};

export function adaptSchedules(apiGames = []) {
  const rows = [];
  const arr = sanitizeArray(apiGames);
  for (const raw of arr) {
    const season = int(pick(raw, ["season", "season_year", "year"]));
    const week = int(pick(raw, ["week", "week_number", "game_week", "weekNo", "week_no"]));
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue;
    const home = extractTeam(raw, [
      "home_team",
      "homeTeam",
      "home_team_abbr",
      "homeTeamAbbr",
      "team_home",
      "home"
    ]);
    const away = extractTeam(raw, [
      "away_team",
      "awayTeam",
      "away_team_abbr",
      "awayTeamAbbr",
      "team_away",
      "away"
    ]);
    if (!home || !away) continue;
    const season_type = parseSeasonType(pick(raw, ["season_type", "seasonType", "type", "season_phase"]));
    const status = pick(raw, ["status", "game_status", "state", "phase", "event_status"]);
    const final = isFinalStatus(status);
    const home_points = final
      ? num(
          pick(raw, [
            "home_points",
            "home_score",
            "homeScore",
            "home_points_total",
            "score_home",
            "points_home",
            "homeTeamScore"
          ]),
          null
        )
      : null;
    const away_points = final
      ? num(
          pick(raw, [
            "away_points",
            "away_score",
            "awayScore",
            "away_points_total",
            "score_away",
            "points_away",
            "awayTeamScore"
          ]),
          null
        )
      : null;
    const roof = String(
      pick(raw, ["roof", "venue_roof", "stadium_roof", "roofType"]) ?? ""
    )
      .trim()
      .toLowerCase();
    const surface = pick(raw, ["surface", "field_surface", "playing_surface", "surfaceType"]);
    const row = {
      season,
      week,
      season_type,
      home_team: home,
      away_team: away,
      home_points: Number.isFinite(home_points) ? home_points : null,
      away_points: Number.isFinite(away_points) ? away_points : null,
      roof,
      surface: surface != null ? String(surface).trim().toLowerCase() : ""
    };
    const gameId = pick(raw, ["game_id", "gameId", "id", "eid"]);
    if (gameId) row.game_id = String(gameId);
    const gameDate = pick(raw, [
      "game_date",
      "start_time",
      "start_time_utc",
      "start_time_gmt",
      "gameTime",
      "kickoff",
      "date"
    ]);
    if (gameDate) row.game_date = String(gameDate);
    const venue = pick(raw, ["venue", "stadium", "stadium_name", "site"]);
    if (venue) row.venue = String(venue).trim();
    const stadiumType = pick(raw, ["stadium_type", "venue_type", "surface_category"]);
    if (stadiumType) row.stadium_type = String(stadiumType).trim().toLowerCase();
    const neutral = pick(raw, ["neutral_site", "isNeutral", "neutral"]);
    if (neutral != null) row.neutral_site = Boolean(parseBoolean(neutral));
    const eloHome = Number(pick(raw, ["elo1_pre", "home_elo_pre", "elo_pre_home", "elo_home"]));
    const eloAway = Number(pick(raw, ["elo2_pre", "away_elo_pre", "elo_pre_away", "elo_away"]));
    if (Number.isFinite(eloHome)) row.elo1_pre = eloHome;
    if (Number.isFinite(eloAway)) row.elo2_pre = eloAway;
    const eloHomePost = Number(pick(raw, ["elo1_post", "elo_post_home"]));
    const eloAwayPost = Number(pick(raw, ["elo2_post", "elo_post_away"]));
    if (Number.isFinite(eloHomePost)) row.elo1_post = eloHomePost;
    if (Number.isFinite(eloAwayPost)) row.elo2_post = eloAwayPost;
    const spread = Number(pick(raw, ["spread_line", "home_spread", "spread"]));
    const total = Number(pick(raw, ["total_line", "over_under", "total"]));
    if (Number.isFinite(spread)) row.spread_line = spread;
    if (Number.isFinite(total)) row.total_line = total;
    rows.push(row);
  }
  return rows;
}

const accumulateOutcome = (row) => {
  const result = String(
    pick(row, ["result", "outcome", "game_result", "decision"]) ?? ""
  )
    .trim()
    .toUpperCase();
  if (result.startsWith("W")) return { win: 1, loss: 0 };
  if (result.startsWith("L")) return { win: 0, loss: 1 };
  const wins = num(pick(row, ["wins", "team_wins", "season_wins", "wins_to_date"]));
  const losses = num(pick(row, ["losses", "team_losses", "season_losses", "losses_to_date"]));
  if (wins && !losses) return { win: 1, loss: 0 };
  if (losses && !wins) return { win: 0, loss: 1 };
  const pointsFor = num(
    pick(row, [
      "points_for",
      "points_scored",
      "points",
      "score",
      "team_points",
      "pts_for"
    ]),
    null
  );
  const pointsAgainst = num(
    pick(row, [
      "points_against",
      "points_allowed",
      "opp_points",
      "points_opp",
      "score_against"
    ]),
    null
  );
  if (Number.isFinite(pointsFor) && Number.isFinite(pointsAgainst)) {
    if (pointsFor > pointsAgainst) return { win: 1, loss: 0 };
    if (pointsFor < pointsAgainst) return { win: 0, loss: 1 };
  }
  return { win: 0, loss: 0 };
};

export function adaptTeamWeekly(apiRows = []) {
  const arr = sanitizeArray(apiRows);
  const perGame = [];
  for (const raw of arr) {
    const season = int(pick(raw, ["season", "season_year", "year"]));
    const week = int(pick(raw, ["week", "week_number", "game_week", "week_no"]));
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue;
    const team = extractTeam(raw, [
      "team",
      "team_abbr",
      "team_code",
      "team_id",
      "teamId",
      "franchise",
      "abbr"
    ]);
    if (!team) continue;
    const opponent = determineOpponent(raw, team);
    const home = determineHomeFlag(raw, team, opponent);

    const canonical = { ...raw };
    canonical.season = season;
    canonical.week = week;
    canonical.team = team;
    canonical.opponent = opponent ?? null;
    canonical.home = home;

    const totalOffYards = num(
      pick(raw, [
        "off_total_yards",
        "total_yards",
        "yards",
        "yards_total",
        "offense_total_yards",
        "offenseYards"
      ]),
      0,
      "off_total_yds_s2d"
    );
    const rushOffYards = num(
      pick(raw, ["off_rush_yards", "rush_yards", "rushing_yards", "rushYds"]),
      0,
      "off_rush_yds_s2d"
    );
    const passOffYards = num(
      pick(raw, [
        "off_pass_yards",
        "pass_yards",
        "passing_yards",
        "passYds",
        "pass_yards_net"
      ]),
      0,
      "off_pass_yds_s2d"
    );
    const offTurnovers = num(
      pick(raw, [
        "off_turnovers",
        "turnovers",
        "giveaways",
        "offense_turnovers",
        "turnovers_total"
      ]),
      0,
      "off_turnovers_s2d"
    );
    const defTotalYards = num(
      pick(raw, [
        "def_total_yards",
        "yards_allowed",
        "opp_total_yards",
        "defense_yards_allowed"
      ]),
      0,
      "def_total_yds_s2d"
    );
    const defRushYards = num(
      pick(raw, [
        "def_rush_yards",
        "rush_yards_allowed",
        "opp_rush_yards",
        "defense_rush_yards"
      ]),
      0,
      "def_rush_yds_s2d"
    );
    const defPassYards = num(
      pick(raw, [
        "def_pass_yards",
        "pass_yards_allowed",
        "opp_pass_yards",
        "defense_pass_yards"
      ]),
      0,
      "def_pass_yds_s2d"
    );
    const defTakeaways = num(
      pick(raw, [
        "def_turnovers",
        "takeaways",
        "turnovers_gained",
        "defense_turnovers"
      ]),
      0,
      "def_turnovers_s2d"
    );

    const thirdConv = num(
      pick(raw, [
        "third_down_converted",
        "third_down_conversions",
        "off_third_down_conv",
        "thirdDownConversions"
      ]),
      0
    );
    const thirdAtt = num(
      pick(raw, [
        "third_down_attempts",
        "off_third_down_att",
        "thirdDownAttempts"
      ]),
      0
    );

    const redTd = num(
      pick(raw, [
        "red_zone_td",
        "red_zone_tds",
        "redZoneTouchdowns",
        "off_red_zone_td"
      ]),
      0
    );
    const redAtt = num(
      pick(raw, [
        "red_zone_att",
        "red_zone_attempts",
        "redZoneAttempts",
        "off_red_zone_att"
      ]),
      0
    );

    const sacksAllowed = num(
      pick(raw, [
        "sacks_allowed",
        "sacks_taken",
        "qb_sacked",
        "sacks",
        "sack_total"
      ]),
      0
    );
    const passAttempts = num(
      pick(raw, [
        "pass_attempts",
        "passing_attempts",
        "attempts",
        "passAtt"
      ]),
      0
    );
    const rushAttempts = num(
      pick(raw, [
        "rush_attempts",
        "rushing_attempts",
        "rushAtt",
        "carries"
      ]),
      0
    );

    const neutralPassAttempts = num(
      pick(raw, [
        "neutral_pass_attempts",
        "neutralPassAttempts",
        "neutral_passes"
      ]),
      passAttempts,
      "off_neutral_pass_rate_s2d"
    );
    const neutralRushAttempts = num(
      pick(raw, [
        "neutral_rush_attempts",
        "neutralRushAttempts",
        "neutral_rushes"
      ]),
      rushAttempts,
      "off_neutral_pass_rate_s2d"
    );

    const { win, loss } = accumulateOutcome(raw);

    perGame.push({
      season,
      week,
      team,
      opponent,
      home,
      wins: win,
      losses: loss,
      off_total_yards: totalOffYards,
      off_rush_yards: rushOffYards,
      off_pass_yards: passOffYards,
      off_turnovers: offTurnovers,
      def_total_yards: defTotalYards,
      def_rush_yards: defRushYards,
      def_pass_yards: defPassYards,
      def_turnovers: defTakeaways,
      third_conv: thirdConv,
      third_att: thirdAtt,
      red_td: redTd,
      red_att: redAtt,
      sacks_allowed: sacksAllowed,
      pass_att: passAttempts,
      rush_att: rushAttempts,
      neutral_pass_att: neutralPassAttempts,
      neutral_rush_att: neutralRushAttempts,
      base: canonical
    });
  }

  perGame.sort((a, b) =>
    a.season - b.season || a.team.localeCompare(b.team) || a.week - b.week
  );

  const state = new Map();
  const out = [];

  for (const row of perGame) {
    const key = `${row.season}-${row.team}`;
    if (!state.has(key)) {
      state.set(key, {
        wins: 0,
        losses: 0,
        off_total: 0,
        off_rush: 0,
        off_pass: 0,
        off_turnovers: 0,
        def_total: 0,
        def_rush: 0,
        def_pass: 0,
        def_turnovers: 0,
        third_conv: 0,
        third_att: 0,
        red_td: 0,
        red_att: 0,
        sacks_allowed: 0,
        pass_att: 0,
        rush_att: 0,
        neutral_pass_att: 0,
        neutral_rush_att: 0
      });
    }
    const agg = state.get(key);
    agg.wins += row.wins;
    agg.losses += row.losses;
    agg.off_total += row.off_total_yards;
    agg.off_rush += row.off_rush_yards;
    agg.off_pass += row.off_pass_yards;
    agg.off_turnovers += row.off_turnovers;
    agg.def_total += row.def_total_yards;
    agg.def_rush += row.def_rush_yards;
    agg.def_pass += row.def_pass_yards;
    agg.def_turnovers += row.def_turnovers;
    agg.third_conv += row.third_conv;
    agg.third_att += row.third_att;
    agg.red_td += row.red_td;
    agg.red_att += row.red_att;
    agg.sacks_allowed += row.sacks_allowed;
    agg.pass_att += row.pass_att;
    agg.rush_att += row.rush_att;
    agg.neutral_pass_att += row.neutral_pass_att;
    agg.neutral_rush_att += row.neutral_rush_att;

    const dropbacks = agg.pass_att + agg.sacks_allowed;
    const neutralTotal = agg.neutral_pass_att + agg.neutral_rush_att;
    const base = row.base;
    base.wins_s2d = agg.wins;
    base.losses_s2d = agg.losses;
    base.off_total_yds_s2d = agg.off_total;
    base.off_rush_yds_s2d = agg.off_rush;
    base.off_pass_yds_s2d = agg.off_pass;
    base.off_turnovers_s2d = agg.off_turnovers;
    base.def_total_yds_s2d = agg.def_total;
    base.def_rush_yds_s2d = agg.def_rush;
    base.def_pass_yds_s2d = agg.def_pass;
    base.def_turnovers_s2d = agg.def_turnovers;
    base.off_third_down_att_s2d = agg.third_att;
    base.off_third_down_conv_s2d = agg.third_conv;
    base.off_third_down_pct_s2d = agg.third_att > 0 ? agg.third_conv / agg.third_att : 0;
    base.off_red_zone_att_s2d = agg.red_att;
    base.off_red_zone_td_s2d = agg.red_td;
    base.off_red_zone_td_pct_s2d = agg.red_att > 0 ? agg.red_td / agg.red_att : 0;
    base.off_pass_att_s2d = agg.pass_att;
    base.off_rush_att_s2d = agg.rush_att;
    base.off_sacks_taken_s2d = agg.sacks_allowed;
    base.off_dropbacks_s2d = dropbacks;
    base.off_sack_rate_s2d = dropbacks > 0 ? agg.sacks_allowed / dropbacks : 0;
    base.off_neutral_pass_rate_s2d = neutralTotal > 0 ? agg.neutral_pass_att / neutralTotal : 0;

    out.push(base);
  }

  return out;
}

const extractGameStats = (row) => {
  const total = num(
    pick(row, ["total_yards", "yards", "off_total_yards", "yards_total"]),
    0
  );
  const pass = num(
    pick(row, ["pass_yards", "passing_yards", "pass_yards_net"]),
    0
  );
  const rush = num(pick(row, ["rush_yards", "rushing_yards", "rushYds"]), 0);
  const penalty = num(
    pick(row, ["penalty_yards", "penalties_yards", "penalty_yds"]),
    0
  );
  const turnovers = num(
    pick(row, ["turnovers", "turnovers_total", "giveaways", "takeaways"]),
    0
  );
  const possession_seconds = parsePossessionSeconds(
    pick(row, [
      "possession_seconds",
      "time_of_possession",
      "time_possession",
      "possession_time",
      "possession"
    ])
  );
  const elo = num(
    pick(row, ["elo_pre", "elo", "elo1_pre", "elo2_pre", "team_elo_pre"]),
    1500
  );
  const r_ratio = total ? pass / total : 0;
  const third_att = num(
    pick(row, [
      "third_down_att",
      "third_down_attempts",
      "third_down_attempt",
      "third_downs_att",
      "third_downs"
    ]),
    0
  );
  const third_conv = num(
    pick(row, [
      "third_down_conv",
      "third_down_conversions",
      "third_down_success",
      "third_downs_conv",
      "third_downs_made"
    ]),
    0
  );
  const red_att = num(
    pick(row, [
      "red_zone_att",
      "red_zone_attempts",
      "red_zone_trips",
      "redzone_att",
      "rz_att"
    ]),
    0
  );
  const red_td = num(
    pick(row, [
      "red_zone_td",
      "red_zone_tds",
      "red_zone_touchdowns",
      "redzone_td",
      "rz_td"
    ]),
    0
  );
  const pass_att = num(
    pick(row, ["pass_att", "pass_attempts", "passing_attempts", "attempts_pass"]),
    0
  );
  const rush_att = num(
    pick(row, ["rush_att", "rush_attempts", "rushing_attempts", "attempts_rush"]),
    0
  );
  const sacks_taken = num(
    pick(row, ["sacks_taken", "qb_sacked", "sacks", "sacks_allowed", "times_sacked"]),
    0
  );
  return {
    total_yards: total,
    pass_yards: pass,
    rush_yards: rush,
    penalty_yards: penalty,
    turnovers,
    possession_seconds,
    r_ratio,
    elo_pre: elo,
    third_down_att: third_att,
    third_down_conv: third_conv,
    red_zone_att: red_att,
    red_zone_td: red_td,
    pass_att,
    rush_att,
    sacks_taken
  };
};

export function adaptTeamGameAdvanced(apiRows = []) {
  const arr = sanitizeArray(apiRows);
  const games = new Map();
  for (const raw of arr) {
    const season = int(pick(raw, ["season", "season_year", "year"]));
    const week = int(pick(raw, ["week", "week_number", "game_week", "week_no"]));
    if (!Number.isFinite(season) || !Number.isFinite(week)) continue;
    const team = extractTeam(raw, [
      "team",
      "team_abbr",
      "team_code",
      "team_id",
      "teamId",
      "posteam"
    ]);
    const opponent = determineOpponent(raw, team);
    const homeTeam = extractTeam(raw, [
      "home_team",
      "homeTeam",
      "team_home",
      "home_abbr"
    ]);
    const awayTeam = extractTeam(raw, [
      "away_team",
      "awayTeam",
      "team_away",
      "away_abbr"
    ]);
    let home = homeTeam;
    let away = awayTeam;
    if (!home || !away) {
      const flag = determineHomeFlag(raw, team, opponent);
      if (flag === 1 && team && opponent) {
        home = team;
        away = opponent;
      } else if (flag === 0 && team && opponent) {
        home = opponent;
        away = team;
      }
    }
    if (!team || !home || !away) continue;
    const key = `${season}-${week}-${home}-${away}`;
    if (!games.has(key)) {
      games.set(key, {
        season,
        week,
        home_team: home,
        away_team: away,
        home_context: null,
        away_context: null
      });
    }
    const entry = games.get(key);
    const stats = extractGameStats(raw);
    if (team === entry.home_team) {
      entry.home_context = { team, ...stats };
    } else if (team === entry.away_team) {
      entry.away_context = { team, ...stats };
    }
  }

  const rows = [];
  for (const [key, entry] of games.entries()) {
    const { season, week, home_team, away_team, home_context, away_context } = entry;
    if (!home_context || !away_context) continue;
    const game_id = `${season}-W${String(week).padStart(2, "0")}-${home_team}-${away_team}`;
    const features = {
      diff_total_yards:
        num(home_context.total_yards) - num(away_context.total_yards),
      diff_penalty_yards:
        num(home_context.penalty_yards) - num(away_context.penalty_yards),
      diff_turnovers: num(home_context.turnovers) - num(away_context.turnovers),
      diff_possession_seconds:
        num(home_context.possession_seconds) - num(away_context.possession_seconds),
      diff_r_ratio: num(home_context.r_ratio) - num(away_context.r_ratio),
      diff_elo_pre: num(home_context.elo_pre, 1500) - num(away_context.elo_pre, 1500)
    };
    rows.push({
      season,
      week,
      home_team,
      away_team,
      game_id,
      features,
      home_context,
      away_context
    });
  }
  return rows;
}

export function adaptPlayerWeekly(apiRows = []) {
  const arr = sanitizeArray(apiRows);
  const rows = [];
  for (const raw of arr) {
    const season = int(pick(raw, ["season", "season_year", "year"]));
    const week = int(pick(raw, ["week", "week_number", "game_week", "week_no"]));
    const team = extractTeam(raw, ["team", "team_abbr", "team_code", "team_id", "teamId"]);
    const player = pick(raw, [
      "player_name",
      "name",
      "display_name",
      "full_name",
      "player",
      "athlete"
    ]);
    const position = String(
      pick(raw, ["position", "pos", "player_position", "depth_position"]) ?? ""
    )
      .trim()
      .toUpperCase();
    if (!Number.isFinite(season) || !Number.isFinite(week) || !team || !player) continue;
    rows.push({
      season,
      week,
      team,
      player_name: String(player).trim(),
      position,
      passing_yards: num(
        pick(raw, ["passing_yards", "pass_yards", "yards_passing"]),
        0
      ),
      passing_attempts: num(
        pick(raw, ["passing_attempts", "pass_attempts", "attempts_pass"]),
        0
      ),
      passing_tds: num(pick(raw, ["passing_tds", "pass_touchdowns"]), 0),
      passing_int: num(pick(raw, ["interceptions", "pass_interceptions"]), 0),
      sacks: num(pick(raw, ["sacks", "times_sacked", "qb_sacked"]), 0),
      rushing_att: num(
        pick(raw, ["rushing_attempts", "rush_attempts", "carries"]),
        0
      ),
      rushing_yards: num(
        pick(raw, ["rushing_yards", "rush_yards", "yards_rushing"]),
        0
      ),
      rushing_tds: num(pick(raw, ["rushing_tds", "rush_touchdowns"]), 0),
      receiving_targets: num(pick(raw, ["targets", "receiving_targets"]), 0),
      receiving_receptions: num(
        pick(raw, ["receptions", "catches", "receiving_receptions"]),
        0
      ),
      receiving_yards: num(
        pick(raw, ["receiving_yards", "rec_yards", "yards_receiving"]),
        0
      ),
      receiving_tds: num(pick(raw, ["receiving_tds", "rec_touchdowns"]), 0)
    });
  }
  return rows;
}

export function adaptRostersWeekly(apiRows = []) {
  const arr = sanitizeArray(apiRows);
  const rows = [];
  for (const raw of arr) {
    const season = int(pick(raw, ["season", "season_year", "year"]));
    const week = int(pick(raw, ["week", "week_number", "game_week", "week_no"]));
    const team = extractTeam(raw, ["team", "team_abbr", "team_code", "team_id", "teamId"]);
    const player = pick(raw, ["player_name", "name", "display_name", "player"]);
    if (!team || !player) continue;
    rows.push({
      season: Number.isFinite(season) ? season : null,
      week: Number.isFinite(week) ? week : null,
      team,
      player: String(player).trim(),
      status: String(
        pick(raw, ["status", "injury_status", "roster_status", "designation"]) ?? ""
      ).trim()
    });
  }
  return rows;
}

export function adaptDepthCharts(apiRows = []) {
  const arr = sanitizeArray(apiRows);
  return arr
    .map((raw) => {
      const team = extractTeam(raw, ["team", "team_abbr", "team_code", "team_id"]);
      const position = String(
        pick(raw, ["position", "pos", "depth_position", "depthchart_position"]) ?? ""
      )
        .trim()
        .toUpperCase();
      const player = pick(raw, ["player_name", "name", "display_name", "player"]);
      const depth = int(pick(raw, ["depth", "depth_chart_order", "slot", "rank"]));
      if (!team || !player || !position) return null;
      return {
        team,
        position,
        player: String(player).trim(),
        depth: Number.isFinite(depth) ? depth : null
      };
    })
    .filter(Boolean);
}

export function adaptInjuries(apiRows = []) {
  const arr = sanitizeArray(apiRows);
  return arr
    .map((raw) => {
      const team = extractTeam(raw, ["team", "team_abbr", "team_code", "team_id"]);
      const player = pick(raw, ["player_name", "name", "display_name", "player"]);
      const status = pick(raw, ["status", "injury_status", "practice_status", "designation"]);
      if (!team || !player) return null;
      return {
        team,
        player: String(player).trim(),
        status: String(status ?? "").trim()
      };
    })
    .filter(Boolean);
}

export function adaptSnapCounts(apiRows = []) {
  const arr = sanitizeArray(apiRows);
  return arr
    .map((raw) => {
      const season = int(pick(raw, ["season", "season_year", "year"]));
      const week = int(pick(raw, ["week", "week_number", "game_week", "week_no"]));
      const team = extractTeam(raw, ["team", "team_abbr", "team_code", "team_id"]);
      const player = pick(raw, ["player_name", "name", "display_name", "player"]);
      if (!team || !player || !Number.isFinite(season) || !Number.isFinite(week)) return null;
      return {
        season,
        week,
        team,
        player: String(player).trim(),
        snaps_off: num(pick(raw, ["snaps_offense", "offensive_snaps", "snaps_off"]), 0),
        snaps_def: num(pick(raw, ["snaps_defense", "defensive_snaps", "snaps_def"]), 0),
        snaps_st: num(pick(raw, ["snaps_special", "snaps_st", "special_teams_snaps"]), 0)
      };
    })
    .filter(Boolean);
}

export function adaptESPNQBR(apiRows = []) {
  const arr = sanitizeArray(apiRows);
  return arr
    .map((raw) => {
      const season = int(pick(raw, ["season", "season_year", "year"]));
      const week = int(pick(raw, ["week", "week_number", "game_week", "week_no"]));
      const team = extractTeam(raw, ["team", "team_abbr", "team_code", "team_id"]);
      const qbr = num(pick(raw, ["qbr", "espn_qbr", "rating"]), null);
      if (!team || !Number.isFinite(season) || !Number.isFinite(week) || qbr == null) return null;
      return { season, week, team, qbr };
    })
    .filter(Boolean);
}

export function adaptOfficials(apiRows = []) {
  const arr = sanitizeArray(apiRows);
  return arr
    .map((raw) => {
      const season = int(pick(raw, ["season", "season_year", "year"]));
      const week = int(pick(raw, ["week", "week_number", "game_week", "week_no"]));
      const referee = pick(raw, ["referee", "crew_chief", "official", "ref"]);
      const crew = pick(raw, ["crew", "crew_name", "officials", "crewMembers"]);
      if (!Number.isFinite(season) || !Number.isFinite(week) || !referee) return null;
      return {
        season,
        week,
        referee: String(referee).trim(),
        crew: crew != null ? String(crew).trim() : ""
      };
    })
    .filter(Boolean);
}

export { sanitizeArray };
