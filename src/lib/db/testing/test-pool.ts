// The integration workers' pool, built from the test-database connection the
// globalSetup provides (never from the environment). Only withRollback uses
// it: tests get a transaction, never the pool or a top-level database.
import { Pool, type PoolClient } from "pg";
import { inject } from "vitest";
import { buildPoolConfig } from "../pool-config";
import type { TestDatabaseConnection } from "./integration-run";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabase: TestDatabaseConnection;
  }
}

// Connections per worker: enough for a test to hold one transaction and
// observe it from a second session.
export const TEST_POOL_MAX = 2;

let pool: Pool | undefined;

function testPool(): Pool {
  if (!pool) {
    const config = buildPoolConfig(inject("testDatabase"), TEST_POOL_MAX);
    if (!config.ok) {
      throw new Error("The provided test-database connection is invalid.");
    }
    pool = new Pool(config.value);
    pool.on("error", () => {
      // A broken idle connection is replaced; the test using it fails.
    });
  }
  return pool;
}

export function acquireTestClient(): Promise<PoolClient> {
  return testPool().connect();
}

// Connections a test has checked out and not released (0 between tests).
export function checkedOutTestClients(): number {
  return pool ? pool.totalCount - pool.idleCount : 0;
}

export async function closeTestPool(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
