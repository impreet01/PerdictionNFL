// scripts/resolveWeek.js
// Prints the target NFL regular-season week number to STDOUT (just the number).
// Logic: choose first REG week that is not fully scored; if all scored, choose the last.
// Floor result to >= 2 (we don't predict Week 1, but we DO ingest Week 1 as training).
//
// Usage in GH Action step:
//   WEEK=$(node scripts/resolveWeek.js)
//   echo "week=$WEEK" >> "$GITHUB_OUTPUT"

import axios from "axios";
import Papa from "papaparse";

const SCHEDULES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

function inferSeason() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1..12
  // Jan/Feb belong to previous NFL season
  return m <= 2 ? y - 1 : y;
}

function parseCSV(text) {
  const { data } = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  return data;
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function hasScore(row) {
  const hs = row.home_score ?? row.home_points ?? row.home_pts ?? null;
  const as = row.away_score ?? row.away_points ?? row.away_pts ?? null;
  const h = toInt(hs);
  const a = toInt(as);
  return Number.isFinite(h) && Number.isFinite(a);
}

(async () => {
  try {
    const season = Number(process.env.SEASON || inferSeason());
    const text = await axios.get(SCHEDULES_URL, { responseType: "text" }).then(r => r.data);
    const rows = parseCSV(text).filter(
      r => Number(r.season) === season && String(r.season_type).toUpperCase() === "REG"
    );

    const weeks = [...new Set(rows.map(r => Number(r.week)).filter(w => Number.isFinite(w)))].sort((a,b)=>a-b);

    let chosen;
    if (weeks.length === 0) {
      chosen = 2; // default
    } else {
      chosen = null;
      for (const w of weeks) {
        const games = rows.filter(r => Number(r.week) === w);
        const allScored = games.every(hasScore);
        if (!allScored) { chosen = w; break; } // upcoming/in-progress
      }
      if (chosen == null) chosen = weeks[weeks.length - 1]; // all finished
      if (chosen < 2) chosen = 2; // floor
    }

    // PRINT JUST THE NUMBER
    process.stdout.write(String(chosen));
  } catch (_e) {
    // On any error, print a sane default (2)
    process.stdout.write("2");
  }
})();
