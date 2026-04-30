# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.3] - 2026-04-30

### Added

- New `proposals/` directory for upstream PR-ready design documents. First entry: [`proposals/lovable-sdk-getproject-enrichment.md`](./proposals/lovable-sdk-getproject-enrichment.md), a complete drop-in proposal for `@lovable.dev/sdk` adding `client.getProject(id, { enrich: true })` with the same workaround `lovagentic` ships internally. Includes real-world repro using a published Lovable project, reference implementation, TypeScript signatures, and a bundle of side documentation drift corrections.

### Changed

- `docs/lovable-api-reference.md` and `docs/lovable-api.md` updated for the `GET /v1/projects/{pid}/database` endpoint. Recon across 55 projects in 4 workspaces confirms two distinct shapes: `{ enabled: false }` when the project has no Lovable Cloud DB, and `{ enabled: true, stack: "supabase" }` when it does. The `stack` field was missing from earlier drafts; the only value observed in production is `"supabase"`. The TypeScript reference type was also corrected.

## [0.3.2] - 2026-04-30

### Added

- API backend `getProjectState(projectId)` now grafts the aggregate-only fields (`tech_stack`, `edit_count`, `created_at`, `updated_at`, `last_edited_at`, `last_viewed_at`, `user_display_name`, `user_photo_url`, `is_starred`, `remix_count`, `trending_score`, `app_visitors_*`) from the project list response onto the slim single-get payload. Live recon confirmed `GET /v1/projects/{pid}` deliberately omits these fields, while `GET /v1/workspaces/{wsId}/projects` items carry them. The workaround is non-destructive (slim values like `latest_commit_sha` and `latest_screenshot_url` always win) and caches list pages per workspace for 30s so back-to-back lookups share one round-trip.
- New `getProjectState(id, { fast: true })` (and convenience `getProjectStateFast(id)`) opt-out for callers that don't need aggregates and want the original SDK shape unchanged.
- Exported `enrichProjectWithAggregates`, `mergeProjectAggregates`, and `clearApiBackendCaches` from `src/backends/api-backend.js` so they can be reused or mocked from outside the backend.
- Regression tests for the merge logic, cache reuse, soft-fail on list errors, and the no-op path when input is already enriched (6 new tests, 78/78 pass).

## [0.3.1] - 2026-04-30

### Fixed

- `lovagentic runbook` now persists snapshot/diff artifacts even when a step omits an explicit `output:`. When the runbook has any output directory (auto-generated under `output/runbooks/<name-timestamp>` by default), each snapshot/diff step writes a `<step-slug>.json` file there and the human summary now prints the resolved output path per step. Previously the steps ran successfully but silently dropped their JSON.
- `lovagentic list` now respects API-cache auth (`~/.lovagentic/auth.json`) for backend selection, not just `LOVABLE_API_KEY`/`LOVABLE_BEARER_TOKEN`. Added `--workspace <id>`, `--all-workspaces`, `--projects-only`, `--sort-by`, and `--sort-order` flags so callers can list raw API project arrays without going through the dashboard scrape. The new direct rendering prints id, display name, status, edit count, last-edited timestamp, and live URL per project.

### Changed

- `docs/lovable-api-reference.md` and `docs/lovable-api.md` updated with corrections from a full live recon against `api.lovable.dev`. Highlights: `GET /v1/projects/{pid}` is slimmer than the list-item shape, `/edits` items carry no diff metadata, `/git/files` is flat with `{path, size, binary}` only, `/git/diff` uses `diffs` (not `entries`) with `{action, file_path, file_type, is_image, hunks}` and camelCase hunk fields, `/database` returns just `{ enabled: bool }`, `/v1/workspaces/{wsId}` wraps the workspace as `{ workspace, current_member }`, `POST /messages` returns `{message_id, status}` (no `ai_message_id`), and `GET /messages` (LIST) is unsupported. Visibility-toggle to `draft` is plan-gated; there is no `DELETE /v1/projects/{pid}` endpoint. `/v1/_dev/...` routes require `lov_...` API keys (Bearer rejected).

## [0.3.0] - 2026-04-30

### Added

- New `auth` command group for managing Lovable API authentication without a `lov_...` API key. `auth bootstrap` extracts the Firebase refresh token from a logged-in browser profile (IndexedDB `firebaseLocalStorageDb`), persists it at `~/.lovagentic/auth.json` (mode 0600), and validates it by minting a fresh Bearer once. `auth refresh` swaps refresh tokens for new id tokens via Google's public Secure Token endpoint without launching a browser. `auth status`, `auth export`, and `auth clear` round out the lifecycle. The CLI flag is `--out-env` rather than `--env-file` because Node 20+ intercepts `--env-file=...` for its own dotenv loader before the script ever sees it.
- `src/auth.js` module with `extractFromProfile`, `refreshAccessToken`, `bootstrapFromProfile`, `refreshCached`, `getValidAccessToken`, and `writeEnvFile` helpers reusable from runbooks and from the API backend.
- `scripts/launchd/` macOS LaunchAgent template plus install/uninstall helpers that run `lovagentic auth refresh --out-env <path>` every 50 minutes (and on each login). The installer resolves symlinks to a real script path so `launchctl` does not pass arguments to `node` through a fragile shebang resolver.
- `scripts/extract-firebase-refresh.mjs` standalone helper that prints the Firebase auth state as JSON, useful when debugging the bootstrap flow.
- Comprehensive Lovable API documentation. `docs/lovable-api.md` covers the auth model, both API surfaces (`api.lovable.dev/v1/*` and the internal `lovable.dev/...` surface), refresh strategy, security notes, and troubleshooting. `docs/lovable-api-reference.md` walks every public endpoint with method, path, headers, request/response schemas, real example payloads, and operational notes — 42 endpoints catalogued, plus a TS-style type catalogue and end-to-end recipes for chat-and-wait, snapshot, publish, SQL, and remix.
- API-only `snapshot`, `diff`, and `runbook` commands. `snapshot` captures project state, URLs, knowledge, file trees, edit history, and optional file contents/MCP inventory. `diff` reads Lovable git diffs by message id, commit sha, or latest edit. `runbook` executes YAML/JSON orchestration steps for `snapshot`, `prompt`/`fix`, `wait`, `verify`, `diff`, and `publish`.
- `src/api-ops.js` and `src/runbook.js` so API snapshot/diff and runbook parsing logic can be tested outside the Commander entrypoint.
- Regression tests for API diff summarization/latest-edit resolution and YAML/JSON runbook normalization/planning.

### Changed

- The API backend transparently falls back to the on-disk auth cache managed by `auth bootstrap`/`auth refresh` when neither `LOVABLE_API_KEY` nor `LOVABLE_BEARER_TOKEN` is set in the environment. Tests pass `skipAuthCache: true` to preserve the env-only failure mode. The `api --validate` command now reports which credential source it actually used (`env-api-key`, `env-bearer`, or `auth-cache`).
- Refreshed README guidance to surface the Bearer-token bootstrap path next to the existing `lov_...` flow, with links into the new docs.
- Clarified docs after reviewing Lovable's `llms-full.txt`: the public Lovable API docs currently position `Build with URL` as the first documented API release, so key-backed SDK flows are described as preview/availability-gated rather than a complete public API replacement for browser automation.

## [0.2.0] - 2026-04-21

### Added

- Added the official Lovable API SDK dependency (`@lovable.dev/sdk`) and an `api` command for local SDK/auth readiness checks.
- Added `src/backends/api-backend.js`, a thin official-API backend adapter covering API-key auth, projects, prompts, plan mode, attachments, publish, knowledge, code/diffs, remix, MCP servers/connectors, analytics, and Lovable Cloud database helpers.
- Added `npm run check:lovable-sdk` plus a scheduled GitHub Actions watcher that opens a tracking issue when npm publishes a newer `@lovable.dev/sdk` than the lockfile uses.
- Added API-first execution paths for `list`, `create`, `prompt`, `publish`, `knowledge`, `status`, and `code` behind `--backend auto|api|browser`.

### Changed

- Backend auto-selection now tries the official API backend first when `LOVABLE_API_KEY` or `LOVABLE_BEARER_TOKEN` is configured, then MCP if configured, then the browser backend.
- `doctor` now reports official API SDK installation and API auth readiness without printing secrets.

## [0.1.13] - 2026-04-21

### Changed

- Tightened public documentation around the future MCP backend: removed stale timeline language and deleted non-runnable MCP config examples until a real `lovagentic mcp` command exists.

## [0.1.12] - 2026-04-21

### Fixed

- `publish` gives transient Lovable/Radix publish surfaces one cleanup-and-retry pass before failing with a missing `Continue` button. This avoids false stalls when the publish wizard briefly renders without exposing the actionable button.

### Changed

- Documented the Playwright browser harness and debugging workflow for headed runs, `PWDEBUG=1`, and local `scratch/` scripts.
- Ignored local ad-hoc browser harness scripts so one-off Lovable project audits do not pollute `git status`.
- The release script now keeps `package-lock.json`'s root package version in sync with `package.json`.

## [0.1.11] - 2026-04-18

### Fixed

- Lovable UI regression: Radix popovers (e.g. "Feeling stuck? Use plan mode to create a plan before you build.") were intercepting pointer events on the composer focus click and the send button, causing headless prompt submission to hang on `<p>…</p> from <div data-radix-popper-content-wrapper="">…</div> subtree intercepts pointer events` with Playwright click retries. The `fillPrompt` path now proactively removes stray popper wrappers before clicking the composer and falls back to `{ force: true }` if the intercept survives. `submitPrompt` runs the same dismissal (Escape → corner-click → DOM removal) and bypasses the click path entirely in favour of `Meta+Enter`/`Control+Enter` when a popover cannot be dismissed. Prompt submission is now resilient against arbitrary Radix popovers that appear mid-flow.

## [0.1.10] - 2026-04-18

### Added

- `lovagentic init` scaffolds a new project directory with `.lovagentic.json`, `.env.example`, `.gitignore`, `prompts/example.md`, and `README.md`. Existing files are skipped unless `--force` is used, and an existing `.gitignore` is augmented in place (not overwritten). Supports `--json` for CI pipelines.
- `publish --json` emits a machine-readable result containing `alreadyPublished`, `updatedExisting`, `siteInfoUpdated`, `deploymentId`, `liveUrl`, `liveCheck`, and `verificationSummaryPath` fields.
- `verify --json` emits a machine-readable result containing `ok`, `summaryPath`, `summary`, and `outputDir` fields.
- `test/init.test.js` adds 5 regression tests covering scaffolding, idempotency, `--force` overwrite, `--json` output, and `.gitignore` preservation.

## [0.1.9] - 2026-04-18

### Added

- `doctor` now probes network reachability to `https://lovable.dev` and `https://registry.npmjs.org` with a 3s timeout each, including response latency in the human-readable output (`lovable.dev reachable (219ms)`). Failures are surfaced with a hint covering offline/proxy issues. The JSON output includes the new `lovableReachable` and `npmReachable` check keys.

## [0.1.8] - 2026-04-18

### Fixed

- `publish` no longer stalls at `"visibility" without a Continue button` for already-published projects. The wizard concatenates words without whitespace (e.g. `PublishedLive URLWho can see the website`), so the old `\bPublished\b` word-boundary regex couldn't match and the surface was misclassified as the pre-publish visibility step. The classifier now uses non-bounded matches for both `Published` and `Live URL`.
- `publish` no longer fails with `Lovable publish flow never exposed a live URL` when the wizard hides the hostname behind a copy button. All three early-return paths fall back to the dashboard project record (fetched in a sibling tab so the project page isn't navigated away) and use the dashboard-reported `liveUrl` when the wizard DOM can't expose it.

### Added

- `classifyPublishSurface` is now exported from `src/browser.js` for unit testing.
- `test/publish-classify.test.js` adds 10 regression cases covering the concatenated-`Published`-`Live URL` case, the fresh visibility step, the publishing/review/website_info/website_url/unknown steps, and the `Publishing > Published` precedence during an update.

## [0.1.7] - 2026-04-18

### Fixed

- `lovagentic --version` no longer reports a stale hardcoded version string. It now reads the installed `package.json` at startup, so the value always matches whatever npm actually installed. Previously every release drifted until someone remembered to touch `.version("…")` in `src/cli.js`, and a user who installed `0.1.6` would still see `0.1.4`.

### Added

- `test/version.test.js` guards both sides of the fix: it asserts `--version` exec output equals `package.json` version, and that `src/cli.js` contains no `.version("x.y.z")` literal so the hardcoded pattern cannot silently come back.

## [0.1.6] - 2026-04-18

### Added

- `verify --authenticated` reuses the Lovable browser profile when capturing previews so unpublished or auth-gated routes (e.g. draft `/docs/*` pages served off the preview origin) can be screenshotted instead of falling through to the Lovable login page. Default behavior remains anonymous capture so public published previews stay auth-footprint-free.
- `capturePreviewSnapshot` gained an optional `profileDir` parameter to power the above. When provided it uses `chromium.launchPersistentContext` against the profile; when omitted it falls back to the previous clean-browser `chromium.launch` path.

## [0.1.5] - 2026-04-18

### Fixed

- Prompt persistence check no longer false-fails on long prompts (>600 chars normalized). Lovable collapses long chat bubbles, so a full verbatim `includes()` never matched after reload and every large prompt was incorrectly reported as `Lovable showed the prompt locally, but it did not persist after a page reload.` We now accept a prefix fingerprint match (first 160 characters of the normalized prompt) as evidence of persistence. Short prompts still require a verbatim match.
- `status` no longer aborts when the preview iframe is slow to attach or the git panel times out; both surfaces are reported as soft errors so dashboard metadata and publish state still print.

### Added

- `test/prompt-match.test.js` with 8 new cases covering verbatim matches, fingerprint fallback, whitespace/markdown normalization, absent prompts, and length gating. Ships alongside a new exported `matchExpectedPromptInHaystack` helper for external reuse.

## [0.1.4] - 2026-04-17

### Added

- `verify --route <path>` for per-route preview captures with route-aware screenshot filenames and per-route summary output
- `prompt --verify-effect` for dashboard-backed post-submit verification using `editCount` / `lastEditedAt`
- `prompt --dry-run` for prompt sizing, token estimation, warning output, and chunk preview without opening a browser
- `status <target-url>` for dashboard metadata, publish state, git connection state, and preview reachability in one command
- `prompt --split-by markdown` plus `--chunked` to split multipart prompts on `##` or `###` headings when the prompt is already structured

### Changed

- Multipart prompt sends no longer prepend the old "Do not implement yet" shim; every emitted chunk is now sent as a standalone instruction
- `prompt --no-auto-split` is now the explicit single-shot escape hatch for users who want one Lovable turn
- README examples now document verified-action workflows and the recommended single-shot `--verify-effect` flow



## [0.1.3] - 2026-04-17

### Added

- Local file attachment support for prompt-driven Lovable flows
- `attachments` command for composer attachment inspection and staged uploads without sending
- Attachment support for `question-answer`
- Repository automation and ownership metadata:
  - GitHub Actions CI
  - Dependabot
  - CODEOWNERS
  - release-note categorization
- Generated CLI command reference in [docs/commands.md](./docs/commands.md)
- Contributor and security policy docs

### Changed

- README structure and maintenance workflow
- Package scripts for help, checks, CI, and command-reference generation
- Prompt orchestration can now upload reference files before sending the first prompt turn
- `prompt`, `chat-loop`, and the initial `fidelity-loop` turn can now send attachment-only requests without prompt text

## [0.1.0] - 2026-04-16

### Added

- Browser-first Lovable CLI
- Session bootstrap and desktop-profile seeding
- Project creation, prompting, publish, verify, and idle orchestration
- Toolbar, project settings, git, code, speed, workspace, and knowledge surfaces
- Prompt splitting, queue handling, findings extraction, question handling, and fidelity loop support
