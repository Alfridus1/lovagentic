# The Lovable API — Complete Reference

> Status: working notes. Built from reverse-engineered network traffic, the
> public `@lovable.dev/sdk` package, and live experiments against the
> production API. Lovable does not (yet) publish a full REST reference, so
> assume any endpoint marked _internal_ may change without notice.

This document is a deep-dive that complements `lovagentic`'s `auth` and `api`
commands. If you only want to use the CLI, jump to
[Operating with `lovagentic`](#operating-with-lovagentic). If you want to call
the API yourself, read the whole thing.

---

## TL;DR

- **Auth.** Lovable uses **Firebase Identity Platform** in the Google Cloud
  project `gpt-engineer-390607`. Every authenticated request carries a
  short-lived (1 hour) Firebase ID token (a signed JWT) as
  `Authorization: Bearer <id_token>`.
- **Two HTTP surfaces.**
  1. `https://api.lovable.dev/v1/...` — the **public, SDK-shaped API**.
     Stable, versioned, documented through the
     [`@lovable.dev/sdk`](https://www.npmjs.com/package/@lovable.dev/sdk) npm
     package. Accepts both Firebase Bearer tokens and `lov_…`-prefixed API
     keys.
  2. `https://lovable.dev/...` — the **internal Web/App API** the dashboard
     itself uses (`/v2/user/projects`, `/workspaces/<id>/...`,
     `/permissions`, `/profile/<slug>`, `/registrar-domains/...`). Only
     accepts Firebase Bearer tokens.
- **Two ways to authenticate.**
  - **`lov_...` API key** (Lovable-issued, long-lived, `Lovable-API-Key:` header).
    Officially in preview; UI to mint one is currently gated.
  - **Firebase Bearer token** with refresh-token rotation. Anyone who can sign
    into Lovable can self-serve this, no UI buttons needed. This is what
    `lovagentic auth bootstrap` automates.
- **Refresh.** Trade a long-lived Firebase refresh token for a new ID token
  via Google's public `securetoken.googleapis.com` endpoint. Pure HTTPS,
  no browser needed, costs nothing.

---

## Authentication architecture

```
┌──────────────────────────┐                          ┌────────────────────────────┐
│  lovable.dev (Web/App)   │  ── login (OAuth) ─────► │ Firebase Identity Platform │
└──────────────────────────┘                          │ project=gpt-engineer-390607│
            │                                         └─────────────┬──────────────┘
            │                                                       │
            │  IndexedDB: firebaseLocalStorageDb                    │ securetoken
            │  key: firebase:authUser:<apiKey>:[DEFAULT]            │ POST  /v1/token
            │  value.stsTokenManager:                               │ grant_type=
            │    accessToken (id_token, 1h, JWT RS256)              │   refresh_token
            │    refreshToken (long-lived)                          │
            │    expirationTime (epoch ms)                          │
            ▼                                                       │
   Authorization: Bearer <id_token>  ─────────────────────────►     │
                                                                    │
                                                                    ▼
                                                       returns fresh id_token
                                                       (and possibly rotated refresh_token)
```

### The Firebase project

Decode any Lovable Bearer JWT (e.g. with `jq -R 'split(".")[1] | @base64d'`)
and you'll see:

```jsonc
{
  "iss":  "https://securetoken.google.com/gpt-engineer-390607",
  "aud":  "gpt-engineer-390607",          // <-- Firebase project id
  "iat":  1777574864,
  "exp":  1777578464,                     // exp - iat = 3600s = 1 hour
  "user_id": "A74qCwaAzShoB9BlXP6yaLQHLsk2",
  "email":   "you@example.com",
  "email_verified": true,
  "firebase": {
    "identities": { "github.com": ["..."], "email": ["..."] },
    "sign_in_provider": "custom"
  },
  "source_sign_in_provider": "github.com" // also "google.com", "password", ...
}
```

The Firebase **Web API key** (`AIzaSy…`) is a public client identifier, not a
secret. Anyone signed into the app can read it from IndexedDB; it is also
embedded in the static JS bundle. We've observed
`AIzaSyBQNjlw9Vp4tP4VVeANzyPJnqbG2wLbYPw` in production. Treat it like a
public OAuth client id, not a credential.

### Where the tokens live in the browser

After login, Firebase JS persists the auth state in **IndexedDB** under the
database `firebaseLocalStorageDb`, object store `firebaseLocalStorage`, with
key `firebase:authUser:<firebaseApiKey>:[DEFAULT]`. The interesting fields:

- `value.stsTokenManager.accessToken` — current ID token (Bearer)
- `value.stsTokenManager.refreshToken` — long-lived refresh token
- `value.stsTokenManager.expirationTime` — epoch ms when the access token expires
- `value.uid` — Firebase user id (same as JWT `user_id`)
- `value.email` — sign-in email

Cookies (`lovable-auth`, `lovable-session-id-v2`) carry a separate
session id used by `lovable.dev` itself; they are **not** the Bearer token.

### Refreshing without a browser

Once you have a refresh token + the Firebase Web API key, you can mint fresh
ID tokens forever — no Playwright, no cookies, no headless Chrome:

```bash
curl -sX POST \
  "https://securetoken.googleapis.com/v1/token?key=$LOVABLE_FIREBASE_API_KEY" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=$LOVABLE_REFRESH_TOKEN"
```

Response (fields renamed in our store to camelCase for sanity):

```jsonc
{
  "access_token":  "eyJhbGciOiJSUzI1NiIs…",   // = id_token, the Bearer
  "expires_in":    "3600",
  "token_type":    "Bearer",
  "refresh_token": "AMf-vB…",                 // sometimes rotated
  "id_token":      "eyJhbGciOiJSUzI1NiIs…",   // identical to access_token
  "user_id":       "A74qCwaAzShoB9BlXP6yaLQHLsk2",
  "project_id":    "288002387414"             // GCP project number
}
```

Refresh tokens **survive password changes and sign-outs from other devices**
in Firebase, but Lovable can revoke them server-side at any time. Treat the
refresh token like a password.

### What about `lov_…` API keys?

The `@lovable.dev/sdk` README documents a stable `apiKey: "lov_..."`
construction. Our reading of the production SDK shows it sends
`Lovable-API-Key: lov_…` instead of `Authorization: Bearer …`. As of writing
(April 2026), the issuance UI for these keys is not yet generally available
in the Workspace settings; the SDK's `LovableClient` already accepts them.

When Lovable opens that flap, swap your Bearer-based env file for an
`lov_…`-keyed one — no other code changes required. `lovagentic` already
prefers `LOVABLE_API_KEY` over `LOVABLE_BEARER_TOKEN` over the cached
refresh.

---

## API surfaces and endpoints

### Surface 1: `https://api.lovable.dev/v1/*` (public, SDK)

Authentication:

```
Authorization:    Bearer <firebase_id_token>
              -- or --
Lovable-API-Key:  lov_...
```

(Pick exactly one — sending both is rejected by the SDK constructor.)

Endpoints we have reproduced from the v0.1.7 SDK:

| Method | Path                                                                                 | Purpose                                      |
|-------:|--------------------------------------------------------------------------------------|----------------------------------------------|
| GET    | `/v1/me`                                                                             | Current user + visible workspaces.           |
| GET    | `/v1/workspaces`                                                                     | Full workspace list with plan/credits info.  |
| GET    | `/v1/workspaces/{wsId}`                                                              | Workspace details.                           |
| GET    | `/v1/workspaces/{wsId}/projects`                                                     | List projects in a workspace.                |
| POST   | `/v1/workspaces/{wsId}/projects`                                                     | Create a new project (`description`, `initialMessage`, optional images). |
| GET    | `/v1/workspaces/{wsId}/available-library-projects`                                   | Library entries usable as bases.             |
| GET    | `/v1/workspaces/{wsId}/available-template-projects`                                  | Template projects.                           |
| GET    | `/v1/workspaces/{wsId}/connections`                                                  | Outbound integrations attached to the workspace. |
| GET/POST | `/v1/workspaces/{wsId}/connectors`                                                  | Workspace connectors, including custom MCP servers. |
| DELETE | `/v1/workspaces/{wsId}/connectors/{connectorId}`                                     | Remove an installed connector.               |
| GET    | `/v1/workspaces/{wsId}/available-connectors`                                         | Public connector catalog visible from the workspace. |
| GET    | `/v1/workspaces/{wsId}/connectors/{kind}`                                            | `kind ∈ {mcp, seamless, standard}`.          |
| GET/PUT| `/v1/workspaces/{wsId}/knowledge`                                                    | Workspace-wide knowledge content.            |
| PUT    | `/v1/workspaces/{wsId}/folders/{folderId}/visibility`                                | Folder visibility toggle.                    |
| GET    | `/v1/projects/{pid}`                                                                 | Project details (status, preview/live URLs, etc.). |
| PUT    | `/v1/projects/{pid}/visibility`                                                      | Public/private toggle.                       |
| GET    | `/v1/projects/{pid}/messages`                                                        | Chat history.                                |
| POST   | `/v1/projects/{pid}/messages`                                                        | **Send a chat message / prompt.**            |
| GET    | `/v1/projects/{pid}/messages/{mid}`                                                  | Single message details.                      |
| (SSE)  | `/v1/projects/{pid}/messages/stream`                                                 | Streaming endpoint used while a turn is in flight. |
| GET    | `/v1/projects/{pid}/edits`                                                           | Edit history (commits).                      |
| GET    | `/v1/projects/{pid}/git/diff?...`                                                    | Diff for a message/commit/range.             |
| GET    | `/v1/projects/{pid}/git/files?...`                                                   | List files in the project repo.              |
| GET    | `/v1/projects/{pid}/git/file?...`                                                    | Read a single file (returns text).           |
| GET    | `/v1/projects/{pid}/database`                                                        | Database state.                              |
| POST   | `/v1/projects/{pid}/database/enable`                                                 | Provision the project DB.                    |
| POST   | `/v1/projects/{pid}/database/query`                                                  | Run a SQL query (`{ "sql": "..." }`).        |
| GET    | `/v1/projects/{pid}/database/connection-info`                                        | DB credentials/connection string for live.   |
| POST   | `/v1/projects/{pid}/deployments`                                                     | **Publish** the project (optional custom slug). |
| GET/PUT| `/v1/projects/{pid}/knowledge`                                                       | Project knowledge.                           |
| GET    | `/v1/projects/{pid}/analytics?...`                                                   | Visitor analytics.                           |
| GET    | `/v1/projects/{pid}/analytics/trend`                                                 | Trend analytics.                             |
| POST   | `/v1/files/upload-url`                                                               | Presigned upload URL for attachments.        |

Remix endpoints live under a different prefix (no `/v1`):

| Method | Path                                                       | Purpose                                          |
|-------:|------------------------------------------------------------|--------------------------------------------------|
| POST   | `/projects/{sourceProjectId}/remix/init`                   | Start a remix job.                               |
| GET    | `/projects/{sourceProjectId}/remix/progress?job_id=…`      | Poll remix progress.                             |

Workspace-membership endpoints (also no `/v1`):

| Method | Path                                              | Purpose                       |
|-------:|---------------------------------------------------|-------------------------------|
| POST   | `/workspaces/{wsId}/memberships`                  | Invite a collaborator.        |
| GET    | `/workspaces/{wsId}/memberships`                  | List members.                 |
| DELETE | `/workspaces/{wsId}/memberships/{userId}`         | Remove a member.              |

Developer/experimental endpoints (everything under `/v1/_dev/...` may change
without notice):

| Method | Path                                                                | Purpose                                  |
|-------:|---------------------------------------------------------------------|------------------------------------------|
| GET    | `/v1/_dev/projects/{pid}/messages/{mid}/traces`                     | Braintrust trace spans for a message.    |
| POST   | `/v1/_dev/projects/{pid}/reviews/replay`                            | Re-run reviewers for assistant messages. |

### Surface 2: `https://lovable.dev/...` (internal, app)

The dashboard itself talks to a richer set of endpoints that are not exposed
through `@lovable.dev/sdk`. They use the same Firebase Bearer token (the
`Lovable-API-Key:` header is **not** accepted here as far as we have
observed).

Notable routes seen in production traffic:

```
POST  /api/auth/session-v2
GET   /consent/policy
GET   /surveys/active
GET   /profile/{slug}
GET   /permissions?workspaceId=<wsId>
GET   /v2/user/projects/starred?sort_by=...
GET   /v2/user/projects/shared?sort_by=...
GET   /user/workspace-invitations
GET   /user/projects/shared
GET   /workspaces/{wsId}/projects/search?...
GET   /workspaces/{wsId}/memberships/search?status=active&limit=...
GET   /workspaces/{wsId}/folders
GET   /workspaces/{wsId}/registrar-domains/viewer-verification-banner
GET   /workspaces/{wsId}/registrar-domains/campaign-eligibility
GET   /workspaces/{wsId}/project-access-requests
GET   /workspaces/{wsId}/workspace-access-requests
```

This surface backs UI-only features (folders, surveys, registrar domain
banners, access requests, etc.). Lean on **Surface 1** for anything
production-facing; reach for Surface 2 only when you genuinely need a feature
the SDK does not cover.

---

## Operating with `lovagentic`

`lovagentic` ships an `auth` command group that handles every step of the
flow, plus an `api` validator that exercises the SDK end-to-end.

### One-time bootstrap (capture the refresh token)

```bash
# Make sure you are signed into Lovable Desktop or have run `lovagentic login`.
lovagentic import-desktop-session --profile-dir /tmp/lovagentic-profile

lovagentic auth bootstrap \
  --profile-dir /tmp/lovagentic-profile \
  --out-env $HOME/.lovagentic/lovable.env
```

What this does:

1. Launches a headless Playwright session against the seeded profile.
2. Reads `firebase:authUser:*:[DEFAULT]` from IndexedDB.
3. Refreshes immediately to confirm the refresh token still works.
4. Persists `~/.lovagentic/auth.json` (mode `0600`).
5. Optionally writes a shell-sourceable env file with `LOVABLE_BEARER_TOKEN`,
   `LOVABLE_REFRESH_TOKEN`, `LOVABLE_FIREBASE_API_KEY`, `LOVABLE_USER_ID`,
   `LOVABLE_EMAIL`.

After bootstrap, the browser profile is no longer needed for refreshes.
`auth.json` alone is enough.

### Status / refresh / export

```bash
lovagentic auth status                       # show user, expiry, refresh-token presence
lovagentic auth status --auto-refresh        # refresh if within 5 minutes of expiry
lovagentic auth refresh                      # force a refresh now
lovagentic auth refresh --out-env ./.env     # refresh and write env file
lovagentic auth export ./.env                # write env file (auto-refreshes)
lovagentic auth export ./.env --no-refresh   # use whatever is on disk
lovagentic auth clear                        # delete ~/.lovagentic/auth.json
```

Important Node 24+ note: we use `--out-env` (not `--env-file`) because Node
itself intercepts `--env-file=...` for its own dotenv loader and refuses to
pass it through to the script.

### Validate end-to-end

```bash
lovagentic api --validate --json
```

If `LOVABLE_API_KEY` and `LOVABLE_BEARER_TOKEN` are unset, the API backend
falls back to `~/.lovagentic/auth.json` and refreshes when needed. The
output reports `authSource = env-api-key | env-bearer | auth-cache`, so you
can tell which credential path your shell is actually using.

### Automatic refresh (macOS)

A LaunchAgent is shipped under
`scripts/launchd/com.lovagentic.auth-refresh.plist.template`:

```bash
./scripts/launchd/install-auth-refresh.sh
# optional custom env-file path:
./scripts/launchd/install-auth-refresh.sh /custom/path/lovable.env
```

What it installs:

- LaunchAgent `com.lovagentic.auth-refresh` in
  `~/Library/LaunchAgents`.
- Runs `node <repo>/src/cli.js auth refresh --out-env <env-file>` every
  3000 seconds (50 minutes), plus once on each login (`RunAtLoad`).
- Logs to `~/.lovagentic/logs/auth-refresh.{out,err}.log`.

To remove:

```bash
./scripts/launchd/uninstall-auth-refresh.sh
```

For Linux/CI, you can replicate the same effect with a systemd timer or a
cron entry that runs every 50 minutes:

```cron
*/50 * * * * /usr/local/bin/lovagentic auth refresh --out-env $HOME/.lovagentic/lovable.env >>$HOME/.lovagentic/logs/auth-refresh.log 2>&1
```

---

## Using the API directly

Pick **one** auth method. With a fresh env file the rest is trivial.

```bash
source ~/.lovagentic/lovable.env

# 1. Whoami
curl -s -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  https://api.lovable.dev/v1/me | jq

# 2. List workspaces
curl -s -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  https://api.lovable.dev/v1/workspaces | jq '.workspaces[] | {id, name, plan}'

# 3. List projects in a workspace
WSID=workspace_01jvy7q77zeasr0p9568vfcwvq
curl -s -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  "https://api.lovable.dev/v1/workspaces/$WSID/projects" | jq '.projects[] | {id, name}'

# 4. Send a chat prompt
PID=<your-project-id>
curl -s -X POST \
  -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Add a dark mode toggle"}' \
  "https://api.lovable.dev/v1/projects/$PID/messages"

# 5. Publish
curl -s -X POST \
  -H "Authorization: Bearer $LOVABLE_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "https://api.lovable.dev/v1/projects/$PID/deployments"
```

Or in TypeScript via the SDK:

```ts
import { LovableClient } from "@lovable.dev/sdk";

const client = new LovableClient({
  bearerToken: process.env.LOVABLE_BEARER_TOKEN!,
});

const me = await client.me();
const ws = me.workspaces[0];
const projects = await client.listProjects(ws.id);
await client.chat(projects[0].id, { message: "Add a dark mode toggle" });
const response = await client.waitForResponse(projects[0].id);
console.log(response.previewUrl);
```

The SDK also accepts `apiKey: "lov_..."` once you have a long-lived API key.

---

## Security & operational notes

- **Refresh-token theft is full account access.** The refresh token plus the
  Firebase Web API key is enough to mint Bearer tokens until the user
  revokes the session in Lovable. Store `~/.lovagentic/auth.json` and any
  derived env file at mode `0600` (lovagentic does this automatically) and
  never commit them.
- **Bearer-token theft is an hour of access.** Fine to inject into
  short-lived CI environments through env vars or short-TTL secrets.
- **Lovable can revoke at any time.** Sign-outs, password rotations, or
  workspace policy changes invalidate refresh tokens. Build retry logic that
  re-runs `auth bootstrap` against a freshly logged-in profile when refresh
  fails with HTTP 400 / `TOKEN_EXPIRED`.
- **Rate limits.** The SDK tolerates the usual 429 / `Retry-After`. Don't
  spawn one-message-per-call hot loops; batch where you can, especially
  against `/messages/stream` and `/edits`.
- **Scopes.** A Bearer token authenticates as the signed-in user with their
  full role set. Treat it as such: it can publish, run SQL, and modify
  workspace settings.

---

## Troubleshooting

**`auth bootstrap` says "No Firebase auth state found"**\
The seeded profile is not actually logged in. Run `lovagentic login`,
finish auth in the visible browser, then re-run bootstrap.

**Refresh returns HTTP 400 `TOKEN_EXPIRED` or `INVALID_REFRESH_TOKEN`**\
Lovable revoked the session. Re-run `auth bootstrap` against a freshly
logged-in profile.

**`api --validate` fails with "auth not configured" even though `auth.json` exists**\
You probably set `LOVABLE_API_KEY=` to an empty string. Either unset it or
give it a real value; the empty string still counts as configured.

**LaunchAgent logs `node: <env-file>: not found`**\
You're on Node 20+ and using `--env-file`. Switch to `--out-env` (already
the default in `install-auth-refresh.sh`). Reinstall the agent.

**Multiple env files drift**\
The cron'd `auth refresh --out-env` rewrites the env file every 50 minutes.
Other shells that already sourced it have the old token. Either re-source on
demand or read `~/.lovagentic/auth.json` at call time and trust the
auto-refresh.

---

## Live-verified vs SDK-typed shapes

The initial draft of these docs was assembled from `@lovable.dev/sdk@0.1.5`
(`dist/index.d.ts`). A full live recon against `api.lovable.dev` revealed
several places where the wire shape diverges from the SDK types. Treat the
**wire shape** as the source of truth.

Full list of corrections lives in
[`docs/lovable-api-reference.md` Appendix D](./lovable-api-reference.md#appendix-d-corrections-from-live-testing).
Highlights:

- `GET /v1/projects/{pid}` returns a slim payload — no `tech_stack`,
  `created_at`, `edit_count`, etc. Those live only on items in the project
  list response.
- `GET /v1/projects/{pid}/edits` items have only `{id, type, commit_sha,
  commit_message, status, created_at}`. No diff metadata.
- `GET /v1/projects/{pid}/git/files` is flat and file-only:
  `{path, size, binary}`. No directory entries, no shas.
- `GET /v1/projects/{pid}/git/diff` top-level uses `diffs`, not `entries`.
  Items use `{action, file_path, file_type, is_image, hunks}` and hunks use
  camelCase (`oldStart`/`newStart`).
- `GET /v1/projects/{pid}/database` returns `{ enabled: false }` when the
  project has no Lovable Cloud DB and `{ enabled: true, stack: "supabase" }`
  when it does. `supabase` is the only `stack` value seen in production.
- `GET /v1/workspaces/{wsId}` wraps the workspace as
  `{ workspace, current_member }`.
- `POST /v1/projects/{pid}/messages` returns `{message_id, status:
  "accepted"}` (no `ai_message_id`). Use `getMessage` / `waitForResponse` to
  observe the assistant turn.
- `GET /v1/projects/{pid}/messages` (LIST) is not supported. Single-get works.
- Visibility-toggle to `draft` is plan-gated (Business/Enterprise only).
- No `DELETE /v1/projects/{pid}` endpoint exists; deletion is UI-only.
- `/v1/_dev/...` endpoints reject Firebase Bearer tokens; they require a
  `Lovable-API-Key: lov_…` credential.
