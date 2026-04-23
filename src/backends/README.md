# Backends

`lovagentic` talks to Lovable through a pluggable backend interface.
Callers never construct a backend directly — they call
`getBackend(options)` from `index.js`, which picks the right one based on
config + capability detection.

## Backend contract

Every backend must export an async factory that returns an object with this
shape (TypeScript-like pseudo for readability, we are in plain JS):

```
{
  kind: 'browser' | 'api' | 'mcp',
  features: Set<string>,                   // capability flags (see CAPABILITIES)

  // Session / auth
  hasSession(): Promise<boolean>,
  ensureSignedIn(): Promise<void>,

  // Project surface
  listProjects(): Promise<Project[]>,
  getProjectState(id): Promise<ProjectState>,
  getProjectIdleState(id): Promise<IdleState>,

  // Prompt / chat
  submitPrompt(id, { text, mode }): Promise<PromptResult>,
  chatLoop(id, opts): AsyncIterable<ChatEvent>,
  listActions(id): Promise<Action[]>,
  clickAction(id, actionRef): Promise<void>,

  // Errors / findings
  listRuntimeErrors(id): Promise<Error[]>,
  clickErrorAction(id, errorRef): Promise<void>,
  listFindings(id): Promise<Finding[]>,

  // Publish / domain
  publish(id, opts): Promise<PublishResult>,
  getPublishedSettings(id): Promise<PublishedSettings>,
  updateDomain(id, domainConfig): Promise<DomainResult>,

  // Verify / speed
  capturePreview(id, opts): Promise<PreviewSnapshot>,
  runLighthouse(id, opts): Promise<LighthouseResult>,

  // Lifecycle
  close(): Promise<void>
}
```

## Backends

### `browser` (v0.1+, default)

Drives Lovable through a Playwright persistent context. All methods map
onto the web-UI flows exposed in `../browser.js`. Works against every
Lovable tier, no API access required. Fails loud on UI drift.

### `api` (v0.2+ preview)

Wraps the official preview `@lovable.dev/sdk` package. It is selected in
`auto` mode only when `LOVABLE_API_KEY` or `LOVABLE_BEARER_TOKEN` is
configured and the requested capabilities are covered by the SDK-backed
adapter.

Current API-backed capability groups:

- workspaces and projects
- project creation, project state, project readiness
- prompt submission, plan mode, file attachments
- publish and published URL polling
- project/workspace knowledge
- code file listing, file reads, diffs, edit history
- MCP server/connector catalog reads and MCP server CRUD
- analytics reads
- Lovable Cloud database status/provision/query helpers

CLI commands wired to this backend today:

- `list`
- `create`
- `prompt`
- `publish`
- `knowledge`
- `status`
- `code`

API-only orchestration/artifact commands built on the same authenticated SDK
client:

- `snapshot`
- `diff`
- `runbook`

Playwright remains the fallback for visual verification, Lighthouse, UI
question cards, proposal chips, runtime error buttons, GitHub OAuth, and
domain/settings fields that the SDK does not expose yet.

### `mcp` (planned scaffold)

Placeholder for a future public, documented Lovable Model Context Protocol
transport. The scaffold intentionally refuses to construct today, so production
runs use the `browser` backend.

## Selection policy

`getBackend({ backend, features })`:

1. If `backend === 'api'` or `backend === 'mcp'` is explicitly requested,
   construct that backend. If auth or capability checks fail, throw.
2. If `backend === 'browser'` is explicitly requested, use browser.
3. If `backend === 'auto'` (default): try API when configured, then MCP when
   configured, then browser. The MCP scaffold currently refuses to construct,
   so browser remains the fallback for UI-only surfaces.

## Capability flags

See `./capabilities.js` for the canonical list. Examples:

- `prompt.submit`, `prompt.chat-loop`, `prompt.mode`
- `project.list`, `knowledge.read`, `knowledge.write`
- `publish.run`, `domain.connect`, `domain.subdomain`
- `verify.desktop`, `verify.mobile`, `speed.lighthouse`
- `git.connect`, `git.disconnect`
- `errors.list`, `errors.autofix`

Callers declare what they need via `features:` and the selector picks a
backend that covers them.
