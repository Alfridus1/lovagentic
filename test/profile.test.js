import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PROFILE_SEED_ENTRIES } from "../src/config.js";
import { pathExists, seedDesktopProfileIntoPlaywrightDefault } from "../src/profile.js";

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeSeedEntry(baseDir, entry) {
  const targetPath = path.join(baseDir, entry);

  if (["IndexedDB", "Local Storage", "Session Storage"].includes(entry)) {
    await fs.mkdir(targetPath, { recursive: true });
    for (let index = 0; index < 25; index += 1) {
      await fs.writeFile(
        path.join(targetPath, `fixture-${index}.txt`),
        `${entry} fixture ${index}\n`
      );
    }
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${entry} fixture\n`);
}

test("seedDesktopProfileIntoPlaywrightDefault tolerates concurrent force seeding on the same target", async () => {
  const sourceDir = await makeTempDir("lovagentic-profile-source-");
  const targetDir = await makeTempDir("lovagentic-profile-target-");

  try {
    await Promise.all(PROFILE_SEED_ENTRIES.map((entry) => writeSeedEntry(sourceDir, entry)));

    const results = await Promise.all(
      Array.from({ length: 6 }, () => {
        return seedDesktopProfileIntoPlaywrightDefault({
          fromDir: sourceDir,
          toDir: targetDir,
          force: true
        });
      })
    );

    for (const result of results) {
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.copied.sort(), [...PROFILE_SEED_ENTRIES].sort());
      assert.equal(result.targetDefaultDir, path.join(targetDir, "Default"));
    }

    for (const entry of PROFILE_SEED_ENTRIES) {
      assert.equal(
        await pathExists(path.join(targetDir, "Default", entry)),
        true,
        `Expected copied profile entry ${entry} to exist`
      );
    }

    assert.equal(
      await pathExists(path.join(targetDir, "Default", ".profile-seed.lock")),
      false
    );
  } finally {
    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(targetDir, { recursive: true, force: true });
  }
});
