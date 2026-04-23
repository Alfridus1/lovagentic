import path from "node:path";

import { parse as parseYaml } from "yaml";

const SUPPORTED_STEP_TYPES = new Set([
  "snapshot",
  "diff",
  "prompt",
  "fix",
  "wait",
  "verify",
  "publish",
  "liveassert",
  "metaassert",
  "routeassert",
  "publishconfirm"
]);

export function parseRunbookText(text, filePath = "runbook.yaml") {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return JSON.parse(text);
  }
  return parseYaml(text);
}

export function normalizeRunbook(input, overrides = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Runbook must be a JSON/YAML object.");
  }

  const defaults = input.defaults && typeof input.defaults === "object" && !Array.isArray(input.defaults)
    ? input.defaults
    : {};
  const projectUrl = overrides.projectUrl || input.projectUrl || defaults.projectUrl;
  if (!projectUrl) {
    throw new Error("Runbook requires `projectUrl` or --project-url.");
  }

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error("Runbook requires a non-empty `steps` array.");
  }

  const backend = normalizeBackend(overrides.backend || defaults.backend || input.backend || "api");
  const outputDir = overrides.outputDir || input.outputDir || defaults.outputDir || null;
  const steps = input.steps.map((step, index) => normalizeStep(step, index));

  return {
    name: input.name || path.basename(String(input.path || "runbook")),
    version: input.version || 1,
    projectUrl,
    backend,
    outputDir,
    defaults,
    steps
  };
}

export function normalizeStep(step, index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new Error(`Runbook step ${index + 1} must be an object.`);
  }

  const rawType = String(step.type || step.command || "").trim().toLowerCase();
  const type = canonicalizeStepType(rawType);
  if (!SUPPORTED_STEP_TYPES.has(type)) {
    throw new Error(`Runbook step ${index + 1} has unsupported type "${step.type || step.command}".`);
  }

  return {
    ...step,
    type,
    name: step.name || `${index + 1}. ${type}`
  };
}

export function getRunbookPlan(runbook) {
  return {
    name: runbook.name,
    projectUrl: runbook.projectUrl,
    backend: runbook.backend,
    outputDir: runbook.outputDir,
    steps: runbook.steps.map((step, index) => ({
      index: index + 1,
      name: step.name,
      type: step.type,
      mutates: stepMutates(step.type)
    }))
  };
}

export function stepMutates(type) {
  return ["prompt", "fix", "publish", "publishconfirm"].includes(type);
}

function normalizeBackend(value) {
  const normalized = String(value || "api").trim().toLowerCase();
  if (!["api", "auto", "browser"].includes(normalized)) {
    throw new Error(`Unsupported backend "${value}". Use api, auto, or browser.`);
  }
  return normalized;
}

function canonicalizeStepType(value) {
  const compact = String(value || "").replace(/[-_\s]/g, "");
  if (compact === "liveassert") return "liveassert";
  if (compact === "metaassert") return "metaassert";
  if (compact === "routeassert") return "routeassert";
  if (compact === "publishconfirm") return "publishconfirm";
  return value;
}
