# AGENTS.md

## Purpose

`lovagentic` is a local prototype for steering Lovable through stable, user-owned surfaces:

- official Lovable URLs for project creation
- Playwright browser automation against `https://lovable.dev`
- optional auth/session seeding from the installed Lovable macOS desktop profile

Do not treat this repo as a private desktop reverse-engineering client. The design goal is explicitly to avoid Lovable's private Electron IPC or undocumented desktop WebSocket auth.

Repo-local OpenClaw skill:

- [skills/lovagentic/SKILL.md](/Users/tobik/Documents/Playground/lovagentic/skills/lovagentic/SKILL.md)

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
npm run check
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
npm run start -- list
npm run start -- create "Build a simple landing page"
npm run start -- prompt "https://lovable.dev/projects/..." "Add a hero CTA"
npm run start -- prompt "https://lovable.dev/projects/..." "Use the attached files as reference." --file ./test/fixtures/reference-doc.pdf
npm run start -- questions "https://lovable.dev/projects/..."
npm run start -- question-answer "https://lovable.dev/projects/..." "Concrete answer text"
npm run start -- mode "https://lovable.dev/projects/..." plan
npm run start -- actions "https://lovable.dev/projects/..."
npm run start -- action "https://lovable.dev/projects/..." "Approve"
npm run start -- errors "https://lovable.dev/projects/..."
npm run start -- error-action "https://lovable.dev/projects/..." "Try to fix"
npm run start -- findings "https://lovable.dev/projects/..."
npm run start -- chat-loop "https://lovable.dev/projects/..." "Outline the next changes" --mode plan --action "Approve"
npm run start -- wait-for-idle "https://lovable.dev/projects/..."
npm run start -- verify "https://lovable.dev/projects/..."
npm run start -- publish "https://lovable.dev/projects/..."
npm run start -- publish-settings "https://lovable.dev/projects/..."
npm run start -- domain "https://lovable.dev/projects/..."
npm run start -- toolbar "https://lovable.dev/projects/..."
npm run start -- project-settings "https://lovable.dev/projects/..."
npm run start -- git "https://lovable.dev/projects/..."
npm run start -- code "https://lovable.dev/projects/..."
npm run start -- speed "https://lovable.dev/projects/..."
npm run start -- fidelity-loop "https://lovable.dev/projects/..."
npm run start -- workspace "https://lovable.dev/projects/..."
npm run start -- knowledge "https://lovable.dev/projects/..."
```

Repo maintenance commands:

```bash
npm run help
npm test
npm run check
```

## Safe Testing Policy

Prefer throwaway Lovable projects for automation work.

Recommended profile pattern:

```bash
--profile-dir /tmp/lovagentic-<task-name>
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
7. `npm run start -- toolbar "<project-url>" --json`
8. `npm run start -- project-settings "<project-url>" --json`
9. `npm run start -- git "<project-url>" --json`
10. `npm run start -- code "<project-url>" --limit 20 --json`
11. `npm run start -- speed "<project-url>" --device desktop --json`
12. `npm run start -- wait-for-idle "<project-url>" --json`

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
- dashboard project/workspace listing through the logged-in `/dashboard` page
- prompt submission with server-side accept checks
- local file attachments on prompt flows through Lovable's hidden chat file input
- idle-state detection through `wait-for-idle`
- prompt guard for obviously truncated prompts
- automatic prompt splitting for large Lovable messages
- queue auto-resume during multipart prompt flows when `--auto-resume` is enabled
- `build` and `plan` composer mode switching
- reading Lovable clarification cards through `questions`
- answering free-text Lovable clarification cards through `question-answer`
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
- top-toolbar inspection including project/share/GitHub/publish menus
- project settings inspection plus safe writes for:
  - visibility
  - category
  - `Hide Lovable badge`
  - `Disable analytics`
  - rename
- project-bound Git/GitHub inspection
- GitHub-backed code reading through the connected repo
- Lighthouse-backed speed auditing against the current preview URL
- iterative preview assertion repair through `fidelity-loop`
- workspace/account settings inspection across the visible settings sections
- knowledge inspection, with guarded writes that fail if Lovable does not persist after reload

## Known Gaps

- fresh custom-domain connection submission is implemented, but it has only been validated idempotently against already listed domains so far
- domain purchase/registrar flows are not automated
- headless login/prompt flows can still fail on verification challenges
- visual verification is screenshot/runtime-based, not a golden pixel diff
- knowledge writes are guarded: the CLI now errors when Lovable does not persist the edit after reload, and current headless smoke runs still hit that product/UI limitation
- long multipart prompts are materially improved, but the exact Lovable queue/render behavior can still vary across projects and active queue state

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
- keep `README.md`, CI, and regression tests in sync with user-facing behavior

When debugging:

- inspect the real rendered Lovable UI first
- confirm whether a value persisted after reload/navigation
- distinguish UI-local state from server-persisted state
- verify the live deployed URL separately from the Lovable project page
