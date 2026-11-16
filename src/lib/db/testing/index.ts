// What integration tests may use: rollback-only transactions and expected
// PostgreSQL errors. There is deliberately no export of the pool, a client,
// or a top-level database instance.
import { acquireTestClient } from "./test-pool";
import { createWithRollback } from "./with-rollback";

export const withRollback = createWithRollback(acquireTestClient);
export {
  expectPgError,
  findPgError,
  RollbackCleanupError,
  type PgErrorDetails,
  type TestTransaction,
} from "./with-rollback";
