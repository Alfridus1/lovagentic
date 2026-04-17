# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

### Fixed

- `status` no longer aborts when the preview iframe is slow to attach or the git panel times out; both surfaces are surfaced as soft errors in the output so dashboard metadata and publish state still report
- Prompt persistence check no longer false-fails on long prompts (>600 chars normalized). Lovable collapses long chat bubbles so a full verbatim includes() never matches after reload; we now accept a prefix fingerprint match (first 160 chars) as evidence of persistence, with a new test suite covering both short and long cases

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
