// trainer/teamCodes.js
// Shared helpers for validating and normalizing team codes sourced from disparate datasets.

const INVALID_TEAM_CODES = new Set([
  "",
  "-",
  "--",
  "?",
  "??",
  "???",
  "TBD",
  "TBA",
  "TBC",
  "UNK",
  "UNKNOWN",
  "NA",
  "N/A",
  "NONE",
  "NULL",
  "HOME",
  "AWAY",
  "H",
  "A"
]);

export function normalizeTeamCode(...values) {
  for (const value of values) {
    if (value == null) continue;
    const raw = String(value).trim().toUpperCase();
    if (!raw) continue;
    if (INVALID_TEAM_CODES.has(raw)) continue;
    const letters = raw.replace(/[^A-Z]/g, "");
    if (!letters || letters.length < 2 || letters.length > 5) continue;
    if (INVALID_TEAM_CODES.has(letters)) continue;
    return letters;
  }
  return null;
}

export function isValidTeamCode(value) {
  return normalizeTeamCode(value) != null;
}

export const INVALID_TEAM_CODE_SET = INVALID_TEAM_CODES;
