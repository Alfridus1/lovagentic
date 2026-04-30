import assert from "node:assert/strict";
import test from "node:test";

import {
  createApiBackend,
  DEFAULT_LOVABLE_API_BASE_URL,
  getApiBackendCapabilities,
  resolveApiBackendConfig,
  enrichProjectWithAggregates,
  mergeProjectAggregates,
  clearApiBackendCaches,
} from "../src/backends/api-backend.js";
import { CAPABILITIES } from "../src/backends/capabilities.js";
import { getBackend } from "../src/backends/index.js";

test("api backend config detects env-free state without exposing secrets", () => {
  const config = resolveApiBackendConfig({ apiKey: "lov_test_key" });
  assert.equal(config.apiKey, "lov_test_key");
  assert.equal(config.hasApiKey, true);
  assert.equal(config.configured, true);
  assert.equal(config.baseUrl, DEFAULT_LOVABLE_API_BASE_URL);
});

test("api backend advertises official SDK-backed capabilities", () => {
  const capabilities = getApiBackendCapabilities();
  assert.equal(capabilities.has(CAPABILITIES.AUTH_API_KEY), true);
  assert.equal(capabilities.has(CAPABILITIES.PROJECT_LIST), true);
  assert.equal(capabilities.has(CAPABILITIES.PROJECT_CREATE), true);
  assert.equal(capabilities.has(CAPABILITIES.PROMPT_SUBMIT), true);
  assert.equal(capabilities.has(CAPABILITIES.PUBLISH_RUN), true);
  assert.equal(capabilities.has(CAPABILITIES.MCP_SERVERS), true);
  assert.equal(capabilities.has(CAPABILITIES.VERIFY_DESKTOP), false);
});

test("explicit api backend fails closed without an API key", async () => {
  const previousApiKey = process.env.LOVABLE_API_KEY;
  const previousBearerToken = process.env.LOVABLE_BEARER_TOKEN;
  delete process.env.LOVABLE_API_KEY;
  delete process.env.LOVABLE_BEARER_TOKEN;
  try {
    // skipAuthCache forces the backend to ignore the on-disk auth cache
    // managed by `lovagentic auth bootstrap`, so this test asserts the pure
    // env-only failure mode regardless of any developer's local cache.
    await assert.rejects(
      () => createApiBackend({ skipAuthCache: true }),
      /Lovable API auth not configured/
    );
    await assert.rejects(
      () => getBackend({ backend: "api", apiOptions: { skipAuthCache: true } }),
      /Configure LOVABLE_API_KEY/
    );
  } finally {
    restoreEnv("LOVABLE_API_KEY", previousApiKey);
    restoreEnv("LOVABLE_BEARER_TOKEN", previousBearerToken);
  }
});

function restoreEnv(name, value) {
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// ---- enrichment workaround for the slim getProject response ----

test("mergeProjectAggregates grafts list-only fields onto the slim response", () => {
  const slim = {
    id: "abc",
    workspace_id: "ws_1",
    display_name: "Agent Smoke Check",
    status: "completed",
    visibility: "private",
    is_published: false,
    latest_commit_sha: "54ea9557",
    latest_screenshot_url: "https://screenshot.example/abc.png",
  };
  const listItem = {
    id: "abc",
    workspace_id: "ws_1",
    name: "agent-smoke",                        // slug only on list
    display_name: "Agent Smoke Check",
    tech_stack: "tanstack_start_ts",
    edit_count: 2,
    created_at: "2026-04-30T20:25:24Z",
    updated_at: "2026-04-30T20:28:34.600429Z",
    last_edited_at: "2026-04-30T20:26:20Z",
    user_display_name: "Tobi",
    is_starred: false,
    remix_count: 0,
    latest_commit_sha: "DIFFERENT",            // must NOT override the slim value
  };
  const merged = mergeProjectAggregates(slim, listItem);

  // Aggregates pulled in.
  assert.equal(merged.tech_stack, "tanstack_start_ts");
  assert.equal(merged.edit_count, 2);
  assert.equal(merged.last_edited_at, "2026-04-30T20:26:20Z");
  assert.equal(merged.user_display_name, "Tobi");
  assert.equal(merged.remix_count, 0);

  // Slug filled in from list (was missing on slim).
  assert.equal(merged.name, "agent-smoke");

  // Slim values must win for fields it already provides.
  assert.equal(merged.latest_commit_sha, "54ea9557");
  assert.equal(merged.latest_screenshot_url, "https://screenshot.example/abc.png");
  assert.equal(merged.display_name, "Agent Smoke Check");
});

test("mergeProjectAggregates is a no-op if listItem is missing", () => {
  const slim = { id: "a", display_name: "x" };
  assert.deepEqual(mergeProjectAggregates(slim, null), slim);
  assert.deepEqual(mergeProjectAggregates(slim, undefined), slim);
});

test("enrichProjectWithAggregates returns slim unchanged when workspace_id missing", async () => {
  const fakeClient = {
    listProjects: async () => {
      throw new Error("should not be called");
    },
  };
  const slim = { id: "abc", display_name: "x" };
  const out = await enrichProjectWithAggregates(fakeClient, slim);
  assert.deepEqual(out, slim);
});

test("enrichProjectWithAggregates fetches the workspace list once and merges", async () => {
  clearApiBackendCaches();
  let listCalls = 0;
  const fakeClient = {
    listProjects: async (workspaceId, params) => {
      listCalls += 1;
      assert.equal(workspaceId, "ws_1");
      assert.equal(params.sort_by, "last_edited_at");
      return {
        projects: [
          { id: "abc", workspace_id: "ws_1", tech_stack: "vite", edit_count: 7 },
          { id: "other", workspace_id: "ws_1", tech_stack: "next", edit_count: 1 },
        ],
      };
    },
  };

  const slim = { id: "abc", workspace_id: "ws_1", display_name: "x" };
  const enriched1 = await enrichProjectWithAggregates(fakeClient, slim);
  assert.equal(enriched1.tech_stack, "vite");
  assert.equal(enriched1.edit_count, 7);
  assert.equal(listCalls, 1);

  // Second call should hit the cache and not re-fetch.
  const enriched2 = await enrichProjectWithAggregates(fakeClient, slim);
  assert.equal(enriched2.edit_count, 7);
  assert.equal(listCalls, 1, "second enrichment must not re-fetch");
});

test("enrichProjectWithAggregates soft-fails when listProjects throws", async () => {
  clearApiBackendCaches();
  const fakeClient = {
    listProjects: async () => {
      throw new Error("rate limited");
    },
  };
  const slim = { id: "abc", workspace_id: "ws_2", display_name: "x" };
  const out = await enrichProjectWithAggregates(fakeClient, slim);
  assert.deepEqual(out, slim, "enrichment must fall back to slim, not throw");
});

test("enrichProjectWithAggregates skips the round-trip when input is already enriched", async () => {
  clearApiBackendCaches();
  let listCalls = 0;
  const fakeClient = {
    listProjects: async () => {
      listCalls += 1;
      return { projects: [] };
    },
  };
  const enrichedInput = {
    id: "abc",
    workspace_id: "ws_3",
    display_name: "x",
    edit_count: 12,
    tech_stack: "vite",
  };
  const out = await enrichProjectWithAggregates(fakeClient, enrichedInput);
  assert.equal(out, enrichedInput);
  assert.equal(listCalls, 0, "already-enriched payloads must not trigger a list fetch");
});
