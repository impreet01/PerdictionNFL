#!/usr/bin/env bash
# Install required R packages for the nflverse ingestion toolchain.
set -euo pipefail

install_system_dependencies() {
  local sudo_bin=""
  if command -v sudo >/dev/null 2>&1; then
    sudo_bin="sudo"
  elif [[ $(id -u) -ne 0 ]]; then
    echo "Warning: sudo not available and script is not running as root; skipping automatic libcurl installation." >&2
    echo "Install the libcurl development package manually before rerunning this script." >&2
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    echo "Installing libcurl development headers via apt-get"
    ${sudo_bin} apt-get update -y >/dev/null
    ${sudo_bin} apt-get install -y libcurl4-openssl-dev >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    echo "Installing libcurl development headers via dnf"
    ${sudo_bin} dnf install -y libcurl-devel >/dev/null
  elif command -v yum >/dev/null 2>&1; then
    echo "Installing libcurl development headers via yum"
    ${sudo_bin} yum install -y libcurl-devel >/dev/null
  elif command -v apk >/dev/null 2>&1; then
    echo "Installing libcurl development headers via apk"
    ${sudo_bin} apk add --no-cache curl-dev >/dev/null
  else
    echo "Warning: could not detect a supported package manager to install libcurl headers." >&2
    echo "Please install the system dependency manually (libcurl development package)." >&2
  fi
}

install_system_dependencies

if ! command -v Rscript >/dev/null 2>&1; then
  echo "Error: Rscript is not installed. Install R (including Rscript) and rerun this setup." >&2
  exit 1
fi

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
