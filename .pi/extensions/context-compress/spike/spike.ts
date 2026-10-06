/**
 * Throwaway spike: render a slice of a real session with the X.org 8x13 font,
 * send the frames and the same text to deepseek-flash, and print usage.
 * Reads the API key from ~/.pi/agent/models.json and never prints it.
 *
 * Usage:
 *   node --experimental-strip-types .pi/extensions/context-compress/spike/spike.ts <session.jsonl> [bdf]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const FRAME = 1344;
const GLYPH_H = 13;
const GLYPH_W = 8;
const SLICE_CHARS = 40_000;

type Glyphs = Map<number, number[]>;

function parseBdf(text: string): Glyphs {
  const glyphs: Glyphs = new Map();
  const chunks = text.split("STARTCHAR ");
  for (const chunk of chunks.slice(1)) {
    const enc = chunk.match(/ENCODING (-?\d+)/);
    const bitmap = chunk.match(/BITMAP\n([\s\S]*?)\nENDCHAR/);
    if (!enc || !bitmap) continue;
    const rows = bitmap[1].trim().split(/\n/).map((row) => Number.parseInt(row.trim(), 16));
    while (rows.length < GLYPH_H) rows.push(0);
    glyphs.set(Number(enc[1]), rows.slice(0, GLYPH_H));
  }
  return glyphs;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (1 + width));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width);
    raw[row] = 0;
    for (let x = 0; x < width; x++) raw[row + 1 + x] = pixels[y * width + x] ?? 255;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderPages(text: string, glyphs: Glyphs, cellW: number, cellH: number): Buffer[] {
  const cols = Math.floor(FRAME / cellW);
  const rows = Math.floor(FRAME / cellH);
  const scaleX = Math.max(1, Math.floor(cellW / GLYPH_W));
  const scaleY = Math.max(1, Math.floor(cellH / GLYPH_H));
  const per = cols * rows;
  const pages: Buffer[] = [];
  for (let offset = 0; offset < text.length; offset += per) {
    const slice = text.slice(offset, offset + per);
    const pixels = new Uint8Array(FRAME * FRAME);
    pixels.fill(255);
    for (let i = 0; i < slice.length; i++) {
      const code = slice.charCodeAt(i);
      const glyph = glyphs.get(code) ?? glyphs.get(63);
      if (!glyph) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const originX = col * cellW;
      const originY = row * cellH;
      for (let gy = 0; gy < GLYPH_H; gy++) {
        const bits = glyph[gy] ?? 0;
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if ((bits & (0x80 >> gx)) === 0) continue;
          for (let sy = 0; sy < scaleY; sy++) {
            for (let sx = 0; sx < scaleX; sx++) {
              const x = originX + gx * scaleX + sx;
              const y = originY + gy * scaleY + sy;
              if (x < FRAME && y < FRAME) pixels[y * FRAME + x] = 0;
            }
          }
        }
      }
    }
    pages.push(encodePng(FRAME, FRAME, pixels));
  }
  return pages;
}

function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; text?: string; thinking?: string };
    if (record.type === "text" && record.text) text += record.text;
    if (record.type === "thinking" && record.thinking) text += record.thinking;
  }
  return text;
}

function olderHalfText(sessionPath: string): string {
  const lines = fs.readFileSync(sessionPath, "utf8").split("\n").filter((line) => line.trim());
  const half = Math.floor(lines.length / 2);
  const parts: Array<{ role: string; text: string }> = [];
  for (const line of lines.slice(0, half)) {
    let obj: { message?: { role?: string; content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const message = obj.message;
    if (!message?.role || message.role === "system") continue;
    const text = messageText(message).replace(/[ \t]+/g, " ").replace(/\r\n/g, "\n").trim();
    if (!text) continue;
    parts.push({ role: message.role, text });
  }
  const users = parts.filter((part) => part.role === "user").map((part) => `user: ${part.text}`);
  const rest = parts.filter((part) => part.role !== "user").map((part) => `${part.role}: ${part.text}`);
  return [...users, ...rest].join("\n").slice(0, SLICE_CHARS);
}

type Usage = Record<string, unknown>;

async function complete(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  content: unknown;
}): Promise<{ text: string; usage: Usage; status: number }> {
  const response = await fetch(`${args.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 1200,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: args.content }],
    }),
  });
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: Usage;
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${JSON.stringify(body.error ?? body).slice(0, 400)}`);
  }
  return {
    status: response.status,
    text: body.choices?.[0]?.message?.content ?? "",
    usage: body.usage ?? {},
  };
}

function loadFlash(): { provider: string; baseUrl: string; apiKey: string; model: string; input: string[] } {
  const models = JSON.parse(fs.readFileSync(path.join(process.env.HOME ?? "", ".pi/agent/models.json"), "utf8")) as {
    providers: Record<string, { baseUrl: string; apiKey: string; models: Array<{ id: string; input?: string[] }> }>;
  };
  const provider = models.providers.bitdeer;
  const model = provider?.models.find((item) => item.id === "deepseek-ai/DeepSeek-V4.1-Flash");
  if (!provider || !model) throw new Error("bitdeer deepseek-ai/DeepSeek-V4.1-Flash is not configured");
  return { provider: "bitdeer", baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: model.id, input: model.input ?? [] };
}

const QUESTIONS = [
  "Which repository is being migrated?",
  "Which Azure DevOps project does that repository belong to?",
  "What application stack does the user name?",
  "What does the user ask to delete?",
  "What should be cherry-picked, and what must be left out?",
  "Which branch should the work be merged to?",
  "Which tools should store skill edits?",
  "What topic does the user ask about in detail after the skill-edit note?",
  "What does the user say is always set on headers?",
  "Does the user say a ready-made example already exists for this stack?",
];

async function main(): Promise<void> {
  const sessionPath = process.argv[2];
  const bdfPath = process.argv[3] ?? "/tmp/8x13.bdf";
  if (!sessionPath) {
    console.error("usage: spike.ts <session.jsonl> [bdf]");
    process.exit(1);
  }
  const glyphs = parseBdf(fs.readFileSync(bdfPath, "utf8"));
  const newline = glyphs.has(0x2588) ? "\u2588" : "|";
  const transcript = olderHalfText(sessionPath).replaceAll("\n", newline);
  const outDir = path.join("/tmp", "context-compress-spike");
  fs.mkdirSync(outDir, { recursive: true });
  const flash = loadFlash();
  const shapes = [
    { cellWidth: 8, cellHeight: 22 },
    { cellWidth: 16, cellHeight: 26 },
    { cellWidth: 24, cellHeight: 39 },
  ];
  const shapeReads: Array<{ cellWidth: number; cellHeight: number; reply: string; usage: Usage }> = [];
  for (const shape of shapes) {
    const codeword = renderPages("CODEWORD KAPPA-4417", glyphs, shape.cellWidth, shape.cellHeight);
    fs.writeFileSync(path.join(outDir, `codeword-${shape.cellWidth}x${shape.cellHeight}.png`), codeword[0] ?? Buffer.alloc(0));
    const codeResult = await complete({
      baseUrl: flash.baseUrl,
      apiKey: flash.apiKey,
      model: flash.model,
      content: [
        { type: "text", text: "Read the image and reply with the code word only." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${(codeword[0] ?? Buffer.alloc(0)).toString("base64")}` } },
      ],
    });
    shapeReads.push({ ...shape, reply: codeResult.text, usage: codeResult.usage });
  }
  const chosen = shapeReads.find((shape) => /CODEWORD/i.test(shape.reply) && /KAPPA-4417/.test(shape.reply)) ?? shapeReads[shapeReads.length - 1];
  const pages = renderPages(transcript, glyphs, chosen.cellWidth ?? 8, chosen.cellHeight ?? 22);
  pages.forEach((png, index) => {
    fs.writeFileSync(path.join(outDir, `frame-${index}.png`), png);
  });
  const codeResult = { text: chosen.reply ?? "", usage: chosen.usage ?? {} };
  const imageContent: unknown[] = [
    {
      type: "text",
      text:
        `The images are a transcript rendered as a ${chosen.cellWidth}x${chosen.cellHeight} cell grid. Newlines are a full block. ` +
        "Answer each question in order, one line each, using only the images.\n" +
        QUESTIONS.map((question, index) => `${index + 1}. ${question}`).join("\n"),
    },
  ];
  const sentPages = pages.slice(0, 6);
  for (const page of sentPages) {
    imageContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${page.toString("base64")}` } });
  }
  const imageResult = await complete({
    baseUrl: flash.baseUrl,
    apiKey: flash.apiKey,
    model: flash.model,
    content: imageContent,
  });
  const cols = Math.floor(FRAME / (chosen.cellWidth ?? 8));
  const rows = Math.floor(FRAME / (chosen.cellHeight ?? 22));
  const compared = transcript.slice(0, sentPages.length * cols * rows);
  const textResult = await complete({
    baseUrl: flash.baseUrl,
    apiKey: flash.apiKey,
    model: flash.model,
    content:
      "Answer each question in order, one line each, using only the transcript.\n" +
      QUESTIONS.map((question, index) => `${index + 1}. ${question}`).join("\n") +
      "\n\n<transcript>\n" +
      compared +
      "\n</transcript>",
  });
  const report = {
    piVersion: "0.87.1",
    provider: flash.provider,
    model: flash.model,
    modelInput: flash.input,
    frame: { width: FRAME, height: FRAME, cellWidth: chosen.cellWidth, cellHeight: chosen.cellHeight },
    shapeReads,
    sliceChars: transcript.length,
    frameCount: pages.length,
    framesSent: sentPages.length,
    frameBytes: pages.map((page) => page.length),
    codewordReply: codeResult.text,
    codewordUsage: codeResult.usage,
    imageUsage: imageResult.usage,
    imageReply: imageResult.text,
    textUsage: textResult.usage,
    textReply: textResult.text,
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    provider: flash.provider,
    model: flash.model,
    modelInput: flash.input,
    sliceChars: transcript.length,
    chosen,
    shapeReads,
    frameCount: pages.length,
    framesSent: sentPages.length,
    frameBytes: pages.map((page) => page.length),
    codewordReply: codeResult.text.slice(0, 200),
    codewordUsage: codeResult.usage,
    imageUsage: imageResult.usage,
    textUsage: textResult.usage,
    imageReply: imageResult.text.slice(0, 1500),
    textReply: textResult.text.slice(0, 1500),
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]"));
  process.exit(1);
});
