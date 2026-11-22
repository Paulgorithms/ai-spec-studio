# Local PostgreSQL with Postgres.app

How to set up the local databases that development and the integration tests use. Everything here runs on your own computer; nothing in it touches a shared or hosted database. The one exception is [CI integration tests](#ci-integration-tests), which describes the disposable database the CI job creates on its own runner.

You end up with:

- `ai_spec_studio_dev`, the development database, labeled `development`
- `ai_spec_studio_test`, the integration-test database, labeled `test`
- `ai_spec_studio_migrator`, which changes the development schema (migrations)
- `ai_spec_studio_app`, which the app uses to read and write rows in the development database
- `ai_spec_studio_test`, which the integration tests use in the test database
- password (SCRAM-SHA-256) authentication for every connection except your own administrator role over the local socket

Between the two project databases, the app and migration roles can connect only to `ai_spec_studio_dev`, and the test role only to `ai_spec_studio_test`. [`local-setup.sql`](./local-setup.sql) creates all of this; read its header for exactly what each role can do, and what happens if a run stops partway.

**Other databases and projects on the same server.** The script changes nothing outside the two project databases and their three roles. PostgreSQL's defaults still let every role, these three included, connect to the server's other databases (such as `postgres`) and create temporary tables there. Steps 2 and 5, though, change settings for the **whole server**: if other projects use this Postgres.app server, their roles need passwords too before step 5, or they'll stop connecting. Only step 3 is scripted; do the other steps yourself.

**Conventions in this guide.**

- `<admin>` is your administrator role: the PostgreSQL role named after your macOS user (`whoami`), which Postgres.app creates. Step 1, item 6 checks it. Replace `<admin>` with that name wherever it appears.
- Commands connect over the local Unix socket explicitly, with `-h /tmp -p 5432` (Postgres.app's socket directory and default port). If you changed the port, use yours.
- `-X` skips `~/.psqlrc`, so your own psql settings can't change what a command does.
- Values under [Verified reference setup](#verified-reference-setup) are from the machine this guide was tested on. Yours can differ; the steps say what to check.

## 1. Install Postgres.app

1. Download **Postgres.app with PostgreSQL 18** from the official site only, [postgresapp.com/downloads.html](https://postgresapp.com/downloads.html). Version 2.9.6 bundles PostgreSQL 18.6, is labeled "Universal" (Intel and Apple Silicon), and needs macOS 10.15 or later.
2. Move it to `/Applications`. Before opening it, check that macOS accepts its signature (these only read):

   ```bash
   spctl --assess --type execute -vv /Applications/Postgres.app   # expect: accepted
   codesign --verify --deep --strict -v /Applications/Postgres.app # expect: valid on disk
   ```

   If either check fails, delete the app and download it again from the official site.

3. Open it and click **Initialize** to create and start a PostgreSQL 18 server.
4. Add its command-line tools to your `PATH`, then open a new terminal window:

   ```bash
   sudo mkdir -p /etc/paths.d &&
     echo /Applications/Postgres.app/Contents/Versions/latest/bin | sudo tee /etc/paths.d/postgresapp
   ```

   Terminals (and tools such as editors) started before this don't see the new `PATH`. There, use the full path, `/Applications/Postgres.app/Contents/Versions/latest/bin/psql`.

5. Check the tools and the server:

   ```bash
   which psql                                       # /Applications/Postgres.app/Contents/Versions/latest/bin/psql
   psql -X -h /tmp -p 5432 -d postgres -c 'SELECT version();'
   ```

   `version()` may name an `aarch64-apple-darwin` build even on an Intel Mac. That text is fixed when Postgres.app is built and describes the build machine, not yours.

   **Postgres.app's permission dialog.** Postgres.app 2.7 and later shows a dialog before any program connects without a password. That covers `trust` authentication (every connection until step 5) **and** `peer` authentication (your administrator connections after step 5). Password (SCRAM) connections never show it.
   - Click **OK** to allow it. Postgres.app remembers the choice for that program, so it asks once per program: Terminal, your editor's terminal, and later `node` each ask separately.
   - **Don't Allow** refuses the connection ("You did not allow … to connect without a password"). A dialog left unanswered makes the connection fail after about a minute (`FATAL: Postgres.app failed to verify "trust" authentication`, "You did not confirm the permission dialog"), and processes Postgres.app can't identify are refused.
   - You can review or reset the choices under **Postgres.app → Settings**. Keep **Ask for permission when apps connect without password** turned on.

6. **Confirm the administrator's identity.** Postgres.app has two superusers:
   - `postgres`, the bootstrap superuser created when the server is initialized (always OID 10), and
   - a role named after your macOS user, which Postgres.app creates for you along with a database of the same name. `psql` with no `-U` connects as this role. This is `<admin>`.

   **Use `<admin>` for everything in this guide, including `local-setup.sql`.** Never run it with `-U postgres`, and never after `SET ROLE` or `SET SESSION AUTHORIZATION`:
   - The script makes the administrator that runs it the owner of the two databases, and checks that ownership on every later run. Databases created by `postgres` would make later runs as `<admin>` stop with an error.
   - Step 5's `peer` rule only lets in the role named after your macOS user. Without a password, `postgres` can't log in at all after step 5. That's intended; give it a password only if you have a reason to use it.

   Check that `psql` connects as your own role:

   ```bash
   echo "PGUSER=${PGUSER:-<not set>}"                 # must be <not set>
   whoami
   psql -X -h /tmp -p 5432 -d postgres -Atc 'SELECT current_user, session_user, rolsuper FROM pg_roles WHERE rolname = current_user;'
   ```

   Both names `psql` prints must equal `whoami`, followed by `|t` (superuser). If they don't, stop. Step 5's `peer` rule would lock the administrator out, so either give the administrator a password with `\password` before step 5 and use `scram-sha-256` instead of `peer` for it, or map the names in `pg_ident.conf`.

## 2. Keep the server loopback-only

PostgreSQL should accept connections only from this computer, and not log password changes:

```bash
psql -X -h /tmp -p 5432 -d postgres -c 'SHOW listen_addresses;'            # expect: localhost
psql -X -h /tmp -p 5432 -d postgres -c 'SHOW password_encryption;'         # expect: scram-sha-256
psql -X -h /tmp -p 5432 -d postgres -c 'SHOW log_statement;'               # expect: none
psql -X -h /tmp -p 5432 -d postgres -c 'SHOW log_min_duration_statement;'  # expect: -1
```

- If `listen_addresses` is anything else (such as `*`), run `psql -X -h /tmp -p 5432 -d postgres -c "ALTER SYSTEM SET listen_addresses = 'localhost';"`, then stop and start the server in Postgres.app.
- If `password_encryption` isn't `scram-sha-256`, run `psql -X -h /tmp -p 5432 -d postgres -c "ALTER SYSTEM SET password_encryption = 'scram-sha-256';" -c 'SELECT pg_reload_conf();'` before setting any password in step 4.
- If `log_statement` is `ddl` or `all`, or `log_min_duration_statement` isn't `-1`, the server log records every `ALTER ROLE … PASSWORD` statement. That includes the password hashes `\password` sends in step 4: they aren't passwords, but they allow offline guessing. Change those settings back (or leave password changes until they're off).

These are server-wide settings (see the note at the top).

**The server log.** Postgres.app writes the server's log to `postgresql.log` in the data directory, `~/Library/Application Support/Postgres/var-18/postgresql.log` for PostgreSQL 18 (`psql -X -h /tmp -p 5432 -d postgres -Atc 'SHOW data_directory;'` prints yours). Steps 5 and 7 read it. It records failed connections and statements that cause errors, so keep it private (Postgres.app creates it readable only by you).

## 3. Create the roles and databases

Only once provisioning is approved. From the project folder (the worktree, if you work in one), run the script as `<admin>` (no `-U`) over the local socket:

```bash
psql -X -v ON_ERROR_STOP=1 -h /tmp -p 5432 -d postgres -f scripts/db/local-setup.sql
```

Don't add `-1` (`--single-transaction`): `CREATE DATABASE` can't run inside a transaction. If Postgres.app shows its permission dialog for your terminal, click **OK**. If the connection is refused or times out instead, the script stops at its first statement with nothing changed; allow the terminal in Postgres.app's settings and run it again.

- **It stops without changing anything** unless it's connected to a local Postgres.app server as **your own superuser role**: not the bootstrap `postgres` role, and not after `SET ROLE`. It also stops if a database on the server is labeled `staging` or `production`, or if a role or database with one of the project names already exists and doesn't look like its own:
  - a role with elevated attributes, role memberships, or role settings, or that owns or has been granted anything outside the two project databases
  - a database not owned by the administrator, or labeled with a different environment
- **The two identity checks** and what to do about them:

  | Error                                                                                                                            | Fix                                                                                                                    |
  | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
  | `current_user (…) differs from session_user (…)`                                                                                 | Run `RESET ROLE` (and `RESET SESSION AUTHORIZATION`), or open a new `psql` that doesn't change roles, and run it again |
  | `Run local-setup.sql as your own administrator role (your macOS user on Postgres.app), not as the bootstrap superuser postgres.` | Reconnect without `-U postgres` (step 1, item 6) and run it again                                                      |

- **It ends with checks** of every role attribute, ownership, label, and privilege it sets, and stops with an error if anything differs. The two tables it prints show each role's attributes (including whether it has a SCRAM password) and each database's owner, privileges, and label.
- **Running it again is safe.** It creates what's missing and resets the roles' attributes, privileges, and default privileges. It never changes passwords, drops anything, or revokes privileges granted to other roles (the final checks report any that get in the way). If a run stops partway (see the script's header), fix the cause and run it again.

## 4. Set passwords

Postgres.app starts with "trust" authentication: any program on this computer can connect as any role without a password. Give each role a password before switching to SCRAM in step 5.

1. **Generate one random password per role in your password manager**, and store it there. Prefer that to a shell command such as `openssl rand -hex 24`, which prints the password to your terminal. Use hex or other URL-safe characters; otherwise, percent-encode characters such as `@`, `:`, `/`, `?`, and `#` when you put them in `.env.local`.
2. **Set each password interactively** in your own terminal, not through any tool that records or shares its output. `\password` prompts twice without echoing, hashes the password on your computer with SCRAM-SHA-256, and sends only the hash, so the plain password never reaches the server or your shell history:

   ```bash
   psql -X -h /tmp -p 5432 -d postgres
   ```

   ```text
   postgres=# \password ai_spec_studio_migrator
   postgres=# \password ai_spec_studio_app
   postgres=# \password ai_spec_studio_test
   ```

Never pass a password on the command line, in `-c` SQL, in `ALTER ROLE … PASSWORD '…'`, in `PGPASSWORD`, or in a connection URL you type: those end up in shell history, process listings, or the server log.

## 5. Require SCRAM authentication

This changes how **every** connection to the server authenticates. Follow the order exactly: an administrator session stays open the whole time, so you can always undo the change, and nothing takes effect until the reload in item 6.

The commands below use these variables. Set them in the terminal you edit files from (not the recovery session):

```bash
D="$(psql -X -h /tmp -p 5432 -d postgres -Atc 'SHOW data_directory;')"
H="$(psql -X -h /tmp -p 5432 -d postgres -Atc 'SHOW hba_file;')"   # normally "$D/pg_hba.conf"
ADMIN="$(whoami)"                                                  # <admin>
PG_CTL=/Applications/Postgres.app/Contents/Versions/18/bin/pg_ctl   # the version that runs the server
```

1. **Check the preconditions.** Every role that will connect with a password needs a SCRAM password. All three rows must show `t` (the query returns only booleans, never the hash). Also check the roles of any other project on this server.

   ```bash
   psql -X -h /tmp -p 5432 -d postgres -c "SELECT rolname, coalesce(rolpassword LIKE 'SCRAM-SHA-256\$%', false) AS scram_password FROM pg_authid WHERE rolname LIKE 'ai\_spec\_studio\_%' ORDER BY rolname;"
   "$PG_CTL" status -D "$D"   # expect: server is running (PID: …), the independent recovery tool
   ```

2. **Open the recovery session first**, in a separate Terminal window, and leave it open until item 8. Reloading the rules doesn't affect sessions that are already connected, so this one keeps working whatever happens:

   ```bash
   psql -X -h /tmp -p 5432 -d postgres
   ```

   ```sql
   SELECT current_user, session_user, pg_backend_pid(), inet_server_addr() IS NULL AS unix_socket;
   SELECT pg_conf_load_time();   -- note this time; item 7 compares against it
   ```

   It must show `<admin>` twice and `unix_socket = t`.

3. **Back up the authentication file** with a timestamp, never overwriting an existing backup, and check that the copy is identical:

   ```bash
   B="$H.pre-scram-$(date +%Y%m%dT%H%M%S)"
   [ ! -e "$B" ] && cp -n -p "$H" "$B"
   shasum -a 256 "$H" "$B"                  # both checksums must be equal
   stat -f '%Su:%Sg %OLp' "$H" "$B"         # both owned by you, mode 600
   ```

   Keep the backup. It's the only way back to the original rules (see [Emergency rollback](#emergency-rollback)).

4. **Prepare the new file next to the active one.** This comments out every active rule (keeping all comments and other lines as they are) and appends the four approved rules:

   ```bash
   umask 077
   { sed -E 's/^(local|host|hostssl|hostnossl|hostgssenc|hostnogssenc|include|include_if_exists|include_dir)([[:space:]])/# \1\2/' "$B"
     cat <<EOF

   # Local development: SCRAM for every role; peer for the administrator over the socket only.
   # Original rules saved as $(basename "$B")
   # TYPE  DATABASE        USER            ADDRESS                 METHOD
   local   all             $ADMIN                            peer
   local   all             all                                     scram-sha-256
   host    all             all             127.0.0.1/32            scram-sha-256
   host    all             all             ::1/128                 scram-sha-256
   EOF
   } > "$H.new"
   diff "$B" "$H.new"                                   # only "# " added to the old rules, plus the block above
   grep -n -v -E '^[[:space:]]*(#|$)' "$H.new"          # exactly the four new rules
   stat -f '%Su:%Sg %OLp' "$H.new"                      # owned by you, mode 600
   ```

   On a fresh Postgres.app 18 server, the old rules are six `trust` rules: `local`, `127.0.0.1/32`, and `::1/128`, once for `all` databases and once for `replication`. If `diff` shows any other change, or `grep` lists anything but the four rules, delete `"$H.new"` and stop.

   What the four rules do. PostgreSQL uses the **first** rule that matches a connection's type, database, and user. If that rule's authentication fails, the connection fails; it never tries the next rule.

   | Connection                                     | Rule                          | Result                                                                                                  |
   | ---------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
   | Local socket as `<admin>`                      | `local … <admin> peer`        | Allowed only for the macOS user of the same name; anyone else claiming `<admin>` is refused             |
   | Local socket as any other role                 | `local all all scram-sha-256` | Needs that role's SCRAM password. `postgres` has none, so it can't log in                               |
   | `127.0.0.1` or `::1`, any role (`<admin>` too) | `host … scram-sha-256`        | Needs a SCRAM password. `<admin>` has none, so **the administrator connects only over the socket**      |
   | Physical replication                           | none                          | Refused (`no pg_hba.conf entry for replication connection`): the `replication` keyword has no rule left |
   | Logical replication (`replication=database`)   | the same rules as above       | Allowed for `<admin>` through `peer`, and for other roles only with a SCRAM password (see below)        |
   | Any other address                              | none                          | Refused. The server also listens only on loopback (step 2)                                              |

   **Replication.** In `pg_hba.conf`, the keyword `replication` matches only _physical_ replication. A _logical_ replication connection names a real database, so it matches the ordinary `all` rules. With these rules, `<admin>`, as a superuser, can open one through `peer`, which gives it nothing it doesn't already have. This is accepted for local development.

5. **Install it and check how PostgreSQL reads it.** The rename is atomic, and the file isn't in effect until item 6:

   ```bash
   mv -f "$H.new" "$H"
   ```

   ```sql
   -- In the recovery session:
   SELECT rule_number, line_number, type, database, user_name, address, auth_method, error
   FROM pg_hba_file_rules ORDER BY rule_number;
   ```

   It must return exactly four rows, in the order above, with `peer` then three `scram-sha-256`, no `trust`, no `replication`, and an empty `error` column. **`pg_hba_file_rules` reads the file as it is on disk, not the rules the server is enforcing**, which stay the old ones until the reload. If anything is wrong, put the original back with `cp -p "$B" "$H"` (nothing was in effect, so no reload is needed) and stop.

6. **Apply the rules** from the recovery session:

   ```sql
   SELECT pg_reload_conf();   -- t means only that the signal was sent
   ```

7. **Confirm the reload worked.** A file PostgreSQL can't parse doesn't take effect: it keeps the old rules and logs `pg_hba.conf was not reloaded`.

   ```sql
   -- In the recovery session: must be later than the time from item 2.
   SELECT pg_conf_load_time();
   ```

   ```bash
   grep -E 'received SIGHUP|was not reloaded|could not load pg_hba' "$D/postgresql.log" | tail -n 3
   # expect a new "received SIGHUP, reloading configuration files" line and no failure line after it
   ```

   Then prove the rules are in effect with **new** connections (in another terminal, not the recovery session). `system_user` names the authentication method and is empty under `trust`; `-w` never prompts for a password:

   ```bash
   # The administrator through peer: no password prompt; expect <admin>|<admin>|peer:<admin>.
   psql -X -w -h /tmp -p 5432 -d postgres -Atc 'SELECT current_user, session_user, system_user;'

   # Without a password, each of these must fail with "fe_sendauth: no password supplied".
   psql -X -w -h /tmp      -p 5432 -U ai_spec_studio_app -d ai_spec_studio_dev -c 'SELECT 1;'
   psql -X -w -h 127.0.0.1 -p 5432 -U ai_spec_studio_app -d ai_spec_studio_dev -c 'SELECT 1;'
   psql -X -w -h ::1       -p 5432 -U ai_spec_studio_app -d ai_spec_studio_dev -c 'SELECT 1;'
   psql -X -w -h /tmp      -p 5432 -U postgres -d postgres -c 'SELECT 1;'
   psql -X -w -h 127.0.0.1 -p 5432 -d postgres -c 'SELECT 1;'      # <admin> over TCP

   # Physical replication must fail with "no pg_hba.conf entry for replication connection".
   psql -X -w "host=/tmp port=5432 dbname=postgres replication=true" -c 'IDENTIFY_SYSTEM;'
   ```

   Finally, log in with each password. `-W` makes `psql` prompt for it (nothing is echoed or saved), and `system_user` must show `scram-sha-256:<role>`. Repeat for the migration role (`ai_spec_studio_dev`) and the test role (`ai_spec_studio_test`), and over `127.0.0.1` and `::1` as well as the socket:

   ```bash
   psql -X -W -h /tmp -p 5432 -U ai_spec_studio_app -d ai_spec_studio_dev \
     -c 'SELECT current_user, session_user, system_user, current_database();'
   ```

8. **Close the recovery session** (`\q`) only if every check in item 7 behaved as described. If one didn't, keep it open and use [Emergency rollback](#emergency-rollback).

After the switch:

- The administrator connects only over the local socket (`-h /tmp`), through `peer`, and Postgres.app's permission dialog still applies to it. Every other connection needs a SCRAM password and never shows the dialog.
- `postgres` can't log in, and physical replication is refused.
- `local-setup.sql` still runs as before (step 3): it connects as `<admin>` over the socket.

### Emergency rollback

**Restoring the backup is an emergency measure, not a normal operation.** It brings back the original `trust` rules, so any program on this computer that Postgres.app allows can again connect as any role, including `postgres`, without a password. Use it only when the new rules lock you out or misbehave, and redo step 5 as soon as the cause is fixed. The application roles' passwords aren't affected either way.

Put the original file back first (`$B` is the backup from item 3; `ls "$D"/pg_hba.conf.pre-scram-*` lists them):

```bash
cp -p "$B" "$H"
shasum -a 256 "$B" "$H"   # must be equal
```

Then make the server read it, by the first of these that works:

1. **The recovery session** (or any open administrator session): `SELECT pg_reload_conf();`
2. **No database session left:** `"$PG_CTL" reload -D "$D"`. This sends the reload signal as your macOS user and needs no database login.
3. **The server won't start** (a broken file stops a restart): with the file restored, start the server in Postgres.app.

Check that it took effect: a new administrator connection shows an empty `system_user` again (`trust`), and `pg_hba_file_rules` lists the original rules. Then fix whatever went wrong, and repeat step 5 from item 1 with a new backup name.

## 6. Create `.env.local`

Copy [`.env.example`](../../.env.example) to `.env.local` in the project root (it's gitignored), fill it in, and make it readable only by you:

```text
DATABASE_URL=postgresql://ai_spec_studio_app:<app password>@127.0.0.1:5432/ai_spec_studio_dev
DATABASE_MIGRATION_URL=postgresql://ai_spec_studio_migrator:<migrator password>@127.0.0.1:5432/ai_spec_studio_dev
DATABASE_SSL_MODE=disable
TEST_DATABASE_URL=postgresql://ai_spec_studio_test:<test password>@127.0.0.1:5432/ai_spec_studio_test
```

```bash
chmod 600 .env.local
```

- `DATABASE_SSL_MODE=disable` is accepted only because the host is a loopback address; the validation in `src/lib/db/env.ts` refuses it for any other host.
- **Copies of your secrets:** new Claude Code worktrees don't get `.env.local`; `.worktreeinclude` deliberately lists no `.env*` files, so don't add any. Create `.env.local` only in the checkout or worktrees you've approved for database work, each one by hand with mode 600 from the start (`install -m 600 /dev/null .env.local`, then edit it). Keep track of every copy: each one needs updating when you change or rotate a password, and removing a worktree deletes its copy.

## 7. Check the setup

`psql` prompts for each password (`-W`). The last command tries a change that must fail; the others only connect or read.

Expected access between the project databases:

| Role                      | `ai_spec_studio_dev`                                              | `ai_spec_studio_test`                           |
| ------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| `ai_spec_studio_migrator` | connect; create schemas and objects in `public` (owns the tables) | refused                                         |
| `ai_spec_studio_app`      | connect; read and write rows in the migrator's tables; no DDL     | refused                                         |
| `ai_spec_studio_test`     | refused                                                           | connect; create schemas and objects in `public` |
| PUBLIC (every other role) | nothing                                                           | nothing                                         |

No project role can create temporary tables in either project database, belongs to another role, or has role-level settings.

```bash
# Each role reaches its own database: system_user must show scram-sha-256:<role>.
psql -X -W -h 127.0.0.1 -p 5432 -U ai_spec_studio_app -d ai_spec_studio_dev -c 'SELECT current_user, system_user, current_database();'
psql -X -W -h 127.0.0.1 -p 5432 -U ai_spec_studio_test -d ai_spec_studio_test -c 'SELECT current_user, system_user, current_database();'

# The database labels, read from the catalog rather than from session settings.
psql -X -h /tmp -p 5432 -d postgres -c "SELECT d.datname, s.setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = 0 AND d.datname LIKE 'ai\_spec\_studio\_%';"

# With the correct password, each must fail with "permission denied for database"
# and "User does not have CONNECT privilege".
psql -X -W -h 127.0.0.1 -p 5432 -U ai_spec_studio_app -d ai_spec_studio_test -c 'SELECT 1;'
psql -X -W -h 127.0.0.1 -p 5432 -U ai_spec_studio_migrator -d ai_spec_studio_test -c 'SELECT 1;'
psql -X -W -h 127.0.0.1 -p 5432 -U ai_spec_studio_test -d ai_spec_studio_dev -c 'SELECT 1;'

# Must fail with "permission denied for schema public" (and is rolled back).
psql -X -W -h 127.0.0.1 -p 5432 -U ai_spec_studio_app -d ai_spec_studio_dev -c 'BEGIN; CREATE TABLE privilege_probe (id int); ROLLBACK;'
```

**Reading the failures.** PostgreSQL checks the password before the database privilege, so the two errors mean different things:

| Message                                                                               | Meaning                                                                                                                 |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `FATAL: password authentication failed for user "…"`                                  | **Authentication** failed: wrong password (or none stored). Try again; it says nothing about isolation                  |
| `FATAL: permission denied for database "…"` / `User does not have CONNECT privilege.` | **Authorization**: the password was accepted, and the role may not use that database. This is the expected result above |
| `fe_sendauth: no password supplied`                                                   | No password was given (with `-w`); the server requires one                                                              |

The server log records both kinds of `FATAL` line, with the `pg_hba.conf` line a failed password matched, so you can confirm a test reached the server.

## 8. Apply the approved migrations

Only for `ai_spec_studio_dev`, as the migrator, from `.env.local`. Every command except `db:migrate` is read-only, and every check prints fixed `PASS`/`FAIL` lines without URLs or passwords. Run the steps in order in one terminal, and stop at the first failure.

The approved migrations, in order, are listed in [`lib/approved-migrations.ts`](./lib/approved-migrations.ts) with their journal timestamps, the SHA-256 of each SQL file and snapshot, and the structure the database must have after each one:

| Migration             | Reviewed in     | Adds                                                           |
| --------------------- | --------------- | -------------------------------------------------------------- |
| `0000_initial_schema` | Step 4B         | `projects`, `specifications`                                   |
| `0001_auth_tables`    | Task 1.2.3 (3C) | `users`, `sessions`, `accounts`, `verifications` (Better Auth) |

Every tool (these checks, the test-database preflight and migration, the integration run) first checks the files offline and refuses to connect unless `drizzle/` holds exactly these migrations, their snapshots, and the journal: the same tags, timestamps (strictly increasing), and hashes, in this order, with the snapshots forming one `prevId` chain. A missing, extra, reordered, renamed, or modified file stops it. A database must be either fresh or have exactly the first approved migrations applied (journal, structure, owners, and grants); anything else is refused. Adding a migration means reviewing it and adding it to that list.

1. **Check the reviewed files:**

   ```bash
   shasum -a 256 drizzle/*.sql drizzle/meta/*.json \
     scripts/db/migration-check.ts scripts/db/lib/migration-checks.ts scripts/db/lib/approved-migrations.ts \
     scripts/db/lib/migration-files.ts scripts/db/lib/live-verification.ts
   npm run db:check    # offline: never loads .env.local; expect "Everything's fine"
   ```

2. **Preflight** (exit 0). It confirms the server (PostgreSQL 18, loopback, port 5432, no TLS), the role (`ai_spec_studio_migrator`, SCRAM, not a superuser), the database and its `development` label, `search_path` (`"$user", public`) and `current_schema()` (`public`), that no schema is named after the migrator, the CREATE privileges the migration needs, that no other migrator session is open, and how PostgreSQL evaluates both CHECK patterns. Then the state:
   - **fresh** (no `drizzle` schema, no journal, `public` empty): `ALL 32 CHECKS PASSED`, ending with `state: ready to apply 0000_initial_schema, 0001_auth_tables`.
   - **exactly `0000_initial_schema` applied** (the development database after Step 4B): its journal row, both tables, every column, constraint, index, owner, and grant are checked as in the `post` check of 0000, then `state: ready to apply 0001_auth_tables (0000_initial_schema applied exactly)`: `ALL 42 CHECKS PASSED`.
   - **every approved migration already applied**: fails with `state: nothing to migrate`; use the `post` check instead.
   - anything else (an empty journal, extra or reordered journal rows, a changed hash or timestamp, tables without a journal): fails as `state: neither fresh nor exactly the first approved migrations, in order`, with codes.

   ```bash
   ./node_modules/.bin/tsx scripts/db/migration-check.ts pre; echo "exit $?"
   ```

3. **No concurrent migration.** The Drizzle migrator takes no lock, so make sure nothing else runs `db:migrate` or is connected as the migrator (the preflight checks for other migrator sessions). Run step 4 right after step 2.

4. **Apply the pending migrations, once:**

   ```bash
   npm run db:migrate; echo "exit $?"
   ```

   Expect `Migration database: ai_spec_studio_migrator@127.0.0.1:5432/ai_spec_studio_dev (DATABASE_MIGRATION_URL)` and a success message. Drizzle creates the `drizzle` schema and `drizzle.__drizzle_migrations` if they don't exist (outside a transaction), reads the latest journaled timestamp, then applies every migration with a later timestamp, and records each, in **one** transaction: from `0000_initial_schema` alone, only `0001_auth_tables` runs.

5. **Verify** (expect `ALL 36 CHECKS PASSED`, exit 0): all six tables in `public` owned by the migrator, every column (type, nullability, default), constraint and index as reviewed (PostgreSQL 18 also stores each NOT NULL in `pg_constraint`; the check expects exactly one per NOT NULL column), the auth tables' constraints and indexes compared to their exact definitions (the two `ON DELETE CASCADE` foreign keys, `CHECK ((password IS NULL))`, the three UNIQUE constraints), no triggers or functions, `ai_spec_studio_app` with exactly SELECT, INSERT, UPDATE and DELETE on every table (from the migrator's default privileges), nothing for the test role or PUBLIC, the journal owned by the migrator and closed to the other roles, and exactly one journal row per approved migration, in order, with its hash and timestamp:

   ```bash
   ./node_modules/.bin/tsx scripts/db/migration-check.ts post; echo "exit $?"
   ```

**If anything fails, don't run `db:migrate` again** and don't drop or change anything. Run the `post` check to record the state, and get the next step reviewed. If the constraints check fails, `./node_modules/.bin/tsx scripts/db/migration-check.ts constraints` lists every constraint as PostgreSQL stores it, marked expected, mismatch, unexpected, or missing (read-only, like the other checks):

| Situation                                                    | What it means                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The preflight fails                                          | Nothing was changed. Fix the cause, then repeat from step 1                                                                                                                                                                                                                                           |
| `db:migrate` fails before connecting (a configuration error) | Nothing was changed. Fix the cause, then repeat from step 1                                                                                                                                                                                                                                           |
| `db:migrate` fails or is interrupted after connecting        | The pending migrations' one transaction rolled back. From `0000_initial_schema` applied, the database is as it was (the preflight reports the same state); from fresh, the `drizzle` schema and an empty journal may remain, which the preflight refuses. Either way, get it reviewed before retrying |
| `db:migrate` succeeds but the `post` check fails             | Running it again would do nothing (the journal has the rows). Don't edit the tables by hand: a fix is a new, reviewed migration                                                                                                                                                                       |

These steps are for the local development database only. Migrating any other database (staging or production) needs the remote safeguards first: explicit host and database confirmation, the server's own environment label, and protected credentials. CI's disposable test database is migrated only with `npm run db:migrate:test`, as below and in [CI integration tests](#ci-integration-tests).

### The pre-migration connection check (historical)

`scripts/db/verify-connections.ts` is the read-only connection check from before the first migration (Step 3C). It verifies all three roles, and it also requires the development database to be **unmigrated**: no application tables and no `drizzle` schema. Against the migrated development database it reports those state checks as failures (`no application tables …`, `no migrations applied …`). That's expected and doesn't mean the database is broken.

Don't use it to assess the migrated development database. Use the migration checks instead:

```bash
./node_modules/.bin/tsx scripts/db/migration-check.ts post         # after every approved migration: ALL 36 CHECKS PASSED
./node_modules/.bin/tsx scripts/db/migration-check.ts constraints  # after every approved migration: ALL 83 CHECKS PASSED
```

## 9. The test database

`ai_spec_studio_test` is used only by `ai_spec_studio_test`, through `TEST_DATABASE_URL`, never `DATABASE_MIGRATION_URL` or `DATABASE_URL`. The test role creates the migration's objects there itself (it has `CREATE` on the database and on `public`), so tables in the test database belong to the test role, not the migrator. `drizzle.config.ts` stays limited to the development database.

**Preflight** (read-only; it never takes the lock):

```bash
./node_modules/.bin/tsx scripts/db/test-database-check.ts pre; echo "exit $?"
```

It fails closed before connecting unless `TEST_DATABASE_URL` is exactly `ai_spec_studio_test@<loopback>:5432/ai_spec_studio_test` with no TLS settings, `NODE_ENV` isn't `production`, no `PG*`/TLS override variables are set, and `DATABASE_URL` and `DATABASE_MIGRATION_URL` (when set) name other databases. Connected, it checks the server, the role (SCRAM, no elevated attributes, no role memberships), the `test` label, `search_path`, the privileges, concurrent use, and the regex cases, and reports the database's state:

| State        | Meaning                                                                                                                                                                                                     | Preflight              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `fresh`      | no `drizzle` schema, no journal, `public` empty                                                                                                                                                             | `ALL 36 CHECKS PASSED` |
| `partial`    | exactly the first approved migrations (today: `0000_initial_schema` only): their journal rows, hashes, and timestamps, their structure owned by the test role, no grants to other roles, their tables empty | `ALL 46 CHECKS PASSED` |
| `applied`    | every approved migration, exactly: one journal row each, in order, the six tables' structure owned by the test role, no grants to other roles, and all six tables empty                                     | `ALL 46 CHECKS PASSED` |
| `unexpected` | anything else, including an empty journal, extra or reordered journal rows, or tables without a journal. Nothing repairs it automatically; it needs review                                                  | fails                  |

**Advisory lock.** The test-database migration and the integration test run hold the session-level advisory lock `(0x41495353, 1)` ("AISS", test database) on one dedicated connection for their whole run, so they exclude each other and a second copy of themselves. PostgreSQL releases it when that connection ends, including after a crash.

**Migrating the test database** (once, after a passing preflight):

```bash
npm run db:migrate:test; echo "exit $?"
```

One connection, as `ai_spec_studio_test`, does everything: the preflight checks (`before:`), then the advisory lock, the same checks again while holding it (`locked:`), the pending migrations with drizzle-orm's own migrator bound to that same connection (all of them in one transaction), and the checks once more (`after:`), which must find every approved migration applied exactly. Then it releases the lock and closes the connection, on every path. From `fresh` it applies both migrations (`ALL 89 CHECKS PASSED`, `Test database migration: migrated`); from `partial` only the pending ones (`ALL 109 CHECKS PASSED`, `migrated`); from `applied` it changes nothing (`ALL 79 CHECKS PASSED`, `up-to-date`). Anything else, a held lock, or a failed check stops it with `not-migrated` before or without changing anything. If the migration itself fails, its transaction is rolled back, the runner prints the resulting state under `after failure:`, and stops: don't rerun it; get the state reviewed (from `partial`, the state is unchanged; from `fresh`, an empty journal may remain, which doesn't prove the database is clean).

**Integration tests.** Run them with `npm run test:integration` (Vitest's `integration` project; `npm run test:unit` never includes it, and CI runs it in a job of its own: see [CI integration tests](#ci-integration-tests)). Before any test, the global setup checks the target and the database exactly as the preflight does (every approved migration applied, all six tables empty), takes the advisory lock, checks again while holding it, and keeps that one connection, with the lock, until the run ends. It removes every database variable from the process, so test workers never see `DATABASE_URL` or `DATABASE_MIGRATION_URL`; they receive only the validated test connection. Every test runs through `withRollback` (`src/lib/db/testing`): one checked-out client, one outer transaction that is always rolled back and never committed, nested Drizzle transactions as savepoints, and the client released on every path. There's no `TRUNCATE`, bulk `DELETE`, `DROP`, or reset step. The run requires all six tables to be empty before it starts and checks again at the end (the count of each table is reported), so a row left behind by a passing or a failing test fails the run instead of being cleaned up. Expected database errors are asserted by SQLSTATE with `expectPgError`: `23514` (CHECK), `23505` (UNIQUE), `23502` (NOT NULL), `23503` (`foreign_key_violation`: a specification naming a project that doesn't exist, and changing a referenced project's id, which the foreign key's default `ON UPDATE NO ACTION` refuses), and `23001` (`restrict_violation`, observed on PostgreSQL 18: deleting a project that specifications still reference, refused by `ON DELETE RESTRICT`).

**Auth tables and Better Auth.** `src/lib/db/auth-schema.integration.test.ts` checks the auth tables directly: database-generated UUID primary keys and the column defaults, the three UNIQUE constraints (`23505`: email, which is case-sensitive by design because Better Auth lowercases it; session token; provider and account id), both foreign keys (`23503`) and their `ON DELETE CASCADE`, the password CHECK (`23514`), and NOT NULL (`23502`). `src/lib/auth/auth.integration.test.ts` runs Better Auth itself with the app's options (`createAuthOptions`), its Drizzle adapter bound to a `withRollback` transaction instead of the app's pool: the schema check, users and sessions with database-generated ids (Better Auth sends none) and no IP address, signed-cookie validation, expiry, refresh, sign-out, and the OAuth redirect flow against fake GitHub and Google endpoints (no network: any other `fetch` fails the test): the state's verification row consumed by the callback, encrypted provider tokens, a replayed state refused, and no automatic account linking. The app sets no Better Auth background-task handler, so Better Auth's follow-up writes finish before each call returns, inside the transaction. The same OAuth flow also runs offline in the unit tests, on Better Auth's in-memory adapter (`src/lib/auth/oauth-flow.test.ts`).

**The development-database isolation test** classifies the run before it checks anything, from the runner variables and the server together. Locally, none of `GITHUB_ACTIONS`, `CI`, `RUNNER_ENVIRONMENT`, or `RUNNER_OS` may be set (so don't run `test:integration` with `CI=true`), and the server must not report `cluster_name = '18/main'`. The supported local server is Postgres.app; Ubuntu's own PostgreSQL 18 cluster is named `18/main`, so the test fails there rather than guess which environment it is in. Locally it then requires `ai_spec_studio_dev` to exist and the test role to have no `CONNECT` on it.

## CI integration tests

The `postgres-integration` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the integration tests against a disposable PostgreSQL 18 database on its own GitHub-hosted `ubuntu-26.04` runner. It runs in parallel with the lint, build, unit, and E2E job, which it doesn't change. It uses the runner image's own PostgreSQL 18 cluster (`18/main`), not a container. Nothing in it runs anywhere else: every script below refuses to run outside a GitHub-hosted Ubuntu 26.04 runner, and none of it applies to Postgres.app.

**No secrets.** The job references no repository secret, and its token can only read the repository. Every credential is generated for that run, is useless outside that runner, and is gone when the job ends, so a pull request from a fork has nothing to steal. The workflow runs only on `pull_request` and on pushes to `main`. Never add a trigger that runs pull-request code with more permissions (`pull_request_target`, `workflow_run`).

**The steps, in order.** Each step runs only if every earlier one passed, except the last.

| Step                                   | Command                                                 | What it establishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install dependencies                   | `npm ci`                                                | Runs before any credential exists, so install scripts never see one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Runner and PostgreSQL preflight        | inline, read only                                       | Prints the OS, `ImageOS`, Node, Bash, the cluster list, the server version, service states, and port 5432 listeners. Fails if a `PG*`, `POSTGRES_*`, `DATABASE_*`, or `TEST_DATABASE_URL` variable is set (by name; values are never printed).                                                                                                                                                                                                                                                                                                                         |
| Generate disposable credentials        | `tsx scripts/db/ci-credentials.ts`                      | A random 64-character hex password, the test URL, and its SCRAM-SHA-256 verifier. Prints `::add-mask::` for the password and the verifier first, then writes two 0600 files in a new 0700 directory, `$RUNNER_TEMP/ai-spec-studio-db`.                                                                                                                                                                                                                                                                                                                                 |
| Provision PostgreSQL                   | `bash -p scripts/db/ci-provision-postgres.sh`           | Checks the runner, the environment, the credential files, and that the cluster is exactly the image's stopped `18/main`; installs [`ci/pg_hba.conf`](./ci/pg_hba.conf) and [`ci/postgresql-ci.conf`](./ci/postgresql-ci.conf); starts it; runs [`ci-setup.sql`](./ci-setup.sql); deletes the verifier file.                                                                                                                                                                                                                                                            |
| Expect a second provisioning refused   | `bash -p scripts/db/ci-expect-refusals.sh provision`    | The provisioning script, run again, stops at its credential gate with exactly `CI_PROVISION_CREDENTIAL_CONTENTS`. This proves a used credential set is refused; it doesn't reach the cluster-state gate.                                                                                                                                                                                                                                                                                                                                                               |
| Expect a second `ci-setup.sql` refused | `bash -p scripts/db/ci-expect-refusals.sh sql`          | After checking the cluster and that it is already provisioned, `ci-setup.sql` run again (with a fixed placeholder verifier) stops in its preflight with exactly the four freshness codes, before any `CREATE`. On any other outcome it prints the exit status, the well-formed codes it saw, a fixed label and count for each output line it didn't accept, the first error's psql input line (digits only), and whether `CI_SETUP_PREFLIGHT_FAILED:` appeared; never the output itself. Output over 16,384 bytes or 256 lines fails as `CI_REFUSAL_OUTPUT_TOO_LARGE`. |
| Verify identity and negative probes    | `tsx scripts/db/ci-verify-postgres.ts`                  | The test role reaches the intended server (`checkSessionIdentity`), then nine probes must each be refused in exactly the expected way: a wrong password (`28P01`); the test role to other databases, the app, migrator, and `postgres` roles over TCP (`28000`); TLS (the server has none).                                                                                                                                                                                                                                                                            |
| Check fresh, migrate, check applied    | `test-database-check.ts pre`, `npm run db:migrate:test` | The preflight's one mode, `pre`, reports the state; the step requires exactly one `Test database state:` line, `fresh` before the migration and `applied` after.                                                                                                                                                                                                                                                                                                                                                                                                       |
| Integration tests                      | `npm run test:integration` with a JSON report           | All of `src/**/*.integration.test.ts`, the same tests as locally. One differs by environment: the development-database isolation test requires `ai_spec_studio_dev` to be absent in CI and present but closed to the test role locally, and decides which from the GitHub runner variables and the server's `cluster_name` together.                                                                                                                                                                                                                                   |
| Check the results                      | inline `node -e`                                        | Reads Vitest's JSON report: at least 110 tests (the repository's count since Task 1.2.3 Phase 3D), every one `passed`, none failed, skipped, pending, or todo, and consistent totals. Prints counts only, never failure messages.                                                                                                                                                                                                                                                                                                                                      |
| Clean up                               | inline, `if: always()`                                  | Removes the credential directory and the report, and stops `postgresql@18-main`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Credentials.** The steps that need the URL read it from `$RUNNER_TEMP/ai-spec-studio-db/test-database-url` with `dd iflag=nofollow` into a shell variable and pass it to that one command as `TEST_DATABASE_URL`. It is never in a job or workflow `env:`, `$GITHUB_ENV`, `$GITHUB_OUTPUT`, a command line, or the log, and nothing runs with tracing. The verifier reaches PostgreSQL only on psql's standard input, and its file is deleted as soon as provisioning succeeds; the probes refuse to run if it is still there. The PostgreSQL administrator, `postgres`, has no password at all: it is used only over the Unix socket, through `sudo -u postgres` and peer authentication.

**Cleanup.** The last step runs after failures and cancellations too, wherever GitHub runs `if: always()` steps. It checks that `RUNNER_TEMP` is a plain, canonical path; removes the credential directory and the results file only if each is what the job created (not a symbolic link, owned by the runner user); and stops only `postgresql@18-main`. It runs no database command. It reports each problem and fails the step instead of hiding it. The runner's own cleanup of `RUNNER_TEMP` and the discarded VM are the backstop.

**A failed run** leaves the cluster as it stopped. Nothing drops or repairs anything; rerun the job, which gets a new runner.

**Verified on GitHub.** The whole job first passed on pull request #13 ([run 44883841634](https://github.com/Paulgorithms/ai-spec-studio/actions/runs/44883841634), commit `de2359f`): Ubuntu 26.04, Bash 5.3, PostgreSQL 18.7, every step from the preflight to cleanup, and 65 of 65 integration tests (the count then; the gate is now 110, after the auth integration tests were added in Task 1.2.3 Phase 3D, not yet run in CI). The earlier runs found four problems, each now covered by a test: Debian's Bash reads startup files under `bash -c` when standard input is a socket (the test harnesses give `bash -c` its standard input from `/dev/null`); on the GitHub-hosted Ubuntu 24.04 runner, Bash 5.2 did not execute the `ERR` trap inside the tested command substitution used in an `if` condition (the regression test checks the behavior of the Bash version running the test); `failures || 'CODE'` is array concatenation in PostgreSQL (the preflight uses `array_append(…, '…'::text)`); and CI has no `ai_spec_studio_dev` (the isolation test checks it per environment). A runner-image update can still change any of these; the preflight and provisioning gates fail closed if it does.

## Removing the local setup

This deletes the two project databases and everything in them, and the three roles. It doesn't change anything else on the server, **including `pg_hba.conf`**: the SCRAM rules from step 5 stay in effect, which is what you want if you set up again. Run it as the administrator only when you mean to start over:

```bash
psql -X -h /tmp -p 5432 -d postgres -c 'DROP DATABASE IF EXISTS ai_spec_studio_dev;' -c 'DROP DATABASE IF EXISTS ai_spec_studio_test;'
psql -X -h /tmp -p 5432 -d postgres -c 'DROP ROLE IF EXISTS ai_spec_studio_app, ai_spec_studio_migrator, ai_spec_studio_test;'
```

Restoring the original `pg_hba.conf` afterwards is a separate choice. It isn't needed to remove the project, and it brings back passwordless `trust` access for every role on the server (see [Emergency rollback](#emergency-rollback)). Keep the SCRAM rules unless something else on this server needs the originals.

## Verified reference setup

The machine this guide was tested on, after every step above. Use it to compare, not as values to copy.

- **Server:** Postgres.app 2.9.6 with PostgreSQL 18.6, on an Intel Mac. `version()` reports an `aarch64-apple-darwin23.6.0` build (see step 1, item 5).
- **Files:** data directory `~/Library/Application Support/Postgres/var-18`, with `pg_hba.conf`, `pg_ident.conf` (no mappings), and `postgresql.log` in it, all mode 600. No `include` directives.
- **Server settings:** `listen_addresses = localhost`, port 5432, socket directory `/tmp`, `ssl = off`, `password_encryption = scram-sha-256`, `log_statement = none`.
- **Authentication:** the stock file's six `trust` rules commented out; the four rules from step 5 at the end of the file; a timestamped `pg_hba.conf.pre-scram-…` backup kept beside it.
- **Checks that passed:**
  - the administrator over the socket reported `system_user = peer:<admin>`;
  - every project role and `postgres` without a password was refused over the socket, `127.0.0.1`, and `::1`, and `<admin>` over TCP;
  - physical replication was refused on all three, and logical replication was allowed only for `<admin>` through `peer`;
  - each project role logged in with its password over all three (`scram-sha-256:<role>`);
  - the three cross-database logins in step 7 failed with `permission denied for database` after a correct password.
