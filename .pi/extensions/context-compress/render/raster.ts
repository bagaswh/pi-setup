import { FULL_BLOCK, FONT_HEIGHT, FONT_WIDTH, glyphRows, hasGlyph } from "./font8x13.ts";
import { encodeGrayscalePng } from "./png.ts";

export type FrameShape = {
  frameWidth: number;
  frameHeight: number;
  cellWidth: number;
  cellHeight: number;
  tokensPerFrame: number;
  maxImages: number;
};

export type ShapeName = "deepseek" | "gemini" | "claude" | "gpt" | "default";

/**
 * deepseek is the T1 measurement: 1344px bills about 994 image tokens, and a 16x26 cell
 * (the 8x13 glyph at 2x) was the size DeepSeek V4.1 Flash read back exactly.
 * The other rows are public billing estimates, not measured on this spike.
 */
export const SHAPE_TABLE: Record<ShapeName, FrameShape> = {
  // maxImages is the DeepSeek API's documented provider limit (https://api-docs.deepseek.com/guides/vision/). BitDeer and Azure Foundry endpoints may differ and are only verified to accept at least 61. The cost cap is snap.maxFrames and snap.maxBytes, not this number.
  deepseek: { frameWidth: 1344, frameHeight: 1344, cellWidth: 16, cellHeight: 26, tokensPerFrame: 994, maxImages: 600 },
  // maxImages on gemini (16), claude (20), and default (16) are unverified placeholders.
  gemini: { frameWidth: 768, frameHeight: 768, cellWidth: 16, cellHeight: 26, tokensPerFrame: 258, maxImages: 16 },
  claude: { frameWidth: 1568, frameHeight: 1568, cellWidth: 16, cellHeight: 26, tokensPerFrame: 3279, maxImages: 20 },
  // maxImages is OpenAI's documented provider limit of 1,500 images per request (https://developers.openai.com/api/docs/guides/images-vision). The cost cap is snap.maxFrames and snap.maxBytes, not this number.
  gpt: { frameWidth: 1024, frameHeight: 1024, cellWidth: 16, cellHeight: 26, tokensPerFrame: 765, maxImages: 1500 },
  default: { frameWidth: 1024, frameHeight: 1024, cellWidth: 16, cellHeight: 26, tokensPerFrame: 1024, maxImages: 16 },
};

export const SHAPE_NAMES: readonly ShapeName[] = ["deepseek", "gemini", "claude", "gpt", "default"];

/** Characters of plain text kept at each chronological edge before the imaged middle. */
export const EDGE_CHARS = 1200;

export type ShapeSetting = "auto" | ShapeName | Pick<FrameShape, "frameWidth" | "frameHeight" | "cellWidth" | "cellHeight" | "tokensPerFrame">;

export function shapeForModel(
  model: { id?: string; provider?: string } | undefined,
  setting: ShapeSetting,
): FrameShape {
  if (typeof setting === "object") {
    const base = shapeForModel(model, "auto");
    return { ...base, ...setting };
  }
  if (setting !== "auto") return SHAPE_TABLE[setting];
  const id = `${model?.provider ?? ""} ${model?.id ?? ""}`.toLowerCase();
  if (id.includes("deepseek")) return SHAPE_TABLE.deepseek;
  if (id.includes("gemini") || id.includes("google")) return SHAPE_TABLE.gemini;
  if (id.includes("claude") || id.includes("anthropic")) return SHAPE_TABLE.claude;
  if (id.includes("gpt") || id.includes("openai")) return SHAPE_TABLE.gpt;
  return SHAPE_TABLE.default;
}

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

export function normalizationMap(text: string): { text: string; rawToNorm: number[] } {
  const rawToNorm = new Array<number>(text.length).fill(-1);
  const kept: number[] = [];
  let stripped = "";
  let cursor = 0;
  for (const match of text.matchAll(ANSI)) {
    const at = match.index ?? 0;
    for (let i = cursor; i < at; i++) kept.push(i);
    stripped += text.slice(cursor, at);
    cursor = at + match[0].length;
  }
  for (let i = cursor; i < text.length; i++) kept.push(i);
  stripped += text.slice(cursor);

  const blocked: string[] = [];
  const blockedFrom: number[] = [];
  let index = 0;
  while (index < stripped.length) {
    if (stripped.startsWith("\r\n", index)) {
      blocked.push(String.fromCodePoint(FULL_BLOCK));
      blockedFrom.push(kept[index] ?? 0);
      index += 2;
      continue;
    }
    const unit = stripped[index] ?? "";
    if (unit === "\n" || unit === "\r") {
      blocked.push(String.fromCodePoint(FULL_BLOCK));
      blockedFrom.push(kept[index] ?? 0);
      index += 1;
      continue;
    }
    blocked.push(unit);
    blockedFrom.push(kept[index] ?? 0);
    index += 1;
  }

  const collapsed: string[] = [];
  const collapsedFrom: number[] = [];
  let block = 0;
  while (block < blocked.length) {
    const unit = blocked[block] ?? "";
    if (unit === " " || unit === "\t" || unit === "\f" || unit === "\v") {
      const from = blockedFrom[block] ?? 0;
      collapsed.push(" ");
      collapsedFrom.push(from);
      block += 1;
      while (block < blocked.length) {
        const next = blocked[block] ?? "";
        if (next !== " " && next !== "\t" && next !== "\f" && next !== "\v") break;
        block += 1;
      }
      continue;
    }
    collapsed.push(unit);
    collapsedFrom.push(blockedFrom[block] ?? 0);
    block += 1;
  }

  const collapsedText = collapsed.join("");
  let out = "";
  let norm = 0;
  let unitIndex = 0;
  for (const char of collapsedText) {
    const code = char.codePointAt(0) ?? 0;
    const glyph = code === FULL_BLOCK || hasGlyph(code) ? char : "?";
    out += glyph;
    const raw = collapsedFrom[unitIndex] ?? 0;
    if (raw >= 0 && raw < rawToNorm.length) rawToNorm[raw] = norm;
    norm += 1;
    unitIndex += char.length;
  }
  return { text: out, rawToNorm };
}

export function normalizeForFont(text: string): string {
  return normalizationMap(text).text;
}

export function pageCapacity(shape: FrameShape): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor(shape.frameWidth / shape.cellWidth)),
    rows: Math.max(1, Math.floor(shape.frameHeight / shape.cellHeight)),
  };
}

export function renderPage(text: string, shape: FrameShape): Buffer {
  const { cols, rows } = pageCapacity(shape);
  const scaleX = Math.max(1, Math.floor(shape.cellWidth / FONT_WIDTH));
  const scaleY = Math.max(1, Math.floor(shape.cellHeight / FONT_HEIGHT));
  const pixels = new Uint8Array(shape.frameWidth * shape.frameHeight);
  pixels.fill(255);
  const limit = Math.min(text.length, cols * rows);
  for (let i = 0; i < limit; i++) {
    const code = text.codePointAt(i) ?? 63;
    const glyph = glyphRows(code) ?? glyphRows(63);
    if (!glyph) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const originX = col * shape.cellWidth;
    const originY = row * shape.cellHeight;
    for (let gy = 0; gy < FONT_HEIGHT; gy++) {
      const bits = glyph[gy] ?? 0;
      for (let gx = 0; gx < FONT_WIDTH; gx++) {
        if ((bits & (0x80 >> gx)) === 0) continue;
        for (let sy = 0; sy < scaleY; sy++) {
          for (let sx = 0; sx < scaleX; sx++) {
            const x = originX + gx * scaleX + sx;
            const y = originY + gy * scaleY + sy;
            if (x < shape.frameWidth && y < shape.frameHeight) pixels[y * shape.frameWidth + x] = 0;
          }
        }
      }
    }
  }
  return encodeGrayscalePng(shape.frameWidth, shape.frameHeight, pixels);
}

export type LayoutResult = {
  head: string;
  tail: string;
  pages: string[];
  droppedChars: number;
};

export function layoutArchive(
  text: string,
  opts: {
    cols: number;
    rows: number;
    edgeChars?: number;
    maxFrames: number;
    maxBytes: number;
    imageBudgetFrames: number;
    measure?: (page: string) => number;
  },
): LayoutResult {
  const edge = opts.edgeChars ?? EDGE_CHARS;
  if (text.length <= edge * 2) {
    return { head: text, tail: "", pages: [], droppedChars: 0 };
  }
  const head = text.slice(0, edge);
  const tail = text.slice(text.length - edge);
  const middle = text.slice(edge, text.length - edge);
  const per = Math.max(1, opts.cols * opts.rows);
  const pages: string[] = [];
  for (let offset = 0; offset < middle.length; offset += per) pages.push(middle.slice(offset, offset + per));
  const measure = opts.measure ?? ((page: string) => page.length);
  let droppedChars = 0;
  const over = () => {
    if (pages.length > opts.maxFrames || pages.length > opts.imageBudgetFrames) return true;
    return pages.reduce((sum, page) => sum + measure(page), 0) > opts.maxBytes;
  };
  while (pages.length > 0 && over()) {
    droppedChars += pages[0]?.length ?? 0;
    pages.shift();
  }
  return { head, tail, pages, droppedChars };
}
