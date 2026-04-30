<div align="center">

# lovagentic

**Agentic CLI for [Lovable.dev](https://lovable.dev) — agents in, apps out.**

Send prompts, verify builds, fix errors, and publish — straight from your terminal or from inside your AI agent.

[![npm version](https://img.shields.io/npm/v/lovagentic.svg?color=blue)](https://www.npmjs.com/package/lovagentic)
[![npm downloads](https://img.shields.io/npm/dw/lovagentic.svg?color=brightgreen)](https://www.npmjs.com/package/lovagentic)
[![CI](https://github.com/Alfridus1/lovagentic/actions/workflows/ci.yml/badge.svg)](https://github.com/Alfridus1/lovagentic/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-lovagentic.com-blue)](https://lovagentic.com/docs)

</div>

---

```bash
npm install -g lovagentic
lovagentic prompt "https://lovable.dev/projects/YOUR-ID" "Add a dark mode toggle"
```

That's it. Lovable builds. You ship.

![lovagentic demo](.github/assets/demo.gif)

---

## What it does

lovagentic gives your terminal (and your AI agents) full control over Lovable:

| | |
|---|---|
| 🚀 **Prompt** | Send prompts, split long ones automatically, verify they landed |
| 🔍 **Verify** | Screenshot every route, check for layout overflows, assert text |
| 📦 **Publish** | One command to deploy — with live URL check |
| 🛠 **Fix** | Inspect runtime errors, click "Try to fix", loop until clean |
| 🤖 **Agent-ready** | `--json` output on every command. Pipe it, script it, chain it. |

---

## Multi-backend: browser, MCP, or API

lovagentic v0.2 auto-selects the fastest available backend:

```
LOVABLE_API_KEY set  →  @lovable.dev/sdk preview backend  (fastest, no browser)
LOVABLE_MCP_URL set  →  MCP backend
nothing set          →  Playwright browser fallback  (always works)
```

Lovable's public docs currently describe the Lovable API as starting with
**Build with URL**. The key-backed SDK backend in lovagentic is intentionally
treated as a preview path: use it when Lovable has granted API access, and keep
the browser backend as the compatibility layer for UI-only surfaces.

Set an API key and supported commands can skip Playwright:

```bash
export LOVABLE_API_KEY=lov_your_key_here
lovagentic api --validate        # confirm SDK is ready
lovagentic list --json           # pure HTTPS, instant
lovagentic prompt "..." "..."    # no browser launch
```

No `lov_...` API key yet? Use the Firebase Bearer-token path that the
Lovable web/desktop app uses internally. After signing in to Lovable Desktop
or running `lovagentic login`, capture the refresh token once and let
lovagentic keep a fresh Bearer on disk for you:

```bash
lovagentic import-desktop-session --profile-dir /tmp/lovagentic-profile
lovagentic auth bootstrap \
  --profile-dir /tmp/lovagentic-profile \
  --out-env $HOME/.lovagentic/lovable.env

lovagentic api --validate        # auto-uses the cached token
```

Optional: install a macOS LaunchAgent that refreshes the Bearer every
50 minutes (see `scripts/launchd/install-auth-refresh.sh`). Full reference
in [`docs/lovable-api.md`](docs/lovable-api.md) and per-endpoint detail in
[`docs/lovable-api-reference.md`](docs/lovable-api-reference.md).

---

## Install

```bash
npm install -g lovagentic
```

First run:

```bash
lovagentic doctor          # check environment
lovagentic login           # authenticate with Lovable (browser, one-time)
lovagentic list            # confirm projects are visible
```

---

## Quick examples

**Send a prompt and verify it landed:**
```bash
lovagentic prompt "https://lovable.dev/projects/YOUR-ID" \
  "Make the hero section full-width on mobile" \
  --headless --seed-desktop-session --verify-effect
```

**Scaffold a project directory:**
```bash
mkdir my-app && cd my-app
lovagentic init --project-url https://lovable.dev/projects/YOUR-ID
```

**Publish to production:**
```bash
lovagentic publish "https://lovable.dev/projects/YOUR-ID" \
  --headless --seed-desktop-session --verify-live
```

**Screenshot all routes (desktop + mobile):**
```bash
lovagentic verify "https://lovable.dev/projects/YOUR-ID" \
  --route / --route /docs --route /pricing \
  --expect-text "Get started"
```

**Run a repeatable build plan:**
```yaml
# runbook.yaml
projectUrl: https://lovable.dev/projects/YOUR-ID
steps:
  - type: snapshot
  - type: prompt
    promptFile: ./prompts/feature.md
  - type: verify
    expectText: [Feature, Get started]
  - type: publish
    verifyLive: true
```
```bash
LOVABLE_API_KEY=lov_... lovagentic runbook ./runbook.yaml
```

---

## All commands

| Command | What it does |
|---|---|
| `init` | Scaffold a project directory |
| `doctor` | Check local environment + network |
| `api` | Validate SDK/API-key readiness |
| `login` | Authenticate with Lovable |
| `list` | List your projects |
| `create` | Create a new Lovable project |
| `prompt` | Send a prompt |
| `mode` | Switch build/plan mode |
| `wait-for-idle` | Wait until Lovable stops thinking |
| `verify` | Screenshot routes, check text/layout |
| `publish` | Publish / deploy |
| `status` | Read project metadata |
| `code` | Read repo files via Lovable |
| `snapshot` | API-backed project artifact |
| `diff` | API-backed git diff |
| `runbook` | Execute a YAML/JSON build plan |
| `knowledge` | Read/write project knowledge |
| `domain` | Manage custom domains |
| `speed` | Lighthouse audit |
| `fidelity-loop` | Iterative verify → fix loop |
| `chat-loop` | Prompt → actions → verify |
| `errors` | Inspect + click runtime errors |
| `findings` | Read security findings |

Full reference → [lovagentic.com/docs/reference/commands](https://lovagentic.com/docs/reference/commands)

---

## Agent-ready: pipe it, script it

Every command supports `--json`:

```bash
STATUS=$(lovagentic status "https://lovable.dev/projects/YOUR-ID" --json)
EDIT_COUNT=$(echo $STATUS | jq '.editCount')

lovagentic prompt "..." "Add a pricing table" --json | jq '.effect.confirmed'

lovagentic publish "..." --json | jq '.liveUrl'
```

Use it from Claude, GPT, Codex, or any agent that can run shell commands.

---

## Environment variables

| Variable | Effect |
|---|---|
| `LOVABLE_API_KEY` | Use SDK/API backend where available |
| `LOVABLE_BEARER_TOKEN` | Alternative API auth |
| `LOVABLE_MCP_URL` | Use MCP backend |
| `LOVABLE_PROJECT_URL` | Default project for commands |
| `LOVAGENTIC_PROFILE_DIR` | Custom browser profile path |

Full reference → [lovagentic.com/docs/reference/env](https://lovagentic.com/docs/reference/env)

---

## Requirements

- Node.js 20+
- A Lovable account + session
- Playwright Chromium (auto-installed, only needed for browser backend)
- Optional: `LOVABLE_API_KEY` to use SDK-backed flows where available

---

## Roadmap

| Version | Status | What |
|---|---|---|
| **v0.1** | ✅ shipped | Browser-first CLI — Playwright control of every Lovable surface |
| **v0.2** | ✅ shipped | Multi-backend — SDK/API + MCP + browser fallback |
| **v0.3** | ✅ shipped | Firebase bearer-token bootstrap, refresh, persistent cache; full Lovable API reference docs; runbook output persistence; `getProject` enrichment workaround |
| **v0.4** | 🔵 planned | CI/CD integrations (GitHub Actions, Vercel workflows) |
| **v0.5** | ⚪ exploratory | Team-scale hosted control plane |

Long-form upstream proposals (e.g. `@lovable.dev/sdk` enhancements) live in
[`proposals/`](./proposals).

---

## Development

```bash
npm test          # 78 tests
npm run check     # syntax + tests
npm run doctor    # environment check
```

📚 Full docs: **[lovagentic.com/docs](https://lovagentic.com/docs)**  
📦 npm: **[npmjs.com/package/lovagentic](https://www.npmjs.com/package/lovagentic)**  
🐛 Issues: **[github.com/Alfridus1/lovagentic/issues](https://github.com/Alfridus1/lovagentic/issues)**

MIT License
