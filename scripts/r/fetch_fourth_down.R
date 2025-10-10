#!/usr/bin/env Rscript
# Generate fourth down decision model outputs using nfl4th.
# Usage: Rscript scripts/r/fetch_fourth_down.R --season 2024 [--weeks 1-9] [--force]

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
  library(nfl4th)
})

main <- function() {
  option_list <- list(
    make_option(c("-s", "--season"), type = "character", help = "Comma separated seasons or ranges", metavar = "SEASONS"),
    make_option(c("-w", "--weeks"), type = "character", default = NULL, help = "Comma separated week list or ranges", metavar = "WEEKS"),
    make_option(c("-f", "--force"), action = "store_true", default = FALSE, help = "Overwrite existing parquet files")
  )
  args <- parse_cli_args(option_list, description = "Generate fourth down recommendations for the requested schedule window")
  seasons <- normalize_seasons(args$season)
  weeks <- normalize_weeks(args$weeks)
  dataset_dir <- ensure_dataset_dir("fourth_down")

  if (!isTRUE(args$force)) {
    existing <- seasons[file.exists(file.path(dataset_dir, sprintf("%d.parquet", seasons)))]
    if (length(existing) == length(seasons)) {
      message("All requested seasons already exist. Use --force to refresh.")
      return(invisible(TRUE))
    }
    seasons <- setdiff(seasons, existing)
  }

  updated <- integer(0)
  for (season in seasons) {
    message(sprintf("Loading fourth down model outputs for season %s", season))
    decisions <- nfl4th::load_4th_pbp(seasons = as.integer(season))
    if (!is.null(weeks)) {
      decisions <- decisions[decisions$week %in% weeks, , drop = FALSE]
    }
    if (nrow(decisions) == 0) {
      warning(sprintf("No fourth down plays returned for season %s", season))
      next
    }
    names(decisions) <- tolower(names(decisions))
    out_path <- file.path(dataset_dir, sprintf("%d.parquet", season))
    write_parquet_safe(decisions, out_path)
    updated <- c(updated, season)
  }

  manifest <- list(
    generated_at = format(Sys.time(), tz = "UTC", usetz = TRUE),
    seasons = as.integer(updated),
    weeks = weeks,
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
