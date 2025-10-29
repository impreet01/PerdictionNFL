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
   - `ROTOWIRE_ENABLED` (`true` is required for the Rotowire injury fetcher to run and write artifacts)
3. Run the full ensemble trainer:
   ```bash
   npm run train:multi
   ```
   This downloads nflverse data, consumes the Rotowire injury artifacts, builds features, fits every model, calibrates the blend, and writes artifacts under `artifacts/` for each completed week up to `WEEK`.
4. (Optional) Run the legacy single-week trainer for the logistic/tree hybrid only:
   ```bash
   npm run train
   ```

## Scheduled workflow helper

Automations that need to refresh context artifacts, resume the ensemble, and
apply hybrid recalibration in one pass can use the bundled helper:

```bash
npm run train:workflow
```

The script replays the playbook captured in
[`docs/training-workflow.md`](docs/training-workflow.md): it optionally refreshes
Rotowire snapshots, confirms the cached bootstrap revision, runs the ensemble
trainer, and triggers `trainer/hybrid_v2.js` for the next outstanding week based
on `artifacts/training_state.json`. If that file is missing you can rebuild it
from committed artifacts with `npm run bootstrap:state`. Use `--skip-fetch`,
`--fetch-only`, or `--dry-run` flags to tailor behaviour for local versus CI
runs. It defaults to `npm run train:multi`, but you can target the legacy
single-week trainer by passing `--trainer=train`. The direct `npm run train` and
`npm run train:multi` scripts continue to work independently when you don't need
the extra guardrails from the workflow helper.

GitHub Actions can automate Step 3 on a schedule; copy `.github/workflows/train.yml`, set secrets if required, and enable Actions in your fork.

## Rotowire ingestion workflow

Injury and betting market context both ship from Rotowire scraper artifacts emitted by the scripts under `scripts/`. Refresh them before generating context packs or rerunning training so the trainer has the latest reports and odds snapshot:

1. Set `ROTOWIRE_ENABLED=true` in your shell (required for the fetchers to execute).
2. Run the injury fetcher for the target snapshot (pass any season/week you need):
   ```bash
   npm run fetch:injuries -- --season=2025 --week=6
   ```
   The script throttles between team requests, parses the Rotowire HTML table, and writes `artifacts/injuries_<season>_W<week>.json` plus `artifacts/injuries_current.json`.
3. Run the betting markets fetcher for the same snapshot:
   ```bash
   npm run fetch:markets -- --season=2025 --week=6
   ```
   This pulls the Rotowire betting tables, normalises prices/lines, and writes `artifacts/markets_<season>_W<week>.json` plus `artifacts/markets_current.json`.
4. Capture the weather forecasts from Rotowire's daily report:
   ```bash
   npm run fetch:weather -- --season=2025 --week=6
   ```
   The scraper parses `https://www.rotowire.com/football/weather.php`, extracts per-game conditions, and writes `artifacts/weather_<season>_W<week>.json` alongside `artifacts/weather_current.json` for the latest snapshot.
5. Re-run `npm run build:context` or `npm run train:multi` so the refreshed artifacts flow into summaries, per-game context, and ensemble training.

## Cumulative training

Run the cumulative trainer week by week or in batches using the bundled helper scripts:

```bash
# Single week (uses cumulative history automatically)
SEASON=2025 BATCH_START=1 BATCH_END=1 npm run train:multi

# Iterate multiple weeks (fast mode for CI)
CI_FAST=1 SEASON=2025 BATCH_START=1 BATCH_END=4 npm run train:multi
```

Use `npm run train:yaml` to inspect the currently resolved YAML settings and `npm run train:one` for the legacy single-week runner when you need to target a specific batch manually.

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

## Handling large context & injury API responses

Rotowire injury snapshots and the weekly context packs can exceed the default payload limits for GPT Actions when you request the full league in one call. The Worker supports lightweight segmentation so automations can stay under the `ResponseTooLargeError` threshold:

- Use the `/context` endpoint with `team`, `game_id`, or the new `chunk` / `chunk_size` controls (for example `?season=2025&week=6&chunk_size=1&chunk=3`) to fetch one game at a time.
- Use the `/injuries` endpoint with query filters such as `?season=2025&week=6&team=BUF,KC` to restrict the response to one or more teams.
- Combine `team` with `status` (for example `status=OUT,QUESTIONABLE`) to trim the payload to only the designations you care about.
- Add `limit=<n>` or tune `chunk_size` after the filters if you only need a fixed number of rows per request.
- The same filters work on `/injuries/current` for the freshest snapshot.

Every response echoes applied filters and exposes pagination metadata so you can confirm which slice of the artifact was returned without diffing the payload manually.

## Validation & monitoring
- `npm run train:multi` writes calibration bins and blend weights per week so you can chart drift over time.
- `trainer/tests/backtest.js` replays recent weeks to ensure the ensemble beats its components and remains calibrated; run with `node trainer/tests/backtest.js` (optionally pass `SEASON`/`BACKTEST_WEEKS`).
- `trainer/tests/smoke.js` is a minimal sanity check that loads data and ensures feature pipelines don’t throw.
- `npm run validate:artifacts` validates the latest JSON artifacts against the schemas in `docs/schemas/` before publishing.

Use these artifacts alongside your observability stack (S3, BigQuery, etc.) or feed them into dashboards to detect regressions early.
