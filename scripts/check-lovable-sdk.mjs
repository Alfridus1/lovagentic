#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PACKAGE_NAME = "@lovable.dev/sdk";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");

try {
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  const declared = packageJson.dependencies?.[PACKAGE_NAME] ?? packageJson.devDependencies?.[PACKAGE_NAME] ?? null;
  const installed = packageLock.packages?.[`node_modules/${PACKAGE_NAME}`]?.version ?? null;
  const latest = await npmView(PACKAGE_NAME, "version");
  const newerAvailable = Boolean(installed && latest && compareSemver(latest, installed) > 0);
  const result = {
    package: PACKAGE_NAME,
    declared,
    installed,
    latest,
    newerAvailable,
    ok: !newerAvailable
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (newerAvailable) {
    console.log(`${PACKAGE_NAME} update available: ${installed} -> ${latest}`);
  } else {
    console.log(`${PACKAGE_NAME} is current (${installed ?? "not installed"}).`);
  }

  process.exitCode = newerAvailable ? 1 : 0;
} catch (err) {
  const result = {
    package: PACKAGE_NAME,
    ok: false,
    error: err?.message || String(err)
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`Failed to check ${PACKAGE_NAME}: ${result.error}`);
  }
  process.exitCode = 2;
}

function npmView(packageName, field) {
  return new Promise((resolve, reject) => {
    execFile("npm", ["view", packageName, field], { cwd: repoRoot }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function parseSemver(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Unsupported semver version: ${version}`);
  }
  return match.slice(1).map(Number);
}
