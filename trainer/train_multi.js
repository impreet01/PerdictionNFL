// trainer/train_multi.js
// Writes per-week artifacts ONLY up to the near-term:
// - Backtest for all weeks that exist in teamWeekly data
// - Forecast for exactly ONE upcoming week: lastCompletedWeek + 1
// Also writes season summary/index and current aliases.

import { loadSchedules, loadTeamWeekly } from "./dataSources.js";
import { buildFeatures } from "./featureBuild.js";
import { writeFileSync, mkdirSync } from "fs";
import LogisticRegression from "ml-logistic-regression";
import { DecisionTreeClassifier as CART } from "ml-cart";
import { Matrix } from "ml-matrix";

const ART_DIR = "artifacts";
mkdirSync(ART_DIR, { recursive: true });

const SEASON = Number(process.env.SEASON || new Date().getFullYear());
const WEEK_ENV = Number(process.env.WEEK || 6); // suggested target (from resolver); used as an upper bound, not to push far ahead

// Keep in sync with featureBuild.js
const FEATS = [
  "off_1st_down_s2d","off_total_yds_s2d","off_rush_yds_s2d","off_pass_yds_s2d","off_turnovers_s2d",
  "def_1st_down_s2d","def_total_yds_s2d","def_rush_yds_s2d","def_pass_yds_s2d","def_turnovers_s2d",
  "wins_s2d","losses_s2d","home",
  "sim_winrate_same_loc_s2d","sim_pointdiff_same_loc_s2d","sim_count_same_loc_s2d",
  "off_total_yds_s2d_minus_opp","def_total_yds_s2d_minus_opp",
  "off_turnovers_s2d_minus_opp","def_turnovers_s2d_minus_opp",
  "elo_pre","elo_diff","rest_days","rest_diff"
];

const isReg = (v) => {
  if (v == null) return true;
  const s = String(v).trim().toUpperCase();
  return s === "" || s.startsWith("REG");
};

function Xy(rows) {
  const X = rows.map(r => FEATS.map(k => Number(r[k] ?? 0)));
  const y = rows.map(r => Number(r.win));
  return { X, y };
}
function splitTrainTest(all, season, week) {
  const train = all.filter(r => r.season === season && r.week < week);
  const test  = all.filter(r => r.season === season && r.week === week);
  return { train, test };
}
const sigmoid = (z)=> 1/(1+Math.exp(-z));
const dot = (a,b)=> { let s=0; for (let i=0;i<a.length;i++) s += (a[i]||0)*(b[i]||0); return s; };
function toArray1D(theta){
  if (!theta) return [];
  if (Array.isArray(theta)) return theta.map(Number);
  if (typeof theta.to1DArray === "function") return theta.to1DArray().map(Number);
  if (typeof theta.toJSON === "function") return theta.toJSON().map(Number);
  return Array.from(theta).map(Number);
}
const vectorizeProba = (theta, X)=> {
  const w = toArray1D(theta);
  return X.map(x => sigmoid(dot(w, x)));
};
function safeLog(x, eps=1e-12){ return Math.log(Math.max(x, eps)); }
function logLoss(y, p){
  let s=0,eps=1e-12;
  for(let i=0;i<y.length;i++) s += -(y[i]*safeLog(p[i],eps) + (1-y[i])*safeLog(1-p[i],eps));
  return s/y.length;
}
function chooseHybridWeight(y, pL, pT){
  let bestW=0.6, bestLL=1e9;
  for(let w=0; w<=1.0001; w+=0.05){
    const ph = pL.map((p,i)=> w*p + (1-w)*pT[i]);
    const ll = logLoss(y, ph);
    if (ll < bestLL) { bestLL = ll; bestW = Number(w.toFixed(2)); }
  }
  return bestW;
}
const round3 = x => Math.round(Number(x)*1000)/1000;
const mean = a => a.reduce((s,v)=>s+v,0)/a.length;

function addDelta(lines, r, means, key, betterLow, label){
  const v = Number(r[key]), m = Number(means[key]);
  if (!Number.isFinite(v) || !Number.isFinite(m)) return;
  const d = v - m;
  const dir = d>=0 ? "higher" : "lower";
  const good = betterLow ? d<0 : d>0;
  lines.push(`${label} is ${dir} than league average by ${Math.abs(d).toFixed(1)} (${good ? "good" : "needs attention"}).`);
}
function explain(r, means, probs){
  const lines = [];
  addDelta(lines, r, means, "def_turnovers_s2d", false, "Defensive takeaways");
  addDelta(lines, r, means, "off_turnovers_s2d", true,  "Offensive giveaways");
  addDelta(lines, r, means, "off_total_yds_s2d", false, "Offensive total yards");
  addDelta(lines, r, means, "def_total_yds_s2d", true,  "Yards allowed");
  if (r.home) lines.push("Home-field advantage applies.");
  if (Number(r.sim_count_same_loc_s2d) > 0) {
    const wr = Number(r.sim_winrate_same_loc_s2d) * 100;
    const pd = Number(r.sim_pointdiff_same_loc_s2d);
    const cnt = Number(r.sim_count_same_loc_s2d);
    lines.push(`History vs similar opponents (same venue): win rate ${wr.toFixed(0)}% over ${cnt} games, avg point diff ${pd.toFixed(1)}.`);
  }
  addDelta(lines, r, means, "off_total_yds_s2d_minus_opp", false, "Offense vs opp (S2D differential)");
  addDelta(lines, r, means, "def_total_yds_s2d_minus_opp", true,  "Defense vs opp (S2D differential)");
  addDelta(lines, r, means, "off_turnovers_s2d_minus_opp", true,  "Giveaways vs opp (S2D differential)");
  addDelta(lines, r, means, "def_turnovers_s2d_minus_opp", false, "Takeaways vs opp (S2D differential)");
  const eloDiff = Number(r.elo_diff);
  if (Number.isFinite(eloDiff) && Math.abs(eloDiff) >= 25) lines.push(`Elo edge: ${eloDiff >= 0 ? "favorable" : "unfavorable"} by ${Math.abs(eloDiff).toFixed(0)} pts.`);
  const restDiff = Number(r.rest_diff);
  if (Number.isFinite(restDiff) && Math.abs(restDiff) >= 2) lines.push(`Rest edge: ${restDiff >= 0 ? "+" : ""}${restDiff} day(s) vs opponent.`);
  return `Logistic: ${(probs.logit*100).toFixed(1)}%. Tree: ${(probs.tree*100).toFixed(1)}%. Hybrid: ${(probs.hybrid*100).toFixed(1)}%. ` + lines.join(" ");
}

/** Find last fully-completed regular-season week in schedules (all games have scores). */
function computeLastCompletedWeek(schedules, season) {
  const reg = schedules.filter(g => Number(g.season)===season && isReg(g.season_type));
  const weeks = [...new Set(reg.map(g => Number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  let lastFull = 0;
  for (const w of weeks) {
    const games = reg.filter(g => Number(g.week)===w);
    const allDone = games.every(g => {
      const hs = Number(g.home_score ?? g.home_points ?? g.home_pts);
      const as = Number(g.away_score ?? g.away_points ?? g.away_pts);
      return Number.isFinite(hs) && Number.isFinite(as);
    });
    if (allDone) lastFull = w; else break;
  }
  return lastFull;
}

/** Forecast test rows for exactly week W from schedules + S2D through W-1. */
function buildForecastRowsForWeek(featRows, schedules, season, W) {
  const latestByTeam = new Map(); // team -> last row before W
  for (const r of featRows) {
    if (r.season !== season || r.week >= W) continue;
    const prev = latestByTeam.get(r.team);
    if (!prev || prev.week < r.week) latestByTeam.set(r.team, r);
  }

  const gamesW = schedules.filter(g =>
    Number(g.season) === season && isReg(g.season_type) && Number(g.week) === W
  );

  const rows = [];
  for (const g of gamesW) {
    const home = g.home_team, away = g.away_team;
    const dateStr = g.gameday || g.game_date || g.game_datetime || g.game_time || null;
    const game_date = dateStr ? new Date(dateStr) : null;

    const tHome = latestByTeam.get(home);
    const tAway = latestByTeam.get(away);
    if (!tHome || !tAway) continue;

    const lastHomeDate = tHome.game_date ? new Date(tHome.game_date) : null;
    const lastAwayDate = tAway.game_date ? new Date(tAway.game_date) : null;
    const rest_days_home = (game_date && lastHomeDate) ? Math.max(0, Math.round((game_date - lastHomeDate)/(1000*60*60*24))) : 0;
    const rest_days_away = (game_date && lastAwayDate) ? Math.max(0, Math.round((game_date - lastAwayDate)/(1000*60*60*24))) : 0;
    const diff = (a,b)=> (Number(a??0) - Number(b??0)) || 0;

    const baseHome = {
      season, week: W, team: home, opponent: away, home: 1,
      off_1st_down_s2d: tHome.off_1st_down_s2d, off_total_yds_s2d: tHome.off_total_yds_s2d,
      off_rush_yds_s2d: tHome.off_rush_yds_s2d, off_pass_yds_s2d: tHome.off_pass_yds_s2d,
      off_turnovers_s2d: tHome.off_turnovers_s2d, def_1st_down_s2d: tHome.def_1st_down_s2d,
      def_total_yds_s2d: tHome.def_total_yds_s2d, def_rush_yds_s2d: tHome.def_rush_yds_s2d,
      def_pass_yds_s2d: tHome.def_pass_yds_s2d, def_turnovers_s2d: tHome.def_turnovers_s2d,
      wins_s2d: tHome.wins_s2d, losses_s2d: tHome.losses_s2d,
      sim_winrate_same_loc_s2d: tHome.sim_winrate_same_loc_s2d ?? 0,
      sim_pointdiff_same_loc_s2d: tHome.sim_pointdiff_same_loc_s2d ?? 0,
      sim_count_same_loc_s2d: tHome.sim_count_same_loc_s2d ?? 0,
      off_total_yds_s2d_minus_opp: diff(tHome.off_total_yds_s2d, tAway.off_total_yds_s2d),
      def_total_yds_s2d_minus_opp: diff(tHome.def_total_yds_s2d, tAway.def_total_yds_s2d),
      off_turnovers_s2d_minus_opp:  diff(tHome.off_turnovers_s2d,  tAway.off_turnovers_s2d),
      def_turnovers_s2d_minus_opp:  diff(tHome.def_turnovers_s2d,  tAway.def_turnovers_s2d),
      rest_days: rest_days_home,
      rest_diff: rest_days_home - rest_days_away,
      elo_pre: tHome.elo_pre ?? 1500,
      elo_diff: (tHome.elo_pre ?? 1500) - (tAway.elo_pre ?? 1500),
      game_date: game_date ? game_date.toISOString() : null,
      win: 0
    };
    const baseAway = {
      season, week: W, team: away, opponent: home, home: 0,
      off_1st_down_s2d: tAway.off_1st_down_s2d, off_total_yds_s2d: tAway.off_total_yds_s2d,
      off_rush_yds_s2d: tAway.off_rush_yds_s2d, off_pass_yds_s2d: tAway.off_pass_yds_s2d,
      off_turnovers_s2d: tAway.off_turnovers_s2d, def_1st_down_s2d: tAway.def_1st_down_s2d,
      def_total_yds_s2d: tAway.def_total_yds_s2d, def_rush_yds_s2d: tAway.def_rush_yds_s2d,
      def_pass_yds_s2d: tAway.def_pass_yds_s2d, def_turnovers_s2d: tAway.def_turnovers_s2d,
      wins_s2d: tAway.wins_s2d, losses_s2d: tAway.losses_s2d,
      sim_winrate_same_loc_s2d: 0, sim_pointdiff_same_loc_s2d: 0, sim_count_same_loc_s2d: 0,
      off_total_yds_s2d_minus_opp: diff(tAway.off_total_yds_s2d, tHome.off_total_yds_s2d),
      def_total_yds_s2d_minus_opp: diff(tAway.def_total_yds_s2d, tHome.def_total_yds_s2d),
      off_turnovers_s2d_minus_opp:  diff(tAway.off_turnovers_s2d,  tHome.off_turnovers_s2d),
      def_turnovers_s2d_minus_opp:  diff(tAway.def_turnovers_s2d,  tHome.def_turnovers_s2d),
      rest_days: rest_days_away,
      rest_diff: rest_days_away - rest_days_home,
      elo_pre: tAway.elo_pre ?? 1500,
      elo_diff: (tAway.elo_pre ?? 1500) - (tHome.elo_pre ?? 1500),
      game_date: game_date ? game_date.toISOString() : null,
      win: 0
    };
    rows.push(baseHome, baseAway);
  }
  return rows;
}

(async function main() {
  console.log(`Rolling train for SEASON=${SEASON} (env WEEK=${WEEK_ENV})`);

  const schedules = await loadSchedules();
  const regSched = schedules.filter(g => Number(g.season) === SEASON && isReg(g.season_type));
  const schedWeeks = [...new Set(regSched.map(g => Number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  const schedMaxWeek = schedWeeks.length ? schedWeeks[schedWeeks.length-1] : 18;

  const lastCompletedWeek = computeLastCompletedWeek(schedules, SEASON);
  const forecastWeek = Math.min(schedMaxWeek, Math.max(2, lastCompletedWeek + 1, WEEK_ENV)); // never earlier than 2

  const teamWeekly = await loadTeamWeekly(SEASON);
  const teamWeeks = [...new Set(teamWeekly.filter(r => Number(r.season)===SEASON).map(r => Number(r.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  const teamMaxWeek = teamWeeks.length ? teamWeeks[teamWeeks.length-1] : 1;

  const prevTeamWeekly = await (async()=>{ try { return await loadTeamWeekly(SEASON - 1); } catch { return []; } })();

  // Full season feature table (handles Week-1 carry-in, Elo, similar-opponent, diffs)
  const featRows = buildFeatures({ teamWeekly, schedules, season: SEASON, prevTeamWeekly });
  const featWeeks = [...new Set(featRows.filter(r => r.season===SEASON).map(r => r.week))].sort((a,b)=>a-b);
  const featMaxWeek = featWeeks.length ? featWeeks[featWeeks.length-1] : 1;

  console.log(`Weeks in schedules: [${schedWeeks.join(", ")}], schedMax=${schedMaxWeek}`);
  console.log(`Last fully-completed week: ${lastCompletedWeek}, forecastWeek candidate: ${forecastWeek}`);
  console.log(`Weeks in teamWeekly: [${teamWeeks.join(", ")}], teamMax=${teamMaxWeek}`);
  console.log(`Weeks in feature table: [${featWeeks.join(", ")}], featMax=${featMaxWeek}`);

  // We will:
  // 1) Backtest all weeks 2..min(teamMaxWeek, featMaxWeek)
  // 2) Forecast exactly week = min(forecastWeek, schedMaxWeek), IF it is > teamMaxWeek (i.e., upcoming)
  const backtestMax = Math.max(2, Math.min(teamMaxWeek, featMaxWeek));
  const doForecast = forecastWeek > backtestMax ? forecastWeek : null;

  console.log(`Backtest weeks: 2..${backtestMax}${doForecast ? `; Forecast week: ${doForecast}` : ""}`);

  const seasonSummary = { season: SEASON, built_through_week: null, weeks: [], feature_names: FEATS };
  const seasonIndex = { season: SEASON, weeks: [] };
  let latestWeekWritten = null;

  // Helper: fit models on given train set
  function fitModels(train) {
    const { X: XL_raw, y: yL_raw } = Xy(train);
    const XL = new Matrix(XL_raw);
    const yL = Matrix.columnVector(yL_raw);

    const logit = new LogisticRegression({ numSteps: 2500, learningRate: 5e-3 });
    logit.train(XL, yL);

    const cart = new CART({ maxDepth: 4, minNumSamples: 30, gainFunction: "gini" });
    cart.train(XL_raw, yL_raw);

    const pL_train = vectorizeProba(logit.theta || logit.weights, XL_raw);
    const getProb1 = (pred) => Array.isArray(pred) ? pred[1] : Number(pred);
    const pT_train = cart.predict(XL_raw).map(getProb1);

    const wHybrid = chooseHybridWeight(yL_raw, pL_train, pT_train);
    return { logit, cart, wHybrid };
  }

  // ----- 1) BACKTEST 2..backtestMax -----
  for (let W=2; W<=backtestMax; W++) {
    const { train, test } = splitTrainTest(featRows, SEASON, W);
    if (!train.length || !test.length) {
      console.log(`W${W}: skip backtest (train=${train.length}, test=${test.length})`);
      continue;
    }

    const { logit, cart, wHybrid } = fitModels(train);

    const { X: Xtest_raw } = Xy(test);
    const pL_test = vectorizeProba(logit.theta || logit.weights, Xtest_raw);
    const getProb1 = (pred) => Array.isArray(pred) ? pred[1] : Number(pred);
    const pT_test = cart.predict(Xtest_raw).map(getProb1);
    const pH_test = pL_test.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_test[i]);

    const leagueMeans = {}; for (const k of FEATS) leagueMeans[k] = mean(train.map(r=> Number(r[k])));

    const results = test.map((r,i)=>{
      const game_id = `${r.season}-W${String(r.week).padStart(2,"0")}-${r.team}-${r.opponent}`;
      const probs = { logit: pL_test[i], tree: pT_test[i], hybrid: pH_test[i] };
      const english = explain(r, leagueMeans, probs);
      return {
        game_id,
        home_team: r.home ? r.team : r.opponent,
        away_team: r.home ? r.opponent : r.team,
        season: r.season,
        week: r.week,
        forecast: false,
        models: {
          logistic: { prob_win: round3(probs.logit) },
          decision_tree: { prob_win: round3(probs.tree) },
          hybrid: { prob_win: round3(probs.hybrid), weights: { logistic: wHybrid, tree: Number((1-wHybrid).toFixed(2)) } }
        },
        natural_language: english
      };
    });

    const predPath  = `${ART_DIR}/predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    const modelPath = `${ART_DIR}/model_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    writeFileSync(predPath, JSON.stringify(results, null, 2));
    writeFileSync(modelPath, JSON.stringify({
      season: SEASON, week: W, features: FEATS,
      hybrid_weight: wHybrid,
      logistic: (logit.theta && toArray1D(logit.theta)) || (logit.weights && toArray1D(logit.weights)) || null
    }, null, 2));
    console.log(`WROTE: ${predPath}`);
    console.log(`WROTE: ${modelPath}`);

    seasonSummary.weeks.push({ week: W, train_rows: train.length, test_rows: test.length, forecast: false, hybrid_weight: wHybrid });
    seasonSummary.built_through_week = W;
    seasonIndex.weeks.push({ week: W, predictions_file: `predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`, model_file: `model_${SEASON}_W${String(W).padStart(2,"0")}.json` });
    latestWeekWritten = W;
  }

  // ----- 2) FORECAST exactly one upcoming week (optional) -----
  if (doForecast) {
    const W = doForecast;
    const { train } = splitTrainTest(featRows, SEASON, W);
    if (train.length) {
      const { logit, cart, wHybrid } = fitModels(train);
      const testRows = buildForecastRowsForWeek(featRows, schedules, SEASON, W);
      if (testRows.length) {
        const { X: Xtest_raw } = Xy(testRows);
        const pL_test = vectorizeProba(logit.theta || logit.weights, Xtest_raw);
        const getProb1 = (pred) => Array.isArray(pred) ? pred[1] : Number(pred);
        const pT_test = cart.predict(Xtest_raw).map(getProb1);
        const pH_test = pL_test.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_test[i]);

        const leagueMeans = {}; for (const k of FEATS) leagueMeans[k] = mean(train.map(r=> Number(r[k])));

        const results = testRows.map((r,i)=>{
          const game_id = `${r.season}-W${String(r.week).padStart(2,"0")}-${r.team}-${r.opponent}`;
          const probs = { logit: pL_test[i], tree: pT_test[i], hybrid: pH_test[i] };
          const english = explain(r, leagueMeans, probs);
          return {
            game_id,
            home_team: r.home ? r.team : r.opponent,
            away_team: r.home ? r.opponent : r.team,
            season: r.season,
            week: r.week,
            forecast: true,
            models: {
              logistic: { prob_win: round3(probs.logit) },
              decision_tree: { prob_win: round3(probs.tree) },
              hybrid: { prob_win: round3(probs.hybrid), weights: { logistic: wHybrid, tree: Number((1-wHybrid).toFixed(2)) } }
            },
            natural_language: english
          };
        });

        const predPath  = `${ART_DIR}/predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`;
        const modelPath = `${ART_DIR}/model_${SEASON}_W${String(W).padStart(2,"0")}.json`;
        writeFileSync(predPath, JSON.stringify(results, null, 2));
        writeFileSync(modelPath, JSON.stringify({
          season: SEASON, week: W, features: FEATS,
          hybrid_weight: wHybrid,
          logistic: (logit.theta && toArray1D(logit.theta)) || (logit.weights && toArray1D(logit.weights)) || null
        }, null, 2));
        console.log(`WROTE (forecast): ${predPath}`);
        console.log(`WROTE (forecast): ${modelPath}`);

        seasonSummary.weeks.push({ week: W, train_rows: train.length, test_rows: testRows.length, forecast: true, hybrid_weight: wHybrid });
        seasonSummary.built_through_week = W;
        seasonIndex.weeks.push({ week: W, predictions_file: `predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`, model_file: `model_${SEASON}_W${String(W).padStart(2,"0")}.json` });
        latestWeekWritten = W;
      } else {
        console.log(`Forecast W${W}: no fixtures built; skipping.`);
      }
    } else {
      console.log(`Forecast W${W}: no training rows; skipping.`);
    }
  }

  // Write summary/index + "current" aliases
  const summaryPath = `${ART_DIR}/season_summary_${SEASON}_to_W${String(seasonSummary.built_through_week || 0).padStart(2,"0")}.json`;
  writeFileSync(summaryPath, JSON.stringify(seasonSummary, null, 2));
  console.log(`WROTE: ${summaryPath}`);

  const indexPath = `${ART_DIR}/season_index_${SEASON}.json`;
  writeFileSync(indexPath, JSON.stringify(seasonIndex, null, 2));
  console.log(`WROTE: ${indexPath}`);

  if (latestWeekWritten != null) {
    const predCurrentPath  = `${ART_DIR}/predictions_current.json`;
    const modelCurrentPath = `${ART_DIR}/model_current.json`;
    const predLatestPath   = `${ART_DIR}/predictions_${SEASON}_W${String(latestWeekWritten).padStart(2,"0")}.json`;
    const modelLatestPath  = `${ART_DIR}/model_${SEASON}_W${String(latestWeekWritten).padStart(2,"0")}.json`;

    const fs = await import("fs/promises");
    const predBuf  = await fs.readFile(predLatestPath,  { encoding: "utf8" });
    const modelBuf = await fs.readFile(modelLatestPath, { encoding: "utf8" });
    writeFileSync(predCurrentPath,  predBuf);
    writeFileSync(modelCurrentPath, modelBuf);

    console.log(`WROTE: ${predCurrentPath} (alias of ${predLatestPath})`);
    console.log(`WROTE: ${modelCurrentPath} (alias of ${modelLatestPath})`);
  } else {
    console.log("No weekly artifacts written; skipping current aliases.");
  }
})().catch(e=>{ console.error(e); process.exit(1); });
