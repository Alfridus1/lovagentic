# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
