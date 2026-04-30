import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApiDiff,
  buildApiSnapshot,
  formatSnapshotSummary,
  getProjectIdFromTarget,
  summarizeApiDiff
} from "../src/api-ops.js";

test("getProjectIdFromTarget accepts Lovable URLs and raw project ids", () => {
  const projectId = "36597153-8b79-41be-8d71-3d9d3afa4a39";
  assert.equal(
    getProjectIdFromTarget(`https://lovable.dev/projects/${projectId}?x=1`),
    projectId
  );
  assert.equal(getProjectIdFromTarget(projectId), projectId);
});

test("summarizeApiDiff counts changed files, additions, deletions, and incomplete files", () => {
  const summary = summarizeApiDiff({
    diffs: [
      {
        action: "modified",
        file_path: "src/App.tsx",
        is_image: false,
        hunks: [
          {
            lines: [
              { type: "context", content: " const x = 1;" },
              { type: "add", content: "+ const y = 2;" },
              { type: "delete", content: "- const z = 3;" }
            ]
          }
        ]
      },
      {
        action: "added",
        file_path: "public/logo.png",
        is_image: true,
        is_incomplete: true
      }
    ]
  });

  assert.equal(summary.filesChanged, 2);
  assert.equal(summary.additions, 1);
  assert.equal(summary.deletions, 1);
  assert.equal(summary.incompleteFiles, 1);
  assert.deepEqual(summary.files.map((file) => file.path), [
    "src/App.tsx",
    "public/logo.png"
  ]);
});

test("buildApiDiff resolves --latest through edit history", async () => {
  const calls = [];
  const backend = {
    async listEdits(projectId, params) {
      calls.push(["listEdits", projectId, params]);
      return {
        edits: [{
          id: "edit_1",
          commit_sha: "abc123",
          status: "completed"
        }]
      };
    },
    async getDiff(projectId, params) {
      calls.push(["getDiff", projectId, params]);
      return { diffs: [] };
    }
  };

  const state = await buildApiDiff(
    backend,
    "36597153-8b79-41be-8d71-3d9d3afa4a39",
    { latest: true }
  );

  assert.equal(state.params.sha, "abc123");
  assert.equal(state.latestEdit.id, "edit_1");
  assert.deepEqual(calls, [
    ["listEdits", "36597153-8b79-41be-8d71-3d9d3afa4a39", { limit: 1 }],
    ["getDiff", "36597153-8b79-41be-8d71-3d9d3afa4a39", { sha: "abc123" }]
  ]);
});

test("buildApiDiff fails clearly when latest edit has no commit sha", async () => {
  const backend = {
    async listEdits() {
      return { edits: [{ id: "edit_without_commit", status: "completed" }] };
    },
    async getDiff() {
      throw new Error("should not request diff");
    }
  };

  await assert.rejects(
    () => buildApiDiff(
      backend,
      "36597153-8b79-41be-8d71-3d9d3afa4a39",
      { latest: true }
    ),
    /commit sha/i
  );
});

// ---- snapshot: database state + truncation warnings ----

function makeFakeSnapshotBackend({ files = [], database = null, calls = {} } = {}) {
  return {
    getProjectState: async () => {
      calls.getProjectState = (calls.getProjectState || 0) + 1;
      return {
        id: "abc",
        workspace_id: "ws_1",
        display_name: "Test",
        status: "completed",
      };
    },
    getPreviewUrl: () => "https://preview/abc",
    getPublishedUrl: async () => null,
    getWorkspace: async () => null,
    getProjectKnowledge: async () => ({ content: "" }),
    getWorkspaceKnowledge: async () => ({ content: "" }),
    listFiles: async () => ({ files }),
    listEdits: async () => ({ edits: [], has_more: false }),
    getDatabaseStatus: async () => {
      calls.getDatabaseStatus = (calls.getDatabaseStatus || 0) + 1;
      return database;
    },
  };
}

test("buildApiSnapshot includes the project's database status by default", async () => {
  const calls = {};
  const backend = makeFakeSnapshotBackend({
    database: { enabled: true, stack: "supabase" },
    calls,
  });
  const snapshot = await buildApiSnapshot(
    backend,
    "https://lovable.dev/projects/36597153-8b79-41be-8d71-3d9d3afa4a39"
  );
  assert.deepEqual(snapshot.database, { enabled: true, stack: "supabase" });
  assert.equal(calls.getDatabaseStatus, 1, "getDatabaseStatus must run by default");
});

test("buildApiSnapshot honours { database: false } as an opt-out", async () => {
  const calls = {};
  const backend = makeFakeSnapshotBackend({
    database: { enabled: true, stack: "supabase" },
    calls,
  });
  const snapshot = await buildApiSnapshot(
    backend,
    "https://lovable.dev/projects/36597153-8b79-41be-8d71-3d9d3afa4a39",
    { database: false }
  );
  assert.equal(snapshot.database, null);
  assert.equal(
    calls.getDatabaseStatus,
    undefined,
    "getDatabaseStatus must NOT run when database: false"
  );
});

test("buildApiSnapshot pushes a warning when files are truncated", async () => {
  const files = Array.from({ length: 200 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    size: 100,
    binary: false,
  }));
  const backend = makeFakeSnapshotBackend({ files });
  const snapshot = await buildApiSnapshot(
    backend,
    "https://lovable.dev/projects/36597153-8b79-41be-8d71-3d9d3afa4a39",
    { maxFiles: 50 }
  );
  assert.equal(snapshot.files.truncated, true);
  assert.ok(
    snapshot.warnings.some((w) => /Files truncated.*--max-files/i.test(w)),
    `expected a truncation warning, got ${JSON.stringify(snapshot.warnings)}`
  );
});

test("formatSnapshotSummary includes the database row and a loud truncation hint", () => {
  const snapshotEnabled = {
    project: { display_name: "x" },
    projectId: "abc",
    projectUrl: "u",
    previewUrl: "p",
    publishedUrl: null,
    files: { returned: 50, total: 200, truncated: true },
    edits: { total: 1, hasMore: false },
    knowledge: { content: "k" },
    database: { enabled: true, stack: "supabase" },
    warnings: ["Files truncated: showing 50 of 200 entries; pass --max-files <n> to widen."],
  };
  const out = formatSnapshotSummary(snapshotEnabled);
  assert.match(out, /Database: enabled \(supabase\)/);
  assert.match(out, /⚠️.*truncated.*--max-files/);
  assert.match(out, /Files truncated: showing 50 of 200/);
});
