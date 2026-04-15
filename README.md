# lovable-cli

`lovable-cli` is a local prototype for steering Lovable without relying on private desktop internals.

What it uses:

- Official Lovable "Build with URL" links for app creation.
- Playwright with a persistent browser profile for follow-up prompts.
- Optional session seeding from the installed macOS desktop app profile.

What it does not do:

- It does not patch or inject into `Lovable.app`.
- It does not depend on the desktop app's private WebSocket token flow.
- It does not expose a stable Lovable backend API, because the desktop bundle shows that the native app is primarily a wrapper around `https://lovable.dev`.

## Why this shape

The local desktop bundle is an Electron wrapper with:

- `https://lovable.dev` as the main renderer origin
- `https://api.lovable.dev` as the desktop API base
- a private `app/ws` socket bridge for local MCP relaying
- local MCP config under `~/.lovable` and app runtime state under `~/Library/Application Support/lovable-desktop`

That makes two surfaces practical for a user-owned CLI:

1. Stable: build URLs and browser automation.
2. Fragile: private desktop IPC and internal WebSocket auth.

This prototype stays on the stable side.

Repo-local OpenClaw skill:

- [skills/lovable-cli/SKILL.md](/Users/tobik/Documents/Playground/lovable-cli/skills/lovable-cli/SKILL.md)

## Install

```bash
npm install
npx playwright install chromium
```

## Commands

Check local setup:

```bash
npm run doctor
```

Try to seed the CLI browser profile from the installed desktop app session:

```bash
npm run start -- import-desktop-session
```

Create a new Lovable app from an official URL:

```bash
npm run start -- create "Build a marketing site for a solar company"
```

Create and drive the flow with the imported desktop session:

```bash
npm run start -- create "Build a simple landing page" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --workspace "Tobi's Lovable" \
  --headless
```

Only print the creation URL:

```bash
npm run start -- create "Build a pricing page" --no-open
```

Login once into the CLI-managed browser profile:

```bash
npm run start -- login
```

List Lovable dashboard projects and the visible workspace menu entries:

```bash
npm run start -- list \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --headless
```

Get the same dashboard state as JSON:

```bash
npm run start -- list \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --headless \
  --json
```

Send a follow-up prompt into a Lovable project page:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" "Add a testimonials section and tighten the mobile spacing."
```

Switch the Lovable composer to `plan`:

```bash
npm run start -- mode "https://lovable.dev/projects/your-project" plan \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --headless
```

Send a prompt explicitly in `plan` mode:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" "Outline the next changes before touching code." \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --mode plan
```

List visible chat-side actions when Lovable shows a proposal or follow-up UI:

```bash
npm run start -- actions "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session
```

Click a visible proposal action such as `Approve`:

```bash
npm run start -- action "https://lovable.dev/projects/your-project" "Approve" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session
```

Read the visible runtime/build error surface when Lovable shows `Try to fix`:

```bash
npm run start -- errors "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session
```

Click the visible runtime/build recovery action:

```bash
npm run start -- error-action "https://lovable.dev/projects/your-project" "Try to fix" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session
```

Open Lovable's inline security findings pane and extract the visible issues:

```bash
npm run start -- findings "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session
```

Get the same findings as JSON:

```bash
npm run start -- findings "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --json
```

Read a visible Lovable `Questions` card:

```bash
npm run start -- questions "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session
```

Answer the current `Questions` card through its free-text field:

```bash
npm run start -- question-answer "https://lovable.dev/projects/your-project" \
  "The hero illustration overflows right, the floating badges overflow on mobile, and the cookie banner overlaps the CTA." \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session
```

Run a full proposal loop in one command:

```bash
npm run start -- chat-loop "https://lovable.dev/projects/your-project" "Outline the next changes before touching code." \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --mode plan \
  --action "Approve"
```

Send a prompt and immediately verify the resulting live preview:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" "Add a testimonials section." \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --verify \
  --verify-output-dir ./output/verify/post-prompt
```

Send a prompt and assert concrete preview text:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" "Update the hero CTA." \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --verify \
  --expect-text "Get Started" \
  --forbid-text "404"
```

Refresh the browser session from the desktop app before sending:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" "Add a footer note." \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --headless
```

Run headed and let the CLI wait if Lovable asks for verification:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" "Refine the hero copy" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --verification-timeout-ms 600000
```

If the prompt is intentionally incomplete, bypass the prompt guard and optionally wait longer for a delayed follow-up question:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" "Fix the following layout issues on the landing page:" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --allow-fragment \
  --question-timeout-ms 20000
```

Keep the automated browser open after submitting:

```bash
npm run start -- prompt "https://lovable.dev/projects/your-project" "Refine the hero copy" --keep-open
```

Capture desktop and mobile preview screenshots plus a JSON summary:

```bash
npm run start -- verify "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --output-dir ./output/verify/latest
```

Fail the verify command if the preview emits console warnings/errors:

```bash
npm run start -- verify "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --output-dir ./output/verify/latest \
  --fail-on-console
```

Fail the verify command if expected preview text is missing:

```bash
npm run start -- verify "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --output-dir ./output/verify/latest \
  --expect-text "Get Started" \
  --forbid-text "404"
```

Publish a Lovable project to its default `.lovable.app` URL and wait for the live site:

```bash
npm run start -- publish "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session
```

Re-run publish against an already published project and print its live URL/status:

```bash
npm run start -- publish "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --headless
```

Inspect or update the published website info that Lovable exposes behind `Edit settings`:

```bash
npm run start -- publish-settings "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --title "My published title" \
  --description "Short published description"
```

Inspect or update the default `.lovable.app` subdomain from the domains settings page:

```bash
npm run start -- domain "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --subdomain "my-new-slug"
```

Inspect the current project toolbar and open menu-style toolbar surfaces:

```bash
npm run start -- toolbar "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --headless
```

Inspect or update low-risk project settings:

```bash
npm run start -- project-settings "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --category "Website" \
  --hide-lovable-badge true \
  --disable-analytics true
```

Inspect the connected Git/GitHub state:

```bash
npm run start -- git "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --headless
```

Read the connected GitHub repo as a pragmatic Code-surface fallback:

```bash
npm run start -- code "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --file "src/pages/Index.tsx"
```

Run the pragmatic Speed-surface fallback with Lighthouse against the live preview:

```bash
npm run start -- speed "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --device both
```

Inspect workspace/account settings without mutating them:

```bash
npm run start -- workspace "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --section all
```

Inspect project/workspace knowledge:

```bash
npm run start -- knowledge "https://lovable.dev/projects/your-project" \
  --profile-dir /tmp/lovable-cli-profile \
  --seed-desktop-session \
  --headless
```

## Notes

- `create` opens the system browser because the desktop app does not expose a documented URL-open control surface.
- `create` can also automate the whole flow with `--profile-dir` plus `--seed-desktop-session`.
- `list` reads Lovable's real `/dashboard` page, not the older `/projects` route, and extracts the current workspace, visible workspace menu entries, and the dashboard project feeds.
- `mode` switches the main Lovable composer between `build` and `plan`.
- `prompt` uses Playwright and a persistent profile at `~/.lovable-cli/profile` by default.
- `prompt` now blocks obviously truncated prompts by default and asks you to use `--allow-fragment` if you really want to send them.
- `prompt --mode plan|build` switches the composer before it types and submits.
- `questions` reads Lovable's separate follow-up `Questions` card when Lovable asks for clarification instead of continuing immediately.
- `question-answer` fills the question card's free-text field and submits it through the same project page.
- `actions` lists visible chat-side buttons near the composer, so agents can see proposal actions like `Approve`, `Skip`, or `Verify it works`.
- `action` clicks one of those visible chat-side buttons by label, which is the main path for button-driven follow-ups after plan suggestions.
- `errors` reads Lovable's separate runtime/build error surface, including recovery buttons like `Try to fix` and `Show logs`.
- `error-action` clicks one of those runtime/build error actions and, for recovery clicks, checks whether Lovable accepted the fix request on the server.
- `findings` opens the inline `View findings` security pane and extracts the visible scan status, pane actions, counts, and issue table rows.
- `chat-loop` combines those pieces: it can send a prompt, wait for the relevant action label to appear, click it, and then optionally run preview verification.
- `prompt --answer-question` and `chat-loop --answer-question` can auto-answer a delayed Lovable `Questions` card, but the follow-up may appear noticeably later than the original chat accept, so tune `--question-timeout-ms` when needed.
- `prompt` now waits for a real server-side `/chat` accept before it trusts the UI and then confirms persistence with a reload.
- `prompt --verify` runs the same preview capture path immediately after a persisted prompt.
- `publish` walks the Lovable publish wizard, waits for the deployment request, and then probes the live URL until it returns success.
- `publish` currently follows the default Lovable publish path: suggested `.lovable.app` subdomain and the default visibility selection shown in the wizard.
- `publish` now also handles already-published projects that show `Update` instead of `Publish`, and waits for that redeploy to complete.
- `publish-settings` automates the published project's `Edit settings` surface, including the nested `Save changes` step that Lovable requires after closing the `Website info` or `Visibility` submenus.
- `toolbar` inspects the top project toolbar and can open menu-style toolbar surfaces such as the project menu, share menu, GitHub menu, and publish surface.
- `project-settings` reads the real `/settings` page and can safely update visibility, category, `Hide Lovable badge`, `Disable analytics`, and rename.
- `git` reads the project-bound Git/GitHub state from the toolbar when possible and falls back to the settings pages for generic provider management.
- `code` is a pragmatic fallback that reads the connected GitHub repo through `gh api`; it does not scrape Lovable's in-app code editor DOM.
- `speed` is a pragmatic fallback that audits the current preview URL with Lighthouse; it does not scrape Lovable's in-app speed cards directly.
- `workspace` reads the visible workspace/account settings pages (`workspace`, `people`, `plans-credits`, `cloud-ai-balance`, `workspace-domains`, `privacy-security`, `account`) in inspect-only mode.
- `knowledge` can read project/workspace knowledge and attempts writes, but it now fails explicitly if Lovable does not persist the edit after reload.
- `domain` inspects the `/settings/domains` page, can update the default `.lovable.app` slug, and can submit `Connect domain` when the requested domain becomes visible afterward.
- If the website info step is empty, Lovable may auto-edit `index.html` with default title/description metadata before it deploys. The CLI reports when that happens.
- `verify` resolves the live preview iframe, captures desktop and mobile screenshots, and writes `summary.json` with console errors, failed requests, and basic DOM stats.
- Preview verification now also checks for horizontal overflow / obvious out-of-viewport elements and can assert `--expect-text` / `--forbid-text`.
- `--fail-on-console` turns preview console warnings/errors into a blocking verify failure. Without it, console issues are still reported in `summary.json` but do not fail the command.
- `import-desktop-session` is best-effort. Chromium/Electron session reuse on macOS is not guaranteed, so manual `login` is the reliable path.
- `import-desktop-session` copies desktop auth/storage into Playwright's `Default/` profile layout.
- The publish surface also exposes `Add custom domain`, `Edit settings`, live visitor counts, and a security scan entry point. `Edit settings`, the default `.lovable.app` slug, and the direct `Connect domain` dialog are automated now; registrar purchase is still out of scope.
- Lovable may trigger an interactive `Verification required` challenge after submit. In a visible browser run, the CLI now waits for that challenge to clear and then re-checks persistence after a reload.
- Headless `prompt` runs are still best-effort. The CLI now treats "local echo only" as a failure and exits if the prompt does not survive a reload.
- If Lovable changes its composer DOM, use `--selector` or `--submit-selector` to override the heuristics.
