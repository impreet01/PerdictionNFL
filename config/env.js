import dotenv from "dotenv";

dotenv.config();

const DEFAULT_HOST = "tank01-nfl-live-in-game-real-time-statistics-nfl.p.rapidapi.com";

const normalizeBaseUrl = (value) => {
  const raw = typeof value === "string" ? value.trim() : "";
  const candidate = raw || DEFAULT_HOST;
  const withProtocol = /^https?:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate.replace(/^\/*/, "")}`;
  try {
    const url = new URL(withProtocol);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch (err) {
    return `https://${DEFAULT_HOST}`;
  }
};

const baseUrl = normalizeBaseUrl(process.env.TANK01_API_BASE_URL);

const hostFromBase = (() => {
  try {
    return new URL(`${baseUrl}/`).host || DEFAULT_HOST;
  } catch (err) {
    return DEFAULT_HOST;
  }
})();

export const CONFIG = {
  TANK01_API_KEY: process.env.TANK01_API_KEY ?? "",
  TANK01_API_BASE_URL: baseUrl,
  TANK01_API_HOST: hostFromBase
};

CONFIG.API_KEY = CONFIG.TANK01_API_KEY;
CONFIG.API_BASE_URL = CONFIG.TANK01_API_BASE_URL;
CONFIG.API_HOST = CONFIG.TANK01_API_HOST;
