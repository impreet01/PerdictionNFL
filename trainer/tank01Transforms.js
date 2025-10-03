// trainer/tank01Transforms.js
// Helpers to map Tank01 API payloads into nflverse-compatible row shapes.

const pick = (row, keys = [], fallback = null) => {
  if (!row) return fallback;
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") return row[key];
  }
  return fallback;
};

const toInt = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
};

const toNum = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const toStr = (value) => {
  if (value == null) return null;
  const str = String(value).trim();
  return str.length ? str : null;
};

const normTeam = (value) => {
  const str = toStr(value);
  return str ? str.toUpperCase() : null;
};

const normPos = (value) => {
  const str = toStr(value);
  return str ? str.toUpperCase() : "";
};

const sumNum = (...values) => {
  return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
};

const parseIsoDate = (value) => {
  if (!value) return null;
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  return str;
};

function ensureTimeOfPossession(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function mapTank01Schedule(row = {}, defaults = {}) {
  const season = toInt(row.season ?? row.seasonYear ?? row.year ?? defaults.season);
  const week = toInt(row.week ?? row.weekNumber ?? row.week_no ?? defaults.week);
  const seasonTypeRaw = pick(row, ["seasonType", "season_type", "gameType"], defaults.season_type ?? "REG");
  const season_type = toStr(seasonTypeRaw)?.toUpperCase() || "REG";
  const home_team =
    normTeam(pick(row, ["homeTeamID", "homeTeam", "home_team", "homeTeamAbbr", "homeAbbr", "home"], defaults.home_team)) ||
    null;
  const away_team =
    normTeam(pick(row, ["awayTeamID", "awayTeam", "away_team", "awayTeamAbbr", "awayAbbr", "away"], defaults.away_team)) ||
    null;
  if (!home_team || !away_team || season == null || week == null) return null;
  const game_id =
    toStr(
      pick(row, ["gameID", "gameId", "game_id", "id", "nflGameId"], defaults.game_id ?? `${season}-${week}-${home_team}-${away_team}`)
    ) || `${season}-${String(week).padStart(2, "0")}-${home_team}-${away_team}`;
  const home_score = toInt(pick(row, ["homeScore", "home_points", "homeScoreTotal", "homePts", "scoreHome"]));
  const away_score = toInt(pick(row, ["awayScore", "away_points", "awayScoreTotal", "awayPts", "scoreAway"]));
  const game_date = parseIsoDate(
    pick(row, ["gameDate", "game_date", "startDate", "date", "gameDateYMD", "gameDay"], defaults.game_date)
  );
  const kickoff = pick(row, ["gameTimeEastern", "startTime", "kickoff", "start_time", "startTimeET"], null);
  const venue = pick(row, ["stadium", "venue", "site", "location"], null);
  const neutral = pick(row, ["neutralSite", "isNeutralSite", "neutral_field"], null);

  return {
    season,
    week,
    season_type,
    game_id,
    game_date,
    kickoff,
    venue,
    neutral_site: neutral === true || String(neutral).toLowerCase() === "true" ? 1 : 0,
    home_team,
    away_team,
    home_score,
    away_score,
    result: home_score != null && away_score != null ? home_score - away_score : null
  };
}

export function mapTank01TeamWeek(row = {}, defaults = {}) {
  const season = toInt(row.season ?? row.seasonYear ?? defaults.season);
  const week = toInt(row.week ?? row.weekNumber ?? row.week_no ?? defaults.week);
  const team = normTeam(pick(row, ["teamID", "team", "teamAbbr", "recentTeam", "team_code"], defaults.team));
  const opponent = normTeam(pick(row, ["opponentID", "opponent", "opponentAbbr", "oppAbbr", "opp"], defaults.opponent));
  if (!team || season == null || week == null) return null;

  const passYds = toNum(
    pick(row, [
      "passingYards",
      "passYards",
      "pass_yards",
      "passYds",
      "offPassYards",
      "pass_yards_gained",
      "passingYardsNet"
    ])
  );
  const rushYds = toNum(
    pick(row, [
      "rushingYards",
      "rushYards",
      "rushing_yards",
      "rush_yards",
      "offRushYards",
      "rushingYardsNet"
    ])
  );
  const penaltyYds = toNum(pick(row, ["penaltyYards", "penaltiesYards", "penalty_yards", "penYds"]));
  const totalYds = toNum(pick(row, ["totalYards", "yards", "offTotalYards", "total_yards"])) ?? sumNum(passYds, rushYds);
  const turnovers = toNum(pick(row, ["turnovers", "turnoversTotal", "giveaways", "totalTurnovers"])) ?? null;
  const interceptions = toNum(pick(row, ["defInterceptions", "interceptions", "interceptionsMade", "def_int"]));
  const defFum = toNum(pick(row, ["defFumblesRecovered", "fumblesRecovered", "def_fumbles"]));
  const firstDownPass = toNum(pick(row, ["firstDownPass", "passingFirstDowns", "pass_first_downs"]));
  const firstDownRush = toNum(pick(row, ["firstDownRush", "rushingFirstDowns", "rush_first_downs"]));
  const firstDownRec = toNum(pick(row, ["firstDownRec", "receivingFirstDowns", "rec_first_downs"]));
  const possSeconds = toNum(pick(row, ["timeOfPossessionSeconds", "timeOfPossession", "possessionSeconds", "possession"], 0));
  const posClock = ensureTimeOfPossession(
    Number.isFinite(possSeconds) ? possSeconds : toNum(pick(row, ["timeOfPossessionDecimal", "time_of_possession_seconds"]))
  );

  const wins = toInt(pick(row, ["wins", "teamWins"], null));
  const losses = toInt(pick(row, ["losses", "teamLosses"], null));

  return {
    season,
    week,
    team,
    opponent,
    passing_yards: passYds ?? null,
    rushing_yards: rushYds ?? null,
    penalty_yards: penaltyYds ?? null,
    total_yards: totalYds ?? null,
    turnovers: turnovers ?? null,
    def_interceptions: interceptions ?? null,
    def_fumbles: defFum ?? null,
    passing_first_downs: firstDownPass ?? null,
    rushing_first_downs: firstDownRush ?? null,
    receiving_first_downs: firstDownRec ?? null,
    time_of_possession: posClock,
    wins,
    losses,
    season_type: toStr(row.seasonType ?? row.season_type ?? defaults.season_type ?? "REG") || "REG"
  };
}

export function mapTank01PlayerWeek(row = {}, defaults = {}) {
  const season = toInt(row.season ?? row.seasonYear ?? defaults.season);
  const week = toInt(row.week ?? row.weekNumber ?? row.week_no ?? defaults.week);
  const team = normTeam(pick(row, ["recentTeam", "team", "teamAbbr", "teamID", "team_code"], defaults.team));
  const opponent = normTeam(pick(row, ["opponent", "oppAbbr", "opponentAbbr"], defaults.opponent));
  if (season == null || week == null) return null;

  return {
    season,
    week,
    recent_team: team,
    team,
    opponent,
    player_id: pick(row, ["playerID", "playerId", "id"], null),
    player_display_name: pick(row, ["playerName", "displayName", "name"], null),
    position: normPos(pick(row, ["position", "pos", "playerPosition"])),
    rushing_attempts: toNum(pick(row, ["rushingAttempts", "rushAttempts", "rushAtt", "attemptsRush"])),
    rushing_yards: toNum(pick(row, ["rushingYards", "rushYards", "rushYds"])),
    rushing_tds: toNum(pick(row, ["rushingTD", "rushingTouchdowns", "rushTD"])),
    rushing_fumbles_lost: toNum(pick(row, ["fumblesLost", "rushingFumblesLost", "rushFumblesLost"])),
    receiving_targets: toNum(pick(row, ["targets", "receivingTargets", "recTargets"])),
    receiving_yards: toNum(pick(row, ["receivingYards", "recYards", "recYds"])),
    receiving_tds: toNum(pick(row, ["receivingTD", "recTD"])),
    receiving_fumbles_lost: toNum(pick(row, ["receivingFumblesLost", "recFumblesLost"])),
    passing_attempts: toNum(pick(row, ["passingAttempts", "passAttempts", "attemptsPass"])),
    passing_completions: toNum(pick(row, ["passingCompletions", "passCompletions", "completions"])),
    passing_yards: toNum(pick(row, ["passingYards", "passYards", "passYds"])),
    passing_tds: toNum(pick(row, ["passingTD", "passTD"])),
    passing_interceptions: toNum(pick(row, ["interceptions", "passINT"])),
    air_yards: toNum(pick(row, ["airYards", "passAirYards", "airyards"])),
    sacks: toNum(pick(row, ["sacks", "sacked", "qbSacked", "sacksTaken"]))
  };
}

export function mapTank01Roster(row = {}, defaults = {}) {
  const team = normTeam(pick(row, ["teamID", "team", "teamAbbr", "recentTeam"], defaults.team));
  if (!team) return null;
  return {
    team,
    season: toInt(row.season ?? defaults.season),
    week: toInt(row.week ?? defaults.week),
    gsis_id: pick(row, ["gsisId", "gsisID", "playerGSIS"], null),
    status: pick(row, ["status", "rosterStatus", "playerStatus"], null),
    position: normPos(pick(row, ["position", "pos", "depthChartPosition"])),
    player_id: pick(row, ["playerID", "playerId", "id"], null),
    player_display_name: pick(row, ["playerName", "displayName", "name"], null)
  };
}

export function mapTank01DepthChart(row = {}, defaults = {}) {
  const team = normTeam(pick(row, ["teamID", "team", "teamAbbr"], defaults.team));
  if (!team) return null;
  return {
    team,
    season: toInt(row.season ?? defaults.season),
    week: toInt(row.week ?? defaults.week),
    position: normPos(pick(row, ["position", "pos"], "")),
    depth_order: toInt(pick(row, ["depth", "order", "depthOrder"], null)),
    player_id: pick(row, ["playerID", "playerId", "id"], null),
    player_display_name: pick(row, ["playerName", "displayName", "name"], null)
  };
}

export function mapTank01Injury(row = {}, defaults = {}) {
  const team = normTeam(pick(row, ["team", "teamAbbr", "teamID"], defaults.team));
  if (!team) return null;
  return {
    team,
    season: toInt(row.season ?? defaults.season),
    week: toInt(row.week ?? defaults.week),
    player_id: pick(row, ["playerID", "playerId", "id"], null),
    player_display_name: pick(row, ["playerName", "name", "displayName"], null),
    position: normPos(pick(row, ["position", "pos"], "")),
    practice_status: pick(row, ["practiceStatus", "practice", "practice_status"], null),
    game_status: pick(row, ["gameStatus", "status", "game_status"], null),
    body_part: pick(row, ["injury", "injuryDetail", "details"], null)
  };
}

export function mapTank01Odds(row = {}, defaults = {}) {
  const season = toInt(row.season ?? defaults.season);
  const week = toInt(row.week ?? row.weekNumber ?? defaults.week);
  const home_team = normTeam(pick(row, ["homeTeam", "homeTeamID", "homeAbbr"], defaults.home_team));
  const away_team = normTeam(pick(row, ["awayTeam", "awayTeamID", "awayAbbr"], defaults.away_team));
  if (season == null || week == null || !home_team || !away_team) return null;
  const spread = toNum(pick(row, ["spread", "homeSpread", "spreadCurrent", "line"], null));
  const total = toNum(pick(row, ["total", "overUnder", "totalPoints"], null));
  return {
    season,
    week,
    home_team,
    away_team,
    spread_line: spread,
    total_line: total,
    provider: pick(row, ["provider", "book", "sportsbook", "source"], null),
    last_update: pick(row, ["lastUpdate", "updated", "timestamp"], null)
  };
}

export function mapTank01Projection(row = {}, defaults = {}) {
  const season = toInt(row.season ?? defaults.season);
  const week = toInt(row.week ?? defaults.week);
  if (season == null || week == null) return null;
  const player_id = pick(row, ["playerID", "playerId", "id"], null);
  const team = normTeam(pick(row, ["team", "teamAbbr", "teamID"], defaults.team));
  return {
    season,
    week,
    player_id,
    player_display_name: pick(row, ["playerName", "displayName", "name"], null),
    position: normPos(pick(row, ["position", "pos"], "")),
    team,
    opponent: normTeam(pick(row, ["opponent", "oppAbbr", "opponentAbbr"], defaults.opponent)),
    passing_yards: toNum(pick(row, ["passingYards", "passYards", "passYdsProj"])),
    passing_tds: toNum(pick(row, ["passingTD", "passTDProj"])),
    rushing_yards: toNum(pick(row, ["rushingYards", "rushYardsProj"])),
    rushing_tds: toNum(pick(row, ["rushingTD", "rushTDProj"])),
    receiving_yards: toNum(pick(row, ["receivingYards", "recYardsProj"])),
    receiving_tds: toNum(pick(row, ["receivingTD", "recTDProj"])),
    fantasy_points: toNum(pick(row, ["fantasyPoints", "fantasyProjection", "projFantasy"], null))
  };
}

export function mapTank01Play(row = {}, defaults = {}) {
  const season = toInt(row.season ?? defaults.season);
  const week = toInt(row.week ?? defaults.week);
  const posteam = normTeam(pick(row, ["posteam", "offenseTeam", "offense", "offenseAbbr"], defaults.posteam));
  const defteam = normTeam(pick(row, ["defteam", "defenseTeam", "defense", "defenseAbbr"], defaults.defteam));
  if (season == null || week == null || !posteam || !defteam) return null;
  const epa = toNum(pick(row, ["epa", "expectedPointsAdded", "playEPA", "epaTotal"]));
  const successRaw = pick(row, ["success", "isSuccess", "successFlag", "successful"], null);
  let success = null;
  if (typeof successRaw === "boolean") {
    success = successRaw ? 1 : 0;
  } else if (successRaw != null) {
    const num = Number(successRaw);
    success = Number.isFinite(num) ? (num > 0 ? 1 : 0) : null;
  }
  return {
    season,
    week,
    posteam,
    defteam,
    epa,
    success,
    season_type: toStr(row.seasonType ?? row.season_type ?? defaults.season_type ?? "REG") || "REG"
  };
}

export function extractFirstArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];
  for (const value of Object.values(payload)) {
    const arr = extractFirstArray(value);
    if (arr.length) return arr;
  }
  return [];
}

export default {
  mapTank01Schedule,
  mapTank01TeamWeek,
  mapTank01PlayerWeek,
  mapTank01Roster,
  mapTank01DepthChart,
  mapTank01Injury,
  mapTank01Odds,
  mapTank01Projection,
  mapTank01Play,
  extractFirstArray
};
