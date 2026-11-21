-- AI Specification Studio: create-only provisioning for the disposable CI
-- PostgreSQL 18 cluster on a GitHub-hosted Ubuntu 26.04 runner ONLY.
--
-- Never run this on a developer's server: local-setup.sql and README.md cover
-- those. Every check below refuses anything but a fresh CI cluster.
--
-- How it runs (scripts/db/ci-provision-postgres.sh): as the built-in postgres
-- superuser over the Unix socket (peer authentication; no password exists),
-- reading this file from standard input after one line the script writes
-- first:
--
--   \set test_verifier '<SCRAM-SHA-256 verifier of the test role>'
--
-- so the verifier is never in a command line or a process environment. Never
-- run psql with -a, -e, -1, or --single-transaction for this file.
--
-- What it creates, and nothing else:
--   ai_spec_studio_test (database)  owned by postgres; app.environment = test
--   ai_spec_studio_test (role)      LOGIN with the SCRAM-SHA-256 verifier
--   ai_spec_studio_app              NOLOGIN, no password (the test checks
--   ai_spec_studio_migrator         NOLOGIN, no password  refer to both)
-- No ai_spec_studio_dev database: CI has only the test database.
--
-- Sequence (psql stops at the first error, ON_ERROR_STOP):
--   1. psql settings, psql version, the verifier's presence and format
--   2. server preflight: identity, socket, version, paths, settings and
--      their source file, pg_hba rules, a fresh cluster (read only)
--   3. CREATE DATABASE (autocommit: it can't run in a transaction)
--   4. one transaction: the three roles, database privileges, the label
--   5. one transaction in the test database: schema public privileges and
--      default privileges (local-setup.sql section 7, unchanged)
--   6. read-only checks in the test database, then on the server
--
-- If it stops partway: whatever committed stays, and every later run refuses
-- (the cluster is no longer fresh). Nothing is ever dropped, repaired, or
-- taken over; a failed run needs a new CI runner. Steps 3 and 4 are ordered
-- so that a failure between them leaves only an unlabeled database with no
-- project roles, which pg_hba.conf lets no one reach over TCP.
--
-- Output: fixed CI_SETUP_* codes on failure and one PASS line on success.
-- Never the verifier, a password, or a role's stored secret.

-- 1. psql settings and inputs.
\set ON_ERROR_STOP on
\set ON_ERROR_ROLLBACK off
\set AUTOCOMMIT on
\set ECHO none
\set ECHO_HIDDEN off
\set QUIET on
\set VERBOSITY default
\set SHOW_CONTEXT errors

SELECT coalesce(:VERSION_NUM BETWEEN 180000 AND 189999, false) AS ci_psql_ok
\gset
\if :ci_psql_ok
\else
DO $psql_version$ BEGIN RAISE EXCEPTION 'CI_SETUP_PSQL_VERSION: psql must be version 18'; END $psql_version$;
\endif

\if :{?test_verifier}
\else
DO $verifier_missing$ BEGIN RAISE EXCEPTION 'CI_SETUP_VERIFIER_MISSING: the test role verifier was not provided'; END $verifier_missing$;
\endif

-- The same shape ci-credentials.ts produces: iterations 4096 to 100000, a
-- 16-byte salt, 32-byte StoredKey and ServerKey, standard base64. Its
-- characters include no quote, backslash, or whitespace. numeric, not int:
-- the cast may run even when the pattern fails, and must not overflow.
-- Every statement that carries the verifier runs with psql reporting only
-- the SQLSTATE of an error, so no message, context, or query excerpt can
-- quote it.
\set VERBOSITY sqlstate
\set SHOW_CONTEXT never
SELECT coalesce(
         :'test_verifier' ~ '^SCRAM-SHA-256\$[1-9][0-9]{3,5}:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$'
         AND substring(:'test_verifier' FROM '^SCRAM-SHA-256\$([0-9]+):')::numeric BETWEEN 4096 AND 100000,
         false) AS ci_verifier_ok
\gset
\set VERBOSITY default
\set SHOW_CONTEXT errors
\if :ci_verifier_ok
\else
DO $verifier_invalid$ BEGIN RAISE EXCEPTION 'CI_SETUP_VERIFIER_INVALID: the test role verifier is not a strict SCRAM-SHA-256 verifier'; END $verifier_invalid$;
\endif

-- 2. Server preflight, read only. Every failing check is listed by code.
DO $preflight$
DECLARE
  failures text[] := ARRAY[]::text[];
  ci_conf constant text := '/etc/postgresql/18/main/conf.d/90-ai-spec-studio-ci.conf';
BEGIN
  -- Who and how: the built-in superuser, over the Unix socket.
  IF (session_user = 'postgres' AND current_user = 'postgres') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_NOT_POSTGRES'::text);
  END IF;
  IF ((SELECT oid FROM pg_roles WHERE rolname = current_user) = 10) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_NOT_BOOTSTRAP_SUPERUSER'::text);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_NOT_SUPERUSER'::text);
  END IF;
  IF (inet_server_addr() IS NULL AND inet_client_addr() IS NULL) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_NOT_UNIX_SOCKET'::text);
  END IF;

  -- Which server: PostgreSQL 18, a primary, the packaged Ubuntu cluster.
  IF (current_setting('server_version_num')::int BETWEEN 180000 AND 189999) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_SERVER_VERSION'::text);
  END IF;
  IF pg_is_in_recovery() THEN
    failures := array_append(failures, 'CI_SETUP_IN_RECOVERY'::text);
  END IF;
  IF (current_setting('data_directory') = '/var/lib/postgresql/18/main') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_DATA_DIRECTORY'::text);
  END IF;
  IF (current_setting('config_file') = '/etc/postgresql/18/main/postgresql.conf') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_CONFIG_FILE'::text);
  END IF;
  IF (current_setting('hba_file') = '/etc/postgresql/18/main/pg_hba.conf') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_HBA_FILE'::text);
  END IF;
  IF (current_setting('cluster_name') = '18/main') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_CLUSTER_NAME'::text);
  END IF;
  IF (current_setting('port') = '5432') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_PORT'::text);
  END IF;

  -- The settings from scripts/db/ci/postgresql-ci.conf, in effect and taken
  -- from that file (installed as ci_conf), with no configuration errors.
  IF (current_setting('listen_addresses') = '127.0.0.1'
      AND current_setting('ssl') = 'off'
      AND current_setting('password_encryption') = 'scram-sha-256'
      AND current_setting('log_min_error_statement') = 'panic'
      AND current_setting('log_statement') = 'none') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_SETTINGS'::text);
  END IF;
  IF ((SELECT count(*) FROM pg_settings
       WHERE name IN ('listen_addresses', 'ssl', 'password_encryption',
                      'log_min_error_statement', 'log_statement')
         AND source = 'configuration file'
         AND sourcefile = ci_conf
         AND NOT pending_restart) = 5) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_SETTINGS_SOURCE'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_file_settings WHERE error IS NOT NULL) THEN
    failures := array_append(failures, 'CI_SETUP_CONFIG_ERRORS'::text);
  END IF;
  IF (current_setting('shared_preload_libraries') = '') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_PRELOAD_LIBRARIES'::text);
  END IF;

  -- The rules from scripts/db/ci/pg_hba.conf, exactly and in order.
  IF EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE error IS NOT NULL) THEN
    failures := array_append(failures, 'CI_SETUP_HBA_ERRORS'::text);
  END IF;
  IF ((SELECT array_agg(
             format('%s|%s|%s|%s|%s|%s', type, database, user_name,
                    coalesce(address, '-'), coalesce(netmask, '-'), auth_method)
             ORDER BY rule_number)
       FROM pg_hba_file_rules)
      = ARRAY[
          'local|{all}|{postgres}|-|-|peer',
          'hostnossl|{ai_spec_studio_test}|{ai_spec_studio_test}|127.0.0.1|255.255.255.255|scram-sha-256',
          'local|{all}|{all}|-|-|reject',
          'local|{replication}|{all}|-|-|reject',
          'host|{all}|{all}|0.0.0.0|0.0.0.0|reject',
          'host|{replication}|{all}|0.0.0.0|0.0.0.0|reject',
          'host|{all}|{all}|::|::|reject',
          'host|{replication}|{all}|::|::|reject'
        ]::text[]) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_HBA_RULES'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_hba_file_rules
             WHERE options IS NOT NULL
                OR file_name IS DISTINCT FROM current_setting('hba_file')) THEN
    failures := array_append(failures, 'CI_SETUP_HBA_OPTIONS'::text);
  END IF;

  -- A fresh cluster: built-in roles, databases, and tablespaces only.
  IF EXISTS (SELECT 1 FROM pg_roles
             WHERE oid <> 10 AND (oid >= 16384 OR rolname NOT LIKE 'pg\_%')) THEN
    failures := array_append(failures, 'CI_SETUP_ROLES_NOT_FRESH'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'ai\_spec\_studio\_%')
     OR EXISTS (SELECT 1 FROM pg_database WHERE datname LIKE 'ai\_spec\_studio\_%') THEN
    failures := array_append(failures, 'CI_SETUP_PROJECT_OBJECTS_EXIST'::text);
  END IF;
  IF ((SELECT array_agg(datname::text ORDER BY datname::text COLLATE "C") FROM pg_database)
      = ARRAY['postgres', 'template0', 'template1']::text[]) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_DATABASES_NOT_FRESH'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_db_role_setting) THEN
    failures := array_append(failures, 'CI_SETUP_SETTINGS_NOT_FRESH'::text);
  END IF;
  IF ((SELECT array_agg(spcname::text ORDER BY spcname::text COLLATE "C") FROM pg_tablespace)
      = ARRAY['pg_default', 'pg_global']::text[]) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_TABLESPACES_NOT_FRESH'::text);
  END IF;
  IF ((SELECT array_agg(extname::text ORDER BY extname::text COLLATE "C") FROM pg_extension)
      = ARRAY['plpgsql']::text[]) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_EXTENSIONS_NOT_FRESH'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity
             WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()) THEN
    failures := array_append(failures, 'CI_SETUP_OTHER_SESSIONS'::text);
  END IF;
  IF (SELECT rolpassword IS NULL FROM pg_authid WHERE oid = 10) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_ADMIN_HAS_PASSWORD'::text);
  END IF;

  IF cardinality(failures) > 0 THEN
    RAISE EXCEPTION 'CI_SETUP_PREFLIGHT_FAILED: %', array_to_string(failures, ', ');
  END IF;
END
$preflight$;

-- 3. The database. CREATE DATABASE can't run in a transaction block, so it
--    runs alone (AUTOCOMMIT) and commits by itself. Create-only: it fails if
--    the database exists. Owned by postgres, so no project role can change
--    its label, rename it, or drop it.
CREATE DATABASE ai_spec_studio_test TEMPLATE template0 ENCODING 'UTF8';

-- 4. Roles, database privileges, and the label, together or not at all.
--    No project role is a member of anything, and none has members: a
--    superuser creating a role grants no membership.
--    The CREATE ROLE that carries the verifier reports only an SQLSTATE.
BEGIN;

\set VERBOSITY sqlstate
\set SHOW_CONTEXT never
CREATE ROLE ai_spec_studio_test LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'test_verifier';
\set VERBOSITY default
\set SHOW_CONTEXT errors

CREATE ROLE ai_spec_studio_app NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ai_spec_studio_migrator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- As local-setup.sql section 5 does for the test database.
REVOKE ALL ON DATABASE ai_spec_studio_test
  FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app, ai_spec_studio_test;
GRANT CONNECT, CREATE ON DATABASE ai_spec_studio_test TO ai_spec_studio_test;

ALTER DATABASE ai_spec_studio_test SET app.environment = 'test';

COMMIT;

-- 5. Test database: schema privileges, then checks. Identical to
--    local-setup.sql section 7 (ci-provisioning-files.test.ts compares them).
\connect ai_spec_studio_test

BEGIN;

REVOKE ALL ON SCHEMA public
  FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app, ai_spec_studio_test;
GRANT USAGE, CREATE ON SCHEMA public TO ai_spec_studio_test;

ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_test
  REVOKE ALL ON TABLES FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_test
  REVOKE ALL ON SEQUENCES FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_test
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_test
  REVOKE ALL ON TYPES FROM ai_spec_studio_migrator, ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_test
  REVOKE ALL ON SCHEMAS FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_test IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_test IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_test IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_test IN SCHEMA public
  REVOKE ALL ON TYPES FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app;

COMMIT;

DO $check_test$
DECLARE
  schema_failures text;
  default_failures text;
BEGIN
  SELECT string_agg(check_name, E'\n  ') INTO schema_failures
  FROM (VALUES
    ('PUBLIC has no privileges on schema public',
      NOT has_schema_privilege('public', 'public', 'USAGE')
      AND NOT has_schema_privilege('public', 'public', 'CREATE')),
    ('the test role can use and create objects in schema public',
      has_schema_privilege('ai_spec_studio_test', 'public', 'USAGE')
      AND has_schema_privilege('ai_spec_studio_test', 'public', 'CREATE')),
    ('the app and migration roles have no privileges on schema public',
      NOT has_schema_privilege('ai_spec_studio_app', 'public', 'USAGE')
      AND NOT has_schema_privilege('ai_spec_studio_app', 'public', 'CREATE')
      AND NOT has_schema_privilege('ai_spec_studio_migrator', 'public', 'USAGE')
      AND NOT has_schema_privilege('ai_spec_studio_migrator', 'public', 'CREATE'))
  ) AS checks (check_name, passed)
  WHERE passed IS DISTINCT FROM true;

  -- Default privileges for new objects the test role creates, computed as in
  -- section 6: the global entry if there is one, otherwise the built-in
  -- default, plus the per-schema entry for schema public. They must grant
  -- nothing to anyone else, apart from PUBLIC's built-in USAGE on types.
  WITH object_types (catalog_type, builtin_type, label) AS (
    VALUES ('r', 'r', 'tables'),
           ('S', 's', 'sequences'),   -- acldefault() uses 's' for sequences
           ('f', 'f', 'functions'),
           ('T', 'T', 'types'),
           ('n', 'n', 'schemas')
  ),
  layers (scope, label, acl) AS (
    SELECT scopes.scope, t.label,
           coalesce(
             (SELECT d.defaclacl FROM pg_default_acl AS d
              WHERE d.defaclrole = 'ai_spec_studio_test'::regrole::oid
                AND d.defaclnamespace = 0
                AND d.defaclobjtype = t.catalog_type::"char"),
             acldefault(t.builtin_type::"char", 'ai_spec_studio_test'::regrole::oid))
    FROM object_types AS t
    CROSS JOIN (VALUES ('global defaults'), ('schema public')) AS scopes (scope)
    UNION ALL
    SELECT 'schema public', t.label, d.defaclacl
    FROM object_types AS t
    JOIN pg_default_acl AS d
      ON d.defaclrole = 'ai_spec_studio_test'::regrole::oid
     AND d.defaclnamespace = 'public'::regnamespace::oid
     AND d.defaclobjtype = t.catalog_type::"char"
  ),
  effective (scope, label, grants) AS (
    SELECT l.scope, l.label,
           array_agg(DISTINCT format('%s:%s%s',
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
             a.privilege_type,
             CASE WHEN a.is_grantable THEN '*' ELSE '' END))
    FROM layers AS l
    CROSS JOIN LATERAL aclexplode(l.acl) AS a
    WHERE a.grantee <> 'ai_spec_studio_test'::regrole::oid
    GROUP BY l.scope, l.label
  ),
  expected (scope, label, allowed) AS (
    VALUES
      ('schema public', 'tables', ARRAY[]::text[]),
      ('schema public', 'sequences', ARRAY[]::text[]),
      ('schema public', 'functions', ARRAY[]::text[]),
      ('schema public', 'types', ARRAY['PUBLIC:USAGE']),
      ('global defaults', 'tables', ARRAY[]::text[]),
      ('global defaults', 'sequences', ARRAY[]::text[]),
      ('global defaults', 'functions', ARRAY[]::text[]),
      ('global defaults', 'types', ARRAY['PUBLIC:USAGE']),
      ('global defaults', 'schemas', ARRAY[]::text[])
  )
  SELECT string_agg(
           format('default privileges for new %s (%s): found %s, allowed %s',
                  e.label, e.scope, coalesce(f.grants, ARRAY[]::text[]), e.allowed),
           E'\n  ' ORDER BY e.scope, e.label)
  INTO default_failures
  FROM expected AS e
  LEFT JOIN effective AS f ON f.scope = e.scope AND f.label = e.label
  WHERE NOT (coalesce(f.grants, ARRAY[]::text[]) <@ e.allowed);

  IF schema_failures IS NOT NULL OR default_failures IS NOT NULL THEN
    RAISE EXCEPTION E'ai_spec_studio_test isn''t in the expected state:\n  %',
      concat_ws(E'\n  ', schema_failures, default_failures);
  END IF;
END
$check_test$;

-- 6. Read-only checks: the test database as the migration runner and the
--    integration tests expect it (fresh, owned by postgres), then the server.
DO $check_ci_test_database$
DECLARE
  failures text[] := ARRAY[]::text[];
BEGIN
  IF (current_database() = 'ai_spec_studio_test' AND current_user = 'postgres') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_TESTDB_SESSION'::text);
  END IF;
  IF ((SELECT array_agg(nspname::text ORDER BY nspname::text COLLATE "C") FROM pg_namespace
       WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema')
      = ARRAY['public']::text[]) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_TESTDB_SCHEMAS'::text);
  END IF;
  IF ((SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public')
      = 'pg_database_owner') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_TESTDB_SCHEMA_OWNER'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public') THEN
    failures := array_append(failures, 'CI_SETUP_TESTDB_NOT_EMPTY'::text);
  END IF;
  IF ((SELECT array_agg(extname::text ORDER BY extname::text COLLATE "C") FROM pg_extension)
      = ARRAY['plpgsql']::text[]) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_TESTDB_EXTENSIONS'::text);
  END IF;

  IF cardinality(failures) > 0 THEN
    RAISE EXCEPTION 'CI_SETUP_TESTDB_CHECKS_FAILED: %', array_to_string(failures, ', ');
  END IF;
END
$check_ci_test_database$;

\connect postgres

DO $check_ci_server$
DECLARE
  failures text[] := ARRAY[]::text[];
  test_db oid := (SELECT oid FROM pg_database WHERE datname = 'ai_spec_studio_test');
BEGIN
  IF EXISTS (
       SELECT 1 FROM pg_roles
       WHERE rolname = 'ai_spec_studio_test'
         AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreaterole
         AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
         AND rolconnlimit = 10 AND rolvaliduntil IS NULL) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_TEST_ROLE'::text);
  END IF;
  IF (SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid
      WHERE rolname = 'ai_spec_studio_test') IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_TEST_ROLE_SCRAM'::text);
  END IF;
  IF ((SELECT count(*) FROM pg_authid
       WHERE rolname IN ('ai_spec_studio_app', 'ai_spec_studio_migrator')
         AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreaterole
         AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
         AND rolpassword IS NULL) = 2) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_NOLOGIN_ROLES'::text);
  END IF;
  IF ((SELECT array_agg(rolname::text ORDER BY rolname::text COLLATE "C") FROM pg_roles
       WHERE oid >= 16384)
      = ARRAY['ai_spec_studio_app', 'ai_spec_studio_migrator', 'ai_spec_studio_test']::text[]) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_ROLES'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid >= 16384 OR member >= 16384) THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_MEMBERSHIPS'::text);
  END IF;
  IF ((SELECT array_agg(datname::text ORDER BY datname::text COLLATE "C") FROM pg_database)
      = ARRAY['ai_spec_studio_test', 'postgres', 'template0', 'template1']::text[]) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_DATABASES'::text);
  END IF;
  IF ((SELECT datdba FROM pg_database WHERE oid = test_db) = 10) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_OWNER'::text);
  END IF;
  -- The only role or database setting is the test database's label, at
  -- database level (setrole = 0), where the checks read it.
  IF ((SELECT count(*) FROM pg_db_role_setting) = 1
      AND EXISTS (SELECT 1 FROM pg_db_role_setting
                  WHERE setdatabase = test_db AND setrole = 0
                    AND setconfig = ARRAY['app.environment=test']::text[])) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_LABEL'::text);
  END IF;
  IF (NOT has_database_privilege('public', 'ai_spec_studio_test', 'CONNECT')
      AND NOT has_database_privilege('public', 'ai_spec_studio_test', 'TEMPORARY')
      AND NOT has_database_privilege('public', 'ai_spec_studio_test', 'CREATE')) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_PUBLIC_PRIVILEGES'::text);
  END IF;
  IF (NOT has_database_privilege('ai_spec_studio_app', 'ai_spec_studio_test', 'CONNECT')
      AND NOT has_database_privilege('ai_spec_studio_app', 'ai_spec_studio_test', 'CREATE')
      AND NOT has_database_privilege('ai_spec_studio_app', 'ai_spec_studio_test', 'TEMPORARY')
      AND NOT has_database_privilege('ai_spec_studio_migrator', 'ai_spec_studio_test', 'CONNECT')
      AND NOT has_database_privilege('ai_spec_studio_migrator', 'ai_spec_studio_test', 'CREATE')
      AND NOT has_database_privilege('ai_spec_studio_migrator', 'ai_spec_studio_test', 'TEMPORARY')) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_APP_MIGRATOR_PRIVILEGES'::text);
  END IF;
  IF (has_database_privilege('ai_spec_studio_test', 'ai_spec_studio_test', 'CONNECT')
      AND has_database_privilege('ai_spec_studio_test', 'ai_spec_studio_test', 'CREATE')
      AND NOT has_database_privilege('ai_spec_studio_test', 'ai_spec_studio_test', 'TEMPORARY')) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_TEST_PRIVILEGES'::text);
  END IF;
  IF (SELECT rolpassword IS NULL FROM pg_authid WHERE oid = 10) IS NOT TRUE THEN
    failures := array_append(failures, 'CI_SETUP_FINAL_ADMIN_PASSWORD'::text);
  END IF;

  IF cardinality(failures) > 0 THEN
    RAISE EXCEPTION 'CI_SETUP_FINAL_CHECKS_FAILED: %', array_to_string(failures, ', ');
  END IF;
END
$check_ci_server$;

-- The stored secret is exactly the verifier provided: compared on the
-- server, reported only as true or false (and an SQLSTATE on error).
\set VERBOSITY sqlstate
\set SHOW_CONTEXT never
SELECT coalesce((SELECT rolpassword FROM pg_authid WHERE rolname = 'ai_spec_studio_test')
                = :'test_verifier', false) AS ci_verifier_stored
\gset
\set VERBOSITY default
\set SHOW_CONTEXT errors
\if :ci_verifier_stored
\else
DO $verifier_not_stored$ BEGIN RAISE EXCEPTION 'CI_SETUP_FINAL_VERIFIER_NOT_STORED: the test role does not hold the provided verifier'; END $verifier_not_stored$;
\endif

\echo 'PASS  ci-setup.sql: ai_spec_studio_test provisioned and verified'
