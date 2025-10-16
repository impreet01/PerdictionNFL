// trainer/teamNormalizer.js
// Utility helpers for normalizing historical NFL team abbreviations.

const TEAM_ALIASES = new Map([
  ["STL", "LAR"],
  ["SD", "LAC"],
  ["OAK", "LV"],
  ["JAX", "JAC"],
  ["LA", "LAR"],
  ["ST", "LAR"],
  ["SDG", "LAC"],
  ["OAKLAND", "LV"],
  ["STLO", "LAR"]
]);

export function normalizeTeam(value) {
  if (value === undefined || value === null) return null;
  const code = String(value).trim().toUpperCase();
  if (!code) return null;
  return TEAM_ALIASES.get(code) || code;
}

export default {
  normalizeTeam
};
