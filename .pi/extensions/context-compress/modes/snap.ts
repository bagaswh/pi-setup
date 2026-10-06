import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ContextCompressConfig } from "../config.ts";
import { alignFullPlacements, hiddenFullPlacements, originalsDir, saveHiddenFull, writeOriginal } from "../originals.ts";
import { EDGE_CHARS, layoutArchive, normalizationMap, normalizeForFont, pageCapacity, renderPage, shapeForModel } from "../render/raster.ts";
import { serializeArchive, type ArchiveMessage, type DigestLookup, type SourcedMessage } from "../serialize.ts";
import { FULL_BLOCK } from "../render/font8x13.ts";
import type { CompressMode, ContextCompressDetails, ContextCompressFrame, ModeResult, ModeRunContext } from "./registry.ts";

function asMessage(value: unknown): ArchiveMessage {
  if (!value || typeof value !== "object") return {};
  return value as ArchiveMessage;
}

export function pairMessages(messages: readonly unknown[], branch: ModeRunContext["branchEntries"]): SourcedMessage[] {
  const pool = branch.flatMap((entry) => (entry.type === "message" && entry.id ? [{ entryId: entry.id, message: entry.message }] : []));
  return messages.map((message) => {
    const index = pool.findIndex((item) => item.message === message);
    if (index < 0) return { entryId: "unsourced", message: asMessage(message) };
    const [hit] = pool.splice(index, 1);
    return { entryId: hit?.entryId ?? "unsourced", message: asMessage(hit?.message) };
  });
}

export function firstUserEntryId(branch: ModeRunContext["branchEntries"]): string | undefined {
  for (const entry of branch) {
    if (entry.type === "message" && entry.id && asMessage(entry.message).role === "user") return entry.id;
  }
  return undefined;
}

function formatChars(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function newKey(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function readSnap(entry: ModeRunContext["branchEntries"][number]): ContextCompressDetails | undefined {
  const details = (entry.details as { contextCompress?: ContextCompressDetails } | undefined)?.contextCompress;
  if (details?.mode !== "snap" || typeof details.archiveText !== "string") return undefined;
  return details;
}

function latestSnap(branch: ModeRunContext["branchEntries"]): { index: number; summary: string; details: ContextCompressDetails } | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "compaction") continue;
    const details = readSnap(entry);
    if (!details) continue;
    return { index, summary: entry.summary?.trim() ?? "", details };
  }
  return undefined;
}

function isSnapSummary(text: string, priorSummary: string): boolean {
  if (priorSummary && text === priorSummary) return true;
  return text.startsWith("Resuming a compacted session");
}

function unimagedPiSummary(ctx: ModeRunContext, prior: ReturnType<typeof latestSnap>): string {
  const chunks: string[] = [];
  const seen = new Set<string>();
  const push = (text: string | undefined) => {
    const summary = text?.trim();
    if (!summary || seen.has(summary) || isSnapSummary(summary, prior?.summary ?? "")) return;
    if (prior && prior.details.archiveText.includes(summary)) return;
    seen.add(summary);
    chunks.push(summary);
  };
  for (let index = 0; index < ctx.branchEntries.length; index++) {
    const entry = ctx.branchEntries[index];
    if (entry?.type !== "compaction" || readSnap(entry)) continue;
    if (prior && index < prior.index) push(entry.summary);
  }
  for (let index = prior ? prior.index + 1 : 0; index < ctx.branchEntries.length; index++) {
    const entry = ctx.branchEntries[index];
    if (entry?.type !== "compaction" || readSnap(entry)) continue;
    push(entry.summary);
  }
  push(ctx.preparation.previousSummary);
  if (chunks.length === 0) return "";
  return `Earlier compaction summary\n${chunks.join("\n\n")}`;
}

function pageText(text: string, per: number): string[] {
  if (!text) return [];
  const pages: string[] = [];
  const size = Math.max(1, per);
  for (let offset = 0; offset < text.length; offset += size) pages.push(text.slice(offset, offset + size));
  return pages;
}

function assignStarts(details: ContextCompressDetails): ContextCompressFrame[] {
  if (details.frames.length === 0) return [];
  if (details.frames.every((frame) => typeof frame.start === "number")) return details.frames.map((frame) => ({ ...frame }));
  let cursor = details.head.length + details.dropped;
  return details.frames.map((frame) => {
    const start = typeof frame.start === "number" ? frame.start : cursor;
    cursor = start + frame.chars;
    return { ...frame, start };
  });
}

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function coveredChars(length: number, ranges: Array<[number, number]>): number {
  const clipped = ranges
    .map(([start, end]) => [Math.max(0, start), Math.min(length, end)] as [number, number])
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  let count = 0;
  let end = 0;
  for (const range of clipped) {
    const start = Math.max(range[0], end);
    if (range[1] > start) count += range[1] - start;
    end = Math.max(end, range[1]);
  }
  return count;
}

function edgeRanges(length: number): Array<[number, number]> {
  if (length <= 0) return [];
  if (length <= EDGE_CHARS * 2) return [[0, length]];
  return [[0, EDGE_CHARS], [length - EDGE_CHARS, length]];
}

function edgesOf(norm: string): { head: string; tail: string } {
  if (norm.length <= EDGE_CHARS * 2) return { head: norm, tail: "" };
  return { head: norm.slice(0, EDGE_CHARS), tail: norm.slice(norm.length - EDGE_CHARS) };
}

const RECALL_INDEX_CAP = 8_000;
const KIND_TOKEN: Record<string, string> = {
  thinking: "thinking",
  "tool result": "toolResult",
  "tool call": "toolCall",
  "user message": "userMessage",
  "model response": "modelResponse",
};

type RecallCandidate = { id: string; kind: string; tokens: number; label: string; offset: number };

function recallLabel(raw: string, id: string): string {
  const needle = `id=${id} -> context_compress_recall`;
  const at = raw.indexOf(needle);
  if (at < 0) return "";
  const before = raw.slice(Math.max(0, at - 400), at);
  const lineBreak = before.lastIndexOf("\n");
  const prior = lineBreak < 0 ? "" : before.slice(0, lineBreak);
  const lines = prior.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.includes("context_compress_recall"));
  return (lines[lines.length - 1] ?? "").replace(/\s+/g, " ").slice(0, 60);
}

export function buildRecallIndex(rawArchive: string, normArchive: string, visible: Array<[number, number]>, extras: RecallCandidate[] = [], note = ""): string {
  const pattern = /\[(thinking|tool result|tool call|user message|model response) ([\d,]+) tok (truncated|summarized|dropped|errorStub), id=(\S+) -> context_compress_recall\]/g;
  const candidates: RecallCandidate[] = [];
  const seen = new Set<string>();
  for (const match of normArchive.matchAll(pattern)) {
    const offset = match.index ?? 0;
    if (visible.some(([start, end]) => offset >= start && offset < end)) continue;
    const id = match[4] ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = KIND_TOKEN[match[1] ?? ""] ?? match[1] ?? "item";
    const tokens = Number((match[2] ?? "0").replace(/,/g, ""));
    candidates.push({ id, kind, tokens: Number.isFinite(tokens) ? tokens : 0, label: recallLabel(rawArchive, id), offset });
  }
  for (const extra of extras) {
    if (!extra.id || seen.has(extra.id)) continue;
    seen.add(extra.id);
    candidates.push(extra);
  }
  if (candidates.length === 0 && !note) return "";
  candidates.sort((left, right) => right.tokens - left.tokens || right.offset - left.offset);
  const header = "Recall index (not on frames):";
  const lineOf = (item: RecallCandidate) => `${item.id} ${item.kind} ${item.tokens} tok ${item.label}`.trimEnd();
  const footer = (omitted: number) => `${omitted} ids omitted. /context-compress show writes the full archive.`;
  const finish = (body: string, omittedNote: string) => [header, body, omittedNote, note].filter(Boolean).join("\n");
  for (let keep = candidates.length; keep >= 0; keep--) {
    const omitted = candidates.length - keep;
    const body = candidates.slice(0, keep).map(lineOf).join("\n");
    const text = finish(body, omitted > 0 ? footer(omitted) : "");
    if (text.length <= RECALL_INDEX_CAP) return text;
  }
  return finish("", footer(candidates.length)).slice(0, RECALL_INDEX_CAP);
}

export function createSnapMode(hooks: {
  getConfig: () => ContextCompressConfig;
  getLookup: () => DigestLookup | undefined;
  notify: (message: string) => void;
}): CompressMode {
  return {
    name: "snap",
    available: (model) => model?.input?.includes("image") === true,
    async run(ctx) {
      const config = hooks.getConfig();
      const sourced = [
        ...pairMessages(ctx.preparation.messagesToSummarize, ctx.branchEntries),
        ...pairMessages(ctx.preparation.turnPrefixMessages, ctx.branchEntries),
      ];
      const dir = originalsDir(ctx.sessionDir, config.originals.dir);
      const serialized = await serializeArchive({
        messages: sourced,
        policy: config.policy,
        snap: config.snap,
        globalSummarizer: config.summarizerModelConfig,
        firstUserEntryId: firstUserEntryId(ctx.branchEntries),
        saveActions: config.originals.enabled ? config.originals.actions : [],
        lookupDigest: hooks.getLookup(),
        saveOriginal: config.originals.enabled ? (record) => writeOriginal(dir, record) : undefined,
      });
      const prior = latestSnap(ctx.branchEntries);
      const piSummary = unimagedPiSummary(ctx, prior);
      const fresh = [piSummary, serialized.text].filter(Boolean).join("\n\n");
      const carriedArchive = prior?.details.archiveText ?? "";
      const archiveText = prior ? [prior.details.archiveText, fresh].filter(Boolean).join("\n\n") : fresh;
      const shape = shapeForModel(ctx.model, config.snap.shape);
      const mapped = normalizationMap(archiveText);
      const normalized = mapped.text;
      const { cols, rows } = pageCapacity(shape);
      const cap = Math.min(config.snap.maxFrames, shape.maxImages);
      const per = Math.max(1, cols * rows);
      let carried: ContextCompressFrame[] = prior ? assignStarts(prior.details) : [];
      const pending: Array<{ text: string; start: number; png?: Buffer }> = [];
      let droppedFrames = 0;
      if (!prior) {
        const cache = new Map<string, Buffer>();
        const measure = (page: string) => {
          const cached = cache.get(page);
          if (cached) return cached.length;
          const png = renderPage(page, shape);
          cache.set(page, png);
          return png.length;
        };
        const layout = layoutArchive(normalized, {
          cols,
          rows,
          maxFrames: config.snap.maxFrames,
          maxBytes: config.snap.maxBytes,
          imageBudgetFrames: shape.maxImages,
          measure,
        });
        const middleLen = normalized.length <= EDGE_CHARS * 2 ? 0 : normalized.length - EDGE_CHARS * 2;
        droppedFrames = Math.max(0, Math.ceil(middleLen / per) - layout.pages.length);
        let start = layout.head.length + layout.droppedChars;
        for (const page of layout.pages) {
          pending.push({ text: page, start, png: cache.get(page) });
          start += page.length;
        }
      } else {
        const addition = normalizeForFont(fresh);
        const base = normalized.endsWith(addition) ? normalized.length - addition.length : normalized.length;
        let start = base;
        for (const page of pageText(addition, per)) {
          pending.push({ text: page, start });
          start += page.length;
        }
      }
      while (carried.length + pending.length > cap) {
        if (carried.length > 0) carried.shift();
        else pending.shift();
        droppedFrames += 1;
      }
      for (const page of pending) page.png ??= renderPage(page.text, shape);
      const byteSum = () => carried.reduce((sum, frame) => sum + fileBytes(frame.path), 0) + pending.reduce((sum, page) => sum + (page.png?.length ?? 0), 0);
      while (carried.length + pending.length > 0 && byteSum() > config.snap.maxBytes) {
        if (carried.length > 0) carried.shift();
        else pending.shift();
        droppedFrames += 1;
      }
      const key = newKey();
      const frameDir = path.join(ctx.sessionDir, "context-compress", "frames", key);
      const freshFrames: ContextCompressFrame[] = pending.map((page, index) => {
        const file = path.join(frameDir, `${String(index + 1).padStart(3, "0")}.png`);
        fs.mkdirSync(frameDir, { recursive: true });
        fs.writeFileSync(file, page.png ?? renderPage(page.text, shape));
        return { path: file, cols, rows, chars: page.text.length, start: page.start };
      });
      const frames = [...carried, ...freshFrames];
      const carriedKept = carried.length;
      const newKept = freshFrames.length;
      const { head, tail } = edgesOf(normalized);
      const visible = [
        ...edgeRanges(normalized.length),
        ...frames.flatMap((frame) => (typeof frame.start === "number" ? [[frame.start, frame.start + frame.chars] as [number, number]] : [])),
      ];
      const droppedChars = Math.max(0, normalized.length - coveredChars(normalized.length, visible));
      const placements = alignFullPlacements({
        prior: prior?.details.placements,
        priorArchive: prior?.details.archiveText,
        carried: carriedArchive,
        piSummary,
        freshText: serialized.text,
        fresh: serialized.placements,
      });
      const hidden = hiddenFullPlacements(placements, visible, mapped.rawToNorm);
      const hiddenNote = !config.originals.enabled && hidden.length > 0 ? `${hidden.length} full items are outside the kept text and cannot be recalled.` : "";
      if (config.originals.enabled) saveHiddenFull(dir, archiveText, hidden);
      const index = buildRecallIndex(archiveText, normalized, visible, config.originals.enabled ? hidden.map((item) => ({
        id: item.id,
        kind: item.kind,
        tokens: item.tokens,
        label: (item.text ?? archiveText.slice(item.start, item.end)).replace(/\s+/g, " ").slice(0, 60),
        offset: item.start,
      })) : [], hiddenNote);
      const chars = frames.reduce((sum, frame) => sum + frame.chars, 0);
      const tokensAfter = Math.ceil(head.length / 4) + Math.ceil(tail.length / 4) + Math.ceil(index.length / 4) + frames.length * shape.tokensPerFrame;
      const saving = Math.max(0, serialized.sourceTokens - tokensAfter);
      const countBits = [
        serialized.counts.truncate ? `${serialized.counts.truncate} truncated` : "",
        serialized.counts.summarize ? `${serialized.counts.summarize} summarized` : "",
        serialized.counts.drop ? `${serialized.counts.drop} dropped` : "",
        serialized.counts.errorStub ? `${serialized.counts.errorStub} error stubs` : "",
        serialized.counts.full ? `${serialized.counts.full} kept` : "",
      ].filter(Boolean);
      const total = Object.values(serialized.counts).reduce((sum, count) => sum + count, 0);
      const missed = serialized.digestMisses > 0 ? `, ${serialized.digestMisses} digests missed and truncated` : "";
      const digestError = serialized.digestErrors.length > 0 ? `; ${serialized.digestErrors.join("; ")}` : "";
      const frameCounts = `${carriedKept} carried, ${newKept} new, ${droppedFrames} dropped`;
      const notice = `${total} items: ${countBits.join(", ") || "none"}, ${formatChars(chars)} chars on ${frames.length} frames (${frameCounts})${missed}, estimated saving ${saving} tok${digestError}`;
      const fileList = frames.length > 0 ? frames.map((frame) => `- ${frame.path} (${frame.cols} x ${frame.rows}, ${frame.chars} chars)`).join("\n") : "(none)";
      const summary = [
        "Resuming a compacted session. Read the frames after this summary for the middle of the archived history, and use context_compress_recall for any elided original.",
        ctx.instructions ? `Operator instructions: ${ctx.instructions}` : "",
        `Reading guide: each frame is a ${cols} by ${rows} grid of ${shape.cellWidth} by ${shape.cellHeight} cells. Newlines are the full-block glyph ${String.fromCodePoint(FULL_BLOCK)}. Dropped characters: ${droppedChars}. Frames: ${frameCounts}.`,
        index,
        head ? `Archive head:\n${head}` : "",
        `Frames:\n${fileList}`,
        notice,
      ].filter(Boolean).join("\n\n");
      hooks.notify(notice);
      const result: ModeResult = {
        summary,
        firstKeptEntryId: ctx.preparation.firstKeptEntryId,
        tokensBefore: ctx.preparation.tokensBefore,
        estimatedTokensAfter: tokensAfter,
        details: {
          contextCompress: {
            mode: "snap",
            archiveText,
            frames,
            dropped: droppedChars,
            head,
            tail,
            notice,
            placements: placements.map(({ text: _text, ...item }) => item),
          },
        },
      };
      return result;
    },
  };
}

export function branchMessages(branch: ModeRunContext["branchEntries"]): SourcedMessage[] {
  return pairMessages(
    branch.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    branch,
  );
}
