<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Formatting

- Prettier formats the code. Run `npm run format` before committing; CI runs `npm run format:check`.

## Testing

- Unit and component tests use Vitest and sit next to the code as `src/**/*.test.ts(x)` (`.ts` runs in Node, `.tsx` in jsdom). Run them with `npm run test:unit`, or a single file with `npm run test:unit -- <path>`. Don't use `test:unit:watch` in scripts or agents; it never exits.
- E2E tests use Playwright (Chromium only) and live in `tests/e2e/*.spec.ts`. Run them with `npm run test:e2e`, or a single file with `npm run test:e2e -- tests/e2e/<file>.spec.ts`. Playwright starts the dev server itself locally (or reuses one already on http://localhost:3000, or on `PORT` when set), and the production server (`npm run start`) in CI. In a second checkout or worktree, use another port: `PORT=3001 npm run test:e2e`.
- Use relative URLs, role/label/placeholder locators (text locators only when the match is verified visible and unique), and web-first `expect` assertions. No fixed sleeps, and no dependencies between tests.
- Ask before installing test dependencies or extra browsers. Full project conventions are in `CLAUDE.md`.
