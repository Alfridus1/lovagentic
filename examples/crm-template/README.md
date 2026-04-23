# Example: Build a CRM Dashboard with lovagentic

Build, iterate, verify, audit, and publish a CRM dashboard from the terminal. With `LOVABLE_API_KEY` set, project creation can run unattended through the SDK/API preview backend; otherwise point the example at an existing project with `LOVABLE_PROJECT_URL`.

Preview verification, idle waiting, and browser-only Lovable surfaces still require a logged-in Lovable browser session.

## What this example does

1. Creates a brand-new Lovable project from a single prompt
2. Iterates on it with two follow-up prompts (chat-loop style)
3. Verifies the preview on desktop + mobile
4. Runs a Lighthouse audit with performance gates
5. Publishes the project to its default Lovable domain

## Run it

```bash
export LOVABLE_API_KEY=lov_...         # optional, required only for unattended create
# or:
export LOVABLE_PROJECT_URL=https://lovable.dev/projects/YOUR-ID

./build.sh
```

The script is idempotent: re-running it picks up the last-created project from `.last-project-url` and continues iterating on it instead of creating a new one.

## What's in the prompts

- [`prompts/01-initial.md`](./prompts/01-initial.md) — the initial project spec
- [`prompts/02-refine-ui.md`](./prompts/02-refine-ui.md) — dark mode + accessibility pass
- [`prompts/03-add-search.md`](./prompts/03-add-search.md) — adds a customer search box

## Notes

- All three prompts fit comfortably under the default auto-split thresholds; together they represent several KB of instructions.
- The Lighthouse gate in `build.sh` is implemented with `speed --json` plus `jq`, because `speed` reports scores but does not own policy thresholds.
- Use `chat-loop --mode build` or `chat-loop --mode plan` when you want proposal/action handling instead of simple `prompt` turns.
