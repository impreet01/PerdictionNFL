#!/usr/bin/env Rscript
# Run Monte Carlo season simulations via nflseedR and export summaries.
# Usage: Rscript scripts/r/run_seed_sim.R --season 2024 [--week 6] [--sims 20000]

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
  library(nflseedR)
  library(readr)
})

locate_model_file <- function(season, week = NULL) {
  artifacts_dir <- normalizePath(file.path(script_dir, "..", "..", "artifacts"), mustWork = FALSE)
  if (!dir.exists(artifacts_dir)) {
    return(NULL)
  }
  if (!is.null(week)) {
    candidate <- file.path(artifacts_dir, sprintf("model_%d_W%02d.json", season, week))
    if (file.exists(candidate)) {
      return(candidate)
    }
  }
  pattern <- sprintf("^model_%d_W(\\\d{2})\\.json$", season)
  matches <- list.files(artifacts_dir, pattern = pattern, full.names = TRUE)
  if (length(matches) == 0) {
    return(NULL)
  }
  weeks <- as.integer(sub(sprintf("model_%d_W(\\\d{2})\\.json", season), "\\1", basename(matches)))
  matches[order(weeks, decreasing = TRUE)][1]
}

extract_team_priors <- function(model_json) {
  if (is.null(model_json) || !file.exists(model_json)) {
    return(NULL)
  }
  model <- jsonlite::read_json(model_json)
  candidate_paths <- list(
    c("team_strength"),
    c("team_strengths"),
    c("team", "strength"),
    c("elo"),
    c("ratings"),
    c("priors", "teams"),
    c("feature_enrichment", "team_strength"),
    c("ensemble", "team_strength"),
    c("logistic", "team_strength"),
    c("bt", "team_strength")
  )
  for (path in candidate_paths) {
    node <- model
    valid <- TRUE
    for (key in path) {
      if (is.null(node[[key]])) {
        valid <- FALSE
        break
      }
      node <- node[[key]]
    }
    if (!valid) next
    if (is.data.frame(node)) {
      data <- node
    } else if (is.list(node) && !is.null(node$team) && !is.null(node$elo)) {
      data <- data.frame(team = node$team, elo = node$elo, stringsAsFactors = FALSE)
    } else if (is.list(node) && !is.null(node$team) && !is.null(node$rating)) {
      data <- data.frame(team = node$team, elo = node$rating, stringsAsFactors = FALSE)
    } else {
      possible <- tryCatch(as.data.frame(node, stringsAsFactors = FALSE), error = function(...) NULL)
      if (is.null(possible)) {
        next
      }
      data <- possible
    }
    if (!"team" %in% names(data)) next
    if (!"elo" %in% names(data)) {
      if ("rating" %in% names(data)) {
        data$elo <- data$rating
      } else if ("strength" %in% names(data)) {
        data$elo <- data$strength
      }
    }
    if (!"elo" %in% names(data)) next
    data <- data[, c("team", "elo"), drop = FALSE]
    return(data)
  }
  NULL
}

build_sim_args <- function(season, sims, week, priors) {
  sim_fun <- NULL
  if ("sim_season" %in% ls("package:nflseedR")) {
    sim_fun <- get("sim_season", asNamespace("nflseedR"))
  } else if ("simulate_nfl" %in% ls("package:nflseedR")) {
    sim_fun <- get("simulate_nfl", asNamespace("nflseedR"))
  } else {
    stop("nflseedR::sim_season or simulate_nfl not found")
  }
  formals_names <- names(formals(sim_fun))
  args <- list()
  if ("season" %in% formals_names) {
    args$season <- season
  }
  if ("nfl_season" %in% formals_names) {
    args$nfl_season <- season
  }
  if ("sims" %in% formals_names) {
    args$sims <- sims
  }
  if ("simulations" %in% formals_names) {
    args$simulations <- sims
  }
  if (!is.null(week)) {
    if ("week" %in% formals_names) {
      args$week <- week
    }
    if ("current_week" %in% formals_names) {
      args$current_week <- week
    }
    if ("test_week" %in% formals_names) {
      args$test_week <- week
    }
  }
  if (!is.null(priors) && nrow(priors) > 0) {
    args$elo <- priors
  }
  list(fun = sim_fun, args = args)
}

summarise_simulation <- function(sim_object) {
  if (is.list(sim_object) && !is.null(sim_object$overall)) {
    overall <- sim_object$overall
  } else if (is.data.frame(sim_object)) {
    overall <- sim_object
  } else {
    stop("Unexpected simulation output structure")
  }
  available <- names(overall)
  if (!"team" %in% available) {
    stop("team column missing in simulation output")
  }
  result <- data.frame(team = overall$team, stringsAsFactors = FALSE)
  result$make_playoffs <- if ("playoff" %in% available) overall$playoff else NA_real_
  result$win_division <- if ("div1" %in% available) overall$div1 else NA_real_
  result$top_seed <- if ("seed1" %in% available) overall$seed1 else NA_real_
  result$draft_pick <- if ("draft1" %in% available) overall$draft1 else NA_real_
  result$mean_wins <- if ("wins" %in% available) overall$wins else NA_real_
  result
}

main <- function() {
  option_list <- list(
    make_option(c("-s", "--season"), type = "integer", help = "Season to simulate", metavar = "SEASON"),
    make_option(c("-w", "--week"), type = "integer", default = NA, help = "Latest completed week for priors", metavar = "WEEK"),
    make_option(c("-n", "--sims"), type = "integer", default = 20000, help = "Number of Monte Carlo simulations")
  )
  args <- parse_cli_args(option_list, description = "Run nflseedR Monte Carlo simulations with optional priors")
  if (is.null(args$season) || is.na(args$season)) {
    stop("--season is required")
  }
  season <- as.integer(args$season)
  week <- if (is.na(args$week)) NULL else as.integer(args$week)
  sims <- as.integer(args$sims)

  model_path <- locate_model_file(season, week)
  priors <- extract_team_priors(model_path)
  if (!is.null(model_path)) {
    message(sprintf("Using model file: %s", model_path))
  } else {
    message("No model file found; running simulations with default priors")
  }
  if (!is.null(priors)) {
    message(sprintf("Loaded %d team priors", nrow(priors)))
  } else {
    message("Team priors unavailable; nflseedR defaults will be used" )
  }

  sim_config <- build_sim_args(season, sims, week, priors)
  sim_object <- do.call(sim_config$fun, sim_config$args)
  summary_df <- summarise_simulation(sim_object)
  summary_df <- coerce_integer64_to_character(summary_df)

  dataset_dir <- ensure_dataset_dir("seed_sim")
  suffix <- if (!is.null(week)) sprintf("%d_W%02d", season, week) else sprintf("%d", season)
  parquet_path <- file.path(dataset_dir, sprintf("seed_sim_%s.parquet", suffix))
  csv_path <- file.path(dataset_dir, sprintf("seed_sim_%s.csv", suffix))
  write_parquet_safe(summary_df, parquet_path)
  readr::write_csv(summary_df, csv_path)

  manifest <- list(
    generated_at = format(Sys.time(), tz = "UTC", usetz = TRUE),
    season = season,
    week = week,
    simulations = sims,
    parquet = basename(parquet_path),
    csv = basename(csv_path)
  )
  write_manifest(file.path(dataset_dir, sprintf("manifest_%s.json", suffix)), manifest)
  message(sprintf("Simulation outputs written to %s", dataset_dir))
  invisible(TRUE)
}

tryCatch({
  main()
}, error = function(err) {
  message("ERROR: ", conditionMessage(err))
  quit(status = 1)
})
