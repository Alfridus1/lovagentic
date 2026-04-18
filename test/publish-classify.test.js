import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyPublishSurface } from "../src/browser.js";

test("classifyPublishSurface returns closed for empty input", () => {
  assert.equal(classifyPublishSurface(""), "closed");
  assert.equal(classifyPublishSurface("   "), "closed");
  assert.equal(classifyPublishSurface(null), "closed");
});

test("classifyPublishSurface detects the publishing step", () => {
  assert.equal(classifyPublishSurface("Publishing your website..."), "publishing");
});

test("classifyPublishSurface detects already-published wizard even when words are concatenated", () => {
  // Regression: Lovable's DOM sometimes joins "Published" and "Live URL"
  // without whitespace, which broke the old \bPublished\b word-boundary match
  // and falsely returned "visibility" for an already-published project.
  const text = "PublishedLive URLWho can see the websiteAnyone with the linkPublicly accessibleReview securityEdit settingsUpdate";
  assert.equal(classifyPublishSurface(text), "published");
});

test("classifyPublishSurface detects published via Live URL label alone", () => {
  assert.equal(classifyPublishSurface("Some prefix Live URL lovagentic.lovable.app"), "published");
});

test("classifyPublishSurface still recognizes fresh visibility step", () => {
  // No Published/Live URL text - pure visibility step on a project that
  // hasn't been published yet should still classify as visibility.
  assert.equal(
    classifyPublishSurface("Who can see the website Anyone with the link"),
    "visibility"
  );
});

test("classifyPublishSurface recognizes review step", () => {
  assert.equal(classifyPublishSurface("Review and publish your changes"), "review");
});

test("classifyPublishSurface recognizes website info step", () => {
  assert.equal(
    classifyPublishSurface("Add info to help people find your website"),
    "website_info"
  );
});

test("classifyPublishSurface recognizes website url step", () => {
  assert.equal(classifyPublishSurface("Your website URL will be"), "website_url");
});

test("classifyPublishSurface returns unknown for other text", () => {
  assert.equal(classifyPublishSurface("Totally unrelated dashboard text"), "unknown");
});

test("classifyPublishSurface prioritizes publishing over published when both appear", () => {
  // Transient state during update flow: \"Publishing\" should win because
  // \"Published\" may still be in the header while a new deploy is running.
  const text = "Published Live URL Publishing new deploy";
  assert.equal(classifyPublishSurface(text), "publishing");
});
