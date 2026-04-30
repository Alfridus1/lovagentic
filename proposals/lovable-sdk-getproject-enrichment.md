# Proposal: enrich `client.getProject(projectId)` with list-only aggregate fields

> Filed for [`@lovable.dev/sdk`](https://www.npmjs.com/package/@lovable.dev/sdk) v0.1.5.
> Sender: Tobias Kub (`tobias.kub@appfor.de`, npm `alfridus`, GitHub `Alfridus1`).
> Repo: <https://github.com/Alfridus1/lovagentic>.
> Source of evidence: live recon against `api.lovable.dev` on 2026-04-30,
> 55 projects sampled across 4 workspaces.

## Summary

`client.getProject(projectId)` currently returns the slim wire response from
`GET /v1/projects/{pid}`. That response intentionally omits the aggregate
fields the dashboard relies on (`tech_stack`, `edit_count`, `created_at`,
`updated_at`, `last_edited_at`, `last_viewed_at`, `user_display_name`,
`user_photo_url`, `is_starred`, `remix_count`, `trending_score`, `app_visitors_*`,
`is_deleted`, etc.). Those fields are present **only** on items returned by
`GET /v1/workspaces/{wsId}/projects`.

In practice, every consumer that touches a single project ends up paying a
second round-trip to the workspace list, doing the cross-reference, and
merging by hand. We've shipped that workaround in
[`lovagentic`](https://github.com/Alfridus1/lovagentic) (npm `lovagentic`)
since v0.3.2 and would like to push it upstream so other SDK consumers can
stop reinventing it.

## Repro / current behaviour

```ts
import { LovableClient } from "@lovable.dev/sdk";
const client = new LovableClient({ bearerToken: process.env.LOVABLE_BEARER_TOKEN! });

// Real public Lovable project ("SolarFlow Partner", workspace "Tobi's Lovable")
const slim = await client.getProject("4907b86e-cc91-4340-9ffa-fbf9039a1e7c");

// What you actually get back today (verified 2026-04-30):
{
  "$schema": "https://api.lovable.dev/V1ProjectResponse.json",
  "id":            "4907b86e-cc91-4340-9ffa-fbf9039a1e7c",
  "workspace_id":  "vRcruRG7IFrfqnhpLXR6",
  "display_name":  "SolarFlow Partner",
  "description":   "- SolarFlow Partner is a whitelabel SaaS …",
  "status":        "completed",
  "visibility":    "private",
  "is_published":  true,
  "url":           "https://pv-pilot-hub.lovable.app",
  "latest_commit_sha":     "496351c3cba8dc91addc9c8b7455a82467a73b7b",
  "latest_screenshot_url": "https://screenshot2.lovable.dev/…"
}
// Notably missing: tech_stack, edit_count, created_at, last_edited_at,
// app_visitors_*, trending_score, user_*, remix_count, name (slug), …
```

The same project, fetched through the workspace list, includes all of the
above:

```ts
const list = await client.listProjects(slim.workspace_id, { limit: 100 });
const item = list.projects.find((p) => p.id === slim.id);
// item.tech_stack       === "tanstack_start_ts"
// item.edit_count       === 182
// item.created_at       === "2026-04-20T07:43:34Z"
// item.last_edited_at   === "2026-04-30T10:57:31Z"
// item.app_visitors_30d === 3
// item.user_display_name === "Tobi"
// item.name             === "pv-pilot-hub" (slug — also missing on slim)
```

## Why this matters

- **Every dashboard tool** that opens a single project needs at least
  `last_edited_at` + `is_starred` to render its top-bar. They all pay the
  hidden cost.
- **CI/automation** that polls a single project for build status doesn't
  *need* the aggregates, but it has to know to ask for them separately to
  surface a meaningful "last updated" timestamp.
- **The SDK type** (`ProjectResponse`) does not document the asymmetry, so
  TypeScript users hit `undefined` at runtime where the type says `string`.
  That has bitten us repeatedly while building `lovagentic`; we shipped two
  doc-correction patches against our own reference docs because of it.
- **Real usage signal:** in 55 projects sampled across 4 workspaces today
  (Tobi's Lovable, COPPEN, My Lovable, mick's Lovable), every single
  `getProject` call we made in `lovagentic snapshot` and `lovagentic prompt`
  flows ended up needing at least one aggregate field, so we had to fan out
  to the list endpoint anyway.

## Proposed change

Expose an opt-in enrichment flag on `client.getProject`. Default off so we
do not break anyone who relies on the slim shape, but make it trivial to
get the merged version that consumers actually want.

```ts
interface GetProjectOptions {
  /**
   * When true, after fetching `/v1/projects/{pid}` the SDK will also fetch
   * `/v1/workspaces/{workspace_id}/projects` and merge the matching list
   * item's aggregate fields onto the slim response. Slim-only fields like
   * `latest_commit_sha` and `latest_screenshot_url` always win.
   *
   * The list response is cached per `workspace_id` for a small TTL
   * (default 30s) so back-to-back lookups share one round-trip.
   *
   * Default: `false` (SDK preserves today's wire shape).
   */
  enrich?: boolean;
}

class LovableClient {
  // existing
  async getProject(projectId: string): Promise<ProjectResponse>;
  // proposed overload — opt-in, additive
  async getProject(projectId: string, options: GetProjectOptions): Promise<ProjectResponse>;
}
```

### Reference implementation

We've been running this in production via lovagentic v0.3.2 against
api.lovable.dev. Drop-in for `dist/index.js`:

```js
// internal cache: workspaceId -> { fetchedAt, projects: Map<id, listItem> }
const projectListCache = new Map();
const PROJECT_LIST_CACHE_TTL_MS = 30_000;

const PROJECT_AGGREGATE_FIELDS = [
  "tech_stack",
  "created_at",
  "updated_at",
  "last_edited_at",
  "last_viewed_at",
  "edit_count",
  "user_display_name",
  "user_photo_url",
  "created_by",
  "user_id",
  "is_starred",
  "remix_count",
  "trending_score",
  "app_visitors_24h",
  "app_visitors_7d",
  "app_visitors_30d",
  "is_deleted",
  "exclude_from_being_read",
  "shared_context_admin_isolated",
];

function mergeProjectAggregates(slim, listItem) {
  if (!slim || !listItem) return slim;
  const enriched = { ...slim };
  for (const f of PROJECT_AGGREGATE_FIELDS) {
    if (enriched[f] === undefined && listItem[f] !== undefined) {
      enriched[f] = listItem[f];
    }
  }
  if (enriched.name === undefined && listItem.name !== undefined) {
    enriched.name = listItem.name;
  }
  return enriched;
}

async function enrichProjectWithAggregates(client, slim) {
  if (!slim || typeof slim !== "object") return slim;
  if (!slim.workspace_id) return slim;
  if (slim.tech_stack !== undefined || slim.edit_count !== undefined) {
    return slim; // already enriched
  }

  const cacheKey = slim.workspace_id;
  const now = Date.now();
  const entry = projectListCache.get(cacheKey);
  if (entry && now - entry.fetchedAt <= PROJECT_LIST_CACHE_TTL_MS) {
    return mergeProjectAggregates(slim, entry.projects.get(slim.id));
  }

  try {
    const list = await client.listProjects(cacheKey, {
      limit: 100,
      sort_by: "last_edited_at",
      sort_order: "desc",
    });
    const map = new Map();
    for (const p of list?.projects || []) {
      if (p?.id) map.set(p.id, p);
    }
    projectListCache.set(cacheKey, { fetchedAt: now, projects: map });
    return mergeProjectAggregates(slim, map.get(slim.id));
  } catch {
    // Soft-fail: prefer slim over a thrown error.
    return slim;
  }
}

class LovableClient {
  // … existing constructor + private rawRequest etc. …

  async getProject(projectId, options) {
    const slim = await this.request("GET", `/v1/projects/${projectId}`);
    if (!options?.enrich) return slim;
    return enrichProjectWithAggregates(this, slim);
  }
}
```

### TypeScript

```ts
type ProjectVisibility = "draft" | "private" | "public";
type ProjectStatus = "completed" | "in_progress" | "failed";

interface ProjectResponse {
  id: string;
  workspace_id: string;
  display_name: string;
  description?: string;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  is_published: boolean;
  url?: string | null;
  latest_commit_sha?: string;
  latest_screenshot_url?: string;

  // Present only when called with { enrich: true }, or when this object
  // came from listProjects(). Document them as Partial<…> here so users
  // know they may be undefined.
  tech_stack?: string;
  name?: string; // slug
  user_id?: string;
  created_at?: string;
  updated_at?: string;
  last_edited_at?: string;
  last_viewed_at?: string;
  edit_count?: number;
  user_display_name?: string;
  user_photo_url?: string;
  created_by?: string;
  is_starred?: boolean;
  remix_count?: number;
  trending_score?: number;
  app_visitors_24h?: number;
  app_visitors_7d?: number;
  app_visitors_30d?: number;
  is_deleted?: boolean;
}

interface GetProjectOptions {
  enrich?: boolean;
}
```

## Compatibility & rollout

- **Backward compatible.** Default behaviour (`enrich` omitted) is identical
  to today.
- **No new server-side API surface.** Pure client-side composition.
- **Cache TTL is configurable** if desired (e.g. `enrich: { cache?: false |
  number }`); we kept the proposed surface minimal but happy to expand.
- **Cache invalidation:** consumers that mutate projects (publish, chat,
  setVisibility, …) can clear the cache via a private helper, or the SDK
  can invalidate the entry for the affected `workspace_id` whenever those
  methods run.

## Bonus: documentation drift

While building lovagentic we also collected a list of small wire-vs-SDK-type
divergences that would be worth fixing in the same release. Full list at
[`docs/lovable-api-reference.md`](https://github.com/Alfridus1/lovagentic/blob/main/docs/lovable-api-reference.md#appendix-d-corrections-from-live-testing).
Highlights:

- `GET /v1/projects/{pid}/edits` items omit `summary`/`lines_added`/`lines_removed`/`files_changed`. Real shape: `{ id, type, commit_sha, commit_message, status, created_at }`.
- `GET /v1/projects/{pid}/git/files` is flat with `{ path, size, binary }` per item — no directory entries, no sha. Top-level keys are `{ "$schema", "files", "ref" }`.
- `GET /v1/projects/{pid}/git/diff` uses top-level `diffs` (not `entries`); items are `{ action, file_path, file_type, is_image, hunks }` with camelCase hunk fields (`oldStart`, `newStart`).
- `GET /v1/projects/{pid}/database` returns `{ enabled: false }` or `{ enabled: true, stack: "supabase" }`. The richer shape in the SDK type (`status`, `region`, `size_bytes`, `tables`) is not returned by the API.
- `GET /v1/workspaces/{wsId}` wraps as `{ workspace, current_member }`, not the unwrapped `WorkspaceWithMembership` the SDK type implies.
- `POST /v1/projects/{pid}/messages` returns `{ message_id, status: "accepted" }`. The previously documented `ai_message_id` is not present at this point — it is only obtainable later via `getMessage` / `waitForResponse`.
- `GET /v1/projects/{pid}/messages` (LIST) is not supported (HTTP 405).
- `PUT /v1/projects/{pid}/visibility` to `draft` is plan-gated (Business/Enterprise).
- There is no `DELETE /v1/projects/{pid}` endpoint — deletion is UI-only today.
- `/v1/_dev/...` routes reject Firebase Bearer tokens with 403 `dev_api_key_required`; they require an `lov_...` API key.

Happy to file these as a separate issue if it helps.

## Why we're filing this externally

`@lovable.dev/sdk` does not have a public source repository (no
`repository`/`bugs` field in its npm package; we couldn't find it on
GitHub). So this proposal is shaped as a self-contained drop-in patch with
type updates and a reference implementation already in production. If you
have an internal tracker / preferred submission channel, we are happy to
re-file there.

## Contact

- npm: `alfridus`
- GitHub: <https://github.com/Alfridus1>
- Email: `tobias.kub@appfor.de`
- Repo using this workaround in production: <https://github.com/Alfridus1/lovagentic>
- Live workspace where this was developed: "Tobi's Lovable" (`vRcruRG7IFrfqnhpLXR6`)
