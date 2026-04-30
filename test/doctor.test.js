// Regression tests for the `doctor` LaunchAgent detection logic.
//
// History: lovagentic 0.3.4 introduced a doctor row that reports whether the
// macOS auth-refresh LaunchAgent is installed. The first cut of the check
// used `os.homedir()` while `os` was not imported in `src/cli.js`. The
// surrounding `try/catch` swallowed the `ReferenceError`, so `doctor` always
// reported "not installed", even on systems that had the plist in place.
//
// These tests pin the behaviour so that future refactors do not silently
// regress the same way:
//
//  - the canonical plist path is `<home>/Library/LaunchAgents/com.lovagentic.auth-refresh.plist`,
//  - present-and-readable plist => `installed: true`,
//  - missing plist             => `installed: false`,
//  - any thrown stat error     => `installed: false` (soft fail).

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import {
  getDoctorLaunchAgentPlistPath,
  isDoctorLaunchAgentInstalled,
} from "../src/doctor.js";

test("getDoctorLaunchAgentPlistPath resolves to ~/Library/LaunchAgents/com.lovagentic.auth-refresh.plist", () => {
  const result = getDoctorLaunchAgentPlistPath({ homeDir: "/Users/test" });
  assert.equal(
    result,
    path.join("/Users/test", "Library", "LaunchAgents", "com.lovagentic.auth-refresh.plist")
  );
});

test("isDoctorLaunchAgentInstalled returns true when the plist exists as a file", () => {
  const expectedPath = path.join(
    "/Users/test",
    "Library",
    "LaunchAgents",
    "com.lovagentic.auth-refresh.plist"
  );
  let calledWith = null;
  const stat = (p) => {
    calledWith = p;
    return { isFile: () => true };
  };
  const installed = isDoctorLaunchAgentInstalled({ homeDir: "/Users/test", stat });
  assert.equal(installed, true);
  assert.equal(calledWith, expectedPath, "stat must be called with the canonical plist path");
});

test("isDoctorLaunchAgentInstalled returns false when the plist exists but is a directory", () => {
  const stat = () => ({ isFile: () => false });
  const installed = isDoctorLaunchAgentInstalled({ homeDir: "/Users/test", stat });
  assert.equal(installed, false);
});

test("isDoctorLaunchAgentInstalled returns false when stat throws ENOENT", () => {
  const stat = () => {
    const err = new Error("ENOENT: no such file or directory");
    err.code = "ENOENT";
    throw err;
  };
  const installed = isDoctorLaunchAgentInstalled({ homeDir: "/Users/test", stat });
  assert.equal(installed, false);
});

test("isDoctorLaunchAgentInstalled returns false when the helper throws ReferenceError", () => {
  // This is the exact failure mode that shipped in 0.3.4: an undefined
  // identifier inside the helper raised a ReferenceError that the
  // surrounding try/catch swallowed. We pin the soft-fail contract so the
  // bug cannot silently come back.
  const stat = () => {
    throw new ReferenceError("os is not defined");
  };
  const installed = isDoctorLaunchAgentInstalled({ homeDir: "/Users/test", stat });
  assert.equal(installed, false);
});

test("isDoctorLaunchAgentInstalled honours a caller-supplied homeDir", () => {
  let calledWith = null;
  const stat = (p) => {
    calledWith = p;
    return { isFile: () => true };
  };
  isDoctorLaunchAgentInstalled({ homeDir: "/Users/other", stat });
  assert.ok(
    calledWith && calledWith.startsWith("/Users/other/"),
    `expected stat path to start with /Users/other/, got ${calledWith}`
  );
});

// ---- self-heal contract ----
//
// `lovagentic doctor --self-heal` must trigger heal actions even for checks
// that report `ok: true` so long as they expose `healable: true`. This is
// the contract that powers the auth-bootstrap and LaunchAgent-install heal
// branches. Pinning it stops the next refactor from quietly re-adding the
// `!c.ok && c.healable` guard that was wrong in the first cut.
import { selfHealActionKeysFor } from "../src/doctor.js";

test("selfHealActionKeysFor selects healable checks regardless of ok status", () => {
  const checks = [
    { key: "node",                ok: true,  healable: false },
    { key: "chromium",            ok: false, healable: true },
    { key: "cliProfile",          ok: false, healable: true },
    { key: "lovableApiAuth",      ok: true,  healable: true },
    { key: "lovableAuthRefresh",  ok: true,  healable: true },
    { key: "lovableReachable",    ok: false, healable: false },
  ];
  const keys = selfHealActionKeysFor(checks);
  assert.deepEqual(keys.sort(), [
    "chromium",
    "cliProfile",
    "lovableApiAuth",
    "lovableAuthRefresh",
  ]);
});

test("selfHealActionKeysFor skips checks that are not healable, even when broken", () => {
  const checks = [
    { key: "lovableReachable", ok: false, healable: false },
    { key: "npmReachable",     ok: false, healable: false },
  ];
  assert.deepEqual(selfHealActionKeysFor(checks), []);
});
