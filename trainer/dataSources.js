// trainer/dataSources.js
// Robust nflverse loaders with multi-URL fallbacks and helpful logging.

import axios from "axios";
import zlib from "zlib";
import { parse } from "csv-parse/sync";

/**
 * Small helper: GET a URL that could be .csv or .csv.gz and return rows.
 */
async function fetchCsvFlexible(url) {
  const tryUrls = [url, url.endsWith(".gz") ? url.slice(0, -3) : url + ".gz"];
  const errs = [];
  for (const u of tryUrls) {
    try {
      const resp = await axios.get(u, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent": "nfl-wins-free-stack/1.0",
          "Accept-Encoding": "gzip,deflate,br",
          "Accept": "text/csv,application/octet-stream,*/*"
        },
        timeout: 30000
      });
      let buf = Buffer.from(resp.data);
      // If gzipped, attempt decompress; if not, parse as-is.
      if (u.endsWith(".gz") || (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
        try {
          buf = zlib.gunzipSync(buf);
        } catch {
          // If gunzip fails we’ll try to parse raw; continue.
        }
      }
      const text = buf.toString("utf8");
      const records = parse(text, {
        columns: true,
        skip_empty_lines: true
      });
      return { rows: records, source: u };
    } catch (e) {
      errs.push(`${u}: ${e?.response?.status || e.code || e.message}`);
    }
  }
  const err = new Error(`fetchCsvFlexible: all attempts failed:\n  - ${errs.join("\n  - ")}`);
  err._attempts = errs;
  throw err;
}

/**
 * Coerce known numeric fields.
 */
function toInt(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function coerceScheduleRow(r) {
  // nflreadr dictionary for schedules: season, week, gameday/game_time_utc, home_team, away_team, etc.
  // We’ll be permissive: accept either schedules.csv (nflverse-data) or games.csv (nfldata) field names.
  return {
    season: toInt(r.season ?? r.year ?? r.Season),
    week: toInt(r.week ?? r.Week),
    game_id: r.game_id ?? r.gsis ?? r.game_id_pfr ?? r.gameday ?? null,
    gameday: r.gameday ?? r.gametime ?? r.game_date ?? r.game_date_full ?? null,
    game_time_utc: r.game_time_utc ?? r.game_time_eastern ?? r.start_time ?? null,
    home_team: r.home_team ?? r.home ?? r.home_team_abbr ?? r.team_home ?? null,
    away_team: r.away_team ?? r.away ?? r.away_team_abbr ?? r.team_away ?? null,
    home_score: toInt(r.home_score ?? r.score_home ?? r.home_points),
    away_score: toInt(r.away_score ?? r.score_away ?? r.away_points),
    game_type: r.game_type ?? r.season_type ?? r.seasontype ?? null,
    week_type: r.week_type ?? null,
    stadium: r.stadium ?? r.venue ?? null,
    roof: r.roof ?? null,
    surface: r.surface ?? null,
    result_posted: r.result_posted ?? (r.home_score != null && r.away_score != null ? 1 : 0)
  };
}

/**
 * ---- Schedules ----
 * Try official nflverse-data release first, then nfldata fallback.
 * References:
 * - nflverse release URL pattern example (rosters): /releases/download/rosters/roster_2020.csv  (we mirror this for schedules)  [oai_citation:2‡NFLReadr](https://nflreadr.nflverse.com/reference/load_from_url.html?utm_source=chatgpt.com)
 * - nfldata hosts a canonical games table at /data/games.csv (community reference)  [oai_citation:3‡Reddit](https://www.reddit.com/r/NFLstatheads/comments/10ndzap/is_there_a_database_of_nfl_box_score_over_the/?utm_source=chatgpt.com)
 */
export async function loadSchedules(season) {
  const baseRel = "https://github.com/nflverse/nflverse-data/releases/download";
  const releaseCandidates = [
    `${baseRel}/schedules/schedules.csv`,
    `${baseRel}/schedules/schedules_${season}.csv`
  ];

  const fallbacks = [
    // Lee Sharpe’s canonical table in nfldata:
    "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
  ];

  const tried = [];
  // 1) Try releases first
  for (const u of releaseCandidates) {
    try {
      const { rows, source } = await fetchCsvFlexible(u);
      const out = rows
        .map(coerceScheduleRow)
        .filter(r => r.season === toInt(season));
      if (out.length) {
        console.log(`[loadSchedules] OK from release asset: ${source} (kept ${out.length} rows for ${season})`);
        return out;
      }
      tried.push(`${u} (no rows for season ${season})`);
    } catch (e) {
      tried.push(`${u} (err: ${e.message.split("\n")[0]})`);
    }
  }

  // 2) Try nfldata/games.csv fallback
  for (const u of fallbacks) {
    try {
      const { rows, source } = await fetchCsvFlexible(u);
      const out = rows
        .map(coerceScheduleRow)
        .filter(r => r.season === toInt(season));
      if (out.length) {
        console.log(`[loadSchedules] OK from fallback: ${source} (kept ${out.length} rows for ${season})`);
        return out;
      }
      tried.push(`${u} (no rows for season ${season})`);
    } catch (e) {
      tried.push(`${u} (err: ${e.message.split("\n")[0]})`);
    }
  }

  const msg = `Could not load schedules for ${season}. Tried:\n  - ${tried.join("\n  - ")}`;
  throw new Error(msg);
}

/**
 * ---- Team weekly stats (Sharpe team summary from nflverse-data: stats_team) ----
 * We’ll keep your current working URL, but accept CSV or CSV.GZ and support both
 * the “all-seasons single file” and “per-season” patterns.
 */
export async function loadTeamWeekly(season) {
  const baseRel = "https://github.com/nflverse/nflverse-data/releases/download";
  const candidates = [
    `${baseRel}/stats_team/stats_team_week_${season}.csv`,
    `${baseRel}/stats_team/stats_team_week_${season}.csv.gz`,
    // Historical (single table across seasons) sometimes appears as “stats_team_week.csv”
    `${baseRel}/stats_team/stats_team_week.csv`,
    `${baseRel}/stats_team/stats_team_week.csv.gz`
  ];
  const tried = [];
  for (const u of candidates) {
    try {
      const { rows, source } = await fetchCsvFlexible(u);
      const filtered = rows.filter(r => toInt(r.season) === toInt(season));
      const out = filtered.length ? filtered : rows;
      console.log(`[loadTeamWeekly] OK from ${source}, rows=${out.length}`);
      return out;
    } catch (e) {
      tried.push(`${u} (err: ${e.message.split("\n")[0]})`);
    }
  }
  throw new Error(`Could not load team weekly stats for ${season}. Tried:\n  - ${tried.join("\n  - ")}`);
}

/**
 * ---- Player weekly summary (stats_player) ----
 */
export async function loadPlayerWeekly(season) {
  const baseRel = "https://github.com/nflverse/nflverse-data/releases/download";
  const candidates = [
    `${baseRel}/stats_player/stats_player_week_${season}.csv`,
    `${baseRel}/stats_player/stats_player_week_${season}.csv.gz`,
    `${baseRel}/stats_player/stats_player_week.csv`,
    `${baseRel}/stats_player/stats_player_week.csv.gz`
  ];
  const tried = [];
  for (const u of candidates) {
    try {
      const { rows, source } = await fetchCsvFlexible(u);
      const filtered = rows.filter(r => toInt(r.season) === toInt(season));
      const out = filtered.length ? filtered : rows;
      console.log(`[loadPlayerWeekly] OK from ${source}, rows=${out.length}`);
      return out;
    } catch (e) {
      tried.push(`${u} (err: ${e.message.split("\n")[0]})`);
    }
  }
  console.warn(`[loadPlayerWeekly] fell back to empty dataset. Tried:\n  - ${tried.join("\n  - ")}`);
  return [];
}

/**
 * ---- Team per-game advanced (nflfastR calculated stats_team, by game) ----
 * Some builds expose “stats_team_game_{season}.csv”; accept that if present.
 */
export async function loadTeamGameAdvanced(season) {
  const baseRel = "https://github.com/nflverse/nflverse-data/releases/download";
  const candidates = [
    `${baseRel}/stats_team/stats_team_game_${season}.csv`,
    `${baseRel}/stats_team/stats_team_game_${season}.csv.gz`,
    `${baseRel}/stats_team/stats_team_game.csv`,
    `${baseRel}/stats_team/stats_team_game.csv.gz`
  ];
  const tried = [];
  for (const u of candidates) {
    try {
      const { rows, source } = await fetchCsvFlexible(u);
      const filtered = rows.filter(r => toInt(r.season) === toInt(season));
      const out = filtered.length ? filtered : rows;
      console.log(`[loadTeamGameAdvanced] OK from ${source}, rows=${out.length}`);
      return out;
    } catch (e) {
      tried.push(`${u} (err: ${e.message.split("\n")[0]})`);
    }
  }
  console.warn(`[loadTeamGameAdvanced] fell back to empty dataset. Tried:\n  - ${tried.join("\n  - ")}`);
  return [];
}

/**
 * ---- Elo / ratings (if you wired these earlier) ----
 * Keep as no-op or plug your sources; left here for completeness.
 */
export async function loadEloLikeRatings(season) {
  return []; // optional hook
}