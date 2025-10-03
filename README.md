# NFL Win Predictor (Free Stack)

Train, evaluate, and serve NFL win probabilities using only open nflverse data — no paid feeds, no Python, and deployable on the free tier of Cloudflare Workers.

## Highlights
- **Ensemble modeling**: blends gradient-trained logistic regression, CART decision trees with Laplace smoothing, a Bradley–Terry matchup model, and a compact ANN committee with Platt calibration for in-season weeks.
- **Rich feature engineering**: season-to-date, rolling-window, and exponentially weighted metrics from team stats, play-by-play EPA/success-rate aggregates, and player usage shares (RB rush, WR/TE target, QB air yards & sack rate).
- **Robust data ingest**: redundant mirrors for schedules, team, player, advanced team-game, and play-by-play datasets to survive nflverse hosting changes, with optional logging via `LOG_LEVEL`.
- **Automated diagnostics**: weekly artifacts capture calibration bins, blend weights, metric dashboards, and season summaries to monitor drift over time.
- **Action-ready API**: Cloudflare Worker auto-selects the freshest `artifacts/predictions_YYYY_WW.json` for `/predict_week`, matching the bundled `openapi.yaml` for Custom GPT Actions.

## Repository layout
- `trainer/` – data loaders, feature builders, models, ensemble trainer, and smoke/backtest scripts.
- `api/worker.js` – Cloudflare Worker that reads the `artifacts/` folder from GitHub to serve predictions.
- `worker/` – worker deployment helpers (if you mirror this repo structure).
- `artifacts/` – sample outputs from the ensemble trainer (models, predictions, metrics, summaries).
- `openapi.yaml` – schema for wiring the Worker into a GPT Action.

## Quick start
1. Fork/clone the repo and run `npm install` (Node 18+ required).
2. Set optional environment overrides:
   - `SEASON` (defaults to current year)
   - `WEEK` (defaults to 6; the trainer iterates from Week 1 up to this value if historical data exists)
   - `ANN_SEEDS`, `ANN_MAX_EPOCHS`, `BT_B`, etc. to tune ensemble search.
3. Run the full ensemble trainer:
   ```bash
   npm run train:multi
   ```
   This downloads nflverse data, builds features, fits every model, calibrates the blend, and writes artifacts under `artifacts/` for each completed week up to `WEEK`.
4. (Optional) Run the legacy single-week trainer for the logistic/tree hybrid only:
   ```bash
   npm run train
   ```

GitHub Actions can automate Step 3 on a schedule; copy `.github/workflows/train.yml`, set secrets if required, and enable Actions in your fork.

## Produced artifacts
Each successful `train:multi` run refreshes or adds:

| File | Description |
| --- | --- |
| `predictions_<season>_W<week>.json` | Per-game ensemble probabilities with component breakdowns and natural language context.|
| `model_<season>_W<week>.json` | Serialized model weights, blend parameters, and scaler metadata for replaying predictions.|
| `diagnostics_<season>_W<week>.json` | Blend weights, calibration bins, and per-model metrics for the most recent training window.|
| `outcomes_<season>_W<week>.json` | Joined predictions with actual results for metric computation.|
| `metrics_<season>_W<week>.json` | Weekly evaluation payload (log loss, Brier, AUC, accuracy, calibration) for dashboards or alerts.|
| `metrics_<season>.json` | Season-to-date rollup of every model’s performance through the latest completed week.|
| `season_index_<season>.json` | Status view of which artifacts exist for each week (useful for Workers/UI).|
| `season_summary_<season>.json` | High-level overview combining metrics, diagnostics, and metadata for external reporting.|
| `bt_features_<season>_W<week>.json` | Bradley–Terry feature matrix for audit/backtests.|

## Data sources
`trainer/dataSources.js` now caches downloads per season and gracefully falls back across multiple nflverse mirrors/releases for:
- Schedules/games (`schedules_<season>.csv` fallback to `games.csv`)
- Team weekly stats (`stats_team_week_<season>.csv`)
- Player weekly stats (`stats_player_week_<season>.csv`)
- Team game advanced stats (`stats_team_game_<season>.csv`)
- Play-by-play (`play_by_play_<season>.csv.gz`)
- Weekly rosters, depth charts, injuries, snap counts, and officials for context packs
- ESPN Total QBR and Pro-Football-Reference advanced team metrics for quarterback and efficiency context

See `docs/data-ingestion.md` for a quick reference to every nflverse dataset we pull and how to extend the loaders. Set `LOG_LEVEL=debug` to trace which mirrors respond during a run.

## Deployment
Deploy `api/worker.js` to Cloudflare Workers, editing the `REPO_USER`, `REPO_NAME`, and `BRANCH` constants to point at your fork. The Worker lists the `artifacts/` directory via the GitHub API and serves the newest available predictions when `season` or `week` is omitted, enabling the bundled `openapi.yaml` to power a Custom GPT Action or any HTTP client.

## Validation & monitoring
- `npm run train:multi` writes calibration bins and blend weights per week so you can chart drift over time.
- `trainer/tests/backtest.js` replays recent weeks to ensure the ensemble beats its components and remains calibrated; run with `node trainer/tests/backtest.js` (optionally pass `SEASON`/`BACKTEST_WEEKS`).
- `trainer/tests/smoke.js` is a minimal sanity check that loads data and ensures feature pipelines don’t throw.

Use these artifacts alongside your observability stack (S3, BigQuery, etc.) or feed them into dashboards to detect regressions early.
