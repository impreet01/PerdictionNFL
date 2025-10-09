#!/usr/bin/env bash
# Install required R packages for the nflverse ingestion toolchain.
set -euo pipefail

Rscript - <<'RSCRIPT'
required <- c(
  "nflreadr",
  "nflfastR",
  "nflseedR",
  "nfl4th",
  "nflplotR",
  "arrow",
  "optparse",
  "jsonlite",
  "readr"
)
if (getOption("repos")["CRAN"] %in% c("@CRAN@", NA)) {
  options(repos = c(CRAN = "https://cloud.r-project.org"))
}
install_if_missing <- function(pkg) {
  if (!requireNamespace(pkg, quietly = TRUE)) {
    message(sprintf("Installing %s", pkg))
    install.packages(pkg)
  } else {
    message(sprintf("%s already installed", pkg))
  }
}
for (pkg in required) {
  install_if_missing(pkg)
}
RSCRIPT
