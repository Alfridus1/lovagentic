# Example: Build a CRM Dashboard with lovagentic

Build, iterate, and publish a full CRM dashboard from the terminal in ~90 seconds — without ever opening the Lovable web UI.

## What this example does

1. Creates a brand-new Lovable project from a single prompt
2. Iterates on it with two follow-up prompts (chat-loop style)
3. Verifies the preview on desktop + mobile
4. Runs a Lighthouse audit with performance gates
5. Publishes the project to its default Lovable domain

## Run it

```bash
./build.sh
```

The script is idempotent: re-running it picks up the last-created project from `.last-project-id` and continues iterating on it instead of creating a new one.

## What's in the prompts

- [`prompts/01-initial.md`](./prompts/01-initial.md) — the initial project spec
- [`prompts/02-refine-ui.md`](./prompts/02-refine-ui.md) — dark mode + accessibility pass
- [`prompts/03-add-search.md`](./prompts/03-add-search.md) — adds a customer search box

## Notes

- All three prompts fit comfortably under the 5k soft-limit where lovagentic auto-splits. Together they represent ~8KB of instructions.
- The Lighthouse thresholds in `build.sh` (`--min-performance 80`, `--min-accessibility 90`) match a reasonable PR gate. Tune them for your project.
- Swap the `--mode` flag on `chat` for `chat` (default) vs `agent` vs `plan` to taste.
