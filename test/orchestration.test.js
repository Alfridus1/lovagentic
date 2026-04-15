import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPromptSequence,
  classifyIdleStateSnapshot,
  parseAssertionLines,
  splitPromptIntoChunks
} from "../src/orchestration.js";

test("buildPromptSequence auto-splits large prompts at blank-line boundaries and wraps parts", () => {
  const prompt = [
    "SECTION 1",
    "A".repeat(80),
    "",
    "SECTION 2",
    "B".repeat(80),
    "",
    "SECTION 3",
    "C".repeat(80)
  ].join("\n");

  const sequence = buildPromptSequence(prompt, {
    thresholdChars: 10,
    maxChunkChars: 260
  });

  assert.equal(sequence.length, 3);
  assert.equal(sequence[0].index, 1);
  assert.equal(sequence[0].total, 3);
  assert.equal(sequence[0].autoSplit, true);
  assert.match(
    sequence[0].prompt,
    /This request is being sent in 3 parts due to Lovable prompt limits\./
  );
  assert.match(
    sequence[1].prompt,
    /Do not implement yet; wait for the final part\. Part 2\/3:/
  );
  assert.match(
    sequence[2].prompt,
    /This is the final part of the same request\. Use all parts together and now proceed\. Part 3\/3:/
  );
  assert.match(sequence[0].prompt, /SECTION 1/);
  assert.match(sequence[1].prompt, /SECTION 2/);
  assert.match(sequence[2].prompt, /SECTION 3/);
});

test("splitPromptIntoChunks falls back to line-based splitting for oversized blocks", () => {
  const prompt = [
    `line 1 ${"A".repeat(24)}`,
    `line 2 ${"B".repeat(24)}`,
    `line 3 ${"C".repeat(24)}`
  ].join("\n");

  const chunks = splitPromptIntoChunks(prompt, {
    thresholdChars: 10,
    maxChunkChars: 40
  });

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0], `line 1 ${"A".repeat(24)}`);
  assert.equal(chunks[1], `line 2 ${"B".repeat(24)}`);
  assert.equal(chunks[2], `line 3 ${"C".repeat(24)}`);
});

test("parseAssertionLines ignores blanks and comments while preserving order and duplicates", () => {
  const parsed = parseAssertionLines(`
    # comment

    HERO
    CTA
    HERO
      # another comment
    FOOTER
  `);

  assert.deepEqual(parsed, [
    "HERO",
    "CTA",
    "HERO",
    "FOOTER"
  ]);
});

test("classifyIdleStateSnapshot reports busy for Thinking", () => {
  const result = classifyIdleStateSnapshot({
    bodyText: "Lovable is Thinking about your request",
    visibleActionLabels: []
  });

  assert.equal(result.status, "busy");
  assert.equal(result.details.hasThinking, true);
});

test("classifyIdleStateSnapshot reports queue_paused for explicit resume queue actions", () => {
  const result = classifyIdleStateSnapshot({
    bodyText: "Queue is paused",
    visibleActionLabels: ["Resume queue"]
  });

  assert.equal(result.status, "queue_paused");
  assert.equal(result.details.hasQueueResumeAction, true);
});

test("classifyIdleStateSnapshot reports waiting_for_input for open questions", () => {
  const result = classifyIdleStateSnapshot({
    bodyText: "Questions",
    visibleActionLabels: [],
    questionOpen: true
  });

  assert.equal(result.status, "waiting_for_input");
});

test("classifyIdleStateSnapshot reports error for runtime error surfaces", () => {
  const result = classifyIdleStateSnapshot({
    bodyText: "The app encountered an error",
    visibleActionLabels: [],
    runtimeErrorOpen: true
  });

  assert.equal(result.status, "error");
});

test("classifyIdleStateSnapshot ignores feedback controls and proposal chips as build activity", () => {
  const result = classifyIdleStateSnapshot({
    bodyText: "Approve\nHelpful\nCopy message",
    visibleActionLabels: [
      "Helpful",
      "Not helpful",
      "Copy message",
      "More options",
      "Approve",
      "Review"
    ]
  });

  assert.equal(result.status, "idle");
  assert.deepEqual(result.details.visibleActionLabels, [
    "approve",
    "review"
  ]);
});
