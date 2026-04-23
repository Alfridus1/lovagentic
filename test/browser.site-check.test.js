import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  capturePreviewSnapshot,
  discoverSiteRoutes
} from "../src/browser.js";

test("capturePreviewSnapshot supports title, meta, link, html assertions and HTML recordings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lovagentic-site-check-"));
  const htmlPath = path.join(dir, "fixture.html");
  const screenshotPath = path.join(dir, "screenshot.png");
  const recordingPath = path.join(dir, "recording.html");
  await fs.writeFile(htmlPath, `<!doctype html>
    <html>
      <head>
        <title>lovagentic test page</title>
        <meta name="description" content="API-first where supported, browser-backed elsewhere">
        <meta property="og:description" content="Agentic CLI for Lovable.dev">
      </head>
      <body>
        <nav>
          <a href="/docs">Docs</a>
          <a href="https://example.com/github">GitHub</a>
        </nav>
        <main><h1>API-first where supported</h1></main>
      </body>
    </html>`);

  const result = await capturePreviewSnapshot({
    previewUrl: pathToFileURL(htmlPath).toString(),
    outputPath: screenshotPath,
    htmlOutputPath: recordingPath,
    viewport: { width: 1024, height: 768 },
    expectText: ["API-first where supported"],
    forbidText: ["MCP-native in v0.2"],
    expectTitle: ["lovagentic test"],
    expectMetaDescription: ["API-first"],
    expectLink: ["Docs"],
    forbidHtml: ["Browser-based today, native MCP next week"],
    settleMs: 50
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.snapshot.missingExpectedTexts, []);
  assert.deepEqual(result.snapshot.forbiddenTextsFound, []);
  assert.deepEqual(result.snapshot.missingExpectedTitles, []);
  assert.deepEqual(result.snapshot.missingExpectedMetaDescriptions, []);
  assert.deepEqual(result.snapshot.missingExpectedLinks, []);
  assert.deepEqual(result.snapshot.forbiddenHtmlFound, []);
  assert.equal(result.htmlOutputPath, recordingPath);
  assert.match(await fs.readFile(recordingPath, "utf8"), /API-first where supported/);
});

test("discoverSiteRoutes returns same-origin nav/header/sidebar routes in stable order", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html>
    <html>
      <head><title>Routes</title></head>
      <body>
        <header><a href="/docs">Docs</a></header>
        <nav><a href="/pricing?tab=pro">Pricing</a></nav>
        <aside><a href="/docs">Docs duplicate</a><a href="https://external.test/">External</a></aside>
      </body>
    </html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  let result;
  try {
    result = await discoverSiteRoutes(`http://127.0.0.1:${port}/fixture.html`, {
      settleMs: 50,
      maxRoutes: 10
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(result.status, 200);
  assert.deepEqual(result.routes.map((route) => route.route), [
    "/fixture.html",
    "/pricing?tab=pro",
    "/docs"
  ]);
});
