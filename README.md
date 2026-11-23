# AI Specification Studio

A standalone, AI-powered, specification-driven software development platform.

## What's included

- **Next.js 16.4** (App Router, Turbopack) with **React 19.3** and strict **TypeScript**
- **Cache Components**, **partial prefetching**, and the **React Compiler** turned on in `next.config.ts`
- **Tailwind CSS v4** through the Turbopack loader, with semantic design tokens for a dark (default) and a light theme in `src/app/globals.css`
- **App shell**: a responsive layout with a sidebar, a header, and a mobile navigation drawer, plus starter Dashboard, Projects, Specifications, and Settings pages showing labeled sample data
- **Reusable components**: buttons, cards, badges, form fields, and page headers in `src/components/`
- **ESLint 10** flat config (`eslint-config-next` core-web-vitals + typescript)
- **Prettier** with Tailwind class sorting, checked in CI. Install your editor's Prettier extension and turn on format on save
- **Route conventions** ready to use: root `not-found.tsx`, `error.tsx` (recovers with `retry()`), and `global-error.tsx`, plus an error page that keeps the app shell
- **Vitest** unit and component tests with Testing Library, next to the code as `src/**/*.test.ts(x)`
- **Playwright** E2E tests (Chromium) in `tests/e2e/`, including automated WCAG 2.2 AA checks with axe
- **GitHub Actions CI**: format check, lint, unit tests, build, and E2E on pull requests and pushes to `main`
- **Dependabot**: weekly grouped update PRs for npm packages and the SHA-pinned actions
- **`CLAUDE.md` / `AGENTS.md`**: project conventions for contributors and AI coding agents

## Prerequisites

- [Git](https://git-scm.com/) and a GitHub account
- The Node.js version in `.nvmrc`, ideally through [nvm](https://github.com/nvm-sh/nvm)
- Optional: [Claude Code](https://code.claude.com/docs), if you want an AI coding agent (see [Using Claude Code](#using-claude-code-optional))

## Working on the project

On a new machine or a fresh clone of your project, install what you need:

```bash
nvm install
npm install
npx playwright install chromium   # browser for the E2E tests
```

Then `npm run dev` starts the dev server at [http://localhost:3000](http://localhost:3000). To use another port, set `PORT` in the shell (`PORT=3001 npm run dev`). Next.js doesn't read `PORT` from `.env` files.

Before you push, run the checks:

```bash
npm run format && npm run lint && npm run test:unit && npm run build && npm run test:e2e
```

See [`CLAUDE.md`](./CLAUDE.md) for branch names, commit messages, and the rest of the workflow.

## The app

| Page           | URL               | What it shows                                                  |
| -------------- | ----------------- | -------------------------------------------------------------- |
| Dashboard      | `/`               | Totals, the most recent specifications, and recent projects    |
| Projects       | `/projects`       | Each project with its specification count and status breakdown |
| Specifications | `/specifications` | Every specification with its project, status, and last update  |
| Settings       | `/settings`       | The color theme                                                |

- **Layout:** from 1024px wide, a sidebar lists the sections; on narrower screens the header's menu button opens them in a drawer. Every page starts with a "Skip to content" link for keyboard users.
- **Theme:** dark by default, whatever the operating system prefers. Choose light in Settings or with the header's toggle. The choice is saved in the browser, applies before the page appears (no flash), and switches every open tab.
- **Sample data:** projects and specifications are fictional records in `src/lib/mock-data.ts`, marked "Sample data" on each page, until workspaces are backed by a database. Nothing can be created or edited yet.

[`CLAUDE.md`](./CLAUDE.md) covers how it's built: the route structure, design tokens, theme internals (including what a future Content Security Policy needs), components, and accessibility rules.

## Authentication

Sign-in with GitHub and Google uses [Better Auth](https://www.better-auth.com/) 1.7.27, served from `/api/auth/*` (`src/app/api/auth/[...all]/route.ts`), with sessions stored in PostgreSQL (the `users`, `sessions`, `accounts`, and `verifications` tables). The configuration is in `src/lib/auth/server.ts`; the environment variables are listed in [`.env.example`](./.env.example) and validated by `src/lib/auth/env.ts` on the first `/api/auth` request. There is no sign-in page or route protection yet.

### What the code does today

- **Sessions:** a signed, `HttpOnly`, `SameSite=Lax` cookie (`Secure` and `__Secure-` prefixed whenever `BETTER_AUTH_URL` is HTTPS) that refers to a row in `sessions`. Sessions last 7 days from last use and are extended at most once a day. There is no cookie cache, so signing out or deleting a session row ends it on the next request.
- **OAuth:** the state is stored in `verifications` and in a signed cookie, used once, and valid for 10 minutes. Callback and redirect URLs must be on `BETTER_AUTH_URL` or `BETTER_AUTH_TRUSTED_ORIGINS`. Accounts are never linked automatically: a sign-in whose email belongs to a user of the other provider is refused (`account_not_linked`).
- **Provider tokens:** GitHub and Google access and refresh tokens are encrypted with `BETTER_AUTH_SECRET` before they're stored in `accounts`. The app never calls the providers' APIs, so the endpoints that would return them to the browser (`/api/auth/get-access-token`, `/refresh-token`, `/account-info`) are disabled and answer 404.
- **Client IP addresses** are never stored: `sessions.ip_address` is always NULL. Better Auth still reads the client IP for rate limiting.
- **Rate limiting** is Better Auth's default: on only when `NODE_ENV=production`, counted per client IP in the memory of each server process.

### Required before any production deployment

These are not handled by the current code. Each needs its own reviewed change before the app is deployed anywhere reachable from the internet.

1. **A trusted client-IP header.** Better Auth takes the client IP from `X-Forwarded-For` by default. That header is set by whoever sends the request: unless a proxy in front of the app overwrites it, a client can put any address there. Better Auth accepts the header only when it holds exactly one address and `advanced.ipAddress.trustedProxies` isn't set. So a client reaching the app directly can rotate fake addresses and get a fresh rate-limit allowance each time. And when the header is missing or lists several addresses, there is no usable IP, so every such request shares one counter per endpoint, and one client can use up the limit for everyone. Before deploying, configure `advanced.ipAddress.ipAddressHeaders` to the header the hosting platform sets and clients can't forge, or `advanced.ipAddress.trustedProxies` to the proxies' address ranges, and make sure the app isn't reachable without passing through them.
2. **A shared rate-limit store.** Counts kept in process memory are per instance: they reset on every restart and deploy, and N instances (or serverless invocations) allow N times the limit. Running more than one instance in production needs an approved shared strategy first, such as Better Auth's database storage (a new table, so a reviewed migration) or a shared secondary store.
3. **A secret-rotation procedure.** `BETTER_AUTH_SECRET` signs every session cookie and OAuth state, and encrypts the stored provider tokens. Changing it signs every user out (existing cookies no longer verify), invalidates sign-ins in progress, and makes the tokens already in `accounts` impossible to decrypt (they would be replaced only when each user signs in again). The validator refuses `BETTER_AUTH_SECRETS`, Better Auth's multi-key rotation, so there is currently no way to rotate without these effects. Agree on a reviewed procedure (when to rotate, how to announce the forced sign-out, what to do with old tokens) before production, and treat a leaked secret as a forced rotation.

Also before production: HTTPS only (the validator refuses `http://` there), real OAuth apps whose callback URLs are `<BETTER_AUTH_URL>/api/auth/callback/github` and `/google`, and secrets kept in the host's secret store, never in the repository.

## Commands

| Command                   | What it does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `npm run dev`             | Dev server (Turbopack) at http://localhost:3000, or on `PORT` when set             |
| `npm run lint`            | ESLint across the project                                                          |
| `npm run format`          | Format the project with Prettier                                                   |
| `npm run format:check`    | Report unformatted files without changing them (what CI runs)                      |
| `npm run build`           | Production build, which also runs the type check                                   |
| `npm run start`           | Serves the production build                                                        |
| `npm run test:unit`       | Vitest unit and component tests, run once                                          |
| `npm run test:unit:watch` | Vitest in watch mode                                                               |
| `npm run test:e2e`        | Playwright E2E tests; starts the dev server or reuses one on port 3000 (or `PORT`) |

To reproduce a CI run locally: `npm run build && CI=true npm run test:e2e`. The E2E suite includes the accessibility scans; to run only those, use `npm run test:e2e -- tests/e2e/accessibility.spec.ts`.

## Using Claude Code (optional)

Nothing in the project requires [Claude Code](https://code.claude.com/docs), but it's set up for it. It reads `CLAUDE.md` (and `AGENTS.md`) automatically, so it follows the project's conventions without extra instructions.

The first time, run `claude` in the project folder and accept the trust prompt. For browser checks, you can also connect the Playwright MCP server (set up per developer, not in the repo):

```bash
claude mcp add playwright -- npx -y @playwright/mcp@latest
```

### Parallel work with worktrees

Claude Code can run each session in its own [git worktree](https://code.claude.com/docs/en/worktrees), a separate copy of the project on its own branch, so parallel sessions don't edit the same files:

```bash
claude --worktree feature-name
```

The worktree is created under `.claude/worktrees/feature-name/` (gitignored), on a new branch `worktree-feature-name` that starts from `origin/main`. `--worktree` exits with an error until you've accepted the trust prompt above.

- **Env files don't come along.** New worktrees start without `.env.local`, on purpose: it holds database credentials. `.worktreeinclude` lists no `.env*` files; keep it that way. The app runs without `.env.local` until a feature needs the database. For a worktree that does database work, create its `.env.local` yourself, as described in [`scripts/db/README.md`](scripts/db/README.md#6-create-envlocal), and only in worktrees you've approved for that.
- **Branch from your current work instead.** To start worktrees from your local `HEAD` rather than `origin/main`, set `worktree.baseRef` in your own `.claude/settings.local.json`:

  ```json
  { "worktree": { "baseRef": "head" } }
  ```

Lint, tests, and builds in your project folder skip `.claude/worktrees/`; run them inside each worktree.

#### Running the app and tests in a worktree

A worktree is a fresh checkout without `node_modules`, so install dependencies first. Use a port other than 3000, which another checkout probably has: `npm run test:e2e` reuses any server already on its port, so it would test the other checkout's code.

`claude --worktree` keeps its terminal busy, so open another terminal and, from your project folder, go into the worktree:

```bash
cd .claude/worktrees/feature-name
nvm use
npm install
lsof -nP -iTCP:3001 -sTCP:LISTEN   # no output means the port is free
PORT=3001 npm run dev              # optional: view the app at http://localhost:3001
PORT=3001 npm run test:e2e         # in another terminal; starts a server on 3001 if none is running
```

Use the same `PORT` for both commands, and a different one per worktree (3002, 3003, …). Set it on the command line or with `export PORT=3001`; Next.js doesn't read it from `.env` files. From the worktree's Claude session you can also type `! PORT=3001 npm run test:e2e`, but run `npm run dev` in its own terminal, since it never exits.

#### Finishing a worktree

The work lives on the worktree's branch until you merge it. From the worktree (or by asking Claude), commit, push the branch, and open a pull request on GitHub:

```bash
git push -u origin worktree-feature-name
```

When you exit the Claude session, it asks whether to keep or remove a worktree that has changes or commits. Removing deletes the folder and its local branch, so push first. To come back to a kept worktree, run the `claude --worktree feature-name --resume` command it prints on exit.

## Project structure

```
src/
  app/              routes only; route-private pieces go in _components/
    (studio)/       pages inside the app shell (the group name isn't part of the URL)
  components/       shared UI used by more than one route
  lib/              non-UI logic: theme, navigation, sample data, formatting
public/             static assets
tests/e2e/          Playwright specs, including accessibility.spec.ts
```

See [`CLAUDE.md`](./CLAUDE.md) for the full conventions: caching, styling, error handling, testing, security, and git workflow.

## License

[MIT](./LICENSE)
