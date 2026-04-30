# Lovable API — Endpoint-by-Endpoint Reference

> **Companion to [`lovable-api.md`](./lovable-api.md).** That document covers
> the auth model, refresh strategy, and the two API surfaces in the abstract.
> This one walks every public endpoint with method, path, headers, request
> body, response body, real example, and operational notes.
>
> Source of truth: `@lovable.dev/sdk` v0.1.5 (`dist/index.d.ts` + the
> compiled JS), supplemented by live network captures against
> `https://api.lovable.dev` and `https://lovable.dev` between 2026-04-30 and
> the date of this commit. JSON response examples are real responses,
> redacted only where account-specific (project ids are kept where they help
> understand the schema).

## Conventions

- **Base URLs**
  - Public/SDK: `https://api.lovable.dev`
  - Internal/App: `https://lovable.dev`
- **Auth header (one of)**
  - `Authorization: Bearer <firebase_id_token>`
  - `Lovable-API-Key: lov_...` (public surface only)
- **Always set `Accept: application/json`** for JSON endpoints. The SDK does
  this for you.
- **Content type for POST/PUT bodies** is `application/json` unless noted.
- **All timestamps** are ISO 8601 strings (`2026-04-30T19:32:22.200Z`).
- **All IDs** are opaque strings; sometimes UUIDs, sometimes Firebase doc
  ids, sometimes ULIDs prefixed `workspace_…`. Don't pattern-match on them.

Errors come through as `{ "type": "...", "message": "...", "details": "..." }`
with the matching HTTP status. The SDK wraps them in `ApiError(status, message, type, detail)`.

---

## Table of contents

- [User & workspaces](#user--workspaces)
  - [GET /v1/me](#get-v1me)
  - [GET /v1/workspaces](#get-v1workspaces)
  - [GET /v1/workspaces/{wsId}](#get-v1workspaceswsid)
  - [GET /v1/workspaces/{wsId}/knowledge](#getput-v1workspaceswsidknowledge)
  - [PUT /v1/workspaces/{wsId}/knowledge](#getput-v1workspaceswsidknowledge)
  - [PUT /v1/workspaces/{wsId}/folders/{folderId}/visibility](#put-v1workspaceswsidfoldersfolderidvisibility)
- [Workspace memberships (no `/v1`)](#workspace-memberships-no-v1)
  - [GET /workspaces/{wsId}/memberships](#get-workspaceswsidmemberships)
  - [POST /workspaces/{wsId}/memberships](#post-workspaceswsidmemberships)
  - [DELETE /workspaces/{wsId}/memberships/{userId}](#delete-workspaceswsidmembershipsuserid)
- [Projects](#projects)
  - [GET /v1/workspaces/{wsId}/projects](#get-v1workspaceswsidprojects)
  - [POST /v1/workspaces/{wsId}/projects](#post-v1workspaceswsidprojects)
  - [GET /v1/projects/{pid}](#get-v1projectspid)
  - [PUT /v1/projects/{pid}/visibility](#put-v1projectspidvisibility)
  - [GET /v1/projects/{pid}/knowledge](#getput-v1projectspidknowledge)
  - [PUT /v1/projects/{pid}/knowledge](#getput-v1projectspidknowledge)
- [Library & templates](#library--templates)
  - [GET /v1/workspaces/{wsId}/available-library-projects](#get-v1workspaceswsidavailable-library-projects)
  - [GET /v1/workspaces/{wsId}/available-template-projects](#get-v1workspaceswsidavailable-template-projects)
- [Messages & chat](#messages--chat)
  - [POST /v1/projects/{pid}/messages](#post-v1projectspidmessages)
  - [GET /v1/projects/{pid}/messages/{mid}](#get-v1projectspidmessagesmid)
  - [POST /v1/projects/{pid}/messages/stream (SSE)](#post-v1projectspidmessagesstream-sse)
- [Edits & git](#edits--git)
  - [GET /v1/projects/{pid}/edits](#get-v1projectspidedits)
  - [GET /v1/projects/{pid}/git/files](#get-v1projectspidgitfiles)
  - [GET /v1/projects/{pid}/git/file](#get-v1projectspidgitfile)
  - [GET /v1/projects/{pid}/git/diff](#get-v1projectspidgitdiff)
- [Files](#files)
  - [POST /v1/files/upload-url](#post-v1filesupload-url)
- [Database](#database)
  - [GET /v1/projects/{pid}/database](#get-v1projectspiddatabase)
  - [POST /v1/projects/{pid}/database/enable](#post-v1projectspiddatabaseenable)
  - [POST /v1/projects/{pid}/database/query](#post-v1projectspiddatabasequery)
  - [GET /v1/projects/{pid}/database/connection-info](#get-v1projectspiddatabaseconnection-info)
- [Deployments](#deployments)
  - [POST /v1/projects/{pid}/deployments](#post-v1projectspiddeployments)
- [Analytics](#analytics)
  - [GET /v1/projects/{pid}/analytics](#get-v1projectspidanalytics)
  - [GET /v1/projects/{pid}/analytics/trend](#get-v1projectspidanalyticstrend)
- [Remix](#remix)
  - [POST /projects/{sourceProjectId}/remix/init](#post-projectssourceprojectidremixinit)
  - [GET /projects/{sourceProjectId}/remix/progress](#get-projectssourceprojectidremixprogress)
- [MCP & connectors](#mcp--connectors)
  - [GET /v1/workspaces/{wsId}/mcp-servers](#get-v1workspaceswsidmcp-servers)
  - [POST /v1/workspaces/{wsId}/mcp-servers](#post-v1workspaceswsidmcp-servers)
  - [DELETE /v1/workspaces/{wsId}/mcp-servers/{serverId}](#delete-v1workspaceswsidmcp-serversserverid)
  - [GET /v1/workspaces/{wsId}/mcp-catalog](#get-v1workspaceswsidmcp-catalog)
  - [GET /v1/workspaces/{wsId}/connectors/standard](#get-v1workspaceswsidconnectorsstandard)
  - [GET /v1/workspaces/{wsId}/connectors/seamless](#get-v1workspaceswsidconnectorsseamless)
  - [GET /v1/workspaces/{wsId}/connectors/mcp](#get-v1workspaceswsidconnectorsmcp)
  - [GET /v1/workspaces/{wsId}/connections](#get-v1workspaceswsidconnections)
- [Developer / experimental](#developer--experimental)
  - [GET /v1/_dev/projects/{pid}/messages/{mid}/traces](#get-v1_devprojectspidmessagesmidtraces)
  - [POST /v1/_dev/projects/{pid}/reviews/replay](#post-v1_devprojectspidreviewsreplay)
- [Internal app surface (`lovable.dev/...`)](#internal-app-surface-lovabledev)

---

## User & workspaces

### `GET /v1/me`

> Identify the current user and the workspaces they have any kind of
> membership in. Cheap; safe for keep-alive checks.

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.me()` → `MeResponse` |
| **Status** | stable |

**Request**

```http
GET /v1/me HTTP/1.1
Host: api.lovable.dev
Authorization: Bearer eyJhbG…
Accept: application/json
```

**Response 200 — `MeResponse`**

```jsonc
{
  "$schema": "https://api.lovable.dev/GetMeOutputBody.json",
  "id":    "A74qCwaAzShoB9BlXP6yaLQHLsk2",
  "email": "tobias.kub@appfor.de",
  "name":  "alfridus",
  "workspaces": [
    { "id": "vRcruRG7IFrfqnhpLXR6", "name": "Tobi's Lovable", "role": "owner" },
    { "id": "workspace_01jvy7q77zeasr0p9568vfcwvq", "name": "COPPEN", "role": "owner" },
    { "id": "mjgIV612hKza0n2vqJEz", "name": "My Lovable", "role": "collaborator" },
    { "id": "jQ77Ai3JCpbQYcKkggHG", "name": "mick's Lovable", "role": "collaborator" }
  ]
}
```

The `role` field is the string form of the `MemberRole` enum:
`admin | collaborator | invited | member | none | owner | viewer`. Lovable
sometimes returns `member` even for paying owners on legacy plans; do not
make `=== "owner"` checks the only allow-list.

---

### `GET /v1/workspaces`

> Full workspace list with plan, credits, billing window, and feature flags.

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.listWorkspaces()` → `WorkspaceWithMembership[]` |
| **Status** | stable |

**Response 200 (one workspace shown, fields sorted by topic)**

```jsonc
{
  "$schema": "https://api.lovable.dev/GetWorkspacesOutputBody.json",
  "workspaces": [
    {
      "id": "workspace_01jvy7q77zeasr0p9568vfcwvq",
      "name": "COPPEN",
      "owner_id": "A74qCwaAzShoB9BlXP6yaLQHLsk2",
      "is_personal": false,
      "num_projects": 23,
      "num_seats": 5,
      "default_project_visibility": "private",
      "default_project_publish_visibility": "public",
      "mcp_enabled": true,

      // Plan + billing
      "plan": "pro_1",
      "plan_type": "monthly",
      "plan_scheduled_updated_at": "2026-03-02T19:20:16.442483Z",
      "subscription_status": "active",
      "subscription_currency": "usd",
      "payment_provider": "stripe",
      "billing_period_start_date": "2026-04-02T19:19:11Z",
      "billing_period_end_date":   "2026-05-02T19:19:11Z",

      // Credits — there are FIVE counters that all matter
      "credits_granted": 30,
      "credits_used": 0,
      "daily_credits_limit": 5,
      "daily_credits_used": 0,
      "rollover_credits_limit": 100,
      "rollover_credits_used": 67.6,
      "billing_period_credits_limit": 100,
      "billing_period_credits_used": 0,
      "topup_credits_limit": 0,
      "topup_credits_used": 0,
      "total_credits_used": 2627.6,

      // Misc
      "referral_count": 0,
      "followers_count": 0,
      "created_at": "2025-05-23T09:31:21.83851Z",
      "updated_at": "2026-04-20T02:02:32.147Z"
    }
  ]
}
```

**Credit counters cheat sheet**

| Field | Meaning |
|---|---|
| `daily_credits_*` | Free tier rate limit (e.g. 5/day on `pro_1`). |
| `billing_period_*` | Monthly plan allotment. |
| `rollover_credits_*` | Carry-over from previous periods. |
| `topup_credits_*` | One-time credits from manual purchase. |
| `total_credits_used` | Lifetime usage; never resets. |

The `membership` object on `WorkspaceWithMembership` (per the SDK's
`WorkspaceMembership` type) carries the caller's role and per-project access
overrides. Empty for personal workspaces.

---

### `GET /v1/workspaces/{wsId}`

> Single-workspace flavour of the list endpoint. Returns one
> `WorkspaceWithMembership`. Useful when you already have the id and don't
> want the entire list.

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.getWorkspace(wsId)` |
| **Status** | stable |

---

### `GET/PUT /v1/workspaces/{wsId}/knowledge`

> The "Workspace knowledge" markdown blob shown in Lovable's settings.
> `GET` returns the current content; `PUT` replaces it. There's no
> append/patch — read first, mutate locally, write back.

| | |
|---|---|
| **Auth** | required (admin or higher) |
| **SDK** | `client.getWorkspaceKnowledge(wsId)`, `client.setWorkspaceKnowledge(wsId, content)` |
| **Status** | stable |

**PUT body**

```json
{ "content": "# Workspace Knowledge\n\nWe always use Tailwind v4..." }
```

**Response 200 (`KnowledgeResponse`)**

```json
{ "content": "...", "updated_at": "2026-04-30T19:32:22.200Z" }
```

`PUT` is destructive. Use `lovagentic knowledge` (browser-backed) if you
want a guarded write that re-reads after save.

---

### `PUT /v1/workspaces/{wsId}/folders/{folderId}/visibility`

> Toggle visibility of a folder inside the workspace dashboard. Bodies that
> we've observed:

```json
{ "visibility": "private" }
```

Response is `{ "ok": true }` or similar. Folders themselves are **only
listable on the internal surface**: `GET /workspaces/{wsId}/folders` (no
`/v1`). The SDK exposes the visibility setter but not the listing — see
[Internal app surface](#internal-app-surface-lovabledev) below.

---

## Workspace memberships (no `/v1`)

These three endpoints are the one place where the "public" SDK does not use
the `/v1` prefix. Treat them as part of the public surface anyway; the SDK
calls them and they are documented in the README.

### `GET /workspaces/{wsId}/memberships`

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.listWorkspaceMembers(wsId)` |

**Response 200 — `WorkspaceMembershipResponse[]`**

```jsonc
[
  {
    "user_id": "A74qCwaAzShoB9BlXP6yaLQHLsk2",
    "username": "alfridus",
    "display_name": "Tobias Kub",
    "email": "tobias.kub@appfor.de",
    "role": "owner",
    "invited_at": null,
    "joined_at": "2025-05-23T09:31:21.838Z",
    "monthly_credit_limit": null,
    "total_credits_used": 2627.6,
    "total_credits_used_in_billing_period": 78.5,
    "project_access": { "<projectId>": { "access_level": "edit" } }
  }
]
```

### `POST /workspaces/{wsId}/memberships`

> Invite by email. Sends a Lovable invite mail and returns the pending
> membership record.

```json
{ "email": "new.colleague@example.com", "role": "member" }
```

`role` ∈ `admin | collaborator | member | viewer`. Returns the same
`WorkspaceMembershipResponse` shape with `joined_at: null` and
`invited_at: <now>`.

### `DELETE /workspaces/{wsId}/memberships/{userId}`

> Remove a member. Returns 204 No Content. Deleting yourself is forbidden
> (HTTP 400 `cannot_remove_self`).

---

## Projects

### `GET /v1/workspaces/{wsId}/projects`

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.listProjects(wsId, options?)` |

**Query parameters (all optional)**

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | `20` | Max 100. |
| `offset` | int | `0` | For pagination. Server also returns `has_more`. |
| `sort_by` | enum | `last_edited_at` | Also: `created_at`, `last_viewed_at`. |
| `sort_order` | enum | `desc` | `asc` or `desc`. |
| `user_id` | string | – | Filter to a specific creator. |
| `viewed_by_me` | bool | – | Implicit `last_viewed_at` filter. |

**Response 200 (one project shown; `total` and `has_more` are top-level)**

```jsonc
{
  "$schema": "https://api.lovable.dev/SearchWorkspaceProjectsResponse.json",
  "total": 23,
  "has_more": true,
  "projects": [
    {
      "id": "86fb9a69-c02c-4d6a-9476-001ebd3983a8",
      "workspace_id": "workspace_01jvy7q77zeasr0p9568vfcwvq",
      "user_id": "dVoVQaaIbJcsqQK1yuJ0IxHOIo13",
      "name": "coppen-kiosk-launchpad",
      "description": "Create a responsive landing page…",
      "tech_stack": "vite_react_shadcn_ts_20250728_minor",
      "visibility": "private",
      "status": "completed",
      "is_published": true,
      "is_deleted": false,
      "url": "https://coppen-kiosk-launchpad.lovable.app",
      "latest_screenshot_url": "https://screenshot2.lovable.dev/…/id-preview-…lovable.app-…png",
      "user_display_name": "Kaan",
      "user_photo_url": "https://lh3.googleusercontent.com/…",
      "is_starred": false,
      "created_by": "dVoVQaaIbJcsqQK1yuJ0IxHOIo13",
      "remix_count": 0,
      "edit_count": 141,
      "trending_score": 0.9655,
      "app_visitors_24h": 2,
      "app_visitors_7d": 17,
      "app_visitors_30d": 245,
      "exclude_from_being_read": false,
      "shared_context_admin_isolated": false,
      "created_at": "2025-10-20T10:18:32.297Z",
      "updated_at": "2026-04-10T15:36:56.504328Z",
      "last_edited_at": "2026-04-10T12:18:07Z",
      "last_viewed_at": "2026-04-10T20:20:55Z"
    }
  ]
}
```

`status` is `in_progress | completed | failed`. `visibility` is
`draft | private | public`. The `url` field is **only set after a
deployment**; it follows `https://<slug>.lovable.app`.

---

### `POST /v1/workspaces/{wsId}/projects`

> **Create a project.** This is the programmatic equivalent of "New
> project" in the dashboard.

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.createProject(wsId, options)` |

**Request — `CreateProjectOptions`**

```jsonc
{
  "description":      "Landing page for the COPPEN sales tool",   // shown in dashboard
  "initial_message": "Build a landing page with hero + 2 cards…", // first chat turn
  "files": [                                                       // optional images
    { "name": "design.png", "data": "<base64 or upload-url>", "type": "image/png" }
  ],
  "tech_stack": "vite_react_shadcn_ts",  // optional preset id
  "template_id": "tpl_…",                 // optional template
  "library_id":  "lib_…",                 // optional library
  "visibility":  "private",               // draft | private | public
  "name":        "coppen-landing"         // optional slug
}
```

The SDK accepts `FileInput` (Node) or `File` (browser) for attachments and
takes care of the multi-step upload via `/v1/files/upload-url` + presigned
PUT before sending the create call. The actual JSON body Lovable receives
references the resulting URLs, not the bytes.

**Response 200 — `ProjectResponse`** (same shape as `GET /v1/projects/{pid}`).
The new project initially has `status: "in_progress"`. Wait for it via
`client.waitForProjectReady(projectId)` or poll the project endpoint.

---

### `GET /v1/projects/{pid}`

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.getProject(pid)` |

Returns a single `ProjectResponse`. Same shape as one entry from the project
list, but always includes the latest values (idle list endpoints can lag a
few seconds).

---

### `PUT /v1/projects/{pid}/visibility`

```json
{ "visibility": "public" }
```

`visibility` ∈ `draft | private | public`. Returns
`{ "visibility": "public" }`.

---

### `GET/PUT /v1/projects/{pid}/knowledge`

Same shape as workspace knowledge. The full content is kept on the project,
so prepend the workspace knowledge in your prompts when both are relevant —
Lovable does this automatically server-side, but it's the project-knowledge
field you write to here.

---

## Library & templates

### `GET /v1/workspaces/{wsId}/available-library-projects`
### `GET /v1/workspaces/{wsId}/available-template-projects`

> "Library" projects are the workspace-private set of remixable bases.
> "Template" projects are the public Lovable-curated starters. Both return
> a list with the same fields:

```jsonc
{
  "projects": [
    {
      "id": "tpl_01jx…",
      "name": "todo-app-shadcn",
      "description": "Minimal todo app on Vite + React + shadcn",
      "preview_url": "https://…lovable.app",
      "thumbnail_url": "https://…",
      "is_published": true,
      "tech_stack": "vite_react_shadcn_ts"
    }
  ]
}
```

Use the returned `id` as `template_id` / `library_id` when calling
`POST /v1/workspaces/{wsId}/projects`.

---

## Messages & chat

### `POST /v1/projects/{pid}/messages`

> **Send a chat message / prompt.** Returns immediately with the message id
> while Lovable processes the turn asynchronously. Use
> `client.waitForResponse(pid)` or
> `GET /v1/projects/{pid}/messages/{mid}` to read the AI response.

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.chat(pid, options)` |

**Request — `ChatMessageOptions`**

```jsonc
{
  "message": "Add a dark-mode toggle to the navbar.",   // required
  "files": [                                              // optional, FileInput[]
    { "name": "screenshot.png", "data": "<bytes>", "type": "image/png" }
  ],
  "mode": "build",            // "build" | "plan"; default: project default
  "continuation": "force",    // ContinuationOverride; rare, for cache control
  "custom_model": {           // optional: route the main agent to your endpoint
    "endpoint":  "https://my-vllm.example.com/v1",
    "api_key":   "…",
    "model_name":"my-org/my-model-id"
  },
  "model": "anthropic/claude-opus-4-7", // optional model id (workspace must allow)
  "image_only_message": false,
  "metadata": {                       // free-form; surfaces in traces
    "source": "lovagentic"
  }
}
```

**Response 200 — `SendMessageResponse`**

```jsonc
{ "message_id": "msg_…", "ai_message_id": "msg_…" }
```

Both ids are present. The `ai_message_id` is the placeholder for the
upcoming AI response; you poll it with `getMessage` until it resolves.

---

### `GET /v1/projects/{pid}/messages/{mid}`

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.getMessage(pid, mid)` |

**Response 200 — `GetMessageResponse`**

```jsonc
{
  "id": "msg_…",
  "project_id": "86fb9a69-…",
  "role": "user" | "assistant" | "system",
  "kind": "message" | "response",
  "status": "pending" | "running" | "completed" | "failed",
  "content": "…",          // markdown text from the assistant
  "files": [],              // attachments echoed back
  "preview_url": "https://…lovable.app",  // present on completed AI responses
  "created_at": "…",
  "completed_at": "…",
  "error": null
}
```

**Polling pattern.** SDK convenience:
`client.waitForMessageCompletion(pid, mid, { pollInterval, timeout, onProgress })`
or `client.waitForResponse(pid)` to wait for the *next* assistant message.

---

### `POST /v1/projects/{pid}/messages/stream` (SSE)

> Server-Sent Events stream that the dashboard uses for live chat updates.
> Same body shape as `POST /messages`. Reads `text/event-stream` with frames
> like:

```
event: message_chunk
data: {"id":"msg_…","delta":"…token text…"}

event: message_done
data: {"id":"msg_…","preview_url":"https://…"}
```

The SDK does **not** expose this directly today (`consumeSSEStream` is
private). Use `chat()` + `waitForResponse()` for the supported pattern.

---

## Edits & git

Lovable maintains a real Git repo per project (you can also connect it to
GitHub). These endpoints expose that history without requiring the GitHub
integration to be set up.

### `GET /v1/projects/{pid}/edits`

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.listEdits(pid, params?)` |

Optional query params: `limit`, `offset`, `since` (ISO timestamp).

```jsonc
{
  "edits": [
    {
      "id": "edit_…",
      "message_id": "msg_…",         // chat turn that produced this edit
      "ref": "abc123",                // git short sha
      "created_at": "2026-04-30T17:01:22Z",
      "files_changed": 4,
      "lines_added": 42,
      "lines_removed": 3,
      "summary": "Add dark mode toggle to navbar"
    }
  ],
  "has_more": false
}
```

### `GET /v1/projects/{pid}/git/files`

```http
GET /v1/projects/{pid}/git/files?ref=abc123&path=src/&limit=200
```

Returns `{ files: GitFileEntry[] }` with each entry being
`{ path, type: "file" | "dir", size?, sha? }`. Without `path`, lists from
repo root.

### `GET /v1/projects/{pid}/git/file`

```http
GET /v1/projects/{pid}/git/file?ref=abc123&path=src/pages/Index.tsx
```

Returns the raw file contents as **text/plain** (not JSON). The SDK exposes
this as `client.readFile(pid, path, ref): Promise<string>`.

### `GET /v1/projects/{pid}/git/diff`

```http
GET /v1/projects/{pid}/git/diff?ref=abc123        # diff vs parent commit
GET /v1/projects/{pid}/git/diff?from=…&to=…        # arbitrary range
GET /v1/projects/{pid}/git/diff?message_id=msg_…   # diff produced by a chat turn
```

**Response — `GitDiffResponse`**

```jsonc
{
  "from_ref": "abc123",
  "to_ref":   "def456",
  "entries": [
    {
      "path": "src/components/Navbar.tsx",
      "old_path": null,
      "kind": "modified" | "added" | "deleted" | "renamed",
      "lines_added": 12,
      "lines_removed": 1,
      "hunks": [
        {
          "header": "@@ -10,3 +10,12 @@",
          "old_start": 10, "old_lines": 3,
          "new_start": 10, "new_lines": 12,
          "lines": [
            { "kind": "context",  "text": "<header>" },
            { "kind": "removed",  "text": "  <h1>App</h1>" },
            { "kind": "added",    "text": "  <h1 className=\"dark:text-white\">App</h1>" }
          ]
        }
      ]
    }
  ]
}
```

---

## Files

### `POST /v1/files/upload-url`

> Mint a presigned URL for uploading an attachment that will be referenced
> from a follow-up `chat()` or `createProject()`.

```json
{ "filename": "design.png", "content_type": "image/png", "size": 482113 }
```

**Response — `FileUploadUrlResponse`**

```jsonc
{
  "upload_url": "https://lovable-uploads.s3.eu-north-1.amazonaws.com/…?X-Amz-Signature=…",
  "method": "PUT",
  "headers": { "content-type": "image/png" },
  "file_url": "https://lovable-uploads.s3.eu-north-1.amazonaws.com/<key>",
  "expires_in": 3600
}
```

Then `PUT` the bytes to `upload_url` with the listed headers, and pass
`file_url` back to Lovable. The SDK does this transparently when you give
it a `FileInput`.

---

## Database

Each Lovable project can have its own managed Postgres-compatible database
("Lovable Cloud"). These endpoints provision and query it. Available only
on plans that include backend hosting.

### `GET /v1/projects/{pid}/database`

```jsonc
{
  "is_enabled": true,
  "status": "active",
  "region": "eu-central",
  "size_bytes": 1842716,
  "tables": 5
}
```

### `POST /v1/projects/{pid}/database/enable`

Empty body. Returns:

```jsonc
{ "status": "provisioning", "estimated_seconds": 60 }
```

Idempotent: a second call against an enabled DB returns
`{ "status": "active" }` without re-provisioning.

### `POST /v1/projects/{pid}/database/query`

```json
{ "sql": "select count(*) from users" }
```

**Response — `DatabaseQueryResult`**

```jsonc
{
  "columns": ["count"],
  "rows": [[42]],
  "row_count": 1,
  "duration_ms": 7
}
```

Read/write SQL is supported. There is no parameter-binding interface; quote
your inputs server-side or build the SQL safely client-side.

### `GET /v1/projects/{pid}/database/connection-info`

```jsonc
{
  "host": "ep-…-eu-central-1.aws.lovable-cloud.dev",
  "port": 5432,
  "database": "lovable",
  "username": "lovable_…",
  "password": "lovbe_…",
  "ssl_required": true,
  "connection_string": "postgres://lovable_…:lovbe_…@ep-…/lovable?sslmode=require"
}
```

Treat the response like a vault entry. Lovable rotates credentials when you
press "Reset" in the UI; there's no rotate endpoint on the API yet.

---

## Deployments

### `POST /v1/projects/{pid}/deployments`

> **Publish a project.** Equivalent of clicking "Publish" in the dashboard.
> Returns immediately with a deployment id while the deploy runs
> asynchronously.

| | |
|---|---|
| **Auth** | required |
| **SDK** | `client.publish(pid, { name? })` |

**Request body**

```jsonc
{ "name": "coppen-kiosk-launchpad" }   // optional custom slug
```

If `name` is omitted, Lovable picks a slug derived from the project name.
Slug must be DNS-safe (lowercase letters, digits, hyphens).

**Response 200 — `DeploymentResponse`**

```jsonc
{
  "deployment_id": "dep_…",
  "status": "queued" | "in_progress" | "succeeded" | "failed",
  "url": null,           // becomes "https://<slug>.lovable.app" once succeeded
  "started_at": "…"
}
```

Wait for completion with `client.waitForProjectPublished(pid)`; it polls
`GET /v1/projects/{pid}` and returns once `is_published: true` and `url` is
set.

---

## Analytics

> Plausible-style page-view analytics for **published** projects. Both
> endpoints 404 on draft / unpublished projects.

### `GET /v1/projects/{pid}/analytics`

```http
GET /v1/projects/{pid}/analytics?start_date=2026-04-01&end_date=2026-04-30&granularity=day
```

`granularity` ∈ `hour | day | week | month`.

**Response — `ProjectAnalyticsResponse`**

```jsonc
{
  "summary": {
    "visitors": 245,
    "pageviews": 612,
    "bounce_rate": 0.42,
    "avg_visit_duration_seconds": 84
  },
  "time_series": {
    "metric": "visitors",
    "granularity": "day",
    "points": [
      { "ts": "2026-04-01", "value": 12 },
      { "ts": "2026-04-02", "value": 8 }
    ]
  },
  "top_pages": {
    "metric": "pageviews",
    "items": [
      { "label": "/",       "value": 410 },
      { "label": "/pricing", "value": 142 }
    ]
  },
  "top_sources": {
    "metric": "visitors",
    "items": [
      { "label": "google.com", "value": 92 },
      { "label": "Direct",     "value": 51 }
    ]
  },
  "top_devices":   { /* same shape */ },
  "top_countries": { /* same shape */ }
}
```

### `GET /v1/projects/{pid}/analytics/trend`

> Realtime-ish 30-minute trend used by the dashboard sparkline.

```jsonc
{
  "current_visitors": 4,
  "trend_30min": [
    { "ts": "2026-04-30T19:00:00Z", "value": 0 },
    { "ts": "2026-04-30T19:01:00Z", "value": 1 }
  ]
}
```

---

## Remix

Remixing forks an existing project. The interesting bit is that the source
project endpoint owns the job lifecycle, even though the result is a brand
new project under the *target* workspace.

### `POST /projects/{sourceProjectId}/remix/init`

> Note the missing `/v1` prefix.

```jsonc
{
  "workspace_id": "workspace_…",        // target workspace
  "message_id": "msg_…",                 // optional snapshot point
  "remix_mode": "before",                // "before" | "including"
  "include_history": true,
  "include_custom_knowledge": true,
  "include_agent_state": true,           // requires the two above + API-key auth
  "skip_initial_remix_message": false,
  "skip_integrations": false,
  "initial_message": "Add dark mode"     // optional first chat turn
}
```

**Response — `RemixInitResponse`**

```jsonc
{ "job_id": "job_…" }
```

### `GET /projects/{sourceProjectId}/remix/progress?job_id=…`

Poll until `status` is `completed` or `error`.

```jsonc
{
  "status": "preparing" | "running" | "completed" | "error" | "unknown",
  "step":  { "code": "creating_new_project", "message": "Creating project…" },
  "project_id": "abc-…"   // only present when status == "completed"
}
```

The SDK wraps this loop in `client.waitForRemix(sourceProjectId, jobId)`.

---

## MCP & connectors

Lovable supports four flavours of integration:

1. **Standard connectors** — first-party integrations (Stripe, HubSpot,
   etc.). Set up in the workspace once, used in any project.
2. **Seamless connectors** — auto-installed integrations driven by AI
   intent (think "you mentioned email, so I configured Resend for you").
3. **MCP connectors** — workspace-installed MCP servers presented to the
   project's chat agent.
4. **External MCP servers** — bring-your-own MCP, registered per workspace.

Plus **connections**: authenticated accounts attached to a connector
(e.g. one Slack workspace).

### `GET /v1/workspaces/{wsId}/mcp-servers`

```jsonc
{
  "servers": [
    {
      "id": "mcp_…",
      "name": "Internal Notion",
      "url":  "https://notion-mcp.example.com",
      "auth_kind": "header" | "oauth" | "none",
      "headers":  { "Authorization": "Bearer …" },
      "created_at": "…"
    }
  ]
}
```

### `POST /v1/workspaces/{wsId}/mcp-servers`

```jsonc
{
  "name": "Internal Notion",
  "url":  "https://notion-mcp.example.com",
  "auth_kind": "header",
  "headers":  { "Authorization": "Bearer …" },
  "description": "Read-only Notion bridge"
}
```

Returns the created `MCPServerResponse`.

### `DELETE /v1/workspaces/{wsId}/mcp-servers/{serverId}`

Returns `{ "ok": true }`.

### `GET /v1/workspaces/{wsId}/mcp-catalog`

```jsonc
{
  "entries": [
    {
      "id": "catalog_…",
      "name": "Linear",
      "logo_url": "https://…",
      "description": "Issue tracking",
      "homepage": "https://linear.app",
      "default_install": { "url": "https://mcp.linear.app", "auth_kind": "oauth" }
    }
  ]
}
```

This is Lovable's **curated** MCP catalog (installable in one click). Don't
confuse with `mcp-servers` (your own).

### `GET /v1/workspaces/{wsId}/connectors/standard`

```jsonc
{
  "connectors": [
    {
      "id": "stripe",
      "name": "Stripe",
      "description": "Payments",
      "logo_url": "https://…",
      "auth_kind": "oauth" | "apikey",
      "is_installed": true
    }
  ]
}
```

### `GET /v1/workspaces/{wsId}/connectors/seamless`

Same shape as standard. The SDK distinguishes `is_seamless: true`.

### `GET /v1/workspaces/{wsId}/connectors/mcp`

```jsonc
{
  "connectors": [
    {
      "id": "linear",
      "name": "Linear",
      "kind": "catalog" | "custom",
      "is_installed": true,
      "server": { /* MCPServerResponse if installed */ }
    }
  ],
  "custom_enabled": true
}
```

`custom_enabled: false` means the workspace plan does not allow custom MCP
servers — only catalog ones.

### `GET /v1/workspaces/{wsId}/connections`

```http
GET /v1/workspaces/{wsId}/connections?connector_id=stripe
```

```jsonc
{
  "connections": [
    {
      "id": "conn_…",
      "connector_id": "stripe",
      "account_label": "Acme Inc.",
      "user_id": "A74…",
      "created_at": "…",
      "scopes": ["read_charges", "write_invoices"]
    }
  ]
}
```

---

## Developer / experimental

Routes under `/v1/_dev/...` are intentionally unstable. Lovable uses them
for internal observability tooling. The SDK exposes them under
`client._dev.*`, with the explicit warning that they may break without
notice. Don't build production flows on these.

### `GET /v1/_dev/projects/{pid}/messages/{mid}/traces`

> Pulls the **Braintrust trace tree** for a chat message. Lovable's agent
> uses Braintrust as its eval/trace store; the API surfaces the same span
> data you'd see in their UI.

```http
GET /v1/_dev/projects/{pid}/messages/{mid}/traces?purposes=main_agent,knowledge_rag
```

`purposes` ∈ `main_agent | codebase_rag | knowledge_rag | review`. Multiple
values are comma-separated. When a purpose has multiple spans (e.g.
multi-turn `main_agent`), only the **last** span is returned.

**Response — `MessageTracesResponse`**

```jsonc
{
  "message_id": "msg_…",
  "braintrust_span_id": "spn_…",
  "root_span_id": "spn_root_…",
  "spans": [
    {
      "id": "spn_…",
      "purpose": "main_agent",
      "name": "claude-opus-4-7@build",
      "started_at": "…",
      "duration_ms": 18742,
      "input": { /* prompt context */ },
      "output": { /* assistant content */ },
      "metadata": { "model_id": "anthropic/claude-opus-4-7", "cache_hit": true },
      "children": [ { /* recursive */ } ]
    }
  ]
}
```

### `POST /v1/_dev/projects/{pid}/reviews/replay`

> Re-run the project's reviewer set (`project_success_v3`, `user_sentiment`,
> etc.) against past assistant messages. Requires API-key auth (Bearer
> tokens are rejected here).

```jsonc
{
  "items": [
    { "response_message_id": "msg_…", "reviewer_types": ["project_success_v3"] }
  ],
  "reviewer_types": ["project_success_v3", "user_sentiment"], // global default
  "concurrency": 4
}
```

Response is a `ReplayReviewsResponse` with per-item outcomes; failed items
sit alongside successful ones rather than aborting the batch.

---

## Internal app surface (`lovable.dev/...`)

These are the endpoints the dashboard JS itself consumes. They use the same
Firebase Bearer token, but the SDK does not wrap them and Lovable can
change shape without warning. Use only when the public `/v1` surface does
not cover the feature you need.

| Method | Path | Purpose |
|---:|---|---|
| POST | `/api/auth/session-v2` | Refresh the dashboard's own session cookie. |
| GET  | `/consent/policy` | Current consent banner text + version. |
| GET  | `/surveys/active` | NPS / feature surveys to show in-app. |
| GET  | `/profile/{slug}` | Public profile page data. |
| GET  | `/permissions?workspaceId=<wsId>` | Caller's effective permission map (per workspace). |
| GET  | `/v2/user/projects/starred` | Starred projects across workspaces. |
| GET  | `/v2/user/projects/shared` | Projects shared with the user (any workspace). |
| GET  | `/user/workspace-invitations` | Pending invitations for the user. |
| GET  | `/user/projects/shared` | Legacy shared-projects route. Same shape as v2 minus pagination. |
| GET  | `/workspaces/{wsId}/projects/search?...` | Richer project search than `/v1/.../projects` (server-side text search, faceted filters). |
| GET  | `/workspaces/{wsId}/memberships/search?status=active&limit=...` | Member search with status filters; used by the dashboard's people pane. |
| GET  | `/workspaces/{wsId}/folders` | List folders inside a workspace dashboard. |
| GET  | `/workspaces/{wsId}/registrar-domains/viewer-verification-banner` | Should the registrar-domain banner be shown? |
| GET  | `/workspaces/{wsId}/registrar-domains/campaign-eligibility` | Whether the workspace qualifies for the cheap-domain campaign. |
| GET  | `/workspaces/{wsId}/project-access-requests` | "Request access" inbox at the project level. |
| GET  | `/workspaces/{wsId}/workspace-access-requests` | Same, at the workspace level. |

If you find yourself reaching for these routinely, file a feature request
upstream — they exist on the SDK roadmap.

---

## Appendix A: full TypeScript-style type catalogue

The shapes used by the public API. Adapted from the SDK
`dist/index.d.ts`. Field optionality matches the SDK; the `?` markers are
not always honored on the wire (the API sometimes returns `null` instead of
omitting), so prefer `value ?? fallback` over `value !== undefined`.

```ts
type ProjectVisibility = "draft" | "private" | "public";
type MemberRole = "admin" | "collaborator" | "invited" | "member" | "none" | "owner" | "viewer";
type ProjectStatus = "completed" | "in_progress" | "failed";
type ContinuationOverride = "force" | "fresh_build" | "allow_expired_cache";
type RemixMode = "before" | "including";
type RemixJobStatus = "unknown" | "preparing" | "running" | "completed" | "error";
type RemixJobStep = "starting" | "creating_new_project" | "remixing_integration" | "finalizing" | "completed";
type TracePurpose = "main_agent" | "codebase_rag" | "knowledge_rag" | "review";

interface MeWorkspace { id: string; name: string; role: string; }
interface MeResponse  { id: string; email: string; name: string; workspaces: MeWorkspace[]; }

interface WorkspaceMembership {
  email: string;
  invited_at?: string;
  joined_at?: string;
  monthly_credit_limit: number | null;
  project_access?: Record<string, { access_level?: string }>;
  role: MemberRole;
  user_id: string;
  workspace_id: string;
}

interface WorkspaceWithMembership {
  id: string;
  name: string;
  description?: string;
  image_url?: string;
  owner_id?: string;
  is_personal?: boolean;
  plan?: string;
  plan_type?: string;
  num_projects: number;
  num_seats?: number;
  membership: WorkspaceMembership;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
  credits_granted: number;
  credits_used: number;
  daily_credits_limit: number;
  daily_credits_used: number;
  billing_period_credits_limit: number;
  billing_period_credits_used: number;
  billing_period_start_date?: string;
  billing_period_end_date?: string;
  rollover_credits_limit: number;
  rollover_credits_used: number;
  topup_credits_limit: number;
  topup_credits_used: number;
  total_credits_used: number;
  subscription_status?: "active" | "canceled" | "incomplete_expired" | "incomplete" | "past_due" | "paused" | "trialing" | "unpaid";
  referral_code?: string;
  short_referral_code?: string;
  referral_count: number;
  followers_count: number;
  default_project_visibility?: ProjectVisibility;
  default_project_publish_visibility?: "private" | "public";
  mcp_enabled?: boolean;
}

interface ProjectResponse {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  description?: string;
  tech_stack?: string;
  visibility: ProjectVisibility;
  status: ProjectStatus;
  is_published: boolean;
  is_deleted: boolean;
  url?: string | null;
  latest_screenshot_url?: string | null;
  created_at: string;
  updated_at: string;
  last_edited_at?: string;
  last_viewed_at?: string;
  edit_count?: number;
  user_display_name?: string;
  user_photo_url?: string;
  is_starred?: boolean;
  remix_count?: number;
  trending_score?: number;
  app_visitors_24h?: number;
  app_visitors_7d?: number;
  app_visitors_30d?: number;
}

interface CreateProjectOptions {
  description?: string;
  initial_message?: string;
  files?: FileInput[] | File[];
  tech_stack?: string;
  template_id?: string;
  library_id?: string;
  visibility?: ProjectVisibility;
  name?: string;
}

interface FileInput { name: string; data: Blob | ArrayBuffer | Uint8Array; type: string; }

interface ChatMessageOptions {
  message: string;
  files?: FileInput[] | File[];
  mode?: "build" | "plan";
  continuation?: ContinuationOverride;
  custom_model?: CustomModelConfig;
  model?: string;
  image_only_message?: boolean;
  metadata?: Record<string, unknown>;
}

interface CustomModelConfig { endpoint: string; api_key: string; model_name: string; }

interface SendMessageResponse { message_id: string; ai_message_id: string; }

interface GetMessageResponse {
  id: string;
  project_id: string;
  role: "user" | "assistant" | "system";
  kind: "message" | "response";
  status: "pending" | "running" | "completed" | "failed";
  content: string;
  files: FileInput[];
  preview_url?: string | null;
  created_at: string;
  completed_at?: string | null;
  error?: string | null;
}

interface DeploymentResponse {
  deployment_id: string;
  status: "queued" | "in_progress" | "succeeded" | "failed";
  url?: string | null;
  started_at: string;
}

interface DiffLine { kind: "context" | "added" | "removed"; text: string; }
interface DiffHunk { header: string; old_start: number; old_lines: number; new_start: number; new_lines: number; lines: DiffLine[]; }
interface DiffEntry { path: string; old_path: string | null; kind: "modified" | "added" | "deleted" | "renamed"; lines_added: number; lines_removed: number; hunks: DiffHunk[]; }
interface GitDiffResponse { from_ref: string; to_ref: string; entries: DiffEntry[]; }

interface KnowledgeResponse  { content: string; updated_at: string; }
interface FileUploadUrlResponse {
  upload_url: string;
  method: "PUT";
  headers: Record<string, string>;
  file_url: string;
  expires_in: number;
}

interface DatabaseStatus { is_enabled: boolean; status: string; region?: string; size_bytes?: number; tables?: number; }
interface DatabaseQueryResult { columns: string[]; rows: unknown[][]; row_count: number; duration_ms: number; }
interface DatabaseConnectionInfo {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl_required: boolean;
  connection_string: string;
}

interface ProjectAnalyticsResponse { /* see Analytics section above */ }
interface ProjectAnalyticsTrendResponse { current_visitors: number; trend_30min: { ts: string; value: number }[]; }

interface MCPServerResponse {
  id: string; name: string; url: string;
  auth_kind: "header" | "oauth" | "none";
  headers?: Record<string, string>;
  description?: string;
  created_at: string;
}

interface MCPCatalogEntry { id: string; name: string; description?: string; logo_url?: string; homepage?: string; default_install?: { url: string; auth_kind: string }; }

interface RemixProjectOptions {
  workspaceId: string;
  messageId?: string;
  remixMode?: RemixMode;
  includeHistory?: boolean;
  includeCustomKnowledge?: boolean;
  includeAgentState?: boolean;
  initialMessage?: string;
  skipInitialRemixMessage?: boolean;
  skipIntegrations?: boolean;
}

interface TraceSpan {
  id: string;
  purpose: TracePurpose;
  name: string;
  started_at: string;
  duration_ms: number;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  children?: TraceSpan[];
}

interface MessageTracesResponse { message_id: string; braintrust_span_id: string; root_span_id: string; spans: TraceSpan[]; }
```

---

## Appendix B: end-to-end recipes

### B.1 Send a prompt and wait for the AI response

```ts
import { LovableClient } from "@lovable.dev/sdk";

const client = new LovableClient({ bearerToken: process.env.LOVABLE_BEARER_TOKEN! });
const { ai_message_id } = await client.chat(projectId, { message: "Add a footer." });
const completion = await client.waitForMessageCompletion(projectId, ai_message_id, {
  pollInterval: 1500,
  timeout: 5 * 60 * 1000,
  onProgress: (status) => console.log("turn:", status),
});
console.log("Preview URL:", completion.preview_url);
```

### B.2 Pure curl: send a prompt, poll for completion

```bash
source ~/.lovagentic/lovable.env
PID=86fb9a69-c02c-4d6a-9476-001ebd3983a8
RESP=$(curl -sX POST \
  -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Add a footer."}' \
  "https://api.lovable.dev/v1/projects/$PID/messages")
MID=$(echo "$RESP" | jq -r .ai_message_id)

while :; do
  STATUS=$(curl -s -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
    "https://api.lovable.dev/v1/projects/$PID/messages/$MID" | jq -r .status)
  echo "$(date +%T)  $STATUS"
  [[ "$STATUS" == "completed" || "$STATUS" == "failed" ]] && break
  sleep 2
done
```

### B.3 Snapshot a project (read-only)

```bash
lovagentic snapshot https://lovable.dev/projects/$PID --json > snapshot.json
```

…or directly via API:

```bash
curl -s -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  "https://api.lovable.dev/v1/projects/$PID" > project.json
curl -s -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  "https://api.lovable.dev/v1/projects/$PID/git/files?ref=HEAD" > files.json
curl -s -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  "https://api.lovable.dev/v1/projects/$PID/edits?limit=10" > edits.json
```

### B.4 Publish + verify

```bash
DEP=$(curl -sX POST \
  -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "https://api.lovable.dev/v1/projects/$PID/deployments")
DEP_ID=$(echo "$DEP" | jq -r .deployment_id)

while :; do
  J=$(curl -s -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
       "https://api.lovable.dev/v1/projects/$PID")
  PUB=$(echo "$J" | jq -r .is_published)
  URL=$(echo "$J" | jq -r .url)
  [[ "$PUB" == "true" && "$URL" != "null" ]] && { echo "Live: $URL"; break; }
  sleep 3
done
```

### B.5 Run SQL against the project DB

```bash
curl -sX POST \
  -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql":"select count(*) from public.users;"}' \
  "https://api.lovable.dev/v1/projects/$PID/database/query" | jq
```

### B.6 Remix at a checkpoint

```ts
const jobId = await client.remixProject(sourceProjectId, {
  workspaceId: targetWsId,
  messageId: lastGoodMessageId,
  remixMode: "before",
  includeHistory: true,
  includeCustomKnowledge: true,
  includeAgentState: true,
});
const { projectId } = await client.waitForRemix(sourceProjectId, jobId, {
  pollInterval: 2000,
  onProgress: (status, step) => console.log(status, step),
});
console.log("New project:", projectId);
```

---

## Appendix C: undocumented quirks worth knowing

- **`workspaces[].role` shape mismatch.** `MeResponse.workspaces[].role` is
  typed as a free-form `string`, but in production it always matches
  `MemberRole`. Treat as the enum.
- **404 vs 403 on private projects.** Visibility-private projects return
  `404` (not `403`) to non-members. Don't try to distinguish "doesn't
  exist" vs "no access" from the response code alone.
- **Slug uniqueness across workspaces.** Two different workspaces cannot
  publish under the same `lovable.app` slug. If your `name` is taken,
  `POST /deployments` returns `409 conflict`.
- **Rate limits.** No documented limits, but observed soft limits at
  ~30 req/s per token. Bursts above that get `429 Retry-After: <seconds>`.
- **Streaming endpoint timeouts.** `/messages/stream` connections idle out
  at ~60s when the model is thinking; reconnect transparently.
- **Knowledge "diffs".** There is no diff endpoint for knowledge changes —
  Lovable just stores the latest revision. Snapshot before mutating if you
  need rollback.
- **MCP server URLs are checked at install time only.** A subsequent
  network failure does not deactivate the server; it just produces tool
  errors in the agent's traces.
- **`include_agent_state: true` requires API-key auth** for remix. Bearer
  tokens are accepted for the rest of the remix flow.
- **`/v1/_dev/...` endpoints require an API key.** A Firebase Bearer token
  is rejected with `403 dev_api_key_required`.

---

_Last verified against production: 2026-04-30._
