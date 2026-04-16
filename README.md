# lovagentic

`lovagentic` is a browser-first operator CLI for steering [Lovable](https://lovable.dev) through stable, user-owned surfaces.

It focuses on:

- official Lovable URLs
- Playwright automation against the Lovable web UI
- persistent browser profiles with real Lovable sessions
- explicit verification and persistence checks after write actions

It deliberately avoids:

- patching or injecting into `Lovable.app`
- depending on private desktop IPC
- treating undocumented backend endpoints as the primary interface

## Status

This repository is production-minded, but still pragmatic:

- stable enough for real operator workflows
- honest about Lovable UI drift and verification challenges
- biased toward explicit failures instead of false success

If Lovable or Cloudflare triggers an interactive verification, headed runs are still the reliable path.

[![CI](https://github.com/Alfridus1/lovagentic/actions/workflows/ci.yml/badge.svg)](https://github.com/Alfridus1/lovagentic/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/lovagentic.svg?color=blue)](https://www.npmjs.com/package/lovagentic)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/lovagentic.svg?color=brightgreen)](./package.json)

## Roadmap

| Version | Status | What changes |
| --- | --- | --- |
| **v0.1** | ✅ Available now (npm) | Browser automation. Headless Playwright control of every Lovable surface. |
| **v0.2** | 🔵 Next week | Native MCP backend. Drops the browser layer when Lovable's official MCP ships. Same `lovagentic` CLI, ~10× faster, fully supported by Lovable. |
| **v0.3** | 🟣 Soon | CI/CD plugins. First-class GitHub Actions, GitLab CI, and Vercel-build integrations. |
| **v0.4** | ⚪ Future | Hosted control plane. Multi-tenant `lovagentic`-as-a-service for agencies and AI agent fleets running 100+ Lovable projects. |

> Native MCP support coming next week — early access by Lovable.

## Why this repo exists

Lovable's desktop app is useful, but a user-owned CLI is much easier to reason about when it stays on durable surfaces:

1. public creation URLs
2. the authenticated Lovable web UI
3. published preview and live URLs

That keeps the repo maintainable and avoids coupling to private desktop internals.

## Features

- Lovable session bootstrap and profile seeding
- dashboard project and workspace listing
- project creation from official build URLs
- prompt submission with server-side acceptance checks
- `build` / `plan` mode switching
- prompt auto-splitting for large requests
- queue pause detection and optional auto-resume
- question-card reading and answering
- proposal action discovery and clicking
- runtime error inspection and `Try to fix`
- findings extraction from Lovable's security pane
- `wait-for-idle` orchestration
- preview verification with screenshots, layout heuristics, console checks, and text assertions
- publish, publish settings, and domain management
- toolbar, project settings, workspace settings, git, code, knowledge, and speed surfaces
- iterative `fidelity-loop` repair flows

## Repository layout

```text
src/
  cli.js              Commander entrypoint and command wiring
  browser.js          Playwright-driven Lovable surface automation
  orchestration.js    Prompt splitting, idle-state logic, orchestration helpers
  config.js           Paths and defaults
  profile.js          Session/profile copy helpers
  url.js              Build/create URL helpers

test/
  *.test.js           Focused regression tests for orchestration and browser helpers

skills/
  lovagentic/        Repo-local OpenClaw skill
```

Supporting docs:

- [AGENTS.md](./AGENTS.md) for agent-oriented operating guidance
- [CONTRIBUTING.md](./CONTRIBUTING.md) for contributor workflow
- [SECURITY.md](./SECURITY.md) for secret-handling and reporting expectations
- [CHANGELOG.md](./CHANGELOG.md) for release history
- [docs/commands.md](./docs/commands.md) for the generated CLI reference
- [docs/releases.md](./docs/releases.md) for the release process

## Requirements

- macOS recommended
- Node.js 20+
- npm
- Playwright Chromium installed
- a valid Lovable account and session on the machine where the CLI runs

## Install

```bash
npm install
npx playwright install chromium
```

## Quick start

Inspect the local environment:

```bash
npm run doctor
```

Login once into the CLI-managed browser profile:

```bash
npm run start -- login
```

Create a new project:

```bash
npm run start -- create "Build a marketing site for a solar company"
```

Prompt an existing project:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" \
  "Add a testimonials section and tighten the mobile spacing."
```

Wait until Lovable is really idle:

```bash
npm run start -- wait-for-idle "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovagentic-profile \
  --seed-desktop-session \
  --headless \
  --json
```

Verify the preview:

```bash
npm run start -- verify "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovagentic-profile \
  --seed-desktop-session
```

## Authentication and session model

The CLI is only useful when the Playwright profile contains a real Lovable session.

Preferred auth paths:

1. `npm run start -- login`
2. `npm run start -- import-desktop-session`
3. `--seed-desktop-session` on supported commands

Important constraints:

- desktop-profile import is best-effort
- headed runs are safer when interactive verification is likely
- headless runs are practical, not guaranteed

## Core command groups

### Bootstrap and session

| Command | Purpose |
| --- | --- |
| `doctor` | Inspect local Lovable desktop and CLI profile state |
| `import-desktop-session` | Seed Playwright profile from the macOS desktop app |
| `login` | Create a CLI-managed browser session |
| `list` | List dashboard projects and visible workspaces |
| `create` | Create a new project from an official build URL |

### Prompt orchestration

| Command | Purpose |
| --- | --- |
| `mode` | Switch the Lovable composer between `build` and `plan` |
| `prompt` | Submit a prompt into a project |
| `actions` / `action` | Inspect or click visible proposal actions |
| `questions` / `question-action` / `question-answer` | Handle Lovable clarification cards |
| `errors` / `error-action` | Inspect or click runtime/build error actions |
| `findings` | Read Lovable security findings |
| `chat-loop` | Prompt, inspect actions, click actions, optionally verify |
| `wait-for-idle` | Wait until Lovable is not thinking, paused, blocked, or erroring |
| `fidelity-loop` | Verify expectations and iteratively follow up on remaining gaps |

### Project and publish surfaces

| Command | Purpose |
| --- | --- |
| `verify` | Capture preview screenshots and a verification summary |
| `publish` | Publish or update a project |
| `publish-settings` | Inspect or update website info and visibility |
| `domain` | Inspect or update domain settings |
| `toolbar` | Inspect visible project toolbar surfaces |
| `project-settings` | Inspect or update low-risk project settings |
| `knowledge` | Inspect or update project/workspace knowledge |
| `workspace` | Inspect workspace and account settings |
| `git` | Inspect or manage the Git/GitHub connection |
| `code` | Read the connected repository through Lovable's code surface |
| `speed` | Run Lighthouse against the current preview URL |

Run `npm run help` or `npm run start -- --help` for the full command list.

## Common workflows

### Create and publish a throwaway smoke project

```bash
npm run start -- create "Build a simple static smoke page with one heading and one CTA" \
  --profile-dir /tmp/lovagentic-smoke \
  --seed-desktop-session \
  --workspace "Tobi's Lovable" \
  --headless

npm run start -- publish "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovagentic-smoke \
  --seed-desktop-session \
  --headless
```

### Send a long prompt safely

Large prompts are auto-split by default:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" \
  "$(cat ./long-prompt.txt)" \
  --profile-dir /tmp/lovagentic-profile \
  --seed-desktop-session \
  --mode plan
```

If you deliberately keep a large prompt in a single Lovable turn with `--no-auto-split`, the CLI now gives larger prompts more time and can rely on server acceptance plus reload persistence before failing.

### Run a plan approval flow

```bash
npm run start -- chat-loop "https://lovable.dev/projects/your-project" \
  "Outline the next changes before touching code." \
  --profile-dir /tmp/lovagentic-profile \
  --seed-desktop-session \
  --mode plan \
  --action "Approve"
```

### Prompt and verify immediately

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" \
  "Add a testimonials section." \
  --profile-dir /tmp/lovagentic-profile \
  --seed-desktop-session \
  --verify \
  --expect-text "Testimonials" \
  --forbid-text "404"
```

## Safety model

`lovagentic` is intentionally conservative:

- it prefers browser-observable state over guessed internal APIs
- it checks for server-side chat acceptance where possible
- it re-checks persistence after reload for write paths
- it distinguishes idle, paused queue, open questions, and error states
- it refuses to silently treat UI-local state as success

Recommended testing pattern:

```bash
--profile-dir /tmp/lovagentic-<task-name>
--seed-desktop-session
```

Prefer throwaway projects for:

- prompt regression checks
- queue handling tests
- domain and publish experiments
- anything that mutates content or settings

## Known limitations

- interactive verification challenges can still block headless flows
- visual verification is screenshot/runtime-based, not golden-image diffing
- domain purchase and registrar flows are not automated
- some Lovable surfaces can drift and need selector maintenance
- knowledge writes are guarded and fail if Lovable does not persist them after reload

## Development

Run the local checks:

```bash
npm test
npm run check
```

Core scripts:

| Script | Purpose |
| --- | --- |
| `npm run help` | Show CLI help |
| `npm run doctor` | Run the `doctor` command |
| `npm run generate:commands` | Regenerate the command reference |
| `npm run check:commands` | Ensure the generated command reference is up to date |
| `npm test` | Run regression tests |
| `npm run check:syntax` | Run `node --check` on all source files |
| `npm run check` | Run syntax checks and tests |
| `npm run ci` | CI-equivalent local check |

GitHub Actions CI runs `npm ci`, installs Playwright Chromium, and executes `npm run check`.
Dependabot keeps npm and GitHub Actions dependencies moving weekly.

## Design constraints

When extending this repo:

- preserve the stable-surfaces-only design
- prefer DOM/state detection over brittle CSS selectors
- keep new commands idempotent when practical
- verify real persistence after reload
- document user-facing behavior changes in this README

## Related files

- [AGENTS.md](./AGENTS.md)
- [skills/lovagentic/SKILL.md](./skills/lovagentic/SKILL.md)
- [docs/commands.md](./docs/commands.md)
