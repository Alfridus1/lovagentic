import fs from "node:fs/promises";
import path from "node:path";

import { normalizeTargetUrl } from "./url.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;

export function getProjectIdFromTarget(targetUrl) {
  const raw = String(targetUrl || "").trim();
  if (!raw) {
    throw new Error("Target URL or project id is required.");
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }

  const normalizedUrl = normalizeTargetUrl(raw);
  const match = normalizedUrl.match(/\/projects\/([^/?#]+)/);
  if (!match) {
    throw new Error(`Could not extract a Lovable project id from ${targetUrl}`);
  }

  return decodeURIComponent(match[1]);
}

export function buildLovableProjectUrl(projectId) {
  return `https://lovable.dev/projects/${projectId}`;
}

export async function buildApiSnapshot(apiBackend, targetUrl, options = {}) {
  const projectId = getProjectIdFromTarget(targetUrl);
  const generatedAt = new Date().toISOString();
  const project = await apiBackend.getProjectState(projectId);
  const workspaceId = project.workspace_id || project.workspaceId || project.workspace?.id || null;
  const ref = options.ref || project.latest_commit_sha || project.main_branch || "HEAD";
  const maxFiles = normalizePositiveInteger(options.maxFiles, 500);
  const maxEdits = normalizePositiveInteger(options.maxEdits, 50);

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    backend: "api",
    projectUrl: buildLovableProjectUrl(projectId),
    projectId,
    previewUrl: apiBackend.getPreviewUrl(projectId),
    publishedUrl: null,
    project,
    workspace: {
      id: workspaceId,
      details: null
    },
    knowledge: null,
    files: null,
    fileContents: null,
    edits: null,
    database: null,
    mcp: null,
    warnings: []
  };

  snapshot.publishedUrl = await maybeCall(() => apiBackend.getPublishedUrl(projectId), {
    warnings: snapshot.warnings,
    label: "published URL"
  });

  if (workspaceId && options.workspace !== false && typeof apiBackend.getWorkspace === "function") {
    snapshot.workspace.details = await maybeCall(() => apiBackend.getWorkspace(workspaceId), {
      warnings: snapshot.warnings,
      label: "workspace details"
    });
  }

  if (options.knowledge !== false) {
    const projectKnowledge = await maybeCall(() => apiBackend.getProjectKnowledge(projectId), {
      warnings: snapshot.warnings,
      label: "project knowledge"
    });
    const workspaceKnowledge = workspaceId
      ? await maybeCall(() => apiBackend.getWorkspaceKnowledge(workspaceId), {
        warnings: snapshot.warnings,
        label: "workspace knowledge"
      })
      : null;

    snapshot.knowledge = {
      project: projectKnowledge?.content ?? projectKnowledge ?? null,
      workspace: workspaceKnowledge?.content ?? workspaceKnowledge ?? null
    };
  }

  let files = [];
  let filesTruncated = false;
  if (options.files !== false) {
    const filesResponse = await maybeCall(() => apiBackend.listFiles(projectId, ref), {
      warnings: snapshot.warnings,
      label: "file list"
    });
    const allFiles = normalizeFileEntries(filesResponse);
    files = allFiles.slice(0, maxFiles);
    const total = allFiles.length;
    filesTruncated = total > files.length;
    if (filesTruncated) {
      snapshot.warnings.push(
        `Files truncated: showing ${files.length} of ${total} entries; pass --max-files <n> to widen.`
      );
    }
    snapshot.files = {
      ref,
      total,
      returned: files.length,
      truncated: total > files.length,
      entries: files.map((entry) => ({
        path: entry.path,
        type: entry.binary ? "binary" : "file",
        size: entry.size ?? null,
        binary: Boolean(entry.binary)
      }))
    };

    if (options.fileContent) {
      const contents = [];
      for (const entry of files) {
        if (!entry.path || entry.binary) {
          continue;
        }
        try {
          const content = await apiBackend.readFile(projectId, entry.path, ref);
          contents.push({
            path: entry.path,
            size: Buffer.byteLength(String(content), "utf8"),
            content
          });
        } catch (err) {
          snapshot.warnings.push(`Could not read ${entry.path}: ${err?.message || String(err)}`);
        }
      }
      snapshot.fileContents = {
        ref,
        total: contents.length,
        entries: contents
      };
    }
  }

  if (options.edits !== false) {
    const editsResponse = await maybeCall(() => apiBackend.listEdits(projectId, { limit: maxEdits }), {
      warnings: snapshot.warnings,
      label: "edit history"
    });
    snapshot.edits = {
      limit: maxEdits,
      total: editsResponse?.edits?.length ?? 0,
      hasMore: Boolean(editsResponse?.has_more),
      entries: editsResponse?.edits ?? []
    };
  }

  // Database state (Lovable Cloud / Supabase). Cheap one-shot call;
  // returns `{ enabled: false }` for projects without a managed DB and
  // `{ enabled: true, stack: "supabase" }` for those with one. Disabled
  // by default if the caller passes `database: false`.
  if (options.database !== false && typeof apiBackend.getDatabaseStatus === "function") {
    snapshot.database = await maybeCall(() => apiBackend.getDatabaseStatus(projectId), {
      warnings: snapshot.warnings,
      label: "database status"
    });
  }

  if (options.mcp && workspaceId) {
    const installedConnectors = await maybeCall(() => apiBackend.listConnectors(workspaceId), {
      warnings: snapshot.warnings,
      label: "connectors"
    });
    snapshot.mcp = {
      servers: installedConnectors,
      installedConnectors,
      connectors: await maybeCall(() => apiBackend.listMCPConnectors(workspaceId), {
        warnings: snapshot.warnings,
        label: "MCP connectors"
      }),
      catalog: await maybeCall(() => apiBackend.listAvailableConnectors(workspaceId), {
        warnings: snapshot.warnings,
        label: "connector catalog"
      })
    };
  }

  return snapshot;
}

export async function buildApiDiff(apiBackend, targetUrl, options = {}) {
  const projectId = getProjectIdFromTarget(targetUrl);
  const params = {};
  let resolvedLatest = null;

  if (options.latest) {
    const editsResponse = await apiBackend.listEdits(projectId, { limit: 1 });
    const latest = editsResponse?.edits?.[0];
    if (!latest) {
      throw new Error("No edits found for this project; cannot resolve --latest.");
    }
    resolvedLatest = latest;
    if (latest.commit_sha) {
      params.sha = latest.commit_sha;
    } else {
      throw new Error("Latest edit does not include a commit sha. Pass --message-id or --sha explicitly.");
    }
  }

  if (options.messageId) {
    params.messageId = options.messageId;
  }
  if (options.sha) {
    params.sha = options.sha;
  }
  if (options.baseSha) {
    params.baseSha = options.baseSha;
  }

  if (!params.messageId && !params.sha) {
    throw new Error("diff requires --message-id, --sha, or --latest.");
  }

  const diff = await apiBackend.getDiff(projectId, params);
  const summary = summarizeApiDiff(diff);
  return {
    backend: "api",
    projectUrl: buildLovableProjectUrl(projectId),
    projectId,
    params,
    latestEdit: resolvedLatest,
    summary,
    diff
  };
}

export function summarizeApiDiff(diff) {
  const entries = Array.isArray(diff?.diffs) ? diff.diffs : [];
  const summary = {
    filesChanged: entries.length,
    additions: 0,
    deletions: 0,
    incompleteFiles: 0,
    files: []
  };

  for (const entry of entries) {
    let additions = 0;
    let deletions = 0;
    const hunks = Array.isArray(entry.hunks) ? entry.hunks : [];
    for (const hunk of hunks) {
      for (const line of hunk.lines ?? []) {
        const type = String(line.type || "").toLowerCase();
        const content = String(line.content || "");
        if (type.includes("add") || content.startsWith("+")) additions += 1;
        if (type.includes("delete") || type.includes("remove") || content.startsWith("-")) deletions += 1;
      }
    }
    if (entry.is_incomplete) summary.incompleteFiles += 1;
    summary.additions += additions;
    summary.deletions += deletions;
    summary.files.push({
      path: entry.file_path || entry.path || null,
      originalPath: entry.original_file_path || null,
      action: entry.action || "modified",
      fileType: entry.file_type || null,
      isImage: Boolean(entry.is_image),
      isIncomplete: Boolean(entry.is_incomplete),
      additions,
      deletions
    });
  }

  return summary;
}

export async function writeJsonFile(filePath, data) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, JSON.stringify(data, null, 2) + "\n", "utf8");
  return resolved;
}

export function formatSnapshotSummary(snapshot) {
  const dbStatus = snapshot.database
    ? snapshot.database.enabled
      ? `enabled (${snapshot.database.stack || "unknown stack"})`
      : "not enabled"
    : "skipped";
  const filesLine = snapshot.files
    ? snapshot.files.truncated
      ? `⚠️  ${snapshot.files.returned}/${snapshot.files.total} (truncated; pass --max-files <n> to widen)`
      : `${snapshot.files.returned}/${snapshot.files.total}`
    : "skipped";
  const lines = [
    `Snapshot: ${snapshot.project?.display_name || snapshot.project?.name || snapshot.projectId}`,
    `Project: ${snapshot.projectUrl}`,
    `Preview: ${snapshot.previewUrl}`,
    `Published: ${snapshot.publishedUrl || "(not published or unavailable)"}`,
    `Files: ${filesLine}`,
    `File contents: ${snapshot.fileContents ? snapshot.fileContents.total : "skipped"}`,
    `Edits: ${snapshot.edits ? `${snapshot.edits.total}${snapshot.edits.hasMore ? "+" : ""}` : "skipped"}`,
    `Knowledge: ${snapshot.knowledge ? "included" : "skipped"}`,
    `Database: ${dbStatus}`,
    `Warnings: ${snapshot.warnings.length}`
  ];
  if (snapshot.warnings.length) {
    for (const w of snapshot.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

export function formatDiffSummary(diffState) {
  const { summary } = diffState;
  const lines = [
    `Diff: ${diffState.projectUrl}`,
    `Files changed: ${summary.filesChanged}`,
    `Additions: ${summary.additions}`,
    `Deletions: ${summary.deletions}`,
    `Incomplete files: ${summary.incompleteFiles}`
  ];

  for (const file of summary.files.slice(0, 20)) {
    lines.push(`  - ${file.action} ${file.path} (+${file.additions}/-${file.deletions})`);
  }
  if (summary.files.length > 20) {
    lines.push(`  ... ${summary.files.length - 20} more files`);
  }

  return lines.join("\n");
}

function normalizeFileEntries(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response.filter((entry) => entry && entry.path);
  if (Array.isArray(response.files)) return response.files.filter((entry) => entry && entry.path);
  return [];
}

async function maybeCall(fn, { warnings, label }) {
  try {
    return await fn();
  } catch (err) {
    warnings.push(`Could not read ${label}: ${err?.message || String(err)}`);
    return null;
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}
