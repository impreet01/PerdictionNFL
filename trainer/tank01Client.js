// trainer/tank01Client.js
// Shared RapidAPI client for Tank01 endpoints with retry/backoff handling.

import { CONFIG } from "../config/env.js";

const DEFAULT_HOST = "tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com";
const DEFAULT_BASE = `https://${DEFAULT_HOST}`;
const BASE_URL = CONFIG.TANK01_API_BASE_URL || DEFAULT_BASE;
const API_HOST = CONFIG.TANK01_API_HOST || DEFAULT_HOST;
const RETRYABLE = new Set([401, 429]);
const MAX_DELAY_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const coercePath = (path = "") => {
  if (!path) return BASE_URL;
  if (/^https?:/i.test(path)) return path;
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
};

const appendSearchParams = (url, params) => {
  if (!params || typeof params !== "object") return;
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v == null) continue;
        url.searchParams.append(key, String(v));
      }
    } else if (value instanceof Date) {
      url.searchParams.append(key, value.toISOString());
    } else if (typeof value === "object") {
      url.searchParams.append(key, JSON.stringify(value));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
};

export const tank01Config = {
  host: API_HOST,
  baseUrl: BASE_URL,
  minSeason: 2022
};

export const hasTank01Key = () => Boolean(CONFIG.TANK01_API_KEY);

export function tank01EnabledForSeason(season) {
  if (!hasTank01Key()) return false;
  const num = Number(season);
  if (!Number.isFinite(num)) return false;
  if (process.env.TANK01_DISABLE?.toLowerCase() === "true") return false;
  return num >= tank01Config.minSeason || process.env.TANK01_FORCE?.toLowerCase() === "true";
}

function parseTankResponse(json) {
  if (json == null) return null;
  if (typeof json !== "object") return json;
  const status = json.statusCode ?? json.status ?? json.code;
  if (status && status !== 200) {
    const message = json.message || json.error || json.body?.message || json.body?.error;
    const err = new Error(`Tank01 API ${status}${message ? `: ${message}` : ""}`);
    err.status = status;
    throw err;
  }
  if (json.body && typeof json.body === "object") {
    return json.body;
  }
  if (json.data && typeof json.data === "object") {
    return json.data;
  }
  return json;
}

export async function fetchTank01(path, { params, method = "GET", retries = 3, signal } = {}) {
  if (!hasTank01Key()) {
    throw new Error("TANK01_API_KEY is not configured");
  }
  const url = new URL(coercePath(path));
  appendSearchParams(url, params);
  const headers = {
    "X-RapidAPI-Key": CONFIG.TANK01_API_KEY,
    "X-RapidAPI-Host": tank01Config.host,
    Accept: "application/json"
  };

  let attempt = 0;
  while (true) {
    const resp = await fetch(url, { method, headers, signal });
    if (RETRYABLE.has(resp.status) && attempt < retries) {
      const backoff = Math.min(500 * 2 ** attempt, MAX_DELAY_MS);
      attempt += 1;
      await sleep(backoff);
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      const err = new Error(`Tank01 HTTP ${resp.status}: ${text}`);
      err.status = resp.status;
      throw err;
    }
    let json;
    try {
      json = await resp.json();
    } catch (err) {
      throw new Error(`Failed to parse Tank01 response: ${err?.message || err}`);
    }
    try {
      return parseTankResponse(json);
    } catch (err) {
      if (RETRYABLE.has(err.status) && attempt < retries) {
        const backoff = Math.min(500 * 2 ** attempt, MAX_DELAY_MS);
        attempt += 1;
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

export async function fetchTank01List(path, options = {}) {
  const body = await fetchTank01(path, options);
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (typeof body !== "object") return [];
  const arrays = [];
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) {
      arrays.push(...value);
    }
  }
  if (arrays.length) return arrays;
  return [];
}

export default fetchTank01;
