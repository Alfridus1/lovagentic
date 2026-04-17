import fs from "node:fs/promises";
import path from "node:path";

import { PROFILE_SEED_ENTRIES } from "./config.js";

const DEFAULT_SEED_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_SEED_LOCK_POLL_MS = 100;

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDirectory(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function withFileLock(lockPath, callback, {
  timeoutMs = DEFAULT_SEED_LOCK_TIMEOUT_MS,
  pollMs = DEFAULT_SEED_LOCK_POLL_MS
} = {}) {
  await ensureDirectory(path.dirname(lockPath));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let handle = null;

    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      return await callback();
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }

  throw new Error(`Timed out waiting for profile seed lock: ${lockPath}`);
}

export async function copyProfileSeed({
  fromDir,
  toDir,
  force = false
}) {
  if (path.resolve(fromDir) === path.resolve(toDir)) {
    throw new Error("Source and destination profile paths must be different.");
  }

  if (!(await pathExists(fromDir))) {
    throw new Error(`Source profile does not exist: ${fromDir}`);
  }

  await ensureDirectory(toDir);
  return withFileLock(path.join(toDir, ".profile-seed.lock"), async () => {
    if (force) {
      for (const entry of PROFILE_SEED_ENTRIES) {
        await fs.rm(path.join(toDir, entry), { recursive: true, force: true });
      }
    }

    const copied = [];
    const skipped = [];

    for (const entry of PROFILE_SEED_ENTRIES) {
      const sourcePath = path.join(fromDir, entry);
      const destinationPath = path.join(toDir, entry);

      if (!(await pathExists(sourcePath))) {
        skipped.push(entry);
        continue;
      }

      await fs.cp(sourcePath, destinationPath, {
        force: true,
        recursive: true
      });
      copied.push(entry);
    }

    return { copied, skipped };
  });
}

export async function seedDesktopProfileIntoPlaywrightDefault({
  fromDir,
  toDir,
  force = false
}) {
  const targetDefaultDir = path.join(toDir, "Default");
  await ensureDirectory(targetDefaultDir);
  return withFileLock(path.join(targetDefaultDir, ".profile-seed.lock"), async () => {
    if (force) {
      for (const entry of PROFILE_SEED_ENTRIES) {
        await fs.rm(path.join(targetDefaultDir, entry), { recursive: true, force: true });
      }
    }

    const copied = [];
    const skipped = [];

    for (const entry of PROFILE_SEED_ENTRIES) {
      const sourcePath = path.join(fromDir, entry);
      const destinationPath = path.join(targetDefaultDir, entry);

      if (!(await pathExists(sourcePath))) {
        skipped.push(entry);
        continue;
      }

      await fs.cp(sourcePath, destinationPath, {
        force: true,
        recursive: true
      });
      copied.push(entry);
    }

    return {
      copied,
      skipped,
      targetDefaultDir
    };
  });
}
