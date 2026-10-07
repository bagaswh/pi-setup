import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadContextCompressConfig, loadLayeredContextCompressConfig, type ContextCompressConfig } from "./config.ts";
import { estimateTokens, KINDS } from "./ladder.ts";
import { createSnapMode, branchMessages } from "./modes/snap.ts";
import { createTextMode } from "./modes/text.ts";
import { originalsDir, listOriginals, pruneOriginals, recallOriginal, showOriginal } from "./originals.ts";
import { parseForcedMode, runMethodOrder, type CompressMode, type ContextCompressDetails, type ModeRunContext } from "./modes/registry.ts";
import { shapeForModel } from "./render/raster.ts";
import { activePolicyHash, serializeArchive, type DigestLookup, type SourcedMessage } from "./serialize.ts";
import { createSummarizer, clipDigestError, type DigestRecord, type ModelCaller, type Summarizer } from "./summarizer.ts";

type SchemaOptions = { description?: string };
type TypeboxLike = {
  Object: (properties: Record<string, unknown>, options?: SchemaOptions) => Record<string, unknown>;
  String: (options?: SchemaOptions) => Record<string, unknown>;
  Number: (options?: SchemaOptions) => Record<string, unknown>;
  Optional: (schema: Record<string, unknown>) => Record<string, unknown>;
};

function withDescription(schema: Record<string, unknown>, options?: SchemaOptions): Record<string, unknown> {
  return options?.description ? { ...schema, description: options.description } : schema;
}

const Type: TypeboxLike = (() => {
  const fallback: TypeboxLike = {
    Object: (properties, options) => withDescription({ type: "object", properties, required: Object.keys(properties).filter((key) => properties[key] && !(properties[key] as { optional?: boolean }).optional) }, options),
    String: (options) => withDescription({ type: "string" }, options),
    Number: (options) => withDescription({ type: "number" }, options),
    Optional: (schema) => ({ ...schema, optional: true }),
  };
  try {
    const required = createRequire(import.meta.url);
    const imported = required("typebox") as { Type?: TypeboxLike };
    return imported.Type ?? fallback;
  } catch {
    return fallback;
  }
})();

function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  return env ? path.resolve(env) : path.join(os.homedir(), ".pi", "agent");
}

export type RegisterOptions = {
  configPath?: string;
  modes?: CompressMode[];
};

type AnyContext = {
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
  model?: { id?: string; provider?: string; input?: string[] };
  signal?: AbortSignal;
  sessionManager: {
    getSessionDir: () => string;
    getBranch: () => ModeRunContext["branchEntries"];
  };
  modelRegistry: {
    find: (provider: string, modelId: string) => { id?: string; provider?: string; reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> } | undefined;
    getAll: () => ReadonlyArray<{ id?: string; provider?: string }>;
    complete: (model: unknown, context: unknown, options?: unknown) => Promise<{ content?: Array<{ type?: string; text?: string }>; usage?: unknown; stopReason?: string; errorMessage?: string }>;
  };
  compact: (options?: { customInstructions?: string }) => void;
};

export function resolveModelRef<T extends { provider?: string; id?: string }>(
  reference: string,
  registry: {
    find: (provider: string, modelId: string) => T | undefined;
    getAll: () => readonly T[];
  },
): T {
  const slash = reference.indexOf("/");
  if (slash > 0) {
    const found = registry.find(reference.slice(0, slash), reference.slice(slash + 1));
    if (found) return found;
  }
  const matches: T[] = [];
  const seen = new Set<string>();
  for (const model of registry.getAll()) {
    const provider = model.provider ?? "";
    const id = model.id ?? "";
    const full = `${provider}/${id}`;
    if (full !== reference && id !== reference) continue;
    if (seen.has(full)) continue;
    seen.add(full);
    matches.push(model);
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const names = matches.map((model) => `${model.provider ?? ""}/${model.id ?? ""}`).join(", ");
    throw new Error(`context-compress config fatal: model: ${reference} matches more than one model: ${names}`);
  }
  throw new Error(`summarizer model not found: ${reference}`);
}

const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function reasoningEffortFor(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> }, requested?: string): (typeof REASONING_LEVELS)[number] | undefined {
  if (!model.reasoning) return undefined;
  const map = model.thinkingLevelMap;
  const listed = (level: string) => typeof map?.[level] === "string";
  const allowed = (level: string) => {
    if (!map) return true;
    if (map[level] === null) return false;
    if (level === "xhigh" || level === "max") return listed(level);
    if (level === "minimal" && !listed("minimal") && REASONING_LEVELS.some((other) => other !== "minimal" && listed(other))) return false;
    return true;
  };
  if (requested && requested !== "off" && (REASONING_LEVELS as readonly string[]).includes(requested) && allowed(requested)) {
    return requested as (typeof REASONING_LEVELS)[number];
  }
  if (map && typeof map.off === "string") return undefined;
  return REASONING_LEVELS.find((level) => allowed(level));
}

function inert(pi: ExtensionAPI): void {
  pi.on("session_before_compact", () => undefined);
  pi.on("context", () => undefined);
  pi.registerCommand("context-compress", {
    description: "context-compress is not configured",
    handler: async () => undefined,
  });
}

function readBranch(ctx: AnyContext): ModeRunContext["branchEntries"] {
  return ctx.sessionManager.getBranch();
}

function sourcedFromBranch(branch: ModeRunContext["branchEntries"]): SourcedMessage[] {
  return branchMessages(branch);
}

export function registerContextCompress(pi: ExtensionAPI, options: RegisterOptions = {}): void {
  const startup = options.configPath
    ? loadContextCompressConfig(options.configPath)
    : loadLayeredContextCompressConfig({
        globalPath: path.join(agentDir(), "context-compress.json"),
        projectPath: path.join(process.cwd(), ".pi", "context-compress.json"),
        globalBase: agentDir(),
        projectBase: process.cwd(),
      });
  if (startup.kind === "fatal") {
    console.error(startup.message);
    process.exit(1);
  }
  if (startup.kind === "no-config") {
    inert(pi);
    return;
  }

  const config = startup.config;
  const seen = new Set<string>();
  let lastNotice = "";
  let lastMode = "";
  let summarizer: Summarizer | undefined;
  let latestCtx: AnyContext | undefined;
  const hash = activePolicyHash(config);
  let lastRequestImages = 0;

  const callModel: ModelCaller = async (req) => {
    const ctx = latestCtx;
    if (!ctx) throw new Error("context-compress summarizer has no session");
    const model = resolveModelRef(req.model, ctx.modelRegistry);
    const effort = reasoningEffortFor(model, req.thinkingLevel);
    const response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [{
          role: "user",
          content: [{ type: "text", text: `${req.prompt}\n\n${req.input}` }],
          timestamp: Date.now(),
        }],
      },
      {
        maxTokens: req.maxOutputTokens,
        temperature: req.temperature,
        signal: req.signal,
        ...(effort ? { reasoningEffort: effort } : {}),
      },
    );
    const text = (response.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    return {
      text,
      usage: response.usage,
      stopReason: response.stopReason,
      error: response.errorMessage ? clipDigestError(response.errorMessage) : undefined,
    };
  };

  const ensureWorker = () => {
    if (!config.needsSummarizer) return undefined;
    summarizer ??= createSummarizer({
      config,
      hash,
      callModel,
      appendDigest: (record) => pi.appendEntry("context-compress/digest", record),
    });
    return summarizer;
  };

  const rememberBranchDigests = (branch: ModeRunContext["branchEntries"]) => {
    const worker = ensureWorker();
    if (!worker) return;
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== "context-compress/digest" || !entry.data) continue;
      worker.remember(entry.data as DigestRecord);
    }
  };

  const lookup: DigestLookup = async (item) => {
    const worker = ensureWorker();
    if (!worker) return undefined;
    return worker.lookup(item, config.summarizerModelConfig.waitMs ?? 0);
  };

  const modeHooks = {
    getConfig: () => config,
    getLookup: () => (config.needsSummarizer ? lookup : undefined),
    notify: (message: string) => {
      lastNotice = message;
      latestCtx?.ui.notify(message, "info");
    },
  };
  const snap = createSnapMode(modeHooks);
  const text = createTextMode(modeHooks);
  const modes = options.modes ?? [snap, text];

  const runCtx = (ctx: AnyContext, preparation: ModeRunContext["preparation"], branch: ModeRunContext["branchEntries"], instructions?: string, signal?: AbortSignal): ModeRunContext => ({
    model: ctx.model,
    preparation,
    branchEntries: branch,
    sessionDir: ctx.sessionManager.getSessionDir(),
    instructions,
    signal,
  });

  pi.on("session_start", () => {
    seen.clear();
    lastNotice = "";
    lastMode = "";
  });

  pi.on("session_before_compact", async (event, ctx) => {
    latestCtx = ctx as AnyContext;
    const branch = readBranch(latestCtx);
    rememberBranchDigests(branch);
    const worker = ensureWorker();
    if (worker) {
      worker.armWait(config.summarizerModelConfig.waitMs ?? 0);
      void worker.kick(sourcedFromBranch(branch));
    }
    const forced = parseForcedMode(event.customInstructions);
    const outcome = await runMethodOrder({
      methodOrder: config.methodOrder,
      modes,
      fallback: config.fallback,
      forced: forced.mode,
      ctx: runCtx(latestCtx, event.preparation, branch, forced.instructions, event.signal),
    });
    if (!outcome) return undefined;
    if (outcome.cancel) return { cancel: true };
    const produced = outcome.compaction?.details?.contextCompress;
    const notice = produced?.notice;
    if (notice) lastNotice = notice;
    if (produced?.mode) lastMode = produced.mode;
    return { compaction: outcome.compaction };
  });

  pi.on("context", (event, ctx) => {
    const live = ctx as AnyContext;
    const branch = readBranch(live);
    let details: ContextCompressDetails | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type !== "compaction") continue;
      const candidate = (entry.details as { contextCompress?: ContextCompressDetails } | undefined)?.contextCompress;
      if (!candidate?.mode) continue;
      details = candidate;
      break;
    }
    if (!details || details.mode !== "snap" || details.frames.length === 0) {
      lastRequestImages = 0;
      return undefined;
    }
    const summaryAt = event.messages.findLastIndex((message) => (message as { role?: string }).role === "compactionSummary");
    if (summaryAt < 0) {
      lastRequestImages = 0;
      return undefined;
    }
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
    for (const frame of details.frames) {
      if (!fs.existsSync(frame.path)) continue;
      content.push({ type: "image", data: fs.readFileSync(frame.path).toString("base64"), mimeType: "image/png" });
    }
    lastRequestImages = content.filter((block) => block.type === "image").length;
    if (details.tail) content.push({ type: "text", text: details.tail });
    if (content.length === 0) return undefined;
    const messages = event.messages.slice();
    messages.splice(summaryAt + 1, 0, { role: "user", content, timestamp: Date.now() });
    return { messages };
  });

  if (config.needsSummarizer) {
    const kick = (ctx: AnyContext) => {
      latestCtx = ctx;
      const worker = ensureWorker();
      if (!worker) return;
      const branch = readBranch(ctx);
      rememberBranchDigests(branch);
      void worker.kick(sourcedFromBranch(branch), ctx.signal);
    };
    pi.on("turn_end", (_event, ctx) => {
      kick(ctx as AnyContext);
    });
    pi.on("agent_end", (_event, ctx) => {
      kick(ctx as AnyContext);
    });
    pi.on("session_shutdown", () => {
      summarizer?.stop();
    });
  }

  if (config.originals.enabled) {
    pi.registerTool({
      name: "context_compress_recall",
      label: "Recall compacted original",
      description: "Read one original that context-compress shortened or dropped. Pass the id from a compaction marker. Optional offset and limit page the file by line.",
      promptSnippet: "Recall a compacted original by id",
      promptGuidelines: [
        "Call context_compress_recall with the id from a context-compress marker when the frames or the stub are not enough.",
        "Use offset and limit to page a long original. When the result names a next offset, pass that offset to continue.",
        "A repeated call for the same id returns the text again and notes that the id was already recalled.",
      ],
      parameters: Type.Object({
        id: Type.String({ description: "Original id copied from a compaction marker, such as 0194abc:toolResult:0" }),
        offset: Type.Optional(Type.Number({ description: "Zero-based line offset into the original file" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return" })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const live = ctx as AnyContext;
        const args = params as { id?: string; offset?: number; limit?: number };
        const dir = originalsDir(live.sessionManager.getSessionDir(), config.originals.dir);
        const result = recallOriginal({
          dir,
          id: args.id ?? "",
          offset: args.offset,
          limit: args.limit,
          seen,
        });
        return {
          content: [{ type: "text", text: result.text }],
          details: {},
          ...(result.isError ? { isError: true } : {}),
        };
      },
    });
  }

  pi.registerCommand("context-compress", {
    description: "Show context-compress status, the latest archive, compact with one mode, dry-run the policy, or manage originals",
    handler: async (args, ctx) => {
      const live = ctx as AnyContext;
      latestCtx = live;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const head = tokens[0] ?? "status";
      if (head === "status") {
        const shape = shapeForModel(live.model, config.snap.shape);
        const branch = readBranch(live);
        const notice = lastNotice || noticeFromBranch(branch) || "(none)";
        const mode = lastMode || latestContextCompress(branch)?.mode || "(none)";
        const digestErrors = digestErrorsFromBranch(branch);
        const errorLine = digestErrors.length > 0 ? `\ndigest errors: ${digestErrors.join("; ")}` : "";
        live.ui.notify(`methodOrder: ${config.methodOrder.join(", ")}\nfallback: ${config.fallback}\nmode: ${mode}\nshape: ${shape.frameWidth}x${shape.frameHeight} cell ${shape.cellWidth}x${shape.cellHeight} ~${shape.tokensPerFrame} tok/frame\nlast notice: ${notice}${errorLine}\nlast request images: ${lastRequestImages}`, "info");
        return;
      }
      if (head === "show") {
        const found = latestContextCompress(readBranch(live));
        if (!found) {
          live.ui.notify("No context-compress compaction yet", "error");
          return;
        }
        const framePath = found.frames[0]?.path;
        if (!framePath) {
          const file = path.join(live.sessionManager.getSessionDir(), "context-compress", "text-archive.txt");
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, found.archiveText);
          live.ui.notify(`archive: ${file}\nframes:\n(none)`, "info");
          return;
        }
        const file = path.join(path.dirname(framePath), "archive.txt");
        fs.mkdirSync(path.dirname(framePath), { recursive: true });
        fs.writeFileSync(file, found.archiveText);
        const frames = found.frames.length > 0 ? found.frames.map((frame) => `- ${frame.path}`).join("\n") : "(none)";
        live.ui.notify(`archive: ${file}\nframes:\n${frames}`, "info");
        return;
      }
      if (head === "dry-run") {
        await dryRun(config, live);
        return;
      }
      if (head === "originals") {
        originalsCommand(config, live, tokens.slice(1));
        return;
      }
      if (head !== "snap" && head !== "text") {
        live.ui.notify(`Unknown context-compress mode ${head}`, "error");
        return;
      }
      const instructions = tokens.slice(1).join(" ");
      live.compact({ customInstructions: instructions ? `mode=${head} ${instructions}` : `mode=${head}` });
    },
  });
}

function latestContextCompress(branch: ModeRunContext["branchEntries"]): ContextCompressDetails | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "compaction") continue;
    const details = (entry.details as { contextCompress?: ContextCompressDetails } | undefined)?.contextCompress;
    if (details?.archiveText) return details;
  }
  return undefined;
}

function digestErrorsFromBranch(branch: ModeRunContext["branchEntries"]): string[] {
  const errors: string[] = [];
  for (const entry of branch) {
    if (entry?.type !== "custom" || entry.customType !== "context-compress/digest") continue;
    const data = entry.data as DigestRecord | undefined;
    if (data?.failed && data.error) errors.push(data.error);
  }
  return errors;
}

function noticeFromBranch(branch: ModeRunContext["branchEntries"]): string {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "compaction") continue;
    const notice = (entry.details as { contextCompress?: ContextCompressDetails } | undefined)?.contextCompress?.notice;
    if (notice) return notice;
  }
  return "";
}

async function dryRun(config: ContextCompressConfig, ctx: AnyContext): Promise<void> {
  const result = await serializeArchive({
    messages: sourcedFromBranch(readBranch(ctx)),
    policy: config.policy,
    snap: config.snap,
    globalSummarizer: config.summarizerModelConfig,
    saveActions: [],
  });
  const lines: string[] = [];
  for (const kind of KINDS) {
    const matched = result.hits.filter((hit) => hit.kind === kind);
    if (matched.length === 0) {
      lines.push(`${kind}: 0`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const hit of matched) {
      const label = `${hit.tier.do}${hit.tier.upTo !== undefined ? ` upTo ${hit.tier.upTo}` : ""}${hit.tier.when ? ` ${hit.tier.when}` : ""}`;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    lines.push(`${kind}: ${[...counts.entries()].map(([label, count]) => `${count} ${label}`).join(", ")}`);
  }
  lines.push(`estimated tokens saved: ${Math.max(0, result.sourceTokens - estimateTokens(result.text))}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

function originalsCommand(config: ContextCompressConfig, ctx: AnyContext, args: string[]): void {
  const dir = originalsDir(ctx.sessionManager.getSessionDir(), config.originals.dir);
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const listed = listOriginals(dir);
    if (listed.length === 0) {
      ctx.ui.notify("originals: none", "info");
      return;
    }
    ctx.ui.notify(listed.map((item) => `${item.id} ${item.kind} ${item.tokens} tok ${item.action}`).join("\n"), "info");
    return;
  }
  if (sub === "show") {
    const id = args[1];
    if (!id) {
      ctx.ui.notify("originals show needs an id", "error");
      return;
    }
    const shown = showOriginal(dir, id);
    ctx.ui.notify(shown.text, shown.isError ? "error" : "info");
    return;
  }
  if (sub === "prune") {
    if (config.originals.retention === "session") {
      ctx.ui.notify("retention is session; nothing pruned", "info");
      return;
    }
    const removed = pruneOriginals(dir, config.originals.retention);
    ctx.ui.notify(`pruned ${removed.length}`, "info");
    return;
  }
  ctx.ui.notify(`Unknown originals command ${sub}`, "error");
}

/** Project copy registers. A global symlink to that same file does not.
 *  jiti keeps import.meta.url as the imported path, so the global symlink
 *  and the project file are different strings. realpath tells them apart.
 *  A different project file also wins. No process-wide flag: each call
 *  reads the paths again, so /reload cannot stick a skip.
 */
export function shouldLoadContextCompress(
  extensionFile: string,
  cwd: string,
  realpath: (file: string) => string = fs.realpathSync,
): boolean {
  const project = path.resolve(cwd, ".pi", "extensions", "context-compress", "index.ts");
  if (!fs.existsSync(project)) return true;
  const loaded = path.resolve(extensionFile);
  if (loaded === project) return true;
  try {
    if (realpath(loaded) === realpath(project)) return false;
  } catch {
    return false;
  }
  return false;
}

export default function contextCompressExtension(pi: ExtensionAPI): void {
  if (!shouldLoadContextCompress(fileURLToPath(import.meta.url), process.cwd())) return;
  registerContextCompress(pi);
}

export type { ContextCompressConfig };
