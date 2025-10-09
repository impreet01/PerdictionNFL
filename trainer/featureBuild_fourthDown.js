// trainer/featureBuild_fourthDown.js
// Aggregate fourth-down decision model outputs into team-week features.

const normTeam = (value) => {
  if (!value) return null;
  const s = String(value).trim().toUpperCase();
  return s || null;
};

const toFinite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizeDecision = (value) => {
  if (!value && value !== 0) return null;
  const str = String(value).trim().toLowerCase();
  if (!str) return null;
  if (["go", "go for it", "go_for_it", "go-for-it"].includes(str)) return "go";
  if (["punt", "punts"].includes(str)) return "punt";
  if (["fg", "field goal", "field_goal", "kick", "kick_fg"].includes(str)) return "kick";
  if (["kneel", "qb kneel"].includes(str)) return "kneel";
  return str;
};

function ensure(map, key) {
  if (!map.has(key)) {
    map.set(key, {
      attempts: 0,
      aligned: 0,
      alignedDeltaSum: 0,
      alignedCount: 0,
      mismatchDeltaSum: 0,
      mismatchCount: 0
    });
  }
  return map.get(key);
}

export function aggregateFourthDown({ rows = [], season }) {
  const seasonNum = Number(season);
  const out = new Map();
  if (!Number.isFinite(seasonNum)) return out;

  for (const row of rows) {
    if (Number(row.season) !== seasonNum) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;
    const team = normTeam(row.posteam ?? row.offense ?? row.team);
    if (!team) continue;

    const rec = ensure(out, `${seasonNum}-${week}-${team}`);
    rec.attempts += 1;

    const recommendation = normalizeDecision(
      row.recommendation ?? row.recommended ?? row.recommended_play ?? row.nfl4th_recommendation
    );
    const actual = normalizeDecision(row.actual_play ?? row.actual ?? row.play_call ?? row.decision_actual);
    const delta = toFinite(row.delta_wp ?? row.delta ?? row.wp_delta ?? row.decision_delta_wp) ?? 0;

    if (recommendation && actual && recommendation === actual) {
      rec.aligned += 1;
      rec.alignedDeltaSum += delta;
      rec.alignedCount += 1;
    } else {
      rec.mismatchDeltaSum += delta;
      rec.mismatchCount += 1;
    }
  }

  for (const [key, rec] of out.entries()) {
    const attempts = rec.attempts || 0;
    const alignedCount = rec.alignedCount || 0;
    const mismatchCount = rec.mismatchCount || 0;
    out.set(key, {
      fourth_down_attempts: attempts,
      fourth_down_align_rate: attempts ? rec.aligned / attempts : 0,
      fourth_down_align_weight: attempts,
      fourth_down_aligned_delta_wp: alignedCount ? rec.alignedDeltaSum / alignedCount : 0,
      fourth_down_aligned_weight: alignedCount,
      fourth_down_mismatch_delta_wp: mismatchCount ? rec.mismatchDeltaSum / mismatchCount : 0,
      fourth_down_mismatch_weight: mismatchCount
    });
  }

  return out;
}

export default aggregateFourthDown;
