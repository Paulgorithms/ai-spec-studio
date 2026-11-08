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

- **Env files come along.** `.worktreeinclude` copies your gitignored `.env*` files (such as `.env.local`) from your project folder into each new worktree. It copies only files that exist there, and only when the worktree is created, so after changing `.env.local`, update the worktree's copy too.
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
