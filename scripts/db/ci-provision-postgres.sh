#!/bin/bash -p
# AI Specification Studio: provisions the disposable CI PostgreSQL 18 cluster
# on a GitHub-hosted Ubuntu 26.04 runner ONLY. Never run it anywhere else:
# it refuses to, and local servers are set up with local-setup.sql.
#
# Run from the project root, after scripts/db/ci-credentials.ts, always in
# Bash's privileged mode (-p):
#
#   bash -p scripts/db/ci-provision-postgres.sh
#
# Privileged mode imports no shell functions from the environment and ignores
# BASH_ENV, ENV, SHELLOPTS, and BASHOPTS, so nothing from the environment can
# run before this script's first line. The script refuses to run without it.
#
# Order (each stage runs only if every earlier check passed):
#   1. this shell: privileged mode, no imported functions, no tracing, no
#      shell-startup variables; fixed PATH, IFS, umask, and locale; no
#      arguments
#   2. the runner: GitHub Actions, GitHub-hosted, Linux, Ubuntu 26.04
#   3. the environment: no PG*, POSTGRES_*, DATABASE_*, or TEST_DATABASE_URL
#   4. the repository files this installs or runs
#   5. the Phase 2 credentials: a 0700 directory and two 0600 files owned by
#      this user; the verifier read with dd iflag=nofollow and checked
#      against the strict SCRAM-SHA-256 shape
#   6. the cluster, read only: exactly 18/main, stopped, port 5432; service
#      inactive and disabled; no server process; port free; canonical,
#      postgres-owned paths; PG_VERSION 18; no postmaster.pid; an empty
#      conf.d; version 18 binaries
#   7. install pg_hba.conf and conf.d/90-ai-spec-studio-ci.conf (postgres,
#      0640), then confirm both
#   8. start postgresql@18-main and wait for it (bounded)
#   9. run ci-setup.sql as the OS user postgres over the Unix socket. The
#      verifier travels only on psql's standard input, in a \set line
#      written by Bash's builtin printf: never in a command line or an
#      environment. ci-setup.sql validates the live server itself.
#  10. delete the verifier file (only after success) and confirm it's gone;
#      the test-database-url file stays for the integration steps
#
# Output: fixed PASS/FAIL lines with CI_PROVISION_* codes, never a
# credential, URL, or file content. On failure nothing is undone: no role or
# database is dropped and no file outside the two configuration files is
# touched. A failed run needs a new runner.

set +x
case "$-" in
  *p*) ;;
  *)
    builtin printf '%s\n' 'FAIL  CI_PROVISION_NOT_PRIVILEGED_MODE'
    exit 1
    ;;
esac
set -euo pipefail
set -o errtrace
umask 077
IFS=$' \t\n'
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C
hash -r

if [ -n "$(declare -F)" ]; then
  builtin printf '%s\n' 'FAIL  CI_PROVISION_IMPORTED_FUNCTIONS'
  exit 1
fi

trap 'builtin printf "FAIL  CI_PROVISION_UNEXPECTED_ERROR (line %s)\n" "$LINENO"' ERR

readonly CREDENTIAL_DIR_NAME="ai-spec-studio-db"
readonly URL_NAME="test-database-url"
readonly VERIFIER_NAME="test-role-verifier"
readonly SERVICE="postgresql@18-main"
readonly PORT="5432"
readonly DATA_DIR="/var/lib/postgresql/18/main"
readonly CONF_DIR="/etc/postgresql/18/main"
readonly CONF_FILE="/etc/postgresql/18/main/postgresql.conf"
readonly HBA_FILE="/etc/postgresql/18/main/pg_hba.conf"
readonly CONF_D="/etc/postgresql/18/main/conf.d"
readonly CI_CONF_NAME="90-ai-spec-studio-ci.conf"
readonly PG_BIN="/usr/lib/postgresql/18/bin"
readonly SCRAM_PATTERN='^SCRAM-SHA-256\$[1-9][0-9]{3,5}:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$'
readonly SERVER_VERSION_PATTERN='^postgres \(PostgreSQL\) 18\.[0-9]+( |$)'
readonly PSQL_VERSION_PATTERN='^psql \(PostgreSQL\) 18\.[0-9]+( |$)'

USER_ID=""
REPO_ROOT=""
SQL_FILE=""
HBA_SOURCE=""
CONF_SOURCE=""
CREDENTIAL_DIR=""
URL_FILE=""
VERIFIER_FILE=""
VERIFIER_IDENTITY=""
VERIFIER=""
SERVER_VERSION=""

fail() {
  builtin printf 'FAIL  %s\n' "$1"
  exit "${2:-1}"
}

pass() {
  builtin printf 'PASS  %s\n' "$1"
}

# Not writable by group or others.
closed_mode() {
  case "$1" in
    *[2367]?|*[2367]) return 1 ;;
  esac
  return 0
}

check_shell() {
  case "$-" in
    *x*) fail CI_PROVISION_XTRACE ;;
  esac
  [ "$#" -eq 0 ] || fail CI_PROVISION_USAGE 2
  pass CI_PROVISION_SHELL
}

check_runner() {
  USER_ID="$(id -u)"
  [ "$USER_ID" != "0" ] || fail CI_PROVISION_RUNNING_AS_ROOT
  [ "${GITHUB_ACTIONS:-}" = "true" ] || fail CI_PROVISION_NOT_GITHUB_ACTIONS
  [ "${CI:-}" = "true" ] || fail CI_PROVISION_NOT_CI
  [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] || fail CI_PROVISION_NOT_GITHUB_HOSTED
  [ "${RUNNER_OS:-}" = "Linux" ] || fail CI_PROVISION_NOT_LINUX_RUNNER
  [ "$(uname -s)" = "Linux" ] || fail CI_PROVISION_NOT_LINUX
  [ "${ImageOS:-}" = "ubuntu26" ] || fail CI_PROVISION_IMAGE_OS
  grep -qx 'ID=ubuntu' /etc/os-release || fail CI_PROVISION_OS_RELEASE
  grep -qx 'VERSION_ID="26.04"' /etc/os-release || fail CI_PROVISION_OS_RELEASE
  sudo -n true || fail CI_PROVISION_SUDO
  pass CI_PROVISION_RUNNER
}

check_environment() {
  local name
  for name in $(compgen -e); do
    case "$name" in
      PG*|POSTGRES_*|postgres_*|DATABASE_*|TEST_DATABASE_URL) fail CI_PROVISION_DATABASE_VARIABLE_SET ;;
      BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_XTRACEFD) fail CI_PROVISION_SHELL_VARIABLE_SET ;;
    esac
  done
  local temp="${RUNNER_TEMP:-}"
  [[ "$temp" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail CI_PROVISION_RUNNER_TEMP
  case "$temp" in
    *//*|*/./*|*/../*|*/.|*/..|*/) fail CI_PROVISION_RUNNER_TEMP ;;
  esac
  [ "$(realpath -e -- "$temp")" = "$temp" ] || fail CI_PROVISION_RUNNER_TEMP
  pass CI_PROVISION_ENVIRONMENT
}

check_repository_files() {
  REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)" || fail CI_PROVISION_REPOSITORY
  SQL_FILE="$REPO_ROOT/scripts/db/ci-setup.sql"
  HBA_SOURCE="$REPO_ROOT/scripts/db/ci/pg_hba.conf"
  CONF_SOURCE="$REPO_ROOT/scripts/db/ci/postgresql-ci.conf"
  local file
  for file in "$SQL_FILE" "$HBA_SOURCE" "$CONF_SOURCE"; do
    [ -f "$file" ] && [ ! -L "$file" ] || fail CI_PROVISION_REPOSITORY_FILE
  done
  pass CI_PROVISION_REPOSITORY
}

check_credentials() {
  CREDENTIAL_DIR="$RUNNER_TEMP/$CREDENTIAL_DIR_NAME"
  URL_FILE="$CREDENTIAL_DIR/$URL_NAME"
  VERIFIER_FILE="$CREDENTIAL_DIR/$VERIFIER_NAME"
  [ -d "$CREDENTIAL_DIR" ] && [ ! -L "$CREDENTIAL_DIR" ] || fail CI_PROVISION_CREDENTIAL_DIRECTORY
  [ "$(realpath -e -- "$CREDENTIAL_DIR")" = "$CREDENTIAL_DIR" ] || fail CI_PROVISION_CREDENTIAL_DIRECTORY
  [ "$(stat -c '%u %a %F' -- "$CREDENTIAL_DIR")" = "$USER_ID 700 directory" ] || fail CI_PROVISION_CREDENTIAL_DIRECTORY
  local entries
  shopt -s nullglob dotglob
  entries=("$CREDENTIAL_DIR"/*)
  shopt -u nullglob dotglob
  [ "${#entries[@]}" -eq 2 ] || fail CI_PROVISION_CREDENTIAL_CONTENTS
  [ "${entries[0]}" = "$URL_FILE" ] && [ "${entries[1]}" = "$VERIFIER_FILE" ] || fail CI_PROVISION_CREDENTIAL_CONTENTS
  local file
  for file in "$URL_FILE" "$VERIFIER_FILE"; do
    [ -f "$file" ] && [ ! -L "$file" ] || fail CI_PROVISION_CREDENTIAL_FILE
    [ "$(stat -c '%u %a %h %F' -- "$file")" = "$USER_ID 600 1 regular file" ] || fail CI_PROVISION_CREDENTIAL_FILE
  done
  VERIFIER_IDENTITY="$(stat -c '%d:%i %u %a %h %F %s' -- "$VERIFIER_FILE")" || fail CI_PROVISION_CREDENTIAL_FILE
  local size="${VERIFIER_IDENTITY##* }"
  VERIFIER="$(dd if="$VERIFIER_FILE" iflag=nofollow status=none)" || fail CI_PROVISION_VERIFIER_UNREADABLE
  [ "${#VERIFIER}" -eq "$size" ] || fail CI_PROVISION_VERIFIER_FORMAT
  [[ "$VERIFIER" =~ $SCRAM_PATTERN ]] || fail CI_PROVISION_VERIFIER_FORMAT
  local rest="${VERIFIER#SCRAM-SHA-256\$}"
  local iterations="${rest%%:*}"
  rest=""
  (( 10#$iterations >= 4096 && 10#$iterations <= 100000 )) || fail CI_PROVISION_VERIFIER_FORMAT
  [ "$(stat -c '%d:%i %u %a %h %F %s' -- "$VERIFIER_FILE")" = "$VERIFIER_IDENTITY" ] || fail CI_PROVISION_VERIFIER_CHANGED
  pass CI_PROVISION_CREDENTIALS
}

check_cluster() {
  command -v pg_lsclusters >/dev/null || fail CI_PROVISION_NO_PG_LSCLUSTERS
  local clusters
  clusters="$(pg_lsclusters --no-header)" || fail CI_PROVISION_CLUSTER_LIST
  case "$clusters" in
    ""|*$'\n'*) fail CI_PROVISION_CLUSTER_COUNT ;;
  esac
  local version cluster port status owner data_dir rest
  read -r version cluster port status owner data_dir rest <<<"$clusters"
  [ "$version" = "18" ] && [ "$cluster" = "main" ] && [ "$port" = "$PORT" ] && [ "$status" = "down" ] && [ "$owner" = "postgres" ] && [ "$data_dir" = "$DATA_DIR" ] || fail CI_PROVISION_CLUSTER_STATE

  [ "$(systemctl is-active "$SERVICE" || true)" = "inactive" ] || fail CI_PROVISION_SERVICE_ACTIVE
  [ "$(systemctl is-active postgresql.service || true)" = "inactive" ] || fail CI_PROVISION_SERVICE_ACTIVE
  [ "$(systemctl is-enabled postgresql.service 2>/dev/null || true)" = "disabled" ] || fail CI_PROVISION_SERVICE_ENABLED
  if pgrep -x postgres >/dev/null; then
    fail CI_PROVISION_SERVER_RUNNING
  fi
  [ -z "$(ss -Hltn "sport = :$PORT")" ] || fail CI_PROVISION_PORT_IN_USE

  [ "$(sudo -n -u postgres realpath -e -- "$DATA_DIR")" = "$DATA_DIR" ] || fail CI_PROVISION_DATA_DIRECTORY
  [ "$(sudo -n -u postgres stat -c '%U %a %F' -- "$DATA_DIR")" = "postgres 700 directory" ] || fail CI_PROVISION_DATA_DIRECTORY
  [ "$(sudo -n -u postgres stat -c '%U %h %F' -- "$DATA_DIR/PG_VERSION")" = "postgres 1 regular file" ] || fail CI_PROVISION_PG_VERSION
  [ "$(sudo -n -u postgres cat -- "$DATA_DIR/PG_VERSION")" = "18" ] || fail CI_PROVISION_PG_VERSION
  if sudo -n -u postgres test -e "$DATA_DIR/postmaster.pid" || sudo -n -u postgres test -L "$DATA_DIR/postmaster.pid"; then
    fail CI_PROVISION_POSTMASTER_PID
  fi

  local dir
  for dir in "$CONF_DIR" "$CONF_D"; do
    [ "$(realpath -e -- "$dir")" = "$dir" ] || fail CI_PROVISION_CONFIG_DIRECTORY
    [ "$(stat -c '%U %F' -- "$dir")" = "postgres directory" ] || fail CI_PROVISION_CONFIG_DIRECTORY
    closed_mode "$(stat -c '%a' -- "$dir")" || fail CI_PROVISION_CONFIG_DIRECTORY
  done
  [ -f "$CONF_FILE" ] && [ ! -L "$CONF_FILE" ] || fail CI_PROVISION_CONFIG_FILE
  [ "$(stat -c '%U %h %F' -- "$CONF_FILE")" = "postgres 1 regular file" ] || fail CI_PROVISION_CONFIG_FILE
  grep -Eq "^include_dir = 'conf\.d'([[:space:]].*)?$" "$CONF_FILE" || fail CI_PROVISION_CONFIG_INCLUDE
  local entries
  shopt -s nullglob dotglob
  entries=("$CONF_D"/*)
  shopt -u nullglob dotglob
  [ "${#entries[@]}" -eq 0 ] || fail CI_PROVISION_CONF_D_NOT_EMPTY
  [ -f "$HBA_FILE" ] && [ ! -L "$HBA_FILE" ] || fail CI_PROVISION_HBA_FILE
  [ "$(stat -c '%U %h %F' -- "$HBA_FILE")" = "postgres 1 regular file" ] || fail CI_PROVISION_HBA_FILE

  SERVER_VERSION="$("$PG_BIN/postgres" --version)" || fail CI_PROVISION_SERVER_BINARY
  [[ "$SERVER_VERSION" =~ $SERVER_VERSION_PATTERN ]] || fail CI_PROVISION_SERVER_BINARY
  local psql_version
  psql_version="$("$PG_BIN/psql" --version)" || fail CI_PROVISION_PSQL_BINARY
  [[ "$psql_version" =~ $PSQL_VERSION_PATTERN ]] || fail CI_PROVISION_PSQL_BINARY
  [ -x "$PG_BIN/pg_isready" ] || fail CI_PROVISION_PG_ISREADY
  pass CI_PROVISION_CLUSTER
}

install_configuration() {
  sudo -n install -T -o postgres -g postgres -m 0640 -- "$HBA_SOURCE" "$HBA_FILE" || fail CI_PROVISION_INSTALL_HBA
  sudo -n install -T -o postgres -g postgres -m 0640 -- "$CONF_SOURCE" "$CONF_D/$CI_CONF_NAME" || fail CI_PROVISION_INSTALL_CONF
  sudo -n cmp -s -- "$HBA_SOURCE" "$HBA_FILE" || fail CI_PROVISION_INSTALLED_HBA
  sudo -n cmp -s -- "$CONF_SOURCE" "$CONF_D/$CI_CONF_NAME" || fail CI_PROVISION_INSTALLED_CONF
  [ "$(stat -c '%U %G %a %h %F' -- "$HBA_FILE")" = "postgres postgres 640 1 regular file" ] || fail CI_PROVISION_INSTALLED_HBA
  [ "$(stat -c '%U %G %a %h %F' -- "$CONF_D/$CI_CONF_NAME")" = "postgres postgres 640 1 regular file" ] || fail CI_PROVISION_INSTALLED_CONF
  local entries
  shopt -s nullglob dotglob
  entries=("$CONF_D"/*)
  shopt -u nullglob dotglob
  [ "${#entries[@]}" -eq 1 ] && [ "${entries[0]}" = "$CONF_D/$CI_CONF_NAME" ] || fail CI_PROVISION_INSTALLED_CONF
  pass CI_PROVISION_CONFIGURATION
}

start_server() {
  sudo -n systemctl start "$SERVICE" || fail CI_PROVISION_START
  "$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PORT" -t 30 || fail CI_PROVISION_NOT_READY
  [ "$(systemctl is-active "$SERVICE" || true)" = "active" ] || fail CI_PROVISION_SERVICE_NOT_ACTIVE
  pass CI_PROVISION_STARTED
}

provision() {
  local status=0
  (
    cd / && {
      builtin printf '%s\n' '\set ECHO none'
      builtin printf '%s\n' "\\set test_verifier '${VERIFIER}'"
      cat -- "$SQL_FILE"
    } | sudo -n -u postgres -- "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d postgres -f -
  ) || status=$?
  VERIFIER=""
  unset VERIFIER
  [ "$status" -eq 0 ] || fail CI_PROVISION_SQL_FAILED
  pass CI_PROVISION_SQL
}

remove_verifier() {
  [ -f "$VERIFIER_FILE" ] && [ ! -L "$VERIFIER_FILE" ] || fail CI_PROVISION_VERIFIER_CHANGED
  [ "$(stat -c '%d:%i %u %a %h %F %s' -- "$VERIFIER_FILE")" = "$VERIFIER_IDENTITY" ] || fail CI_PROVISION_VERIFIER_CHANGED
  rm -- "$VERIFIER_FILE" || fail CI_PROVISION_VERIFIER_DELETE
  [ ! -e "$VERIFIER_FILE" ] && [ ! -L "$VERIFIER_FILE" ] || fail CI_PROVISION_VERIFIER_STILL_PRESENT
  [ -f "$URL_FILE" ] && [ ! -L "$URL_FILE" ] || fail CI_PROVISION_URL_FILE
  [ "$(stat -c '%u %a %h %F' -- "$URL_FILE")" = "$USER_ID 600 1 regular file" ] || fail CI_PROVISION_URL_FILE
  pass CI_PROVISION_VERIFIER_REMOVED
}

main() {
  check_shell "$@"
  check_runner
  check_environment
  check_repository_files
  check_credentials
  check_cluster
  install_configuration
  start_server
  provision
  remove_verifier
  pass "CI_PROVISION_COMPLETE (${SERVER_VERSION%% (Ubuntu*})"
}

main "$@"
