// trainer/contextPack.js
// Builds per-game context for a given week with rolling form, QB trends, injuries, venue, and market.

import {
  loadSchedules,
  loadTeamWeekly,
  loadPlayerWeekly,
  loadInjuries,
  loadESPNQBR
} from "./dataSources.js";
import { loadElo } from "./eloLoader.js";

function toNum(v, def = null) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function rollingAvg(arr, k) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const s = Math.max(0, i - k + 1);
    const slice = arr.slice(s, i + 1)
      .map((val) => toNum(val, null))
      .filter((val) => Number.isFinite(val));
    if (!slice.length) {
      out.push(null);
      continue;
    }
    const sum = slice.reduce((acc, val) => acc + val, 0);
    out.push(sum / slice.length);
  }
  return out;
}

function gameKey(season, week, home, away) {
  return `${season}-W${String(week).padStart(2, "0")}-${home}-${away}`;
}

function pickValue(row, keys = []) {
  for (const key of keys) {
    if (row?.[key] != null && row[key] !== "") return row[key];
  }
  return null;
}

function extractWeeklySeries(rows, weeklyKeys = [], cumulativeKeys = []) {
  const weekly = rows.map((r) => pickValue(r, weeklyKeys));
  if (weekly.some((v) => v != null && v !== "")) {
    return weekly.map((v) => toNum(v, null));
  }
  const cumulative = rows.map((r) => pickValue(r, cumulativeKeys));
  const cumulativeNums = cumulative.map((v) => toNum(v, null));
  const out = [];
  let lastValid = null;
  for (let i = 0; i < cumulativeNums.length; i++) {
    const current = cumulativeNums[i];
    if (!Number.isFinite(current)) {
      out.push(null);
      continue;
    }
    if (!Number.isFinite(lastValid)) {
      out.push(current);
    } else {
      out.push(current - lastValid);
    }
    lastValid = current;
  }
  return out.map((v) => (Number.isFinite(v) ? v : null));
}

function buildInjuryMap(rows, season, week) {
  const out = new Map();
  for (const r of rows || []) {
    if (Number(r.season) !== season) continue;
    const wk = Number(r.week);
    if (Number.isFinite(wk) && wk > week) continue;
    const team = String(r.team || r.team_abbr || "").toUpperCase();
    if (!team) continue;
    const status = String(r.status || r.injury_status || "").toLowerCase();
    const player = r.player || r.player_name || r.gsis_id || "unknown";
    const bucket = status.includes("out") || status.includes("ir") || status.includes("susp") ? "out" :
      status.includes("question") || status.includes("doubt") || status.includes("probable") || status.includes("limited")
        ? "questionable"
        : null;
    if (!bucket) continue;
    if (!out.has(team)) out.set(team, { out: [], questionable: [] });
    out.get(team)[bucket].push(player);
  }
  return out;
}

function buildEloMap(rows, season, week) {
  const map = new Map();
  for (const r of rows || []) {
    if (Number(r.season) !== season) continue;
    const wk = Number(r.week);
    if (!Number.isFinite(wk) || wk !== week) continue;
    const home = String(r.home_team || r.home || "").toUpperCase();
    const away = String(r.away_team || r.away || "").toUpperCase();
    if (!home || !away) continue;
    const key = gameKey(season, wk, home, away);
    const homeE = toNum(r.elo_home ?? r.home_elo ?? r.elo_pre_home ?? r.elo_home_pre);
    const awayE = toNum(r.elo_away ?? r.away_elo ?? r.elo_pre_away ?? r.elo_away_pre);
    const spread = r.spread_home != null ? toNum(r.spread_home) : r.spread != null ? toNum(r.spread) : null;
    map.set(key, {
      home: homeE,
      away: awayE,
      diff: homeE - awayE,
      spread_home: Number.isFinite(spread) ? spread : null
    });
  }
  return map;
}

function buildQBRHistory(rows, season) {
  const map = new Map();
  for (const r of rows || []) {
    if (Number(r.season) !== season) continue;
    const wk = Number(r.week ?? r.game_week ?? r.week_number);
    if (!Number.isFinite(wk)) continue;
    const team = String(r.team || r.team_abbr || r.recent_team || "").toUpperCase();
    if (!team) continue;
    const qbr = toNum(r.qbr_total ?? r.qbr ?? r.total_qbr ?? r.qbr_raw ?? r.espn_qbr ?? r.qbr_offense);
    if (!map.has(team)) map.set(team, []);
    map.get(team).push({ week: wk, qbr });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.week - b.week);
  return map;
}

function latestQBR(entries = [], week) {
  if (!entries.length) return null;
  let val = null;
  for (const entry of entries) {
    if (Number.isFinite(week) && entry.week > week) break;
    val = entry.qbr;
  }
  return val ?? entries.at(-1)?.qbr ?? null;
}

export async function buildContextForWeek(season, week) {
  const y = Number(season);
  const w = Number(week);
  if (!Number.isFinite(y) || !Number.isFinite(w)) return [];

  const schedules = await loadSchedules(y);
  let teamWeekly = [];
  let playerWeekly = [];
  let injuries = [];
  let qbrRows = [];
  let eloRows = [];
  try { teamWeekly = await loadTeamWeekly(y); } catch (err) { console.warn("teamWeekly load failed", err?.message ?? err); }
  try { playerWeekly = await loadPlayerWeekly(y); } catch (err) { console.warn("playerWeekly load failed", err?.message ?? err); }
  try { injuries = await loadInjuries(y); } catch (err) { console.warn("injuries load failed", err?.message ?? err); }
  try { qbrRows = await loadESPNQBR(y); } catch (err) { /* optional */ }
  try { eloRows = await loadElo(y); } catch (err) { console.warn("elo load failed", err?.message ?? err); }

  const games = schedules.filter((g) => Number(g.season) === y && Number(g.week) === w);
  if (!games.length) return [];

  const byTeam = new Map();
  for (const row of teamWeekly || []) {
    if (Number(row.season) !== y) continue;
    const team = String(row.team ?? row.team_abbr ?? row.recent_team ?? row.posteam ?? "").toUpperCase();
    if (!team) continue;
    const wk = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(wk)) continue;
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push({ ...row, _week: wk });
  }

  const qbHistory = buildQBRHistory(qbrRows, y);
  const injuryMap = buildInjuryMap(injuries, y, w);
  const eloMap = buildEloMap(eloRows, y, w);

  for (const [team, rows] of byTeam.entries()) {
    rows.sort((a, b) => a._week - b._week);
    const yardsFor = extractWeeklySeries(rows, ["total_yards", "off_total_yards", "off_total_yds", "yards_gained"], ["off_total_yds_s2d", "total_yards_s2d"]);
    const yardsAgainst = extractWeeklySeries(rows, ["yards_allowed", "total_yards_allowed", "def_total_yards", "def_total_yds"], ["def_total_yds_s2d", "yards_allowed_s2d"]);
    const passYards = extractWeeklySeries(rows, ["passing_yards", "pass_yards", "pass_yds"], ["off_pass_yds_s2d"]);
    const passAtt = extractWeeklySeries(rows, ["pass_attempts", "passing_attempts", "attempts", "pass_att"], ["off_pass_att_s2d"]);
    const sacks = extractWeeklySeries(rows, ["sacks", "sacks_taken", "qb_sacked"], ["off_sacks_taken_s2d"]);

    const ypaSeries = passYards.map((yds, idx) => {
      const yards = toNum(yds, null);
      const attempts = toNum(passAtt[idx], 0);
      if (!Number.isFinite(yards) || attempts <= 0) return null;
      return yards / attempts;
    });
    const sackRateSeries = sacks.map((s, idx) => {
      const sackVal = toNum(s, null);
      const attempts = toNum(passAtt[idx], 0);
      const totalPlays = attempts + toNum(s, 0);
      if (!Number.isFinite(sackVal) || totalPlays <= 0) return null;
      return sackVal / totalPlays;
    });

    const roll3For = rollingAvg(yardsFor, 3);
    const roll5For = rollingAvg(yardsFor, 5);
    const roll3Against = rollingAvg(yardsAgainst, 3);
    const roll5Against = rollingAvg(yardsAgainst, 5);
    const roll3Ypa = rollingAvg(ypaSeries, 3);
    const roll5Ypa = rollingAvg(ypaSeries, 5);
    const roll3Sack = rollingAvg(sackRateSeries, 3);
    const roll5Sack = rollingAvg(sackRateSeries, 5);

    rows.forEach((row, idx) => {
      row._roll3_for = roll3For[idx];
      row._roll5_for = roll5For[idx];
      row._roll3_against = roll3Against[idx];
      row._roll5_against = roll5Against[idx];
      row._roll3_net =
        Number.isFinite(roll3For[idx]) && Number.isFinite(roll3Against[idx])
          ? roll3For[idx] - roll3Against[idx]
          : null;
      row._roll5_net =
        Number.isFinite(roll5For[idx]) && Number.isFinite(roll5Against[idx])
          ? roll5For[idx] - roll5Against[idx]
          : null;
      row._qb_ypa3 = roll3Ypa[idx];
      row._qb_ypa5 = roll5Ypa[idx];
      row._qb_sack3 = roll3Sack[idx];
      row._qb_sack5 = roll5Sack[idx];
    });
  }

  const out = [];
  for (const g of games) {
    const home = String(g.home_team || "").toUpperCase();
    const away = String(g.away_team || "").toUpperCase();
    if (!home || !away) continue;
    const gid = gameKey(y, w, home, away);

    const hRows = byTeam.get(home) || [];
    const aRows = byTeam.get(away) || [];
    const hLast = hRows.filter((r) => r._week <= w).at(-1) ?? hRows.at(-1) ?? {};
    const aLast = aRows.filter((r) => r._week <= w).at(-1) ?? aRows.at(-1) ?? {};

    const roof = String(g.roof ?? g.roof_type ?? "").toLowerCase();
    const surfaceRaw = g.surface ?? g.surface_type ?? g.surface_short ?? null;
    const isDome = roof.includes("dome") || roof.includes("closed") || roof.includes("roof");
    const isOutdoor = roof.includes("outdoor") || roof.includes("open") || (!roof && !isDome);

    const qbrHome = latestQBR(qbHistory.get(home) || [], w);
    const qbrAway = latestQBR(qbHistory.get(away) || [], w);

    const eloInfo = eloMap.get(gid) || null;

    out.push({
      game_id: gid,
      season: y,
      week: w,
      home_team: home,
      away_team: away,
      context: {
        rolling_strength: {
          home: {
            yds_for_3g: hLast._roll3_for ?? null,
            yds_for_5g: hLast._roll5_for ?? null,
            yds_against_3g: hLast._roll3_against ?? null,
            yds_against_5g: hLast._roll5_against ?? null,
            net_yds_3g: hLast._roll3_net ?? null,
            net_yds_5g: hLast._roll5_net ?? null
          },
          away: {
            yds_for_3g: aLast._roll3_for ?? null,
            yds_for_5g: aLast._roll5_for ?? null,
            yds_against_3g: aLast._roll3_against ?? null,
            yds_against_5g: aLast._roll5_against ?? null,
            net_yds_3g: aLast._roll3_net ?? null,
            net_yds_5g: aLast._roll5_net ?? null
          }
        },
        qb_form: {
          home: {
            ypa_3g: hLast._qb_ypa3 ?? null,
            ypa_5g: hLast._qb_ypa5 ?? null,
            sack_rate_3g: hLast._qb_sack3 ?? null,
            sack_rate_5g: hLast._qb_sack5 ?? null,
            qbr: qbrHome
          },
          away: {
            ypa_3g: aLast._qb_ypa3 ?? null,
            ypa_5g: aLast._qb_ypa5 ?? null,
            sack_rate_3g: aLast._qb_sack3 ?? null,
            sack_rate_5g: aLast._qb_sack5 ?? null,
            qbr: qbrAway
          }
        },
        injuries: {
          home_out: injuryMap.get(home)?.out ?? [],
          away_out: injuryMap.get(away)?.out ?? [],
          home_probable: injuryMap.get(home)?.questionable ?? [],
          away_probable: injuryMap.get(away)?.questionable ?? []
        },
        venue: {
          is_dome: isDome,
          is_outdoor: isOutdoor,
          surface: surfaceRaw || null
        },
        elo: eloInfo,
        market: eloInfo && Number.isFinite(eloInfo.spread_home)
          ? { spread_home: eloInfo.spread_home }
          : null
      }
    });
  }

  return out;
}

export default buildContextForWeek;
