import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "src/cli.js");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lovagentic-init-"));
}

function runInit(dir, args = []) {
  return spawnSync(process.execPath, [cliPath, "init", "--dir", dir, ...args], {
    encoding: "utf8"
  });
}

test("init scaffolds expected files with sane defaults", () => {
  const dir = makeTempDir();
  try {
    const result = runInit(dir, ["--project-url", "https://lovable.dev/projects/TEST"]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    assert.ok(fs.existsSync(path.join(dir, ".lovagentic.json")));
    assert.ok(fs.existsSync(path.join(dir, ".env.example")));
    assert.ok(fs.existsSync(path.join(dir, ".gitignore")));
    assert.ok(fs.existsSync(path.join(dir, "README.md")));
    assert.ok(fs.existsSync(path.join(dir, "prompts/example.md")));

    const config = JSON.parse(fs.readFileSync(path.join(dir, ".lovagentic.json"), "utf8"));
    assert.equal(config.version, 1);
    assert.equal(config.projectUrl, "https://lovable.dev/projects/TEST");
    assert.equal(typeof config.defaults, "object");
    assert.equal(config.defaults.verifyEffect, true);
    assert.equal(typeof config.ci, "object");

    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.env$/m);

    const env = fs.readFileSync(path.join(dir, ".env.example"), "utf8");
    assert.match(env, /LOVABLE_PROJECT_URL=https:\/\/lovable\.dev\/projects\/TEST/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init is idempotent: second run skips existing files", () => {
  const dir = makeTempDir();
  try {
    const first = runInit(dir);
    assert.equal(first.status, 0);
    const firstConfig = fs.readFileSync(path.join(dir, ".lovagentic.json"), "utf8");

    const second = runInit(dir);
    assert.equal(second.status, 0);
    const secondConfig = fs.readFileSync(path.join(dir, ".lovagentic.json"), "utf8");

    assert.equal(firstConfig, secondConfig, "config should be unchanged after second run without --force");
    assert.match(second.stdout, /skipped/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init --force overwrites existing files", () => {
  const dir = makeTempDir();
  try {
    runInit(dir, ["--project-url", "https://lovable.dev/projects/FIRST"]);
    const second = runInit(dir, ["--project-url", "https://lovable.dev/projects/SECOND", "--force"]);
    assert.equal(second.status, 0);

    const config = JSON.parse(fs.readFileSync(path.join(dir, ".lovagentic.json"), "utf8"));
    assert.equal(config.projectUrl, "https://lovable.dev/projects/SECOND");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init --json emits machine-readable output with filesCreated list", () => {
  const dir = makeTempDir();
  try {
    const result = runInit(dir, ["--json"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.targetDir, dir);
    assert.ok(Array.isArray(parsed.filesCreated));
    assert.ok(parsed.filesCreated.includes(".lovagentic.json"));
    assert.ok(parsed.filesCreated.includes(".env.example"));
    assert.ok(parsed.filesCreated.includes("prompts/example.md"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init preserves existing .gitignore and appends .env if missing", () => {
  const dir = makeTempDir();
  try {
    const existing = "node_modules/\ndist/\n";
    fs.writeFileSync(path.join(dir, ".gitignore"), existing, "utf8");

    runInit(dir);

    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    assert.match(gitignore, /node_modules/);
    assert.match(gitignore, /^dist\/$/m);
    assert.match(gitignore, /^\.env$/m, "should have added .env entry");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
