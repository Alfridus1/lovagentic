import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const cliPath = path.join(repoRoot, "src/cli.js");

test("--version output matches package.json version", () => {
  const result = spawnSync(process.execPath, [cliPath, "--version"], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("cli source no longer hardcodes a version string literal", () => {
  const cliSrc = readFileSync(cliPath, "utf8");
  // Regex catches any `.version("0.1.x")` call with a literal - the fix
  // replaces this with `.version(PKG_VERSION)`.
  const hardcoded = cliSrc.match(/\.version\("[0-9]+\.[0-9]+\.[0-9]+/);
  assert.equal(hardcoded, null, `found hardcoded version literal: ${hardcoded?.[0]}`);
});
