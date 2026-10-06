import { effectiveLadder, policyHash, type ContextCompressConfig, type SerializePolicy, type SnapConfig } from "./config.ts";
import {
  estimateTokens,
  layerSummarizer,
  resolveTier,
  type Action,
  type Kind,
  type SummarizerConfig,
  type Tier,
} from "./ladder.ts";

export type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
};

export type ArchiveMessage = {
  role?: string;
  content?: string | ContentBlock[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
  command?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  summary?: string;
  customType?: string;
};

export type SourcedMessage = {
  entryId: string;
  message: ArchiveMessage;
};

export type ExtractedItem = {
  id: string;
  entryId: string;
  kind: Kind;
  index: number;
  text: string;
  isError: boolean;
  toolName?: string;
  argumentsText?: string;
  exitCode?: number;
  tokens: number;
};

export type OriginalRecord = {
  id: string;
  entryId: string;
  kind: Kind;
  index: number;
  toolName?: string;
  argumentsText?: string;
  tokens: number;
  action: Action;
  text: string;
  error: boolean;
};

export type DigestHit = {
  text?: string;
  keepOriginal?: boolean;
  failed?: boolean;
  error?: string;
};

export type DigestLookup = (item: ExtractedItem) => Promise<DigestHit | undefined>;

export type KindCounts = Record<Kind, Record<Action, number>>;

export type FullPlacement = {
  id: string;
  entryId: string;
  kind: Kind;
  index: number;
  start: number;
  end: number;
  tokens: number;
  toolName?: string;
  argumentsText?: string;
  text?: string;
};

export type SerializeResult = {
  text: string;
  originals: OriginalRecord[];
  placements: FullPlacement[];
  counts: Record<Action, number>;
  byKind: KindCounts;
  hits: Array<{ kind: Kind; action: Action; tier: Tier }>;
  sourceTokens: number;
  digestMisses: number;
  digestErrors: string[];
};

const LABELS: Record<Kind, string> = {
  thinking: "thinking",
  toolResult: "tool result",
  toolCall: "tool call",
  userMessage: "user message",
  modelResponse: "model response",
};

const ACTION_WORD: Record<Action, string> = {
  full: "full",
  truncate: "truncated",
  summarize: "summarized",
  drop: "dropped",
  errorStub: "errorStub",
};

function emptyCounts(): Record<Action, number> {
  return { full: 0, truncate: 0, summarize: 0, drop: 0, errorStub: 0 };
}

function emptyByKind(): KindCounts {
  return {
    thinking: emptyCounts(),
    toolResult: emptyCounts(),
    toolCall: emptyCounts(),
    userMessage: emptyCounts(),
    modelResponse: emptyCounts(),
  };
}

function blockText(content: ArchiveMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) text += block.text;
    if (block.type === "image") text += "[image]";
  }
  return text;
}

function argsText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function exitCodeOf(details: unknown, message: ArchiveMessage): number | undefined {
  if (typeof message.exitCode === "number") return message.exitCode;
  if (!details || typeof details !== "object") return undefined;
  const code = (details as { exitCode?: unknown; code?: unknown }).exitCode ?? (details as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function pushItem(
  items: ExtractedItem[],
  indexes: Record<Kind, number>,
  entryId: string,
  kind: Kind,
  text: string,
  extra: Partial<ExtractedItem> = {},
): void {
  const index = indexes[kind];
  indexes[kind] += 1;
  items.push({
    id: `${entryId}:${kind}:${index}`,
    entryId,
    kind,
    index,
    text,
    isError: extra.isError ?? false,
    toolName: extra.toolName,
    argumentsText: extra.argumentsText,
    exitCode: extra.exitCode,
    tokens: estimateTokens(text),
  });
}

export function extractItems(messages: readonly SourcedMessage[]): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  const calls = new Map<string, { toolName: string; argumentsText: string }>();
  for (const sourced of messages) {
    const message = sourced.message;
    const indexes: Record<Kind, number> = { thinking: 0, toolResult: 0, toolCall: 0, userMessage: 0, modelResponse: 0 };
    if (message.role === "assistant" && Array.isArray(message.content)) {
      let reply = "";
      const flush = () => {
        if (!reply) return;
        pushItem(items, indexes, sourced.entryId, "modelResponse", reply);
        reply = "";
      };
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "thinking") {
          flush();
          pushItem(items, indexes, sourced.entryId, "thinking", block.thinking ?? "");
          continue;
        }
        if (block.type === "toolCall") {
          flush();
          const argumentsText = argsText(block.arguments);
          if (block.id) calls.set(block.id, { toolName: block.name ?? "tool", argumentsText });
          pushItem(items, indexes, sourced.entryId, "toolCall", argumentsText, { toolName: block.name ?? "tool", argumentsText });
          continue;
        }
        if (block.type === "text") reply += block.text ?? "";
        if (block.type === "image") reply += "[image]";
      }
      flush();
      continue;
    }
    if (message.role === "toolResult") {
      const paired = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      pushItem(items, indexes, sourced.entryId, "toolResult", blockText(message.content), {
        isError: message.isError === true,
        toolName: message.toolName ?? paired?.toolName ?? "tool",
        argumentsText: paired?.argumentsText ?? "",
        exitCode: exitCodeOf(message.details, message),
      });
      continue;
    }
    if (message.role === "bashExecution") {
      pushItem(items, indexes, sourced.entryId, "toolResult", message.output ?? "", {
        isError: message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0),
        toolName: "bash",
        argumentsText: message.command ?? "",
        exitCode: message.exitCode,
      });
      continue;
    }
    if (message.role === "user" || message.role === "custom") {
      pushItem(items, indexes, sourced.entryId, "userMessage", blockText(message.content));
      continue;
    }
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
      pushItem(items, indexes, sourced.entryId, "modelResponse", message.summary ?? "");
    }
  }
  return items;
}

function marker(kind: Kind, tokens: number, action: Action, id: string, saved: boolean): string {
  const label = `${LABELS[kind]} ${tokens.toLocaleString("en-US")} tok ${ACTION_WORD[action]}`;
  if (!saved) return `[${label}, original not saved]`;
  return `[${label}, id=${id} -> context_compress_recall]`;
}

function header(item: ExtractedItem): string {
  const name = item.toolName ?? "tool";
  const preview = (item.argumentsText ?? "").slice(0, 80);
  return `${name}(${preview})`;
}

function truncateBody(text: string, maxTokens: number, kind: Kind, id: string, saved: boolean): string {
  const maxChars = Math.max(0, maxTokens) * 4;
  const stamp = marker(kind, estimateTokens(text), "truncate", id, saved);
  if (text.length <= maxChars) return `${text}\n${stamp}`;
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
  return `${head}\n${stamp}\n${tail}`;
}

function renderItem(item: ExtractedItem, action: Action, saved: boolean, summary: string | undefined, truncateTo: number, stubChars: number): string {
  const toolish = item.kind === "toolCall" || item.kind === "toolResult";
  const lead = toolish ? header(item) : "";
  if (action === "full") {
    if (item.kind === "toolCall") return `${item.toolName ?? "tool"}(${item.argumentsText ?? ""})`;
    if (lead) return `${lead}\n${item.text}`;
    return item.text;
  }
  if (action === "drop") {
    const line = marker(item.kind, item.tokens, "drop", item.id, saved);
    return lead ? `${lead}\n${line}` : line;
  }
  if (action === "errorStub") {
    const first = (item.text.split(/\r?\n/)[0] ?? "").slice(0, stubChars);
    const lines = [`${item.toolName ?? "tool"}: ${first}`];
    if (item.exitCode !== undefined) lines.push(`exit ${item.exitCode}`);
    lines.push(marker(item.kind, item.tokens, "errorStub", item.id, saved));
    return lines.join("\n");
  }
  if (action === "summarize" && summary !== undefined) {
    const line = marker(item.kind, item.tokens, "summarize", item.id, saved);
    const body = `${summary}\n${line}`;
    return lead ? `${lead}\n${body}` : body;
  }
  const body = truncateBody(item.text, truncateTo, item.kind, item.id, saved);
  if (item.kind === "toolCall") return `${item.toolName ?? "tool"}\n${body}`;
  return lead ? `${lead}\n${body}` : body;
}

export async function serializeArchive(opts: {
  messages: readonly SourcedMessage[];
  policy: SerializePolicy;
  snap?: SnapConfig;
  globalSummarizer?: SummarizerConfig;
  firstUserEntryId?: string;
  saveActions?: readonly Action[];
  lookupDigest?: DigestLookup;
  saveOriginal?: (record: OriginalRecord) => void;
}): Promise<SerializeResult> {
  const items = extractItems(opts.messages);
  const counts = emptyCounts();
  const byKind = emptyByKind();
  const hits: SerializeResult["hits"] = [];
  const originals: OriginalRecord[] = [];
  const placements: FullPlacement[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let digestMisses = 0;
  const digestErrors: string[] = [];
  let sourceTokens = 0;
  const saveActions = new Set(opts.saveActions ?? ["drop", "truncate", "summarize", "errorStub"]);

  for (const item of items) {
    sourceTokens += item.tokens;
    const forcedFull = item.kind === "userMessage" && item.entryId === opts.firstUserEntryId && item.index === 0;
    const ladder = effectiveLadder(opts.policy, opts.snap, item.kind, item.toolName);
    const tier = forcedFull ? { do: "full" as const } : resolveTier(ladder.tiers, item.tokens, item.isError);
    let action: Action = tier.do;
    let summary: string | undefined;
    if (action === "summarize") {
      const hit = opts.lookupDigest ? await opts.lookupDigest(item) : undefined;
      if (hit?.keepOriginal) {
        action = "full";
      } else if (hit?.text && estimateTokens(hit.text) < item.tokens) {
        summary = hit.text;
      } else {
        action = "truncate";
        digestMisses += 1;
        if (hit?.error) digestErrors.push(hit.error);
      }
    }
    counts[action] += 1;
    byKind[item.kind][action] += 1;
    hits.push({ kind: item.kind, action, tier });
    const saved = action !== "full" && saveActions.has(action);
    if (action !== "full") {
      const record: OriginalRecord = {
        id: item.id,
        entryId: item.entryId,
        kind: item.kind,
        index: item.index,
        toolName: item.toolName,
        argumentsText: item.argumentsText,
        tokens: item.tokens,
        action,
        text: item.text,
        error: action === "errorStub",
      };
      originals.push(record);
      if (saved) opts.saveOriginal?.(record);
    }
    const truncateTo = tier.truncateTo ?? opts.policy.truncateTo;
    const rendered = renderItem(item, action, saved, summary, truncateTo, opts.policy.stubChars);
    if (parts.length > 0) cursor += 2;
    const start = cursor;
    parts.push(rendered);
    cursor += rendered.length;
    if (action === "full") {
      placements.push({
        id: item.id,
        entryId: item.entryId,
        kind: item.kind,
        index: item.index,
        start,
        end: cursor,
        tokens: item.tokens,
        toolName: item.toolName,
        argumentsText: item.argumentsText,
        text: item.text,
      });
    }
  }

  return { text: parts.join("\n\n"), originals, placements, counts, byKind, hits, sourceTokens, digestMisses, digestErrors };
}

export function summarizerFor(policy: SerializePolicy, snap: SnapConfig | undefined, global: SummarizerConfig, item: ExtractedItem): SummarizerConfig {
  const kindLadder = snap?.serialize?.ladders[item.kind] ?? policy.ladders[item.kind];
  const toolLadder = item.toolName ? snap?.serialize?.perTool[item.toolName]?.[item.kind] ?? policy.perTool[item.toolName]?.[item.kind] : undefined;
  const used = toolLadder ?? kindLadder ?? { tiers: [{ do: "full" as const }] };
  const tier = resolveTier(used.tiers, item.tokens, item.isError);
  return layerSummarizer(global, kindLadder?.summarizer, toolLadder?.summarizer, tier.do === "summarize" ? tier.summarizer : undefined);
}

export function activePolicyHash(config: ContextCompressConfig): string {
  return policyHash(config.policy, config.summarizerModelConfig, config.snap.serialize);
}
