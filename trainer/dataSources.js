// trainer/dataSources.js
// Robust, URL-tolerant loaders for nflverse datasets via GitHub Releases first.
// ESM module. Node 18+ global fetch is available.

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
function log(level, ...args) {
  const rank = { silent:0, warn:1, info:2, debug:3 }[LOG_LEVEL] ?? 2;
  const need = { warn:1, info:2, debug:3 }[level] ?? 2;
  if (need <= rank) console[level === "warn" ? "warn" : "log"](...args);
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "nfl-wins-free-stack/1.0 (+actions)" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function tryFirst(urls) {
  for (const url of urls) {
    try {
      const txt = await fetchText(url);
      log("info", `OK ${url}`);
      return txt;
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("HTTP 404")) {
        log("debug", `404 ${url}`);
        continue;
      }
      log("warn", `warn: ${msg}`);
      continue;
    }
  }
  return null;
}

function parseCsvLoose(txt) {
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map(line => {
    const cols = line.split(",");
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cols[i] ?? "";
    return obj;
  });
}

function currentYear() {
  const now = new Date();
  return now.getUTCFullYear();
}

// ---- PUBLIC LOADERS ----

// Schedules/games (stable in repo tree)
export async function loadSchedules() {
  const CANDIDATES = [
    "https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/games.csv",
    "https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/games.csv"
  ];
  const txt = await tryFirst(CANDIDATES);
  if (!txt) throw new Error("Could not load schedules (games.csv) from nflverse-data");
  return parseCsvLoose(txt);
}

// Team weekly summary stats (primary features) — use Releases first
export async function loadTeamWeekly(season) {
  const s = Number(season || currentYear());
  const CANDIDATES = [
    // Releases (preferred)
    `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${s}.csv`,
    // Raw repo fallbacks (older mirrors)
    `https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/team_week_stats/stats_team_week_${s}.csv`,
    `https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/team_week_stats/stats_team_week_${s}.csv`,
    `https://raw.githubusercontent.com/nflverse/nflfastR-data/master/team_stats/team_stats_${s}.csv`
  ];
  const txt = await tryFirst(CANDIDATES);
  if (!txt) throw new Error(`Could not load team weekly stats for ${s}`);
  return parseCsvLoose(txt);
}

// Player weekly summary stats (optional enrichments) — Releases first
export async function loadPlayerWeekly(season) {
  const s = Number(season || currentYear());
  const CANDIDATES = [
    `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${s}.csv`,
    // older/alternate mirrors
    `https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/player_stats/player_stats_${s}.csv`,
    `https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/player_stats/player_stats_${s}.csv`
  ];
  const txt = await tryFirst(CANDIDATES);
  if (!txt) {
    log("warn", `loadPlayerWeekly(${s}) → [] (no asset yet)`);
    return [];
  }
  return parseCsvLoose(txt);
}

// Team-game advanced (optional; varies by year) — keep tolerant
export async function loadTeamGameAdvanced(season) {
  const s = Number(season || currentYear());
  const CANDIDATES = [
    // If nflverse later publishes as a release, add here:
    // `https://github.com/nflverse/nflverse-data/releases/download/team_game/team_game_${s}.csv`,
    // Raw mirrors commonly seen:
    `https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/team_game/team_game_${s}.csv`,
    `https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/team_game/team_games_${s}.csv`,
    `https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/team_game/team_game_${s}.csv`,
    `https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/team_game/team_games_${s}.csv`
  ];
  const txt = await tryFirst(CANDIDATES);
  if (!txt) {
    log("warn", `loadTeamGameAdvanced(${s}) → []`);
    return [];
  }
  return parseCsvLoose(txt);
}

// Play-by-play CSV (optional: used only if you plan to parse aggregate features)
export async function loadPBP(season) {
  const s = Number(season || currentYear());
  const CANDIDATES = [
    `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${s}.csv.gz`
  ];
  const txt = await tryFirst(CANDIDATES);
  if (!txt) {
    log("warn", `loadPBP(${s}) → []`);
    return [];
  }
  // We’re returning raw CSV text right now; add a gzip step if needed.
  return parseCsvLoose(txt);
}
