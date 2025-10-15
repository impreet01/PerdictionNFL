// trainer/eloLoader.js
// Loads Elo-like ratings (diff & spread if present) with safe fallbacks.

import { loadSchedules } from "./dataSources.js"; // not strictly required here

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "nfl-wins/1.0 (+actions)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}
function parseCsvLoose(txt) {
  const cleaned = txt.trim();
  if (!cleaned) return [];
  const lines = cleaned.split(/\r?\n/);
  if (!lines.length) return [];
  const delimiter = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const headers = lines[0].split(delimiter).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(delimiter);
    const entry = {};
    for (let i = 0; i < headers.length; i += 1) {
      entry[headers[i]] = cells[i]?.trim() ?? "";
    }
    return entry;
  });
}

export async function loadElo(season) {
  const y = Number(season);
  const C = [
    `https://raw.githubusercontent.com/nflverse/nflverse-data/main/data/elo/elo_${y}.csv`,
    `https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/elo/elo_${y}.csv`
  ];
  for (const url of C) {
    try { const txt = await fetchText(url); return parseCsvLoose(txt); }
    catch {}
  }
  return [];
}
