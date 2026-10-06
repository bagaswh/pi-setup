import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  return env ? path.resolve(env) : path.join(os.homedir(), ".pi", "agent");
}

function shouldLoadKnowledgeBase(extensionFile: string, cwd: string): boolean {
  const project = path.resolve(cwd, ".pi", "extensions", "knowledge-base", "index.ts");
  return !(fs.existsSync(project) && path.resolve(extensionFile) !== project);
}

export default function registerKnowledgeBaseExtension(pi: ExtensionAPI) {
  if (!shouldLoadKnowledgeBase(fileURLToPath(import.meta.url), process.cwd())) return;
  const startup = loadLayeredKnowledgeBaseConfig({
    globalPath: path.join(agentDir(), "kb.json"),
    projectPath: path.join(process.cwd(), ".pi", "kb.json"),
    globalBase: agentDir(),
    projectBase: process.cwd(),
  }, {
    lookupQmdCollections: createLookupQmdCollectionsSync(),
    lookupQmdUpdateCommand: createLookupQmdUpdateCommandSync(),
  });
  const runCli = createDefaultCliRunner();
  const qmdAdapter = createQmdAdapter({
    allowlistedCollections: startup.kind === "ready" ? startup.config.qmd.collections : [],
    runCli,
    inspectCollection: createCollectionInspector(runCli),
    ensureRefreshReady: resolveQmdPackageFromCli,
    refreshCollection: createSdkCollectionScanRefresh({
      resolvePackage: resolveQmdPackageFromCli,
      workingDirectory: process.cwd(),
    }),
  });
  const registration = buildKnowledgeBaseTools(startup, { qmdAdapter });

  if (registration.kind === "fatal") {
    console.error(registration.message);
    process.exit(1);
  }
  if (registration.kind === "no-tools") return;

  for (const tool of registration.tools) {
    pi.registerTool(tool);
  }
}
