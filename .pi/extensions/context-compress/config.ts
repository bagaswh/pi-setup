import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_TRUNCATE_TO,
  KINDS,
  type Action,
  type Kind,
  type SummarizerConfig,
  type Tier,
} from "./ladder.ts";
import { SHAPE_NAMES, type ShapeName, type ShapeSetting } from "./render/raster.ts";

export type { ShapeSetting };

export type LadderSpec = {
  tiers: Tier[];
  summarizer?: SummarizerConfig;
};

export type SerializePolicy = {
  tokenEstimate: "chars/4";
  stubChars: number;
  truncateTo: number;
  ladders: Record<Kind, LadderSpec>;
  perTool: Record<string, Partial<Record<Kind, LadderSpec>>>;
};

export type OriginalsConfig = {
  enabled: boolean;
  actions: Action[];
  retention: "session" | number;
  dir?: string;
};

export type SnapConfig = {
  shape: ShapeSetting;
  maxFrames: number;
  maxBytes: number;
  serialize?: {
    ladders: Partial<Record<Kind, LadderSpec>>;
    perTool: Record<string, Partial<Record<Kind, LadderSpec>>>;
  };
};

export type TextConfig = {
  maxChars: number;
};

export type ContextCompressConfig = {
  methodOrder: string[];
  fallback: "pi-default" | "cancel";
  originals: OriginalsConfig;
  snap: SnapConfig;
  text: TextConfig;
  summarizerModelConfig: SummarizerConfig;
  policy: SerializePolicy;
  needsSummarizer: boolean;
};

export type StartupDecision =
  | { kind: "no-config" }
  | { kind: "fatal"; message: string }
  | { kind: "ready"; config: ContextCompressConfig };

const ACTIONS: readonly Action[] = ["full", "truncate", "summarize", "drop", "errorStub"];
const KNOWN_MODES = ["snap", "text"];
const TOP_KEYS = ["methodOrder", "fallback", "serialize", "originals", "summarizerModelConfig", "snap", "text"];
const DEFAULT_TEXT_MAX_CHARS = 120_000;
const SUMMARIZER_KEYS = ["model", "prompt", "maxOutputTokens", "thinkingLevel", "temperature", "concurrency", "minAgeTokens", "waitMs"];
const TIER_KEYS = ["upTo", "when", "do", "summarizer", "truncateTo"];
const SERIALIZE_META = ["tokenEstimate", "stubChars", "truncateTo", "perTool"];

const SHORTHAND: Record<string, { kind: Kind; style: "bool" | "include" | "summarizeBool" | "summarize" }> = {
  includeThinking: { kind: "thinking", style: "bool" },
  includeThinkingIfLessThanToks: { kind: "thinking", style: "include" },
  includeToolResults: { kind: "toolResult", style: "bool" },
  includeToolResultsIfLessThanToks: { kind: "toolResult", style: "include" },
  summarizeToolResults: { kind: "toolResult", style: "summarizeBool" },
  summarizeToolResultsIfToksExceeds: { kind: "toolResult", style: "summarize" },
  includeToolCalls: { kind: "toolCall", style: "bool" },
  includeToolCallsIfLessThanToks: { kind: "toolCall", style: "include" },
  summarizeToolCalls: { kind: "toolCall", style: "summarizeBool" },
  summarizeToolCallsIfToksExceeds: { kind: "toolCall", style: "summarize" },
  alwaysIncludeUserMessages: { kind: "userMessage", style: "bool" },
  includeUserMessagesIfLessThanToks: { kind: "userMessage", style: "include" },
  summarizeModelResponses: { kind: "modelResponse", style: "summarizeBool" },
  summarizeModelResponsesIfToksExceeds: { kind: "modelResponse", style: "summarize" },
};

const DEFAULT_SUMMARIZER: SummarizerConfig = {
  model: "azure-foundry-ai-agents-cus/gpt-6-luna",
  maxOutputTokens: 400,
  concurrency: 1,
  minAgeTokens: 30000,
  waitMs: 15000,
};

const DEFAULT_ACTIONS: Action[] = ["drop", "truncate", "summarize", "errorStub"];

type Fail = { ok: false; message: string };
type Ok<T> = { ok: true; value: T };

function fail(key: string, detail: string): Fail {
  return { ok: false, message: `context-compress config fatal: ${key}: ${detail}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: readonly string[], key: string): Fail | undefined {
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name)) return fail(key, `unknown key ${JSON.stringify(name)}`);
  }
  return undefined;
}

function parseSummarizer(raw: unknown, key: string): Ok<SummarizerConfig> | Fail {
  if (!isRecord(raw)) return fail(key, "must be an object");
  const unknown = unknownKey(raw, SUMMARIZER_KEYS, key);
  if (unknown) return unknown;
  const config: SummarizerConfig = {};
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !raw.model.includes("/")) return fail(key, "model must be provider/id");
    config.model = raw.model;
  }
  if (raw.prompt !== undefined) {
    if (typeof raw.prompt !== "string") return fail(key, "prompt must be a string");
    config.prompt = raw.prompt;
  }
  if (raw.thinkingLevel !== undefined) {
    if (typeof raw.thinkingLevel !== "string") return fail(key, "thinkingLevel must be a string");
    config.thinkingLevel = raw.thinkingLevel;
  }
  for (const name of ["maxOutputTokens", "concurrency", "minAgeTokens", "waitMs"] as const) {
    if (raw[name] === undefined) continue;
    if (typeof raw[name] !== "number" || !Number.isFinite(raw[name]) || (raw[name] as number) < 0) {
      return fail(key, `${name} must be a non-negative number`);
    }
    config[name] = raw[name] as number;
  }
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature)) return fail(key, "temperature must be a number");
    config.temperature = raw.temperature;
  }
  return { ok: true, value: config };
}

function parseTier(raw: unknown, key: string, kind: Kind): Ok<Tier> | Fail {
  if (!isRecord(raw)) return fail(key, "tier must be an object");
  const unknown = unknownKey(raw, TIER_KEYS, key);
  if (unknown) return unknown;
  if (typeof raw.do !== "string" || !ACTIONS.includes(raw.do as Action)) return fail(key, "do must be full, truncate, summarize, drop, or errorStub");
  const tier: Tier = { do: raw.do as Action };
  if (raw.upTo !== undefined) {
    if (typeof raw.upTo !== "number" || !Number.isFinite(raw.upTo) || raw.upTo < 0) return fail(key, "upTo must be a non-negative number");
    tier.upTo = raw.upTo;
  }
  if (raw.when !== undefined) {
    if (raw.when !== "error" && raw.when !== "ok") return fail(key, "when must be error or ok");
    tier.when = raw.when;
  }
  if (raw.truncateTo !== undefined) {
    if (typeof raw.truncateTo !== "number" || !Number.isFinite(raw.truncateTo) || raw.truncateTo < 0) {
      return fail(key, "truncateTo must be a non-negative number");
    }
    tier.truncateTo = raw.truncateTo;
  }
  if (tier.do === "errorStub" && kind !== "toolResult") return fail(key, "errorStub is valid only on toolResult");
  if (tier.do === "errorStub" && tier.when === "ok") return fail(key, "errorStub matches only error results");
  if (tier.do === "errorStub" && tier.when === undefined) tier.when = "error";
  if (raw.summarizer !== undefined) {
    if (tier.do !== "summarize") return fail(key, "summarizer is valid only on a summarize tier");
    const parsed = parseSummarizer(raw.summarizer, `${key}.summarizer`);
    if (!parsed.ok) return parsed;
    tier.summarizer = parsed.value;
  }
  return { ok: true, value: tier };
}

function parseLadder(raw: unknown, key: string, kind: Kind): Ok<LadderSpec> | Fail {
  let tiersRaw: unknown = raw;
  let summarizer: SummarizerConfig | undefined;
  if (isRecord(raw) && !("do" in raw)) {
    const unknown = unknownKey(raw, ["tiers", "summarizer"], key);
    if (unknown) return unknown;
    if (!Array.isArray(raw.tiers)) return fail(key, "tiers must be an array");
    tiersRaw = raw.tiers;
    if (raw.summarizer !== undefined) {
      const parsed = parseSummarizer(raw.summarizer, `${key}.summarizer`);
      if (!parsed.ok) return parsed;
      summarizer = parsed.value;
    }
  }
  if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) return fail(key, "ladder must be a non-empty tier array");
  const tiers: Tier[] = [];
  for (const [index, tier] of tiersRaw.entries()) {
    const parsed = parseTier(tier, `${key}[${index}]`, kind);
    if (!parsed.ok) return parsed;
    tiers.push(parsed.value);
  }
  if (kind === "userMessage" && tiers[tiers.length - 1]?.do === "drop") {
    return fail(key, "userMessage ladder may not end in drop");
  }
  return { ok: true, value: { tiers, summarizer } };
}

type ShorthandBucket = {
  bool?: boolean;
  include?: number;
  summarizeBool?: boolean;
  summarize?: number;
};

function expandBucket(kind: Kind, bucket: ShorthandBucket, key: string): Ok<Tier[]> | Fail {
  const styles = [bucket.bool !== undefined, bucket.include !== undefined, bucket.summarizeBool !== undefined, bucket.summarize !== undefined].filter(Boolean).length;
  const pair = bucket.include !== undefined && bucket.summarize !== undefined && bucket.bool === undefined && bucket.summarizeBool === undefined;
  if (styles > 1 && !pair) return fail(key, `conflicting shorthand for ${kind}`);
  if (bucket.bool !== undefined && styles === 1) {
    const terminal: Action = bucket.bool ? "full" : "drop";
    return { ok: true, value: [{ do: terminal }] };
  }
  if (bucket.summarizeBool) return { ok: true, value: [{ do: "summarize" }] };
  const terminal: Action = kind === "userMessage" ? "truncate" : "drop";
  const n1 = bucket.include;
  const n2 = bucket.summarize;
  if (n1 !== undefined && n2 !== undefined) {
    if (n1 >= n2) return { ok: true, value: [{ upTo: n1, do: "full" }, { do: "summarize" }] };
    return { ok: true, value: [{ upTo: n1, do: "full" }, { upTo: n2, do: "truncate" }, { do: "summarize" }] };
  }
  if (n1 !== undefined) return { ok: true, value: [{ upTo: n1, do: "full" }, { do: terminal }] };
  if (n2 !== undefined) return { ok: true, value: [{ upTo: n2, do: "full" }, { do: "summarize" }] };
  return { ok: true, value: [] };
}

function parseSerialize(raw: unknown, key: string, partial: boolean): Ok<SerializePolicy> | Fail {
  if (raw === undefined) {
    return {
      ok: true,
      value: {
        tokenEstimate: "chars/4",
        stubChars: 200,
        truncateTo: DEFAULT_TRUNCATE_TO,
        ladders: Object.fromEntries(KINDS.map((kind) => [kind, { tiers: [{ do: "full" as const }] }])) as Record<Kind, LadderSpec>,
        perTool: {},
      },
    };
  }
  if (!isRecord(raw)) return fail(key, "must be an object");
  const allowed = [...SERIALIZE_META, ...KINDS, ...Object.keys(SHORTHAND)];
  const unknown = unknownKey(raw, allowed, key);
  if (unknown) return unknown;
  if (raw.tokenEstimate !== undefined && raw.tokenEstimate !== "chars/4") return fail(key, "tokenEstimate must be chars/4");
  if (raw.stubChars !== undefined && (typeof raw.stubChars !== "number" || raw.stubChars < 0)) return fail(key, "stubChars must be a non-negative number");
  if (raw.truncateTo !== undefined && (typeof raw.truncateTo !== "number" || raw.truncateTo < 0)) return fail(key, "truncateTo must be a non-negative number");

  const buckets = new Map<Kind, ShorthandBucket>();
  for (const [name, spec] of Object.entries(SHORTHAND)) {
    if (raw[name] === undefined) continue;
    const bucket = buckets.get(spec.kind) ?? {};
    if (spec.style === "bool" || spec.style === "summarizeBool") {
      if (typeof raw[name] !== "boolean") return fail(key, `${name} must be a boolean`);
      if (spec.style === "bool") bucket.bool = raw[name] as boolean;
      else bucket.summarizeBool = raw[name] as boolean;
    } else {
      if (typeof raw[name] !== "number" || (raw[name] as number) < 0) return fail(key, `${name} must be a non-negative number`);
      if (spec.style === "include") bucket.include = raw[name] as number;
      else bucket.summarize = raw[name] as number;
    }
    buckets.set(spec.kind, bucket);
  }

  const ladders = {} as Record<Kind, LadderSpec>;
  for (const kind of KINDS) {
    const explicit = raw[kind];
    const bucket = buckets.get(kind);
    if (explicit !== undefined && bucket) return fail(key, `shorthand and ladder both set for ${kind}`);
    if (explicit !== undefined) {
      const parsed = parseLadder(explicit, `${key}.${kind}`, kind);
      if (!parsed.ok) return parsed;
      ladders[kind] = parsed.value;
      continue;
    }
    if (bucket) {
      const expanded = expandBucket(kind, bucket, key);
      if (!expanded.ok) return expanded;
      if (kind === "userMessage" && expanded.value[expanded.value.length - 1]?.do === "drop") {
        return fail(key, "userMessage ladder may not end in drop");
      }
      ladders[kind] = { tiers: expanded.value };
      continue;
    }
    if (!partial) ladders[kind] = { tiers: [{ do: "full" }] };
  }

  let perTool: SerializePolicy["perTool"] = {};
  if (raw.perTool !== undefined) {
    if (!isRecord(raw.perTool)) return fail(key, "perTool must be an object");
    const parsed = parsePerTool(raw.perTool, `${key}.perTool`);
    if (!parsed.ok) return parsed;
    perTool = parsed.value;
  }

  return {
    ok: true,
    value: {
      tokenEstimate: "chars/4",
      stubChars: typeof raw.stubChars === "number" ? raw.stubChars : 200,
      truncateTo: typeof raw.truncateTo === "number" ? raw.truncateTo : DEFAULT_TRUNCATE_TO,
      ladders,
      perTool,
    },
  };
}

function parsePerTool(raw: Record<string, unknown>, key: string): Ok<SerializePolicy["perTool"]> | Fail {
  const perTool: SerializePolicy["perTool"] = {};
  for (const [tool, value] of Object.entries(raw)) {
    if (!isRecord(value)) return fail(key, `${tool} must be an object`);
    const unknown = unknownKey(value, KINDS, `${key}.${tool}`);
    if (unknown) return unknown;
    const kinds: Partial<Record<Kind, LadderSpec>> = {};
    for (const kind of KINDS) {
      if (value[kind] === undefined) continue;
      const parsed = parseLadder(value[kind], `${key}.${tool}.${kind}`, kind);
      if (!parsed.ok) return parsed;
      kinds[kind] = parsed.value;
    }
    perTool[tool] = kinds;
  }
  return { ok: true, value: perTool };
}

function ladderHasSummarize(spec: LadderSpec | undefined): boolean {
  return spec?.tiers.some((tier) => tier.do === "summarize") ?? false;
}

export function policyNeedsSummarizer(policy: SerializePolicy, snap?: SnapConfig["serialize"]): boolean {
  for (const kind of KINDS) {
    if (ladderHasSummarize(policy.ladders[kind])) return true;
    if (ladderHasSummarize(snap?.ladders[kind])) return true;
  }
  for (const tool of Object.values(policy.perTool)) {
    for (const spec of Object.values(tool)) if (ladderHasSummarize(spec)) return true;
  }
  for (const tool of Object.values(snap?.perTool ?? {})) {
    for (const spec of Object.values(tool)) if (ladderHasSummarize(spec)) return true;
  }
  return false;
}

export function policyHash(policy: SerializePolicy, global: SummarizerConfig, snap?: SnapConfig["serialize"]): string {
  return createHash("sha256").update(JSON.stringify({ policy, global, snap })).digest("hex");
}

function parseConfig(raw: unknown): Ok<ContextCompressConfig> | Fail {
  if (!isRecord(raw)) return fail("top-level", "JSON must be an object");
  const unknown = unknownKey(raw, TOP_KEYS, "top-level");
  if (unknown) return unknown;

  let methodOrder = ["snap"];
  if (raw.methodOrder !== undefined) {
    if (!Array.isArray(raw.methodOrder) || raw.methodOrder.length === 0) return fail("methodOrder", "must be a non-empty array of mode names");
    for (const name of raw.methodOrder) {
      if (typeof name !== "string" || !KNOWN_MODES.includes(name)) return fail("methodOrder", `unknown mode ${JSON.stringify(name)}`);
    }
    methodOrder = raw.methodOrder as string[];
  }

  let fallback: "pi-default" | "cancel" = "pi-default";
  if (raw.fallback !== undefined) {
    if (raw.fallback !== "pi-default" && raw.fallback !== "cancel") return fail("fallback", "must be pi-default or cancel");
    fallback = raw.fallback;
  }

  const serialize = parseSerialize(raw.serialize, "serialize", false);
  if (!serialize.ok) return serialize;

  let originals: OriginalsConfig = { enabled: true, actions: [...DEFAULT_ACTIONS], retention: "session" };
  if (raw.originals !== undefined) {
    if (!isRecord(raw.originals)) return fail("originals", "must be an object");
    const originalsUnknown = unknownKey(raw.originals, ["enabled", "actions", "retention", "dir"], "originals");
    if (originalsUnknown) return originalsUnknown;
    if (raw.originals.enabled !== undefined && typeof raw.originals.enabled !== "boolean") return fail("originals", "enabled must be a boolean");
    if (raw.originals.dir !== undefined && typeof raw.originals.dir !== "string") return fail("originals", "dir must be a string");
    if (raw.originals.actions !== undefined) {
      if (!Array.isArray(raw.originals.actions) || raw.originals.actions.some((action) => typeof action !== "string" || !ACTIONS.includes(action as Action))) {
        return fail("originals", "actions must be a list of drop, truncate, summarize, errorStub, or full");
      }
    }
    if (raw.originals.retention !== undefined && raw.originals.retention !== "session" && (typeof raw.originals.retention !== "number" || raw.originals.retention < 0)) {
      return fail("originals", "retention must be session or a number of days");
    }
    originals = {
      enabled: raw.originals.enabled !== false,
      actions: (raw.originals.actions as Action[] | undefined) ?? [...DEFAULT_ACTIONS],
      retention: (raw.originals.retention as OriginalsConfig["retention"] | undefined) ?? "session",
      dir: typeof raw.originals.dir === "string" ? raw.originals.dir : undefined,
    };
  }

  let summarizerModelConfig: SummarizerConfig = { ...DEFAULT_SUMMARIZER };
  if (raw.summarizerModelConfig !== undefined) {
    const parsed = parseSummarizer(raw.summarizerModelConfig, "summarizerModelConfig");
    if (!parsed.ok) return parsed;
    summarizerModelConfig = { ...DEFAULT_SUMMARIZER, ...parsed.value };
  }

  let snap: SnapConfig = { shape: "auto", maxFrames: 64, maxBytes: 3_000_000 };
  if (raw.snap !== undefined) {
    if (!isRecord(raw.snap)) return fail("snap", "must be an object");
    const snapUnknown = unknownKey(raw.snap, ["shape", "maxFrames", "maxBytes", "serialize"], "snap");
    if (snapUnknown) return snapUnknown;
    if (raw.snap.maxFrames !== undefined && (typeof raw.snap.maxFrames !== "number" || raw.snap.maxFrames < 1)) return fail("snap", "maxFrames must be a positive number");
    if (raw.snap.maxBytes !== undefined && (typeof raw.snap.maxBytes !== "number" || raw.snap.maxBytes < 1)) return fail("snap", "maxBytes must be a positive number");
    let shape: ShapeSetting = "auto";
    if (raw.snap.shape !== undefined) {
      if (raw.snap.shape === "auto" || (typeof raw.snap.shape === "string" && SHAPE_NAMES.includes(raw.snap.shape as ShapeName))) {
        shape = raw.snap.shape as ShapeSetting;
      } else if (isRecord(raw.snap.shape)) {
        const shapeUnknown = unknownKey(raw.snap.shape, ["frameWidth", "frameHeight", "cellWidth", "cellHeight", "tokensPerFrame"], "snap.shape");
        if (shapeUnknown) return shapeUnknown;
        for (const name of ["frameWidth", "frameHeight", "cellWidth", "cellHeight", "tokensPerFrame"]) {
          if (typeof raw.snap.shape[name] !== "number" || (raw.snap.shape[name] as number) <= 0) return fail("snap.shape", `${name} must be a positive number`);
        }
        shape = {
          frameWidth: raw.snap.shape.frameWidth as number,
          frameHeight: raw.snap.shape.frameHeight as number,
          cellWidth: raw.snap.shape.cellWidth as number,
          cellHeight: raw.snap.shape.cellHeight as number,
          tokensPerFrame: raw.snap.shape.tokensPerFrame as number,
        };
      } else {
        return fail("snap.shape", "must be auto, a model name, or a shape object");
      }
    }
    let snapSerialize: SnapConfig["serialize"];
    if (raw.snap.serialize !== undefined) {
      const parsed = parseSerialize(raw.snap.serialize, "snap.serialize", true);
      if (!parsed.ok) return parsed;
      snapSerialize = { ladders: parsed.value.ladders, perTool: parsed.value.perTool };
    }
    snap = {
      shape,
      maxFrames: typeof raw.snap.maxFrames === "number" ? raw.snap.maxFrames : 64,
      maxBytes: typeof raw.snap.maxBytes === "number" ? raw.snap.maxBytes : 3_000_000,
      serialize: snapSerialize,
    };
  }

  let text: TextConfig = { maxChars: DEFAULT_TEXT_MAX_CHARS };
  if (raw.text !== undefined) {
    if (!isRecord(raw.text)) return fail("text", "must be an object");
    const textUnknown = unknownKey(raw.text, ["maxChars"], "text");
    if (textUnknown) return textUnknown;
    if (raw.text.maxChars !== undefined && (typeof raw.text.maxChars !== "number" || raw.text.maxChars < 1)) return fail("text", "maxChars must be a positive number");
    text = { maxChars: typeof raw.text.maxChars === "number" ? raw.text.maxChars : DEFAULT_TEXT_MAX_CHARS };
  }

  const policy = serialize.value;
  return {
    ok: true,
    value: {
      methodOrder,
      fallback,
      originals,
      snap,
      text,
      summarizerModelConfig,
      policy,
      needsSummarizer: policyNeedsSummarizer(policy, snap.serialize),
    },
  };
}

export function loadContextCompressConfig(
  configPath: string,
  deps: { existsSync?: (path: string) => boolean; readFileSync?: (path: string, encoding: BufferEncoding) => string } = {},
): StartupDecision {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? ((filePath: string, encoding: BufferEncoding) => fs.readFileSync(filePath, encoding));
  if (!existsSync(configPath)) return { kind: "no-config" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "fatal", message: `context-compress config fatal: top-level: cannot parse JSON at ${configPath}: ${message}` };
  }
  const config = parseConfig(parsed);
  if (!config.ok) return { kind: "fatal", message: config.message };
  return { kind: "ready", config: config.value };
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (Array.isArray(over) || !isRecord(base) || !isRecord(over)) return over;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) merged[key] = deepMerge(merged[key], value);
  return merged;
}

function resolveConfigPath(value: string, base: string): string {
  if (path.isAbsolute(value) || value.includes("://")) return value;
  return path.resolve(base, value);
}

function withOriginalsDir(raw: unknown, base: string): unknown {
  if (!isRecord(raw) || !isRecord(raw.originals) || typeof raw.originals.dir !== "string") return raw;
  return { ...raw, originals: { ...raw.originals, dir: resolveConfigPath(raw.originals.dir, base) } };
}

export function loadLayeredContextCompressConfig(
  paths: { globalPath: string; projectPath: string; globalBase: string; projectBase: string },
  deps: { existsSync?: (path: string) => boolean; readFileSync?: (path: string, encoding: BufferEncoding) => string } = {},
): StartupDecision {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const readFileSync = deps.readFileSync ?? ((filePath: string, encoding: BufferEncoding) => fs.readFileSync(filePath, encoding));
  const read = (file: string, base: string): { ok: true; value: unknown } | StartupDecision | undefined => {
    if (!existsSync(file)) return undefined;
    try {
      return { ok: true, value: withOriginalsDir(JSON.parse(readFileSync(file, "utf8")), base) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "fatal", message: `context-compress config fatal: top-level: cannot parse JSON at ${file}: ${message}` };
    }
  };
  const globalFile = read(paths.globalPath, paths.globalBase);
  if (globalFile && "kind" in globalFile) return globalFile;
  const projectFile = read(paths.projectPath, paths.projectBase);
  if (projectFile && "kind" in projectFile) return projectFile;
  if (!globalFile && !projectFile) return { kind: "no-config" };
  const merged = globalFile?.ok && projectFile?.ok ? deepMerge(globalFile.value, projectFile.value) : (projectFile?.ok ? projectFile.value : globalFile?.value);
  const config = parseConfig(merged);
  if (!config.ok) return { kind: "fatal", message: config.message };
  return { kind: "ready", config: config.value };
}

export function effectiveLadder(policy: SerializePolicy, snap: SnapConfig | undefined, kind: Kind, toolName: string | undefined): LadderSpec {
  const tool = toolName ? snap?.serialize?.perTool[toolName]?.[kind] ?? policy.perTool[toolName]?.[kind] : undefined;
  if (tool) return tool;
  return snap?.serialize?.ladders[kind] ?? policy.ladders[kind] ?? { tiers: [{ do: "full" }] };
}
