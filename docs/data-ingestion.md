# Data ingestion cheat sheet

This project relies exclusively on [nflverse](https://github.com/nflverse/) public datasets by default. The `trainer/dataSources.js`
module wraps every feed with:

- **Redundant mirrors** – GitHub release assets, `main` and `master` branches, and legacy `nfldata` fallbacks.
- **Dynamic discovery** – manifests are resolved via the GitHub API so loaders know which seasons/files are available before
  downloading anything. The manifest results are cached in-process to avoid repeated API calls during long runs.
- **Automatic gzip handling** – URLs are tried with and without the `.gz` suffix.
- **Per-season caching** – repeated calls within a single training run reuse in-memory copies so we only download each table once.

If you set `TANK01_API_KEY`, the loaders will prefer Tank01 RapidAPI responses for seasons 2022 and newer (schedules, team/player weekly stats, rosters, depth charts, injuries, betting odds, projections, and play-by-play) before falling back to nflverse mirrors. This keeps the historical nflverse pipeline intact while layering in higher-frequency Tank01 updates when available.

Use this table to understand what we load, how often nflverse updates it, and where it is consumed.

| Dataset | Primary URL pattern | Update cadence | Used by |
| --- | --- | --- | --- |
| Schedules & scores | `releases/download/schedules/schedules_<season>.csv` → `nfldata/games.csv` | Daily in-season | Feature builders, trainers, context packs |
| Team weekly stats | `releases/download/stats_team/stats_team_week_<season>.csv` | Weekly | Feature builders (`featureBuild.js`) |
| Team game advanced stats | `releases/download/stats_team/stats_team_game_<season>.csv` | Weekly | Feature builders (advanced splits) |
| Player weekly stats | `releases/download/stats_player/stats_player_week_<season>.csv` | Weekly | Player usage + QB form |
| Play-by-play | `releases/download/pbp/play_by_play_<season>.csv.gz` | Daily/weekly | EPA & success aggregates |
| Weekly rosters | `releases/download/weekly_rosters/weekly_rosters_<season>.csv` | Daily | Context packs (starters) |
| Depth charts | `releases/download/depth_charts/depth_charts_<season>.csv` | Daily | Context packs (starter mapping) |
| Injuries | `releases/download/injuries/injuries_<season>.csv` | Daily (Thu-Sun heavy) | Context packs (injury report summaries) |
| Snap counts | `releases/download/snap_counts/snap_counts_<season>.csv` | Weekly | Available for usage-based context |
| ESPN Total QBR | `releases/download/espn_data/espn_qbr_<season>.csv` | Weekly | QB form overlay |
| PFR advanced team | `releases/download/pfr_advstats/pfr_advstats_team_<season>.csv` | Weekly | Team efficiency context |
| Officials | `releases/download/officials/officials.csv` | Sporadic | Optional officiating context |

## Season discovery & range controls

`trainer/databases.js` now exposes a `resolveSeasonList` helper that folds together manifest discovery, CLI flags, and
environment variables:

- `--all` / `ALL_SEASONS` – use the entire discovered history (still capped by `SINCE_SEASON`/`MAX_SEASONS`).
- `--since <year>` / `SINCE_SEASON` – drop anything older than the given season.
- `--max <n>` / `MAX_SEASONS` – keep only the most recent `n` seasons after other filters are applied.

The context builder CLI iterates that bounded list, writes one context shard per season, and produces
`artifacts/context_index.json` summarising what was generated. Training inherits the same controls, aggregates
features across the resolved seasons, and still evaluates only on the target season/week so rolling statistics reset cleanly.

## Extending the loaders

1. Identify the nflverse dataset (check [nflverse-data README](https://github.com/nflverse/nflverse-data)).
2. Add a loader in `trainer/dataSources.js` following the same pattern: declare mirrors, wrap in `cached(...)`, and export it.
3. Consume the new data in feature builders or context packs as needed.

Because every loader now caches by `(season, dataset)`, you can safely call them inside loops or `Promise.all` chains without
re-downloading. If you need to force a refresh (for example when running long-lived services), clear the corresponding cache
map before invoking the loader again. The manifest helper will refetch if you evict the cached entry.
