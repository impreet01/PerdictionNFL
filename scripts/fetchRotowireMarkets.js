import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const ROTOWIRE_ENABLED = process.env.ROTOWIRE_ENABLED === 'true';
const ROTOWIRE_MARKETS_ENDPOINT = 'https://www.rotowire.com/betting/nfl/tables/nfl-games-by-market.php';

const execFile = promisify(execFileCallback);

async function fetchJsonWithFallback(url) {
  const headers = {
    'User-Agent': 'PerdictionNFL/rotowire-markets (+https://github.com/Perdiction-NFL)',
    Accept: 'application/json,text/javascript;q=0.9'
  };

  if (typeof fetch === 'function') {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      const code = err?.cause?.code ?? err?.code ?? null;
      const message = err?.message ?? String(err);
      if (code !== 'ENETUNREACH') {
        console.warn(`[fetchRotowireMarkets] fetch() failed (${message}); falling back to curl`);
      } else {
        console.warn('[fetchRotowireMarkets] fetch() reported ENETUNREACH; falling back to curl');
      }
    }
  }

  try {
    const args = ['-sS', '-H', `User-Agent: ${headers['User-Agent']}`, '-H', `Accept: ${headers.Accept}`, url.toString()];
    const { stdout } = await execFile('curl', args);
    return JSON.parse(stdout);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error('curl not found (required for fallback fetch)');
    }
    if (err?.stderr) {
      throw new Error(`curl exited with error: ${err.stderr.trim()}`);
    }
    throw err;
  }
}

if (!ROTOWIRE_ENABLED) {
  console.log('[fetchRotowireMarkets] ROTOWIRE_ENABLED !== "true"; skipping fetch.');
  process.exit(0);
}

function parseCli(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, rawVal] = arg.split('=');
    if (rawVal !== undefined) {
      opts[key.slice(2)] = rawVal;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      opts[key.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      opts[key.slice(2)] = true;
    }
  }
  return opts;
}

function toInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const str = String(value).trim();
  if (!str) return null;
  if (/^pk$/i.test(str) || /^pick'em$/i.test(str) || /^pickem$/i.test(str) || /^pick$/i.test(str)) {
    return 0;
  }
  if (/^ev$/i.test(str) || /^even$/i.test(str)) {
    return 100;
  }
  const cleaned = str.replace(/[,]/g, '');
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

function average(values = []) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  const sum = nums.reduce((acc, val) => acc + val, 0);
  return sum / nums.length;
}

function extractBookFields(entry) {
  const out = {};
  if (!entry || typeof entry !== 'object') return out;
  for (const [key, value] of Object.entries(entry)) {
    const match = key.match(/^([a-z0-9]+)_(moneyline|spread|spreadML|ou|ouML|teamTotalOver|teamTotalOverML|teamTotalUnder|teamTotalUnderML)$/i);
    if (!match) continue;
    const book = match[1].toLowerCase();
    if (!out[book]) out[book] = {};
    out[book][match[2]] = value;
  }
  return out;
}

function mergeBooks(homeBooks, awayBooks) {
  const merged = {};
  const bookNames = new Set([...Object.keys(homeBooks || {}), ...Object.keys(awayBooks || {})]);
  for (const book of bookNames) {
    const h = homeBooks?.[book] ?? {};
    const a = awayBooks?.[book] ?? {};
    const bookEntry = {
      moneyline: {
        home: toNumber(h.moneyline),
        away: toNumber(a.moneyline)
      },
      spread: {
        home: {
          line: toNumber(h.spread),
          price: toNumber(h.spreadML)
        },
        away: {
          line: toNumber(a.spread),
          price: toNumber(a.spreadML)
        }
      },
      total: {
        points: toNumber(a.ou ?? h.ou),
        over_price: toNumber(a.ouML),
        under_price: toNumber(h.ouML)
      },
      team_total: {
        home: {
          points: toNumber(h.teamTotalOver ?? h.teamTotalUnder),
          over_price: toNumber(h.teamTotalOverML),
          under_price: toNumber(h.teamTotalUnderML)
        },
        away: {
          points: toNumber(a.teamTotalOver ?? a.teamTotalUnder),
          over_price: toNumber(a.teamTotalOverML),
          under_price: toNumber(a.teamTotalUnderML)
        }
      }
    };
    merged[book] = bookEntry;
  }
  return merged;
}

function computeConsensus(books = {}) {
  const spreadHome = [];
  const spreadAway = [];
  const spreadPriceHome = [];
  const spreadPriceAway = [];
  const moneylineHome = [];
  const moneylineAway = [];
  const totalPoints = [];
  const totalOverPrice = [];
  const totalUnderPrice = [];
  const teamTotalHome = [];
  const teamTotalHomeOver = [];
  const teamTotalHomeUnder = [];
  const teamTotalAway = [];
  const teamTotalAwayOver = [];
  const teamTotalAwayUnder = [];

  for (const bookEntry of Object.values(books)) {
    if (!bookEntry || typeof bookEntry !== 'object') continue;
    const spread = bookEntry.spread ?? {};
    const total = bookEntry.total ?? {};
    const teamTotal = bookEntry.team_total ?? {};

    if (Number.isFinite(spread?.home?.line)) spreadHome.push(spread.home.line);
    if (Number.isFinite(spread?.away?.line)) spreadAway.push(spread.away.line);
    if (Number.isFinite(spread?.home?.price)) spreadPriceHome.push(spread.home.price);
    if (Number.isFinite(spread?.away?.price)) spreadPriceAway.push(spread.away.price);

    if (Number.isFinite(bookEntry.moneyline?.home)) moneylineHome.push(bookEntry.moneyline.home);
    if (Number.isFinite(bookEntry.moneyline?.away)) moneylineAway.push(bookEntry.moneyline.away);

    if (Number.isFinite(total?.points)) totalPoints.push(total.points);
    if (Number.isFinite(total?.over_price)) totalOverPrice.push(total.over_price);
    if (Number.isFinite(total?.under_price)) totalUnderPrice.push(total.under_price);

    if (Number.isFinite(teamTotal?.home?.points)) teamTotalHome.push(teamTotal.home.points);
    if (Number.isFinite(teamTotal?.home?.over_price)) teamTotalHomeOver.push(teamTotal.home.over_price);
    if (Number.isFinite(teamTotal?.home?.under_price)) teamTotalHomeUnder.push(teamTotal.home.under_price);

    if (Number.isFinite(teamTotal?.away?.points)) teamTotalAway.push(teamTotal.away.points);
    if (Number.isFinite(teamTotal?.away?.over_price)) teamTotalAwayOver.push(teamTotal.away.over_price);
    if (Number.isFinite(teamTotal?.away?.under_price)) teamTotalAwayUnder.push(teamTotal.away.under_price);
  }

  return {
    samples: Object.keys(books).length,
    spread_home: average(spreadHome),
    spread_away: average(spreadAway),
    spread_home_price: average(spreadPriceHome),
    spread_away_price: average(spreadPriceAway),
    moneyline_home: average(moneylineHome),
    moneyline_away: average(moneylineAway),
    total_points: average(totalPoints),
    total_over_price: average(totalOverPrice),
    total_under_price: average(totalUnderPrice),
    team_total_home: average(teamTotalHome),
    team_total_home_over_price: average(teamTotalHomeOver),
    team_total_home_under_price: average(teamTotalHomeUnder),
    team_total_away: average(teamTotalAway),
    team_total_away_over_price: average(teamTotalAwayOver),
    team_total_away_under_price: average(teamTotalAwayUnder)
  };
}

function mergeBest(homeEntry, awayEntry) {
  const best = {
    moneyline: {
      home: {
        book: homeEntry?.best_moneylineBook ?? null,
        price: toNumber(homeEntry?.best_moneyline)
      },
      away: {
        book: awayEntry?.best_moneylineBook ?? null,
        price: toNumber(awayEntry?.best_moneyline)
      }
    },
    spread: {
      home: {
        book: homeEntry?.best_spreadBook ?? null,
        line: toNumber(homeEntry?.best_spread),
        price: toNumber(homeEntry?.best_spreadML)
      },
      away: {
        book: awayEntry?.best_spreadBook ?? null,
        line: toNumber(awayEntry?.best_spread),
        price: toNumber(awayEntry?.best_spreadML)
      }
    },
    total: {
      over: {
        book: awayEntry?.best_ouBook ?? null,
        points: toNumber(awayEntry?.best_ou),
        price: toNumber(awayEntry?.best_ouML)
      },
      under: {
        book: homeEntry?.best_ouBook ?? null,
        points: toNumber(homeEntry?.best_ou),
        price: toNumber(homeEntry?.best_ouML)
      }
    },
    team_total: {
      home: {
        over: {
          book: homeEntry?.best_teamTotalOverBook ?? null,
          points: toNumber(homeEntry?.best_teamTotalOver),
          price: toNumber(homeEntry?.best_teamTotalOverML)
        },
        under: {
          book: homeEntry?.best_teamTotalUnderBook ?? null,
          points: toNumber(homeEntry?.best_teamTotalUnder),
          price: toNumber(homeEntry?.best_teamTotalUnderML)
        }
      },
      away: {
        over: {
          book: awayEntry?.best_teamTotalOverBook ?? null,
          points: toNumber(awayEntry?.best_teamTotalOver),
          price: toNumber(awayEntry?.best_teamTotalOverML)
        },
        under: {
          book: awayEntry?.best_teamTotalUnderBook ?? null,
          points: toNumber(awayEntry?.best_teamTotalUnder),
          price: toNumber(awayEntry?.best_teamTotalUnderML)
        }
      }
    }
  };
  return best;
}

function buildGameRecord(gameId, homeEntry, awayEntry, meta) {
  const homeTeam = String(homeEntry?.abbr ?? awayEntry?.oppAbbr ?? '').trim().toUpperCase();
  const awayTeam = String(awayEntry?.abbr ?? homeEntry?.oppAbbr ?? '').trim().toUpperCase();
  if (!homeTeam || !awayTeam) return null;

  const booksHome = extractBookFields(homeEntry);
  const booksAway = extractBookFields(awayEntry);
  const books = mergeBooks(booksHome, booksAway);
  const consensus = computeConsensus(books);
  const best = mergeBest(homeEntry, awayEntry);

  const weekTag = String(meta.week).padStart(2, '0');
  const gameKey = `${meta.season}-W${weekTag}-${homeTeam}-${awayTeam}`;
  const kickoffRaw = homeEntry?.gameDate ?? awayEntry?.gameDate ?? null;
  const kickoffDisplay = homeEntry?.gameDateTime ?? awayEntry?.gameDateTime ?? null;
  const gameDay = homeEntry?.gameDay ?? awayEntry?.gameDay ?? null;
  const urlPath = homeEntry?.gameURL ?? awayEntry?.gameURL ?? null;
  let marketUrl = null;
  if (urlPath) {
    try {
      const fullUrl = new URL(urlPath, 'https://www.rotowire.com');
      marketUrl = fullUrl.toString();
    } catch {
      marketUrl = null;
    }
  }

  const record = {
    season: meta.season,
    week: meta.week,
    rotowire_game_id: gameId,
    game_key: gameKey,
    game_date: kickoffRaw ?? null,
    game_day: gameDay ?? null,
    kickoff_display: kickoffDisplay ?? null,
    market_url: marketUrl,
    home_team: homeTeam,
    away_team: awayTeam,
    home_name: homeEntry?.name ?? awayEntry?.oppName ?? null,
    away_name: awayEntry?.name ?? homeEntry?.oppName ?? null,
    fetched_at: meta.fetchedAt,
    source: 'rotowire',
    market: {
      spread: consensus.spread_home ?? null,
      close_spread: consensus.spread_home ?? null,
      open_spread: consensus.spread_home ?? null,
      spread_home: consensus.spread_home ?? null,
      spread_away: consensus.spread_away ?? null,
      spread_price_home: consensus.spread_home_price ?? null,
      spread_price_away: consensus.spread_away_price ?? null,
      moneyline_home: consensus.moneyline_home ?? null,
      moneyline_away: consensus.moneyline_away ?? null,
      total: consensus.total_points ?? null,
      total_points: consensus.total_points ?? null,
      total_over_price: consensus.total_over_price ?? null,
      total_under_price: consensus.total_under_price ?? null,
      team_total_home: consensus.team_total_home ?? null,
      team_total_home_over_price: consensus.team_total_home_over_price ?? null,
      team_total_home_under_price: consensus.team_total_home_under_price ?? null,
      team_total_away: consensus.team_total_away ?? null,
      team_total_away_over_price: consensus.team_total_away_over_price ?? null,
      team_total_away_under_price: consensus.team_total_away_under_price ?? null,
      consensus_samples: consensus.samples ?? 0,
      books,
      best,
      fetched_at: meta.fetchedAt,
      source: 'rotowire'
    }
  };

  return record;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const now = new Date();
  const season = toInt(cli.season ?? now.getUTCFullYear());
  if (season == null) {
    console.error('[fetchRotowireMarkets] Invalid --season');
    process.exit(1);
  }
  const week = toInt(cli.week ?? cli.w ?? cli.gameweek ?? 0);
  if (week == null || week <= 0) {
    console.error('[fetchRotowireMarkets] Provide --week (1-22).');
    process.exit(1);
  }

  const fetchedAt = new Date().toISOString();
  const artifactsDir = path.resolve(process.cwd(), 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });

  // `trainer/dataSources.js#loadMarkets` reads the JSON artifacts generated here.
  // The upstream feed lives at:
  //   https://www.rotowire.com/betting/nfl/tables/nfl-games-by-market.php?week=<WEEK>
  const url = new URL(ROTOWIRE_MARKETS_ENDPOINT);
  url.searchParams.set('week', String(week));

  let payload;
  try {
    payload = await fetchJsonWithFallback(url);
  } catch (err) {
    console.error(`[fetchRotowireMarkets] Failed to fetch markets: ${err?.message || err}`);
    process.exit(1);
  }

  if (!Array.isArray(payload)) {
    console.error('[fetchRotowireMarkets] Unexpected payload format (expected array).');
    process.exit(1);
  }

  const grouped = new Map();
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const gameIdRaw = entry.gameID ?? entry.gameId ?? entry.id ?? null;
    const gameId = gameIdRaw != null ? String(gameIdRaw) : null;
    if (!gameId) continue;
    const roleRaw = entry.homeAway ?? entry.side ?? '';
    const role = typeof roleRaw === 'string' && roleRaw.toLowerCase() === 'home' ? 'home' : 'away';
    if (!grouped.has(gameId)) {
      grouped.set(gameId, { home: null, away: null });
    }
    grouped.get(gameId)[role] = entry;
  }

  const records = [];
  for (const [gameId, group] of grouped.entries()) {
    const record = buildGameRecord(gameId, group.home, group.away, { season, week, fetchedAt });
    if (record) records.push(record);
  }

  records.sort((a, b) => {
    if (a.game_key && b.game_key) return a.game_key.localeCompare(b.game_key);
    return (a.rotowire_game_id ?? '').localeCompare(b.rotowire_game_id ?? '');
  });

  const fileName = `markets_${season}_W${String(week).padStart(2, '0')}.json`;
  const outPath = path.join(artifactsDir, fileName);
  const serialized = `${JSON.stringify(records, null, 2)}\n`;
  await fs.writeFile(outPath, serialized, 'utf8');
  await fs.writeFile(path.join(artifactsDir, 'markets_current.json'), serialized, 'utf8');

  console.log(`[fetchRotowireMarkets] Wrote ${records.length} games to ${fileName}`);
}

main().catch((err) => {
  console.error('[fetchRotowireMarkets] Unhandled error', err);
  process.exit(1);
});
