// trainer/eloLoader.js
// Loads Elo-like ratings (diff & spread if present) with safe fallbacks.

import { loadSchedules } from "./dataSources.js"; // not strictly required here

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "nfl-wins/1.0 (+actions)" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}
function parseCsvLoose(txt){
  const lines = txt.trim().split(/\r?\n/); if(!lines.length) return [];
  const h = lines[0].split(",");
  return lines.slice(1).map(l=>{
    const c=l.split(","); const o={};
    for (let i=0;i<h.length;i++) o[h[i]]=c[i]??"";
    return o;
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
