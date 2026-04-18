#!/usr/bin/env node
/**
 * Release orchestrator for lovagentic.
 *
 * Responsibilities (in order):
 *   1. Verify working tree is clean and on main.
 *   2. Bump package.json version (patch | minor | major | x.y.z).
 *   3. Regenerate docs/commands.md via scripts/generate-command-reference.mjs.
 *   4. Run full check suite (lint/syntax + tests + command reference check).
 *   5. Commit bump + regenerated docs.
 *   6. Create git tag vX.Y.Z.
 *   7. Push main + tags.
 *   8. npm publish via scripts/publish-to-npm.mjs.
 *   9. Create GitHub release (gh CLI) using CHANGELOG.md section.
 *
 * Flags:
 *   --dry-run         Skip mutating commands (bump, commit, tag, push, publish, gh release).
 *   --skip-publish    Bump + commit + tag + push, but skip npm publish and gh release.
 *   --skip-gh         Publish to npm, but skip `gh release create`.
 *   --no-push         Commit + tag locally, skip `git push`.
 *   --allow-dirty     Skip clean-working-tree check.
 *   --branch <name>   Require a specific branch (default: main).
 *
 * Examples:
 *   node scripts/release.mjs patch
 *   node scripts/release.mjs minor --dry-run
 *   node scripts/release.mjs 0.2.0
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const flags = {
  dryRun: argv.includes("--dry-run"),
  skipPublish: argv.includes("--skip-publish"),
  skipGh: argv.includes("--skip-gh"),
  noPush: argv.includes("--no-push"),
  allowDirty: argv.includes("--allow-dirty")
};

function flagValue(name, fallback) {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  return argv[idx + 1];
}
const requiredBranch = flagValue("--branch", "main");

const bumpTarget = argv.find((arg) => !arg.startsWith("--") && arg !== requiredBranch);
if (!bumpTarget) {
  fail(
    "Missing bump target.\nUsage: release.mjs <patch|minor|major|x.y.z> [flags]\n\nSee script header for flags."
  );
}

function log(msg) {
  process.stdout.write(`\x1b[36m▶\x1b[0m ${msg}\n`);
}
function ok(msg) {
  process.stdout.write(`\x1b[32m✓\x1b[0m ${msg}\n`);
}
function warn(msg) {
  process.stdout.write(`\x1b[33m!\x1b[0m ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`\x1b[31m✗\x1b[0m ${msg}\n`);
  process.exit(1);
}

function runSync(cmd, args, { allowFailure = false } = {}) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    fail(
      `Command failed: ${cmd} ${args.join(" ")}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`
    );
  }
  return result;
}

function runInherit(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function bumpSemver(current, target) {
  if (/^\d+\.\d+\.\d+$/.test(target)) return target;
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) fail(`Cannot parse current version: ${current}`);
  let [, major, minor, patch] = match;
  major = Number(major);
  minor = Number(minor);
  patch = Number(patch);
  switch (target) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      fail(`Invalid bump target: ${target}. Use patch|minor|major|x.y.z.`);
  }
}

function extractChangelogSection(version) {
  const p = path.join(repoRoot, "CHANGELOG.md");
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, "utf8");
  // Match `## [VERSION] - DATE` block up to the next `## [` header.
  const pattern = new RegExp(
    `##\\s+\\[${version.replace(/\./g, "\\.")}\\][\\s\\S]*?(?=\\n##\\s+\\[|$)`
  );
  const match = text.match(pattern);
  return match ? match[0].trim() : null;
}

async function main() {
  // --- 1. Preflight ---
  log("Preflight checks");
  const branch = runSync("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (branch !== requiredBranch) {
    fail(`Expected branch '${requiredBranch}', got '${branch}'. Use --branch <name> to override.`);
  }
  const status = runSync("git", ["status", "--porcelain"]).stdout.trim();
  if (status && !flags.allowDirty) {
    fail(
      `Working tree is dirty. Commit or stash before releasing, or pass --allow-dirty.\n${status}`
    );
  }
  ok(`On branch ${branch}, tree ${status ? "dirty (allowed)" : "clean"}`);

  // --- 2. Bump version ---
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = readJson(pkgPath);
  const currentVersion = pkg.version;
  const nextVersion = bumpSemver(currentVersion, bumpTarget);
  const tag = `v${nextVersion}`;

  log(`Bumping version ${currentVersion} → ${nextVersion}`);
  if (!flags.dryRun) {
    pkg.version = nextVersion;
    writeJson(pkgPath, pkg);
  }

  // --- 3. Regenerate command reference ---
  log("Regenerating docs/commands.md");
  await runInherit("node", ["./scripts/generate-command-reference.mjs"]);
  ok("docs/commands.md in sync");

  // --- 4. Full check suite ---
  log("Running full check suite (syntax + tests + command reference)");
  await runInherit("npm", ["run", "check"]);
  ok("All checks green");

  // --- 5. Commit bump + regen ---
  if (flags.dryRun) {
    warn("--dry-run: skipping commit, tag, push, publish, gh release");
    ok(`Dry-run complete. Would release ${tag}.`);
    return;
  }

  log(`Committing release ${tag}`);
  runSync("git", ["add", "package.json", "docs/commands.md"]);

  // Include CHANGELOG.md if it was modified (common pattern).
  const stagedStatus = runSync("git", ["status", "--porcelain"]).stdout;
  if (stagedStatus.includes("CHANGELOG.md")) {
    runSync("git", ["add", "CHANGELOG.md"]);
  }

  runSync("git", ["commit", "-m", `chore(release): ${tag}`]);

  // --- 6. Tag ---
  log(`Creating git tag ${tag}`);
  runSync("git", ["tag", tag]);

  // --- 7. Push ---
  if (flags.noPush) {
    warn("--no-push: skipping git push");
  } else {
    log("Pushing branch + tags to origin");
    runSync("git", ["push", "origin", requiredBranch]);
    runSync("git", ["push", "origin", tag]);
    ok("Pushed");
  }

  // --- 8. npm publish ---
  if (flags.skipPublish) {
    warn("--skip-publish: skipping npm publish and gh release");
    ok(`Release ${tag} committed + tagged locally`);
    return;
  }

  log(`Publishing ${pkg.name}@${nextVersion} to npm`);
  await runInherit("node", ["./scripts/publish-to-npm.mjs"]);
  ok(`${pkg.name}@${nextVersion} on npm`);

  // --- 9. GitHub release ---
  if (flags.skipGh) {
    warn("--skip-gh: skipping GitHub release creation");
    return;
  }

  const changelogSection = extractChangelogSection(nextVersion);
  const notes = changelogSection
    ? `${changelogSection}\n\n**Install:**\n\n\`\`\`bash\nnpm install -g ${pkg.name}@${nextVersion}\n\`\`\``
    : `Release ${tag}.\n\nSee [CHANGELOG.md](https://github.com/Alfridus1/lovagentic/blob/main/CHANGELOG.md) for details.`;

  log(`Creating GitHub release ${tag}`);
  const ghResult = spawnSync(
    "gh",
    ["release", "create", tag, "--title", `${tag} — ${pkg.name}`, "--notes", notes],
    { cwd: repoRoot, encoding: "utf8" }
  );

  if (ghResult.status !== 0) {
    warn(
      `gh release create exited with code ${ghResult.status}. stderr:\n${ghResult.stderr}\n\nCreate the release manually: gh release create ${tag}`
    );
  } else {
    ok(`GitHub release ${tag} published`);
    process.stdout.write(ghResult.stdout);
  }

  ok(`Release ${tag} done. 🚀`);
}

main().catch((error) => {
  fail(error.message);
});
