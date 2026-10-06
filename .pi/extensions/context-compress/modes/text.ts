import type { ContextCompressConfig } from "../config.ts";
import { alignFullPlacements, hiddenFullPlacements, originalsDir, saveHiddenFull, writeOriginal } from "../originals.ts";
import { serializeArchive, type DigestLookup, type SourcedMessage } from "../serialize.ts";
import { buildRecallIndex, firstUserEntryId, pairMessages } from "./snap.ts";
import type { CompressMode, ContextCompressDetails, ModeResult, ModeRunContext } from "./registry.ts";

function readCompress(entry: ModeRunContext["branchEntries"][number]): ContextCompressDetails | undefined {
  const details = (entry.details as { contextCompress?: ContextCompressDetails } | undefined)?.contextCompress;
  if (!details || typeof details.archiveText !== "string") return undefined;
  return details;
}

function latestCompress(branch: ModeRunContext["branchEntries"]): { index: number; summary: string; details: ContextCompressDetails } | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "compaction") continue;
    const details = readCompress(entry);
    if (!details) continue;
    return { index, summary: entry.summary?.trim() ?? "", details };
  }
  return undefined;
}

function isExtensionSummary(text: string, priorSummary: string): boolean {
  if (priorSummary && text === priorSummary) return true;
  return text.startsWith("Resuming a compacted session");
}

function earlierPiSummary(ctx: ModeRunContext, prior: ReturnType<typeof latestCompress>): string {
  const chunks: string[] = [];
  const seen = new Set<string>();
  const push = (text: string | undefined) => {
    const summary = text?.trim();
    if (!summary || seen.has(summary) || isExtensionSummary(summary, prior?.summary ?? "")) return;
    if (prior && prior.details.archiveText.includes(summary)) return;
    seen.add(summary);
    chunks.push(summary);
  };
  for (let index = 0; index < ctx.branchEntries.length; index++) {
    const entry = ctx.branchEntries[index];
    if (entry?.type !== "compaction" || readCompress(entry)) continue;
    if (prior && index < prior.index) push(entry.summary);
  }
  for (let index = prior ? prior.index + 1 : 0; index < ctx.branchEntries.length; index++) {
    const entry = ctx.branchEntries[index];
    if (entry?.type !== "compaction" || readCompress(entry)) continue;
    push(entry.summary);
  }
  push(ctx.preparation.previousSummary);
  if (chunks.length === 0) return "";
  return `Earlier compaction summary\n${chunks.join("\n\n")}`;
}

const CHROME = [
  /^Resuming a compacted session\.[^\n]*(?:\n+|$)/,
  /^Operator instructions:.*(?:\n+|$)/,
  /^Reading guide:.*(?:\n+|$)/,
  /^Recall index[^\n]*\n(?:.*\n)*?(?:.*ids omitted\. \/context-compress show writes the full archive\.\n+|\n|$)/,
];

/** Drop a carried summary's reading guide and recall index so a later text compaction regenerates them instead of nesting them. */
export function stripTextChrome(text: string): string {
  let rest = text.trimStart();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of CHROME) {
      if (!pattern.test(rest)) continue;
      rest = rest.replace(pattern, "").trimStart();
      changed = true;
    }
  }
  return rest;
}

export function fitTextArchive(archive: string, maxChars: number): { head: string; tail: string; dropped: number; visible: string } {
  if (archive.length <= maxChars) return { head: archive, tail: "", dropped: 0, visible: archive };
  const marker = (dropped: number) => `\n[dropped ${dropped} chars]\n`;
  let kept = Math.max(0, maxChars - marker(Math.max(0, archive.length - 1)).length);
  for (let pass = 0; pass < 4; pass++) {
    const dropped = Math.max(0, archive.length - kept);
    kept = Math.max(0, maxChars - marker(dropped).length);
  }
  const mark = marker(Math.max(0, archive.length - kept));
  if (kept + mark.length > maxChars) kept = Math.max(0, maxChars - mark.length);
  let headLen = Math.floor(kept / 2);
  let tailLen = kept - headLen;
  let head = archive.slice(0, headLen);
  let tail = tailLen > 0 ? archive.slice(archive.length - tailLen) : "";
  let dropped = archive.length - head.length - tail.length;
  let visible = `${head}${marker(dropped)}${tail}`;
  while (visible.length > maxChars && (head.length > 0 || tail.length > 0)) {
    if (head.length >= tail.length && head.length > 0) head = head.slice(0, -1);
    else tail = tail.slice(1);
    dropped = archive.length - head.length - tail.length;
    visible = `${head}${marker(dropped)}${tail}`;
  }
  return { head, tail, dropped, visible };
}

function visibleRanges(archive: string, fitted: { head: string; tail: string; dropped: number }): Array<[number, number]> {
  if (fitted.dropped === 0) return archive.length > 0 ? [[0, archive.length]] : [];
  const ranges: Array<[number, number]> = [];
  if (fitted.head.length > 0) ranges.push([0, fitted.head.length]);
  if (fitted.tail.length > 0) ranges.push([archive.length - fitted.tail.length, archive.length]);
  return ranges;
}

export function createTextMode(hooks: {
  getConfig: () => ContextCompressConfig;
  getLookup: () => DigestLookup | undefined;
  notify: (message: string) => void;
}): CompressMode {
  return {
    name: "text",
    available: () => true,
    async run(ctx) {
      const config = hooks.getConfig();
      const sourced: SourcedMessage[] = [
        ...pairMessages(ctx.preparation.messagesToSummarize, ctx.branchEntries),
        ...pairMessages(ctx.preparation.turnPrefixMessages, ctx.branchEntries),
      ];
      const dir = originalsDir(ctx.sessionDir, config.originals.dir);
      const serialized = await serializeArchive({
        messages: sourced,
        policy: config.policy,
        globalSummarizer: config.summarizerModelConfig,
        firstUserEntryId: firstUserEntryId(ctx.branchEntries),
        saveActions: config.originals.enabled ? config.originals.actions : [],
        lookupDigest: hooks.getLookup(),
        saveOriginal: config.originals.enabled ? (record) => writeOriginal(dir, record) : undefined,
      });
      const prior = latestCompress(ctx.branchEntries);
      const piSummary = earlierPiSummary(ctx, prior);
      const fresh = [piSummary, serialized.text].filter(Boolean).join("\n\n");
      const carried = prior ? stripTextChrome(prior.details.archiveText) : "";
      const archiveText = carried ? [carried, fresh].filter(Boolean).join("\n\n") : fresh;
      const fitted = fitTextArchive(archiveText, config.text.maxChars);
      const visible = visibleRanges(archiveText, fitted);
      const placements = alignFullPlacements({
        prior: prior?.details.placements,
        priorArchive: prior?.details.archiveText,
        carried,
        piSummary,
        freshText: serialized.text,
        fresh: serialized.placements,
      });
      const hidden = hiddenFullPlacements(placements, visible);
      const hiddenNote = !config.originals.enabled && hidden.length > 0 ? `${hidden.length} full items are outside the kept text and cannot be recalled.` : "";
      if (config.originals.enabled) saveHiddenFull(dir, archiveText, hidden);
      const index = buildRecallIndex(archiveText, archiveText, visible, config.originals.enabled ? hidden.map((item) => ({
        id: item.id,
        kind: item.kind,
        tokens: item.tokens,
        label: (item.text ?? archiveText.slice(item.start, item.end)).replace(/\s+/g, " ").slice(0, 60),
        offset: item.start,
      })) : [], hiddenNote);
      const lead = "Resuming a compacted session. The archive below is the compacted history in text. Use context_compress_recall for any elided original.";
      const guide = "Reading guide: truncated, summarized, dropped, and errorStub mark items whose full text is in context_compress_recall. A dropped-chars line is the oldest middle omitted so the archive fits; the head is the oldest kept text and the tail is the newest.";
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
      const body = [
        lead,
        ctx.instructions ? `Operator instructions: ${ctx.instructions}` : "",
        guide,
        index,
        fitted.visible,
      ].filter(Boolean).join("\n\n");
      const visibleTokens = Math.ceil(fitted.visible.length / 4);
      const noticePrefix = `${total} items: ${countBits.join(", ") || "none"}, text: ${fitted.visible.length} chars (~${visibleTokens} tok)${missed}, estimated saving `;
      const noticeSuffix = ` tok${digestError}`;
      let saving = Math.max(0, ctx.preparation.tokensBefore - Math.ceil(body.length / 4));
      let notice = `${noticePrefix}${saving}${noticeSuffix}`;
      let summary = `${body}\n\n${notice}`;
      saving = Math.max(0, ctx.preparation.tokensBefore - Math.ceil(summary.length / 4));
      notice = `${noticePrefix}${saving}${noticeSuffix}`;
      summary = `${body}\n\n${notice}`;
      hooks.notify(notice);
      const result: ModeResult = {
        summary,
        firstKeptEntryId: ctx.preparation.firstKeptEntryId,
        tokensBefore: ctx.preparation.tokensBefore,
        estimatedTokensAfter: Math.ceil(summary.length / 4),
        details: {
          contextCompress: {
            mode: "text",
            archiveText,
            frames: [],
            dropped: fitted.dropped,
            head: fitted.head,
            tail: fitted.tail,
            notice,
            placements: placements.map(({ text: _text, ...item }) => item),
          },
        },
      };
      return result;
    },
  };
}
