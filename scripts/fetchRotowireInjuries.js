import fs from 'node:fs/promises';
import path from 'node:path';

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
const artifactsDir = path.resolve(process.cwd(), 'artifacts');

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

async function fetchTeamReport(team) {
  const url = new URL('https://www.rotowire.com/football/tables/injury-report.php');
  url.searchParams.set('team', team);
  url.searchParams.set('pos', 'ALL');
  url.searchParams.set('season', String(season));
  url.searchParams.set('week', String(week));

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'PerdictionNFL/rotowire-ingest (+https://github.com/Perdiction-NFL)',
      Accept: 'text/html,application/xhtml+xml'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return parseTable(html, { team, season, week, fetchedAt });
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const aggregated = [];
  for (const [idx, team] of TEAM_CODES.entries()) {
    try {
      console.log(`[fetchRotowireInjuries] Fetching ${team} (${idx + 1}/${TEAM_CODES.length})`);
      const rows = await fetchTeamReport(team);
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
