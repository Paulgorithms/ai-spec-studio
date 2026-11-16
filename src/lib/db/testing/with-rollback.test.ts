import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { describe, expect, test } from "vitest";
import { projects } from "../schema";
import {
  createWithRollback,
  expectPgError,
  findPgError,
  RollbackCleanupError,
} from "./with-rollback";

// A fake checked-out client driven by drizzle-orm's real transaction code.
// It records every statement and behaves like PostgreSQL where it matters:
// txid_current() is stable inside a transaction, a failed statement aborts
// the transaction (25P02) until ROLLBACK or ROLLBACK TO SAVEPOINT, and COMMIT
// ends it.
type FakeOptions = {
  failOn?: (text: string) => Error | undefined;
  rollbackError?: Error;
  beginError?: Error;
  releaseError?: Error;
};

class FakeSessionClient {
  readonly texts: string[] = [];
  readonly releases: unknown[] = [];
  private xid = 100;
  private aborted = false;
  constructor(private readonly options: FakeOptions = {}) {}

  async query(config: string | { text: string }) {
    const text = (typeof config === "string" ? config : config.text).trim();
    this.texts.push(text);
    if (text === "begin" && this.options.beginError)
      throw this.options.beginError;
    if (text === "rollback") {
      if (this.options.rollbackError) throw this.options.rollbackError;
      this.aborted = false;
      this.xid += 1;
      return { rows: [] };
    }
    if (text.startsWith("rollback to savepoint")) {
      this.aborted = false;
      return { rows: [] };
    }
    if (this.aborted) {
      throw Object.assign(new Error("current transaction is aborted"), {
        code: "25P02",
      });
    }
    if (text === "commit") {
      this.xid += 1;
      return { rows: [] };
    }
    const failure = this.options.failOn?.(text);
    if (failure) {
      this.aborted = true;
      throw failure;
    }
    if (text.startsWith("select txid_current()"))
      return { rows: [{ xid: String(this.xid) }] };
    return { rows: [], rowCount: 1 };
  }

  release(destroy?: unknown) {
    this.releases.push(destroy);
    if (this.options.releaseError) throw this.options.releaseError;
  }
}

function setup(options: FakeOptions = {}) {
  const client = new FakeSessionClient(options);
  let acquired = 0;
  const withRollback = createWithRollback(async () => {
    acquired += 1;
    return client as unknown as PoolClient;
  });
  return { client, withRollback, acquiredCount: () => acquired };
}

const checkViolation = () =>
  Object.assign(
    new Error('new row violates check constraint "projects_slug_format_check"'),
    {
      code: "23514",
      constraint: "projects_slug_format_check",
      table: "projects",
    },
  );

const insertProject =
  (slug: string) =>
  (tx: Parameters<Parameters<ReturnType<typeof createWithRollback>>[0]>[0]) =>
    tx.insert(projects).values({ slug, name: "Fake" });

describe("withRollback", () => {
  test("a passing test runs in one transaction that is rolled back, never committed", async () => {
    const { client, withRollback, acquiredCount } = setup();
    const value = await withRollback(async (tx) => {
      await insertProject("billing-service")(tx);
      return "result";
    });
    expect(value).toBe("result");
    expect(acquiredCount()).toBe(1);
    expect(client.texts[0]).toBe("begin");
    expect(client.texts[1]).toMatch(/^select txid_current\(\)/);
    expect(client.texts[2]).toMatch(/^insert into "projects"/);
    expect(client.texts[3]).toMatch(/^select txid_current\(\)/);
    expect(client.texts.at(-1)).toBe("rollback");
    expect(client.texts).not.toContain("commit");
    expect(client.releases).toEqual([undefined]);
  });

  test("a failing test is rolled back and its own error is rethrown", async () => {
    const { client, withRollback } = setup();
    const failure = new Error("assertion failed");
    await expect(
      withRollback(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.texts.at(-1)).toBe("rollback");
    expect(client.texts).not.toContain("commit");
    expect(client.releases).toEqual([undefined]);
  });

  test("nested Drizzle transactions are savepoints inside the outer rollback", async () => {
    const { client, withRollback } = setup();
    await withRollback(async (tx) => {
      await tx.transaction(async (inner) => {
        await insertProject("a")(inner);
        await inner.transaction(async (deeper) => {
          await insertProject("b")(deeper);
        });
      });
    });
    expect(client.texts.filter((t) => t.startsWith("savepoint"))).toEqual([
      "savepoint sp1",
      "savepoint sp2",
    ]);
    expect(
      client.texts.filter((t) => t.startsWith("release savepoint")),
    ).toEqual(["release savepoint sp2", "release savepoint sp1"]);
    expect(client.texts.filter((t) => t === "begin")).toHaveLength(1);
    expect(client.texts).not.toContain("commit");
    expect(client.texts.at(-1)).toBe("rollback");
  });

  test("a failing nested transaction rolls back only to its savepoint", async () => {
    const { client, withRollback } = setup();
    await withRollback(async (tx) => {
      await tx
        .transaction(async () => {
          throw new Error("inner failure");
        })
        .catch(() => undefined);
      await insertProject("after")(tx);
    });
    expect(client.texts).toContain("rollback to savepoint sp1");
    expect(client.texts.at(-1)).toBe("rollback");
    expect(client.texts).not.toContain("commit");
  });

  test("a raw COMMIT inside a test is detected and fails the test", async () => {
    const { client, withRollback } = setup();
    await expect(
      withRollback(async (tx) => {
        await tx.execute(sql`commit`);
      }),
    ).rejects.toThrow(/ended the rollback-only transaction/);
    expect(client.texts.at(-1)).toBe("rollback");
  });

  test("a swallowed database error that leaves the transaction aborted fails the test", async () => {
    const { withRollback } = setup({
      failOn: (t) => (t.startsWith("insert") ? checkViolation() : undefined),
    });
    await expect(
      withRollback(async (tx) => {
        await insertProject("Bad")
          .call(null, tx)
          .catch(() => undefined);
      }),
    ).rejects.toThrow(/left its transaction aborted/);
  });

  test("when the test fails and ROLLBACK fails too, both are reported and the original comes first", async () => {
    const rollbackError = Object.assign(new Error("connection lost"), {
      code: "08006",
    });
    const { client, withRollback } = setup({ rollbackError });
    const failure = new Error("assertion failed");
    const error = await withRollback(async () => {
      throw failure;
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RollbackCleanupError);
    expect((error as RollbackCleanupError).errors[0]).toBe(failure);
    // Drizzle wraps the failed ROLLBACK; its cause is the connection error.
    expect((error as RollbackCleanupError).errors[1]).toMatchObject({
      cause: rollbackError,
    });
    expect((error as RollbackCleanupError).errors).toHaveLength(2);
    expect(client.releases).toEqual([true]);
  });

  test("a failed ROLLBACK after a passing test fails it and destroys the connection", async () => {
    const rollbackError = Object.assign(new Error("connection lost"), {
      code: "08006",
    });
    const { client, withRollback } = setup({ rollbackError });
    await expect(withRollback(async () => "ok")).rejects.toMatchObject({
      cause: rollbackError,
    });
    expect(client.releases).toEqual([true]);
  });

  test("a failed release is reported", async () => {
    const releaseError = new Error(
      "Release called on client which has already been released",
    );
    const { withRollback } = setup({ releaseError });
    await expect(withRollback(async () => "ok")).rejects.toBe(releaseError);
    const failure = new Error("assertion failed");
    const error = await setup({ releaseError })
      .withRollback(async () => {
        throw failure;
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RollbackCleanupError);
    expect((error as RollbackCleanupError).errors).toEqual([
      failure,
      releaseError,
    ]);
  });

  test("a failed BEGIN never runs the test and destroys the connection", async () => {
    const beginError = Object.assign(new Error("terminating connection"), {
      code: "57P01",
    });
    const { client, withRollback } = setup({ beginError });
    let ran = false;
    await expect(
      withRollback(async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ cause: beginError });
    expect(ran).toBe(false);
    expect(client.releases).toEqual([true]);
  });

  test("releases the client exactly once on every path", async () => {
    for (const fn of [
      async () => 1,
      async () => Promise.reject(new Error("x")),
    ]) {
      const { client, withRollback } = setup();
      await withRollback(fn).catch(() => undefined);
      expect(client.releases).toHaveLength(1);
    }
  });
});

describe("expectPgError", () => {
  test("recovers through a savepoint and returns the error's details", async () => {
    const { client, withRollback } = setup({
      failOn: (t) =>
        t.startsWith("insert") &&
        client.texts.filter((x) => x.startsWith("insert")).length === 1
          ? checkViolation()
          : undefined,
    });
    const details = await withRollback(async (tx) => {
      const pg = await expectPgError(
        tx,
        { code: "23514", constraint: "projects_slug_format_check" },
        insertProject("Bad"),
      );
      // The outer transaction is still usable afterwards.
      await insertProject("good")(tx);
      return pg;
    });
    expect(details).toEqual({
      code: "23514",
      constraint: "projects_slug_format_check",
      table: "projects",
    });
    expect(client.texts).toContain("savepoint sp1");
    expect(client.texts).toContain("rollback to savepoint sp1");
    expect(client.texts.filter((t) => t.startsWith("insert"))).toHaveLength(2);
    expect(client.texts.at(-1)).toBe("rollback");
  });

  test("fails when the statement succeeds", async () => {
    const { withRollback } = setup();
    await expect(
      withRollback((tx) =>
        expectPgError(tx, { code: "23514" }, insertProject("fine")),
      ),
    ).rejects.toThrow(
      "Expected PostgreSQL error 23514, but the statement succeeded.",
    );
  });

  test("fails on a different SQLSTATE", async () => {
    const { withRollback } = setup({
      failOn: (t) =>
        t.startsWith("insert")
          ? Object.assign(new Error("dup"), {
              code: "23505",
              constraint: "projects_slug_unique",
            })
          : undefined,
    });
    await expect(
      withRollback((tx) =>
        expectPgError(tx, { code: "23514" }, insertProject("x")),
      ),
    ).rejects.toThrow("Expected PostgreSQL error 23514, got 23505.");
  });

  test("fails on a different constraint", async () => {
    const { withRollback } = setup({
      failOn: (t) => (t.startsWith("insert") ? checkViolation() : undefined),
    });
    await expect(
      withRollback((tx) =>
        expectPgError(
          tx,
          { code: "23514", constraint: "specifications_status_check" },
          insertProject("x"),
        ),
      ),
    ).rejects.toThrow(
      "Expected constraint specifications_status_check, got projects_slug_format_check.",
    );
  });

  test("fails when the error isn't a database error", async () => {
    const { withRollback } = setup();
    await expect(
      withRollback((tx) =>
        expectPgError(tx, { code: "23503" }, async () => {
          throw new TypeError("not sql");
        }),
      ),
    ).rejects.toThrow("but the failure wasn't a database error");
  });
});

describe("findPgError", () => {
  test("unwraps Drizzle's DrizzleQueryError cause", () => {
    const pg = Object.assign(new Error("fk"), {
      code: "23503",
      constraint: "specifications_project_id_fkey",
      table: "specifications",
    });
    expect(
      findPgError(Object.assign(new Error("Failed query: ..."), { cause: pg })),
    ).toEqual({
      code: "23503",
      constraint: "specifications_project_id_fkey",
      table: "specifications",
    });
  });

  test.each([[new Error("x")], [null], ["23503"], [{ code: "not-a-code" }]])(
    "returns undefined for %#",
    (value) => {
      expect(findPgError(value)).toBeUndefined();
    },
  );
});
