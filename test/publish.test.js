import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPublishFailure,
  shouldTreatPublishFailureAsSuccess
} from "../src/publish.js";

test("classifyPublishFailure marks registry visibility races as retryable", () => {
  const result = classifyPublishFailure(`
    npm notice publish Signed provenance statement
    npm error code E404
    npm error 404 'lovagentic@0.1.2' is not in this registry.
  `);

  assert.deepEqual(result, {
    retryable: true,
    reason: "registry_visibility_race"
  });
});

test("classifyPublishFailure marks already-published versions as retryable", () => {
  const result = classifyPublishFailure(`
    npm error You cannot publish over the previously published versions: 0.1.2.
  `);

  assert.deepEqual(result, {
    retryable: true,
    reason: "version_already_exists"
  });
});

test("shouldTreatPublishFailureAsSuccess accepts matching published gitHead", () => {
  const result = shouldTreatPublishFailureAsSuccess({
    publishOutput: "npm error 404 'lovagentic@0.1.2' is not in this registry.",
    currentGitHead: "abc123",
    publishedGitHead: "abc123"
  });

  assert.deepEqual(result, {
    ok: true,
    reason: "registry_visibility_race"
  });
});

test("shouldTreatPublishFailureAsSuccess rejects mismatched published gitHead", () => {
  const result = shouldTreatPublishFailureAsSuccess({
    publishOutput: "npm error You cannot publish over the previously published versions: 0.1.2.",
    currentGitHead: "abc123",
    publishedGitHead: "def456"
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "published_githead_mismatch"
  });
});

test("shouldTreatPublishFailureAsSuccess rejects unknown publish failures", () => {
  const result = shouldTreatPublishFailureAsSuccess({
    publishOutput: "npm error code E401\nnpm error Unable to authenticate",
    currentGitHead: "abc123",
    publishedGitHead: "abc123"
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "unknown_failure"
  });
});
