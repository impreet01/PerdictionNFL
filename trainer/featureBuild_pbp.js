// trainer/featureBuild_pbp.js
// Aggregate play-by-play rows into team-week level EPA and success rate metrics.

const isReg = (v) => {
  if (v == null) return true;
  const s = String(v).trim().toUpperCase();
  return s === "" || s.startsWith("REG");
};

const num = (value, def = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
};

const normTeam = (value) => {
  if (!value) return null;
  const s = String(value).trim().toUpperCase();
  return s || null;
};

function ensure(map, key) {
  if (!map.has(key)) {
    map.set(key, {
      off_plays: 0,
      off_epa_sum: 0,
      off_success_sum: 0,
      def_plays: 0,
      def_epa_sum: 0,
      def_success_sum: 0
    });
  }
  return map.get(key);
}

const successValue = (raw, fallback) => {
  if (raw === true) return 1;
  if (raw === false) return 0;
  const n = Number(raw);
  if (Number.isFinite(n)) return n > 0 ? 1 : 0;
  return fallback;
};

export function aggregatePBP({ rows = [], season }) {
  const seasonNum = Number(season);
  const out = new Map();
  if (!Number.isFinite(seasonNum)) return out;

  for (const row of rows) {
    if (Number(row.season) !== seasonNum) continue;
    if (!isReg(row.season_type)) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;

    const posteam = normTeam(row.posteam ?? row.offense ?? row.offense_team);
    const defteam = normTeam(row.defteam ?? row.defense ?? row.defense_team);
    const epa = num(row.epa, 0);
    const success = successValue(row.success, epa > 0 ? 1 : 0);

    if (posteam) {
      const key = `${seasonNum}-${week}-${posteam}`;
      const rec = ensure(out, key);
      rec.off_plays += 1;
      rec.off_epa_sum += epa;
      rec.off_success_sum += success;
    }

    if (defteam) {
      const key = `${seasonNum}-${week}-${defteam}`;
      const rec = ensure(out, key);
      rec.def_plays += 1;
      rec.def_epa_sum += epa;
      rec.def_success_sum += success;
    }
  }

  for (const [key, rec] of out.entries()) {
    const offPlays = rec.off_plays || 0;
    const defPlays = rec.def_plays || 0;
    out.set(key, {
      off_epa_per_play: offPlays ? rec.off_epa_sum / offPlays : 0,
      off_success_rate: offPlays ? rec.off_success_sum / offPlays : 0,
      off_play_weight: offPlays,
      def_epa_per_play_allowed: defPlays ? rec.def_epa_sum / defPlays : 0,
      def_success_rate_allowed: defPlays ? rec.def_success_sum / defPlays : 0,
      def_play_weight: defPlays
    });
  }

  return out;
}

export default aggregatePBP;
