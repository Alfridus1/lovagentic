import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const __dirname_mcp = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname_mcp, "..");
const DEFAULT_GITHUB_REPO = "Alfridus1/lovagentic";
const DEFAULT_DOCS = {
  readme: {
    path: "README.md",
    title: "README",
    description: "Project overview, installation, core workflow, and command map.",
    mimeType: "text/markdown"
  },
  commands: {
    path: "docs/commands.md",
    title: "Command Reference",
    description: "Generated lovagentic CLI command reference.",
    mimeType: "text/markdown"
  },
  agents: {
    path: "AGENTS.md",
    title: "Agent Instructions",
    description: "Repository operating guide for coding agents.",
    mimeType: "text/markdown"
  },
  changelog: {
    path: "CHANGELOG.md",
    title: "Changelog",
    description: "Release notes and user-facing changes.",
    mimeType: "text/markdown"
  },
  releases: {
    path: "docs/releases.md",
    title: "Release Runbook",
    description: "Release process and automation notes.",
    mimeType: "text/markdown"
  },
  package: {
    path: "package.json",
    title: "Package Metadata",
    description: "npm package metadata, scripts, files, and dependencies.",
    mimeType: "application/json"
  }
};

export function getDefaultMcpRepoRoot() {
  return DEFAULT_REPO_ROOT;
}

export function getMcpDocumentKeys() {
  return Object.keys(DEFAULT_DOCS);
}

export async function readRepoDocument(doc, options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const spec = DEFAULT_DOCS[doc];
  if (!spec) {
    throw new Error(`Unknown repo document "${doc}". Expected one of: ${getMcpDocumentKeys().join(", ")}`);
  }

  const absolutePath = path.resolve(repoRoot, spec.path);
  if (!absolutePath.startsWith(`${repoRoot}${path.sep}`) && absolutePath !== repoRoot) {
    throw new Error(`Refusing to read outside repo root: ${absolutePath}`);
  }

  const text = await fs.readFile(absolutePath, "utf8");
  const maxBytes = clampInteger(options.maxBytes, 1000, 250_000, 80_000);
  return {
    doc,
    title: spec.title,
    description: spec.description,
    path: spec.path,
    mimeType: spec.mimeType,
    text: truncateUtf8(text, maxBytes)
  };
}

export function extractCommandSections(markdown, options = {}) {
  const query = String(options.query ?? "").trim().toLowerCase();
  const limit = clampInteger(options.limit, 1, 50, 10);
  const sections = markdown
    .split(/(?=^##\s+)/m)
    .map((section) => section.trim())
    .filter((section) => section.startsWith("## "))
    .filter((section) => !/^##\s+Contents\b/i.test(section));

  const filtered = query
    ? sections.filter((section) => section.toLowerCase().includes(query))
    : sections;

  return filtered.slice(0, limit).map((section) => {
    const title = section.split("\n", 1)[0].replace(/^##\s+/, "").trim();
    return { title, markdown: section };
  });
}

export async function readCommandReference(options = {}) {
  const doc = await readRepoDocument("commands", options);
  const sections = extractCommandSections(doc.text, options);
  const text = sections.length > 0
    ? sections.map((section) => section.markdown).join("\n\n")
    : `No command reference sections matched "${options.query}".`;
  return {
    query: options.query ?? "",
    count: sections.length,
    sections,
    text
  };
}

export function createLovagenticMcpServer(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const githubRepo = options.githubRepo || process.env.LOVAGENTIC_GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const pkg = readPackageMetadata(repoRoot);
  const server = new McpServer({
    name: "lovagentic",
    version: pkg.version ?? "0.0.0",
    websiteUrl: pkg.homepage ?? "https://github.com/Alfridus1/lovagentic"
  }, {
    capabilities: { logging: {} }
  });

  registerRepoResources(server, { repoRoot, githubRepo });
  registerRepoTools(server, { repoRoot, githubRepo, githubToken: options.githubToken ?? process.env.GITHUB_TOKEN });
  registerPromptTemplates(server);

  return server;
}

export async function runLovagenticMcpServer(options = {}) {
  const transport = options.transport === "stdio" || options.stdio ? "stdio" : "http";
  if (transport === "stdio") {
    const server = createLovagenticMcpServer(options);
    await server.connect(new StdioServerTransport());
    return {
      transport,
      server,
      close: () => server.close()
    };
  }

  const host = options.host || process.env.HOST || "127.0.0.1";
  const port = clampInteger(options.port ?? process.env.PORT, 1, 65_535, 8787);
  const endpoint = normalizeEndpoint(options.endpoint || "/mcp");
  const token = options.token ?? process.env.LOVAGENTIC_MCP_TOKEN ?? null;
  const app = createMcpExpressApp({
    host,
    allowedHosts: options.allowedHosts?.length ? options.allowedHosts : undefined
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "lovagentic-mcp",
      transport: "streamable-http"
    });
  });

  app.use(endpoint, (req, res, next) => {
    if (!token) {
      next();
      return;
    }
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null
      });
      return;
    }
    next();
  });

  app.post(endpoint, async (req, res) => {
    const server = createLovagenticMcpServer(options);
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    try {
      await server.connect(httpTransport);
      await httpTransport.handleRequest(req, res, req.body);
      res.on("close", () => {
        httpTransport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (err) {
      console.error("MCP request failed:", err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  app.get(endpoint, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    });
  });

  app.delete(endpoint, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    });
  });

  const listener = await new Promise((resolve, reject) => {
    const started = app.listen(port, host, () => resolve(started));
    started.on("error", reject);
  });

  return {
    transport,
    host,
    port,
    endpoint,
    tokenRequired: Boolean(token),
    url: `http://${host}:${port}${endpoint}`,
    listener,
    close: () => new Promise((resolve, reject) => {
      listener.close((err) => err ? reject(err) : resolve());
    })
  };
}

function registerRepoResources(server, options) {
  for (const [doc, spec] of Object.entries(DEFAULT_DOCS)) {
    server.registerResource(
      `repo-${doc}`,
      `lovagentic://repo/${doc}`,
      {
        title: spec.title,
        description: spec.description,
        mimeType: spec.mimeType
      },
      async (uri) => {
        const document = await readRepoDocument(doc, options);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: document.mimeType,
              text: document.text
            }
          ]
        };
      }
    );
  }

  server.registerResource(
    "github-open-issues",
    "lovagentic://github/issues",
    {
      title: "GitHub Open Issues",
      description: "Latest open non-PR issues from the public lovagentic repository.",
      mimeType: "application/json"
    },
    async (uri) => {
      const issues = await listGitHubIssues({ repo: options.githubRepo, state: "open", limit: 20 });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(issues, null, 2)
          }
        ]
      };
    }
  );

  server.registerResource(
    "github-releases",
    "lovagentic://github/releases",
    {
      title: "GitHub Releases",
      description: "Latest GitHub releases for lovagentic.",
      mimeType: "application/json"
    },
    async (uri) => {
      const releases = await listGitHubReleases({ repo: options.githubRepo, limit: 10 });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(releases, null, 2)
          }
        ]
      };
    }
  );
}

function registerRepoTools(server, options) {
  server.registerTool(
    "read_repo_doc",
    {
      title: "Read Repository Document",
      description: "Read a packaged lovagentic repository document such as README, AGENTS, command reference, changelog, or release runbook.",
      inputSchema: {
        doc: z.enum(getMcpDocumentKeys()).describe("Document to read."),
        maxBytes: z.number().int().min(1000).max(250000).default(80000).describe("Maximum UTF-8 bytes to return.")
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ doc, maxBytes }) => textResult((await readRepoDocument(doc, { ...options, maxBytes })).text)
  );

  server.registerTool(
    "command_reference",
    {
      title: "Search Command Reference",
      description: "Return generated CLI command reference sections, optionally filtered by command name or flag.",
      inputSchema: {
        query: z.string().trim().optional().describe("Command, flag, or term to search for."),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum matching command sections to return.")
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    async ({ query = "", limit = 10 }) => {
      const reference = await readCommandReference({ ...options, query, limit });
      return textResult(reference.text, {
        query,
        count: reference.count,
        sections: reference.sections.map((section) => section.title)
      });
    }
  );

  server.registerTool(
    "list_github_issues",
    {
      title: "List GitHub Issues",
      description: "List public GitHub issues for the lovagentic repository. Pull requests are excluded.",
      inputSchema: {
        state: z.enum(["open", "closed", "all"]).default("open"),
        labels: z.string().trim().optional().describe("Comma-separated labels to filter by."),
        limit: z.number().int().min(1).max(100).default(20)
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true
      }
    },
    async ({ state = "open", labels = "", limit = 20 }) => {
      const issues = await listGitHubIssues({
        repo: options.githubRepo,
        token: options.githubToken,
        state,
        labels,
        limit
      });
      return jsonResult(issues);
    }
  );

  server.registerTool(
    "list_github_releases",
    {
      title: "List GitHub Releases",
      description: "List public GitHub releases for the lovagentic repository.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(10)
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true
      }
    },
    async ({ limit = 10 }) => {
      const releases = await listGitHubReleases({
        repo: options.githubRepo,
        token: options.githubToken,
        limit
      });
      return jsonResult(releases);
    }
  );
}

function registerPromptTemplates(server) {
  server.registerPrompt(
    "update-site-from-audit",
    {
      title: "Update Site From Audit",
      description: "Reusable Lovable prompt for applying a site audit with strict verification expectations.",
      argsSchema: {
        auditSummary: z.string().optional().describe("Short summary of the audit or missing items."),
        publicUrl: z.string().url().optional().describe("Public site URL to verify after publish."),
        expectedCopy: z.string().optional().describe("Critical copy that must be visible.")
      }
    },
    async ({ auditSummary = "", publicUrl = "", expectedCopy = "" }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Update the existing Lovable site using the attached audit or repository context as the source of truth.",
              "Keep correct work untouched. Do not invent unsupported product/API/MCP features.",
              auditSummary ? `Audit focus:\n${auditSummary}` : "",
              expectedCopy ? `Required visible copy:\n${expectedCopy}` : "",
              publicUrl ? `After publishing, verify the public URL: ${publicUrl}` : "",
              "When done, stop and summarize only the changed sections and remaining verification risks."
            ].filter(Boolean).join("\n\n")
          }
        }
      ]
    })
  );
}

export async function listGitHubIssues(options = {}) {
  const repo = options.repo || DEFAULT_GITHUB_REPO;
  const state = options.state || "open";
  const limit = clampInteger(options.limit, 1, 100, 20);
  const params = new URLSearchParams({
    state,
    per_page: String(Math.min(limit * 2, 100))
  });
  if (options.labels) params.set("labels", options.labels);
  const data = await fetchGitHubJson(`/repos/${repo}/issues?${params}`, options);
  return data
    .filter((issue) => !issue.pull_request)
    .slice(0, limit)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url,
      labels: (issue.labels ?? []).map((label) => label.name),
      createdAt: issue.created_at,
      updatedAt: issue.updated_at
    }));
}

export async function listGitHubReleases(options = {}) {
  const repo = options.repo || DEFAULT_GITHUB_REPO;
  const limit = clampInteger(options.limit, 1, 100, 10);
  const data = await fetchGitHubJson(`/repos/${repo}/releases?per_page=${limit}`, options);
  return data.slice(0, limit).map((release) => ({
    name: release.name,
    tagName: release.tag_name,
    draft: Boolean(release.draft),
    prerelease: Boolean(release.prerelease),
    url: release.html_url,
    publishedAt: release.published_at
  }));
}

async function fetchGitHubJson(apiPath, options = {}) {
  const timeoutMs = clampInteger(options.timeoutMs, 1000, 30_000, 10_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "lovagentic-mcp"
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  try {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GitHub API ${response.status}: ${body.slice(0, 200)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function readPackageMetadata(repoRoot) {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

function textResult(text, structuredContent) {
  return {
    ...(structuredContent ? { structuredContent } : {}),
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 2), { result: value });
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n\n[truncated to ${maxBytes} bytes]`;
}

function clampInteger(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || "/mcp").trim();
  return value.startsWith("/") ? value : `/${value}`;
}
