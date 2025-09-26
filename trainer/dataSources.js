// trainer/dataSources.js
// Downloads nflverse schedules and team weekly stats (CSV) for a given season.

import axios from "axios";
import Papa from "papaparse";

const NFLVERSE_RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const STATS_TEAM_TAG = "stats_team"; // team weekly stats bundle
const SCHEDULES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

/** Fetch and parse CSV into array of objects */
async function fetchCSV(url) {
  const { data } = await axios.get(url, { responseType: "text" });
  const parsed = Papa.parse(data, { header: true, dynamicTyping: true, skipEmptyLines: true });
  return parsed.data;
}

/** Load schedules (all seasons) then filter by caller */
export async function loadSchedules() {
  // Contains: season, week, season_type (REG/POST), game_id, home_team, away_team, etc.
  return await fetchCSV(SCHEDULES_URL);
}

/** Load team weekly stats for a season from nflverse-data release (CSV preferred) */
export async function loadTeamWeekly(season) {
  // Try CSV first
  const csvUrl = `${NFLVERSE_RELEASE}/${STATS_TEAM_TAG}/team_stats_week_${season}.csv`;
  try {
    const rows = await fetchCSV(csvUrl);
    if (rows?.length) return rows;
  } catch (e) {
    // Fallback could handle .csv.gz or parquet if needed
    throw new Error(`Could not fetch team weekly stats CSV for ${season}: ${e.message}`);
  }
}