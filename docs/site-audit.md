# Website Audit

Last checked: 2026-04-23

The public website is deployed separately from this repository. Treat this file
as the handoff checklist for the next `lovagentic.com` Lovable-site update.

## Checked URLs

- `https://lovagentic.com/`
- `https://lovagentic.com/docs`
- `https://lovagentic.com/docs/reference/commands`

## Findings

- The homepage renders the current v0.2 API/SDK message, but the raw HTML meta
  description still says `Browser-based today, native MCP next week`.
- The docs home is stale. It still says `Browser-first today, MCP-native in
  v0.2`, `no API key`, and `Last updated: 2026-04-18`.
- The hosted command reference lags the repo. The current source of truth is
  [`docs/commands.md`](./commands.md), generated from `src/cli.js`.
- The live HTML still includes the Lovable badge styling. If the production
  project has access to the paid toggle, enable `Hide Lovable badge` in Project
  Settings before the next publish.

## Replacement Copy

Use this positioning until Lovable exposes a production MCP transport:

```text
lovagentic v0.2 is API-first where Lovable's @lovable.dev/sdk preview supports
the workflow, and browser-backed everywhere else. Set LOVABLE_API_KEY for fast
SDK/API flows. Keep a logged-in Lovable browser session for UI-only surfaces
like questions, proposal actions, runtime fixes, visual verification, domains,
GitHub OAuth, and settings.
```

Do not describe the MCP backend as active. The repo has a scaffold for a future
public MCP backend, but production runs currently use SDK/API or browser
automation.

## Publish Checklist

1. Replace stale docs-home copy with the v0.2 wording above.
2. Regenerate the website command reference from [`docs/commands.md`](./commands.md).
3. Update SEO/meta descriptions to avoid the old `native MCP next week` claim.
4. If available, enable `Hide Lovable badge` before publishing.
5. Re-check `/`, `/docs`, and `/docs/reference/commands` after publish.
