# Release process

## Principles

- Keep release notes user-facing and command-focused.
- Document Lovable behavior changes separately from CLI fixes.
- Prefer small, verifiable releases over large batches of UI-automation changes.

## Automated release flow

Use the one-shot release script:

```bash
npm run release:patch   # 0.1.10 -> 0.1.11
npm run release:minor   # 0.1.10 -> 0.2.0
npm run release:major   # 0.1.10 -> 1.0.0

# Or pin an exact version:
node ./scripts/release.mjs 0.2.0
```

The script runs, in order:

1. Preflight: ensure working tree is clean and on `main` (overrides: `--allow-dirty`, `--branch <name>`).
2. Bump `package.json` version.
3. Regenerate [`docs/commands.md`](./commands.md) from the live CLI definitions.
4. Run the full `npm run check` suite (syntax + tests + command reference).
5. Commit the bump + regenerated docs as `chore(release): vX.Y.Z`.
6. Create the git tag `vX.Y.Z`.
7. Push branch + tag to `origin`.
8. Publish to npm via [`scripts/publish-to-npm.mjs`](../scripts/publish-to-npm.mjs).
9. Create a GitHub release using the matching `CHANGELOG.md` section.

Flags for partial runs:

- `--dry-run` — skip every mutating step; useful for validating the bump + checks.
- `--skip-publish` — commit + tag + push, but skip npm publish and GitHub release.
- `--skip-gh` — publish to npm, skip `gh release create`.
- `--no-push` — commit + tag locally, skip `git push`.

## Before releasing

1. Move items from `Unreleased` into a new version heading in [CHANGELOG.md](../CHANGELOG.md).
2. Add the new version heading and date.
3. Confirm any Lovable UI-drift fixes were exercised against a real project.
4. Run the release script above.

## Manual fallback

If the automated flow can't run (for example in a locked-down CI), the manual steps are:

```bash
npm run prerelease           # regenerates docs/commands.md and runs npm run check
# edit package.json version manually
# edit CHANGELOG.md
git commit -am "chore(release): vX.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags
npm publish --provenance --access public
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes.md>
```

Note: `prepublishOnly` in `package.json` re-runs `npm run check` automatically before any `npm publish`, so the command reference and tests are always enforced at publish time.

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
