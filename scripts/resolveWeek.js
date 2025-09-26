// scripts/resolveWeek.js
import axios from "axios";
import Papa from "papaparse";

const SCHEDULES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

function inferSeason() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
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
      chosen = 2;
    } else {
      chosen = null;
      for (const w of weeks) {
        const games = rows.filter(r => Number(r.week) === w);
        const allScored = games.every(hasScore);
        if (!allScored) { chosen = w; break; }
      }
      if (chosen == null) chosen = weeks[weeks.length - 1];
      if (chosen < 2) chosen = 2;
    }

    process.stdout.write(String(chosen));
  } catch (_e) {
    process.stdout.write("2");
  }
})();
