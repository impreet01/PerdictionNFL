#!/usr/bin/env Rscript
# Fetch weekly player statistics via nflreadr and persist parquet artifacts.
# Usage: Rscript scripts/r/fetch_player_weekly.R --season 2024 [--force]

get_script_dir <- function() {
  args <- commandArgs(trailingOnly = FALSE)
  file_flag <- "--file="
  script_path <- args[grep(file_flag, args)]
  if (length(script_path) == 0) {
    return(getwd())
  }
  dirname(normalizePath(sub(file_flag, "", script_path)))
}

script_dir <- get_script_dir()
source(file.path(script_dir, "common.R"))

suppressPackageStartupMessages({
  library(nflreadr)
})

main <- function() {
  option_list <- list(
    make_option(c("-s", "--season"), type = "character", help = "Comma separated seasons or ranges", metavar = "SEASONS"),
    make_option(c("-f", "--force"), action = "store_true", default = FALSE, help = "Overwrite existing parquet files")
  )
  args <- parse_cli_args(option_list, description = "Download weekly player stats and mirror the stats_player_week schema")
  seasons <- normalize_seasons(args$season)
  dataset_dir <- ensure_dataset_dir("player_weekly")

  if (!isTRUE(args$force)) {
    existing <- seasons[file.exists(file.path(dataset_dir, sprintf("%d.parquet", seasons)))]
    if (length(existing) == length(seasons)) {
      message("All requested seasons already exist. Use --force to refresh.")
      return(invisible(TRUE))
    }
    seasons <- setdiff(seasons, existing)
  }

  message(sprintf("Fetching weekly player stats for seasons: %s", paste(seasons, collapse = ", ")))
  stats <- nflreadr::load_player_stats(seasons = seasons, summary_level = "week")
  stats <- stats[stats$season_type == "REG", , drop = FALSE]
  names(stats) <- tolower(names(stats))

  updated <- integer(0)
  for (season in seasons) {
    season_data <- stats[stats$season == season, , drop = FALSE]
    if (nrow(season_data) == 0) {
      warning(sprintf("No weekly stats returned for season %s", season))
      next
    }
    out_path <- file.path(dataset_dir, sprintf("%d.parquet", season))
    write_parquet_safe(season_data, out_path)
    updated <- c(updated, season)
  }

  manifest <- list(
    generated_at = format(Sys.time(), tz = "UTC", usetz = TRUE),
    seasons = as.integer(updated),
    files = lapply(updated, function(season) {
      list(season = season, path = sprintf("%d.parquet", season))
    })
  )
  write_manifest(file.path(dataset_dir, "manifest.json"), manifest)
  message(sprintf("Wrote %d season parquet files", length(updated)))
  invisible(TRUE)
}

tryCatch({
  main()
}, error = function(err) {
  message("ERROR: ", conditionMessage(err))
  quit(status = 1)
})
