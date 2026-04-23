import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  extractCommandSections,
  getMcpDocumentKeys,
  readCommandReference,
  readRepoDocument
} from "../src/mcp-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "src/cli.js");

test("readRepoDocument exposes packaged repo docs by stable key", async () => {
  assert.deepEqual(getMcpDocumentKeys().slice(0, 3), ["readme", "commands", "agents"]);
  const readme = await readRepoDocument("readme", { repoRoot, maxBytes: 20_000 });
  assert.equal(readme.path, "README.md");
  assert.match(readme.text, /lovagentic/i);
});

test("command reference extraction filters generated command sections", async () => {
  const reference = await readCommandReference({ repoRoot, query: "site-check", limit: 2 });
  assert.equal(reference.count >= 1, true);
  assert.match(reference.text, /site-check/);

  const sections = extractCommandSections("## first\nabc\n\n## second\nsite-check\n\n## third\nsite-check", {
    query: "site-check",
    limit: 1
  });
  assert.deepEqual(sections.map((section) => section.title), ["second"]);
});

test("mcp-server help advertises HTTP and stdio transports", () => {
  const result = spawnSync(process.execPath, [cliPath, "mcp-server", "--help"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--stdio/);
  assert.match(result.stdout, /--endpoint/);
});

test("mcp-server stdio exposes read-only docs and command tools", { timeout: 20_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "mcp-server", "--stdio"],
    cwd: repoRoot,
    stderr: "pipe"
  });
  const client = new Client({
    name: "lovagentic-test",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "read_repo_doc"));
    assert.ok(tools.tools.some((tool) => tool.name === "command_reference"));

    const commandResult = await client.callTool({
      name: "command_reference",
      arguments: { query: "site-check", limit: 1 }
    });
    const commandText = commandResult.content.find((item) => item.type === "text")?.text ?? "";
    assert.match(commandText, /site-check/);

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "lovagentic://repo/readme"));

    const readme = await client.readResource({ uri: "lovagentic://repo/readme" });
    const readmeText = readme.contents.find((item) => item.text)?.text ?? "";
    assert.match(readmeText, /lovagentic/i);
  } finally {
    await client.close().catch(() => {});
  }
});
