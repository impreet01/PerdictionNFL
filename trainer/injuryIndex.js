// trainer/injuryIndex.js
//
// Shared helpers for transforming Rotowire injury artifacts into
// per-team snapshots that downstream feature builders can consume.

import { normalizeTeamCode } from "./teamCodes.js";

const KEY_SKILL_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const KEY_OFFENSIVE_LINE = new Set(["LT", "RT", "LG", "RG", "C", "OL", "T", "G", "OT", "OG"]);

const ZERO_SNAPSHOT = Object.freeze({
  total: 0,
  out: 0,
  questionable: 0,
  doubtful: 0,
  skill_out: 0,
  skill_questionable: 0,
  ol_out: 0,
  ol_questionable: 0,
  practice_dnp: 0,
  practice_limited: 0
});

const normTeam = (...values) => normalizeTeamCode(...values);

const classifyStatus = (statusRaw = "") => {
  if (!statusRaw) return null;
  const status = String(statusRaw).toLowerCase();
  if (!status) return null;
  if (
    status.includes("out") ||
    status.includes("injured reserve") ||
    status.includes("injury reserve") ||
    status.includes("ir") ||
    status.includes("susp") ||
    status.includes("pup") ||
    status.includes("nfi") ||
    status.includes("covid")
  ) {
    return "out";
  }
  if (status.includes("doubt")) return "doubtful";
  if (status.includes("question")) return "questionable";
  if (status.includes("probable") || status.includes("game-time")) return "questionable";
  return null;
};

const classifyPractice = (practiceRaw = "") => {
  if (!practiceRaw) return null;
  const practice = String(practiceRaw).toLowerCase();
  if (!practice) return null;
  if (
    practice.includes("did not") ||
    practice.includes("no practice") ||
    practice.includes("dnp") ||
    practice.includes("out")
  ) {
    return "dnp";
  }
  if (practice.includes("limited")) return "limited";
  return null;
};

const cloneSnapshot = (snapshot = ZERO_SNAPSHOT) => ({
  total: snapshot.total || 0,
  out: snapshot.out || 0,
  questionable: snapshot.questionable || 0,
  doubtful: snapshot.doubtful || 0,
  skill_out: snapshot.skill_out || 0,
  skill_questionable: snapshot.skill_questionable || 0,
  ol_out: snapshot.ol_out || 0,
  ol_questionable: snapshot.ol_questionable || 0,
  practice_dnp: snapshot.practice_dnp || 0,
  practice_limited: snapshot.practice_limited || 0
});

export function buildTeamInjuryIndex(rows = [], season) {
  const seasonNum = Number(season);
  if (!Number.isFinite(seasonNum)) return new Map();
  const index = new Map();
  const dedup = new Set();
  for (const row of rows || []) {
    if (Number(row.season) !== seasonNum) continue;
    const week = Number(row.week);
    if (!Number.isFinite(week) || week < 1) continue;
    const team = normTeam(row.team, row.team_abbr, row.recent_team, row.club_code);
    if (!team) continue;
    const player = String(row.player || row.player_name || row.gsis_id || row.esb_id || "").trim();
    const statusRaw = row.status ?? row.injury_status ?? row.designation ?? "";
    const practiceRaw = row.practice ?? row.practice_status ?? row.practice_notes ?? row.practice_text ?? "";
    const dedupKey = `${seasonNum}|${week}|${team}|${player}|${statusRaw}|${practiceRaw}`;
    if (dedup.has(dedupKey)) continue;
    dedup.add(dedupKey);

    let bucket = classifyStatus(statusRaw);
    const practiceBucket = classifyPractice(practiceRaw);
    if (!bucket && practiceBucket) {
      // treat practice downgrades as questionable signals if no explicit status
      bucket = "questionable";
    }
    if (!bucket && !practiceBucket) continue;

    const key = `${seasonNum}-${week}-${team}`;
    if (!index.has(key)) {
      index.set(key, cloneSnapshot());
    }
    const snapshot = index.get(key);
    snapshot.total += 1;
    if (bucket === "out") {
      snapshot.out += 1;
    } else if (bucket) {
      snapshot.questionable += 1;
      if (bucket === "doubtful") snapshot.doubtful += 1;
    }

    const pos = String(row.position || row.pos || row.player_position || "").toUpperCase();
    const isSkill = KEY_SKILL_POSITIONS.has(pos);
    const isOl = KEY_OFFENSIVE_LINE.has(pos);
    if (bucket === "out") {
      if (isSkill) snapshot.skill_out += 1;
      if (isOl) snapshot.ol_out += 1;
    } else if (bucket) {
      if (isSkill) snapshot.skill_questionable += 1;
      if (isOl) snapshot.ol_questionable += 1;
    }

    if (practiceBucket === "dnp") snapshot.practice_dnp += 1;
    else if (practiceBucket === "limited") snapshot.practice_limited += 1;
  }
  return index;
}

export function getTeamInjurySnapshot(index, season, week, team) {
  if (!team) return cloneSnapshot();
  const seasonNum = Number(season);
  const weekNum = Number(week);
  if (!Number.isFinite(seasonNum) || !Number.isFinite(weekNum) || weekNum < 1) {
    return cloneSnapshot();
  }
  const key = `${seasonNum}-${weekNum}-${team}`;
  const snapshot = index.get(key);
  return cloneSnapshot(snapshot);
}

export const ZERO_INJURY_SNAPSHOT = cloneSnapshot();
