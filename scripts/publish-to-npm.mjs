#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { shouldTreatPublishFailureAsSuccess } from "../src/publish.js";

const DEFAULT_VERIFY_TIMEOUT_MS = 90_000;
const DEFAULT_VERIFY_POLL_MS = 5_000;

async function readPackageMetadata() {
  const packageJsonPath = path.resolve(process.cwd(), "package.json");
  const raw = await fs.readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw);

  if (!pkg.name || !pkg.version) {
    throw new Error("package.json must define name and version before publishing.");
  }

  return {
    name: String(pkg.name),
    version: String(pkg.version)
  };
}

async function runCommand(command, args, {
  env = process.env,
  tolerateFailure = false,
  silent = false
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ["inherit", "pipe", "pipe"]
    });

    let combinedOutput = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      combinedOutput += text;
      if (!silent) {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      combinedOutput += text;
      if (!silent) {
        process.stderr.write(text);
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: code ?? 1,
        output: combinedOutput
      };

      if (result.code === 0 || tolerateFailure) {
        resolve(result);
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${result.code}`));
    });
  });
}

async function getCurrentGitHead() {
  const result = await runCommand("git", ["rev-parse", "HEAD"], {
    tolerateFailure: true,
    silent: true
  });
  if (result.code !== 0) {
    return null;
  }

  const lines = result.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines[lines.length - 1] || null;
}

async function getPublishedGitHead(name, version) {
  const result = await runCommand("npm", ["view", `${name}@${version}`, "gitHead", "--json"], {
    tolerateFailure: true
  });
  if (result.code !== 0) {
    return null;
  }

  const value = result.output.trim();
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value.replace(/^"+|"+$/g, "");
  }
}

async function waitForPublishedVersion({
  name,
  version,
  currentGitHead,
  publishOutput,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  pollMs = DEFAULT_VERIFY_POLL_MS
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const publishedGitHead = await getPublishedGitHead(name, version);
    const verdict = shouldTreatPublishFailureAsSuccess({
      publishOutput,
      currentGitHead,
      publishedGitHead
    });

    if (verdict.ok) {
      return {
        ok: true,
        reason: verdict.reason,
        publishedGitHead
      };
    }

    if (publishedGitHead && verdict.reason === "published_githead_mismatch") {
      return {
        ok: false,
        reason: verdict.reason,
        publishedGitHead
      };
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }

  return {
    ok: false,
    reason: "verify_timeout",
    publishedGitHead: null
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const { name, version } = await readPackageMetadata();
  const currentGitHead = await getCurrentGitHead();
  const publishArgs = dryRun
    ? ["pack", "--dry-run"]
    : ["publish", "--provenance", "--access", "public"];

  const publishResult = await runCommand("npm", publishArgs, {
    tolerateFailure: true
  });

  if (publishResult.code === 0) {
    return;
  }

  if (dryRun) {
    process.exitCode = publishResult.code;
    return;
  }

  console.warn(
    `npm publish exited with code ${publishResult.code}. Checking whether ${name}@${version} actually reached the registry...`
  );

  const verification = await waitForPublishedVersion({
    name,
    version,
    currentGitHead,
    publishOutput: publishResult.output
  });

  if (verification.ok) {
    console.warn(
      `Publish verification succeeded: ${name}@${version} is already in npm with gitHead ${verification.publishedGitHead}. Treating ${verification.reason} as success.`
    );
    return;
  }

  if (verification.reason === "published_githead_mismatch") {
    throw new Error(
      `npm registry already has ${name}@${version}, but its gitHead (${verification.publishedGitHead}) does not match the current checkout (${currentGitHead || "unknown"}).`
    );
  }

  process.exitCode = publishResult.code;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
