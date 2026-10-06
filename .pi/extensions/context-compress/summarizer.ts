import { effectiveLadder, type ContextCompressConfig } from "./config.ts";
import { estimateTokens, resolveTier } from "./ladder.ts";
import {
  extractItems,
  summarizerFor,
  type DigestHit,
  type ExtractedItem,
  type SourcedMessage,
} from "./serialize.ts";

export type DigestRecord = {
  entryId: string;
  kind: string;
  index: number;
  ladderHash: string;
  text?: string;
  model?: string;
  usage?: unknown;
  failed?: boolean;
  error?: string;
  keepOriginal?: boolean;
};

export type ModelCaller = (req: {
  model: string;
  prompt: string;
  input: string;
  maxOutputTokens?: number;
  thinkingLevel?: string;
  temperature?: number;
  signal?: AbortSignal;
}) => Promise<{ text: string; usage?: unknown; stopReason?: string; error?: string }>;

export function clipDigestError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const redacted = raw
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|x-api-key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return redacted.replace(/\s+/g, " ").trim().slice(0, 200) || "summarizer failed";
}

const DEFAULT_PROMPT = "Summarize the following item in a few sentences. Keep names, paths, errors, and decisions. Reply with the summary only.";

function isRateLimit(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return /\b429\b|rate limit exceeded/i.test(text);
}

function rateLimitWaitMs(error: string | undefined): number {
  const match = error?.match(/retry-after[^0-9]{0,16}(\d+)/i);
  if (!match) return 3000;
  return Math.min(Math.max(0, Number(match[1])) * 1000, 15_000);
}

export function createSummarizer(opts: {
  config: ContextCompressConfig;
  hash: string;
  callModel: ModelCaller;
  appendDigest: (record: DigestRecord) => void;
}) {
  const memory = new Map<string, DigestRecord>();
  const inflight = new Map<string, Promise<void>>();
  let stopped = false;
  let deadline = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastMessages: readonly SourcedMessage[] = [];
  const abort = new AbortController();

  function ready(id: string): DigestRecord | undefined {
    const hit = memory.get(id);
    if (!hit || hit.ladderHash !== opts.hash) return undefined;
    return hit;
  }

  const worker = {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      abort.abort();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
    armWait(waitMs: number) {
      deadline = Date.now() + Math.max(0, waitMs);
    },
    remember(record: DigestRecord) {
      memory.set(`${record.entryId}:${record.kind}:${record.index}`, record);
    },
    async lookup(item: ExtractedItem, waitMs: number): Promise<DigestHit | undefined> {
      if (!deadline) deadline = Date.now() + Math.max(0, waitMs);
      if (!ready(item.id)) {
        const pending = inflight.get(item.id);
        if (pending) {
          const left = Math.max(0, deadline - Date.now());
          await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, left))]);
        }
      }
      const hit = ready(item.id);
      if (!hit) return undefined;
      if (hit.failed) return { failed: true, error: hit.error };
      if (hit.keepOriginal) return { keepOriginal: true };
      return { text: hit.text };
    },
    async kick(messages: readonly SourcedMessage[], signal?: AbortSignal) {
      if (stopped) return;
      lastMessages = messages;
      const items = extractItems(messages);
      let trailing = 0;
      const minAge = opts.config.summarizerModelConfig.minAgeTokens ?? 0;
      const excluded = new Set<string>();
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (!item || trailing >= minAge) break;
        excluded.add(item.id);
        trailing += item.tokens;
      }
      const queue = items.filter((item) => {
        if (excluded.has(item.id)) return false;
        const ladder = effectiveLadder(opts.config.policy, opts.config.snap, item.kind, item.toolName);
        if (resolveTier(ladder.tiers, item.tokens, item.isError).do !== "summarize") return false;
        return !ready(item.id) && !inflight.has(item.id);
      });
      const concurrency = Math.max(1, opts.config.summarizerModelConfig.concurrency ?? 1);
      let cursor = 0;
      const runOne = async (item: ExtractedItem) => {
        const layered = summarizerFor(opts.config.policy, opts.config.snap, opts.config.summarizerModelConfig, item);
        const model = layered.model ?? "azure-foundry-ai-agents-cus/gpt-6-luna";
        let text: string | undefined;
        let usage: unknown;
        let error: string | undefined;
        let rateLimited = false;
        for (let attempt = 0; attempt < 2 && !stopped && !signal?.aborted && !abort.signal.aborted; attempt++) {
          try {
            const result = await opts.callModel({
              model,
              prompt: layered.prompt ?? DEFAULT_PROMPT,
              input: item.text,
              maxOutputTokens: layered.maxOutputTokens,
              thinkingLevel: layered.thinkingLevel,
              temperature: layered.temperature,
              signal: signal ?? abort.signal,
            });
            usage = result.usage;
            if (isRateLimit(result.error)) {
              rateLimited = true;
              text = undefined;
              error = clipDigestError(result.error);
              if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, rateLimitWaitMs(result.error)));
                continue;
              }
              break;
            }
            rateLimited = false;
            if (!result.text && result.stopReason !== "stop") {
              text = undefined;
              error = clipDigestError(result.error || result.stopReason || "empty summary");
              continue;
            }
            text = result.text;
            error = result.text ? undefined : clipDigestError(result.error || "empty summary");
            break;
          } catch (caught) {
            text = undefined;
            error = clipDigestError(caught);
            if (isRateLimit(caught)) {
              rateLimited = true;
              if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, rateLimitWaitMs(error)));
                continue;
              }
              break;
            }
            rateLimited = false;
          }
        }
        if (stopped || signal?.aborted || abort.signal.aborted) return;
        if (rateLimited && !text) {
          if (!retryTimer) {
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              if (!stopped) void worker.kick(lastMessages);
            }, rateLimitWaitMs(error));
          }
          return;
        }
        const base = { entryId: item.entryId, kind: item.kind, index: item.index, ladderHash: opts.hash, model, usage };
        const record: DigestRecord = !text
          ? { ...base, failed: true, ...(error ? { error } : {}) }
          : estimateTokens(text) >= item.tokens
            ? { ...base, keepOriginal: true }
            : { ...base, text };
        memory.set(item.id, record);
        opts.appendDigest(record);
      };
      const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
        while (!stopped) {
          const item = queue[cursor++];
          if (!item) return;
          const job = runOne(item);
          inflight.set(item.id, job);
          try {
            await job;
          } finally {
            if (inflight.get(item.id) === job) inflight.delete(item.id);
          }
        }
      });
      if (queue.length === 0) return;
      await Promise.all(workers);
    },
  };
  return worker;
}

export type Summarizer = ReturnType<typeof createSummarizer>;
