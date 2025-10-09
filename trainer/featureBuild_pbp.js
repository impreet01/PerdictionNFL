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
      off_xyac_sum: 0,
      off_xyac_weight: 0,
      off_wp_sum: 0,
      off_wp_weight: 0,
      off_cpoe_sum: 0,
      off_cpoe_weight: 0,
      def_plays: 0,
      def_epa_sum: 0,
      def_success_sum: 0,
      def_xyac_sum: 0,
      def_xyac_weight: 0,
      def_wp_sum: 0,
      def_wp_weight: 0,
      def_cpoe_sum: 0,
      def_cpoe_weight: 0
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

  const toFinite = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const addMetric = (rec, sumKey, weightKey, value) => {
    const val = toFinite(value);
    if (val == null) return;
    rec[sumKey] += val;
    rec[weightKey] += 1;
  };

  for (const row of rows) {
    if (Number(row.season) !== seasonNum) continue;
    if (!isReg(row.season_type)) continue;
    const week = Number(row.week ?? row.game_week ?? row.week_number);
    if (!Number.isFinite(week)) continue;

    const posteam = normTeam(row.posteam ?? row.offense ?? row.offense_team);
    const defteam = normTeam(row.defteam ?? row.defense ?? row.defense_team);
    const epa = num(row.epa, 0);
    const success = successValue(row.success, epa > 0 ? 1 : 0);
    const xyac = toFinite(row.xyac_epa ?? row.xyAC_epa ?? row.xyacepa);
    const wp = toFinite(row.wp ?? row.win_probability);
    const cpoe = toFinite(row.cpoe ?? row.completion_pct_over_expected ?? row.cpoe_all);

    if (posteam) {
      const key = `${seasonNum}-${week}-${posteam}`;
      const rec = ensure(out, key);
      rec.off_plays += 1;
      rec.off_epa_sum += epa;
      rec.off_success_sum += success;
      addMetric(rec, 'off_xyac_sum', 'off_xyac_weight', xyac);
      addMetric(rec, 'off_wp_sum', 'off_wp_weight', wp);
      addMetric(rec, 'off_cpoe_sum', 'off_cpoe_weight', cpoe);
    }

    if (defteam) {
      const key = `${seasonNum}-${week}-${defteam}`;
      const rec = ensure(out, key);
      rec.def_plays += 1;
      rec.def_epa_sum += epa;
      rec.def_success_sum += success;
      addMetric(rec, 'def_xyac_sum', 'def_xyac_weight', xyac);
      addMetric(rec, 'def_wp_sum', 'def_wp_weight', wp);
      addMetric(rec, 'def_cpoe_sum', 'def_cpoe_weight', cpoe);
    }
  }

  for (const [key, rec] of out.entries()) {
    const offPlays = rec.off_plays || 0;
    const defPlays = rec.def_plays || 0;
    const offXyacWeight = rec.off_xyac_weight || 0;
    const offWpWeight = rec.off_wp_weight || 0;
    const offCpoeWeight = rec.off_cpoe_weight || 0;
    const defXyacWeight = rec.def_xyac_weight || 0;
    const defWpWeight = rec.def_wp_weight || 0;
    const defCpoeWeight = rec.def_cpoe_weight || 0;
    out.set(key, {
      off_epa_per_play: offPlays ? rec.off_epa_sum / offPlays : 0,
      off_success_rate: offPlays ? rec.off_success_sum / offPlays : 0,
      off_play_weight: offPlays,
      off_xyac_epa_per_play: offXyacWeight ? rec.off_xyac_sum / offXyacWeight : 0,
      off_xyac_weight: offXyacWeight,
      off_wp_mean: offWpWeight ? rec.off_wp_sum / offWpWeight : 0,
      off_wp_weight: offWpWeight,
      off_cpoe_mean: offCpoeWeight ? rec.off_cpoe_sum / offCpoeWeight : 0,
      off_cpoe_weight: offCpoeWeight,
      def_epa_per_play_allowed: defPlays ? rec.def_epa_sum / defPlays : 0,
      def_success_rate_allowed: defPlays ? rec.def_success_sum / defPlays : 0,
      def_play_weight: defPlays,
      def_xyac_epa_per_play_allowed: defXyacWeight ? rec.def_xyac_sum / defXyacWeight : 0,
      def_xyac_weight: defXyacWeight,
      def_wp_mean_allowed: defWpWeight ? rec.def_wp_sum / defWpWeight : 0,
      def_wp_weight: defWpWeight,
      def_cpoe_mean_allowed: defCpoeWeight ? rec.def_cpoe_sum / defCpoeWeight : 0,
      def_cpoe_weight: defCpoeWeight
    });
  }

  return out;
}

export default aggregatePBP;
