import { test } from "node:test";
import assert from "node:assert/strict";

import {
  matchExpectedPromptInHaystack,
  LONG_PROMPT_MATCH_THRESHOLD,
  PROMPT_FINGERPRINT_LENGTH
} from "../src/browser.js";

test("matchExpectedPromptInHaystack returns false when expected is empty", () => {
  assert.equal(matchExpectedPromptInHaystack("anything", ""), false);
  assert.equal(matchExpectedPromptInHaystack("anything", null), false);
});

test("matchExpectedPromptInHaystack returns true for short verbatim matches", () => {
  const prompt = "Add a footer with copyright.";
  const history = "You: Add a footer with copyright.\nLovable: Done.";
  assert.equal(matchExpectedPromptInHaystack(history, prompt), true);
});

test("matchExpectedPromptInHaystack returns false for short prompts that are absent", () => {
  const prompt = "Add a footer with copyright.";
  const history = "Lovable: Ready to help.";
  assert.equal(matchExpectedPromptInHaystack(history, prompt), false);
});

test("matchExpectedPromptInHaystack matches long prompts by prefix fingerprint", () => {
  const longPrompt = "Fill in real content for the 4 Getting Started docs pages. " +
    "These are currently placeholder pages showing COMING SOON. " +
    "Replace the placeholders with the content below. ".repeat(20);
  assert.ok(longPrompt.length > LONG_PROMPT_MATCH_THRESHOLD);

  // Lovable often renders only the first ~200 chars of a collapsed bubble.
  const truncatedHistory = `You: ${longPrompt.slice(0, 220)}... (truncated) Lovable: Done.`;
  assert.equal(matchExpectedPromptInHaystack(truncatedHistory, longPrompt), true);
});

test("matchExpectedPromptInHaystack still rejects long prompts with a different prefix", () => {
  const longPrompt = ("Replace placeholder content in docs pages. ").repeat(40);
  assert.ok(longPrompt.length > LONG_PROMPT_MATCH_THRESHOLD);

  const wrongHistory = "You: totally unrelated message about something else entirely. Lovable: Done.";
  assert.equal(matchExpectedPromptInHaystack(wrongHistory, longPrompt), false);
});

test("matchExpectedPromptInHaystack tolerates whitespace and markdown bullets", () => {
  const prompt = "- Step one\n- Step two\n- Step three";
  const history = "You: Step one Step two Step three Lovable: Done.";
  assert.equal(matchExpectedPromptInHaystack(history, prompt), true);
});

test("matchExpectedPromptInHaystack fingerprint requires minimum length", () => {
  const shortPrompt = "hi there";
  // prompt is short, so it uses verbatim match only — fingerprint path is gated
  // by LONG_PROMPT_MATCH_THRESHOLD. This confirms short prompts aren't silently
  // falling through to fingerprint heuristic.
  const history = "h";
  assert.equal(matchExpectedPromptInHaystack(history, shortPrompt), false);
});

test("PROMPT_FINGERPRINT_LENGTH is a sensible value", () => {
  assert.ok(PROMPT_FINGERPRINT_LENGTH >= 80 && PROMPT_FINGERPRINT_LENGTH <= 400);
  assert.ok(LONG_PROMPT_MATCH_THRESHOLD > PROMPT_FINGERPRINT_LENGTH);
});
