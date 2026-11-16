// Integration project setupFiles: runs in each worker, before its tests.
import { afterAll, afterEach } from "vitest";
import { assertWorkerEnvironment } from "./integration-run";
import { checkedOutTestClients, closeTestPool } from "./test-pool";

// Workers get the test connection only through inject("testDatabase"); no
// database URL may be visible in their environment.
assertWorkerEnvironment(process.env);

afterEach(() => {
  const leaked = checkedOutTestClients();
  if (leaked !== 0) {
    throw new Error(
      `A test left ${leaked} database connection(s) checked out. Use withRollback for every database access.`,
    );
  }
});

afterAll(async () => {
  await closeTestPool();
});
