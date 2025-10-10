#!/usr/bin/env Rscript
# Common helpers for R ingestion scripts.
# Provides CLI parsing, artifact directory utilities, and parquet writers.

suppressPackageStartupMessages({
  library(optparse)
  library(arrow)
  library(jsonlite)
})

#' Ensure nflverse core packages are attached quietly.
#' @param packages Optional character vector of specific nflverse packages to verify.
load_nflverse_packages <- function(packages = NULL) {
  if (!requireNamespace("nflverse", quietly = TRUE)) {
    stop(
      "The 'nflverse' package is required. Run scripts/setup-r.sh to install R dependencies.",
      call. = FALSE
    )
  }

  original_quiet <- getOption("nflverse.quiet")
  on.exit(options(nflverse.quiet = original_quiet), add = TRUE)
  options(nflverse.quiet = TRUE)
  suppressPackageStartupMessages(library(nflverse))

  if (!is.null(packages) && length(packages) > 0) {
    missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
    if (length(missing) > 0) {
      stop(
        sprintf(
          "Missing nflverse package(s): %s. Run scripts/setup-r.sh and retry.",
          paste(missing, collapse = ", ")
        ),
        call. = FALSE
      )
    }
  }

  invisible(TRUE)
}

#' Internal helper to resolve the path to this scripts directory.
get_scripts_root <- function() {
  args <- commandArgs(trailingOnly = FALSE)
  file_flag <- "--file="
  script_path <- args[grep(file_flag, args)]
  if (length(script_path) == 0) {
    return(getwd())
  }
  script_path <- sub(file_flag, "", script_path)
  dirname(normalizePath(script_path))
}

#' Create an optparse parser with shared defaults.
#' @param option_list List of optparse::make_option entries.
#' @param description Optional description string.
parse_cli_args <- function(option_list, description = NULL) {
  parser <- OptionParser(option_list = option_list, description = description)
  parse_args(parser)
}

#' Normalise a comma-delimited season string into numeric vector.
#' Accepts ranges like "2020-2022" and deduplicates seasons.
normalize_seasons <- function(season_input) {
  if (length(season_input) == 0 || is.na(season_input) || nchar(trimws(season_input)) == 0) {
    stop("Season is required")
  }
  parts <- unlist(strsplit(season_input, ","))
  seasons <- integer(0)
  for (part in parts) {
    trimmed <- trimws(part)
    if (nchar(trimmed) == 0) next
    if (grepl("-", trimmed, fixed = TRUE)) {
      bounds <- as.integer(strsplit(trimmed, "-", fixed = TRUE)[[1]])
      if (length(bounds) != 2 || any(is.na(bounds))) {
        stop(sprintf("Invalid season range provided: %s", trimmed))
      }
      seasons <- c(seasons, seq(min(bounds), max(bounds)))
    } else {
      value <- suppressWarnings(as.integer(trimmed))
      if (is.na(value)) {
        stop(sprintf("Invalid season provided: %s", trimmed))
      }
      seasons <- c(seasons, value)
    }
  }
  sort(unique(seasons))
}

#' Normalise week argument into numeric vector or NULL if absent.
normalize_weeks <- function(week_input) {
  if (is.null(week_input) || length(week_input) == 0 || nchar(trimws(week_input)) == 0) {
    return(NULL)
  }
  parts <- unlist(strsplit(week_input, ","))
  weeks <- integer(0)
  for (part in parts) {
    trimmed <- trimws(part)
    if (nchar(trimmed) == 0) next
    if (grepl("-", trimmed, fixed = TRUE)) {
      bounds <- as.integer(strsplit(trimmed, "-", fixed = TRUE)[[1]])
      if (length(bounds) != 2 || any(is.na(bounds))) {
        stop(sprintf("Invalid week range provided: %s", trimmed))
      }
      weeks <- c(weeks, seq(min(bounds), max(bounds)))
    } else {
      value <- suppressWarnings(as.integer(trimmed))
      if (is.na(value)) {
        stop(sprintf("Invalid week provided: %s", trimmed))
      }
      weeks <- c(weeks, value)
    }
  }
  sort(unique(weeks))
}

#' Ensure dataset directory exists under artifacts/r-data.
#' @param dataset Dataset slug (e.g. "pbp").
#' @return Normalised path to dataset directory.
ensure_dataset_dir <- function(dataset) {
  base_dir <- file.path(get_scripts_root(), "..", "..", "artifacts", "r-data", dataset)
  base_dir <- normalizePath(base_dir, mustWork = FALSE)
  if (!dir.exists(base_dir)) {
    dir.create(base_dir, recursive = TRUE, showWarnings = FALSE)
  }
  base_dir
}

#' Convert integer64 columns to character to simplify downstream parsing.
coerce_integer64_to_character <- function(df) {
  for (name in names(df)) {
    column <- df[[name]]
    if (inherits(column, "integer64")) {
      df[[name]] <- as.character(column)
    }
  }
  df
}

#' Write a dataframe to parquet with integer64 coercion.
write_parquet_safe <- function(df, path, ...) {
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  df <- coerce_integer64_to_character(df)
  arrow::write_parquet(df, path, ...)
}

#' Write a manifest JSON to accompany parquet exports.
write_manifest <- function(path, manifest) {
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  jsonlite::write_json(manifest, path, auto_unbox = TRUE, pretty = TRUE)
}

#' Helper to compute relative path from repository root for manifests.
repo_relative_path <- function(path) {
  normalizePath(path, winslash = "/", mustWork = FALSE)
}

