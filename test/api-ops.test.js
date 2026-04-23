import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApiDiff,
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
