# proposals/

Self-contained, PR-ready documents we'd like to push upstream when the
right channel exists. Each proposal is a single Markdown file with:

- a one-paragraph summary,
- evidence (real wire shapes, real project ids, repro snippets),
- the proposed change,
- a reference implementation we are already running in production,
- compatibility / rollout notes, and
- contact info.

## Filed

- [`lovable-sdk-getproject-enrichment.md`](./lovable-sdk-getproject-enrichment.md)
  Enrich `@lovable.dev/sdk`'s `client.getProject()` with the aggregate
  fields that today exist only on items in `client.listProjects()`. Includes
  reference implementation already shipping in `lovagentic@>=0.3.2` and a
  side bundle of doc-drift corrections worth fixing in the same release.

## How to use

`@lovable.dev/sdk` does not currently expose a public GitHub repo or an
issues tracker. Until they do, these documents serve two purposes:

1. **Source of truth** for what we want changed and why, written so that we
   can hand it to the maintainers via any channel they offer (Discord,
   email, future GitHub repo) without rewriting it.
2. **In-repo design notes** for our own workarounds, so contributors here
   can see why a given hack exists in `src/backends/api-backend.js`.

When a proposal lands upstream, move it from the "Filed" list above to a
"Resolved" section with the upstream version + the resolution.
