// trainer/dataSources.js
// Downloads nflverse schedules and team weekly stats (CSV or CSV.GZ) for a given season.
// Uses the asset pattern: stats_team_week_<season>.csv[.gz]

import Papa from "papaparse";
import { gunzipSync } from "node:zlib"; // <-- use Node built-in zlib
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { URL } from "node:url";
let fetchImpl = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
let ProxyAgentCtor;
let dispatcher = null;
let fetchInitPromise;

const NFLVERSE_RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const STATS_TEAM_TAG = "stats_team";
const SCHEDULES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";
const SCHEDULES_MIRROR = "https://cdn.jsdelivr.net/gh/nflverse/nfldata@master/data/games.csv";
const DEFAULT_LOCAL_SCHEDULES = "./data/games.csv";
const DEFAULT_CACHE_SCHEDULES = "artifacts/cache/games.csv";
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const NO_PROXY_RAW = process.env.NO_PROXY || process.env.no_proxy || "";
const NO_PROXY_LIST = NO_PROXY_RAW.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

async function ensureFetch() {
  if (fetchImpl && (dispatcher !== null || !PROXY_URL)) {
    return;
  }
  if (!fetchInitPromise) {
    fetchInitPromise = (async () => {
      if ((!fetchImpl || PROXY_URL) && !ProxyAgentCtor) {
        try {
          const undici = await import("undici");
          fetchImpl = undici.fetch;
          ProxyAgentCtor = undici.ProxyAgent;
        } catch (err) {
          if (!fetchImpl) {
            throw new Error(
              "Fetch API unavailable; install 'undici' or upgrade Node.js to v18+."
            );
          }
        }
      }
      dispatcher = ProxyAgentCtor && PROXY_URL ? new ProxyAgentCtor(PROXY_URL) : null;
    })();
  }
  await fetchInitPromise;
}

function shouldBypassProxy(url) {
  if (!dispatcher || !NO_PROXY_LIST.length) return false;
  let host = "";
  let port = "";
  try {
    const parsed = new URL(url);
    host = (parsed.hostname || "").toLowerCase();
    port = parsed.port || "";
  } catch {
    return false;
  }
  const hostPort = port ? `${host}:${port}` : host;
  return NO_PROXY_LIST.some((entryRaw) => {
    const entry = entryRaw.trim();
    if (!entry) return false;
    if (entry === "*") return true;
    if (entry === hostPort) return true;
    if (!port && entry === host) return true;
    if (!entry.includes(":")) {
      const domain = entry.startsWith(".") ? entry.slice(1) : entry;
      if (host === domain) return true;
      if (host.endsWith(`.${domain}`)) return true;
    }
    return false;
  });
}

function parseCSV(text) {
  const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
  return parsed.data;
}

async function fetchWithProxy(url, options = {}) {
  await ensureFetch();
  if (!fetchImpl) {
    throw new Error("No fetch implementation available for HTTP requests.");
  }
  const useDispatcher = dispatcher && !shouldBypassProxy(url) ? dispatcher : undefined;
  const res = await fetchImpl(url, useDispatcher ? { ...options, dispatcher: useDispatcher } : options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res;
}

async function fetchText(url) {
  const res = await fetchWithProxy(url);
  return res.text();
}

async function fetchCSVMaybeGz(url) {
  if (url.endsWith(".csv")) {
    const text = await fetchText(url);
    return parseCSV(text);
  }
  if (url.endsWith(".csv.gz")) {
    const res = await fetchWithProxy(url);
    const arrayBuf = await res.arrayBuffer();
    let buf = Buffer.from(arrayBuf);
    const enc = (res.headers.get("content-encoding") || "").toLowerCase();
    if (enc.includes("gzip")) {
      buf = gunzipSync(buf);
    } else {
      try { buf = gunzipSync(buf); } catch (_) { /* not gzipped, ignore */ }
    }
    const text = buf.toString("utf8");
    return parseCSV(text);
  }
  throw new Error(`Unsupported extension for ${url}`);
}

function persistCache(cachePath, text) {
  if (!cachePath) return;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, text, "utf8");
  } catch {
    // best effort; ignore cache write failures
  }
}

function parseLocalFile(path) {
  const text = readFileSync(path, "utf8");
  return parseCSV(text);
}

export async function loadSchedules({ localPath, cachePath } = {}) {
  const resolvedLocal = localPath ?? process.env.NFLVERSE_SCHEDULES_FILE ?? DEFAULT_LOCAL_SCHEDULES;
  const resolvedCache = cachePath ?? process.env.NFLVERSE_SCHEDULES_CACHE ?? DEFAULT_CACHE_SCHEDULES;
  const attempts = [];

  const tryLocal = (path, label) => {
    if (!path) return null;
    try {
      return parseLocalFile(path);
    } catch (err) {
      attempts.push(`${label} (${path}): ${err?.message || err}`);
      return null;
    }
  };

  const localRows = tryLocal(resolvedLocal, "local schedules file");
  if (localRows) return localRows;

  if (!resolvedCache || resolvedCache === resolvedLocal) {
    // avoid double-attempt if cache path equals local path and already failed
  } else {
    const cacheRows = tryLocal(resolvedCache, "cached schedules file");
    if (cacheRows) return cacheRows;
  }

  const remoteSources = [SCHEDULES_URL, SCHEDULES_MIRROR];
  for (const url of remoteSources) {
    try {
      const text = await fetchText(url);
      persistCache(resolvedCache, text);
      return parseCSV(text);
    } catch (err) {
      attempts.push(`remote ${url}: ${err?.message || err}`);
    }
  }

  const detail = attempts.length ? ` Attempts: ${attempts.join(" | ")}` : "";
  throw new Error(`Could not load schedules from any source.${detail}`);
}

export async function loadTeamWeekly(season) {
  const candidates = [
    `${NFLVERSE_RELEASE}/${STATS_TEAM_TAG}/stats_team_week_${season}.csv`,
    `${NFLVERSE_RELEASE}/${STATS_TEAM_TAG}/stats_team_week_${season}.csv.gz`
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const rows = await fetchCSVMaybeGz(url);
      if (rows?.length) return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Could not fetch team weekly stats for ${season}: ${lastErr?.message || "no candidates succeeded"}`);
}
