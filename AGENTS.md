# AGENTS.md

## Purpose

`lovable-cli` is a local prototype for steering Lovable through stable, user-owned surfaces:

- official Lovable URLs for project creation
- Playwright browser automation against `https://lovable.dev`
- optional auth/session seeding from the installed Lovable macOS desktop profile

Do not treat this repo as a private desktop reverse-engineering client. The design goal is explicitly to avoid Lovable's private Electron IPC or undocumented desktop WebSocket auth.

## Operating Model

Use these surfaces:

- browser automation on Lovable's web UI
- persistent Playwright profiles
- official public/live URLs for verification

Do not use these surfaces:

- desktop app code injection
- desktop app private sockets
- guessed backend APIs as the primary interface

## Environment Requirements

- macOS recommended
- Node.js + npm
- Playwright Chromium installed
- a valid Lovable login session on the machine where the agent runs

Install:

```bash
npm install
npx playwright install chromium
```

## Auth And Session

The CLI is only useful when the browser profile has a real Lovable session.

Preferred paths:

1. `npm run start -- login`
2. `npm run start -- import-desktop-session`
3. `--seed-desktop-session` on commands that support it

Important:

- `import-desktop-session` is best-effort only.
- If Lovable or Cloudflare triggers `Verification required`, switch to a visible browser run.
- Headless flows are practical, not guaranteed.

## Repo Commands

Core commands:

```bash
npm run doctor
npm run start -- login
npm run start -- create "Build a simple landing page"
npm run start -- prompt "https://lovable.dev/projects/..." "Add a hero CTA"
npm run start -- mode "https://lovable.dev/projects/..." plan
npm run start -- actions "https://lovable.dev/projects/..."
npm run start -- action "https://lovable.dev/projects/..." "Approve"
npm run start -- errors "https://lovable.dev/projects/..."
npm run start -- error-action "https://lovable.dev/projects/..." "Try to fix"
npm run start -- findings "https://lovable.dev/projects/..."
npm run start -- chat-loop "https://lovable.dev/projects/..." "Outline the next changes" --mode plan --action "Approve"
npm run start -- verify "https://lovable.dev/projects/..."
npm run start -- publish "https://lovable.dev/projects/..."
npm run start -- publish-settings "https://lovable.dev/projects/..."
npm run start -- domain "https://lovable.dev/projects/..."
```

## Safe Testing Policy

Prefer throwaway Lovable projects for automation work.

Recommended profile pattern:

```bash
--profile-dir /tmp/lovable-cli-<task-name>
```

Recommended session pattern:

```bash
--seed-desktop-session
```

Do not change a real published project's subdomain, visibility, or website info unless the user explicitly asked for it.

## Recommended Smoke Sequence

For a new machine or new agent run:

1. `npm run doctor`
2. `npm run start -- login`
3. `npm run start -- create "Build a simple static smoke page with one heading and one CTA"`
4. `npm run start -- publish "<project-url>" --verify-live`
5. `npm run start -- publish-settings "<project-url>"`
6. `npm run start -- domain "<project-url>"`

For prompt regression checks:

1. Use `mode` to set `build` or `plan`
2. Use `prompt`
3. If Lovable shows button-based next steps, use `actions` and `action`
4. Use `prompt --verify`

For a single end-to-end proposal run:

1. Use `chat-loop "<project-url>" "<prompt>" --mode plan --action "Approve"`
2. Add `--verify` if the resulting preview should be captured immediately after the loop

## What Currently Works

- project creation through build URLs
- prompt submission with server-side accept checks
- `build` and `plan` composer mode switching
- listing visible chat-side proposal actions near the composer
- clicking button-driven follow-ups such as `Approve`, `Skip`, or similar Lovable proposal actions
- reading Lovable's separate runtime/build error surface with `Try to fix` / `Show logs`
- clicking runtime/build error actions and confirming server-side acceptance for `Try to fix`
- extracting the inline `View findings` security pane, including scan status, counts, pane actions, and issue rows
- single-command prompt -> proposal -> action flows through `chat-loop`
- preview verification with screenshots, console checks, text assertions, and layout heuristics
- publish to the default `.lovable.app` URL
- redeploy already-published projects through the `Update` button when Lovable shows pending changes
- live-site verification after publish
- published `Edit settings` automation for:
  - visibility inspection
  - title/description editing
- `.lovable.app` subdomain editing through the domains settings page

## Known Gaps

- custom domain connection is mapped in the UI but not submitted by the CLI yet
- domain purchase/registrar flows are not automated
- headless login/prompt flows can still fail on verification challenges
- visual verification is screenshot/runtime-based, not a golden pixel diff

## Important Product Observation

`publish-settings` can persist title and description in Lovable's publish UI, but the live site's delivered HTML may still keep Lovable's default `<title>` and meta description.

Treat that as a Lovable product behavior or publish pipeline issue, not automatically as a CLI failure.

## Output Artifacts

Generated artifacts go under:

- `output/verify/`
- `output/live-verify/`

Do not commit those artifacts. They are ignored on purpose.

## Agent Guidance

When extending this repo:

- preserve the "stable surfaces only" design
- prefer DOM/state detection over brittle CSS selectors
- verify changes with a real Lovable project whenever possible
- keep new commands idempotent when practical
- fail with explicit errors when a Lovable UI surface is missing or changed

When debugging:

- inspect the real rendered Lovable UI first
- confirm whether a value persisted after reload/navigation
- distinguish UI-local state from server-persisted state
- verify the live deployed URL separately from the Lovable project page
