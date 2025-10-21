import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactsRoot } from '../trainer/utils/paths.js';

const ROTOWIRE_ENABLED = process.env.ROTOWIRE_ENABLED === 'true';

if (!ROTOWIRE_ENABLED) {
  console.log('[fetchRotowireInjuries] ROTOWIRE_ENABLED !== "true"; skipping fetch.');
  process.exit(0);
}

const TEAM_CODES = [
  'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE',
  'DAL','DEN','DET','GB','HOU','IND','JAX','KC',
  'LAC','LAR','LV','MIA','MIN','NE','NO','NYG',
  'NYJ','PHI','PIT','SF','SEA','TB','TEN','WAS'
];

const argv = process.argv.slice(2);
const cliOptions = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith('--')) {
    const [key, rawVal] = arg.split('=');
    if (rawVal !== undefined) cliOptions[key.slice(2)] = rawVal;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      cliOptions[key.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      cliOptions[key.slice(2)] = true;
    }
  }
}

const now = new Date();
const season = Number.parseInt(cliOptions.season ?? now.getUTCFullYear(), 10);
if (!Number.isFinite(season)) {
  console.error('[fetchRotowireInjuries] Invalid --season');
  process.exit(1);
}
const week = Number.parseInt(cliOptions.week ?? cliOptions.w ?? cliOptions.gameweek ?? 0, 10);
if (!Number.isFinite(week) || week <= 0) {
  console.error('[fetchRotowireInjuries] Provide --week (1-22).');
  process.exit(1);
}

const fetchedAt = new Date().toISOString();
const artifactsDir = path.resolve(process.cwd(), artifactsRoot());

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTable(html, meta) {
  const rows = [];
  if (!html) return rows;
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableHtml = null;
  let tMatch;
  while ((tMatch = tableRegex.exec(html)) !== null) {
    const chunk = tMatch[0];
    if (/Player/i.test(chunk) && /Status/i.test(chunk)) {
      tableHtml = chunk;
      break;
    }
  }
  if (!tableHtml) return rows;
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRegex.exec(tableHtml)) !== null) {
    const rowHtml = m[1];
    if (/<th/i.test(rowHtml)) continue;
    const cellMatches = Array.from(rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi));
    if (!cellMatches.length) continue;
    const cells = cellMatches.map((c) => cleanText(c[1]));
    const [player, position, injury, status, practice, notes] = cells;
    if (!player) continue;
    rows.push({
      team: meta.team,
      season: meta.season,
      week: meta.week,
      player,
      position: position || null,
      status: status || null,
      injury: injury || null,
      practice: practice || null,
      notes: notes || null,
      fetched_at: meta.fetchedAt,
      source: 'rotowire'
    });
  }
  return rows;
}

function parseGrid(html, meta) {
  const rows = [];
  if (!html) return rows;
  const gridRegex = /<div[^>]*role=["']grid["'][^>]*>([\s\S]*?)<\/div>/gi;
  let gMatch;
  while ((gMatch = gridRegex.exec(html)) !== null) {
    const gridHtml = gMatch[1];
    if (!/Player/i.test(gridHtml) || !/Status/i.test(gridHtml)) continue;
    const rowRegex = /<div[^>]*role=["']row["'][^>]*>([\s\S]*?)<\/div>/gi;
    let rMatch;
    while ((rMatch = rowRegex.exec(gridHtml)) !== null) {
      const rowHtml = rMatch[1];
      if (/role=["']columnheader["']/i.test(rowHtml)) continue;
      const cellMatches = Array.from(
        rowHtml.matchAll(/<(?:div|span)[^>]*role=["']gridcell["'][^>]*>([\s\S]*?)<\/(?:div|span)>/gi)
      );
      if (!cellMatches.length) continue;
      const cells = cellMatches.map((c) => cleanText(c[1])).filter((txt) => txt);
      if (!cells.length) continue;
      const [player, position, injury, status, practice, notes] = cells;
      if (!player || /player/i.test(player)) continue;
      rows.push({
        team: meta.team,
        season: meta.season,
        week: meta.week,
        player,
        position: position || null,
        status: status || null,
        injury: injury || null,
        practice: practice || null,
        notes: notes || null,
        fetched_at: meta.fetchedAt,
        source: 'rotowire'
      });
    }
  }
  return rows;
}

function pickString(...values) {
  for (const val of values) {
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

function pickDefined(...values) {
  for (const val of values) {
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}

function parseSeasonNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const firstYearMatch = trimmed.match(/(20\d{2})/);
    if (firstYearMatch) {
      const parsed = Number.parseInt(firstYearMatch[1], 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

const TEAM_ABBR_MAP = new Map([
  ['ARZ', 'ARI'],
  ['JAC', 'JAX'],
  ['KAN', 'KC'],
  ['KCC', 'KC'],
  ['SD', 'LAC'],
  ['SDG', 'LAC'],
  ['STL', 'LAR'],
  ['LA', 'LAR'],
  ['OAK', 'LV'],
  ['WSH', 'WAS'],
  ['WDC', 'WAS'],
  ['TAM', 'TB'],
  ['NOR', 'NO'],
  ['GNB', 'GB'],
  ['SFO', 'SF'],
  ['NWE', 'NE'],
  ['NJD', 'NYJ'],
  ['NYA', 'NYJ'],
  ['NYN', 'NYG']
]);

function normalizeTeam(value) {
  if (!value) return null;
  const cleaned = value.toString().trim().toUpperCase();
  const mapped = TEAM_ABBR_MAP.get(cleaned);
  if (mapped) return mapped;
  if (TEAM_CODES.includes(cleaned)) return cleaned;
  if (cleaned.length >= 3) {
    const short = cleaned.slice(0, 3);
    const shortMapped = TEAM_ABBR_MAP.get(short) || short;
    if (TEAM_CODES.includes(shortMapped)) return shortMapped;
  }
  return null;
}

function createJsonCollector(meta) {
  const rows = [];
  const seen = new Set();

  function maybePush(obj) {
    if (!obj || typeof obj !== 'object') return;
    const teamCandidate = pickString(
      obj.team,
      obj.teamAbbr,
      obj.team_abbr,
      obj.teamAbbrev,
      obj.teamCode,
      obj.team_code,
      obj.team,
      obj.teamShort,
      obj.teamShortName,
      obj.team_short,
      obj.club,
      obj.clubcode
    );
    const normalizedTeam = normalizeTeam(teamCandidate);
    if (normalizedTeam && normalizedTeam !== meta.team) return;

    const seasonCandidate = pickDefined(
      obj.season,
      obj.seasonYear,
      obj.season_year,
      obj.seasonId,
      obj.season_id,
      obj.seasonCode,
      obj.season_code,
      obj.year,
      obj.gameSeason,
      obj.seasonDisplay,
      obj.season_display
    );
    const normalizedSeason = parseSeasonNumber(seasonCandidate);
    if (normalizedSeason !== null && normalizedSeason !== meta.season) return;

    const player = pickString(obj.player, obj.playerName, obj.name, obj.fullName, obj.displayName);
    if (!player) return;

    const position = pickString(obj.position, obj.pos, obj.positionAbbr, obj.position_abbr);
    const status = pickString(
      obj.status,
      obj.gameStatus,
      obj.statusShort,
      obj.statusText,
      obj.injuryStatus,
      obj.status_label
    );
    const injury = pickString(obj.injury, obj.injuryDetail, obj.injury_desc, obj.injuryType, obj.bodyPart);
    const practice = pickString(
      obj.practice,
      obj.practiceStatus,
      obj.practiceParticipation,
      obj.practiceText,
      obj.practice_status
    );
    const notes = pickString(obj.notes, obj.note, obj.report, obj.analysis, obj.comment, obj.outlook);

    if (!(status || injury || practice || notes)) return;

    const key = `${player}|${status || ''}|${injury || ''}|${practice || ''}|${notes || ''}`;
    if (seen.has(key)) return;
    seen.add(key);

    rows.push({
      team: meta.team,
      season: meta.season,
      week: meta.week,
      player,
      position: position || null,
      status: status || null,
      injury: injury || null,
      practice: practice || null,
      notes: notes || null,
      fetched_at: meta.fetchedAt,
      source: 'rotowire'
    });
  }

  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object') {
      maybePush(node);
      for (const value of Object.values(node)) walk(value);
    }
  }

  return { rows, walk };
}

function parseEmbeddedJson(html, meta) {
  const { rows, walk } = createJsonCollector(meta);

  const jsonScriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonScriptRegex.exec(html)) !== null) {
    const raw = match[1];
    try {
      const parsed = JSON.parse(raw);
      walk(parsed);
    } catch (err) {
      // ignore parse issues for unrelated JSON blobs
    }
  }

  const nextDataMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const parsed = JSON.parse(nextDataMatch[1]);
      walk(parsed);
    } catch (err) {
      // ignore
    }
  }

  const nuxtMatch = html.match(/window\.__NUXT__=({[\s\S]*?});/);
  if (nuxtMatch) {
    try {
      const parsed = JSON.parse(nuxtMatch[1]);
      walk(parsed);
    } catch (err) {
      // ignore
    }
  }

  return rows;
}

function parseEmbeddedJsonObject(payload, meta) {
  const { rows, walk } = createJsonCollector(meta);
  walk(payload);
  return rows;
}

function extractRows(html, meta) {
  if (!html) return [];
  const tableRows = parseTable(html, meta);
  if (tableRows.length) return tableRows;

  const gridRows = parseGrid(html, meta);
  if (gridRows.length) return gridRows;

  return parseEmbeddedJson(html, meta);
}

async function fetchTeamReport(team) {
  const url = new URL('https://www.rotowire.com/football/tables/injury-report.php');
  url.searchParams.set('team', team);
  url.searchParams.set('pos', 'ALL');
  url.searchParams.set('season', String(season));
  url.searchParams.set('week', String(week));

  const attempts = [url];

  const ajaxUrl = new URL(url);
  ajaxUrl.searchParams.set('type', 'ajax');
  attempts.push(ajaxUrl);

  const legacyAjaxUrl = new URL(url);
  legacyAjaxUrl.searchParams.set('ajax', '1');
  attempts.push(legacyAjaxUrl);

  for (const attemptUrl of attempts) {
    const res = await fetch(attemptUrl, {
      headers: {
        'User-Agent': 'PerdictionNFL/rotowire-ingest (+https://github.com/Perdiction-NFL)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9'
      }
    });
    if (!res.ok) {
      if (attemptUrl === attempts[attempts.length - 1]) throw new Error(`HTTP ${res.status}`);
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    let body;
    let jsonPayload = null;
    if (/application\/json/i.test(contentType)) {
      try {
        const json = await res.json();
        jsonPayload = json && typeof json === 'object' ? json : null;
        if (typeof json === 'string') body = json;
        else if (json && typeof json === 'object') {
          body = json.html || json.body || json.result || json.content || null;
          if (!body) {
            try {
              body = JSON.stringify(json);
            } catch (err) {
              body = null;
            }
          }
        }
      } catch (err) {
        body = null;
      }
    } else {
      body = await res.text();
    }

    const html = typeof body === 'string' ? body : '';
    let rows = extractRows(html, { team, season, week, fetchedAt });
    if (!rows.length && jsonPayload) {
      rows = parseEmbeddedJsonObject(jsonPayload, { team, season, week, fetchedAt });
    }
    if (rows.length) return rows;
  }

  return [];
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const aggregated = [];
  for (const [idx, team] of TEAM_CODES.entries()) {
    try {
      console.log(`[fetchRotowireInjuries] Fetching ${team} (${idx + 1}/${TEAM_CODES.length})`);
      const rows = await fetchTeamReport(team);
      if (!rows.length) {
        console.warn(`[fetchRotowireInjuries] ${team} returned 0 rows (no injuries or markup change?)`);
      }
      aggregated.push(...rows);
    } catch (err) {
      console.warn(`[fetchRotowireInjuries] ${team} failed: ${err?.message || err}`);
    }
    if (idx < TEAM_CODES.length - 1) {
      const pause = 1000 + Math.random() * 1000;
      await delay(pause);
    }
  }

  aggregated.sort((a, b) => {
    if (a.team === b.team) return (a.player || '').localeCompare(b.player || '');
    return a.team.localeCompare(b.team);
  });

  const fileName = `injuries_${season}_W${String(week).padStart(2, '0')}.json`;
  const filePath = path.join(artifactsDir, fileName);
  await fs.writeFile(filePath, JSON.stringify(aggregated, null, 2));
  await fs.writeFile(path.join(artifactsDir, 'injuries_current.json'), JSON.stringify(aggregated, null, 2));

  console.log(`[fetchRotowireInjuries] wrote ${aggregated.length} rows to ${fileName}`);
}

main().catch((err) => {
  console.error('[fetchRotowireInjuries] fatal', err);
  process.exitCode = 1;
});
