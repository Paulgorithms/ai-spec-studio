# Next.js Starter

A foundation for new Next.js App Router projects, with the tooling and conventions already set up.

## What's included

- **Next.js 16.4** (App Router, Turbopack) with **React 19.3** and strict **TypeScript**
- **Cache Components**, **partial prefetching**, and the **React Compiler** turned on in `next.config.ts`
- **Tailwind CSS v4** through the Turbopack loader, with light and dark design tokens in `src/app/globals.css`
- **ESLint 9** flat config (`eslint-config-next` core-web-vitals + typescript)
- **Prettier** with Tailwind class sorting, checked in CI. Install your editor's Prettier extension and turn on format on save
- **Route conventions** ready to use: root `not-found.tsx`, `error.tsx` (recovers with `retry()`), and `global-error.tsx`
- **Examples** at `/examples` showing `loading.tsx` with request-time params, `notFound()`, and an error boundary. Delete them when you start
- **Vitest** unit and component tests with Testing Library, next to the code as `src/**/*.test.ts(x)`
- **Playwright** E2E tests (Chromium) in `tests/e2e/`
- **GitHub Actions CI**: format check, lint, unit tests, build, and E2E on pull requests and pushes to `main`
- **Dependabot**: weekly grouped update PRs for npm packages and the SHA-pinned actions
- **`CLAUDE.md` / `AGENTS.md`**: project conventions for contributors and AI coding agents

## Prerequisites

- [Git](https://git-scm.com/) and a GitHub account
- The Node.js version in `.nvmrc`, ideally through [nvm](https://github.com/nvm-sh/nvm)
- Optional: [Claude Code](https://code.claude.com/docs), if you want an AI coding agent (see [Using Claude Code](#using-claude-code-optional))

## Start a new project from this template

Do these once, in order, when you create a project. Using an AI coding agent? Do step 1 yourself, then give it the prompt in [Setting up with an AI coding agent](#setting-up-with-an-ai-coding-agent-optional).

### 1. Create your repository

Click **Use this template → Create a new repository** on GitHub. Then clone the new repository (not this template): copy its URL from the green **Code** button and run:

```bash
git clone <your-repo-url>   # https://github.com/<you>/<your-repo>.git, or git@github.com:<you>/<your-repo>.git with SSH
cd <your-repo>
```

The folder you cloned into is your project folder. Run the commands in these steps from it.

### 2. Install and run it

You need the Node.js version in `.nvmrc`. With [nvm](https://github.com/nvm-sh/nvm), `nvm install` installs that version and switches to it. Without nvm, install that Node.js version another way.

```bash
nvm install
npm install
npx playwright install chromium   # browser for the E2E tests
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and check that the starter page loads, then stop the server with Ctrl+C.

`npm install` may print audit and deprecation warnings and list install scripts that haven't been approved. When this README was written, every check passed with those warnings present and the scripts unapproved, and the audit warnings all came through the ESLint dev tooling. Don't run `npm audit fix --force`: it makes breaking changes, and at the time it proposed downgrading ESLint to a far older version.

### 3. Make it yours

1. Rename the project:
   - `name` in `package.json`, then run `npm install` so `package-lock.json` picks up the new name
   - `name` and `description` in `src/lib/site.ts` (used by metadata and the home page), and the comments above them, which mention the starter and this template. A placeholder description is fine until you have final wording
   - the title and introduction at the top of this `README.md`
   - the copyright holder in `LICENSE`, or replace the license
   - optional: replace `src/app/favicon.ico` with your own icon. This can wait until you have one
2. Delete the examples: `src/app/examples/`, `src/lib/examples.ts`, `src/lib/examples.test.ts`, and `tests/e2e/examples.spec.ts`. Then remove the **Examples** line under "What's included" in this `README.md`, and clear the generated files:

   ```bash
   rm -rf .next
   ```

   Step 2's dev server generated types for the example routes. If you skip this, the build in step 4 fails with `Cannot find module '../../../src/app/examples/...'`.

3. Replace the starter content in `src/app/page.tsx`, including its "View examples" link and the `ButtonLink` import if you no longer use it. Keep `src/components/button.tsx`. If you don't have content yet, keep just the `h1` and description. Then update the E2E tests that check for the starter's content:
   - `tests/e2e/homepage.spec.ts`: your page's title and headings. Remove the "Where to start" and "View examples" assertions if those are gone, and update the comment and test name that mention the starter
   - `tests/e2e/not-found.spec.ts`: the heading it expects after following the **Go home** link
4. In `CLAUDE.md`, under "Folder organization", delete the first two sentences of the paragraph that describes the examples as disposable demos. Keep the last sentence, which says the root `not-found.tsx`, `error.tsx`, `global-error.tsx`, and the shared components are meant to stay.
5. Delete `.git-blame-ignore-revs`. It lists a commit from this template's history, which a repository created from the template doesn't have. Recreate it the first time you make a large reformatting commit.
6. Optional: once you know the site's URL, set `metadataBase` in `src/app/layout.tsx` to it (for example `new URL("https://example.com")`). Next.js uses it to build full URLs in metadata, such as social preview images.
7. Optional: if the project needs env vars, add their names to `.env.example`, then create `.env.local` for the values with `cp .env.example .env.local`. It's gitignored, so it stays on your machine. Skip this if you have none yet.
8. Check for leftovers:

   ```bash
   grep -rniE "starter|view examples|this template" src tests package.json
   ```

   The only matches should be the two "View examples" lines in `src/components/button.test.tsx`. They're sample data for testing the link component, so they can stay.

### 4. Check and push

Run the same checks as CI, except that `npm run format` fixes formatting instead of only reporting it, and E2E runs against the dev server here and the production build in CI. All must pass:

```bash
npm run format && npm run lint && npm run test:unit && npm run build && npm run test:e2e
```

Then commit and push straight to `main` (the ruleset in the next step doesn't exist yet):

```bash
git add -A
git commit -m "chore: set up project from template"
git push
```

The push runs CI on GitHub (the **Actions** tab). A green run confirms the setup.

### 5. Set up the GitHub repository

These settings aren't copied from the template:

- **Settings → Advanced Security**: turn on Dependabot alerts and Dependabot security updates.
- **Settings → Rules → Rulesets → New branch ruleset**: target the default branch, turn on **Require a pull request before merging** and **Require status checks to pass**, and add the **Lint, build, and E2E** check (GitHub lists it once CI has run, which step 4 did). From then on, changes reach `main` through pull requests, as `CLAUDE.md` describes.

Dependabot's configuration does come from the template, so update branches or PRs may already be waiting, including major version updates. Don't merge any until your setup's CI run is green. Merge them only when their own CI passes, and read the changelog for any major update.

### 6. Finish the README

These setup steps only apply once, so remove them from your project. Do this on a branch, since `main` now requires a pull request:

```bash
git switch -c docs/finish-readme
```

Delete this whole "Start a new project from this template" section, including the AI agent setup below, and the sentence pointing to it. Then commit, push the branch, and open a pull request. It's also a quick test of the ruleset from step 5.

### Setting up with an AI coding agent (optional)

An agent can do steps 2 to 4. Do step 1 yourself, then fill in the details in this prompt and paste it into a session started in your project folder. Steps 5 and 6 stay with you: step 5 needs your GitHub settings, and step 6 needs the CI run from step 4 to go green first.

```text
Set up this repository by following "Start a new project from this template"
in README.md. Read README.md and CLAUDE.md first, then do steps 2, 3, and 4,
in order, and stop.

Project details:
- Package name: <kebab-case-name>
- Display name: <Project Name>
- Description: <one sentence, or "use a neutral placeholder">
- Home page: <what it should show, or "just the name and description">
- Copyright holder: <name, or "replace the license with ...">
- Favicon: <path to the icon file, or "keep the current one">
- Site URL: <URL, or "not known yet">
- Env var names: <names only, or "none">

Rules:
- This prompt approves the README's setup steps, so you don't need to propose a
  separate plan. Ask before doing anything those steps don't list.
- Use only the details above. Don't invent product names, claims, or page
  content. If a detail is missing, use the neutral option and list it in your
  report.
- Run the dev server only long enough to check the page, and stop it before
  moving on.
- Don't add or upgrade dependencies, run `npm audit fix`, or approve install
  scripts. Don't merge or change Dependabot branches.
- If a check fails, find the cause and fix it. Don't skip checks or weaken tests.
  The only test changes you may make are the ones step 3 describes.
- I approve one commit and one push to `main` for step 4, with the README's
  commit message. If a permission rule or tool blocks the push, don't look for a
  way around it: stop and give me the command to run myself.
- Don't change GitHub settings, and don't do steps 5 or 6.

When you finish, report:
- what you did, and the result of each check
- which details are placeholders and which steps you skipped
- whether you checked the page visually, and how. If you couldn't, say so
- whether the push went through and whether CI passed. If you can't see the CI
  result, say so instead of assuming it passed
- what's left for me to do
```

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

To reproduce a CI run locally: `npm run build && CI=true npm run test:e2e`.

## Using Claude Code (optional)

Nothing in the project requires [Claude Code](https://code.claude.com/docs), but it's set up for it. It reads `CLAUDE.md` (and `AGENTS.md`) automatically, so it follows the project's conventions without extra instructions.

The first time, run `claude` in the project folder and accept the trust prompt. For browser checks, you can also connect the Playwright MCP server (set up per developer, not in the repo):

```bash
claude mcp add playwright -- npx -y @playwright/mcp@latest
```

Pushing straight to `main` may be blocked by Claude Code's permission settings, even when you've asked for it. If that happens during setup, run the push yourself by typing `! git push` in the session.

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
  app/          routes only; route-private pieces go in _components/
  components/   shared UI used by more than one route
  lib/          non-UI logic: data access, validation, utilities
public/         static assets
tests/e2e/      Playwright specs
```

See [`CLAUDE.md`](./CLAUDE.md) for the full conventions: caching, styling, error handling, testing, security, and git workflow.

## License

[MIT](./LICENSE)
