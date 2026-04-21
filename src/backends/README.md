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
  kind: 'browser' | 'mcp',
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

### `mcp` (planned scaffold)

Placeholder for a future public, documented Lovable Model Context Protocol
transport. The scaffold intentionally refuses to construct today, so production
runs use the `browser` backend.

## Selection policy

`getBackend({ backend, features })`:

1. If `backend === 'mcp'` is explicitly requested, try MCP. If
   capability check fails, throw (no silent fallback).
2. If `backend === 'browser'` is explicitly requested, use browser.
3. If `backend === 'auto'` (default): try MCP only when configured. Since the
   current MCP backend is a scaffold, normal runs fall back to browser.

## Capability flags

See `./capabilities.js` for the canonical list. Examples:

- `prompt.submit`, `prompt.chat-loop`, `prompt.mode`
- `project.list`, `project.knowledge.read`, `project.knowledge.write`
- `publish.run`, `publish.custom-domain`
- `verify.desktop`, `verify.mobile`, `speed.lighthouse`
- `git.connect`, `git.disconnect`
- `errors.list`, `errors.auto-fix`

Callers declare what they need via `features:` and the selector picks a
backend that covers them.
