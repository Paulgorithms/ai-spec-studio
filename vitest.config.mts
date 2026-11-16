import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Integration tests need the local PostgreSQL test database, so they live in
// their own project and only `npm run test:integration` selects it.
// `npm run test:unit` (and CI) selects only `unit` and `component`.
const INTEGRATION_TESTS = "**/*.integration.test.*";

export default defineConfig({
  plugins: [react()],
  // Resolves the @/* alias from tsconfig.json (built into Vite 8).
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [INTEGRATION_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "component",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          exclude: [INTEGRATION_TESTS],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
          // One worker, one file at a time: every test shares the test
          // database (each inside its own rolled-back transaction).
          fileParallelism: false,
          maxWorkers: 1,
          // Validates the target, checks the database, and holds the
          // test-database advisory lock for the whole run.
          globalSetup: ["./src/lib/db/testing/global-setup.ts"],
          // Per worker: refuses database URLs in the environment, and fails a
          // test that leaves a connection checked out.
          setupFiles: ["./src/lib/db/testing/setup.ts"],
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
