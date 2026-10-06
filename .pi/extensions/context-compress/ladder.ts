export type Action = "full" | "truncate" | "summarize" | "drop" | "errorStub";

export type Kind = "thinking" | "toolResult" | "toolCall" | "userMessage" | "modelResponse";

export const KINDS: readonly Kind[] = ["thinking", "toolResult", "toolCall", "userMessage", "modelResponse"];

export type SummarizerConfig = {
  model?: string;
  prompt?: string;
  maxOutputTokens?: number;
  thinkingLevel?: string;
  temperature?: number;
  concurrency?: number;
  minAgeTokens?: number;
  waitMs?: number;
};

export type Tier = {
  upTo?: number;
  when?: "error" | "ok";
  do: Action;
  summarizer?: SummarizerConfig;
  truncateTo?: number;
};

/** Tokens kept when a tier says truncate and does not set truncateTo. Also the no-match size cap. */
export const DEFAULT_TRUNCATE_TO = 500;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function resolveTier(ladder: readonly Tier[], size: number, isError: boolean): Tier {
  const hit = ladder.find((tier) => (tier.upTo === undefined || size <= tier.upTo) && (tier.when === undefined || (tier.when === "error") === isError));
  return hit ?? { do: "truncate" };
}

export function layerSummarizer(...layers: Array<SummarizerConfig | undefined>): SummarizerConfig {
  const merged: SummarizerConfig = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
