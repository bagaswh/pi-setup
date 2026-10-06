export type ModeResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  details?: {
    contextCompress?: ContextCompressDetails;
  };
};

export type ContextCompressFrame = {
  path: string;
  cols: number;
  rows: number;
  chars: number;
  /** Normalized offset of this frame in `archiveText`. Later snaps use it to see what a carried frame still covers. */
  start?: number;
};

export type StoredPlacement = {
  id: string;
  entryId: string;
  kind: string;
  index: number;
  start: number;
  end: number;
  tokens: number;
  toolName?: string;
  argumentsText?: string;
};

export type ContextCompressDetails = {
  mode: "snap" | "text";
  archiveText: string;
  frames: ContextCompressFrame[];
  dropped: number;
  head: string;
  tail: string;
  notice: string;
  /** Full-item spans in `archiveText`. A later compaction uses them when frames or the text cap hide that span. */
  placements?: StoredPlacement[];
};

export type ModeModel = {
  id?: string;
  provider?: string;
  input?: string[];
};

export type CompressMode = {
  name: string;
  available: (model: ModeModel | undefined) => boolean;
  run: (ctx: ModeRunContext) => Promise<ModeResult | undefined>;
};

export type ModeRunContext = {
  model: ModeModel | undefined;
  preparation: {
    firstKeptEntryId: string;
    messagesToSummarize: unknown[];
    turnPrefixMessages: unknown[];
    tokensBefore: number;
    previousSummary?: string;
  };
  branchEntries: ReadonlyArray<{
    type?: string;
    id?: string;
    summary?: string;
    message?: unknown;
    customType?: string;
    data?: unknown;
    details?: unknown;
  }>;
  sessionDir: string;
  instructions?: string;
  signal?: AbortSignal;
};

export function parseForcedMode(customInstructions?: string): { mode?: string; instructions?: string } {
  if (!customInstructions) return {};
  if (!customInstructions.startsWith("mode=")) return { instructions: customInstructions };
  const rest = customInstructions.slice("mode=".length);
  const space = rest.search(/\s/);
  if (space === -1) return { mode: rest.trim() || undefined };
  const mode = rest.slice(0, space).trim();
  const instructions = rest.slice(space + 1).trim();
  return { mode: mode || undefined, instructions: instructions || undefined };
}

export async function runMethodOrder(opts: {
  methodOrder: readonly string[];
  modes: readonly CompressMode[];
  fallback: "pi-default" | "cancel";
  forced?: string;
  ctx: ModeRunContext;
}): Promise<{ compaction?: ModeResult; cancel?: true } | undefined> {
  const names = opts.forced ? [opts.forced] : opts.methodOrder;
  for (const name of names) {
    const mode = opts.modes.find((item) => item.name === name);
    if (!mode || !mode.available(opts.ctx.model)) {
      if (opts.forced) break;
      continue;
    }
    try {
      const result = await mode.run(opts.ctx);
      if (result) return { compaction: result };
    } catch {
      // A throwing mode falls through unless this run was forced.
    }
    if (opts.forced) break;
  }
  if (opts.fallback === "cancel") return { cancel: true };
  return undefined;
}
