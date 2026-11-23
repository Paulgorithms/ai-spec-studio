// Integration tests for the approved schema, against the local test database
// (npm run test:integration only). Every database access goes through
// withRollback: one transaction per call, always rolled back. Expected
// errors are asserted by SQLSTATE and constraint name with expectPgError,
// inside savepoints, never by message text.
import { randomInt, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { projects, specifications } from "@/lib/db/schema";
import {
  expectPgError,
  withRollback,
  type TestTransaction,
} from "@/lib/db/testing";
import {
  DEVELOPMENT_DATABASE,
  developmentDatabaseIsolationViolations,
} from "@/lib/db/testing/development-database-isolation";
import type { SpecStatus } from "@/lib/spec-status";
import { APPROVED_MIGRATIONS } from "../../../scripts/db/lib/migration-checks";

const ALL_TABLES = [
  "accounts",
  "projects",
  "sessions",
  "specifications",
  "users",
  "verifications",
];

// Unique test data, so no test depends on another or on execution order.
const uniqueSlug = (label = "p") => `${label}-${randomUUID().slice(0, 8)}`;
const uniqueKey = () => `SPEC-${randomInt(100_000, 1_000_000)}`;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function insertProject(tx: TestTransaction, slug = uniqueSlug()) {
  const [row] = await tx
    .insert(projects)
    .values({ slug, name: `Project ${slug}` })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

async function insertSpecification(
  tx: TestTransaction,
  projectId: string,
  key = uniqueKey(),
) {
  const [row] = await tx
    .insert(specifications)
    .values({ projectId, key, title: `Title ${key}` })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

// Read-only: whether a row with this slug exists, from a fresh transaction.
const slugExists = (slug: string) =>
  withRollback(async (tx) => {
    const rows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, slug));
    return rows.length > 0;
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("projects and specifications", () => {
  test("a project is inserted with generated id and defaults, and read back", async () => {
    await withRollback(async (tx) => {
      const slug = uniqueSlug();
      const inserted = await insertProject(tx, slug);
      expect(inserted.id).toMatch(UUID_V4);
      expect(inserted.description).toBe("");
      expect(inserted.createdAt).toBeInstanceOf(Date);
      expect(inserted.updatedAt).toBeInstanceOf(Date);

      const [read] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, inserted.id));
      expect(read).toEqual(inserted);
    });
  });

  test("created_at and updated_at default to the transaction's now(), at millisecond precision", async () => {
    await withRollback(async (tx) => {
      const { id } = await insertProject(tx);
      const result = await tx.execute<{ matches: boolean; same: boolean }>(sql`
        select created_at = now()::timestamptz(3) as matches,
               created_at = updated_at as same
        from projects where id = ${id}`);
      expect(result.rows[0]).toEqual({ matches: true, same: true });
    });
  });

  test("a specification links to its project, with summary '' and status draft", async () => {
    await withRollback(async (tx) => {
      const project = await insertProject(tx);
      const spec = await insertSpecification(tx, project.id);
      expect(spec.id).toMatch(UUID_V4);
      expect(spec.projectId).toBe(project.id);
      expect(spec.summary).toBe("");
      expect(spec.status).toBe("draft");

      const linked = await tx
        .select({ key: specifications.key, slug: projects.slug })
        .from(specifications)
        .innerJoin(projects, eq(specifications.projectId, projects.id))
        .where(eq(specifications.id, spec.id));
      expect(linked).toEqual([{ key: spec.key, slug: project.slug }]);
    });
  });

  test("a project's specifications are found by project_id", async () => {
    await withRollback(async (tx) => {
      const a = await insertProject(tx);
      const b = await insertProject(tx);
      const specA1 = await insertSpecification(tx, a.id);
      const specA2 = await insertSpecification(tx, a.id);
      await insertSpecification(tx, b.id);
      const forA = await tx
        .select({ id: specifications.id })
        .from(specifications)
        .where(eq(specifications.projectId, a.id));
      expect(forA.map((row) => row.id).sort()).toEqual(
        [specA1.id, specA2.id].sort(),
      );
    });
  });

  test("records update through Drizzle", async () => {
    await withRollback(async (tx) => {
      const project = await insertProject(tx);
      const spec = await insertSpecification(tx, project.id);
      const [updated] = await tx
        .update(specifications)
        .set({ title: "Updated title", status: "in-review" })
        .where(eq(specifications.id, spec.id))
        .returning();
      expect(updated).toMatchObject({
        title: "Updated title",
        status: "in-review",
        key: spec.key,
      });
    });
  });

  test("timestamptz(3) stores milliseconds (microseconds are rounded away)", async () => {
    await withRollback(async (tx) => {
      const slug = uniqueSlug();
      await tx.execute(sql`
        insert into projects (slug, name, created_at, updated_at)
        values (${slug}, 'Precision', '2030-01-02T03:04:05.123456Z', '2030-01-02T03:04:05.123456Z')`);
      const [row] = await tx
        .select({ createdAt: projects.createdAt })
        .from(projects)
        .where(eq(projects.slug, slug));
      expect(row?.createdAt.toISOString()).toBe("2030-01-02T03:04:05.123Z");
    });
  });

  test("$onUpdate sets updated_at from the application clock on Drizzle updates", async () => {
    await withRollback(async (tx) => {
      const project = await insertProject(tx);
      // Only Date is faked: the driver's timers keep working.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2031-05-06T07:08:09.321Z"));
      const [updated] = await tx
        .update(projects)
        .set({ name: "Renamed" })
        .where(eq(projects.id, project.id))
        .returning();
      vi.useRealTimers();
      expect(updated?.updatedAt.toISOString()).toBe("2031-05-06T07:08:09.321Z");
      expect(updated?.createdAt.getTime()).toBe(project.createdAt.getTime());
    });
  });
});

describe("CHECK constraints (23514)", () => {
  test.each(["billing-service", "a", "v2-api", "x1-y2-z3"])(
    "accepts the slug %j",
    async (slug) => {
      await withRollback(async (tx) => {
        await insertProject(tx, `${slug}-${randomUUID().slice(0, 4)}`);
      });
    },
  );

  test.each([
    "Billing-Service",
    "billing_service",
    "-billing",
    "billing-",
    "billing--service",
    "billing service",
    "é",
    "",
  ])("rejects the slug %j", async (slug) => {
    await withRollback(async (tx) => {
      await expectPgError(
        tx,
        { code: "23514", constraint: "projects_slug_format_check" },
        (sp) => sp.insert(projects).values({ slug, name: "Invalid slug" }),
      );
    });
  });

  test.each(["SPEC-001", "SPEC-1234"])("accepts the key %j", async (base) => {
    await withRollback(async (tx) => {
      const project = await insertProject(tx);
      // Keep the accepted shape while staying unique.
      await insertSpecification(tx, project.id, `${base}${randomInt(10, 100)}`);
    });
  });

  test.each([
    "SPEC-01",
    "spec-001",
    "SPEC-00A",
    "SPEC 001",
    "XSPEC-001",
    "SPEC-001 ",
  ])("rejects the key %j", async (key) => {
    await withRollback(async (tx) => {
      const project = await insertProject(tx);
      await expectPgError(
        tx,
        { code: "23514", constraint: "specifications_key_format_check" },
        (sp) =>
          sp
            .insert(specifications)
            .values({ projectId: project.id, key, title: "Invalid key" }),
      );
    });
  });

  test.each(["draft", "in-review", "approved"] as const)(
    "accepts the status %j",
    async (status) => {
      await withRollback(async (tx) => {
        const project = await insertProject(tx);
        const [row] = await tx
          .insert(specifications)
          .values({
            projectId: project.id,
            key: uniqueKey(),
            title: "Status",
            status,
          })
          .returning();
        expect(row?.status).toBe(status);
      });
    },
  );

  test.each(["published", "Draft", "in_review", ""])(
    "rejects the status %j",
    async (status) => {
      await withRollback(async (tx) => {
        const project = await insertProject(tx);
        await expectPgError(
          tx,
          { code: "23514", constraint: "specifications_status_check" },
          (sp) =>
            sp.insert(specifications).values({
              projectId: project.id,
              key: uniqueKey(),
              title: "Invalid status",
              status: status as SpecStatus,
            }),
        );
      });
    },
  );
});

describe("UNIQUE constraints (23505)", () => {
  test("rejects a duplicate project slug", async () => {
    await withRollback(async (tx) => {
      const slug = uniqueSlug();
      await insertProject(tx, slug);
      await expectPgError(
        tx,
        { code: "23505", constraint: "projects_slug_unique" },
        (sp) => sp.insert(projects).values({ slug, name: "Duplicate" }),
      );
    });
  });

  test("rejects a duplicate specification key, even in another project", async () => {
    await withRollback(async (tx) => {
      const a = await insertProject(tx);
      const b = await insertProject(tx);
      const key = uniqueKey();
      await insertSpecification(tx, a.id, key);
      await expectPgError(
        tx,
        { code: "23505", constraint: "specifications_key_unique" },
        (sp) =>
          sp
            .insert(specifications)
            .values({ projectId: b.id, key, title: "Duplicate" }),
      );
    });
  });
});

describe("NOT NULL (23502)", () => {
  // Raw SQL, because Drizzle's types don't allow null here. The column is
  // asserted; PostgreSQL's constraint naming for NOT NULL isn't relied on.
  test.each(["slug", "name", "description"])(
    "rejects a null projects.%s",
    async (column) => {
      await withRollback(async (tx) => {
        const values = {
          slug: uniqueSlug(),
          name: "Not null",
          description: "",
          [column]: null,
        };
        const error = await expectPgError(tx, { code: "23502" }, (sp) =>
          sp.execute(sql`
            insert into projects (slug, name, description)
            values (${values.slug}, ${values.name}, ${values.description})`),
        );
        expect(error.column).toBe(column);
      });
    },
  );

  test.each(["project_id", "key", "title", "summary", "status"])(
    "rejects a null specifications.%s",
    async (column) => {
      await withRollback(async (tx) => {
        const project = await insertProject(tx);
        const values: Record<string, string | null> = {
          project_id: project.id,
          key: uniqueKey(),
          title: "Not null",
          summary: "",
          status: "draft",
          [column]: null,
        };
        const error = await expectPgError(tx, { code: "23502" }, (sp) =>
          sp.execute(sql`
            insert into specifications (project_id, key, title, summary, status)
            values (${values.project_id}::uuid, ${values.key}, ${values.title}, ${values.summary}, ${values.status})`),
        );
        expect(error.column).toBe(column);
      });
    },
  );
});

describe("the foreign key (23503 foreign_key_violation; ON DELETE RESTRICT: 23001 restrict_violation)", () => {
  test("rejects a specification for a project that doesn't exist", async () => {
    await withRollback(async (tx) => {
      await expectPgError(
        tx,
        { code: "23503", constraint: "specifications_project_id_fkey" },
        (sp) =>
          sp.insert(specifications).values({
            projectId: randomUUID(),
            key: uniqueKey(),
            title: "Orphan",
          }),
      );
    });
  });

  test("ON DELETE RESTRICT: a project with specifications can't be deleted", async () => {
    await withRollback(async (tx) => {
      const project = await insertProject(tx);
      const spec = await insertSpecification(tx, project.id);
      await expectPgError(
        tx,
        { code: "23001", constraint: "specifications_project_id_fkey" },
        (sp) => sp.delete(projects).where(eq(projects.id, project.id)),
      );
      // Once its specification is gone, the project can be deleted.
      await tx.delete(specifications).where(eq(specifications.id, spec.id));
      const deleted = await tx
        .delete(projects)
        .where(eq(projects.id, project.id))
        .returning({ id: projects.id });
      expect(deleted).toEqual([{ id: project.id }]);
    });
  });

  test("a referenced project's id can't be changed", async () => {
    await withRollback(async (tx) => {
      const project = await insertProject(tx);
      await insertSpecification(tx, project.id);
      await expectPgError(
        tx,
        { code: "23503", constraint: "specifications_project_id_fkey" },
        (sp) =>
          sp
            .update(projects)
            .set({ id: randomUUID() })
            .where(eq(projects.id, project.id)),
      );
    });
  });
});

describe("transaction isolation", () => {
  test("an insert is visible inside its transaction and gone after it", async () => {
    const slug = uniqueSlug("visible");
    await withRollback(async (tx) => {
      await insertProject(tx, slug);
      const inside = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.slug, slug));
      expect(inside).toHaveLength(1);
      // Another session can't see the uncommitted row.
      expect(await slugExists(slug)).toBe(false);
    });
    expect(await slugExists(slug)).toBe(false);
  });

  test("a failing test's changes are rolled back too", async () => {
    const slug = uniqueSlug("failing");
    const failure = new Error("deliberate failure");
    await expect(
      withRollback(async (tx) => {
        await insertProject(tx, slug);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await slugExists(slug)).toBe(false);
  });

  test("a nested Drizzle transaction can't persist anything", async () => {
    const slug = uniqueSlug("nested");
    await withRollback(async (tx) => {
      await tx.transaction(async (inner) => {
        await insertProject(inner, slug);
      });
      // The nested "commit" was only a released savepoint.
      expect(
        await tx.select().from(projects).where(eq(projects.slug, slug)),
      ).toHaveLength(1);
    });
    expect(await slugExists(slug)).toBe(false);
  });

  test("an expected error is recovered through a savepoint, and later queries succeed", async () => {
    await withRollback(async (tx) => {
      const slug = uniqueSlug();
      const first = await insertProject(tx, slug);
      await expectPgError(
        tx,
        { code: "23505", constraint: "projects_slug_unique" },
        (sp) => sp.insert(projects).values({ slug, name: "Duplicate" }),
      );
      // The outer transaction is still usable, and the first row is intact.
      const second = await insertProject(tx);
      const rows = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.slug, slug));
      expect(rows).toEqual([{ id: first.id }]);
      expect(second.id).not.toBe(first.id);
    });
  });
});

describe("role and database isolation (read-only catalog checks)", () => {
  type Row = Record<string, unknown>;
  const one = (tx: TestTransaction, query: ReturnType<typeof sql>) =>
    tx.execute<Row>(query).then((result) => result.rows[0] ?? {});

  test("connected as ai_spec_studio_test to ai_spec_studio_test, without elevated rights", async () => {
    await withRollback(async (tx) => {
      expect(
        await one(
          tx,
          sql`select current_user::text as role, session_user::text as session_role,
                     current_database()::text as database
              , r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls
              from pg_roles as r where r.rolname = current_user`,
        ),
      ).toEqual({
        role: "ai_spec_studio_test",
        session_role: "ai_spec_studio_test",
        database: "ai_spec_studio_test",
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      });
    });
  });

  test("the test role belongs to no other role", async () => {
    await withRollback(async (tx) => {
      expect(
        await one(
          tx,
          sql`select count(*)::int as memberships from pg_auth_members
              where member = (select oid from pg_roles where rolname = current_user)`,
        ),
      ).toEqual({ memberships: 0 });
    });
  });

  test("the app role, the migrator, and PUBLIC can't use the test database", async () => {
    await withRollback(async (tx) => {
      expect(
        await one(
          tx,
          sql`select
                has_database_privilege('ai_spec_studio_app', current_database(), 'CONNECT') as app_connect,
                has_database_privilege('ai_spec_studio_migrator', current_database(), 'CONNECT') as migrator_connect,
                has_database_privilege('public', current_database(), 'CONNECT') as public_connect,
                has_database_privilege('public', current_database(), 'CREATE') as public_create,
                has_database_privilege('public', current_database(), 'TEMPORARY') as public_temporary`,
        ),
      ).toEqual({
        app_connect: false,
        migrator_connect: false,
        public_connect: false,
        public_create: false,
        public_temporary: false,
      });
    });
  });

  test("the test role can't reach the development database", async () => {
    // Locally it exists and is closed to the test role; in CI it must not
    // exist. Which applies comes from the runner and the server together
    // (developmentDatabaseIsolationViolations), never from whether it exists.
    await withRollback(async (tx) => {
      const facts = await one(
        tx,
        sql`select current_setting('cluster_name') as cluster_name,
          exists (select 1 from pg_database where datname = ${DEVELOPMENT_DATABASE}) as dev_exists`,
      );
      const developmentDatabaseExists = facts.dev_exists === true;
      // has_database_privilege on a database that doesn't exist is an
      // error (3D000), so it's read only when pg_database has the row.
      const testRoleCanConnect = developmentDatabaseExists
        ? (
            await one(
              tx,
              sql`select has_database_privilege(current_user, ${DEVELOPMENT_DATABASE}::text, 'CONNECT') as dev_connect`,
            )
          ).dev_connect
        : null;
      expect(typeof facts.cluster_name).toBe("string");
      expect(typeof facts.dev_exists).toBe("boolean");
      expect(
        developmentDatabaseIsolationViolations(process.env, {
          clusterName: String(facts.cluster_name),
          developmentDatabaseExists,
          testRoleCanConnect:
            typeof testRoleCanConnect === "boolean" ? testRoleCanConnect : null,
        }),
      ).toEqual([]);
    });
  });

  test("no other role or PUBLIC has privileges on the tables", async () => {
    await withRollback(async (tx) => {
      const result = await tx.execute<Row>(sql`
        select t.name,
          has_table_privilege('ai_spec_studio_app', t.qualified, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as app_any,
          has_table_privilege('ai_spec_studio_migrator', t.qualified, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as migrator_any,
          has_table_privilege('public', t.qualified, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as public_any
        from (values ('accounts', 'public.accounts'), ('projects', 'public.projects'),
                     ('sessions', 'public.sessions'), ('specifications', 'public.specifications'),
                     ('users', 'public.users'), ('verifications', 'public.verifications'))
          as t (name, qualified)
        order by 1`);
      expect(result.rows).toEqual(
        ALL_TABLES.map((name) => ({
          name,
          app_any: false,
          migrator_any: false,
          public_any: false,
        })),
      );
    });
  });

  test("the six tables exist, owned by the test role, with exactly the approved migrations journaled in order", async () => {
    await withRollback(async (tx) => {
      const tables = await tx.execute<Row>(sql`
        select c.relname::text as name, pg_get_userbyid(c.relowner)::text as owner
        from pg_class as c join pg_namespace as n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname::text collate "C"`);
      expect(tables.rows).toEqual(
        ALL_TABLES.map((name) => ({ name, owner: "ai_spec_studio_test" })),
      );
      const journal = await tx.execute<Row>(
        sql`select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id`,
      );
      expect(journal.rows).toEqual(
        APPROVED_MIGRATIONS.map((m) => ({
          hash: m.sha256,
          created_at: String(m.when),
        })),
      );
    });
  });
});
