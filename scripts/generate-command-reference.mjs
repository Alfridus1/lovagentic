import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.js");
const OUTPUT_PATH = path.join(REPO_ROOT, "docs", "commands.md");

function normalizeBlock(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

async function runCliHelp(args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    maxBuffer: 1024 * 1024
  });

  return normalizeBlock(stdout);
}

function parseCommandsFromRootHelp(rootHelp) {
  const lines = rootHelp.split("\n");
  const commands = [];
  let inCommands = false;

  for (const line of lines) {
    if (/^Commands:\s*$/.test(line)) {
      inCommands = true;
      continue;
    }

    if (!inCommands) {
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^\s{2,}([a-z0-9-]+)\b/i);
    if (!match) {
      continue;
    }

    const name = match[1];
    if (name === "help") {
      continue;
    }

    commands.push(name);
  }

  return commands;
}

function renderMarkdown(rootHelp, commandHelps) {
  const commandList = Object.keys(commandHelps)
    .map((command) => `- [\`${command}\`](#${command.replace(/[^a-z0-9-]/gi, "")})`)
    .join("\n");

  const sections = Object.entries(commandHelps)
    .map(([command, helpText]) => `## ${command}

\`\`\`text
${helpText}
\`\`\`
`)
    .join("\n");

  return `# CLI Command Reference

This file is generated from \`node ./src/cli.js --help\`. Do not edit it manually.

- Source: [src/cli.js](../src/cli.js)

## Root help

\`\`\`text
${rootHelp}
\`\`\`

## Commands

${commandList}

${sections}`.trimEnd() + "\n";
}

async function main() {
  const rootHelp = await runCliHelp(["--help"]);
  const commands = parseCommandsFromRootHelp(rootHelp);
  const commandHelps = {};

  for (const command of commands) {
    commandHelps[command] = await runCliHelp([command, "--help"]);
  }

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, renderMarkdown(rootHelp, commandHelps), "utf8");
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
}

await main();
