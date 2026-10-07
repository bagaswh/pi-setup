import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadContextCompressConfig, loadLayeredContextCompressConfig, type ContextCompressConfig } from "./config.ts";
import { originalPath, recallOriginal } from "./originals.ts";
import { activePolicyHash, serializeArchive } from "./serialize.ts";
import { reasoningEffortFor, registerContextCompress, resolveModelRef, shouldLoadContextCompress } from "./index.ts";
import { resolveTier } from "./ladder.ts";
import type { CompressMode, ModeResult } from "./modes/registry.ts";
import { layoutArchive, normalizeForFont, renderPage, SHAPE_TABLE, shapeForModel } from "./render/raster.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type Handler = (event: unknown, ctx: unknown) => unknown;
type Harness = ReturnType<typeof createHarness>;

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const tools: Array<Record<string, unknown>> = [];
  const commands: Array<Record<string, unknown>> = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const modelCalls: Array<{ kind: string; provider?: string; id?: string; input?: string; reasoningEffort?: string }> = [];
  let completeImpl: (input: string) => Promise<{ text: string; errorMessage?: string; stopReason?: string }> = async () => ({ text: "short summary" });
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    registerCommand(name: string, options: Record<string, unknown>) {
      commands.push({ name, ...options });
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
  };
  return {
    pi,
    handlers,
    tools,
    commands,
    entries,
    modelCalls,
    setComplete(impl: (input: string) => Promise<{ text: string; errorMessage?: string; stopReason?: string }>) {
      completeImpl = impl;
    },
    modelRegistry: {
      find(provider: string, id: string) {
        modelCalls.push({ kind: "find", provider, id });
        return { id, provider, input: ["text", "image"], reasoning: id === "tiny" };
      },
      async complete(_model: unknown, context: { messages?: Array<{ content?: Array<{ text?: string }> }> }, options?: { reasoningEffort?: string }) {
        const input = context.messages?.[0]?.content?.[0]?.text ?? "";
        modelCalls.push({ kind: "complete", input, reasoningEffort: options?.reasoningEffort });
        const result = await completeImpl(input);
        return { content: [{ type: "text", text: result.text }], usage: { totalTokens: 1 }, errorMessage: result.errorMessage, stopReason: result.stopReason ?? "stop" };
      },
    },
  };
}

function handler(harness: Harness, name: string): Handler {
  const found = harness.handlers.get(name);
  assert.ok(found?.[0], `missing handler ${name}`);
  return found[0];
}

function writeConfig(dir: string, value: unknown): string {
  const configPath = path.join(dir, "context-compress.json");
  fs.writeFileSync(configPath, JSON.stringify(value));
  return configPath;
}

function tempCase(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-compress-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function loadRaw(value: unknown) {
  const { dir, cleanup } = tempCase();
  try {
    return loadContextCompressConfig(writeConfig(dir, value));
  } finally {
    cleanup();
  }
}

function ready(value: unknown): ContextCompressConfig {
  const loaded = loadRaw(value);
  assert.equal(loaded.kind, "ready");
  if (loaded.kind !== "ready") throw new Error("unreachable");
  return loaded.config;
}

function pngSize(buf: Buffer): { width: number; height: number } {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function pngPixel(buf: Buffer, x: number, y: number): number {
  const { width } = pngSize(buf);
  let offset = 8;
  const parts: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") parts.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  return raw[y * (width + 1) + 1 + x] ?? 255;
}

const policy = {
  tokenEstimate: "chars/4",
  stubChars: 200,
  thinking: [{ do: "drop" }],
  toolResult: [
    { when: "error", do: "errorStub" },
    { upTo: 50, do: "full" },
    { do: "truncate" },
  ],
  toolCall: [{ upTo: 20, do: "full" }, { do: "truncate" }],
  userMessage: [{ upTo: 30, do: "full" }, { do: "truncate" }],
  modelResponse: [{ do: "full" }],
};

function sessionCtx(harness: Harness, sessionDir: string, branch: unknown[], model?: { id?: string; provider?: string; input?: string[] }) {
  const notes: string[] = [];
  const compacts: string[] = [];
  const ctx = {
    ui: { notify(message: string) { notes.push(message); } },
    model: model ?? { id: "deepseek-ai/DeepSeek-V4.1-Flash", provider: "bitdeer", input: ["text", "image"] },
    signal: undefined,
    sessionManager: {
      getSessionDir: () => sessionDir,
      getBranch: () => branch,
    },
    modelRegistry: harness.modelRegistry,
    compact(options?: { customInstructions?: string }) {
      compacts.push(options?.customInstructions ?? "");
    },
  };
  return { ctx, notes, compacts };
}

test("missing config registers inert handlers and leaves compaction unchanged", async () => {
  const { dir, cleanup } = tempCase();
  try {
    const harness = createHarness();
    registerContextCompress(harness.pi as never, { configPath: path.join(dir, "missing.json") });
    assert.equal(harness.tools.length, 0);
    assert.equal(harness.commands[0]?.name, "context-compress");
    const compact = handler(harness, "session_before_compact");
    const context = handler(harness, "context");
    assert.equal(await compact({ preparation: {}, branchEntries: [] }, {}), undefined);
    assert.equal(await context({ messages: [{ role: "user", content: "hi" }] }, {}), undefined);
    const command = harness.commands[0]?.handler as (args: string, ctx: unknown) => Promise<void>;
    const notes: string[] = [];
    await command("status", { ui: { notify(message: string) { notes.push(message); } }, compact() { notes.push("compacted"); } });
    assert.deepEqual(notes, []);
  } finally {
    cleanup();
  }
});

test("invalid config is fatal and names the key", () => {
  for (const [value, key] of [
    [{ methodOrder: ["snap"], extra: true }, "extra"],
    [{ methodOrder: ["shake"] }, "methodOrder"],
    [{ fallback: "give-up" }, "fallback"],
    [{ originals: { enabled: "yes" } }, "originals"],
    [{ snap: { maxFrames: 0 } }, "snap"],
    [{ serialize: { includeThinking: false, thinking: [{ do: "full" }] } }, "thinking"],
    [{ serialize: { toolCall: [{ do: "errorStub" }] } }, "errorStub"],
    [{ serialize: { userMessage: [{ do: "drop" }] } }, "userMessage"],
    [{ serialize: { thinking: [{ do: "full", summarizer: { model: "a/b" } }] } }, "summarizer"],
  ] as const) {
    const loaded = loadRaw(value);
    assert.equal(loaded.kind, "fatal", JSON.stringify(value));
    if (loaded.kind === "fatal") assert.match(loaded.message, new RegExp(key));
  }
});

test("a fatal file makes the extension exit", () => {
  const { dir, cleanup } = tempCase();
  const orig = process.exit;
  const errors: string[] = [];
  const origErr = console.error;
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as typeof process.exit;
  console.error = (message?: unknown) => {
    errors.push(String(message));
  };
  try {
    const harness = createHarness();
    assert.throws(
      () => registerContextCompress(harness.pi as never, { configPath: writeConfig(dir, { fallback: "nope" }) }),
      /exit:1/,
    );
    assert.match(errors.join("\n"), /fallback/);
  } finally {
    process.exit = orig;
    console.error = origErr;
    cleanup();
  }
});

test("a valid file fills spec defaults", () => {
  const config = ready({});
  assert.deepEqual(config.methodOrder, ["snap"]);
  assert.equal(config.fallback, "pi-default");
  assert.equal(config.originals.enabled, true);
  assert.deepEqual(config.originals.actions, ["drop", "truncate", "summarize", "errorStub"]);
  assert.equal(config.originals.retention, "session");
  assert.equal(config.snap.shape, "auto");
  assert.equal(config.snap.maxFrames, 64);
  assert.equal(config.snap.maxBytes, 3_000_000);
  assert.equal(config.summarizerModelConfig.model, "azure-foundry-ai-agents-cus/gpt-6-luna");
  assert.equal(config.summarizerModelConfig.maxOutputTokens, 400);
  assert.equal(config.summarizerModelConfig.concurrency, 1);
  assert.equal(config.summarizerModelConfig.minAgeTokens, 30000);
  assert.equal(config.summarizerModelConfig.waitMs, 15000);
  assert.equal(config.needsSummarizer, false);
  assert.match(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8"), /\.pi\/context-compress\.json/);
  assert.equal(ready({ serialize: { perTool: { write: { toolCall: [{ do: "summarize" }] } } } }).needsSummarizer, true);
  assert.equal(ready({ snap: { serialize: { modelResponse: [{ do: "summarize" }] } } }).needsSummarizer, true);
});

test("shorthand ladders expand and resolveTier applies upTo, when, and the truncate default", () => {
  assert.deepEqual(resolveTier([{ upTo: 10, do: "full" }, { do: "drop" }], 10, false), { upTo: 10, do: "full" });
  assert.deepEqual(resolveTier([{ upTo: 10, do: "full" }, { do: "drop" }], 11, false), { do: "drop" });
  assert.equal(resolveTier([{ when: "error", do: "errorStub" }, { do: "full" }], 5, true).do, "errorStub");
  assert.equal(resolveTier([{ when: "error", do: "errorStub" }, { do: "full" }], 5, false).do, "full");
  assert.deepEqual(resolveTier([{ upTo: 2, do: "full" }], 9, false), { do: "truncate" });

});

test("each shorthand key expands to the spec ladder", () => {
  const cases: Array<[unknown, string, unknown]> = [
    [{ includeThinking: true }, "thinking", [{ do: "full" }]],
    [{ includeThinking: false }, "thinking", [{ do: "drop" }]],
    [{ includeThinkingIfLessThanToks: 7 }, "thinking", [{ upTo: 7, do: "full" }, { do: "drop" }]],
    [{ includeToolResults: true }, "toolResult", [{ do: "full" }]],
    [{ includeToolResults: false }, "toolResult", [{ do: "drop" }]],
    [{ includeToolResultsIfLessThanToks: 9 }, "toolResult", [{ upTo: 9, do: "full" }, { do: "drop" }]],
    [{ summarizeToolResults: true }, "toolResult", [{ do: "summarize" }]],
    [{ summarizeToolResultsIfToksExceeds: 12 }, "toolResult", [{ upTo: 12, do: "full" }, { do: "summarize" }]],
    [{ includeToolCalls: true }, "toolCall", [{ do: "full" }]],
    [{ includeToolCalls: false }, "toolCall", [{ do: "drop" }]],
    [{ summarizeToolCalls: true }, "toolCall", [{ do: "summarize" }]],
    [{ includeToolCallsIfLessThanToks: 4 }, "toolCall", [{ upTo: 4, do: "full" }, { do: "drop" }]],
    [{ summarizeToolCallsIfToksExceeds: 6 }, "toolCall", [{ upTo: 6, do: "full" }, { do: "summarize" }]],
    [{ alwaysIncludeUserMessages: true }, "userMessage", [{ do: "full" }]],
    [{ includeUserMessagesIfLessThanToks: 11 }, "userMessage", [{ upTo: 11, do: "full" }, { do: "truncate" }]],
    [{ summarizeModelResponses: true }, "modelResponse", [{ do: "summarize" }]],
  ];
  for (const [serialize, kind, tiers] of cases) {
    const config = ready({ serialize });
    assert.deepEqual(config.policy.ladders[kind as "thinking"].tiers, tiers, JSON.stringify(serialize));
  }
  const overlap = ready({ serialize: { includeToolResultsIfLessThanToks: 100, summarizeToolResultsIfToksExceeds: 40 } });
  assert.equal(resolveTier(overlap.policy.ladders.toolResult.tiers, 80, false).do, "full");
  assert.equal(resolveTier(overlap.policy.ladders.toolResult.tiers, 120, false).do, "summarize");
  const gap = ready({ serialize: { includeToolResultsIfLessThanToks: 20, summarizeToolResultsIfToksExceeds: 80 } });
  assert.equal(resolveTier(gap.policy.ladders.toolResult.tiers, 10, false).do, "full");
  assert.equal(resolveTier(gap.policy.ladders.toolResult.tiers, 40, false).do, "truncate");
  assert.equal(resolveTier(gap.policy.ladders.toolResult.tiers, 90, false).do, "summarize");
  const layered = ready({
    summarizerModelConfig: { model: "global/base", maxOutputTokens: 10 },
    serialize: {
      toolResult: { tiers: [{ do: "summarize", summarizer: { maxOutputTokens: 99 } }], summarizer: { temperature: 0.2 } },
      perTool: { write: { toolResult: { tiers: [{ do: "summarize", summarizer: { model: "tier/model" } }], summarizer: { prompt: "per tool" } } } },
    },
  });
  const tier = layered.policy.perTool.write?.toolResult?.tiers[0];
  assert.equal(tier?.summarizer?.model, "tier/model");
  assert.equal(layered.policy.ladders.toolResult.summarizer?.temperature, 0.2);
  assert.equal(layered.summarizerModelConfig.model, "global/base");
  assert.equal(layered.summarizerModelConfig.maxOutputTokens, 10);
});

test("font header, normalization, and one glyph pixel", () => {
  const source = fs.readFileSync(new URL("./render/font8x13.ts", import.meta.url), "utf8").slice(0, 700);
  assert.match(source, /misc-fixed/);
  assert.match(source, /8x13/);
  assert.match(source, /Public domain font\. {2}Share and enjoy\./);
  const normalized = normalizeForFont("a\u001B[31mb  \n\t c\u0001");
  assert.equal(normalized, `ab ${String.fromCodePoint(0x2588)} c?`);
  const page = renderPage("A", { frameWidth: 8, frameHeight: 13, cellWidth: 8, cellHeight: 13, tokensPerFrame: 1, maxImages: 1 });
  const size = pngSize(page);
  assert.equal(size.width, 8);
  assert.equal(size.height, 13);
  assert.equal(pngPixel(page, 3, 2), 0);
  assert.equal(pngPixel(page, 0, 0), 255);
  const sample = renderPage("The quick brown fox jumps over the lazy dog. 12345", SHAPE_TABLE.deepseek);
  fs.writeFileSync("/tmp/context-compress-legible.png", sample);
  assert.equal(sample.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("layout keeps edges, caps frames, and honors a shape override", () => {
  assert.equal(layoutArchive("short text", { cols: 10, rows: 2, edgeChars: 20, maxFrames: 5, maxBytes: 9999, imageBudgetFrames: 5 }).pages.length, 0);
  const text = `${"H".repeat(30)}${"M".repeat(80)}${"T".repeat(30)}`;
  const open = layoutArchive(text, { cols: 10, rows: 2, edgeChars: 30, maxFrames: 8, maxBytes: 9999, imageBudgetFrames: 8 });
  assert.equal(open.head, "H".repeat(30));
  assert.equal(open.tail, "T".repeat(30));
  assert.ok(open.pages.length > 1);
  assert.equal(open.pages.join(""), "M".repeat(80));
  const byFrames = layoutArchive(text, { cols: 10, rows: 2, edgeChars: 30, maxFrames: 1, maxBytes: 9999, imageBudgetFrames: 8 });
  assert.equal(byFrames.pages.length, 1);
  assert.ok(byFrames.droppedChars > 0);
  assert.equal(byFrames.pages[0], "M".repeat(80).slice(-20));
  const byBudget = layoutArchive(text, { cols: 10, rows: 2, edgeChars: 30, maxFrames: 8, maxBytes: 9999, imageBudgetFrames: 1 });
  assert.equal(byBudget.pages.length, 1);
  assert.ok(byBudget.droppedChars > 0);
  const byBytes = layoutArchive(text, { cols: 10, rows: 2, edgeChars: 30, maxFrames: 8, maxBytes: 25, imageBudgetFrames: 8, measure: () => 20 });
  assert.equal(byBytes.pages.length, 1);
  assert.ok(byBytes.droppedChars > 0);
  assert.equal(SHAPE_TABLE.deepseek.frameWidth, 1344);
  assert.equal(SHAPE_TABLE.deepseek.cellWidth, 16);
  assert.equal(SHAPE_TABLE.deepseek.cellHeight, 26);
  assert.equal(SHAPE_TABLE.deepseek.tokensPerFrame, 994);
  for (const name of ["gemini", "claude", "gpt", "default"] as const) assert.ok(SHAPE_TABLE[name]);
  const override = { frameWidth: 32, frameHeight: 26, cellWidth: 8, cellHeight: 13, tokensPerFrame: 3 };
  assert.equal(shapeForModel({ id: "deepseek-ai/DeepSeek-V4.1-Flash", provider: "bitdeer" }, "auto").tokensPerFrame, 994);
  assert.equal(shapeForModel({ id: "claude-opus" }, "auto").frameWidth, SHAPE_TABLE.claude.frameWidth);
  assert.deepEqual(shapeForModel({ id: "deepseek" }, override), { ...SHAPE_TABLE.deepseek, ...override });
});

test("compaction writes frames, originals, and a recallable archive", async () => {
  const { dir, cleanup } = tempCase();
  try {
    const sessionDir = path.join(dir, "session");
    fs.mkdirSync(sessionDir);
    const originals = path.join(dir, "originals");
    const harness = createHarness();
    const configPath = writeConfig(dir, { serialize: policy, originals: { dir: originals }, snap: { maxFrames: 4, maxBytes: 3_000_000 } });
    registerContextCompress(harness.pi as never, { configPath });
    const tool = harness.tools[0];
    assert.equal(tool?.name, "context_compress_recall");
    assert.equal(typeof tool?.description, "string");
    assert.equal(typeof tool?.promptSnippet, "string");
    assert.ok(Array.isArray(tool?.promptGuidelines));

    const firstUser = { role: "user", content: `FIRST_SECRET ${"a".repeat(1800)}`, timestamp: 1 };
    const laterUser = { role: "user", content: `LATER_HEAD ${"b".repeat(1500)}LATER_SECRET${"b".repeat(1500)} LATER_TAIL`, timestamp: 2 };
    const assistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `THINK_SECRET ${"t".repeat(400)}` },
        { type: "toolCall", id: "c3", name: "bash", arguments: { command: "ls -la" } },
        { type: "text", text: "the model said hello" },
      ],
      timestamp: 3,
    };
    const bigResult = {
      role: "toolResult",
      toolCallId: "c3",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: `RESULT_HEAD ${"r".repeat(1500)}RESULT_SECRET${"r".repeat(1500)} RESULT_TAIL` }],
      timestamp: 4,
    };
    const errorResult = {
      role: "toolResult",
      toolCallId: "c2",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: "permission denied\nERROR_SECRET_LINE" }],
      details: { exitCode: 1 },
      timestamp: 5,
    };
    const smallResult = {
      role: "toolResult",
      toolCallId: "c9",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "ok small" }],
      timestamp: 6,
    };
    const branch = [
      { type: "message", id: "u1", message: firstUser },
      { type: "message", id: "u2", message: laterUser },
      { type: "message", id: "a1", message: assistant },
      { type: "message", id: "r1", message: bigResult },
      { type: "message", id: "r2", message: errorResult },
      { type: "message", id: "r3", message: smallResult },
    ];
    const { ctx, notes } = sessionCtx(harness, sessionDir, branch);
    const result = await handler(harness, "session_before_compact")({
      preparation: {
        firstKeptEntryId: "keep-1",
        messagesToSummarize: [firstUser, laterUser, assistant, bigResult, errorResult, smallResult],
        turnPrefixMessages: [],
        tokensBefore: 5000,
      },
      customInstructions: "mode=snap focus on auth",
      signal: undefined,
    }, ctx) as { compaction?: ModeResult };
    const compaction = result.compaction;
    assert.ok(compaction);
    assert.equal(compaction.firstKeptEntryId, "keep-1");
    const details = compaction.details?.contextCompress;
    assert.ok(details);
    assert.equal(details.mode, "snap");
    assert.equal(details.dropped >= 0, true);
    assert.ok(details.frames.length > 0);
    assert.equal(JSON.stringify(details).includes("iVBORw0KGgo"), false);
    const png = fs.readFileSync(details.frames[0]?.path ?? "");
    assert.equal(png.subarray(0, 4).toString("hex"), "89504e47");
    assert.match(compaction.summary, /focus on auth/);
    assert.match(compaction.summary, /full-block glyph/);
    assert.match(compaction.summary, /Dropped characters: /);
    assert.match(notes.join("\n"), /truncated/);
    assert.match(notes.join("\n"), /error stubs/);
    const archive = details.archiveText;
    assert.match(archive, /FIRST_SECRET/);
    assert.equal(archive.includes("THINK_SECRET"), false);
    assert.equal(archive.includes("LATER_SECRET"), false);
    assert.match(archive, /LATER_HEAD/);
    assert.match(archive, /LATER_TAIL/);
    assert.match(archive, /bash\(\{"command":"ls -la"\}\)/);
    const command = `ARGONCE_${"z".repeat(3000)}`;
    const duplicated = await serializeArchive({
      messages: [{ entryId: "dup", message: { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command } }] } }],
      policy: ready({ serialize: policy }).policy,
    });
    const needle = JSON.stringify({ command }).slice(0, 80);
    assert.equal(!duplicated.text.startsWith(`bash(${needle}`) && duplicated.text.includes(needle) && duplicated.text.indexOf(needle) === duplicated.text.lastIndexOf(needle) && duplicated.text.includes("id=dup:toolCall:0 -> context_compress_recall"), true);
    assert.equal(archive.includes("RESULT_SECRET"), false);
    assert.match(archive, /permission denied/);
    assert.equal(archive.includes("ERROR_SECRET_LINE"), false);
    assert.match(archive, /ok small/);
    assert.match(archive, /the model said hello/);
    const errorFile = fs.readdirSync(originals).find((name) => name.endsWith(".error.txt"));
    assert.ok(errorFile);
    const errorText = fs.readFileSync(path.join(originals, errorFile), "utf8");
    assert.match(errorText, /ERROR_SECRET_LINE/);
    assert.match(errorText, /tool: bash/);
    assert.match(errorText, /kind: toolResult/);
    assert.match(errorText, /action: errorStub/);
    const thinkingFile = fs.readdirSync(originals).find((name) => name.includes("thinking"));
    assert.ok(thinkingFile);
    assert.match(fs.readFileSync(path.join(originals, thinkingFile), "utf8"), /THINK_SECRET/);

    const execute = tool?.execute as (id: string, params: { id: string; offset?: number; limit?: number }, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const thinkingId = archive.match(/id=(a1:thinking:0)/)?.[1];
    assert.ok(thinkingId);
    const recalled = await execute("call-1", { id: thinkingId }, undefined, undefined, ctx);
    assert.match(recalled.content[0]?.text ?? "", /THINK_SECRET/);
    const paged = await execute("call-2", { id: thinkingId, offset: 0, limit: 2 }, undefined, undefined, ctx);
    assert.match(paged.content[0]?.text ?? "", /next offset=2/);
    assert.match(paged.content[0]?.text ?? "", /already recalled/);

    const missing = await execute("call-3", { id: "../outside" }, undefined, undefined, ctx);
    assert.equal(missing.isError, true);
    assert.equal((missing.content[0]?.text ?? "").includes("OUTSIDE"), false);
    fs.writeFileSync(path.join(dir, "outside-secret.txt"), "OUTSIDE_SECRET");
    const escaped = await execute("call-4", { id: ".." }, undefined, undefined, ctx);
    assert.equal(escaped.isError, true);
    assert.equal((escaped.content[0]?.text ?? "").includes("OUTSIDE_SECRET"), false);

    branch.push({ type: "compaction", id: "cmp-1", summary: compaction.summary, message: undefined, details: compaction.details } as never);
    const again = await handler(harness, "session_before_compact")({
        preparation: {
        firstKeptEntryId: "keep-2",
        messagesToSummarize: [{ role: "user", content: `brand new turn ${"n".repeat(3000)}`, timestamp: 9 }],
        turnPrefixMessages: [],
        tokensBefore: 6000,
        previousSummary: compaction.summary,
      },
    }, ctx) as { compaction: ModeResult };
    const againArchive = again.compaction.details?.contextCompress?.archiveText ?? "";
    const againFrames = again.compaction.details?.contextCompress?.frames ?? [];
    assert.equal(againArchive.startsWith(details.archiveText) && againArchive.includes("brand new turn") && !againArchive.includes("Resuming a compacted session") && againFrames.some((frame) => details.frames.some((prior) => prior.path === frame.path)), true);
    assert.equal(harness.modelCalls.length, 0);
    assert.equal(harness.entries.length, 0);
    branch.push({ type: "compaction", id: "cmp-2", message: undefined, details: again.compaction.details } as never);

    const contextResult = await handler(harness, "context")({
      messages: [
        { role: "compactionSummary", summary: again.compaction.summary, tokensBefore: 6000, timestamp: 1 },
        { role: "user", content: "kept tail", timestamp: 2 },
      ],
    }, ctx) as { messages: Array<{ role?: string; content?: unknown }> };
    assert.equal(contextResult.messages[0]?.role, "compactionSummary");
    assert.equal(contextResult.messages[1]?.role, "user");
    const inserted = contextResult.messages[1]?.content as Array<{ type: string }>;
    assert.equal(inserted.some((block) => block.type === "image"), true);
    assert.equal(contextResult.messages[2]?.content, "kept tail");
    const untouched = await handler(harness, "context")({ messages: [{ role: "user", content: "no summary", timestamp: 1 }] }, { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [] } });
    assert.equal(untouched, undefined);
  } finally {
    cleanup();
  }
});

test("re-compaction carries frames and drops the oldest when the cap is full", async () => {
  const { dir, cleanup } = tempCase();
  try {
    const sessionDir = path.join(dir, "session");
    fs.mkdirSync(sessionDir);
    const harness = createHarness();
    registerContextCompress(harness.pi as never, {
      configPath: writeConfig(dir, {
        serialize: {
          userMessage: [{ do: "full" }],
          thinking: [{ do: "drop" }],
          toolCall: [{ do: "full" }],
          toolResult: [{ do: "full" }],
          modelResponse: [{ do: "full" }],
        },
        originals: { dir: path.join(dir, "originals-carry") },
        snap: { maxFrames: 3, maxBytes: 3_000_000, shape: { frameWidth: 80, frameHeight: 26, cellWidth: 16, cellHeight: 26, tokensPerFrame: 1 } },
      }),
    });
    const firstMessage = { role: "user", content: `${"A".repeat(1200)}${"M".repeat(15)}${"Z".repeat(1200)}`, timestamp: 1 };
    const branch: Array<Record<string, unknown>> = [{ type: "message", id: "u1", message: firstMessage }];
    const { ctx } = sessionCtx(harness, sessionDir, branch);
    const compact = (preparation: Record<string, unknown>) => handler(harness, "session_before_compact")({ preparation }, ctx) as Promise<{ compaction: ModeResult }>;
    const first = await compact({ firstKeptEntryId: "k1", messagesToSummarize: [firstMessage], turnPrefixMessages: [], tokensBefore: 1 });
    const firstFrames = first.compaction.details?.contextCompress?.frames ?? [];
    const carriedPath = firstFrames[2]?.path ?? "";
    const carriedBytes = fs.readFileSync(carriedPath);
    const secondMessage = { role: "user", content: "N".repeat(10), timestamp: 2 };
    branch.push({ type: "compaction", id: "c1", summary: first.compaction.summary, details: first.compaction.details });
    const second = await compact({ firstKeptEntryId: "k2", messagesToSummarize: [secondMessage], turnPrefixMessages: [], tokensBefore: 2, previousSummary: first.compaction.summary });
    const secondDetails = second.compaction.details?.contextCompress;
    const thirdMessage = { role: "user", content: "Q".repeat(5), timestamp: 3 };
    branch.push({ type: "compaction", id: "c2", summary: second.compaction.summary, details: second.compaction.details });
    const third = await compact({ firstKeptEntryId: "k3", messagesToSummarize: [thirdMessage], turnPrefixMessages: [], tokensBefore: 3, previousSummary: second.compaction.summary });
    const thirdDetails = third.compaction.details?.contextCompress;
    const counts = (notice: string | undefined) => {
      const match = notice?.match(/(\d+) carried, (\d+) new, (\d+) dropped/);
      return { carried: Number(match?.[1]), fresh: Number(match?.[2]), dropped: Number(match?.[3]) };
    };
    const secondArchive = secondDetails?.archiveText ?? "";
    assert.deepEqual({
      second: counts(secondDetails?.notice),
      third: counts(thirdDetails?.notice),
      carriedPath: secondDetails?.frames[0]?.path,
      bytesSame: fs.readFileSync(carriedPath).equals(carriedBytes),
      newDir: path.dirname(secondDetails?.frames[1]?.path ?? "") !== path.dirname(carriedPath),
      prefix: secondArchive.startsWith(first.compaction.details?.contextCompress?.archiveText ?? ""),
      hasNew: secondArchive.includes("N".repeat(10)),
      noGuide: !secondArchive.includes("Resuming a compacted session") && !secondArchive.includes("Reading guide:"),
      thirdOldest: thirdDetails?.frames[0]?.path === secondDetails?.frames[1]?.path,
    }, {
      second: { carried: 1, fresh: 2, dropped: 2 },
      third: { carried: 2, fresh: 1, dropped: 1 },
      carriedPath,
      bytesSame: true,
      newDir: true,
      prefix: true,
      hasNew: true,
      noGuide: true,
      thirdOldest: true,
    });
  } finally {
    cleanup();
  }
});

test("recall index lists off-frame ids and stays within the cap", async () => {
  const { dir, cleanup } = tempCase();
  try {
    const sessionDir = path.join(dir, "session");
    fs.mkdirSync(sessionDir);
    const harness = createHarness();
    registerContextCompress(harness.pi as never, {
      configPath: writeConfig(dir, {
        serialize: {
          userMessage: [{ upTo: 400, do: "full" }, { do: "truncate", truncateTo: 2 }],
          thinking: [{ do: "drop" }],
          toolCall: [{ do: "full" }],
          toolResult: [{ do: "full" }],
          modelResponse: [{ do: "full" }],
        },
        originals: { dir: path.join(dir, "originals-index") },
        snap: { maxFrames: 1, maxBytes: 3_000_000, shape: { frameWidth: 80, frameHeight: 26, cellWidth: 16, cellHeight: 26, tokensPerFrame: 1 } },
      }),
    });
    const mediums = Array.from({ length: 250 }, (_, index) => ({ role: "user", content: `m${index} ${"x".repeat(1990)}`, timestamp: 4 + index }));
    const messages = [
      { role: "user", content: "P".repeat(1500), timestamp: 1 },
      { role: "user", content: "t".repeat(1604), timestamp: 2 },
      { role: "user", content: "H".repeat(8000), timestamp: 3 },
      ...mediums,
      { role: "user", content: "Z".repeat(1500), timestamp: 300 },
    ];
    const branch = [
      { type: "message", id: "pad-head", message: messages[0] },
      { type: "message", id: "tiny-early", message: messages[1] },
      { type: "message", id: "huge-mid", message: messages[2] },
      ...mediums.map((message, index) => ({ type: "message", id: `m${index}`, message })),
      { type: "message", id: "pad-tail", message: messages[messages.length - 1] },
    ];
    const { ctx } = sessionCtx(harness, sessionDir, branch);
    const result = await handler(harness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: messages, turnPrefixMessages: [], tokensBefore: 1 },
    }, ctx) as { compaction: ModeResult };
    const summary = result.compaction.summary;
    const indexStart = summary.indexOf("Recall index (not on frames):");
    const indexEnd = summary.indexOf("\n\nArchive head:");
    const index = indexStart >= 0 && indexEnd > indexStart ? summary.slice(indexStart, indexEnd) : "";
    assert.equal(index.length > 0 && index.length <= 8_000 && index.includes("huge-mid:userMessage:0") && !index.includes("tiny-early:userMessage:0") && index.includes("ids omitted") && index.includes("/context-compress show"), true);
  } finally {
    cleanup();
  }
});

test("perTool overrides one tool and a non-matching tier truncates", async () => {
  const { dir, cleanup } = tempCase();
  try {
    const sessionDir = path.join(dir, "session");
    fs.mkdirSync(sessionDir);
    const harness = createHarness();
    registerContextCompress(harness.pi as never, {
      configPath: writeConfig(dir, {
        serialize: {
          ...policy,
          toolCall: [{ do: "full" }],
          toolResult: [{ upTo: 1, do: "full" }],
          perTool: { write: { toolCall: [{ do: "drop" }] } },
        },
        originals: { dir: path.join(dir, "originals") },
      }),
    });
    const write = { role: "assistant", content: [{ type: "toolCall", id: "w", name: "write", arguments: { path: "a.ts" } }], timestamp: 1 };
    const bash = { role: "assistant", content: [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "pwd" } }], timestamp: 2 };
    const odd = { role: "toolResult", toolCallId: "z", toolName: "bash", isError: false, content: [{ type: "text", text: `${"q".repeat(1200)}NO_MATCH_SECRET${"q".repeat(1200)}` }], timestamp: 3 };
    const branch = [
      { type: "message", id: "w1", message: write },
      { type: "message", id: "b1", message: bash },
      { type: "message", id: "o1", message: odd },
    ];
    const { ctx } = sessionCtx(harness, sessionDir, branch);
    const result = await handler(harness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [write, bash, odd], turnPrefixMessages: [], tokensBefore: 100 },
    }, ctx) as { compaction: ModeResult };
    const archive = result.compaction.details?.contextCompress?.archiveText ?? "";
    assert.match(archive, /write\(\{"path":"a.ts"\}\)/);
    assert.match(archive, /dropped/);
    assert.match(archive, /bash\(\{"command":"pwd"\}\)/);
    assert.equal(archive.includes("NO_MATCH_SECRET"), false);
    assert.match(archive, /truncated/);
  } finally {
    cleanup();
  }
});

test("unavailable snap honors fallback, and a forced mode does not fall through", async () => {
  const { dir, cleanup } = tempCase();
  try {
    const harness = createHarness();
    const sessionDir = path.join(dir, "session");
    fs.mkdirSync(sessionDir);
    registerContextCompress(harness.pi as never, { configPath: writeConfig(dir, { fallback: "cancel", serialize: policy }) });
    const { ctx } = sessionCtx(harness, sessionDir, [], { id: "text-only", input: ["text"] });
    const cancelled = await handler(harness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 1 },
    }, ctx);
    assert.deepEqual(cancelled, { cancel: true });

    const harnessDefault = createHarness();
    registerContextCompress(harnessDefault.pi as never, { configPath: writeConfig(dir, { fallback: "pi-default", serialize: policy }) });
    const quiet = await handler(harnessDefault, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 1 },
    }, sessionCtx(harnessDefault, sessionDir, [], { input: ["text"] }).ctx);
    assert.equal(quiet, undefined);

    let calls = 0;
    const flaky: CompressMode = {
      name: "snap",
      available: () => true,
      async run(): Promise<ModeResult | undefined> {
        calls += 1;
        if (calls === 1) return undefined;
        return { summary: "second mode", firstKeptEntryId: "kept-id", tokensBefore: 3, details: { contextCompress: { mode: "snap", archiveText: "second", frames: [], dropped: 0, head: "", tail: "", notice: "second" } } };
      },
    };
    const harnessFall = createHarness();
    registerContextCompress(harnessFall.pi as never, { configPath: writeConfig(dir, { methodOrder: ["snap", "snap"], serialize: policy }), modes: [flaky] });
    const fell = await handler(harnessFall, "session_before_compact")({
      preparation: { firstKeptEntryId: "kept-id", messagesToSummarize: [{ role: "user", content: "x", timestamp: 1 }], turnPrefixMessages: [], tokensBefore: 3 },
    }, sessionCtx(harnessFall, sessionDir, []).ctx) as { compaction: ModeResult };
    assert.equal(fell.compaction.summary, "second mode");
    assert.equal(calls, 2);

    calls = 0;
    flaky.run = async () => {
      calls += 1;
      if (calls === 1) throw new Error("snap failed");
      return { summary: "after throw", firstKeptEntryId: "kept-id", tokensBefore: 3 };
    };
    const threw = await handler(harnessFall, "session_before_compact")({
      preparation: { firstKeptEntryId: "kept-id", messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 3 },
    }, sessionCtx(harnessFall, sessionDir, []).ctx) as { compaction: ModeResult };
    assert.equal(threw.compaction.summary, "after throw");

    calls = 0;
    flaky.run = async () => {
      calls += 1;
      return undefined;
    };
    const harnessForced = createHarness();
    registerContextCompress(harnessForced.pi as never, {
      configPath: writeConfig(dir, { methodOrder: ["snap", "snap"], fallback: "cancel", serialize: policy }),
      modes: [flaky],
    });
    const forced = await handler(harnessForced, "session_before_compact")({
      customInstructions: "mode=snap focus on auth",
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [], turnPrefixMessages: [], tokensBefore: 1 },
    }, sessionCtx(harnessForced, sessionDir, []).ctx);
    assert.deepEqual(forced, { cancel: true });
    assert.equal(calls, 1);
  } finally {
    cleanup();
  }
});

test("originals can be disabled, listed, shown, and pruned", async () => {
  const { dir, cleanup } = tempCase();
  try {
    const sessionDir = path.join(dir, "session");
    const originals = path.join(dir, "originals");
    fs.mkdirSync(sessionDir);
    const harness = createHarness();
    registerContextCompress(harness.pi as never, {
      configPath: writeConfig(dir, {
        serialize: { thinking: [{ do: "drop" }] },
        originals: { enabled: false, dir: originals, actions: ["drop"] },
      }),
    });
    assert.equal(harness.tools.length, 0);
    const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "hidden thought" }], timestamp: 1 };
    const branch = [{ type: "message", id: "a", message: thinking }];
    const { ctx, notes } = sessionCtx(harness, sessionDir, branch);
    const dropped = await handler(harness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [thinking], turnPrefixMessages: [], tokensBefore: 10 },
    }, ctx) as { compaction: ModeResult };
    assert.match(dropped.compaction.details?.contextCompress?.archiveText ?? "", /original not saved/);
    assert.equal(fs.existsSync(originals), false);

    const harnessOn = createHarness();
    registerContextCompress(harnessOn.pi as never, {
      configPath: writeConfig(dir, {
        serialize: { thinking: [{ do: "drop" }] },
        originals: { dir: originals, retention: 1, actions: ["drop"] },
      }),
    });
    const { ctx: ctxOn, notes: commandNotes, compacts } = sessionCtx(harnessOn, sessionDir, branch);
    await handler(harnessOn, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [thinking], turnPrefixMessages: [], tokensBefore: 10 },
    }, ctxOn);
    const command = harnessOn.commands[0]?.handler as (args: string, ctx: unknown) => Promise<void>;
    await command("originals list", ctxOn);
    assert.match(commandNotes.join("\n"), /thinking/);
    assert.match(commandNotes.join("\n"), /drop/);
    const listed = fs.readdirSync(originals);
    assert.equal(listed.length, 1);
    await command(`originals show a:thinking:0`, ctxOn);
    assert.match(commandNotes.join("\n"), /hidden thought/);
    const old = path.join(originals, "old.txt");
    fs.writeFileSync(old, "tool: x\narguments: -\nkind: thinking\ntokens: 1\naction: drop\n\nstale");
    const aged = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, aged, aged);
    await command("originals prune", ctxOn);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(path.join(originals, listed[0] ?? "")), true);
    assert.match(commandNotes.join("\n"), /pruned 1/);

    const harnessSession = createHarness();
    registerContextCompress(harnessSession.pi as never, {
      configPath: writeConfig(dir, { originals: { dir: originals, retention: "session" }, serialize: policy }),
    });
    const sessionNotes: string[] = [];
    const sessionCtxLive = sessionCtx(harnessSession, sessionDir, []);
    sessionCtxLive.ctx.ui.notify = (message: string) => { sessionNotes.push(message); };
    const sessionCommand = harnessSession.commands[0]?.handler as (args: string, ctx: unknown) => Promise<void>;
    await sessionCommand("originals prune", sessionCtxLive.ctx);
    assert.match(sessionNotes.join("\n"), /nothing pruned/);
    await sessionCommand("status", ctxOn);
    assert.match(commandNotes.join("\n"), /methodOrder: snap/);
    assert.match(commandNotes.join("\n"), /fallback: pi-default/);
    assert.match(commandNotes.join("\n"), /1344x1344/);
    const showBranch = [{
      type: "compaction",
      id: "cmp",
      details: {
        contextCompress: {
          mode: "snap",
          archiveText: "SHOW_ARCHIVE_TOKEN kept full",
          frames: [{ path: path.join(sessionDir, "frame-001.png"), cols: 2, rows: 2, chars: 8 }],
          dropped: 0,
          head: "",
          tail: "",
          notice: "n",
        },
      },
    }];
    const showSession = sessionCtx(harnessOn, sessionDir, showBranch);
    await command("show", showSession.ctx);
    const shownArchive = path.join(sessionDir, "archive.txt");
    assert.equal(!fs.existsSync(path.join(sessionDir, "context-compress", "archive.txt")) && fs.readFileSync(shownArchive, "utf8").includes("SHOW_ARCHIVE_TOKEN") && showSession.notes.join("\n").includes(shownArchive), true);
    fs.writeFileSync(path.join(sessionDir, "frame-001.png"), "png");
    await handler(harnessOn, "context")({ messages: [{ role: "compactionSummary", content: "summary" }] }, showSession.ctx);
    const imageNotes: string[] = [];
    showSession.ctx.ui.notify = (message: string) => { imageNotes.push(message); };
    await command("status", showSession.ctx);
    assert.match(imageNotes.join("\n"), /last request images: 1/);
    await command("nope", ctxOn);
    assert.match(commandNotes.join("\n"), /Unknown context-compress mode nope/);
    assert.equal(compacts.length, 0);
    await command("snap focus on auth", ctxOn);
    assert.equal(compacts.at(-1), "mode=snap focus on auth");
    await command("dry-run", ctxOn);
    assert.match(commandNotes.join("\n"), /thinking:/);
    assert.equal(harnessOn.modelCalls.length, 0);
    assert.equal(harnessOn.entries.length, 0);
    assert.equal(notes.length >= 0, true);
  } finally {
    cleanup();
  }
});

test("summarizer runs only for old summarize-tier items and compaction uses digests", async () => {
  assert.deepEqual(
    resolveModelRef("openrouter/free", {
      find() { return undefined; },
      getAll() { return [{ provider: "openrouter", id: "openrouter/free" }]; },
    }),
    { provider: "openrouter", id: "openrouter/free" },
  );
  const { dir, cleanup } = tempCase();
  try {
    const sessionDir = path.join(dir, "session");
    fs.mkdirSync(sessionDir);
    const summarizeConfig = {
      serialize: {
        thinking: [{ do: "drop" }],
        toolCall: [{ do: "full" }],
        userMessage: [{ do: "full" }],
        modelResponse: [{ do: "full" }],
        toolResult: [{ do: "summarize", summarizer: { model: "other/tiny", maxOutputTokens: 40 } }],
      },
      summarizerModelConfig: { model: "global/base", minAgeTokens: 20, waitMs: 40, concurrency: 1, maxOutputTokens: 50 },
      originals: { dir: path.join(dir, "originals") },
      snap: { maxFrames: 2, maxBytes: 3_000_000 },
    };
    const quiet = createHarness();
    registerContextCompress(quiet.pi as never, { configPath: writeConfig(dir, { serialize: policy, originals: { dir: path.join(dir, "quiet-originals") } }) });
    assert.equal(quiet.handlers.get("turn_end"), undefined);
    assert.equal(quiet.handlers.get("agent_end"), undefined);
    const quietBranch = [{ type: "message", id: "u", message: { role: "user", content: "hello from a quiet session", timestamp: 1 } }];
    const quietCtx = sessionCtx(quiet, sessionDir, quietBranch);
    await handler(quiet, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [quietBranch[0]?.message], turnPrefixMessages: [], tokensBefore: 20 },
    }, quietCtx.ctx);
    assert.equal(quiet.modelCalls.length, 0);
    assert.equal(quiet.entries.some((entry) => entry.customType === "context-compress/digest"), false);

    const harness = createHarness();
    const loaded = ready(summarizeConfig);
    const hash = activePolicyHash(loaded);
    let attempts = 0;
    harness.setComplete(async (input) => {
      attempts += 1;
      if (input.includes("FAIL_ME") && attempts < 3) throw new Error("temporary");
      if (input.includes("TOO_LONG")) return { text: `${input} ${input}` };
      return { text: "brief digest" };
    });
    registerContextCompress(harness.pi as never, { configPath: writeConfig(dir, summarizeConfig) });
    assert.equal(harness.modelCalls.length, 0);
    const oldResult = {
      role: "toolResult",
      toolCallId: "old",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: `OLD_ITEM ${"o".repeat(200)}` }],
      timestamp: 1,
    };
    const newResult = {
      role: "toolResult",
      toolCallId: "new",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: `NEW_TAIL_SECRET ${"n".repeat(200)}` }],
      timestamp: 2,
    };
    const branch = [
      { type: "message", id: "old", message: oldResult },
      { type: "message", id: "new", message: newResult },
    ];
    const { ctx } = sessionCtx(harness, sessionDir, branch);
    await handler(harness, "turn_end")({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(harness.modelCalls.filter((call) => call.kind === "find" && call.provider === "other" && call.id === "tiny").length > 0, true);
    assert.equal(harness.modelCalls.some((call) => call.kind === "complete" && call.input?.includes("OLD_ITEM") && call.reasoningEffort === "minimal"), true);
    assert.equal(harness.modelCalls.some((call) => call.input?.includes("NEW_TAIL_SECRET")), false);
    const digest = harness.entries.find((entry) => entry.customType === "context-compress/digest");
    assert.equal((digest?.data as { text?: string })?.text, "brief digest");

    const readyBranch = [
      { type: "message", id: "old", message: oldResult },
      { type: "custom", customType: "context-compress/digest", data: { entryId: "old", kind: "toolResult", index: 0, ladderHash: hash, text: "DIGEST_READY_SHORT", model: "other/tiny" } },
      { type: "message", id: "new", message: { role: "user", content: "tail", timestamp: 3 } },
    ];
    const readyCtx = sessionCtx(harness, sessionDir, readyBranch);
    const before = harness.modelCalls.length;
    const used = await handler(harness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [oldResult], turnPrefixMessages: [], tokensBefore: 400 },
    }, readyCtx.ctx) as { compaction: ModeResult };
    assert.match(used.compaction.details?.contextCompress?.archiveText ?? "", /DIGEST_READY_SHORT/);
    assert.equal(harness.modelCalls.length, before);

    const staleBranch = [
      { type: "message", id: "old", message: oldResult },
      { type: "custom", customType: "context-compress/digest", data: { entryId: "old", kind: "toolResult", index: 0, ladderHash: "nope", text: "STALE_DIGEST_XYZ", model: "other/tiny" } },
    ];
    const stale = await handler(harness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [oldResult], turnPrefixMessages: [], tokensBefore: 400 },
    }, sessionCtx(harness, sessionDir, staleBranch).ctx) as { compaction: ModeResult };
    assert.equal((stale.compaction.details?.contextCompress?.archiveText ?? "").includes("STALE_DIGEST_XYZ"), false);
    assert.match(stale.compaction.summary, /digests missed and truncated/);

    const longResult = { ...oldResult, content: [{ type: "text", text: "TOO_LONG_ITEM_BODY" }] };
    const longHarness = createHarness();
    longHarness.setComplete(async () => ({ text: `${"TOO_LONG_ITEM_BODY".repeat(4)}` }));
    registerContextCompress(longHarness.pi as never, { configPath: writeConfig(dir, { ...summarizeConfig, summarizerModelConfig: { ...summarizeConfig.summarizerModelConfig, minAgeTokens: 1 } }) });
    const filler = { role: "user", content: "f".repeat(80), timestamp: 2 };
    const longBranch = [
      { type: "message", id: "old", message: longResult },
      { type: "message", id: "fill", message: filler },
    ];
    const longCtx = sessionCtx(longHarness, sessionDir, longBranch);
    await handler(longHarness, "turn_end")({}, longCtx.ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const kept = await handler(longHarness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [longResult], turnPrefixMessages: [], tokensBefore: 50 },
    }, longCtx.ctx) as { compaction: ModeResult };
    const keptArchive = kept.compaction.details?.contextCompress?.archiveText ?? "";
    assert.match(keptArchive, /TOO_LONG_ITEM_BODY/);
    assert.equal(keptArchive.includes("TOO_LONG_ITEM_BODY".repeat(4)), false);

    const failHarness = createHarness();
    let fails = 0;
    failHarness.setComplete(async () => {
      fails += 1;
      throw new Error("nope");
    });
    registerContextCompress(failHarness.pi as never, { configPath: writeConfig(dir, { ...summarizeConfig, summarizerModelConfig: { ...summarizeConfig.summarizerModelConfig, minAgeTokens: 1 } }) });
    const failBranch = [
      { type: "message", id: "old", message: oldResult },
      { type: "message", id: "fill", message: filler },
    ];
    const failCtx = sessionCtx(failHarness, sessionDir, failBranch);
    await handler(failHarness, "turn_end")({}, failCtx.ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fails, 2);
    assert.equal((failHarness.entries.at(-1)?.data as { failed?: boolean; error?: string })?.failed, true);
    assert.equal((failHarness.entries.at(-1)?.data as { error?: string })?.error, "nope");

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waitHarness = createHarness();
    waitHarness.setComplete(async () => {
      await gate;
      return { text: "late digest" };
    });
    registerContextCompress(waitHarness.pi as never, { configPath: writeConfig(dir, summarizeConfig) });
    const waitBranch = [
      { type: "message", id: "old", message: oldResult },
      { type: "message", id: "new", message: newResult },
    ];
    const waitCtx = sessionCtx(waitHarness, sessionDir, waitBranch);
    await handler(waitHarness, "turn_end")({}, waitCtx.ctx);
    const missed = await handler(waitHarness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [oldResult, newResult], turnPrefixMessages: [], tokensBefore: 800 },
    }, waitCtx.ctx) as { compaction: ModeResult };
    assert.match(missed.compaction.summary, /digests missed and truncated/);
    assert.equal((missed.compaction.details?.contextCompress?.archiveText ?? "").includes("late digest"), false);
    release();
    await handler(waitHarness, "session_shutdown")({}, waitCtx.ctx);
    const callsBefore = waitHarness.modelCalls.filter((call) => call.kind === "complete").length;
    await handler(waitHarness, "turn_end")({}, waitCtx.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(waitHarness.modelCalls.filter((call) => call.kind === "complete").length, callsBefore);

    const retryHarness = createHarness();
    let retryCalls = 0;
    retryHarness.setComplete(async () => {
      retryCalls += 1;
      if (retryCalls < 3) return { text: "", errorMessage: "429 rate limit exceeded retry-after: 0", stopReason: "error" };
      return { text: "retried digest" };
    });
    registerContextCompress(retryHarness.pi as never, { configPath: writeConfig(dir, { ...summarizeConfig, summarizerModelConfig: { ...summarizeConfig.summarizerModelConfig, minAgeTokens: 1 } }) });
    const retryBranch = [
      { type: "message", id: "old", message: oldResult },
      { type: "message", id: "fill", message: filler },
    ];
    const retryCtx = sessionCtx(retryHarness, sessionDir, retryBranch);
    await handler(retryHarness, "turn_end")({}, retryCtx.ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((retryHarness.entries.find((entry) => entry.customType === "context-compress/digest")?.data as { text?: string; failed?: boolean } | undefined)?.text === "retried digest", true);
  } finally {
    cleanup();
  }
});

test("reasoning effort skips a level this model does not list when a higher level is listed", () => {
  assert.equal(reasoningEffortFor({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }), "low");
});

test("project context-compress.json overrides the global file and keeps each dir with its file", () => {
  const globalPath = "/home/agent/context-compress.json";
  const projectPath = "/work/.pi/context-compress.json";
  const got = loadLayeredContextCompressConfig({
    globalPath,
    projectPath,
    globalBase: "/home/agent",
    projectBase: "/work",
  }, {
    existsSync: (file) => file === globalPath || file === projectPath,
    readFileSync: (file) => file === globalPath
      ? JSON.stringify({ originals: { dir: "global-box" }, snap: { maxFrames: 10 } })
      : JSON.stringify({ originals: { dir: "project-box" }, snap: { maxFrames: 3 } }),
  });
  assert.equal(got.kind === "ready" && got.config.originals.dir === "/work/project-box" && got.config.snap.maxFrames === 3, true);
});

test("text mode compacts without frames, caps the archive, injects nothing, and follows methodOrder", async () => {
  const { dir, cleanup } = tempCase();
  try {
    const sessionDir = path.join(dir, "session");
    fs.mkdirSync(sessionDir);
    const harness = createHarness();
    registerContextCompress(harness.pi as never, {
      configPath: writeConfig(dir, { methodOrder: ["text"], serialize: policy, text: { maxChars: 80 } }),
    });
    const head = { role: "user", content: `HEAD_KEEP ${"h".repeat(20)}`, timestamp: 1 };
    const middle = { role: "user", content: `ONLY_MIDDLE ${"m".repeat(800)}`, timestamp: 2 };
    const tail = { role: "user", content: "TAIL_KEEP", timestamp: 3 };
    const branch = [
      { type: "message", id: "h", message: head },
      { type: "message", id: "m", message: middle },
      { type: "message", id: "t", message: tail },
    ];
    const { ctx } = sessionCtx(harness, sessionDir, branch);
    const result = await handler(harness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [head, middle, tail], turnPrefixMessages: [], tokensBefore: 5000 },
    }, ctx) as { compaction: ModeResult };
    const details = result.compaction.details?.contextCompress;
    const summary = result.compaction.summary;
    assert.equal(details?.mode === "text" && details.frames.length === 0 && summary.includes("Reading guide:") && summary.includes("Recall index") && summary.includes("truncated") && details.archiveText.includes("HEAD_KEEP"), true);
    const dropAt = summary.indexOf(`[dropped ${details?.dropped} chars]`);
    const keptHead = summary.slice(summary.indexOf("HEAD_KEEP"), dropAt);
    assert.equal(details !== undefined && details.dropped > 0 && keptHead.includes("HEAD_KEEP") && !keptHead.includes("ONLY_MIDDLE") && summary.slice(dropAt).includes("TAIL_KEEP") && !summary.slice(dropAt).includes("ONLY_MIDDLE") && details.archiveText.includes("ONLY_MIDDLE") && summary.includes("text: ") && summary.includes(" chars (~"), true);

    const textBranch = [{ type: "compaction", summary, details: result.compaction.details }];
    const textCtx = sessionCtx(harness, sessionDir, textBranch);
    const injected = await handler(harness, "context")({ messages: [{ role: "compactionSummary", content: summary }] }, textCtx.ctx);
    const frame = path.join(sessionDir, "frame-001.png");
    fs.writeFileSync(frame, "png");
    const snapBranch = [{
      type: "compaction",
      details: {
        contextCompress: {
          mode: "snap",
          archiveText: "snap archive",
          frames: [{ path: frame, cols: 1, rows: 1, chars: 4 }],
          dropped: 0,
          head: "",
          tail: "",
          notice: "snap",
        },
      },
    }];
    const snapCtx = sessionCtx(harness, sessionDir, snapBranch);
    const snapInjected = await handler(harness, "context")({ messages: [{ role: "compactionSummary", content: "snap" }] }, snapCtx.ctx) as { messages: Array<{ content?: Array<{ type?: string }> }> };
    const sawImage = snapInjected.messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image"));
    assert.equal(injected === undefined && sawImage, true);

    const ordered = createHarness();
    registerContextCompress(ordered.pi as never, {
      configPath: writeConfig(dir, { methodOrder: ["snap", "text"], serialize: policy }),
    });
    const { ctx: orderedCtx, compacts } = sessionCtx(ordered, sessionDir, branch, { id: "text-only", input: ["text"] });
    const fell = await handler(ordered, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [tail], turnPrefixMessages: [], tokensBefore: 20 },
    }, orderedCtx) as { compaction: ModeResult };
    const command = ordered.commands[0]?.handler as (args: string, ctx: unknown) => Promise<void>;
    await command("text keep auth", orderedCtx);
    assert.equal(fell.compaction.details?.contextCompress?.mode === "text" && fell.compaction.details?.contextCompress?.frames.length === 0 && compacts.at(-1) === "mode=text keep auth", true);
  } finally {
    cleanup();
  }
});

test("a full item hidden by the text cap is recalled and a visible full item is not saved", async () => {
  const { dir, cleanup } = tempCase();
  try {
    const sessionDir = path.join(dir, "session");
    const originals = path.join(dir, "originals");
    fs.mkdirSync(sessionDir);
    const harness = createHarness();
    registerContextCompress(harness.pi as never, {
      configPath: writeConfig(dir, { methodOrder: ["text"], serialize: policy, originals: { dir: originals }, text: { maxChars: 80 } }),
    });
    const head = { role: "user", content: `HEAD_KEEP ${"h".repeat(20)}`, timestamp: 1 };
    const hidden = { role: "user", content: "FULL_HIDDEN", timestamp: 2 };
    const pad = { role: "user", content: `PAD ${"p".repeat(900)}`, timestamp: 3 };
    const tail = { role: "user", content: "TAIL_KEEP", timestamp: 4 };
    const branch = [
      { type: "message", id: "head", message: head },
      { type: "message", id: "mid", message: hidden },
      { type: "message", id: "pad", message: pad },
      { type: "message", id: "tail", message: tail },
    ];
    const { ctx } = sessionCtx(harness, sessionDir, branch);
    const result = await handler(harness, "session_before_compact")({
      preparation: { firstKeptEntryId: "k", messagesToSummarize: [head, hidden, pad, tail], turnPrefixMessages: [], tokensBefore: 4000 },
    }, ctx) as { compaction: ModeResult };
    const summary = result.compaction.summary;
    const recalled = recallOriginal({ dir: originals, id: "mid:userMessage:0", seen: new Set() });
    const tailFile = originalPath(originals, "tail:userMessage:0", false);
    assert.equal(recalled.isError === false && recalled.text.includes("FULL_HIDDEN") && summary.includes("mid:userMessage:0") && tailFile !== undefined && !fs.existsSync(tailFile), true);
  } finally {
    cleanup();
  }
});

test("reload still registers context-compress and the global copy does not", () => {
  const project = path.join(repoRoot, ".pi", "extensions", "context-compress", "index.ts");
  const other = path.join(repoRoot, "not-project", "index.ts");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cc-load-"));
  try {
    const globalLink = "/home/user/.pi/agent/extensions/context-compress/index.ts";
    assert.equal(shouldLoadContextCompress(project, repoRoot) && shouldLoadContextCompress(project, repoRoot) && !shouldLoadContextCompress(other, repoRoot) && shouldLoadContextCompress(other, scratch) && !shouldLoadContextCompress(globalLink, repoRoot, () => project) && shouldLoadContextCompress(project, repoRoot, () => project), true);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
