// trainer/featureBuild.js
//
// Build season-to-date (S2D) features from nflverse team-week and team-game datasets.
// Includes baseline cumulative stats plus advanced situational rates derived from team_game.
// Defensive "allowed" values are taken from the opponent row in the same game/week.
// Only generates rows for actual games (no fabrication of future weeks).

import { aggregatePBP } from "./featureBuild_pbp.js";
import { aggregateFourthDown } from "./featureBuild_fourthDown.js";
import { aggregatePlayerUsage } from "./featureBuild_players.js";
import { buildTeamInjuryIndex, getTeamInjurySnapshot, normalizePlayerKey } from "./injuryIndex.js";
import { normalizeTeamCode } from "./teamCodes.js";

export const FEATS = [
  "off_1st_down_s2d",
  "off_total_yds_s2d",
  "off_total_yds_exp",
  "off_rush_yds_s2d",
  "off_rush_yds_exp",
  "off_pass_yds_s2d",
  "off_pass_yds_exp",
  "off_turnovers_s2d",
  "off_turnovers_exp",
  "def_1st_down_s2d",
  "def_total_yds_s2d",
  "def_total_yds_exp",
  "def_rush_yds_s2d",
  "def_rush_yds_exp",
  "def_pass_yds_s2d",
  "def_pass_yds_exp",
  "def_turnovers_s2d",
  "def_turnovers_exp",
  "wins_s2d",
  "losses_s2d",
  "wins_exp",
  "losses_exp",
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
  "off_third_down_pct_exp",
  "off_red_zone_td_pct_exp",
  "off_sack_rate_exp",
  "off_neutral_pass_rate_exp",
  "off_third_down_pct_s2d_minus_opp",
  "off_red_zone_td_pct_s2d_minus_opp",
  "off_sack_rate_s2d_minus_opp",
  "off_neutral_pass_rate_s2d_minus_opp",
  "off_yds_for_3g",
  "off_yds_for_5g",
  "def_yds_against_3g",
  "def_yds_against_5g",
  "net_yds_3g",
  "net_yds_5g",
  "qb_ypa_3g",
  "qb_sack_rate_3g",
  "qb_qbr",
  "off_epa_per_play_s2d",
  "off_epa_per_play_w3",
  "off_epa_per_play_w5",
  "off_epa_per_play_exp",
  "off_success_rate_s2d",
  "off_success_rate_w3",
  "off_success_rate_w5",
  "off_success_rate_exp",
  "off_xyac_epa_per_play_s2d",
  "off_xyac_epa_per_play_w3",
  "off_xyac_epa_per_play_w5",
  "off_xyac_epa_per_play_exp",
  "off_wp_mean_s2d",
  "off_wp_mean_w3",
  "off_wp_mean_w5",
  "off_wp_mean_exp",
  "off_cpoe_mean_s2d",
  "off_cpoe_mean_w3",
  "off_cpoe_mean_w5",
  "off_cpoe_mean_exp",
  "def_epa_per_play_allowed_s2d",
  "def_epa_per_play_allowed_w3",
  "def_epa_per_play_allowed_w5",
  "def_epa_per_play_allowed_exp",
  "def_success_rate_allowed_s2d",
  "def_success_rate_allowed_w3",
  "def_success_rate_allowed_w5",
  "def_success_rate_allowed_exp",
  "def_xyac_epa_per_play_allowed_s2d",
  "def_xyac_epa_per_play_allowed_w3",
  "def_xyac_epa_per_play_allowed_w5",
  "def_xyac_epa_per_play_allowed_exp",
  "def_wp_mean_allowed_s2d",
  "def_wp_mean_allowed_w3",
  "def_wp_mean_allowed_w5",
  "def_wp_mean_allowed_exp",
  "def_cpoe_mean_allowed_s2d",
  "def_cpoe_mean_allowed_w3",
  "def_cpoe_mean_allowed_w5",
  "def_cpoe_mean_allowed_exp",
  "rb_rush_share_s2d",
  "rb_rush_share_w3",
  "rb_rush_share_w5",
  "rb_rush_share_exp",
  "wr_target_share_s2d",
  "wr_target_share_w3",
  "wr_target_share_w5",
  "wr_target_share_exp",
  "te_target_share_s2d",
  "te_target_share_w3",
  "te_target_share_w5",
  "te_target_share_exp",
  "qb_aypa_s2d",
  "qb_aypa_w3",
  "qb_aypa_w5",
  "qb_aypa_exp",
  "qb_sack_rate_s2d",
  "qb_sack_rate_w3",
  "qb_sack_rate_w5",
  "qb_sack_rate_exp",
  "roof_dome",
  "roof_outdoor",
  "weather_temp_f",
  "weather_wind_mph",
  "weather_precip_pct",
  "weather_impact_score",
  "weather_extreme_flag",
  "inj_out_count",
  "inj_questionable_count",
  "inj_skill_out_count",
  "inj_ol_out_count",
  "inj_practice_dnp_count",
  "inj_out_diff",
  "inj_skill_out_diff",
  "inj_practice_dnp_diff",
  "inj_out_change",
  "inj_skill_out_change",
  "injury_return_delta",
  "injury_return_count",
  "fourth_down_align_rate_s2d",
  "fourth_down_align_rate_w3",
  "fourth_down_align_rate_w5",
  "fourth_down_align_rate_exp",
  "fourth_down_aligned_delta_wp_s2d",
  "fourth_down_aligned_delta_wp_w3",
  "fourth_down_aligned_delta_wp_w5",
  "fourth_down_aligned_delta_wp_exp",
  "fourth_down_mismatch_delta_wp_s2d",
  "fourth_down_mismatch_delta_wp_w3",
  "fourth_down_mismatch_delta_wp_w5",
  "fourth_down_mismatch_delta_wp_exp",
  "market_delta_spread",
  "momentum_composite",
  "off_eff_residual",
  "off_eff_recalibrate",
  "def_eff_residual",
  "def_eff_recalibrate"
];

const DECAY_LAMBDA = 0.85;
const MAX_HISTORY = 8;

const PBP_METRICS = [
  { key: "off_epa_per_play", weightKey: "off_play_weight" },
  { key: "off_success_rate", weightKey: "off_play_weight" },
  { key: "def_epa_per_play_allowed", weightKey: "def_play_weight" },
  { key: "def_success_rate_allowed", weightKey: "def_play_weight" },
  { key: "off_xyac_epa_per_play", weightKey: "off_xyac_weight" },
  { key: "off_wp_mean", weightKey: "off_wp_weight" },
  { key: "off_cpoe_mean", weightKey: "off_cpoe_weight" },
  { key: "def_xyac_epa_per_play_allowed", weightKey: "def_xyac_weight" },
  { key: "def_wp_mean_allowed", weightKey: "def_wp_weight" },
  { key: "def_cpoe_mean_allowed", weightKey: "def_cpoe_weight" }
];

const FOURTH_METRICS = [
  { key: "fourth_down_align_rate", weightKey: "fourth_down_align_weight" },
  { key: "fourth_down_aligned_delta_wp", weightKey: "fourth_down_aligned_weight" },
  { key: "fourth_down_mismatch_delta_wp", weightKey: "fourth_down_mismatch_weight" }
];

const USAGE_METRICS = [
  { key: "rb_rush_share", weightKey: "rb_rush_weight" },
  { key: "wr_target_share", weightKey: "target_weight" },
  { key: "te_target_share", weightKey: "target_weight" },
  { key: "qb_aypa", weightKey: "qb_aypa_weight" },
  { key: "qb_sack_rate", weightKey: "qb_sack_rate_weight" }
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

const maybeNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const dateOnly = (value) => (value ? String(value).slice(0, 10) : null);

const normTeam = (...values) => normalizeTeamCode(...values);

const weightedAverage = (history = []) => {
  if (!history.length) return 0;
  const weight = history.reduce((s, r) => s + (Number(r.weight) || 0), 0);
  if (weight > 0) {
    const sum = history.reduce((s, r) => s + (Number(r.value) || 0) * (Number(r.weight) || 0), 0);
    return sum / weight;
  }
  const total = history.reduce((s, r) => s + (Number(r.value) || 0), 0);
  return total / history.length;
};

const triangularAverage = (arr = [], size = 3) => {
  if (!arr.length) return 0;
  const slice = arr.slice(-size);
  let total = 0;
  let weightSum = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const value = Number(slice[i]);
    if (!Number.isFinite(value)) continue;
    const weight = i + 1; // give most recent the highest weight
    total += value * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? total / weightSum : 0;
};

const windowAverage = (history = [], size = 3, { triangular = false } = {}) => {
  if (!history.length) return 0;
  if (triangular) return triangularAverage(history.map((entry) => entry.value ?? entry));
  const slice = history.slice(-size);
  return weightedAverage(slice);
};

const updateExponential = (prevExp, value, weight = 1) => {
  if (!Number.isFinite(value)) return Number(prevExp) || 0;
  if (!Number.isFinite(weight) || weight <= 0) weight = 1;
  if (prevExp == null || !Number.isFinite(prevExp)) return value;
  return DECAY_LAMBDA * prevExp + (1 - DECAY_LAMBDA) * value;
};

const updateHistory = (prevHistory = [], value, limit = MAX_HISTORY) => {
  const history = Array.isArray(prevHistory) ? prevHistory.slice() : [];
  if (Number.isFinite(value)) {
    history.push(value);
    if (history.length > limit) history.shift();
  }
  return history;
};

const avgLast = (arr = [], k = 3) => {
  if (!arr.length) return 0;
  const slice = arr.slice(-k);
  const sum = slice.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  return slice.length ? sum / slice.length : 0;
};

function pushLimited(arr, value, limit = 8) {
  if (!Number.isFinite(value)) value = 0;
  arr.push(value);
  if (arr.length > limit) arr.shift();
}

function ensureFormState(map, team) {
  if (!map.has(team)) {
    map.set(team, {
      offFor: [],
      defAgainst: [],
      qbYpa: [],
      qbSack: []
    });
  }
  return map.get(team);
}

function snapshotRolling(state = {}) {
  const offFor = state.offFor || [];
  const defAgainst = state.defAgainst || [];
  const qbYpa = state.qbYpa || [];
  const qbSack = state.qbSack || [];
  const off3 = avgLast(offFor, 3);
  const off5 = avgLast(offFor, 5);
  const def3 = avgLast(defAgainst, 3);
  const def5 = avgLast(defAgainst, 5);
  return {
    off3,
    off5,
    def3,
    def5,
    net3: off3 - def3,
    net5: off5 - def5,
    qbYpa3: avgLast(qbYpa, 3),
    qbSack3: avgLast(qbSack, 3)
  };
}

function updateFormSnapshots(state, signals = {}, usage = {}) {
  if (!state) return;
  pushLimited(state.offFor, num(signals.offTotal));
  pushLimited(state.defAgainst, num(signals.defTotalAllowed));
  const ypaVal = Number.isFinite(usage.qb_aypa) ? usage.qb_aypa : 0;
  const sackVal = Number.isFinite(usage.qb_sack_rate) ? usage.qb_sack_rate : 0;
  pushLimited(state.qbYpa, ypaVal);
  pushLimited(state.qbSack, sackVal);
}

function buildTeamQBRHistory(rows = [], season) {
  const map = new Map();
  for (const row of rows) {
    if (Number(row.season) !== Number(season)) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;
    const pos = String(row.position ?? row.player_position ?? row.pos ?? "").toUpperCase();
    if (pos && pos !== "QB") continue;
    const team = normTeam(row.recent_team, row.team, row.team_abbr, row.posteam);
    if (!team) continue;
    const qbr = Number(row.qbr_total ?? row.qbr ?? row.total_qbr ?? row.espn_qbr ?? row.qbr_raw ?? row.qbr_offense);
    if (!Number.isFinite(qbr)) continue;
    const key = team;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ week, qbr });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.week - b.week);
  return map;
}

function latestTeamQBR(map, team, week) {
  const arr = map.get(team);
  if (!arr || !arr.length) return null;
  let val = null;
  for (const entry of arr) {
    if (Number.isFinite(week) && entry.week > week) break;
    val = entry.qbr;
  }
  return val ?? arr[arr.length - 1].qbr ?? null;
}

function updateMetricCollection(prevState = {}, configs = [], weekMetrics = {}) {
  const nextState = { ...prevState };
  const features = {};
  for (const cfg of configs) {
    const baseKey = cfg.key;
    const value = Number(weekMetrics[baseKey] ?? 0) || 0;
    const weight = Number(weekMetrics[cfg.weightKey] ?? 0) || 0;
    const prev = prevState[baseKey] || { sum: 0, weight: 0, history: [], exp: null };
    const history = Array.isArray(prev.history) ? prev.history.slice() : [];
    history.push({ value, weight });
    if (history.length > MAX_HISTORY) history.shift();
    const sum = prev.sum + (weight > 0 ? value * weight : 0);
    const weightSum = prev.weight + (weight > 0 ? weight : 0);
    let exp = prev.exp;
    if (weight > 0) {
      exp = exp == null ? value : DECAY_LAMBDA * exp + (1 - DECAY_LAMBDA) * value;
    } else if (exp == null) {
      exp = value;
    }
    const s2d = weightSum > 0 ? sum / weightSum : weightedAverage(history);
    const w3 = windowAverage(history, 3);
    const w5 = windowAverage(history, 5);
    nextState[baseKey] = { sum, weight: weightSum, history, exp };
    features[`${baseKey}_s2d`] = Number.isFinite(s2d) ? s2d : 0;
    features[`${baseKey}_w3`] = Number.isFinite(w3) ? w3 : 0;
    features[`${baseKey}_w5`] = Number.isFinite(w5) ? w5 : 0;
    features[`${baseKey}_exp`] = Number.isFinite(exp) ? exp : 0;
  }
  return { state: nextState, features };
}

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
    const team = normTeam(row.team, row.team_abbr, row.team_code);
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
    const team = normTeam(row.team, row.team_abbr, row.team_code, row.posteam);
    if (!team) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;
    idx.set(`${season}-${week}-${team}`, row);
  }
  return idx;
}

function indexWeather(rows = [], season) {
  const idx = new Map();
  for (const row of rows) {
    if (Number(row.season) !== Number(season)) continue;
    const wk = Number(row.week);
    const home = normTeam(row.home_team, row.home);
    const away = normTeam(row.away_team, row.away);
    const key = row.game_key ?? (Number.isFinite(wk) && home && away
      ? `${season}-W${String(wk).padStart(2, '0')}-${home}-${away}`
      : null);
    if (!key) continue;
    idx.set(key, row);
  }
  return idx;
}

function computeWeatherFeatures(entry, { roofDome }) {
  const isDome = entry?.is_dome === true || Boolean(roofDome);
  const temperature = Number(entry?.temperature_f);
  const precip = Number(entry?.precipitation_chance);
  const wind = Number(entry?.wind_mph);
  const impact = Number(entry?.impact_score);
  const baseTemp = isDome ? 70 : 65;
  const out = {
    weather_temp_f: Number.isFinite(temperature) ? temperature : baseTemp,
    weather_precip_pct: Number.isFinite(precip) ? precip : 0,
    weather_wind_mph: Number.isFinite(wind) ? wind : isDome ? 0 : 5,
    weather_impact_score: Number.isFinite(impact) ? impact : isDome ? 0 : 0
  };
  const extreme =
    (Number.isFinite(out.weather_impact_score) && out.weather_impact_score >= 0.5) ||
    (Number.isFinite(out.weather_wind_mph) && out.weather_wind_mph >= 18) ||
    (Number.isFinite(out.weather_precip_pct) && out.weather_precip_pct >= 60) ||
    (Number.isFinite(out.weather_temp_f) && (out.weather_temp_f <= 25 || out.weather_temp_f >= 95))
      ? 1
      : 0;
  out.weather_extreme_flag = extreme;
  return out;
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
  const next = {};

  const thirdAttVal = num(metrics.thirdAtt);
  const thirdConvVal = num(metrics.thirdConv);
  const redAttVal = num(metrics.redAtt);
  const redTDVal = num(metrics.redTD);
  const passAttVal = num(metrics.passAtt);
  const rushAttVal = num(metrics.rushAtt);
  const sacksVal = num(metrics.sacksTaken);
  const dropbacksVal = passAttVal + sacksVal;
  const neutralDenom = passAttVal + rushAttVal;

  const thirdAttHist = updateHistory(prev.__hist_third_att, thirdAttVal);
  const thirdConvHist = updateHistory(prev.__hist_third_conv, thirdConvVal);
  const redAttHist = updateHistory(prev.__hist_red_att, redAttVal);
  const redTDHist = updateHistory(prev.__hist_red_td, redTDVal);
  const passAttHist = updateHistory(prev.__hist_pass_att, passAttVal);
  const rushAttHist = updateHistory(prev.__hist_rush_att, rushAttVal);
  const sacksHist = updateHistory(prev.__hist_sacks_taken, sacksVal);
  const dropbacksHist = updateHistory(prev.__hist_dropbacks, dropbacksVal);

  const thirdPctVal = thirdAttVal > 0 ? thirdConvVal / thirdAttVal : null;
  const redPctVal = redAttVal > 0 ? redTDVal / redAttVal : null;
  const sackRateVal = dropbacksVal > 0 ? sacksVal / dropbacksVal : null;
  const neutralRateVal = neutralDenom > 0 ? passAttVal / neutralDenom : null;

  const thirdPctHist = updateHistory(prev.__hist_third_pct, thirdPctVal);
  const redPctHist = updateHistory(prev.__hist_red_pct, redPctVal);
  const sackRateHist = updateHistory(prev.__hist_sack_rate, sackRateVal);
  const neutralRateHist = updateHistory(prev.__hist_neutral_rate, neutralRateVal);

  next.off_third_down_att_s2d = triangularAverage(thirdAttHist);
  next.off_third_down_conv_s2d = triangularAverage(thirdConvHist);
  next.off_red_zone_att_s2d = triangularAverage(redAttHist);
  next.off_red_zone_td_s2d = triangularAverage(redTDHist);
  next.off_pass_att_s2d = triangularAverage(passAttHist);
  next.off_rush_att_s2d = triangularAverage(rushAttHist);
  next.off_sacks_taken_s2d = triangularAverage(sacksHist);
  next.off_dropbacks_s2d = triangularAverage(dropbacksHist);

  const thirdPct = triangularAverage(thirdPctHist);
  const redPct = triangularAverage(redPctHist);
  const sackRate = triangularAverage(sackRateHist);
  const neutralRate = triangularAverage(neutralRateHist);

  const thirdPctExp = updateExponential(prev.__exp_third_pct, Number.isFinite(thirdPctVal) ? thirdPctVal : thirdPct);
  const redPctExp = updateExponential(prev.__exp_red_pct, Number.isFinite(redPctVal) ? redPctVal : redPct);
  const sackRateExp = updateExponential(prev.__exp_sack_rate, Number.isFinite(sackRateVal) ? sackRateVal : sackRate);
  const neutralRateExp = updateExponential(
    prev.__exp_neutral_rate,
    Number.isFinite(neutralRateVal) ? neutralRateVal : neutralRate
  );

  next.off_third_down_pct_s2d = Number.isFinite(thirdPct) ? thirdPct : 0;
  next.off_red_zone_td_pct_s2d = Number.isFinite(redPct) ? redPct : 0;
  next.off_sack_rate_s2d = Number.isFinite(sackRate) ? sackRate : 0;
  next.off_neutral_pass_rate_s2d = Number.isFinite(neutralRate) ? neutralRate : 0;

  next.off_third_down_pct_exp = Number.isFinite(thirdPctExp) ? thirdPctExp : next.off_third_down_pct_s2d;
  next.off_red_zone_td_pct_exp = Number.isFinite(redPctExp) ? redPctExp : next.off_red_zone_td_pct_s2d;
  next.off_sack_rate_exp = Number.isFinite(sackRateExp) ? sackRateExp : next.off_sack_rate_s2d;
  next.off_neutral_pass_rate_exp = Number.isFinite(neutralRateExp)
    ? neutralRateExp
    : next.off_neutral_pass_rate_s2d;

  next.__hist_third_att = thirdAttHist;
  next.__hist_third_conv = thirdConvHist;
  next.__hist_red_att = redAttHist;
  next.__hist_red_td = redTDHist;
  next.__hist_pass_att = passAttHist;
  next.__hist_rush_att = rushAttHist;
  next.__hist_sacks_taken = sacksHist;
  next.__hist_dropbacks = dropbacksHist;
  next.__hist_third_pct = thirdPctHist;
  next.__hist_red_pct = redPctHist;
  next.__hist_sack_rate = sackRateHist;
  next.__hist_neutral_rate = neutralRateHist;
  next.__exp_third_pct = thirdPctExp;
  next.__exp_red_pct = redPctExp;
  next.__exp_sack_rate = sackRateExp;
  next.__exp_neutral_rate = neutralRateExp;

  return next;
}

function zeroAdvanced() {
  return {
    off_third_down_att_s2d: 0,
    off_third_down_conv_s2d: 0,
    off_third_down_pct_s2d: 0,
    off_third_down_pct_exp: 0,
    off_red_zone_att_s2d: 0,
    off_red_zone_td_s2d: 0,
    off_red_zone_td_pct_s2d: 0,
    off_red_zone_td_pct_exp: 0,
    off_pass_att_s2d: 0,
    off_rush_att_s2d: 0,
    off_sacks_taken_s2d: 0,
    off_dropbacks_s2d: 0,
    off_sack_rate_s2d: 0,
    off_sack_rate_exp: 0,
    off_neutral_pass_rate_s2d: 0,
    off_neutral_pass_rate_exp: 0
  };
}

function seedElo(team, prevTeamWeekly) {
  const wins = (prevTeamWeekly || [])
    .filter((row) => normTeam(row.team) === team)
    .reduce((sum, row) => sum + num(row.wins ?? row.win ?? 0), 0);
  return Number.isFinite(wins) ? 1450 + 5 * wins : 1500;
}

export function buildFeatures({
  teamWeekly,
  teamGame = [],
  schedules,
  season,
  prevTeamWeekly,
  pbp = [],
  fourthDown = [],
  playerWeekly = [],
  weather = [],
  injuries = [],
  markets = []
}) {
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
  const pbpIdx = aggregatePBP({ rows: pbp || [], season: seasonNum });
  const fourthIdx = aggregateFourthDown({ rows: fourthDown || [], season: seasonNum });
  const usageIdx = aggregatePlayerUsage({ rows: playerWeekly || [], season: seasonNum });
  const weatherIdx = indexWeather(weather || [], seasonNum);
  const injuryIdx = buildTeamInjuryIndex(injuries || [], seasonNum);
  const playerWeekIdx =
    typeof indexPlayerWeeks === "function" ? indexPlayerWeeks(playerWeekly || [], seasonNum) : new Map();
  const marketIdx = typeof indexMarkets === "function" ? indexMarkets(markets || [], seasonNum) : new Map();

  const lastDate = new Map();
  const elo = new Map();
  const eloHistory = new Map();
  const qbTrendState = new Map();
  const residualState = new Map();
  const playerBaselineState = new Map();
  for (const team of teams) {
    elo.set(team, seedElo(team, prevTeamWeekly));
    eloHistory.set(team, [elo.get(team)]);
    qbTrendState.set(team, []);
  }

  const roll = new Map();
  const advRoll = new Map();
  const pbpRoll = new Map();
  const fourthRoll = new Map();
  const usageRoll = new Map();
  const formRoll = new Map();
  const qbQbrHistory = buildTeamQBRHistory(playerWeekly || [], seasonNum);
  for (const team of teams) {
    roll.set(team, new Map());
    advRoll.set(team, new Map());
    pbpRoll.set(team, {});
    fourthRoll.set(team, {});
    usageRoll.set(team, {});
    ensureFormState(formRoll, team);
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
      const hPbpWeek = pbpIdx.get(hKey) || {};
      const aPbpWeek = pbpIdx.get(aKey) || {};
      const hFourthWeek = fourthIdx.get(hKey) || {};
      const aFourthWeek = fourthIdx.get(aKey) || {};
      const hUsageWeek = usageIdx.get(hKey) || {};
      const aUsageWeek = usageIdx.get(aKey) || {};

      const hOppRow = aRow;
      const aOppRow = hRow;

      const hSignals = perGameSignals(hRow, hOppRow);
      const aSignals = perGameSignals(aRow, aOppRow);
      const hAdvSignals = advancedSignals(hAdvRow);
      const aAdvSignals = advancedSignals(aAdvRow);

      const hPbpPrev = pbpRoll.get(home) || {};
      const aPbpPrev = pbpRoll.get(away) || {};
      const hFourthPrev = fourthRoll.get(home) || {};
      const aFourthPrev = fourthRoll.get(away) || {};
      const hUsagePrev = usageRoll.get(home) || {};
      const aUsagePrev = usageRoll.get(away) || {};

      const { state: hPbpState, features: hPbpFeats } = updateMetricCollection(
        hPbpPrev,
        PBP_METRICS,
        hPbpWeek
      );
      const { state: aPbpState, features: aPbpFeats } = updateMetricCollection(
        aPbpPrev,
        PBP_METRICS,
        aPbpWeek
      );
      pbpRoll.set(home, hPbpState);
      pbpRoll.set(away, aPbpState);

      const { state: hFourthState, features: hFourthFeats } = updateMetricCollection(
        hFourthPrev,
        FOURTH_METRICS,
        hFourthWeek
      );
      const { state: aFourthState, features: aFourthFeats } = updateMetricCollection(
        aFourthPrev,
        FOURTH_METRICS,
        aFourthWeek
      );
      fourthRoll.set(home, hFourthState);
      fourthRoll.set(away, aFourthState);

      const { state: hUsageState, features: hUsageFeats } = updateMetricCollection(
        hUsagePrev,
        USAGE_METRICS,
        hUsageWeek
      );
      const { state: aUsageState, features: aUsageFeats } = updateMetricCollection(
        aUsagePrev,
        USAGE_METRICS,
        aUsageWeek
      );
      usageRoll.set(home, hUsageState);
      usageRoll.set(away, aUsageState);

      const hPrev = roll.get(home).get(week - 1) || {};
      const aPrev = roll.get(away).get(week - 1) || {};

const BASE_ROLLING_FIELDS = [
  { field: "off_1st_down", getter: (sig) => num(sig.offFD) },
  { field: "off_total_yds", getter: (sig) => num(sig.offTotal) },
  { field: "off_rush_yds", getter: (sig) => num(sig.rushYds) },
  { field: "off_pass_yds", getter: (sig) => num(sig.passYds) },
  { field: "off_turnovers", getter: (sig) => num(sig.offTO) },
  { field: "def_1st_down", getter: (sig) => num(sig.defFDAllowed) },
  { field: "def_total_yds", getter: (sig) => num(sig.defTotalAllowed) },
  { field: "def_rush_yds", getter: (sig) => num(sig.defRushAllowed) },
  { field: "def_pass_yds", getter: (sig) => num(sig.defPassAllowed) },
  { field: "def_turnovers", getter: (sig) => num(sig.defTO) }
];

const updateRoll = (prev = {}, sig = {}) => {
  const next = {};
  for (const cfg of BASE_ROLLING_FIELDS) {
    const value = cfg.getter(sig);
    const histKey = `__hist_${cfg.field}`;
    const expKey = `__exp_${cfg.field}`;
    const history = updateHistory(prev[histKey], value);
    const weighted = triangularAverage(history);
    const expVal = updateExponential(prev[expKey], value);
    next[`${cfg.field}_s2d`] = Number.isFinite(weighted) ? weighted : 0;
    next[`${cfg.field}_exp`] = Number.isFinite(expVal) ? expVal : 0;
    next[histKey] = history;
    next[expKey] = expVal;
  }
  next.wins_s2d = Number.isFinite(prev.wins_s2d) ? prev.wins_s2d : 0;
  next.losses_s2d = Number.isFinite(prev.losses_s2d) ? prev.losses_s2d : 0;
  next.__hist_wins = Array.isArray(prev.__hist_wins) ? prev.__hist_wins.slice() : [];
  next.__exp_wins = Number.isFinite(prev.__exp_wins) ? prev.__exp_wins : null;
  next.wins_exp = Number.isFinite(prev.__exp_wins) ? prev.__exp_wins : Number(next.wins_s2d) || 0;
  next.losses_exp = Number.isFinite(prev.__exp_wins) ? 1 - prev.__exp_wins : Number(next.losses_s2d) || 0;
  return next;
};

const updateWinHistory = (prev = {}, result = null) => {
  const history = Array.isArray(prev.__hist_wins) ? prev.__hist_wins.slice() : [];
  if (Number.isFinite(result)) {
    history.push(result);
    if (history.length > MAX_HISTORY) history.shift();
  }
  const winsWeighted = triangularAverage(history);
  const exp = Number.isFinite(result)
    ? updateExponential(prev.__exp_wins, result)
    : prev.__exp_wins != null
      ? prev.__exp_wins
      : Number.isFinite(winsWeighted)
        ? winsWeighted
        : 0;
  return {
    history,
    wins: Number.isFinite(winsWeighted) ? winsWeighted : Number(prev.wins_s2d) || 0,
    losses: Number.isFinite(winsWeighted) ? 1 - winsWeighted : Number(prev.losses_s2d) || 0,
    exp
  };
};

const playerKeyFromWeekly = (row = {}) => {
  const normalized = normalizePlayerKey(row);
  if (normalized) return normalized;
  const fallback = row.player_id ?? row.player ?? row.player_name ?? row.gsis_id ?? null;
  return fallback ? String(fallback).trim().toUpperCase() : null;
};

function indexPlayerWeeks(rows = [], season) {
  const seasonNum = Number(season);
  const map = new Map();
  for (const row of rows || []) {
    if (Number(row.season) !== seasonNum) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;
    const team = normTeam(row.recent_team, row.team, row.team_abbr, row.posteam);
    if (!team) continue;
    const key = `${seasonNum}-${week}-${team}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function indexMarkets(rows = [], season) {
  const map = new Map();
  const seasonNum = Number(season);
  for (const row of rows || []) {
    if (Number(row.season ?? row.year ?? seasonNum) !== seasonNum) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;
    const home = normTeam(row.home_team, row.home, row.team_home);
    const away = normTeam(row.away_team, row.away, row.team_away);
    if (!home || !away) continue;
    const key = `${seasonNum}-W${String(week).padStart(2, "0")}-${home}-${away}`;
    const market = row.market && typeof row.market === "object" ? row.market : row;
    const spreadOpen =
      maybeNum(market.spread_open) ??
      maybeNum(market.opening_spread) ??
      maybeNum(market.spread_pre) ??
      maybeNum(market.open_spread) ??
      maybeNum(market.initial_spread);
    const spreadClose =
      maybeNum(market.spread_close) ??
      maybeNum(market.closing_spread) ??
      maybeNum(market.spread) ??
      maybeNum(market.final_spread);
    map.set(key, {
      open: spreadOpen,
      close: spreadClose,
      delta:
        Number.isFinite(spreadOpen) && Number.isFinite(spreadClose) ? spreadClose - spreadOpen : null,
      source: market.source ?? row.source ?? null
    });
  }
  return map;
}

const RESIDUAL_THRESHOLD = 0.15;

function ensureResidualState(map, team) {
  if (!map.has(team)) {
    map.set(team, { offense: [], defense: [], offConsec: 0, defConsec: 0 });
  }
  return map.get(team);
}

function computePlayerContribution(row = {}) {
  const rushEPA = maybeNum(row.rush_epa ?? row.rushing_epa);
  const recEPA = maybeNum(row.rec_epa ?? row.receiving_epa);
  const passEPA = maybeNum(row.pass_epa ?? row.passing_epa ?? row.pass_epa_total);
  const epaSum = [rushEPA, recEPA, passEPA]
    .filter((val) => Number.isFinite(val))
    .reduce((sum, val) => sum + val, 0);
  if (Number.isFinite(epaSum) && epaSum !== 0) return epaSum;
  const rushYds = maybeNum(row.rushing_yards ?? row.rush_yards ?? row.rush_yds);
  const recYds = maybeNum(row.receiving_yards ?? row.rec_yards ?? row.rec_yds);
  const passYds = maybeNum(row.passing_yards ?? row.pass_yards ?? row.pass_yds);
  const yards = (rushYds || 0) + (recYds || 0) + (passYds || 0);
  if (Number.isFinite(yards) && yards !== 0) return yards / 100;
  const touchdowns = maybeNum(row.total_tds ?? row.touchdowns ?? row.rushing_tds ?? row.receiving_tds);
  if (Number.isFinite(touchdowns) && touchdowns !== 0) return touchdowns * 0.7;
  return 0.05;
}

function updatePlayerBaselineState(map, playerKey, contribution) {
  if (!playerKey || !Number.isFinite(contribution)) return;
  const prev = map.get(playerKey) || { total: 0, games: 0, avg: 0 };
  prev.total += contribution;
  prev.games += 1;
  prev.avg = prev.games > 0 ? prev.total / prev.games : 0;
  map.set(playerKey, prev);
}

function computeReturningDelta({ team, season, week, injuryIdx, playerBaselineState }) {
  const current = getTeamInjurySnapshot(injuryIdx, season, week, team);
  const previous = getTeamInjurySnapshot(injuryIdx, season, week - 1, team);
  const prevOut = new Set(previous.players_out || []);
  const currOut = new Set(current.players_out || []);
  let delta = 0;
  let count = 0;
  for (const playerKey of prevOut) {
    if (currOut.has(playerKey)) continue;
    const baseline = playerBaselineState.get(playerKey);
    const contribution = baseline && Number.isFinite(baseline.avg) ? baseline.avg : 0.1;
    delta += contribution;
    count += 1;
  }
  return { delta, count };
}

function computeTrend(history = []) {
  const slice = history.slice(-3);
  if (slice.length < 2) return 0;
  let total = 0;
  let weightSum = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const diff = Number(slice[i]) - Number(slice[i - 1]);
    if (!Number.isFinite(diff)) continue;
    const weight = i;
    total += diff * weight;
    weightSum += weight;
  }
  return weightSum ? total / weightSum : 0;
}

function computeMomentumComposite(eloMomentum, qbMomentum) {
  const scaledElo = Number.isFinite(eloMomentum) ? eloMomentum * 0.01 : 0;
  const scaledQb = Number.isFinite(qbMomentum) ? qbMomentum * 0.02 : 0;
  return scaledElo + scaledQb;
}

function pushScalarHistory(map, team, value) {
  if (!Number.isFinite(value)) return;
  const arr = map.get(team) || [];
  arr.push(value);
  if (arr.length > MAX_HISTORY) arr.shift();
  map.set(team, arr);
}

const computeResidual = (actual, expected) => {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return 0;
  if (!expected) return actual ? Math.sign(actual) * 0.2 : 0;
  return (actual - expected) / Math.max(Math.abs(expected), 1);
};

function updateResidualState(state, type, residual) {
  if (!Number.isFinite(residual)) return;
  const arrKey = type === "defense" ? "defense" : "offense";
  const consecKey = type === "defense" ? "defConsec" : "offConsec";
  const arr = state[arrKey];
  arr.push(residual);
  if (arr.length > MAX_HISTORY) arr.shift();
  if (Math.abs(residual) > RESIDUAL_THRESHOLD) {
    state[consecKey] = Math.min(MAX_HISTORY, state[consecKey] + 1);
  } else {
    state[consecKey] = 0;
  }
}

      const homePrevOffExp = Number.isFinite(hPrev.off_total_yds_exp)
        ? hPrev.off_total_yds_exp
        : Number.isFinite(hPrev.off_total_yds_s2d)
          ? hPrev.off_total_yds_s2d
          : 0;
      const homePrevDefExp = Number.isFinite(hPrev.def_total_yds_exp)
        ? hPrev.def_total_yds_exp
        : Number.isFinite(hPrev.def_total_yds_s2d)
          ? hPrev.def_total_yds_s2d
          : 0;
      const awayPrevOffExp = Number.isFinite(aPrev.off_total_yds_exp)
        ? aPrev.off_total_yds_exp
        : Number.isFinite(aPrev.off_total_yds_s2d)
          ? aPrev.off_total_yds_s2d
          : 0;
      const awayPrevDefExp = Number.isFinite(aPrev.def_total_yds_exp)
        ? aPrev.def_total_yds_exp
        : Number.isFinite(aPrev.def_total_yds_s2d)
          ? aPrev.def_total_yds_s2d
          : 0;

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
        const homeWinState = updateWinHistory(hPrev, homeWin);
        const awayWinState = updateWinHistory(aPrev, awayWin);
        hS2D.wins_s2d = homeWinState.wins;
        hS2D.losses_s2d = homeWinState.losses;
        hS2D.__hist_wins = homeWinState.history;
        hS2D.__exp_wins = homeWinState.exp;
        hS2D.wins_exp = homeWinState.exp;
        hS2D.losses_exp = 1 - homeWinState.exp;

        aS2D.wins_s2d = awayWinState.wins;
        aS2D.losses_s2d = awayWinState.losses;
        aS2D.__hist_wins = awayWinState.history;
        aS2D.__exp_wins = awayWinState.exp;
        aS2D.wins_exp = awayWinState.exp;
        aS2D.losses_exp = 1 - awayWinState.exp;
      } else {
        hS2D.wins_s2d = Number.isFinite(hPrev.wins_s2d) ? hPrev.wins_s2d : 0;
        hS2D.losses_s2d = Number.isFinite(hPrev.losses_s2d) ? hPrev.losses_s2d : 0;
        hS2D.__hist_wins = Array.isArray(hPrev.__hist_wins) ? hPrev.__hist_wins.slice() : [];
        hS2D.__exp_wins = hPrev.__exp_wins;
        hS2D.wins_exp = Number.isFinite(hPrev.__exp_wins) ? hPrev.__exp_wins : hS2D.wins_s2d;
        hS2D.losses_exp = Number.isFinite(hPrev.__exp_wins) ? 1 - hPrev.__exp_wins : hS2D.losses_s2d;

        aS2D.wins_s2d = Number.isFinite(aPrev.wins_s2d) ? aPrev.wins_s2d : 0;
        aS2D.losses_s2d = Number.isFinite(aPrev.losses_s2d) ? aPrev.losses_s2d : 0;
        aS2D.__hist_wins = Array.isArray(aPrev.__hist_wins) ? aPrev.__hist_wins.slice() : [];
        aS2D.__exp_wins = aPrev.__exp_wins;
        aS2D.wins_exp = Number.isFinite(aPrev.__exp_wins) ? aPrev.__exp_wins : aS2D.wins_s2d;
        aS2D.losses_exp = Number.isFinite(aPrev.__exp_wins) ? 1 - aPrev.__exp_wins : aS2D.losses_s2d;
      }

      const homeRest = daysBetween(lastDate.get(home) || null, gameDate);
      const awayRest = daysBetween(lastDate.get(away) || null, gameDate);
      const restDiff = (homeRest || 0) - (awayRest || 0);

      const homeElo = num(elo.get(home), 1500);
      const awayElo = num(elo.get(away), 1500);
      const eloDiff = homeElo - awayElo;

      const roofFlag = (val) => {
        if (val == null || val === "") return null;
        if (typeof val === "number") return val ? 1 : 0;
        const str = String(val).toLowerCase();
        if (["1", "y", "yes", "true", "dome", "indoors", "indoor"].includes(str)) return 1;
        if (["0", "n", "no", "false", "outdoor", "outdoors", "open"].includes(str)) return 0;
        const numVal = Number(str);
        if (Number.isFinite(numVal)) return numVal ? 1 : 0;
        return null;
      };
      const derivedRoof = String(game.roof ?? game.stadium_type ?? "").toLowerCase();
      const roofDome =
        roofFlag(game.is_dome) ?? (derivedRoof ? (derivedRoof.includes("dome") || derivedRoof.includes("indoor") ? 1 : 0) : 0);
      const roofOutdoor =
        roofFlag(game.is_outdoor) ??
        (derivedRoof ? (derivedRoof.includes("outdoor") || derivedRoof.includes("open") ? 1 : 0) : 0);

      const weatherKey = `${seasonNum}-W${String(week).padStart(2, "0")}-${home}-${away}`;
      const weatherEntry = weatherIdx.get(weatherKey);
      const weatherFeats = computeWeatherFeatures(weatherEntry, { roofDome: Boolean(roofDome) });

      const homeFormState = ensureFormState(formRoll, home);
      const awayFormState = ensureFormState(formRoll, away);
      const homeRolling = snapshotRolling(homeFormState);
      const awayRolling = snapshotRolling(awayFormState);
      const homeQbr = latestTeamQBR(qbQbrHistory, home, week - 1);
      const awayQbr = latestTeamQBR(qbQbrHistory, away, week - 1);

      const mkRow = (
        team,
        opp,
        isHome,
        me,
        op,
        advMe,
        advOp,
        pbpMe,
        fourthMe,
        usageMe,
        rolling,
        qbrVal,
        weatherFeats = {},
        extras = {}
      ) => {
        const adv = advMe || zeroAdvanced();
        const advOpp = advOp || zeroAdvanced();
        const injuryCurrent = getTeamInjurySnapshot(injuryIdx, seasonNum, week, team);
        const injuryOpponent = getTeamInjurySnapshot(injuryIdx, seasonNum, week, opp);
        const injuryPrev = getTeamInjurySnapshot(injuryIdx, seasonNum, week - 1, team);
        return {
          season: seasonNum,
          week,
          team,
          opponent: opp,
          home: isHome ? 1 : 0,
          game_date: gameDate,
          off_1st_down_s2d: num(me.off_1st_down_s2d),
          off_total_yds_s2d: num(me.off_total_yds_s2d),
          off_total_yds_exp: num(me.off_total_yds_exp),
          off_rush_yds_s2d: num(me.off_rush_yds_s2d),
          off_rush_yds_exp: num(me.off_rush_yds_exp),
          off_pass_yds_s2d: num(me.off_pass_yds_s2d),
          off_pass_yds_exp: num(me.off_pass_yds_exp),
          off_turnovers_s2d: num(me.off_turnovers_s2d),
          off_turnovers_exp: num(me.off_turnovers_exp),
          def_1st_down_s2d: num(me.def_1st_down_s2d),
          def_total_yds_s2d: num(me.def_total_yds_s2d),
          def_total_yds_exp: num(me.def_total_yds_exp),
          def_rush_yds_s2d: num(me.def_rush_yds_s2d),
          def_rush_yds_exp: num(me.def_rush_yds_exp),
          def_pass_yds_s2d: num(me.def_pass_yds_s2d),
          def_pass_yds_exp: num(me.def_pass_yds_exp),
          def_turnovers_s2d: num(me.def_turnovers_s2d),
          def_turnovers_exp: num(me.def_turnovers_exp),
          wins_s2d: num(me.wins_s2d),
          losses_s2d: num(me.losses_s2d),
          wins_exp: num(me.wins_exp),
          losses_exp: num(me.losses_exp),
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
          off_yds_for_3g: Number.isFinite(rolling?.off3) ? rolling.off3 : 0,
          off_yds_for_5g: Number.isFinite(rolling?.off5) ? rolling.off5 : 0,
          def_yds_against_3g: Number.isFinite(rolling?.def3) ? rolling.def3 : 0,
          def_yds_against_5g: Number.isFinite(rolling?.def5) ? rolling.def5 : 0,
          net_yds_3g: Number.isFinite(rolling?.net3) ? rolling.net3 : 0,
          net_yds_5g: Number.isFinite(rolling?.net5) ? rolling.net5 : 0,
          qb_ypa_3g: Number.isFinite(rolling?.qbYpa3) ? rolling.qbYpa3 : 0,
          qb_sack_rate_3g: Number.isFinite(rolling?.qbSack3) ? rolling.qbSack3 : 0,
          qb_qbr: Number.isFinite(qbrVal) ? qbrVal : 0,
          win: winLabel(game, isHome),
          ...pbpMe,
          ...fourthMe,
          ...usageMe,
          ...weatherFeats,
          off_third_down_pct_exp: num(adv.off_third_down_pct_exp),
          off_red_zone_td_pct_exp: num(adv.off_red_zone_td_pct_exp),
          off_sack_rate_exp: num(adv.off_sack_rate_exp),
          off_neutral_pass_rate_exp: num(adv.off_neutral_pass_rate_exp),
          roof_dome: roofDome,
          roof_outdoor: roofOutdoor,
          inj_out_count: injuryCurrent.out,
          inj_questionable_count: injuryCurrent.questionable,
          inj_skill_out_count: injuryCurrent.skill_out,
          inj_ol_out_count: injuryCurrent.ol_out,
          inj_practice_dnp_count: injuryCurrent.practice_dnp,
          inj_out_diff: injuryCurrent.out - injuryOpponent.out,
          inj_skill_out_diff: injuryCurrent.skill_out - injuryOpponent.skill_out,
          inj_practice_dnp_diff: injuryCurrent.practice_dnp - injuryOpponent.practice_dnp,
          inj_out_change: injuryCurrent.out - injuryPrev.out,
          inj_skill_out_change: injuryCurrent.skill_out - injuryPrev.skill_out,
          injury_return_delta: Number(extras.injuryReturnDelta ?? 0),
          injury_return_count: Number(extras.injuryReturnCount ?? 0),
          market_delta_spread: Number(extras.marketDelta ?? 0),
          momentum_composite: Number(extras.momentum ?? 0),
          off_eff_residual: Number(extras.offResidual ?? 0),
          off_eff_recalibrate: Number(extras.offResidualFlag ?? 0),
          def_eff_residual: Number(extras.defResidual ?? 0),
          def_eff_recalibrate: Number(extras.defResidualFlag ?? 0)
        };
      };

      const homeResidualSnap = ensureResidualState(residualState, home);
      const awayResidualSnap = ensureResidualState(residualState, away);
      const homeOffResidualFeat = homeResidualSnap.offense.length
        ? homeResidualSnap.offense[homeResidualSnap.offense.length - 1]
        : 0;
      const homeDefResidualFeat = homeResidualSnap.defense.length
        ? homeResidualSnap.defense[homeResidualSnap.defense.length - 1]
        : 0;
      const homeOffRecal = homeResidualSnap.offConsec >= 2 ? 1 : 0;
      const homeDefRecal = homeResidualSnap.defConsec >= 2 ? 1 : 0;

      const awayOffResidualFeat = awayResidualSnap.offense.length
        ? awayResidualSnap.offense[awayResidualSnap.offense.length - 1]
        : 0;
      const awayDefResidualFeat = awayResidualSnap.defense.length
        ? awayResidualSnap.defense[awayResidualSnap.defense.length - 1]
        : 0;
      const awayOffRecal = awayResidualSnap.offConsec >= 2 ? 1 : 0;
      const awayDefRecal = awayResidualSnap.defConsec >= 2 ? 1 : 0;

      const marketKey = `${seasonNum}-W${String(week).padStart(2, "0")}-${home}-${away}`;
      const marketEntry = marketIdx.get(marketKey);
      const homeMarketDelta = Number.isFinite(marketEntry?.delta) ? marketEntry.delta : 0;
      const awayMarketDelta = Number.isFinite(marketEntry?.delta) ? -marketEntry.delta : 0;

      const homeReturn = computeReturningDelta({
        team: home,
        season: seasonNum,
        week,
        injuryIdx,
        playerBaselineState
      });
      const awayReturn = computeReturningDelta({
        team: away,
        season: seasonNum,
        week,
        injuryIdx,
        playerBaselineState
      });

      const homeMomentum = computeMomentumComposite(
        computeTrend(eloHistory.get(home) || []),
        computeTrend(qbTrendState.get(home) || [])
      );
      const awayMomentum = computeMomentumComposite(
        computeTrend(eloHistory.get(away) || []),
        computeTrend(qbTrendState.get(away) || [])
      );

      const homeRow = mkRow(
        home,
        away,
        true,
        hS2D,
        aS2D,
        hAdvS2D,
        aAdvS2D,
        hPbpFeats,
        hFourthFeats,
        hUsageFeats,
        homeRolling,
        homeQbr,
        weatherFeats,
        {
          injuryReturnDelta: homeReturn.delta,
          injuryReturnCount: homeReturn.count,
          marketDelta: homeMarketDelta,
          momentum: homeMomentum,
          offResidual: homeOffResidualFeat,
          offResidualFlag: homeOffRecal,
          defResidual: homeDefResidualFeat,
          defResidualFlag: homeDefRecal
        }
      );
      const awayRow = mkRow(
        away,
        home,
        false,
        aS2D,
        hS2D,
        aAdvS2D,
        hAdvS2D,
        aPbpFeats,
        aFourthFeats,
        aUsageFeats,
        awayRolling,
        awayQbr,
        weatherFeats,
        {
          injuryReturnDelta: awayReturn.delta,
          injuryReturnCount: awayReturn.count,
          marketDelta: awayMarketDelta,
          momentum: awayMomentum,
          offResidual: awayOffResidualFeat,
          offResidualFlag: awayOffRecal,
          defResidual: awayDefResidualFeat,
          defResidualFlag: awayDefRecal
        }
      );
      out.push(homeRow, awayRow);

      const homeActualOff = num(hSignals.offTotal);
      const homeActualDef = num(hSignals.defTotalAllowed);
      const awayActualOff = num(aSignals.offTotal);
      const awayActualDef = num(aSignals.defTotalAllowed);

      updateResidualState(
        homeResidualSnap,
        "offense",
        computeResidual(homeActualOff, homePrevOffExp)
      );
      updateResidualState(
        homeResidualSnap,
        "defense",
        computeResidual(homeActualDef, homePrevDefExp)
      );
      updateResidualState(
        awayResidualSnap,
        "offense",
        computeResidual(awayActualOff, awayPrevOffExp)
      );
      updateResidualState(
        awayResidualSnap,
        "defense",
        computeResidual(awayActualDef, awayPrevDefExp)
      );

      const homePlayers = playerWeekIdx.get(hKey) || [];
      for (const playerRow of homePlayers) {
        const pKey = playerKeyFromWeekly(playerRow);
        const contribution = computePlayerContribution(playerRow);
        updatePlayerBaselineState(playerBaselineState, pKey, contribution);
      }
      const awayPlayers = playerWeekIdx.get(aKey) || [];
      for (const playerRow of awayPlayers) {
        const pKey = playerKeyFromWeekly(playerRow);
        const contribution = computePlayerContribution(playerRow);
        updatePlayerBaselineState(playerBaselineState, pKey, contribution);
      }

      updateFormSnapshots(homeFormState, hSignals, hUsageWeek);
      updateFormSnapshots(awayFormState, aSignals, aUsageWeek);

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
        pushScalarHistory(eloHistory, home, elo.get(home));
        pushScalarHistory(eloHistory, away, elo.get(away));
      }

      const homeQbrCurrent = maybeNum(latestTeamQBR(qbQbrHistory, home, week));
      const awayQbrCurrent = maybeNum(latestTeamQBR(qbQbrHistory, away, week));
      if (homeQbrCurrent != null) pushScalarHistory(qbTrendState, home, homeQbrCurrent);
      if (awayQbrCurrent != null) pushScalarHistory(qbTrendState, away, awayQbrCurrent);
    }
  }

  return out;
}
