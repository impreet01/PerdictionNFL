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

pkg_dir="$(dirname "$0")/r"
pkg_list_file="$pkg_dir/package-list.txt"
pkg_manifest_file="$pkg_dir/package-manifest.txt"

if [[ ! -f "$pkg_list_file" ]]; then
  echo "Error: package list file not found at $pkg_list_file" >&2
  exit 1
fi

pkg_source_file="$pkg_list_file"
if [[ -f "$pkg_manifest_file" ]]; then
  echo "Using dependency manifest at $pkg_manifest_file"
  pkg_source_file="$pkg_manifest_file"
else
  echo "Dependency manifest not found; using package list at $pkg_list_file"
fi

PKG_LIST_FILE="$pkg_source_file" Rscript - <<'RSCRIPT'
pkg_file <- Sys.getenv("PKG_LIST_FILE")
message(sprintf("Reading required packages from %s", pkg_file))
required <- readLines(pkg_file, warn = FALSE)
required <- trimws(required)
required <- required[nzchar(required) & !grepl("^#", required)]

# Prefer Posit Package Manager binaries on common CI runners to avoid
# repeated source builds (for example duckdb taking minutes to compile).
`%||%` <- function(lhs, rhs) if (is.null(lhs) || is.na(lhs)) rhs else lhs
repos <- getOption("repos")
cran_repo <- repos["CRAN"]
if (.Platform$OS.type == "unix") {
  sysname <- Sys.info()[["sysname"]]
  if (identical(sysname, "Linux")) {
    repos["CRAN"] <- "https://packagemanager.posit.co/cran/__linux__/jammy/latest"
  } else if (identical(sysname, "Darwin")) {
    repos["CRAN"] <- "https://packagemanager.posit.co/cran/__macos__/big-sur/latest"
  }
}
if (is.null(cran_repo) || cran_repo %in% c("@CRAN@", NA)) {
  repos["CRAN"] <- repos["CRAN"] %||% "https://cloud.r-project.org"
}
options(repos = repos)
install_if_missing <- function(pkg) {
  if (!requireNamespace(pkg, quietly = TRUE)) {
    message(sprintf("Installing %s", pkg))
    install.packages(pkg, dependencies = TRUE)
  } else {
    message(sprintf("%s already installed", pkg))
  }
}
for (pkg in required) {
  install_if_missing(pkg)
}
RSCRIPT
