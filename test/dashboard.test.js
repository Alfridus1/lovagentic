import assert from "node:assert/strict";
import test from "node:test";

import {
  compareDashboardProjectState,
  pollDashboardProjectState
} from "../src/browser.js";

function createJsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

test("compareDashboardProjectState detects editCount and lastEditedAt changes", () => {
  const baseline = {
    editCount: 2,
    lastEditedAt: "2026-04-17T10:00:00.000Z",
    updatedAt: "2026-04-17T10:00:00.000Z"
  };
  const current = {
    editCount: 3,
    lastEditedAt: "2026-04-17T10:05:00.000Z",
    updatedAt: "2026-04-17T10:05:00.000Z"
  };

  const comparison = compareDashboardProjectState(baseline, current);

  assert.deepEqual(comparison, {
    changed: true,
    editCountIncreased: true,
    lastEditedAtAdvanced: true,
    updatedAtAdvanced: true
  });
});

test("pollDashboardProjectState detects dashboard metadata changes through the workspace search endpoint", async () => {
  const originalFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async (url) => {
    fetchCalls.push(String(url));
    return createJsonResponse({
      total: 1,
      has_more: false,
      projects: [
        {
          id: "project-123",
          display_name: "Docs App",
          name: "docs-app",
          workspace_id: "workspace-1",
          last_edited_at: "2026-04-17T10:05:00.000Z",
          updated_at: "2026-04-17T10:05:00.000Z",
          edit_count: 4
        }
      ]
    });
  };

  try {
    const page = {
      waitForTimeout: async () => {}
    };
    const baseline = {
      id: "project-123",
      workspaceId: "workspace-1",
      workspaceName: "Docs",
      editCount: 3,
      lastEditedAt: "2026-04-17T10:00:00.000Z",
      updatedAt: "2026-04-17T10:00:00.000Z"
    };
    const lookup = {
      origin: "https://lovable.dev",
      collectionSeeds: {
        workspace: {
          requestHeaders: {
            authorization: "Bearer test-token"
          }
        }
      }
    };

    const result = await pollDashboardProjectState(page, {
      projectId: "project-123",
      baseline,
      lookup,
      timeoutMs: 50,
      initialPollMs: 1,
      maxPollMs: 1,
      pageSize: 100
    });

    assert.equal(result.detected, true);
    assert.equal(result.final.editCount, 4);
    assert.equal(result.comparison.editCountIncreased, true);
    assert.match(fetchCalls[0], /\/workspaces\/workspace-1\/projects\/search/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("pollDashboardProjectState returns detected=false when metadata never changes", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    return createJsonResponse({
      total: 1,
      has_more: false,
      projects: [
        {
          id: "project-123",
          display_name: "Docs App",
          name: "docs-app",
          workspace_id: "workspace-1",
          last_edited_at: "2026-04-17T10:00:00.000Z",
          updated_at: "2026-04-17T10:00:00.000Z",
          edit_count: 3
        }
      ]
    });
  };

  try {
    const page = {
      waitForTimeout: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
    };
    const baseline = {
      id: "project-123",
      workspaceId: "workspace-1",
      workspaceName: "Docs",
      editCount: 3,
      lastEditedAt: "2026-04-17T10:00:00.000Z",
      updatedAt: "2026-04-17T10:00:00.000Z"
    };
    const lookup = {
      origin: "https://lovable.dev",
      collectionSeeds: {
        workspace: {
          requestHeaders: {
            authorization: "Bearer test-token"
          }
        }
      }
    };

    const result = await pollDashboardProjectState(page, {
      projectId: "project-123",
      baseline,
      lookup,
      timeoutMs: 5,
      initialPollMs: 1,
      maxPollMs: 1,
      pageSize: 100
    });

    assert.equal(result.detected, false);
    assert.equal(result.final.editCount, 3);
    assert.equal(result.comparison.changed, false);
  } finally {
    global.fetch = originalFetch;
  }
});
