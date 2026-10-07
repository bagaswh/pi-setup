#!/usr/bin/env node
/**
 * MCP stdio server exposing the knowledge-base tools (kb*) from this Pi
 * extension to any MCP client (Cursor, Claude Desktop, etc.).
 *
 * Reuses the extension's own modules (config.ts, qmd.ts, register.ts), so
 * behavior, schemas, and formatting stay identical to the in-Pi tools.
 *
 * Config resolution mirrors the Pi extension:
 *   - global config:  $KB_AGENT_DIR/kb.json   (default: ~/.pi/agent/kb.json)
 *   - project config: $KB_PROJECT_DIR/.pi/kb.json (default: process.cwd())
 * The two are layered the same way (project wins per key, deep-merged).
 *
 * Cursor example (mcp.json):
 *   {
 *     "mcpServers": {
 *       "knowledge-base": {
 *         "command": "node",
 *         "args": ["/abs/path/to/.pi/extensions/knowledge-base/mcp-server.ts"],
 *         "env": { "KB_PROJECT_DIR": "/abs/path/to/project" }
 *       }
 *     }
 *   }
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadLayeredKnowledgeBaseConfig } from "./config.ts";
import {
  createCollectionInspector,
  createDefaultCliRunner,
  createLookupQmdCollectionsSync,
  createLookupQmdUpdateCommandSync,
  createQmdAdapter,
  createSdkCollectionScanRefresh,
  resolveQmdPackageFromCli,
} from "./qmd.ts";
import { buildKnowledgeBaseTools } from "./register.ts";

// Project config lookup order: $KB_PROJECT_DIR, then the launch cwd (a
// harness workspace root), then the project that contains this server file
// (<project>/.pi/extensions/knowledge-base/mcp-server.ts).
function defaultProjectDir(): string {
  const fromCwd = path.join(process.cwd(), ".pi", "kb.json");
  if (existsSync(fromCwd)) return process.cwd();
  // mcp-server.ts lives at <project>/.pi/extensions/knowledge-base/, so the
  // enclosing project is three levels up. (For the global copy at
  // ~/.pi/agent/extensions/knowledge-base/ this yields ~/.pi/agent — harmless,
  // the layered config simply won't find a kb.json there.)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

const projectDir = process.env.KB_PROJECT_DIR
  ? path.resolve(process.env.KB_PROJECT_DIR)
  : defaultProjectDir();
const agentDir = process.env.KB_AGENT_DIR
  ? path.resolve(process.env.KB_AGENT_DIR)
  : path.join(os.homedir(), ".pi", "agent");

const startup = loadLayeredKnowledgeBaseConfig(
  {
    globalPath: path.join(agentDir, "kb.json"),
    projectPath: path.join(projectDir, ".pi", "kb.json"),
    globalBase: agentDir,
    projectBase: projectDir,
  },
  {
    lookupQmdCollections: createLookupQmdCollectionsSync(),
    lookupQmdUpdateCommand: createLookupQmdUpdateCommandSync(),
  },
);

if (startup.kind === "no-config") {
  console.error(
    `kb mcp fatal: no kb.json found (looked at ${path.join(agentDir, "kb.json")} and ` +
      `${path.join(projectDir, ".pi", "kb.json")}). Create one, e.g. {"backend":"qmd","qmd":{"collections":["runbooks"]}}.`,
  );
  process.exit(1);
}
if (startup.kind === "fatal") {
  console.error(startup.message);
  process.exit(1);
}

const runCli = createDefaultCliRunner();
const qmdAdapter = createQmdAdapter({
  allowlistedCollections: startup.config.qmd.collections,
  runCli,
  inspectCollection: createCollectionInspector(runCli),
  ensureRefreshReady: resolveQmdPackageFromCli,
  refreshCollection: createSdkCollectionScanRefresh({
    resolvePackage: resolveQmdPackageFromCli,
    workingDirectory: projectDir,
  }),
});
const registration = buildKnowledgeBaseTools(startup, { qmdAdapter });

if (registration.kind !== "tools") {
  console.error("kb mcp fatal: no tools registered");
  process.exit(1);
}

const tools = registration.tools;

const server = new Server(
  { name: "knowledge-base", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Pi injects promptGuidelines into the model's system prompt; over MCP the
// description is the only channel the agent sees, so append them there.
function mcpDescription(tool: (typeof tools)[number]): string {
  if (tool.promptGuidelines.length === 0) return tool.description;
  return `${tool.description}\n\nGuidelines:\n${tool.promptGuidelines.map((g) => `- ${g}`).join("\n")}`;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    name: tool.name,
    description: mcpDescription(tool),
    inputSchema: tool.parameters,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((entry) => entry.name === request.params.name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }
  try {
    const args = tool.prepareArguments
      ? tool.prepareArguments(request.params.arguments ?? {})
      : (request.params.arguments ?? {});
    const result = await tool.execute(request.params.name, args, new AbortController().signal);
    return {
      content: result.content,
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `kb mcp error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `kb mcp ready: ${tools.length} tool(s) over stdio ` +
    `(collections: ${startup.config.qmd.collections.join(", ")}, writable: ${startup.config.writable})`,
);
