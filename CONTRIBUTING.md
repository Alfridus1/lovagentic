# Contributing

## Scope

`lovagentic` deliberately stays on stable, user-owned surfaces:

- official Lovable URLs
- browser automation against the web UI
- persistent Playwright profiles

Do not add features that depend primarily on:

- private Electron IPC
- reverse-engineered desktop WebSocket auth
- undocumented backend APIs as the main control path

## Local setup

```bash
npm install
npx playwright install chromium
```

## Development commands

```bash
npm run help
npm run doctor
npm run generate:commands
npm test
npm run check
```

## Browser harness and debugging

The supported browser harness is Playwright in `src/browser.js`. The CLI uses
persistent browser profiles so real Lovable login state can be reused across
commands.

For normal interactive debugging, run commands without `--headless`; a visible
Chromium window opens and can be inspected manually. For Playwright's inspector,
prefix the command with `PWDEBUG=1`.

Chrome DevTools is not embedded as a separate CLI surface. If you need DevTools,
open it from the visible Chromium window, or use a temporary Playwright script
under `scratch/`. Keep one-off harness scripts out of git; promote anything
reusable into `test/` or `src/`.

## Contribution guidelines

- Prefer throwaway Lovable projects for any write-path testing.
- Keep commands idempotent where practical.
- Fail explicitly when a Lovable surface is missing or has drifted.
- Verify persistence after reload for any write operation.
- Distinguish UI-local state from server-persisted state.
- Update `README.md` when user-facing behavior changes.
- Regenerate `docs/commands.md` when command output changes.
- Add or update regression tests for orchestration, prompt handling, or selector logic.

## Manual verification expectations

Before merging UI-automation changes, try to cover at least one real Lovable flow:

- `prompt`
- `chat-loop`
- `wait-for-idle`
- `verify`
- the specific surface you changed

If a real Lovable verification challenge blocks the run, document that clearly in the PR.
