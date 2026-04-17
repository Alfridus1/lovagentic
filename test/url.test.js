import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPreviewRouteUrl,
  getVerificationScreenshotFilename,
  normalizePreviewRoute,
  slugifyPreviewRoute
} from "../src/url.js";

test("normalizePreviewRoute normalizes paths and preserves query fragments", () => {
  assert.equal(normalizePreviewRoute("docs/start"), "/docs/start");
  assert.equal(normalizePreviewRoute("/docs?tab=install#top"), "/docs?tab=install#top");
  assert.equal(normalizePreviewRoute(""), "/");
});

test("buildPreviewRouteUrl resolves preview subroutes against the preview origin", () => {
  const url = buildPreviewRouteUrl("https://preview.example.dev/", "/docs/start/install");
  assert.equal(url, "https://preview.example.dev/docs/start/install");
});

test("slugifyPreviewRoute and screenshot filenames include route slugs for explicit routes", () => {
  assert.equal(slugifyPreviewRoute("/docs/start/install"), "docs_start_install");
  assert.equal(
    getVerificationScreenshotFilename("desktop", "/docs/start/install", {
      explicitRoute: true
    }),
    "desktop__docs_start_install.png"
  );
  assert.equal(
    getVerificationScreenshotFilename("desktop", "/", {
      explicitRoute: false
    }),
    "desktop.png"
  );
});
