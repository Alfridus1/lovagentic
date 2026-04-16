# Release process

## Principles

- Keep release notes user-facing and command-focused.
- Document Lovable behavior changes separately from CLI fixes.
- Prefer small, verifiable releases over large batches of UI-automation changes.

## Before releasing

1. Run:

   ```bash
   npm run check
   npm run generate:commands
   ```

2. Verify that [docs/commands.md](./commands.md) is up to date.
3. Update [CHANGELOG.md](../CHANGELOG.md):
   - move relevant items from `Unreleased`
   - add the new version heading and date
4. Confirm any Lovable UI-drift fixes were exercised against a real project.

## Tagging and publishing

This repo does not currently automate package publication.

Recommended release flow:

1. bump `package.json` version
2. update `CHANGELOG.md`
3. create a GitHub release from the tag
4. use GitHub's generated notes as a draft, then edit for clarity

## Release note categories

GitHub release notes are grouped using [/.github/release.yml](../.github/release.yml).

Use labels consistently:

- `breaking-change`
- `feature`
- `enhancement`
- `bug`
- `docs`
- `documentation`
- `chore`
- `dependencies`
