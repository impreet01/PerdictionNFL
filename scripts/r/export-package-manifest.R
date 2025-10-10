#!/usr/bin/env Rscript
args_all <- commandArgs(trailingOnly = FALSE)
script_path <- sub("^--file=", "", args_all[grep("^--file=", args_all)])
if (length(script_path) == 0) {
  script_dir <- getwd()
} else {
  script_dir <- dirname(normalizePath(script_path))
}

args <- commandArgs(trailingOnly = TRUE)
input <- if (length(args) >= 1) args[[1]] else file.path(script_dir, "package-list.txt")
output <- if (length(args) >= 2) args[[2]] else file.path(script_dir, "package-manifest.txt")

input <- normalizePath(input, mustWork = TRUE)
output <- normalizePath(output, mustWork = FALSE)

read_pkg_list <- function(path) {
  lines <- readLines(path, warn = FALSE)
  lines <- trimws(lines)
  lines <- lines[nzchar(lines) & !grepl("^#", lines)]
  unique(lines)
}

pkg_list <- read_pkg_list(input)
if (length(pkg_list) == 0) {
  message("No packages specified; writing empty manifest.")
  writeLines(character(), output)
  quit(status = 0)
}

repos <- getOption("repos")
if (is.null(repos) || is.na(repos[["CRAN"]]) || repos[["CRAN"]] == "@CRAN@") {
  options(repos = c(CRAN = "https://cloud.r-project.org"))
}

available <- suppressWarnings(utils::available.packages())
# Determine dependencies recursively (Depends/Imports/LinkingTo)
deps_list <- tools::package_dependencies(pkg_list, db = available, recursive = TRUE, which = c("Depends", "Imports", "LinkingTo"))
deps <- unique(unlist(deps_list, use.names = FALSE))
all_pkgs <- sort(unique(c(pkg_list, deps)))

# Drop base and recommended packages that ship with R
installed <- installed.packages()
base_pkgs <- rownames(installed[installed[, "Priority"] %in% "base", , drop = FALSE])
recommended_pkgs <- rownames(installed[installed[, "Priority"] %in% "recommended", , drop = FALSE])
pruned <- setdiff(all_pkgs, union(base_pkgs, recommended_pkgs))
manifest <- sort(unique(c(pkg_list, pruned)))

writeLines(manifest, output)
message(sprintf("Wrote %d packages (including dependencies) to %s", length(manifest), output))
