import { CONFIG } from "../config/env.js";

const ok = Boolean(CONFIG.API_KEY);
const payload = {
  apiKeyPresent: ok,
  baseUrl: CONFIG.API_BASE_URL
};

console.log(JSON.stringify(payload));

if (!ok) {
  process.exit(1);
}
