#!/bin/bash -p
# AI Specification Studio: confirms that the provisioned CI PostgreSQL 18
# cluster refuses to be provisioned twice. GitHub-hosted Ubuntu 26.04 runner
# ONLY, after scripts/db/ci-provision-postgres.sh has succeeded, always in
# Bash's privileged mode:
#
#   bash -p scripts/db/ci-expect-refusals.sh provision
#   bash -p scripts/db/ci-expect-refusals.sh sql
#
# provision: runs ci-provision-postgres.sh a second time. It must stop at
#   its credential gate with exactly CI_PROVISION_CREDENTIAL_CONTENTS: the
#   first run deleted the verifier file, so a used credential set is
#   refused. This checks the credential-state gate only. It does not reach,
#   and so does not prove, the cluster-state gate (the first run passed it).
#
# sql: checks the runner and the running 18/main cluster (online, port
#   5432, listening on 127.0.0.1 only), confirms with one read-only query
#   that the cluster is already provisioned, then runs ci-setup.sql again,
#   unchanged, as the OS user postgres over the Unix socket. The verifier it
#   is given is a fixed, syntactically valid placeholder, not a credential:
#   ci-setup.sql must stop in its preflight, before any CREATE, with exactly
#   the four freshness codes. A cluster that isn't provisioned is refused
#   before ci-setup.sql runs, so the placeholder can never be used.
#
# An outcome passes only if every security-significant part matches: the
# exit status, the exact set of refusal codes, no sign of progress past the
# expected gate, and no output line of an unrecognized form. Informational
# PASS lines of earlier stages are allowed but not required.
#
# Output: fixed PASS/FAIL lines with CI_REFUSAL_* codes. On a mismatch it
# adds the exit status and the refusal codes it saw, and only those that
# are well-formed CI_PROVISION_* or CI_SETUP_* tokens: never captured text,
# a URL, or a credential. A failed sql run also reports, without any of
# the lines' text: the kind of each line it didn't accept, as a fixed label
# with a count; the psql input line of the first error, digits only, when a
# line starts with a well-formed psql:<file>:<line>: prefix (the input is
# two \set lines, then ci-setup.sql, so input line N is the file's line
# N - 2); and whether the fixed marker CI_SETUP_PREFLIGHT_FAILED: appeared
# at all. Output over 16384 bytes or 256 lines isn't classified. It changes
# nothing: no file, configuration, role, or database is created, altered,
# or removed.

set +x
case "$-" in
  *p*) ;;
  *)
    builtin printf '%s\n' 'FAIL  CI_REFUSAL_NOT_PRIVILEGED_MODE'
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
  builtin printf '%s\n' 'FAIL  CI_REFUSAL_IMPORTED_FUNCTIONS'
  exit 1
fi

trap 'builtin printf "FAIL  CI_REFUSAL_UNEXPECTED_ERROR (line %s)\n" "$LINENO"' ERR

readonly CREDENTIAL_DIR_NAME="ai-spec-studio-db"
readonly URL_NAME="test-database-url"
readonly VERIFIER_NAME="test-role-verifier"
readonly SERVICE="postgresql@18-main"
readonly PORT="5432"
readonly DATA_DIR="/var/lib/postgresql/18/main"
readonly PG_BIN="/usr/lib/postgresql/18/bin"
readonly PSQL_VERSION_PATTERN='^psql \(PostgreSQL\) 18\.[0-9]+( |$)'
readonly EXPECTED_PROVISION_CODE="CI_PROVISION_CREDENTIAL_CONTENTS"
readonly EXPECTED_SQL_CODES="CI_SETUP_ROLES_NOT_FRESH, CI_SETUP_PROJECT_OBJECTS_EXIST, CI_SETUP_DATABASES_NOT_FRESH, CI_SETUP_SETTINGS_NOT_FRESH"
readonly PLACEHOLDER_VERIFIER='SCRAM-SHA-256$4096:AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
readonly SQL_ERROR_PATTERN='^psql:<stdin>:[0-9]+: ERROR:  (.*)$'
readonly SQL_CODES_PATTERN='^CI_SETUP_[A-Z_]+(, CI_SETUP_[A-Z_]+)*$'
readonly PROVISION_CODE_PATTERN='^CI_PROVISION_[A-Z_]+$'
readonly SQL_PSQL_PREFIX="psql:"
readonly SQL_SUDO_PREFIX="sudo:"
readonly SQL_LOCATED_PATTERN='^psql:[^:]+:([1-9][0-9]{0,8}): (.*)$'
readonly SQL_LINE_NUMBER_PATTERN='^[1-9][0-9]{0,8}$'
readonly SQL_KINDS="ERROR_OTHER_PREFIX ERROR_NO_PREFIX PSQL_CLIENT_ERROR SERVER_WARNING SERVER_NOTICE DETAIL HINT LINE QUERY STATEMENT SUDO PSQL_OTHER OTHER"
readonly SQL_KINDS_REPORT_PATTERN='^(none|[A-Z_]+ x[0-9]{1,2}\+?(, [A-Z_]+ x[0-9]{1,2}\+?)*)$'
readonly SQL_OUTPUT_BYTE_LIMIT=16384
readonly SQL_OUTPUT_LINE_LIMIT=256
readonly SQL_KIND_COUNT_LIMIT=99

MODE=""
USER_ID=""
REPO_ROOT=""
PROVISION_SCRIPT=""
SQL_FILE=""
VERDICT=""
OBSERVED=""
STATUS=""
SQL_UNRECOGNIZED=""
SQL_ERROR_LINE=""
SQL_MARKER=""
LINE_KIND=""

fail() {
  builtin printf 'FAIL  %s\n' "$1"
  exit "${2:-1}"
}

pass() {
  builtin printf 'PASS  %s\n' "$1"
}

# ---------------------------------------------------------------------------
# Classifiers: Bash builtins only, so the tests can run them on any input.
# Each sets VERDICT (CI_REFUSAL_EXPECTED or a failure code) and OBSERVED
# (well-formed refusal codes only).

classify_provision() {
  local status="$1" output="$2"
  local rest="$output"$'\n' line code
  local count=0 progressed=0 unrecognized=0
  VERDICT=""
  OBSERVED=""
  while [ -n "$rest" ]; do
    line="${rest%%$'\n'*}"
    rest="${rest#*$'\n'}"
    case "$line" in
      "") ;;
      "PASS  CI_PROVISION_SHELL" | "PASS  CI_PROVISION_RUNNER" | "PASS  CI_PROVISION_ENVIRONMENT" | "PASS  CI_PROVISION_REPOSITORY") ;;
      "PASS  CI_PROVISION_"*) progressed=1 ;;
      "FAIL  CI_PROVISION_UNEXPECTED_ERROR (line "*")")
        count=$((count + 1))
        OBSERVED="${OBSERVED:+$OBSERVED }CI_PROVISION_UNEXPECTED_ERROR"
        ;;
      "FAIL  "*)
        code="${line#FAIL  }"
        if [[ "$code" =~ $PROVISION_CODE_PATTERN ]]; then
          count=$((count + 1))
          OBSERVED="${OBSERVED:+$OBSERVED }$code"
        else
          unrecognized=1
        fi
        ;;
      *) unrecognized=1 ;;
    esac
  done
  if [ "$status" = "0" ]; then
    VERDICT="CI_REFUSAL_PROVISION_SUCCEEDED"
  elif [ "$progressed" = "1" ]; then
    VERDICT="CI_REFUSAL_PROVISION_PROGRESSED"
  elif [ "$unrecognized" = "1" ]; then
    VERDICT="CI_REFUSAL_UNRECOGNIZED_OUTPUT"
  elif [ "$status" != "1" ]; then
    VERDICT="CI_REFUSAL_WRONG_STATUS"
  elif [ "$count" = "0" ]; then
    VERDICT="CI_REFUSAL_MISSING_CODE"
  elif [ "$count" != "1" ] || [ "$OBSERVED" != "$EXPECTED_PROVISION_CODE" ]; then
    VERDICT="CI_REFUSAL_WRONG_CODE"
  else
    VERDICT="CI_REFUSAL_EXPECTED"
  fi
}

# The kind of an output line classify_sql doesn't accept, as one fixed
# label in LINE_KIND. Only the line's leading form is looked at; none of
# its text is kept.
sql_line_kind() {
  local line="$1" body="$1" located=0
  if [[ "$line" =~ $SQL_LOCATED_PATTERN ]]; then
    body="${BASH_REMATCH[2]}"
    located=1
  elif [ "${line#"$SQL_PSQL_PREFIX "}" != "$line" ]; then
    body="${line#"$SQL_PSQL_PREFIX "}"
    located=1
  fi
  case "$body" in
    "ERROR:"* | "FATAL:"* | "PANIC:"*)
      if [ "$located" = "1" ]; then
        LINE_KIND="ERROR_OTHER_PREFIX"
      else
        LINE_KIND="ERROR_NO_PREFIX"
      fi
      ;;
    "error: "*)
      if [ "$located" = "1" ]; then
        LINE_KIND="PSQL_CLIENT_ERROR"
      else
        LINE_KIND="OTHER"
      fi
      ;;
    "WARNING:"*) LINE_KIND="SERVER_WARNING" ;;
    "NOTICE:"* | "INFO:"* | "LOG:"* | "DEBUG"*) LINE_KIND="SERVER_NOTICE" ;;
    "DETAIL:"*) LINE_KIND="DETAIL" ;;
    "HINT:"*) LINE_KIND="HINT" ;;
    "QUERY:"*) LINE_KIND="QUERY" ;;
    "STATEMENT:"*) LINE_KIND="STATEMENT" ;;
    "LINE "[0-9]*) LINE_KIND="LINE" ;;
    *)
      if [ "$located" = "1" ] || [ "${line#"$SQL_PSQL_PREFIX"}" != "$line" ]; then
        LINE_KIND="PSQL_OTHER"
      elif [ "${line#"$SQL_SUDO_PREFIX"}" != "$line" ]; then
        LINE_KIND="SUDO"
      else
        LINE_KIND="OTHER"
      fi
      ;;
  esac
}

classify_sql() {
  local status="$1" output="$2"
  local rest="$output"$'\n' line message="" codes="" expected kind
  local errors=0 reported=0 unrecognized=0 missing=0 extra=0
  local lines=0 oversized=0 marker=0 index count
  local -a counts=(0 0 0 0 0 0 0 0 0 0 0 0 0)
  VERDICT=""
  OBSERVED=""
  SQL_UNRECOGNIZED=""
  SQL_ERROR_LINE=""
  SQL_MARKER=""
  if [ "${#output}" -gt "$SQL_OUTPUT_BYTE_LIMIT" ]; then
    oversized=1
    rest=""
  fi
  while [ -n "$rest" ]; do
    lines=$((lines + 1))
    if [ "$lines" -gt "$SQL_OUTPUT_LINE_LIMIT" ]; then
      oversized=1
      break
    fi
    line="${rest%%$'\n'*}"
    rest="${rest#*$'\n'}"
    case "$line" in
      *"CI_SETUP_PREFLIGHT_FAILED:"*) marker=1 ;;
    esac
    if [ -z "$SQL_ERROR_LINE" ] && [[ "$line" =~ $SQL_LOCATED_PATTERN ]]; then
      case "${BASH_REMATCH[2]}" in
        "ERROR:"* | "FATAL:"* | "PANIC:"* | "error: "*) SQL_ERROR_LINE="${BASH_REMATCH[1]}" ;;
      esac
    fi
    case "$line" in
      "") ;;
      "PASS  ci-setup.sql"*) reported=1 ;;
      "CONTEXT:  "*) ;;
      *)
        if [[ "$line" =~ $SQL_ERROR_PATTERN ]]; then
          errors=$((errors + 1))
          message="${BASH_REMATCH[1]}"
        else
          unrecognized=1
          sql_line_kind "$line"
          index=0
          for kind in $SQL_KINDS; do
            if [ "$kind" = "$LINE_KIND" ]; then
              counts[index]=$((counts[index] + 1))
            fi
            index=$((index + 1))
          done
        fi
        ;;
    esac
  done
  line=""
  if [ "$oversized" = "1" ]; then
    SQL_ERROR_LINE=""
    VERDICT="CI_REFUSAL_OUTPUT_TOO_LARGE"
    return 0
  fi
  index=0
  for kind in $SQL_KINDS; do
    count="${counts[index]}"
    if [ "$count" -gt "$SQL_KIND_COUNT_LIMIT" ]; then
      count="$SQL_KIND_COUNT_LIMIT+"
    fi
    if [ "$count" != "0" ]; then
      SQL_UNRECOGNIZED="${SQL_UNRECOGNIZED:+$SQL_UNRECOGNIZED, }$kind x$count"
    fi
    index=$((index + 1))
  done
  SQL_UNRECOGNIZED="${SQL_UNRECOGNIZED:-none}"
  if [ "$marker" = "1" ]; then
    SQL_MARKER="present"
  else
    SQL_MARKER="absent"
  fi
  if [ "$errors" = "1" ] && [ "${message#CI_SETUP_PREFLIGHT_FAILED: }" != "$message" ]; then
    codes="${message#CI_SETUP_PREFLIGHT_FAILED: }"
    if [[ "$codes" =~ $SQL_CODES_PATTERN ]]; then
      OBSERVED="$codes"
    else
      codes=""
    fi
  fi
  if [ -n "$codes" ]; then
    rest="$EXPECTED_SQL_CODES, "
    while [ -n "$rest" ]; do
      expected="${rest%%, *}"
      rest="${rest#*, }"
      case ", $codes, " in
        *", $expected, "*) ;;
        *) missing=1 ;;
      esac
    done
    if [ "$codes" != "$EXPECTED_SQL_CODES" ] && [ "$missing" = "0" ]; then
      extra=1
    fi
  fi
  if [ "$reported" = "1" ]; then
    VERDICT="CI_REFUSAL_SQL_REPORTED_SUCCESS"
  elif [ "$status" = "0" ]; then
    VERDICT="CI_REFUSAL_SQL_SUCCEEDED"
  elif [ "$unrecognized" = "1" ]; then
    VERDICT="CI_REFUSAL_UNRECOGNIZED_OUTPUT"
  elif [ "$status" != "3" ]; then
    VERDICT="CI_REFUSAL_WRONG_STATUS"
  elif [ "$errors" = "0" ]; then
    VERDICT="CI_REFUSAL_MISSING_CODE"
  elif [ "$errors" != "1" ] || [ -z "$codes" ]; then
    VERDICT="CI_REFUSAL_WRONG_ERROR"
  elif [ "$missing" = "1" ]; then
    VERDICT="CI_REFUSAL_MISSING_CODE"
  elif [ "$extra" = "1" ]; then
    VERDICT="CI_REFUSAL_UNEXPECTED_CODE"
  else
    VERDICT="CI_REFUSAL_EXPECTED"
  fi
}

# PASS for the expected refusal; otherwise FAIL with the verdict, the exit
# status (digits only), and the well-formed codes seen. For sql, also the
# fixed-label diagnostics classify_sql set, each printed only if it still
# has its validated form.
report_verdict() {
  local label="$1"
  if [ "$VERDICT" = "CI_REFUSAL_EXPECTED" ]; then
    pass "$label"
    return 0
  fi
  builtin printf 'FAIL  %s\n' "$VERDICT"
  if [[ "$STATUS" =~ ^[0-9]+$ ]]; then
    builtin printf '      exit status: %s\n' "$STATUS"
  fi
  if [ -n "$OBSERVED" ]; then
    builtin printf '      observed: %s\n' "$OBSERVED"
  fi
  if [[ "$SQL_UNRECOGNIZED" =~ $SQL_KINDS_REPORT_PATTERN ]]; then
    builtin printf '      unrecognized: %s\n' "$SQL_UNRECOGNIZED"
  fi
  if [[ "$SQL_ERROR_LINE" =~ $SQL_LINE_NUMBER_PATTERN ]]; then
    builtin printf '      error input line: %s\n' "$SQL_ERROR_LINE"
  fi
  case "$SQL_MARKER" in
    present | absent) builtin printf '      preflight marker: %s\n' "$SQL_MARKER" ;;
  esac
  exit 1
}

# ---------------------------------------------------------------------------
# Gates

check_arguments() {
  case "$-" in
    *x*) fail CI_REFUSAL_XTRACE ;;
  esac
  [ "$#" -eq 1 ] || fail CI_REFUSAL_USAGE 2
  case "$1" in
    provision) MODE="provision" ;;
    sql) MODE="sql" ;;
    *) fail CI_REFUSAL_USAGE 2 ;;
  esac
  pass CI_REFUSAL_ARGUMENTS
}

check_runner() {
  USER_ID="$(id -u)"
  [ "$USER_ID" != "0" ] || fail CI_REFUSAL_RUNNING_AS_ROOT
  [ "${GITHUB_ACTIONS:-}" = "true" ] || fail CI_REFUSAL_NOT_GITHUB_ACTIONS
  [ "${CI:-}" = "true" ] || fail CI_REFUSAL_NOT_CI
  [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ] || fail CI_REFUSAL_NOT_GITHUB_HOSTED
  [ "${RUNNER_OS:-}" = "Linux" ] || fail CI_REFUSAL_NOT_LINUX_RUNNER
  [ "$(uname -s)" = "Linux" ] || fail CI_REFUSAL_NOT_LINUX
  [ "${ImageOS:-}" = "ubuntu26" ] || fail CI_REFUSAL_IMAGE_OS
  grep -qx 'ID=ubuntu' /etc/os-release || fail CI_REFUSAL_OS_RELEASE
  grep -qx 'VERSION_ID="26.04"' /etc/os-release || fail CI_REFUSAL_OS_RELEASE
  sudo -n true || fail CI_REFUSAL_SUDO
  pass CI_REFUSAL_RUNNER
}

check_environment() {
  local name
  for name in $(compgen -e); do
    case "$name" in
      PG*|POSTGRES_*|postgres_*|DATABASE_*|TEST_DATABASE_URL) fail CI_REFUSAL_DATABASE_VARIABLE_SET ;;
      BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_XTRACEFD) fail CI_REFUSAL_SHELL_VARIABLE_SET ;;
    esac
  done
  local temp="${RUNNER_TEMP:-}"
  [[ "$temp" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail CI_REFUSAL_RUNNER_TEMP
  case "$temp" in
    *//*|*/./*|*/../*|*/.|*/..|*/) fail CI_REFUSAL_RUNNER_TEMP ;;
  esac
  [ "$(realpath -e -- "$temp")" = "$temp" ] || fail CI_REFUSAL_RUNNER_TEMP
  pass CI_REFUSAL_ENVIRONMENT
}

check_repository_files() {
  REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)" || fail CI_REFUSAL_REPOSITORY
  PROVISION_SCRIPT="$REPO_ROOT/scripts/db/ci-provision-postgres.sh"
  SQL_FILE="$REPO_ROOT/scripts/db/ci-setup.sql"
  local file
  for file in "$PROVISION_SCRIPT" "$SQL_FILE"; do
    [ -f "$file" ] && [ ! -L "$file" ] || fail CI_REFUSAL_REPOSITORY_FILE
  done
  pass CI_REFUSAL_REPOSITORY
}

# The state a successful provisioning leaves: the credential directory
# holds only the URL file; the verifier file is gone. Neither file is read.
check_credential_state() {
  local dir="$RUNNER_TEMP/$CREDENTIAL_DIR_NAME"
  [ -d "$dir" ] && [ ! -L "$dir" ] || fail CI_REFUSAL_CREDENTIAL_STATE
  [ "$(realpath -e -- "$dir")" = "$dir" ] || fail CI_REFUSAL_CREDENTIAL_STATE
  [ "$(stat -c '%u %a %F' -- "$dir")" = "$USER_ID 700 directory" ] || fail CI_REFUSAL_CREDENTIAL_STATE
  if [ -e "$dir/$VERIFIER_NAME" ] || [ -L "$dir/$VERIFIER_NAME" ]; then
    fail CI_REFUSAL_VERIFIER_PRESENT
  fi
  local entries
  shopt -s nullglob dotglob
  entries=("$dir"/*)
  shopt -u nullglob dotglob
  [ "${#entries[@]}" -eq 1 ] && [ "${entries[0]}" = "$dir/$URL_NAME" ] || fail CI_REFUSAL_CREDENTIAL_STATE
  [ -f "$dir/$URL_NAME" ] && [ ! -L "$dir/$URL_NAME" ] || fail CI_REFUSAL_CREDENTIAL_STATE
  [ "$(stat -c '%u %a %h %F' -- "$dir/$URL_NAME")" = "$USER_ID 600 1 regular file" ] || fail CI_REFUSAL_CREDENTIAL_STATE
  pass CI_REFUSAL_CREDENTIAL_STATE
}

# The cluster ci-provision-postgres.sh started, and nothing else: one
# cluster, 18/main, online on 5432, listening only on 127.0.0.1.
check_cluster_online() {
  command -v pg_lsclusters >/dev/null || fail CI_REFUSAL_NO_PG_LSCLUSTERS
  local clusters
  clusters="$(pg_lsclusters --no-header)" || fail CI_REFUSAL_CLUSTER_LIST
  case "$clusters" in
    ""|*$'\n'*) fail CI_REFUSAL_CLUSTER_COUNT ;;
  esac
  local version cluster port status owner data_dir rest
  read -r version cluster port status owner data_dir rest <<<"$clusters"
  [ "$version" = "18" ] && [ "$cluster" = "main" ] && [ "$port" = "$PORT" ] && [ "$status" = "online" ] && [ "$owner" = "postgres" ] && [ "$data_dir" = "$DATA_DIR" ] || fail CI_REFUSAL_CLUSTER_STATE
  [ "$(systemctl is-active "$SERVICE" || true)" = "active" ] || fail CI_REFUSAL_SERVICE_NOT_ACTIVE
  local listeners
  listeners="$(ss -Hltn "sport = :$PORT")" || fail CI_REFUSAL_LISTENERS
  [ -n "$listeners" ] || fail CI_REFUSAL_LISTENERS
  local state recv send local_address peer
  while read -r state recv send local_address peer rest; do
    [ "$local_address" = "127.0.0.1:$PORT" ] || fail CI_REFUSAL_LISTENERS
  done <<<"$listeners"
  local psql_version
  psql_version="$("$PG_BIN/psql" --version)" || fail CI_REFUSAL_PSQL_BINARY
  [[ "$psql_version" =~ $PSQL_VERSION_PATTERN ]] || fail CI_REFUSAL_PSQL_BINARY
  pass CI_REFUSAL_CLUSTER
}

# One read-only query: the cluster already holds the project's test role and
# labeled test database. Anything else stops here, before ci-setup.sql.
check_provisioned() {
  local answer
  answer="$(cd / && sudo -n -u postgres -- "$PG_BIN/psql" -X -q -At -v ON_ERROR_STOP=1 -d postgres -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_spec_studio_test') AND EXISTS (SELECT 1 FROM pg_db_role_setting AS s JOIN pg_database AS d ON d.oid = s.setdatabase WHERE d.datname = 'ai_spec_studio_test' AND s.setrole = 0 AND 'app.environment=test' = ANY (s.setconfig))")" || fail CI_REFUSAL_PROVISIONED_QUERY
  [ "$answer" = "t" ] || fail CI_REFUSAL_NOT_PROVISIONED
  pass CI_REFUSAL_PROVISIONED
}

# ---------------------------------------------------------------------------
# The refusals

run_provision_refusal() {
  local output
  STATUS=0
  # trap - ERR: errtrace would otherwise run the ERR trap inside this
  # substitution when the refusal exits non-zero, and capture its text.
  if output="$(
    trap - ERR
    /bin/bash -p "$PROVISION_SCRIPT" 2>&1
  )"; then
    STATUS=0
  else
    STATUS=$?
  fi
  classify_provision "$STATUS" "$output"
  output=""
  report_verdict CI_REFUSAL_PROVISION_EXPECTED
}

run_sql_refusal() {
  local output
  STATUS=0
  if output="$(
    trap - ERR
    cd / && {
      builtin printf '%s\n' '\set ECHO none'
      builtin printf '%s\n' "\\set test_verifier '${PLACEHOLDER_VERIFIER}'"
      cat -- "$SQL_FILE"
    } | sudo -n -u postgres -- "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -d postgres -f - 2>&1
  )"; then
    STATUS=0
  else
    STATUS=$?
  fi
  classify_sql "$STATUS" "$output"
  output=""
  report_verdict CI_REFUSAL_SQL_EXPECTED
}

main() {
  check_arguments "$@"
  check_runner
  check_environment
  check_repository_files
  check_credential_state
  case "$MODE" in
    provision)
      run_provision_refusal
      ;;
    sql)
      check_cluster_online
      check_provisioned
      run_sql_refusal
      ;;
  esac
}

main "$@"
