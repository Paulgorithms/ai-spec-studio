-- AI Specification Studio: local PostgreSQL provisioning (Postgres.app)
--
-- FOR REVIEW. Don't run this until local provisioning is approved. Read
-- scripts/db/README.md first: it covers installation, loopback-only access,
-- passwords, and SCRAM authentication.
--
-- What it sets up. Running it again brings everything back to this state.
-- The one exception is privileges granted to roles other than PUBLIC and these
-- three: the script never revokes those, and its final checks stop with an
-- error if one affects the state below.
--
--   Roles (LOGIN, NOINHERIT; no superuser, CREATEDB, CREATEROLE, REPLICATION,
--   or BYPASSRLS):
--     ai_spec_studio_migrator  DDL in the development database; owns its tables
--     ai_spec_studio_app       runtime reads and writes in the development database
--     ai_spec_studio_test      integration tests in the test database
--
--   Databases, owned by the administrator running this script (never by an
--   application role, so no application role can drop them, rename them, or
--   change their environment label):
--     ai_spec_studio_dev   app.environment = 'development'
--     ai_spec_studio_test  app.environment = 'test'
--
-- Privileges are granted explicitly, role by role. Nothing relies on PUBLIC
-- defaults, role membership, or database ownership:
--   * PUBLIC loses every privilege on both project databases and on their
--     public schemas.
--   * No ai_spec_studio role may be a member of another role, or have members.
--   * The app role can only read and write rows in tables the migration role
--     creates: no DDL, TRUNCATE, REFERENCES, TRIGGER, or MAINTAIN, and no access
--     to the migration history in the drizzle schema.
--   * Between the two project databases: the app and migration roles can connect
--     only to ai_spec_studio_dev, and the test role only to ai_spec_studio_test.
--
-- Other databases on this server are left exactly as they are. PostgreSQL's
-- defaults give PUBLIC, and so every role including these three, CONNECT and
-- TEMPORARY on them: typically postgres, template1, and the database
-- Postgres.app names after your macOS user. There these roles can connect and
-- create temporary tables, but (on PostgreSQL 15 or later) can't create objects
-- in the public schema.
--
-- Existing roles and databases: a role or database that already has one of
-- these names is taken over only if it looks like this script's own (sections
-- 1 and 2). Otherwise the script stops before changing anything.
--
-- What it never does: set, change, or print passwords; drop or rename anything;
-- change server-wide settings (pg_hba.conf, listen_addresses,
-- password_encryption); or change any database other than the two above.
--
-- Passwords: roles are created without one. With Postgres.app's default "trust"
-- authentication they can log in from this computer without a password. Before
-- switching to SCRAM-SHA-256, set each password interactively with psql's
-- \password, which hashes it on the client. See README.md.
--
-- If a run stops partway: psql stops at the first error (ON_ERROR_STOP) and
-- rolls back the transaction that was open. What stays depends on the section:
--   1-3  checks, then roles: either nothing or all of the roles change
--   4    each CREATE DATABASE commits on its own. A database created before the
--        failure stays, unlabeled and with PostgreSQL's default PUBLIC CONNECT
--        and TEMPORARY privileges, until section 5 commits
--   5-7  one transaction each; earlier sections stay committed. A missing
--        section 6 or 7 fails closed (the roles can't create tables)
--   8    checks and a report only
-- Nothing is ever dropped, so recovery is always: fix the cause and run the
-- script again. Every run ends with the checks in sections 6-8, which stop with
-- an error if anything differs from the state above.
--
-- Run it, once approved, as the Postgres.app administrator over the local socket:
--   psql -X -v ON_ERROR_STOP=1 -d postgres -f scripts/db/local-setup.sql

\set ON_ERROR_STOP on
\set AUTOCOMMIT on

-- 1. Preconditions. Stop before changing anything if this isn't a local
--    Postgres.app server run by its administrator.
DO $preconditions$
BEGIN
  -- Every check below, and every object this script creates, uses current_user.
  -- After SET ROLE that is a different role from the one that connected.
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'current_user (%) differs from session_user (%). Run RESET ROLE, or reconnect as your own administrator role, before running local-setup.sql.', current_user, session_user;
  END IF;

  -- OID 10 is always the bootstrap superuser created by initdb (postgres on
  -- Postgres.app). It would own both databases, so later runs as your own role
  -- would stop below, and it can't log in after the SCRAM switch in README.md.
  IF (SELECT oid FROM pg_roles WHERE rolname = current_user) = 10 THEN
    RAISE EXCEPTION 'Run local-setup.sql as your own administrator role (your macOS user on Postgres.app), not as the bootstrap superuser %.', current_user;
  END IF;

  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'Run local-setup.sql as the Postgres.app administrator (a superuser), not as %.', current_user;
  END IF;

  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'PostgreSQL 15 or later is required (this server runs %).', current_setting('server_version');
  END IF;

  -- inet_server_addr() is NULL over a Unix socket.
  IF inet_server_addr() IS NOT NULL
     AND NOT (inet_server_addr() <<= inet '127.0.0.0/8' OR inet_server_addr() = inet '::1') THEN
    RAISE EXCEPTION 'Connect through the local socket or a loopback address, not %.', inet_server_addr();
  END IF;

  -- A tunnel can make a remote server look local, so also check that the data
  -- directory belongs to Postgres.app.
  IF current_setting('data_directory') NOT LIKE '%/Library/Application Support/Postgres/%' THEN
    RAISE EXCEPTION 'This server''s data directory isn''t a Postgres.app one. local-setup.sql only provisions a local Postgres.app server.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_db_role_setting AS s, unnest(s.setconfig) AS setting
    WHERE s.setrole = 0
      AND setting IN ('app.environment=staging', 'app.environment=production')
  ) THEN
    RAISE EXCEPTION 'A database on this server is labeled staging or production. local-setup.sql only runs on local development servers.';
  END IF;

  -- A project database that already exists must be this script's own: owned by
  -- the administrator, with either its expected label or none (a run that
  -- stopped before section 5). Anything else is left alone.
  IF EXISTS (
    SELECT 1
    FROM pg_database AS d
    LEFT JOIN pg_db_role_setting AS s ON s.setdatabase = d.oid AND s.setrole = 0
    WHERE d.datname IN ('ai_spec_studio_dev', 'ai_spec_studio_test')
      AND (
        d.datdba <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
        OR EXISTS (
          SELECT 1 FROM unnest(s.setconfig) AS setting
          WHERE setting LIKE 'app.environment=%'
            AND setting <> CASE d.datname
                             WHEN 'ai_spec_studio_dev' THEN 'app.environment=development'
                             ELSE 'app.environment=test'
                           END
        )
      )
  ) THEN
    RAISE EXCEPTION 'ai_spec_studio_dev or ai_spec_studio_test already exists but isn''t owned by % or has another environment label. Nothing was changed; review that database by hand.', current_user;
  END IF;
END
$preconditions$;

-- 2. Existing project roles. Take over a role with one of these names only if
--    it looks like this script's own. Stop if one has elevated attributes, role
--    memberships, or its own settings, or if it owns or has privileges on
--    anything outside the two project databases. pg_shdepend is shared by every
--    database on the server, so it shows dependencies in all of them.
DO $existing_roles$
DECLARE
  problems text;
BEGIN
  SELECT string_agg(problem, E'\n  ' ORDER BY problem) INTO problems
  FROM (
    SELECT format('%s has elevated attributes (superuser, CREATEROLE, CREATEDB, REPLICATION, or BYPASSRLS)', r.rolname) AS problem
    FROM pg_roles AS r
    WHERE r.rolname IN ('ai_spec_studio_migrator', 'ai_spec_studio_app', 'ai_spec_studio_test')
      AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)

    UNION ALL
    SELECT format('%s is a member of %s', member.rolname, granted.rolname)
    FROM pg_auth_members AS m
    JOIN pg_roles AS member ON member.oid = m.member
    JOIN pg_roles AS granted ON granted.oid = m.roleid
    WHERE member.rolname IN ('ai_spec_studio_migrator', 'ai_spec_studio_app', 'ai_spec_studio_test')
       OR granted.rolname IN ('ai_spec_studio_migrator', 'ai_spec_studio_app', 'ai_spec_studio_test')

    UNION ALL
    -- Role-level settings would override the database labels in current_setting().
    SELECT format('%s has its own settings (ALTER ROLE … SET)', r.rolname)
    FROM pg_db_role_setting AS s
    JOIN pg_roles AS r ON r.oid = s.setrole
    WHERE r.rolname IN ('ai_spec_studio_migrator', 'ai_spec_studio_app', 'ai_spec_studio_test')

    UNION ALL
    SELECT DISTINCT format(
      '%s owns or has privileges on objects in %s',
      r.rolname,
      CASE WHEN d.dbid = 0 THEN 'shared objects (databases or tablespaces)'
           ELSE coalesce(quote_ident(db.datname), 'database OID ' || d.dbid) END
    )
    FROM pg_shdepend AS d
    JOIN pg_roles AS r ON d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid
    LEFT JOIN pg_database AS db ON db.oid = d.dbid
    WHERE r.rolname IN ('ai_spec_studio_migrator', 'ai_spec_studio_app', 'ai_spec_studio_test')
      -- Objects inside the project databases are this script's (or its migrations').
      AND NOT (d.dbid <> 0 AND db.datname IN ('ai_spec_studio_dev', 'ai_spec_studio_test'))
      -- So are ownership of, and privileges on, the project databases themselves.
      AND NOT (
        d.dbid = 0
        AND d.classid = 'pg_database'::regclass
        AND d.objid IN (
          SELECT oid FROM pg_database WHERE datname IN ('ai_spec_studio_dev', 'ai_spec_studio_test')
        )
      )
  ) AS found;

  IF problems IS NOT NULL THEN
    RAISE EXCEPTION E'Nothing was changed: existing roles with these names don''t look like this script''s own.\n  %\nReview them by hand before running local-setup.sql again.', problems;
  END IF;
END
$existing_roles$;

-- 3. Roles: create the missing ones, then reset their attributes on every run.
--    Passwords are never touched.
DO $roles$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('ai_spec_studio_migrator', 2),
      ('ai_spec_studio_app', 20),
      ('ai_spec_studio_test', 10)
    ) AS roles (name, connection_limit)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = spec.name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', spec.name);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT %s',
      spec.name, spec.connection_limit
    );
  END LOOP;
END
$roles$;

-- 4. Databases. CREATE DATABASE can't run inside a function or transaction, so
--    psql runs the generated statements (\gexec) only for the ones that are
--    missing. Each one commits on its own (see "If a run stops partway").
SELECT format('CREATE DATABASE %I TEMPLATE template0 ENCODING %L', name, 'UTF8')
FROM unnest(ARRAY['ai_spec_studio_dev', 'ai_spec_studio_test']) AS name
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = name)
\gexec

-- 5. Database ownership, privileges, and labels.
BEGIN;

ALTER DATABASE ai_spec_studio_dev OWNER TO CURRENT_USER;
ALTER DATABASE ai_spec_studio_test OWNER TO CURRENT_USER;

-- Start from no access, then grant exactly what each role needs. CREATE on a
-- database allows creating schemas (Drizzle keeps its migration history in a
-- "drizzle" schema). It doesn't allow dropping the database.
REVOKE ALL ON DATABASE ai_spec_studio_dev
  FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app, ai_spec_studio_test;
GRANT CONNECT, CREATE ON DATABASE ai_spec_studio_dev TO ai_spec_studio_migrator;
GRANT CONNECT ON DATABASE ai_spec_studio_dev TO ai_spec_studio_app;

REVOKE ALL ON DATABASE ai_spec_studio_test
  FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app, ai_spec_studio_test;
GRANT CONNECT, CREATE ON DATABASE ai_spec_studio_test TO ai_spec_studio_test;

-- Server-side environment labels. Only the owner (the administrator) or a
-- superuser can change them. Safety checks should read them from
-- pg_db_role_setting rather than current_setting(), which a session or role
-- setting can override.
ALTER DATABASE ai_spec_studio_dev SET app.environment = 'development';
ALTER DATABASE ai_spec_studio_test SET app.environment = 'test';

COMMIT;

-- 6. Development database: schema privileges, then checks.
\connect ai_spec_studio_dev

BEGIN;

REVOKE ALL ON SCHEMA public
  FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app, ai_spec_studio_test;
GRANT USAGE, CREATE ON SCHEMA public TO ai_spec_studio_migrator;
GRANT USAGE ON SCHEMA public TO ai_spec_studio_app;

-- Objects the migration role creates later: the app role may read and write
-- rows and use sequences, nothing more. Functions aren't executable by PUBLIC.
--
-- Deferred to Step 4 (migration review): these defaults cover only objects that
-- ai_spec_studio_migrator itself creates, so migrations must run as that role
-- (check table owners). A SECURITY DEFINER function created by a migration
-- would run with the migrator's privileges when the app calls it, so add none
-- without explicit approval and a pinned search_path.
--
-- First remove whatever an earlier run (or anyone else) granted to these
-- grantees, globally and in schema public, so every run ends with exactly the
-- defaults below. Grants to other roles aren't touched, and make the checks
-- below fail.
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator
  REVOKE ALL ON TABLES FROM PUBLIC, ai_spec_studio_app, ai_spec_studio_test;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator
  REVOKE ALL ON SEQUENCES FROM PUBLIC, ai_spec_studio_app, ai_spec_studio_test;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, ai_spec_studio_app, ai_spec_studio_test;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator
  REVOKE ALL ON TYPES FROM ai_spec_studio_app, ai_spec_studio_test;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator
  REVOKE ALL ON SCHEMAS FROM PUBLIC, ai_spec_studio_app, ai_spec_studio_test;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, ai_spec_studio_app, ai_spec_studio_test;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, ai_spec_studio_app, ai_spec_studio_test;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, ai_spec_studio_app, ai_spec_studio_test;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator IN SCHEMA public
  REVOKE ALL ON TYPES FROM PUBLIC, ai_spec_studio_app, ai_spec_studio_test;

ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO ai_spec_studio_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ai_spec_studio_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO ai_spec_studio_app;

COMMIT;

DO $check_development$
DECLARE
  schema_failures text;
  default_failures text;
BEGIN
  SELECT string_agg(check_name, E'\n  ') INTO schema_failures
  FROM (VALUES
    ('PUBLIC has no privileges on schema public',
      NOT has_schema_privilege('public', 'public', 'USAGE')
      AND NOT has_schema_privilege('public', 'public', 'CREATE')),
    ('the app role can use schema public but not create objects in it',
      has_schema_privilege('ai_spec_studio_app', 'public', 'USAGE')
      AND NOT has_schema_privilege('ai_spec_studio_app', 'public', 'CREATE')),
    ('the migration role can use and create objects in schema public',
      has_schema_privilege('ai_spec_studio_migrator', 'public', 'USAGE')
      AND has_schema_privilege('ai_spec_studio_migrator', 'public', 'CREATE')),
    ('the test role has no privileges on schema public',
      NOT has_schema_privilege('ai_spec_studio_test', 'public', 'USAGE')
      AND NOT has_schema_privilege('ai_spec_studio_test', 'public', 'CREATE'))
  ) AS checks (check_name, passed)
  WHERE passed IS DISTINCT FROM true;

  -- Default privileges for new objects the migration role creates, computed
  -- the way PostgreSQL documents them instead of from which catalog rows
  -- happen to exist:
  --   * global defaults (every schema): the global pg_default_acl entry if
  --     there is one, otherwise the built-in default from acldefault(), which
  --     gives PUBLIC EXECUTE on functions and USAGE on types
  --   * schema public: the global defaults plus the per-schema entry
  -- The owner's own privileges are left out. A grant option is marked "*", so
  -- it never matches an allowed privilege. Each kind of object must have every
  -- required grant and nothing beyond the allowed ones, so anything missing or
  -- extra fails.
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
              WHERE d.defaclrole = 'ai_spec_studio_migrator'::regrole::oid
                AND d.defaclnamespace = 0
                AND d.defaclobjtype = t.catalog_type::"char"),
             acldefault(t.builtin_type::"char", 'ai_spec_studio_migrator'::regrole::oid))
    FROM object_types AS t
    CROSS JOIN (VALUES ('global defaults'), ('schema public')) AS scopes (scope)
    UNION ALL
    SELECT 'schema public', t.label, d.defaclacl
    FROM object_types AS t
    JOIN pg_default_acl AS d
      ON d.defaclrole = 'ai_spec_studio_migrator'::regrole::oid
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
    WHERE a.grantee <> 'ai_spec_studio_migrator'::regrole::oid
    GROUP BY l.scope, l.label
  ),
  expected (scope, label, required, allowed) AS (
    VALUES
      ('schema public', 'tables',
        ARRAY['ai_spec_studio_app:SELECT', 'ai_spec_studio_app:INSERT',
              'ai_spec_studio_app:UPDATE', 'ai_spec_studio_app:DELETE'],
        ARRAY['ai_spec_studio_app:SELECT', 'ai_spec_studio_app:INSERT',
              'ai_spec_studio_app:UPDATE', 'ai_spec_studio_app:DELETE']),
      ('schema public', 'sequences',
        ARRAY['ai_spec_studio_app:USAGE'], ARRAY['ai_spec_studio_app:USAGE']),
      ('schema public', 'functions',
        ARRAY['ai_spec_studio_app:EXECUTE'], ARRAY['ai_spec_studio_app:EXECUTE']),
      ('schema public', 'types', ARRAY[]::text[], ARRAY['PUBLIC:USAGE']),
      ('global defaults', 'tables', ARRAY[]::text[], ARRAY[]::text[]),
      ('global defaults', 'sequences', ARRAY[]::text[], ARRAY[]::text[]),
      ('global defaults', 'functions', ARRAY[]::text[], ARRAY[]::text[]),
      ('global defaults', 'types', ARRAY[]::text[], ARRAY['PUBLIC:USAGE']),
      ('global defaults', 'schemas', ARRAY[]::text[], ARRAY[]::text[])
  )
  SELECT string_agg(
           format('default privileges for new %s (%s): found %s, required %s, allowed %s',
                  e.label, e.scope, coalesce(f.grants, ARRAY[]::text[]), e.required, e.allowed),
           E'\n  ' ORDER BY e.scope, e.label)
  INTO default_failures
  FROM expected AS e
  LEFT JOIN effective AS f ON f.scope = e.scope AND f.label = e.label
  WHERE NOT (coalesce(f.grants, ARRAY[]::text[]) @> e.required
             AND coalesce(f.grants, ARRAY[]::text[]) <@ e.allowed);

  IF schema_failures IS NOT NULL OR default_failures IS NOT NULL THEN
    RAISE EXCEPTION E'ai_spec_studio_dev isn''t in the expected state:\n  %',
      concat_ws(E'\n  ', schema_failures, default_failures);
  END IF;
END
$check_development$;

-- 7. Test database: schema privileges, then checks.
\connect ai_spec_studio_test

BEGIN;

REVOKE ALL ON SCHEMA public
  FROM PUBLIC, ai_spec_studio_migrator, ai_spec_studio_app, ai_spec_studio_test;
GRANT USAGE, CREATE ON SCHEMA public TO ai_spec_studio_test;

-- Objects the test role creates are its own: no default privileges for anyone
-- else, and functions aren't executable by PUBLIC.
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

-- 8. Final checks on roles, ownership, labels, and database privileges, then a
--    read-only report. The report shows whether each role has a password,
--    never the password or its hash.
\connect postgres

DO $check_server$
DECLARE
  failures text;
BEGIN
  SELECT string_agg(check_name, E'\n  ') INTO failures
  FROM (VALUES
    ('the three roles exist with LOGIN, NOINHERIT, and no elevated attributes',
      (SELECT count(*) FROM pg_roles
       WHERE rolname IN ('ai_spec_studio_migrator', 'ai_spec_studio_app', 'ai_spec_studio_test')
         AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreaterole
         AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls) = 3),
    ('the roles have the expected connection limits',
      (SELECT count(*) FROM pg_roles
       WHERE (rolname, rolconnlimit) IN (('ai_spec_studio_migrator', 2),
                                         ('ai_spec_studio_app', 20),
                                         ('ai_spec_studio_test', 10))) = 3),
    ('no role memberships involve the project roles',
      NOT EXISTS (
        SELECT 1 FROM pg_auth_members AS m
        JOIN pg_roles AS r ON r.oid IN (m.roleid, m.member)
        WHERE r.rolname IN ('ai_spec_studio_migrator', 'ai_spec_studio_app', 'ai_spec_studio_test')
      )),
    ('the project roles have no role-level settings',
      NOT EXISTS (
        SELECT 1 FROM pg_db_role_setting AS s
        JOIN pg_roles AS r ON r.oid = s.setrole
        WHERE r.rolname IN ('ai_spec_studio_migrator', 'ai_spec_studio_app', 'ai_spec_studio_test')
      )),
    ('both databases are owned by the administrator',
      (SELECT count(*) FROM pg_database
       WHERE datname IN ('ai_spec_studio_dev', 'ai_spec_studio_test')
         AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)) = 2),
    ('ai_spec_studio_dev is labeled development',
      EXISTS (
        SELECT 1 FROM pg_db_role_setting AS s
        JOIN pg_database AS d ON d.oid = s.setdatabase
        WHERE d.datname = 'ai_spec_studio_dev' AND s.setrole = 0
          AND 'app.environment=development' = ANY (s.setconfig)
      )),
    ('ai_spec_studio_test is labeled test',
      EXISTS (
        SELECT 1 FROM pg_db_role_setting AS s
        JOIN pg_database AS d ON d.oid = s.setdatabase
        WHERE d.datname = 'ai_spec_studio_test' AND s.setrole = 0
          AND 'app.environment=test' = ANY (s.setconfig)
      )),
    ('PUBLIC has no privileges on either project database',
      NOT has_database_privilege('public', 'ai_spec_studio_dev', 'CONNECT')
      AND NOT has_database_privilege('public', 'ai_spec_studio_dev', 'TEMPORARY')
      AND NOT has_database_privilege('public', 'ai_spec_studio_dev', 'CREATE')
      AND NOT has_database_privilege('public', 'ai_spec_studio_test', 'CONNECT')
      AND NOT has_database_privilege('public', 'ai_spec_studio_test', 'TEMPORARY')
      AND NOT has_database_privilege('public', 'ai_spec_studio_test', 'CREATE')),
    ('the migration role has exactly CONNECT and CREATE on ai_spec_studio_dev, nothing on ai_spec_studio_test',
      has_database_privilege('ai_spec_studio_migrator', 'ai_spec_studio_dev', 'CONNECT')
      AND has_database_privilege('ai_spec_studio_migrator', 'ai_spec_studio_dev', 'CREATE')
      AND NOT has_database_privilege('ai_spec_studio_migrator', 'ai_spec_studio_dev', 'TEMPORARY')
      AND NOT has_database_privilege('ai_spec_studio_migrator', 'ai_spec_studio_test', 'CONNECT')),
    ('the app role has exactly CONNECT on ai_spec_studio_dev, nothing on ai_spec_studio_test',
      has_database_privilege('ai_spec_studio_app', 'ai_spec_studio_dev', 'CONNECT')
      AND NOT has_database_privilege('ai_spec_studio_app', 'ai_spec_studio_dev', 'CREATE')
      AND NOT has_database_privilege('ai_spec_studio_app', 'ai_spec_studio_dev', 'TEMPORARY')
      AND NOT has_database_privilege('ai_spec_studio_app', 'ai_spec_studio_test', 'CONNECT')),
    ('the test role has exactly CONNECT and CREATE on ai_spec_studio_test, nothing on ai_spec_studio_dev',
      has_database_privilege('ai_spec_studio_test', 'ai_spec_studio_test', 'CONNECT')
      AND has_database_privilege('ai_spec_studio_test', 'ai_spec_studio_test', 'CREATE')
      AND NOT has_database_privilege('ai_spec_studio_test', 'ai_spec_studio_test', 'TEMPORARY')
      AND NOT has_database_privilege('ai_spec_studio_test', 'ai_spec_studio_dev', 'CONNECT'))
  ) AS checks (check_name, passed)
  WHERE passed IS DISTINCT FROM true;

  IF failures IS NOT NULL THEN
    RAISE EXCEPTION E'The server isn''t in the expected state:\n  %', failures;
  END IF;
END
$check_server$;

SELECT rolname AS role,
       rolcanlogin AS can_login,
       rolsuper AS superuser,
       rolinherit AS inherits,
       rolcreatedb AS create_db,
       rolcreaterole AS create_role,
       rolreplication AS replication,
       rolbypassrls AS bypass_rls,
       rolconnlimit AS connection_limit,
       rolpassword IS NOT NULL AS has_password,
       coalesce(rolpassword LIKE 'SCRAM-SHA-256$%', false) AS scram_password
FROM pg_authid
WHERE rolname LIKE 'ai\_spec\_studio\_%'
ORDER BY rolname;

SELECT d.datname AS database,
       pg_get_userbyid(d.datdba) AS owner,
       d.datacl AS privileges,
       s.setconfig AS settings
FROM pg_database AS d
LEFT JOIN pg_db_role_setting AS s ON s.setdatabase = d.oid AND s.setrole = 0
WHERE d.datname LIKE 'ai\_spec\_studio\_%'
ORDER BY d.datname;
