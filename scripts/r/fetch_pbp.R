#!/usr/bin/env Rscript
# Fetch NFL play-by-play data via nflreadr/nflfastR and persist parquet artifacts.
# Usage: Rscript scripts/r/fetch_pbp.R --season 2023[,2024] [--force]

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

load_nflverse_packages(c("nflreadr", "nflfastR"))

main <- function() {
  option_list <- list(
    make_option(c("-s", "--season"), type = "character", help = "Comma separated seasons or ranges (e.g. 2020,2022-2024)", metavar = "SEASONS"),
    make_option(c("-f", "--force"), action = "store_true", default = FALSE, help = "Overwrite existing parquet files")
  )
  args <- parse_cli_args(option_list, description = "Download play-by-play data and enrich with nflfastR metrics")
  seasons <- normalize_seasons(args$season)
  dataset_dir <- ensure_dataset_dir("pbp")

  if (!isTRUE(args$force)) {
    existing <- seasons[file.exists(file.path(dataset_dir, sprintf("%d.parquet", seasons)))]
    if (length(existing) == length(seasons)) {
      message("All requested seasons already exist. Use --force to refresh.")
      return(invisible(TRUE))
    }
    seasons <- setdiff(seasons, existing)
  }

  message(sprintf("Fetching play-by-play for seasons: %s", paste(seasons, collapse = ", ")))
  # nflreadr::load_pbp already returns the fully enriched nflfastR dataset.
  # The nflfastR documentation (https://www.nflfastr.com/) recommends
  # retrieving play-by-play data via nflreadr, which includes drive and
  # series annotations previously produced by calculate_* helpers.
  pbp <- nflreadr::load_pbp(seasons = seasons)

  maybe_calculate <- function(name, data) {
    fn <- get0(name, envir = asNamespace("nflfastR"), inherits = FALSE)
    if (is.function(fn)) {
      message(sprintf("Applying nflfastR::%s()", name))
      fn(data)
    } else {
      message(sprintf(
        "nflfastR::%s() not available; skipping because load_pbp already includes these fields",
        name
      ))
      data
    }
  }

  pbp <- maybe_calculate("calculate_drive_info", pbp)
  pbp <- maybe_calculate("calculate_series_info", pbp)

  updated <- integer(0)
  for (season in seasons) {
    season_data <- pbp[pbp$season == season, , drop = FALSE]
    if (nrow(season_data) == 0) {
      warning(sprintf("No data returned for season %s", season))
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
