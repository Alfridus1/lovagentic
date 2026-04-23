---
name: lovagentic
description: "Use this repo-local skill when work should drive Lovable through the `lovagentic` project in this repository: inspect SDK/API readiness, list dashboard projects/workspaces, capture API snapshots/diffs, run YAML/JSON runbooks, inspect toolbar/settings/git/code/speed/domain surfaces, create apps, send prompts, guard against truncated prompts, answer Lovable clarification cards, switch build/plan, click proposal actions, inspect runtime errors with `Try to fix`, extract security findings, verify previews, and publish Lovable projects. Prefer this skill over ad hoc browser scripting when the task targets `lovable.dev` and can be done through the CLI. Do not use it for private desktop reverse engineering or unsupported domain-purchase flows."
metadata:
  {
    "openclaw":
      {
        "emoji": "💗",
        "requires": { "bins": ["node", "npm", "npx"] },
      },
  }
---

# lovagentic

Use the local CLI in this repo instead of rebuilding Lovable browser flows from scratch.

## Scope

Use this skill for:

- Lovable project creation through build URLs
- SDK/API readiness checks through `api`
- API-first `list`, `create`, `prompt`, `publish`, `knowledge`, `status`, and `code` through `--backend auto|api|browser`
- API-only project snapshots through `snapshot`
- API-only git diffs through `diff`
- YAML/JSON orchestration through `runbook`
- public website assertions, screenshots, saved HTML, link/meta checks, and route discovery through `site-check` / `route-discover`
- publish plus live custom-domain confirmation through `publish-confirm`
- standardized Lovable-site updates from an audit file through `update-site --from <path>`
- project sync/drift inspection through `project-sync-status`
- read-only MCP serving of repo docs, command reference, issues, and releases through `mcp-server`
- dashboard project/workspace listing through `list`
- top-toolbar inspection through `toolbar`
- project settings reads and safe writes through `project-settings`
- project/workspace knowledge reads and guarded writes through `knowledge`
- workspace/account settings inspection through `workspace`
- project-bound Git/GitHub inspection through `git`
- GitHub-backed code reading through `code`
- Lighthouse-backed preview audits through `speed`
- explicit idle-state detection through `wait-for-idle`
- prompt-guarded prompt submission plus delayed clarification handling through `questions` / `question-answer`
- iterative preview assertion repair through `fidelity-loop`
- `build` / `plan` mode switching
- prompt submission and prompt-to-action loops
- visible proposal actions near the composer
- runtime/build error handling with `Try to fix` and `Show logs`
- inline security findings extraction via `View findings`
- preview/live verification and publish flows

Do not use this skill for:

- private Electron IPC, desktop sockets, or backend reverse engineering
- unsupported registrar or domain-purchase flows
- parallel runs against the same `--profile-dir`

## Start Here

Work from the repo root:

```bash
cd /Users/tobik/Documents/Playground/lovagentic
npm install
npx playwright install chromium
```

Read [AGENTS.md](../../AGENTS.md) first for repo-specific safety rules.
Open [README.md](../../README.md) only when you need full command flags or examples.
Use [docs/commands.md](../../docs/commands.md) or `npm run start -- --help` as the command source of truth; the public website docs can lag the repository.

## Session Rules

- Prefer a fresh profile dir per run: `--profile-dir /tmp/lovagentic-<task>`
- Prefer `--seed-desktop-session`; fall back to `npm run start -- login`
- If Lovable asks for verification, rerun visibly instead of forcing headless
- Treat one profile dir as single-run ownership

## Core Commands

```bash
npm run start -- prompt "<project-url>" "<prompt>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- questions "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- question-answer "<project-url>" "Concrete clarification answer" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- list \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session \
  --headless

npm run start -- api --json

LOVABLE_API_KEY="lov_..." npm run start -- api --validate

LOVABLE_API_KEY="lov_..." npm run start -- list --backend api --json

LOVABLE_API_KEY="lov_..." npm run start -- snapshot "<project-url>" \
  --output ./output/snapshot.json

LOVABLE_API_KEY="lov_..." npm run start -- diff "<project-url>" \
  --latest \
  --json

LOVABLE_API_KEY="lov_..." npm run start -- runbook ./runbook.yaml

npm run start -- chat-loop "<project-url>" "<prompt>" \
  --mode plan \
  --action "Approve" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- wait-for-idle "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session \
  --headless

npm run start -- errors "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- error-action "<project-url>" "Try to fix" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- findings "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- toolbar "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- project-settings "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- git "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- code "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session \
  --file "src/pages/Index.tsx"

npm run start -- speed "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session \
  --device desktop

npm run start -- fidelity-loop "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session \
  --expect-file ./expectations.txt

npm run start -- verify "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- publish "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session

npm run start -- publish-confirm "<project-url>" \
  --profile-dir /tmp/lovagentic-task \
  --seed-desktop-session \
  --expect-text "API-first where supported"

npm run start -- site-check "https://lovagentic.com" \
  --discover-routes \
  --meta-description "Agentic CLI" \
  --forbid-html "native MCP next week"

npm run start -- update-site "<project-url>" \
  --from ./docs/site-audit.md \
  --publish

LOVAGENTIC_MCP_TOKEN=change-me npm run start -- mcp-server \
  --host 0.0.0.0 \
  --port 8787
```

## Preferred Flow

1. Use `mode` or `chat-loop` to choose `build` or `plan`.
2. Use `prompt` or `chat-loop` for the main change.
3. Use `actions` / `action` for proposal chips.
4. Use `errors` / `error-action` if the preview breaks.
5. Use `findings` for the security scan surface.
6. Use `verify` or `publish --verify-live` before closing.

## Important Notes

- The CLI is the stable surface. Extend it before falling back to raw browser scripting.
- Prefer repo-local docs and command help over the public website when they disagree.
- `Try to fix` lives on the runtime error surface, not in chat actions.
- `View findings` opens an inline pane, not a modal.
- `code` and `speed` are pragmatic fallbacks: GitHub + Lighthouse, not DOM scraping of Lovable's in-app panes.
- Lovable's public docs currently document `Build with URL` as the first Lovable API release. Treat key-backed SDK flows as preview/availability-gated and keep browser fallback ready.
- `snapshot`, `diff`, and `runbook` require `LOVABLE_API_KEY` or `LOVABLE_BEARER_TOKEN`; they intentionally fail closed instead of falling back to brittle DOM scraping.
- `runbook verify` still uses Playwright screenshot capture because visual/runtime verification is not available through the SDK.
- `wait-for-idle` uses page state, queue labels, runtime errors, and question cards; generic proposal chips do not count as build activity.
- long prompts auto-split by default; use `--no-auto-split` only when you explicitly want a single large Lovable turn.
- `--auto-resume` also applies during multipart prompt flows, not just `wait-for-idle` / `verify` / `speed`.
- `knowledge` writes are guarded. If Lovable does not persist after reload, treat that as a product/UI limitation and fail loudly instead of pretending success.
- Use `publish-confirm` instead of plain `publish` when the important question is whether the public custom domain actually serves the new copy.
- Use `site-check` for public URLs. It does not need a Lovable session and records screenshots, HTML, console entries, and failed requests.
- Treat `audit-bundle.json` from `site-check`, `publish-confirm`, and `update-site` as the preferred handoff artifact for later agents.
- Project-session commands acquire a per-project lock by default. Only pass `--no-project-lock` for deliberate read-only parallel debugging.
- Use `mcp-server` when Lovable should read this repo through its MCP connector. Prefer Bearer auth (`LOVAGENTIC_MCP_TOKEN`) for any hosted/public endpoint.
- Confirm persistence after reload or navigation when a Lovable action claims success.
