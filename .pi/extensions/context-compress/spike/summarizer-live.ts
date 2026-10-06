// Live T11 check. Not part of the default test run.
// Usage: node --experimental-strip-types .pi/extensions/context-compress/spike/summarizer-live.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Resolve pi-coding-agent from the global npm root (portable across machines).
const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
const { createAgentSessionServices, ModelRegistry } = await import(
  pathToFileURL(
    path.join(globalRoot, "@earendil-works/pi-coding-agent/dist/index.js")
  ).href
);
import { loadContextCompressConfig, type ContextCompressConfig } from "../config.ts";
import { recallOriginal, writeOriginal } from "../originals.ts";
import { activePolicyHash, serializeArchive, type SourcedMessage } from "../serialize.ts";
import { reasoningEffortFor, resolveModelRef } from "../index.ts";
import { createSummarizer, type DigestRecord } from "../summarizer.ts";

function redact(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["'][^"']+["']/gi, "api_key=[redacted]");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-compress-summarizer-live-"));
const originals = path.join(root, "originals");
fs.mkdirSync(originals, { recursive: true });

const services = await createAgentSessionServices({
  cwd: root,
  agentDir: path.join(os.homedir(), ".pi", "agent"),
  resourceLoaderOptions: {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  },
});
const registry = new ModelRegistry(services.modelRuntime);

const modelConfig = "azure-foundry-ai-agents-cus/gpt-6-luna";
const resolved = resolveModelRef(modelConfig, registry);
const reasoningEffort = reasoningEffortFor(resolved);

const calls: Array<{ model: string; saw: string[]; stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; chars: number }>; usage?: unknown }> = [];
const markers = ["OLD_SUMMARIZE_TOKEN", "SHORT_FULL_TOKEN", "TAIL_KEEP_TOKEN", "THINK_DROP_TOKEN", "FAIL_TOKEN"];

async function callModel(req: {
  model: string;
  prompt: string;
  input: string;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<{ text: string; usage?: unknown }> {
  const seen = markers.filter((marker) => req.input.includes(marker));
  const model = resolveModelRef(req.model, registry);
  try {
    const response = await registry.complete(
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
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    );
    const blocks = response.content ?? [];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    const errorMessage = response.errorMessage ? redact(response.errorMessage).slice(0, 200) : undefined;
    calls.push({
      model: req.model,
      saw: seen,
      stopReason: response.stopReason,
      errorMessage,
      content: blocks.map((block) => ({
        type: block.type,
        chars: (block.text ?? block.thinking ?? "").length,
      })),
      usage: response.usage,
    });
    return { text, usage: response.usage, stopReason: response.stopReason, error: errorMessage };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 200);
    calls.push({ model: req.model, saw: seen, errorMessage: message, content: [] });
    throw error;
  }
}

function writeReady(name: string, summarizerModel: string, minAgeTokens: number): ContextCompressConfig {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify({
    methodOrder: ["snap"],
    fallback: "pi-default",
    serialize: {
      thinking: [{ do: "drop" }],
      toolCall: [{ do: "full" }],
      userMessage: [{ do: "full" }],
      modelResponse: [{ do: "full" }],
      toolResult: [{ upTo: 20, do: "full" }, { do: "summarize" }],
    },
    originals: { enabled: true, dir: originals, actions: ["drop", "truncate", "summarize", "errorStub"], retention: "session" },
    summarizerModelConfig: { model: summarizerModel, maxOutputTokens: 400, concurrency: 1, minAgeTokens, waitMs: 15000 },
  }));
  const loaded = loadContextCompressConfig(file);
  if (loaded.kind !== "ready") throw new Error(loaded.kind === "fatal" ? loaded.message : "config not ready");
  return loaded.config;
}

const oldText = `OLD_SUMMARIZE_TOKEN ${"alpha ".repeat(200)}`;
const shortText = "SHORT_FULL_TOKEN";
const tailText = `TAIL_KEEP_TOKEN ${"beta ".repeat(80)}`;
const successMessages: SourcedMessage[] = [
  {
    entryId: "think-1",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "THINK_DROP_TOKEN should stay out of the model call" }, { type: "text", text: "noted" }] },
  },
  {
    entryId: "old-1",
    message: { role: "toolResult", toolName: "bash", toolCallId: "c1", isError: false, content: [{ type: "text", text: oldText }] },
  },
  {
    entryId: "short-1",
    message: { role: "toolResult", toolName: "bash", toolCallId: "c2", isError: false, content: [{ type: "text", text: shortText }] },
  },
  {
    entryId: "tail-1",
    message: { role: "toolResult", toolName: "bash", toolCallId: "c3", isError: false, content: [{ type: "text", text: tailText }] },
  },
];

const successConfig = writeReady("success.json", modelConfig, 80);
const successDigests: DigestRecord[] = [];
const successWorker = createSummarizer({
  config: successConfig,
  hash: activePolicyHash(successConfig),
  callModel,
  appendDigest: (record) => successDigests.push(record),
});
let successError: string | undefined;
try {
  await successWorker.kick(successMessages);
} catch (error) {
  successError = redact(error instanceof Error ? error.message : String(error));
}

const successArchive = await serializeArchive({
  messages: successMessages,
  policy: successConfig.policy,
  snap: successConfig.snap,
  globalSummarizer: successConfig.summarizerModelConfig,
  lookupDigest: (item) => successWorker.lookup(item, 0),
  saveOriginal: (record) => writeOriginal(originals, record),
});
const successRecall = recallOriginal({ dir: originals, id: "old-1:toolResult:0", seen: new Set() });
const digest = successDigests[0];

const failText = `FAIL_TOKEN ${"gamma ".repeat(200)}`;
const failMessages: SourcedMessage[] = [
  {
    entryId: "fail-1",
    message: { role: "toolResult", toolName: "bash", toolCallId: "c4", isError: false, content: [{ type: "text", text: failText }] },
  },
];
const beforeFailCalls = calls.length;
const failConfig = writeReady("fail.json", "openrouter/no-such-free-model", 0);
const failDigests: DigestRecord[] = [];
const failWorker = createSummarizer({
  config: failConfig,
  hash: activePolicyHash(failConfig),
  callModel,
  appendDigest: (record) => failDigests.push(record),
});
await failWorker.kick(failMessages);
const failArchive = await serializeArchive({
  messages: failMessages,
  policy: failConfig.policy,
  snap: failConfig.snap,
  globalSummarizer: failConfig.summarizerModelConfig,
  lookupDigest: (item) => failWorker.lookup(item, 0),
  saveOriginal: (record) => writeOriginal(originals, record),
});
const failRecall = recallOriginal({ dir: originals, id: "fail-1:toolResult:0", seen: new Set() });

const report = {
  modelConfig,
  resolved: { provider: resolved.provider, id: resolved.id },
  reasoningEffort: reasoningEffort ?? null,
  diagnostics: services.diagnostics.map((item) => ({ type: item.type, message: redact(item.message) })),
  success: {
    error: successError,
    callCount: beforeFailCalls,
    calls: calls.slice(0, beforeFailCalls),
    digestCount: successDigests.length,
    digestFailed: digest?.failed === true,
    digestHasText: typeof digest?.text === "string" && digest.text.length > 0,
    digestTextChars: typeof digest?.text === "string" ? digest.text.length : 0,
    digestModel: digest?.model,
    usage: digest?.usage,
    archiveHasSummarized: successArchive.text.includes("summarized"),
    archiveHasOldToken: successArchive.text.includes("OLD_SUMMARIZE_TOKEN"),
    archiveHasTailToken: successArchive.text.includes("TAIL_KEEP_TOKEN"),
    counts: successArchive.counts,
    digestMisses: successArchive.digestMisses,
    recallIsError: successRecall.isError,
    recallHasOldToken: successRecall.text.includes("OLD_SUMMARIZE_TOKEN"),
    recallHasAlpha: successRecall.text.includes("alpha alpha"),
  },
  failure: {
    attempts: calls.length - beforeFailCalls,
    calls: calls.slice(beforeFailCalls),
    digestCount: failDigests.length,
    digestFailed: failDigests[0]?.failed === true,
    archiveHasTruncated: failArchive.text.includes("truncated"),
    archiveHasFailToken: failArchive.text.includes("FAIL_TOKEN"),
    counts: failArchive.counts,
    digestMisses: failArchive.digestMisses,
    recallIsError: failRecall.isError,
    recallHasFailToken: failRecall.text.includes("FAIL_TOKEN"),
    recallHasGamma: failRecall.text.includes("gamma gamma"),
  },
};
console.log(JSON.stringify(report, null, 2));
