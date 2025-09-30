// trainer/contextPack.js
// Builds per-game context for a week: injuries, QB form, rolling team strength, venue, Elo/spread.

import {
  loadSchedules, loadTeamWeekly, loadPlayerWeekly, loadRostersWeekly,
  loadDepthCharts, loadInjuries, loadPFRAdvTeam, loadESPNQBR
} from "./dataSources.js";
import { loadElo } from "./eloLoader.js";

export async function buildContextForWeek(season, week) {
  const [schedAll, teamW, playersW, rostersW, depthW, injuriesW, pfrTeam, qbr, elo] = await Promise.all([
    loadSchedules(),
    loadTeamWeekly(season),
    loadPlayerWeekly(season),
    loadRostersWeekly(season),
    loadDepthCharts(season),
    loadInjuries(season),
    loadPFRAdvTeam(season),
    loadESPNQBR(season),
    loadElo(season)
  ]);

  // Filter schedule rows for the exact week/season
  const sched = schedAll.filter(r => Number(r.season)===season && Number(r.week)===week);
  const teamKey = (t,w)=> `${t}:${season}:${w}`;

  // Index team weekly by (team,week)
  const teamMap = new Map();
  for (const r of teamW) {
    const t = r.team || r.team_abbr || r.posteam || r.recent_team;
    const w = Number(r.week);
    if (!t || !Number.isFinite(w) || Number(r.season)!==season) continue;
    teamMap.set(teamKey(t,w), r);
  }

  // Players: group last 3 games per team for QB form
  const playersByTeam = groupPlayerWeekly(playersW, season);
  // Injuries, depth charts, rosters → star/out lists
  const injuryIndex = indexInjuries(injuriesW, season, week);
  const startersIdx  = indexStarters(depthW, rostersW, season, week);
  // ESPN QBR indexed by team (some CSVs have team or player_id)
  const qbrByTeam = indexQBR(qbr, season);

  // Elo by game_id
  const eloByGame = indexElo(elo, season);

  const out = [];
  for (const g of sched) {
    const home = g.home_team, away = g.away_team;
    const homeKey = (home || "").toUpperCase();
    const awayKey = (away || "").toUpperCase();
    const game_id = `${season}-W${String(week).padStart(2,"0")}-${home}-${away}`;

    const rsHome = rollingTeamStrength(teamMap, home, season, week, 3);
    const rsAway = rollingTeamStrength(teamMap, away, season, week, 3);

    const qbHome = qbForm(playersByTeam[home]?.last3, qbrByTeam[homeKey]);
    const qbAway = qbForm(playersByTeam[away]?.last3, qbrByTeam[awayKey]);

    const injHome = injuryIndex.get(homeKey) || { out:[], probable:[] };
    const injAway = injuryIndex.get(awayKey) || { out:[], probable:[] };

    // mark starters as star=true for impact
    markStarters(injHome, startersIdx.get(homeKey));
    markStarters(injAway, startersIdx.get(awayKey));

    const roof = (g.roof || g.roof_type || "").toLowerCase();
    const surfaceSrc = (g.surface || g.surface_short || "").toLowerCase();
    const surface = surfaceSrc.includes("turf") ? "turf" : surfaceSrc.includes("grass") ? "grass" : "unknown";
    const is_dome = /dome|closed/.test(roof);
    const is_outdoor = /outdoor|open/.test(roof);

    const eloG = eloByGame.get(game_id) || null;

    out.push({
      game_id, season, week, home_team: home, away_team: away,
      context: {
        injuries: {
          home_out: injHome.out,
          away_out: injAway.out,
          home_probable: injHome.probable,
          away_probable: injAway.probable
        },
        qb_form: { home: qbHome, away: qbAway },
        rolling_strength: { home: rsHome, away: rsAway },
        venue: { is_dome, is_outdoor, surface },
        elo: eloG ? { home: eloG.home, away: eloG.away, diff: eloG.diff, spread_home: eloG.spread_home ?? null } : null,
        market: eloG && Number.isFinite(eloG.spread_home) ? { spread_home: eloG.spread_home } : null
      }
    });
  }
  return out;
}

// ---- helpers ---------------------------------------------------------------

function groupPlayerWeekly(rows, season) {
  const byTeam = {};
  for (const r of rows) {
    if (Number(r.season)!==season) continue;
    const t = r.team || r.recent_team || r.team_abbr; if (!t) continue;
    (byTeam[t] ||= []).push(r);
  }
  const out = {};
  for (const [t, arr] of Object.entries(byTeam)) {
    arr.sort((a,b)=> Number(a.week)-Number(b.week));
    const qbs = arr.filter(x => (x.position||x.pos||"").toUpperCase()==="QB");
    out[t] = { last3: qbs.slice(-3) };
  }
  return out;
}

function qbForm(last3, qbrTeam) {
  // Primary: last-3 YPA & sack rate; augment with QBR if available
  if (!last3 || !last3.length) return { ypa_3g: 0, sack_rate_3g: 0, qbr: qbrTeam ?? null };
  let att=0, yds=0, sacks=0, dropbacks=0;
  for (const r of last3) {
    const pa = Number(r.pass_attempts || r.attempts || r.c_att || 0);
    const y = Number(r.passing_yards || r.pass_yds || r.yards || 0);
    const sk = Number(r.sacks || r.sacks_taken || 0);
    att+=pa; yds+=y; sacks+=sk; dropbacks+=(pa+sk);
  }
  const ypa = att? yds/att : 0;
  const sr = dropbacks? sacks/dropbacks : 0;
  return { ypa_3g: round4(ypa), sack_rate_3g: round4(sr), qbr: qbrTeam ?? null };
}

function rollingTeamStrength(teamMap, team, season, week, k) {
  const rows=[]; for (let w=week-1; w>=1 && rows.length<k; w--) {
    const r = teamMap.get(`${team}:${season}:${w}`); if (r) rows.push(r);
  }
  let yfor=0, yagainst=0;
  for (const r of rows) {
    yfor += Number(r.total_yards || r.off_total_yards || r.off_total_yds || 0);
    yagainst += Number(r.total_yards_allowed || r.def_total_yards || r.def_total_yds || 0);
  }
  return { yds_for_3g:yfor, yds_against_3g:yagainst, net_yds_3g:yfor-yagainst };
}

function indexElo(rows, season) {
  const m = new Map();
  for (const r of rows) {
    if (Number(r.season)!==season) continue;
    const home = r.home_team || r.home, away = r.away_team || r.away, week = Number(r.week);
    if (!home||!away||!week) continue;
    const game_id = `${season}-W${String(week).padStart(2,"0")}-${home}-${away}`;
    const homeE = Number(r.elo_home || r.home_elo || r.elo_pre_home || 0);
    const awayE = Number(r.elo_away || r.away_elo || r.elo_pre_away || 0);
    const diff = homeE - awayE;
    const spread_home = (r.spread_home!=null) ? Number(r.spread_home) :
                        (r.spread!=null) ? Number(r.spread) : null;
    m.set(game_id, { home: homeE, away: awayE, diff, ...(Number.isFinite(spread_home)?{spread_home}: {}) });
  }
  return m;
}

function indexQBR(rows, season) {
  // Many QBR tables have columns like season, team, qbr_total or qbr
  const out = {};
  for (const r of rows) {
    if (Number(r.season)!==season) continue;
    const t = (r.team || r.team_abbr || "").toUpperCase(); if (!t) continue;
    const qbr = Number(r.qbr_total || r.qbr || r.total_qbr || 0);
    if (!Number.isFinite(qbr)) continue;
    // Keep latest entry or max
    out[t] = qbr;
  }
  return out;
}

function indexInjuries(rows, season, week) {
  // Expect columns like season, week, team, player, position, status
  const key = t => `${t}`;
  const out = new Map();
  const OUT_STATI = new Set(["OUT","IR","PUP","SUSP","RESERVED"]);
  const PRB_STATI = new Set(["QUESTIONABLE","DOUBTFUL","PROBABLE","LIMITED"]);

  for (const r of rows) {
    if (Number(r.season)!==season) continue;
    const w = Number(r.week); if (!Number.isFinite(w) || w>week) continue;
    const team = (r.team || r.team_abbr || "").toUpperCase(); if (!team) continue;
    const status = (r.status || r.injury_status || "").toUpperCase();
    const pos = (r.position || r.pos || "").toUpperCase();
    const player = r.player || r.player_name || r.gsis_id || "unknown";
    const row = { player, pos, note: status, star: false };

    const bucket = (OUT_STATI.has(status) || status==="DNP") ? "out" :
                   PRB_STATI.has(status) ? "probable" : null;
    if (!bucket) continue;
    const v = out.get(key(team)) || { out:[], probable:[] };
    v[bucket].push(row);
    out.set(key(team), v);
  }
  return out;
}

function indexStarters(depthCharts, rosters, season, week) {
  // Very light starter index: depth_charts with depth==1 at this week, fallback to roster starters if present
  const starters = new Map(); // key: team -> Set of player names
  const byTeam = new Map();

  for (const r of depthCharts) {
    if (Number(r.season)!==season) continue;
    const w = Number(r.week); if (!Number.isFinite(w) || w>week) continue;
    const team = (r.team || r.team_abbr || "").toUpperCase(); if (!team) continue;
    const depth = Number(r.depth || r.player_depth || 0);
    const player = r.player || r.player_name || r.gsis_id || "";
    if (depth === 1 && player) {
      (byTeam.get(team) || byTeam.set(team, new Set()).get(team)).add(player);
    }
  }
  // fallback: rosters weekly (starter flag sometimes provided)
  for (const r of rosters) {
    if (Number(r.season)!==season) continue;
    const w = Number(r.week); if (!Number.isFinite(w) || w>week) continue;
    const team = (r.team || r.team_abbr || r.recent_team || "").toUpperCase(); if (!team) continue;
    const player = r.player || r.player_name || r.gsis_id || "";
    const starter = (String(r.starter || r.depth || "").toLowerCase()==="true" || String(r.depth||"")==="1");
    if (starter && player) {
      (byTeam.get(team) || byTeam.set(team, new Set()).get(team)).add(player);
    }
  }
  // finalize
  for (const [t,set] of byTeam.entries()) starters.set(t, Array.from(set));
  return starters;
}

function markStarters(injBucket, startersArray) {
  if (!injBucket || !startersArray) return;
  const starters = new Set(startersArray.map(s=>String(s).toLowerCase()));
  for (const k of ["out","probable"]) {
    for (const p of injBucket[k] || []) {
      const nm = String(p.player||"").toLowerCase();
      if (starters.has(nm) || p.pos === "QB") p.star = true;
    }
  }
}

function round4(x){ return Math.round(x*1e4)/1e4; }
