// trainer/train_multi.js
// Training + forecasting pipeline with early-season-stable hybrid,
// per-game explanations, and home-view de-duplicated outputs.

import { loadSchedules, loadTeamWeekly } from "./dataSources.js";
import { buildFeatures, FEATS } from "./featureBuild.js";
import { writeFileSync, mkdirSync } from "fs";
import { DecisionTreeClassifier as CART } from "ml-cart";

const ART_DIR = "artifacts";
mkdirSync(ART_DIR, { recursive: true });

const SEASON = Number(process.env.SEASON || new Date().getFullYear());
const WEEK_ENV = Number(process.env.WEEK || 6);

function isReg(v){ if (v == null) return true; const s=String(v).trim().toUpperCase(); return s==="" || s.startsWith("REG"); }
const sigmoid = z => 1/(1+Math.exp(-z));
const dot = (a,b)=> { let s=0; for (let i=0;i<a.length;i++) s += (a[i]||0)*(b[i]||0); return s; };
const round3 = x => Math.round(Number(x)*1000)/1000;
const mean = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;

function Xy(rows){ const X = rows.map(r => FEATS.map(k => Number(r[k] ?? 0))); const y = rows.map(r => Number(r.win)); return { X, y }; }
function splitTrainTest(all, season, week){
  const train = all.filter(r => r.season===season && r.week <  week && (r.win===0 || r.win===1));
  const test  = all.filter(r => r.season===season && r.week === week);
  return { train, test };
}

function fitScaler(X){
  const d = X[0]?.length || 0; const mu=new Array(d).fill(0), sd=new Array(d).fill(1);
  const n = Math.max(1,X.length);
  for (let j=0;j<d;j++){ let s=0; for (let i=0;i<X.length;i++) s+=X[i][j]; mu[j]=s/n; }
  for (let j=0;j<d;j++){ let s=0; for (let i=0;i<X.length;i++){ const v=X[i][j]-mu[j]; s+=v*v; } sd[j]=Math.sqrt(s/n)||1; }
  return { mu, sd };
}
const applyScaler = (X,{mu,sd}) => X.map(r => r.map((v,j)=>(v-mu[j])/(sd[j]||1)));

function trainLogisticGD(X, y, { steps=3000, lr=5e-3, l2=2e-4 } = {}){
  const n = X.length, d = X[0]?.length || 0; let w=new Array(d).fill(0), b=0;
  for (let t=0;t<steps;t++){
    let gb=0; const gw=new Array(d).fill(0);
    for (let i=0;i<n;i++){ const z=dot(w,X[i])+b, p=sigmoid(z), e=p-y[i]; gb+=e; for (let j=0;j<d;j++) gw[j]+= e*X[i][j]; }
    for (let j=0;j<d;j++) gw[j]+= l2*w[j];
    b -= (lr*gb/n); for (let j=0;j<d;j++) w[j] -= (lr*gw[j]/n);
  }
  return { w, b };
}
const predictLogit = (X,{w,b}) => X.map(x => sigmoid(dot(w,x)+b));

// CART leaf probabilities with Laplace smoothing
function leafPath(root, x){
  let node=root, path="";
  for (let guard=0; guard<200; guard++){
    const isLeaf = (!node.left && !node.right) || node.type==="leaf";
    if (isLeaf) return path||"ROOT";
    const col = node.splitColumn ?? node.attribute ?? node.index ?? node.feature ?? null;
    const thr = node.splitValue  ?? node.threshold ?? node.split  ?? null;
    if (col==null || thr==null) return path||"ROOT";
    const val = Number(x[col]??0); const goLeft = val <= Number(thr);
    path += goLeft ? "L":"R"; node = goLeft ? node.left : node.right; if (!node) return path;
  }
  return path||"ROOT";
}
function buildLeafFreq(cart, Xtr, ytr, alpha=4){
  let json; try { json=cart.toJSON(); } catch { json=null; }
  const root = json?.root || json; const freq=new Map();
  if (!root){
    const n1=ytr.reduce((s,v)=>s+(v?1:0),0), n0=ytr.length-n1;
    freq.set("ROOT",{n0,n1,alpha});
    return {root:null,freq,alpha};
  }
  for (let i=0;i<Xtr.length;i++){
    const p=leafPath(root,Xtr[i]); const f=freq.get(p)||{n0:0,n1:0,alpha};
    if (ytr[i]===1) f.n1++; else f.n0++; freq.set(p,f);
  }
  return { root, freq, alpha };
}
function predictTree(cart, leafStats, X){
  const { root, freq, alpha } = leafStats;
  if (!root){
    const f=freq.get("ROOT")||{n0:0,n1:0,alpha:4}; const tot=f.n0+f.n1; const p1=(f.n1+alpha)/(tot+2*alpha)||0.5;
    return X.map(()=>p1);
  }
  return X.map(x=>{
    const p=leafPath(root,x); const f=freq.get(p);
    if (!f){ return 0.5; }
    const tot=f.n0+f.n1; return (f.n1 + alpha)/(tot + 2*alpha);
  });
}

// 5-fold CV for hybrid weight with early-season clamp
function kfoldIndices(n, k=5){
  const idx = Array.from({length:n}, (_,i)=>i);
  const folds = Array.from({length:k}, ()=>[]);
  for (let i=0;i<n;i++) folds[i%k].push(idx[i]);
  return folds;
}
function chooseHybridCV(X, y){
  const folds = kfoldIndices(X.length, Math.min(5, Math.max(2, Math.floor(X.length/8))));
  const weights = Array.from({length:21}, (_,i)=> i*0.05);
  const losses = new Array(weights.length).fill(0);

  for (const valIdx of folds){
    const trainIdx = new Set(Array.from({length:X.length},(_,i)=>i).filter(i=>!valIdx.includes(i)));
    const Xtr = [], ytr = [], Xva = [], yva = [];
    for (let i=0;i<X.length;i++){
      if (trainIdx.has(i)){ Xtr.push(X[i]); ytr.push(y[i]); } else { Xva.push(X[i]); yva.push(y[i]); }
    }
    const scaler = fitScaler(Xtr);
    const XtrS = applyScaler(Xtr, scaler);
    const XvaS = applyScaler(Xva, scaler);

    const pos = ytr.reduce((s,v)=>s+(v?1:0),0); const neg = ytr.length - pos;
    let logit;
    if (pos===0 || neg===0){
      const prior = pos/Math.max(1,pos+neg);
      const b = Math.log((prior+1e-9)/(1-prior+1e-9));
      logit = { w: new Array(XtrS[0].length).fill(0), b };
    } else {
      logit = trainLogisticGD(XtrS, ytr, { steps: 3000, lr: 5e-3, l2: 2e-4 });
    }
    const cart = new CART({ maxDepth: 5, minNumSamples: 10, gainFunction: "gini" });
    cart.train(XtrS, ytr);
    const leafStats = buildLeafFreq(cart, XtrS, ytr, 4);

    const pL = predictLogit(XvaS, logit);
    const pT = predictTree(cart, leafStats, XvaS);
    for (let wi=0; wi<weights.length; wi++){
      const w = weights[wi];
      let ll=0, eps=1e-12;
      for (let i=0;i<XvaS.length;i++){
        const ph = w*pL[i] + (1-w)*pT[i];
        ll += -(yva[i]*Math.log(Math.max(ph,eps)) + (1-yva[i])*Math.log(Math.max(1-ph,eps)));
      }
      losses[wi] += ll / Math.max(1,XvaS.length);
    }
  }
  let bestW = 0.5, bestL = Infinity;
  weights.forEach((w,i)=>{ if (losses[i] < bestL){ bestL = losses[i]; bestW = w; } });
  return Number(bestW.toFixed(2));
}

// helpers: league means & per-game NL explanation
function leagueMeans(rows){ const m={}; for (const k of FEATS){ m[k]=mean(rows.map(r=>Number(r[k]||0))); } return m; }
function gamesPlayed(r){ const w=Number(r.wins_s2d||0), l=Number(r.losses_s2d||0); return Math.max(1, w+l); }
function explain(r, probs, means){
  const lines=[];
  const add=(key, lowIsGood, label)=>{
    const gp = gamesPlayed(r);
    const v=Number(r[key])/gp, m=Number(means[key])/gp;
    if (!Number.isFinite(v)||!Number.isFinite(m)) return;
    const d=v-m, dir = d>=0?"higher":"lower"; const good = lowIsGood ? d<0 : d>0;
    lines.push(`${label} per game is ${dir} than league average by ${Math.abs(d).toFixed(1)} (${good?"good":"needs attention"}).`);
  };
  add("def_turnovers_s2d", false, "Defensive takeaways");
  add("off_turnovers_s2d", true,  "Offensive giveaways");
  add("off_total_yds_s2d", false, "Offensive total yards");
  add("def_total_yds_s2d", true,  "Yards allowed");
  if (r.home) lines.push("Home-field advantage applies.");
  const rd=Number(r.rest_diff); if (Number.isFinite(rd)&&Math.abs(rd)>=2){ lines.push(`Rest edge: ${rd>=0?"+":""}${rd} day(s).`); }
  return `Logistic: ${(probs.logit*100).toFixed(1)}%. Tree: ${(probs.tree*100).toFixed(1)}%. Hybrid: ${(probs.hybrid*100).toFixed(1)}%. `+lines.join(" ");
}
function toResult(r, probs, forecast, wHybrid, trainRows){
  const means = leagueMeans(trainRows);
  return {
    game_id: `${r.season}-W${String(r.week).padStart(2,"0")}-${r.team}-${r.opponent}`,
    home_team: r.home ? r.team : r.opponent,
    away_team: r.home ? r.opponent : r.team,
    season: r.season,
    week: r.week,
    forecast,
    models: {
      logistic:      { prob_win: round3(probs.logit) },
      decision_tree: { prob_win: round3(probs.tree) },
      hybrid:        { prob_win: round3(probs.hybrid), weights: { logistic: wHybrid, tree: Number((1-wHybrid).toFixed(2)) } }
    },
    natural_language: explain(r, probs, means)
  };
}

// forecast missing fixtures in a target week W using last known S2D snapshots
function forecastMissingForWeek(W, regSched, SEASON, trainRows, testRows){
  const presentPairs = new Set(testRows.map(r => (r.home ? `${r.team}@${r.opponent}` : `${r.opponent}@${r.team}`)));
  const regPairs = regSched.filter(g=>Number(g.week)===W).map(g => `${g.home_team}@${g.away_team}`);
  const missing = regPairs.filter(k => !presentPairs.has(k));
  if (!missing.length) return [];

  const lastByTeam = new Map();
  for (const r of trainRows){
    if (r.season!==SEASON) continue;
    const key = r.team;
    const prev = lastByTeam.get(key);
    if (!prev || r.week > prev.week) lastByTeam.set(key, r);
  }

  const rows = [];
  for (const m of missing){
    const [home, away] = m.split("@");
    const hPrev = lastByTeam.get(home);
    const aPrev = lastByTeam.get(away);
    if (!hPrev || !aPrev) continue;

    const clone = (src, team, opp, isHome) => {
      const r = { season: SEASON, week: W, team, opponent: opp, home: isHome?1:0, game_date: null, win: null };
      for (const f of FEATS){
        if (f === "home") { r.home = isHome?1:0; continue; }
        r[f] = Number(src[f] ?? 0);
      }
      // refresh opponent-diff features
      const me = r, op = isHome ? aPrev : hPrev;
      me.off_total_yds_s2d_minus_opp = Number(me.off_total_yds_s2d) - Number(op.off_total_yds_s2d);
      me.def_total_yds_s2d_minus_opp = Number(me.def_total_yds_s2d) - Number(op.def_total_yds_s2d);
      me.off_turnovers_s2d_minus_opp = Number(me.off_turnovers_s2d)  - Number(op.off_turnovers_s2d);
      me.def_turnovers_s2d_minus_opp = Number(me.def_turnovers_s2d)  - Number(op.def_turnovers_s2d);
      return r;
    };
    rows.push(clone(hPrev, home, away, true));
    rows.push(clone(aPrev, away, home, false));
  }
  return rows;
}

// de-dupe to one row per matchup (home view)
function dedupeToHomeView(items) {
  const seen = new Set();
  const out = [];
  for (const r of items) {
    const key = `${r.season}-W${String(r.week).padStart(2,'0')}-${r.home_team}-${r.away_team}`;
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}

(async function main(){
  console.log(`Rolling train for SEASON=${SEASON} (env WEEK=${WEEK_ENV})`);

  const schedules = await loadSchedules();
  const teamWeekly = await loadTeamWeekly(SEASON);
  const prevTeamWeekly = await (async()=>{ try { return await loadTeamWeekly(SEASON-1); } catch { return []; } })();

  const regSched = schedules.filter(g => Number(g.season)===SEASON && isReg(g.season_type));
  const schedWeeks = [...new Set(regSched.map(g => Number(g.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  const maxSchedWeek = schedWeeks.length ? schedWeeks[schedWeeks.length-1] : 18;

  const twWeeks = [...new Set((teamWeekly||[]).filter(r=>Number(r.season)===SEASON).map(r=>Number(r.week)).filter(Number.isFinite))].sort((a,b)=>a-b);
  const maxWeekAvail = twWeeks.length ? twWeeks[twWeeks.length-1] : 1;

  const featRows = buildFeatures({ teamWeekly, schedules, season: SEASON, prevTeamWeekly });
  console.log(`Built feature rows: ${featRows.length} | data weeks: ${JSON.stringify(twWeeks)}`);

  const MAX_WEEK = Math.min(WEEK_ENV, Math.max(2, maxWeekAvail + 1), maxSchedWeek);
  console.log(`Train/predict through WEEK ${MAX_WEEK} (cap env=${WEEK_ENV}, data+1=${maxWeekAvail+1}, sched=${maxSchedWeek})`);

  const seasonSummary = { season: SEASON, built_through_week: null, weeks: [], feature_names: FEATS };
  const seasonIndex = { season: SEASON, weeks: [] };
  let latestWeekWritten = null;

  function runWeek(W){
    const { train, test } = splitTrainTest(featRows, SEASON, W);
    const pos = train.reduce((s,r)=> s+(r.win?1:0),0);
    const neg = train.length - pos;
    console.log(`W${W}: train rows=${train.length} pos=${pos} neg=${neg} pos_rate=${train.length?(pos/train.length).toFixed(3):"n/a"}`);
    if (!train.length) return null;

    const { X: XtrRaw } = Xy(train);
    const ytr = train.map(r=>r.win);
    const scaler = fitScaler(XtrRaw);
    const Xtr = applyScaler(XtrRaw, scaler);

    // logistic
    let logit;
    if (pos===0 || neg===0){
      const prior = pos/Math.max(1,pos+neg);
      const b = Math.log((prior+1e-9)/(1-prior+1e-9));
      logit = { w: new Array(Xtr[0].length).fill(0), b };
      console.log(`W${W}: logistic prior-only (single class), prior=${prior.toFixed(3)}`);
    } else {
      logit = trainLogisticGD(Xtr, ytr, { steps: 3500, lr: 4e-3, l2: 2e-4 });
    }

    // tree (richer + smoothed)
    const cart = new CART({ maxDepth: 5, minNumSamples: 10, gainFunction: "gini" });
    cart.train(Xtr, ytr);
    const leafStats = buildLeafFreq(cart, Xtr, ytr, 4);

    // hybrid by CV, then clamp early-season for stability
    const wCV = chooseHybridCV(Xtr, ytr);
    let wHybrid = wCV;
    if (ytr.length < 96) { // < ~3 weeks of full slate
      if (wHybrid < 0.35) wHybrid = 0.35;
      if (wHybrid > 0.65) wHybrid = 0.65;
    }
    wHybrid = Number(wHybrid.toFixed(2));

    // backtest on observed rows of W
    const { X: XteRaw } = Xy(test);
    const Xte = applyScaler(XteRaw, scaler);
    const pL_back = predictLogit(Xte, logit);
    const pT_back = predictTree(cart, leafStats, Xte);
    const pH_back = pL_back.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_back[i]);
    const back = test.map((r,i)=> toResult(r, { logit:pL_back[i], tree:pT_back[i], hybrid:pH_back[i] }, false, wHybrid, train));

    // forecast rest of week W
    const foreRows = forecastMissingForWeek(W, regSched, SEASON, train, test);
    const { X: XfRaw } = Xy(foreRows);
    const Xf = applyScaler(XfRaw, scaler);
    const pL_f = predictLogit(Xf, logit);
    const pT_f = predictTree(cart, leafStats, Xf);
    const pH_f = pL_f.map((p,i)=> wHybrid*p + (1-wHybrid)*pT_f[i]);
    const fore = foreRows.map((r,i)=> toResult(r, { logit:pL_f[i], tree:pT_f[i], hybrid:pH_f[i] }, true, wHybrid, train));

    return { results: [...back, ...fore], scaler, wHybrid, logit };
  }

  for (let W=2; W<=MAX_WEEK; W++){
    const res = runWeek(W);
    if (!res) continue;
    const { results, scaler, wHybrid, logit } = res;

    const resultsDeduped = dedupeToHomeView(results);

    const predPath  = `${ART_DIR}/predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    const modelPath = `${ART_DIR}/model_${SEASON}_W${String(W).padStart(2,"0")}.json`;
    writeFileSync(predPath, JSON.stringify(resultsDeduped, null, 2));
    writeFileSync(modelPath, JSON.stringify({
      season: SEASON, week: W, features: FEATS, hybrid_weight: wHybrid,
      logistic: { weights: logit.w, intercept: logit.b }, scaler
    }, null, 2));
    console.log(`WROTE: ${predPath}`);
    console.log(`WROTE: ${modelPath}`);

    seasonSummary.weeks.push({
      week: W,
      train_rows: resultsDeduped.filter(r=>!r.forecast).length,
      forecast: resultsDeduped.some(r=>r.forecast),
      hybrid_weight: wHybrid
    });
    seasonSummary.built_through_week = W;
    seasonIndex.weeks.push({
      week: W,
      predictions_file: `predictions_${SEASON}_W${String(W).padStart(2,"0")}.json`,
      model_file:       `model_${SEASON}_W${String(W).padStart(2,"0")}.json`
    });
    latestWeekWritten = W;
  }

  writeFileSync(`${ART_DIR}/season_index_${SEASON}.json`, JSON.stringify(seasonIndex, null, 2));
  writeFileSync(`${ART_DIR}/season_summary_${SEASON}_to_W${String(seasonSummary.built_through_week || 0).padStart(2,"0")}.json`, JSON.stringify(seasonSummary, null, 2));
  console.log(`WROTE: season_index_${SEASON}.json and season_summary_*`);

  if (latestWeekWritten != null) {
    const fs = await import("fs/promises");
    const predSrc  = `${ART_DIR}/predictions_${SEASON}_W${String(latestWeekWritten).padStart(2,"0")}.json`;
    const modelSrc = `${ART_DIR}/model_${SEASON}_W${String(latestWeekWritten).padStart(2,"0")}.json`;
    writeFileSync(`${ART_DIR}/predictions_current.json`, await fs.readFile(predSrc,  "utf8"));
    writeFileSync(`${ART_DIR}/model_current.json`,      await fs.readFile(modelSrc, "utf8"));
    console.log(`WROTE: artifacts/*_current.json aliases`);
  }
})().catch(e=>{ console.error(e); process.exit(1); });
