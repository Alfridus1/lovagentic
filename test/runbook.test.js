import assert from "node:assert/strict";
import test from "node:test";

import {
  getRunbookPlan,
  normalizeRunbook,
  parseRunbookText,
  stepMutates
} from "../src/runbook.js";

test("parseRunbookText parses YAML runbooks", () => {
  const parsed = parseRunbookText(`
projectUrl: https://lovable.dev/projects/36597153-8b79-41be-8d71-3d9d3afa4a39
defaults:
  backend: api
steps:
  - type: snapshot
    output: before.json
  - type: prompt
    prompt: Ship a better hero.
`, "runbook.yaml");

  assert.equal(parsed.defaults.backend, "api");
  assert.equal(parsed.steps.length, 2);
});

test("normalizeRunbook applies overrides and validates step types", () => {
  const runbook = normalizeRunbook({
    projectUrl: "https://lovable.dev/projects/old",
    defaults: {
      backend: "auto",
      outputDir: "out"
    },
    steps: [
      { type: "snapshot" },
      { command: "diff", latest: true },
      { type: "publish", verifyLive: true }
    ]
  }, {
    projectUrl: "https://lovable.dev/projects/new",
    backend: "api"
  });

  assert.equal(runbook.projectUrl, "https://lovable.dev/projects/new");
  assert.equal(runbook.backend, "api");
  assert.equal(runbook.outputDir, "out");
  assert.deepEqual(runbook.steps.map((step) => step.type), [
    "snapshot",
    "diff",
    "publish"
  ]);
});

test("normalizeRunbook canonicalizes site assertion and publish-confirm step aliases", () => {
  const runbook = normalizeRunbook({
    projectUrl: "https://lovable.dev/projects/36597153-8b79-41be-8d71-3d9d3afa4a39",
    steps: [
      { type: "liveAssert" },
      { type: "meta-assert" },
      { type: "route_assert" },
      { type: "publish-confirm" }
    ]
  });

  assert.deepEqual(runbook.steps.map((step) => step.type), [
    "liveassert",
    "metaassert",
    "routeassert",
    "publishconfirm"
  ]);
});

test("normalizeRunbook rejects unsupported step types", () => {
  assert.throws(
    () => normalizeRunbook({
      projectUrl: "https://lovable.dev/projects/36597153-8b79-41be-8d71-3d9d3afa4a39",
      steps: [{ type: "transfer-ownership" }]
    }),
    /unsupported type/i
  );
});

test("getRunbookPlan marks mutating and inspect-only steps", () => {
  const runbook = normalizeRunbook({
    projectUrl: "https://lovable.dev/projects/36597153-8b79-41be-8d71-3d9d3afa4a39",
    steps: [
      { type: "snapshot", name: "before" },
      { type: "prompt", name: "change" },
      { type: "verify", name: "check" },
      { type: "publish", name: "ship" },
      { type: "publish-confirm", name: "ship-and-confirm" }
    ]
  });

  const plan = getRunbookPlan(runbook);
  assert.deepEqual(plan.steps.map((step) => [step.type, step.mutates]), [
    ["snapshot", false],
    ["prompt", true],
    ["verify", false],
    ["publish", true],
    ["publishconfirm", true]
  ]);
  assert.equal(stepMutates("fix"), true);
  assert.equal(stepMutates("diff"), false);
});
