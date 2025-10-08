import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { load } from "cheerio";

const ROTOWIRE_ENABLED = process.env.ROTOWIRE_ENABLED === "true";

if (!ROTOWIRE_ENABLED) {
  console.log('[fetchRotowireWeather] ROTOWIRE_ENABLED !== "true"; skipping fetch.');
  process.exit(0);
}

const TEAM_NAME_TO_CODE = new Map([
  ["49ERS", "SF"],
  ["NINERS", "SF"],
  ["BEARS", "CHI"],
  ["BENGALS", "CIN"],
  ["BILLS", "BUF"],
  ["BRONCOS", "DEN"],
  ["BROWNS", "CLE"],
  ["BUCCANEERS", "TB"],
  ["BUCS", "TB"],
  ["CARDINALS", "ARI"],
  ["CHARGERS", "LAC"],
  ["CHIEFS", "KC"],
  ["COLTS", "IND"],
  ["COMMANDERS", "WAS"],
  ["COWBOYS", "DAL"],
  ["DOLPHINS", "MIA"],
  ["EAGLES", "PHI"],
  ["FALCONS", "ATL"],
  ["GIANTS", "NYG"],
  ["JAGUARS", "JAX"],
  ["JAGS", "JAX"],
  ["JETS", "NYJ"],
  ["LIONS", "DET"],
  ["PACKERS", "GB"],
  ["PANTHERS", "CAR"],
  ["PATRIOTS", "NE"],
  ["RAIDERS", "LV"],
  ["RAMS", "LAR"],
  ["RAVENS", "BAL"],
  ["SAINTS", "NO"],
  ["SEAHAWKS", "SEA"],
  ["STEELERS", "PIT"],
  ["TEXANS", "HOU"],
  ["TITANS", "TEN"],
  ["VIKINGS", "MIN"]
]);

const argv = process.argv.slice(2);
const cliOptions = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) continue;
  const [key, rawVal] = arg.split("=");
  if (rawVal !== undefined) {
    cliOptions[key.slice(2)] = rawVal;
  } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
    cliOptions[key.slice(2)] = argv[i + 1];
    i += 1;
  } else {
    cliOptions[key.slice(2)] = true;
  }
}

const now = new Date();
const season = Number.parseInt(cliOptions.season ?? now.getUTCFullYear(), 10);
if (!Number.isFinite(season)) {
  console.error('[fetchRotowireWeather] Invalid --season');
  process.exit(1);
}
const week = Number.parseInt(cliOptions.week ?? cliOptions.w ?? cliOptions.gameweek ?? 0, 10);
if (!Number.isFinite(week) || week <= 0) {
  console.error('[fetchRotowireWeather] Provide --week (1-22).');
  process.exit(1);
}

const fetchedAt = new Date().toISOString();
const artifactsDir = path.resolve(process.cwd(), "artifacts");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function clean(text) {
  if (!text) return "";
  return text
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function canonical(name) {
  return clean(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function extractTeamCode($team) {
  if (!$team || !$team.length) return null;
  const imgSrc = $team.find("img").attr("src") || "";
  const imgMatch = imgSrc.match(/\/([A-Z]{2,3})\.svg/i);
  if (imgMatch) {
    return imgMatch[1].toUpperCase();
  }
  const href = $team.attr("href") || "";
  const slug = href.split("/").pop() || "";
  if (slug) {
    const slugParts = slug.split("-");
    const last = slugParts.at(-1);
    if (last && last.length <= 3) {
      return last.toUpperCase();
    }
  }
  const label = canonical($team.text());
  if (!label) return null;
  return TEAM_NAME_TO_CODE.get(label) || null;
}

function parseTemperature(details, isDome) {
  const match = details.match(/(-?\d+(?:\.\d+)?)\s*°?\s*F/i);
  if (match) return Number.parseFloat(match[1]);
  return isDome ? 70 : null;
}

function parsePrecip(details, isDome) {
  if (isDome) return 0;
  const match = details.match(/(\d+(?:\.\d+)?)%\s+chance of (?:precipitation|rain|showers)/i);
  if (match) return Number.parseFloat(match[1]);
  return null;
}

function inferWind(text, isDome) {
  if (isDome) return 0;
  const lower = text.toLowerCase();
  const mph = lower.match(/(\d+(?:\.\d+)?)\s*mph/);
  if (mph) return Number.parseFloat(mph[1]);
  const patterns = [
    { regex: /calm (?:conditions|winds?)/i, value: 2 },
    { regex: /light (?:breeze|winds?)/i, value: 7 },
    { regex: /breezy/i, value: 12 },
    { regex: /moderate (?:breeze|winds?)/i, value: 15 },
    { regex: /steady winds?/i, value: 16 },
    { regex: /gusty/i, value: 20 },
    { regex: /strong (?:breeze|winds?)/i, value: 24 },
    { regex: /howling winds?/i, value: 28 }
  ];
  for (const { regex, value } of patterns) {
    if (regex.test(text)) return value;
  }
  return null;
}

function inferImpact({ notes, details, isDome, precip, wind, temperature }) {
  if (isDome) return 0;
  const text = `${details} ${notes}`.toLowerCase();
  if (!text.trim()) return null;
  const checks = [
    { regex: /(minimal impact|not have a significant impact|little impact)/i, score: 0.1 },
    { regex: /(light breeze|light winds?)/i, score: 0.2 },
    { regex: /(moderate breeze|moderate winds?|steady winds?)/i, score: 0.35 },
    { regex: /(gusty|strong winds?|heavy rain|downpour|snow|slick field|blustery)/i, score: 0.6 },
    { regex: /(may result in some inaccurate passes|missed kicks|difficult kicking)/i, score: 0.45 },
    { regex: /(significant impact|major impact)/i, score: 0.65 }
  ];
  let score = null;
  for (const { regex, score: s } of checks) {
    if (regex.test(text)) {
      score = score == null ? s : Math.max(score, s);
    }
  }
  if (score == null) {
    if (typeof wind === "number") {
      if (wind >= 25) score = 0.75;
      else if (wind >= 18) score = 0.55;
      else if (wind >= 12) score = 0.35;
      else if (wind >= 6) score = 0.2;
    }
  }
  if (score == null && typeof precip === "number") {
    if (precip >= 70) score = 0.65;
    else if (precip >= 50) score = 0.45;
  }
  if (score == null && typeof temperature === "number") {
    if (temperature <= 25) score = 0.5;
    else if (temperature >= 90) score = 0.35;
  }
  return score;
}

function parseLocation(details) {
  const match = details.match(/in\s+([^.,]+?)(?:\s+at|\.|,)/i);
  if (match) {
    const loc = clean(match[1]);
    if (loc) return loc;
  }
  return null;
}

function parseProvider(details) {
  const match = details.match(/According to\s+([^,]+),/i);
  if (match) return clean(match[1]);
  return null;
}

async function fetchWeatherHtml() {
  const url = "https://www.rotowire.com/football/weather.php";
  const response = await axios.get(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    timeout: 15000
  });
  return response.data;
}

async function main() {
  const html = await fetchWeatherHtml();
  const $ = load(html);

  const boxes = $(".weather-box");
  if (!boxes.length) {
    console.warn("[fetchRotowireWeather] No weather boxes found on page.");
  }

  const records = [];
  boxes.each((_, el) => {
    const $box = $(el);
    const $away = $box.find(".weather-box__team.is-visit");
    const $home = $box.find(".weather-box__team.is-home");
    const awayTeam = extractTeamCode($away);
    const homeTeam = extractTeamCode($home);
    if (!homeTeam || !awayTeam) return;

    const summary = clean($box.find(".weather-box__weather .heading").text());
    const detail = clean($box.find(".weather-box__weather .text-80").text());
    const notes = clean($box.find(".weather-box__notes").text());
    const kickoff = clean($box.find(".weather-box__date").text());
    const icon = clean($box.find(".weather-box__icon").attr("src"));
    const provider = parseProvider(detail);
    const isDome = /domed stadium|indoors?|roof closed/i.test(detail) || /indoors?|roof closed/i.test(notes);
    const temperatureF = parseTemperature(detail, isDome);
    const precipitationChance = parsePrecip(detail, isDome);
    const windMph = inferWind(`${detail} ${notes}`, isDome);
    const impactScore = inferImpact({ notes, details: detail, isDome, precip: precipitationChance, wind: windMph, temperature: temperatureF });
    const location = parseLocation(detail) || null;

    const links = [];
    $box.find(".weather-box__forecasts a").each((__, link) => {
      const href = clean($(link).attr("href"));
      const label = clean($(link).text());
      if (href) {
        links.push({ label: label || null, url: href });
      }
    });

    const record = {
      season,
      week,
      home_team: homeTeam,
      away_team: awayTeam,
      home_name: clean($home.text()) || null,
      away_name: clean($away.text()) || null,
      game_key: `${season}-W${String(week).padStart(2, "0")}-${homeTeam}-${awayTeam}`,
      kickoff_display: kickoff || null,
      summary: summary || null,
      details: detail || null,
      notes: notes || null,
      location,
      forecast_provider: provider,
      icon: icon || null,
      temperature_f: typeof temperatureF === "number" ? Number(temperatureF.toFixed(1)) : null,
      precipitation_chance: typeof precipitationChance === "number" ? Number(precipitationChance.toFixed(1)) : null,
      wind_mph: typeof windMph === "number" ? Number(windMph.toFixed(1)) : (isDome ? 0 : null),
      impact_score: typeof impactScore === "number" ? Number(impactScore.toFixed(2)) : (isDome ? 0 : null),
      forecast_links: links,
      fetched_at: fetchedAt,
      source: "rotowire"
    };
    records.push(record);
  });

  if (!records.length) {
    console.warn("[fetchRotowireWeather] No records parsed; aborting write.");
    return;
  }

  await fs.mkdir(artifactsDir, { recursive: true });
  const weekSuffix = `W${String(week).padStart(2, "0")}`;
  const outPath = path.join(artifactsDir, `weather_${season}_${weekSuffix}.json`);
  const currentPath = path.join(artifactsDir, "weather_current.json");
  await fs.writeFile(outPath, JSON.stringify(records, null, 2));
  await fs.writeFile(currentPath, JSON.stringify(records, null, 2));
  console.log(`[fetchRotowireWeather] Wrote ${records.length} records -> ${outPath}`);
}

main().catch((err) => {
  console.error("[fetchRotowireWeather] Error:", err?.message || err);
  process.exit(1);
});
