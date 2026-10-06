import { createRequire } from "node:module";

import type { StartupDecision } from "./config.ts";
import type { KbHit } from "./contract.ts";
import type { QmdAdapter } from "./qmd.ts";

type SchemaOptions = { description?: string };

type TypeboxLike = {
  Object: (properties: Record<string, unknown>, options?: SchemaOptions) => Record<string, unknown>;
  Union: (variants: Array<Record<string, unknown>>) => Record<string, unknown>;
  Literal: (value: string) => Record<string, unknown>;
  String: (options?: SchemaOptions) => Record<string, unknown>;
  Number: () => Record<string, unknown>;
  Array: (items: Record<string, unknown>, options?: SchemaOptions) => Record<string, unknown>;
  Optional: (schema: Record<string, unknown>) => Record<string, unknown>;
};

function withDescription(schema: Record<string, unknown>, options?: SchemaOptions): Record<string, unknown> {
  return options?.description ? { ...schema, description: options.description } : schema;
}

const Type: TypeboxLike = (() => {
  const fallback: TypeboxLike = {
    Object: (properties, options) =>
      withDescription({ type: "object", properties, required: Object.keys(properties) }, options),
    Union: (variants) => ({ anyOf: variants }),
    Literal: (value) => ({ const: value, type: "string" }),
    String: (options) => withDescription({ type: "string" }, options),
    Number: () => ({ type: "number" }),
    Array: (items, options) => withDescription({ type: "array", items }, options),
    Optional: (schema) => schema,
  };
  try {
    const required = createRequire(import.meta.url);
    const imported = required("typebox") as { Type?: TypeboxLike };
    return imported.Type ?? fallback;
  } catch {
    return fallback;
  }
})();

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

export type RegisteredTool = {
  name:
    | "kbSearch"
    | "kbDocRead"
    | "kbDocReadMultiple"
    | "kbDocEdit"
    | "kbDocCreate"
    | "kbCollectionList"
    | "kbDocList"
    | "kbDocTree";
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: object;
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ) => Promise<ToolResult>;
};

export type RegistrationPlan =
  | { kind: "no-tools" }
  | { kind: "fatal"; message: string }
  | { kind: "tools"; tools: RegisteredTool[] };

function toolResult(details: Record<string, unknown>, text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(details: Record<string, unknown>, error: string): ToolResult {
  return toolResult(details, error, true);
}

/** Readable block for one kbSearch hit. Optional fields omitted when absent. */
export function formatSearchHit(hit: KbHit): string {
  const lines = [
    `collection: ${hit.collection}`,
    `documentPath: ${hit.documentPath}`,
  ];
  if (hit.line !== undefined) lines.push(`line: ${hit.line}`);
  if (hit.score !== undefined) lines.push(`score: ${hit.score}`);
  if (hit.context !== undefined) lines.push(`context: ${hit.context}`);
  lines.push("snippet:");
  lines.push(hit.snippet);
  return lines.join("\n");
}

export function formatSearchHits(hits: KbHit[]): string {
  if (hits.length === 0) return "No hits.";
  return hits.map(formatSearchHit).join("\n\n");
}

export function formatCollectionList(
  collections: Array<{ name: string; path: string }>,
): string {
  if (collections.length === 0) return "No collections.";
  return collections.map((entry) => `name: ${entry.name}\npath: ${entry.path}`).join("\n\n");
}

export function formatEditSuccess(result: { documentPath: string; line: number }): string {
  return `documentPath: ${result.documentPath}\nline: ${result.line}`;
}

/** One kbDocReadMultiple entry: success text from kbDocRead, or an inline error. */
export function formatReadMultipleResult(
  entries: Array<{ collection: string; documentPath: string; text?: string; error?: string }>,
): string {
  const blocks = entries.map((entry) => {
    if (entry.error) {
      return (
        `# kbDocReadMultiple  collection ${entry.collection}  documentPath ${entry.documentPath}  ` +
        `[ERROR] ${entry.error}`
      );
    }
    return entry.text ?? "";
  });
  const errors = entries.filter((entry) => entry.error).length;
  const summary = `\n[${entries.length} document(s): ${entries.length - errors} ok, ${errors} error(s)]`;
  return blocks.join("\n\n") + summary;
}

function isTextEdit(value: unknown): value is { oldText: string; newText: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as { oldText?: unknown; newText?: unknown };
  return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/** Coerce the argument shapes Pi's edit tool accepts before schema validation. */
export function prepareKbDocEditArguments(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const args = { ...(input as Record<string, unknown>) };
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isTextEdit(parsed)) args.edits = [parsed];
    } catch {
      // Leave the string so schema validation can report it.
    }
  } else if (isTextEdit(args.edits)) {
    args.edits = [args.edits];
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...args.edits] : [];
    edits.push({ oldText: args.oldText, newText: args.newText });
    delete args.oldText;
    delete args.newText;
    args.edits = edits;
  }
  return args;
}

export function buildKnowledgeBaseTools(
  startup: StartupDecision,
  deps: { qmdAdapter: QmdAdapter },
): RegistrationPlan {
  if (startup.kind === "no-config") return { kind: "no-tools" };
  if (startup.kind === "fatal") return { kind: "fatal", message: startup.message };

  const modes = ["semantic", "keyword", "hybrid"] as const;
  const collections = startup.config.qmd.collections;
  const baseCorpusText = "The knowledge corpus is outside the current workspace.";

  const searchTool: RegisteredTool = {
    name: "kbSearch",
    label: "Knowledge base search",
    description:
      `${baseCorpusText} Search one allowlisted qmd collection per call by meaning or text using modes ` +
      `${modes.join(", ")}. Allowlisted collections: ${collections.join(", ")}. ` +
      `Hit line values are 0-based file line indices usable as kbDocRead start. ` +
      `Only indexed files are searched; use kbDocTree to find files the index does not contain.`,
    promptSnippet: "Search an external qmd collection",
    promptGuidelines: [
      `Use mode ${modes.join(" | ")} and a non-empty searchTerm.`,
      "Each call searches exactly one allowlisted collection.",
      "A file missing from search may still exist on disk; kbDocTree lists it.",
    ],
    parameters: Type.Object({
      mode: Type.Union(modes.map((mode) => Type.Literal(mode))),
      searchTerm: Type.String(),
      collection: Type.Union(collections.map((collection) => Type.Literal(collection))),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const out = await deps.qmdAdapter.search({
        mode: params.mode as "semantic" | "keyword" | "hybrid",
        searchTerm: String(params.searchTerm ?? ""),
        collection: String(params.collection ?? ""),
        limit: params.limit as number | undefined,
      });
      if (!out.ok) return toolError({ tool: "kbSearch" }, out.error);
      return toolResult(
        { tool: "kbSearch", hitCount: out.hits.length },
        formatSearchHits(out.hits),
      );
    },
  };

  const readTool: RegisteredTool = {
    name: "kbDocRead",
    label: "Knowledge base read",
    description:
      `${baseCorpusText} Read document lines by relative path from the qmd collection. ` +
      `start and end are 0-based inclusive file line indices; the printed N| prefix is that same index. ` +
      `Omitted start is 0; omitted end means 200 lines beginning at start. ` +
      `This reads the file on disk, so a documentPath that is not indexed is still readable.`,
    promptSnippet: "Read lines from an external corpus document",
    promptGuidelines: [
      "Use collection and documentPath from kbSearch hits without modifying them.",
      "Pass a hit's line as start to open at that 0-based index.",
      "A path from kbDocList or kbDocTree works too, including an entry marked [unindexed].",
      "Use kbDocReadMultiple when you need several documents in one call.",
    ],
    parameters: Type.Object({
      collection: Type.Union(collections.map((collection) => Type.Literal(collection))),
      documentPath: Type.String(),
      start: Type.Optional(Type.Number()),
      end: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const out = await deps.qmdAdapter.read({
        collection: String(params.collection ?? ""),
        documentPath: String(params.documentPath ?? ""),
        start: params.start as number | undefined,
        end: params.end as number | undefined,
      });
      if (!out.ok) return toolError({ tool: "kbDocRead" }, out.error);
      return toolResult({ tool: "kbDocRead" }, out.text);
    },
  };

  const readMultipleTool: RegisteredTool = {
    name: "kbDocReadMultiple",
    label: "Knowledge base read multiple",
    description:
      `${baseCorpusText} Read several corpus documents in one call. ` +
      `Each documents[] entry takes collection, documentPath, and optional 0-based inclusive start/end with the same defaults as kbDocRead. ` +
      `Each successful block is the same progress text kbDocRead returns; per-document failures are reported inline and the other documents still return.`,
    promptSnippet: "Read several external corpus documents in one call",
    promptGuidelines: [
      "Use kbDocReadMultiple when you need to inspect several documents at once.",
      "Each documents[] entry uses the same collection, documentPath, start, and end rules as kbDocRead.",
      "A failed document is reported inline; other documents in the same call still return.",
    ],
    parameters: Type.Object({
      documents: Type.Array(
        Type.Object({
          collection: Type.Union(collections.map((collection) => Type.Literal(collection))),
          documentPath: Type.String({
            description: "Collection-relative path of the document to read",
          }),
          start: Type.Optional(Type.Number()),
          end: Type.Optional(Type.Number()),
        }),
        { description: "Documents to read, in order" },
      ),
    }),
    async execute(_id, params) {
      const documents = params.documents;
      if (!Array.isArray(documents) || documents.length === 0) {
        return toolError(
          { tool: "kbDocReadMultiple" },
          "documents must contain at least one entry.",
        );
      }

      const entries: Array<{ collection: string; documentPath: string; text?: string; error?: string }> =
        [];
      for (let i = 0; i < documents.length; i++) {
        const item = documents[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          entries.push({
            collection: "",
            documentPath: "",
            error: `documents[${i}] must be an object with collection and documentPath.`,
          });
          continue;
        }
        const row = item as {
          collection?: unknown;
          documentPath?: unknown;
          start?: unknown;
          end?: unknown;
        };
        const collection = String(row.collection ?? "");
        const documentPath = String(row.documentPath ?? "");
        if (collection.length === 0 || documentPath.length === 0) {
          entries.push({
            collection,
            documentPath,
            error: `documents[${i}] requires collection and documentPath.`,
          });
          continue;
        }
        const out = await deps.qmdAdapter.read({
          collection,
          documentPath,
          start: typeof row.start === "number" ? row.start : undefined,
          end: typeof row.end === "number" ? row.end : undefined,
        });
        if (!out.ok) {
          entries.push({ collection, documentPath, error: out.error });
          continue;
        }
        entries.push({ collection, documentPath, text: out.text });
      }

      const errors = entries.filter((entry) => entry.error).length;
      return toolResult(
        { tool: "kbDocReadMultiple", documentCount: entries.length, errors },
        formatReadMultipleResult(entries),
      );
    },
  };

  const collectionListTool: RegisteredTool = {
    name: "kbCollectionList",
    label: "Knowledge base collection list",
    description: `${baseCorpusText} List allowlisted qmd collections and their on-disk paths.`,
    promptSnippet: "List allowlisted qmd collections",
    promptGuidelines: ["Use this to discover collection names before searching."],
    parameters: Type.Object({}),
    async execute() {
      const out = await deps.qmdAdapter.listCollections();
      if (!out.ok) return toolError({ tool: "kbCollectionList" }, out.error);
      return toolResult(
        { tool: "kbCollectionList", count: out.collections.length },
        formatCollectionList(out.collections),
      );
    },
  };

  const docListTool: RegisteredTool = {
    name: "kbDocList",
    label: "Knowledge base directory list",
    description:
      `${baseCorpusText} List one directory of documents in exactly one allowlisted qmd collection per call (not recursive). ` +
      `Allowlisted collections: ${collections.join(", ")}. ` +
      `start is a 0-based offset into the immediate-child listing (default 0). ` +
      `Each result is one page (default 50 entries, max 100). ` +
      `The listing is the index plus the files on disk, so a file the index does not contain still appears, marked [unindexed].`,
    promptSnippet: "List one directory in an external qmd collection",
    promptGuidelines: [
      "Pass exactly one allowlisted collection; optional path is one directory under that collection.",
      "Directories end with /; call kbDocList again with that path to descend.",
      "Use start to continue when the header reports remaining entries.",
      "An entry marked [unindexed] is readable by path but will not come back from kbSearch.",
    ],
    parameters: Type.Object({
      collection: Type.Union(collections.map((collection) => Type.Literal(collection))),
      path: Type.Optional(Type.String()),
      start: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const out = await deps.qmdAdapter.listDocs({
        collection: String(params.collection ?? ""),
        path: params.path as string | undefined,
        start: params.start as number | undefined,
        limit: params.limit as number | undefined,
      });
      if (!out.ok) return toolError({ tool: "kbDocList" }, out.error);
      return toolResult({ tool: "kbDocList" }, out.text);
    },
  };

  const docTreeTool: RegisteredTool = {
    name: "kbDocTree",
    label: "Knowledge base document tree",
    description:
      `${baseCorpusText} List the recursive file tree in exactly one allowlisted qmd collection per call. ` +
      `Allowlisted collections: ${collections.join(", ")}. ` +
      `start is a 0-based offset into the tree listing (default 0). ` +
      `Each result is one page (default 50 entries, max 100). ` +
      `The tree is the index plus the files on disk, so a file the index does not contain still appears, marked [unindexed].`,
    promptSnippet: "List the recursive file tree in an external qmd collection",
    promptGuidelines: [
      "Pass exactly one allowlisted collection; optional path scopes under that directory recursively.",
      "Use start to continue when the header reports remaining entries.",
      "An entry marked [unindexed] is readable by path but will not come back from kbSearch.",
    ],
    parameters: Type.Object({
      collection: Type.Union(collections.map((collection) => Type.Literal(collection))),
      path: Type.Optional(Type.String()),
      start: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      const out = await deps.qmdAdapter.listTree({
        collection: String(params.collection ?? ""),
        path: params.path as string | undefined,
        start: params.start as number | undefined,
        limit: params.limit as number | undefined,
      });
      if (!out.ok) return toolError({ tool: "kbDocTree" }, out.error);
      return toolResult({ tool: "kbDocTree" }, out.text);
    },
  };

  const tools: RegisteredTool[] = [
    searchTool,
    readTool,
    readMultipleTool,
    collectionListTool,
    docListTool,
    docTreeTool,
  ];

  if (startup.config.writable) {
    const editTool: RegisteredTool = {
      name: "kbDocEdit",
      label: "Knowledge base edit",
      description:
        `${baseCorpusText} Edit one existing document with exact text replacement. ` +
        `Pass edits as a list of {oldText, newText}. Every edits[].oldText must match a unique, non-overlapping region of the original document. ` +
        `Keep each oldText as small as possible while it still occurs once; send only that excerpt and its replacement. ` +
        `If two changes affect the same block or nearby lines, merge them into one edit. ` +
        `Success reports the 0-based line index where the earliest replacement starts.`,
      promptSnippet: "Edit a corpus document with small exact replacements, including several disjoint edits in one call",
      promptGuidelines: [
        "Use kbDocEdit for precise changes. Each edits[].oldText must match a unique excerpt of the original document.",
        "When changing several separate places in one document, send one kbDocEdit call with multiple edits[] entries.",
        "Each edits[].oldText is matched against the original document. Merge nearby changes into one edit.",
        "Keep edits[].oldText as small as possible while it still occurs once in the document.",
        "Use kbDocCreate when the document does not exist yet.",
      ],
      parameters: Type.Object({
        collection: Type.Union(collections.map((collection) => Type.Literal(collection))),
        documentPath: Type.String({ description: "Collection-relative path of the document to edit" }),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String({
              description:
                "Exact text for one targeted replacement. It must be unique in the original document and must not overlap with any other edits[].oldText in the same call.",
            }),
            newText: Type.String({ description: "Replacement text for this targeted edit." }),
          }),
          {
            description:
              "One or more targeted replacements. Each edit is matched against the original document, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
          },
        ),
      }),
      prepareArguments: prepareKbDocEditArguments,
      async execute(_id, params) {
        const edits = params.edits;
        if (!Array.isArray(edits) || edits.length === 0) {
          return toolError({ tool: "kbDocEdit" }, "edits must contain at least one replacement.");
        }
        const parsed: Array<{ oldText: string; newText: string }> = [];
        for (let i = 0; i < edits.length; i++) {
          const item = edits[i];
          if (!isTextEdit(item)) {
            return toolError({ tool: "kbDocEdit" }, `edits[${i}] must include string oldText and newText.`);
          }
          parsed.push({ oldText: item.oldText, newText: item.newText });
        }
        const out = await deps.qmdAdapter.edit({
          collection: String(params.collection ?? ""),
          documentPath: String(params.documentPath ?? ""),
          edits: parsed,
        });
        if (!out.ok) return toolError({ tool: "kbDocEdit" }, out.error);
        return toolResult({ tool: "kbDocEdit" }, formatEditSuccess(out));
      },
    };
    const createTool: RegisteredTool = {
      name: "kbDocCreate",
      label: "Knowledge base create",
      description:
        `${baseCorpusText} Create a new document at documentPath and write content as its full text. ` +
        `The path is relative to the named collection and is treated like an object-storage key: nested segments such as a/b/c/foo.md are fine, and missing parent directories are created. ` +
        `Fails when that document already exists; use kbDocEdit to change an existing document. ` +
        `Success reports documentPath.`,
      promptSnippet: "Create a new document in an external qmd collection",
      promptGuidelines: [
        "Use kbDocCreate when the document does not exist yet. Pass documentPath and the full content.",
        "Treat documentPath like an object key: nested paths are allowed; parent directories are created automatically.",
        "Use kbDocEdit to change a document that already exists.",
      ],
      parameters: Type.Object({
        collection: Type.Union(collections.map((collection) => Type.Literal(collection))),
        documentPath: Type.String({
          description:
            "Collection-relative path of the new document (object-key style; parents are created). Fails if that path already exists.",
        }),
        content: Type.String({ description: "Full text of the new document." }),
      }),
      async execute(_id, params) {
        if (typeof params.content !== "string") {
          return toolError({ tool: "kbDocCreate" }, "content must be a string.");
        }
        const out = await deps.qmdAdapter.create({
          collection: String(params.collection ?? ""),
          documentPath: String(params.documentPath ?? ""),
          content: params.content,
        });
        if (!out.ok) return toolError({ tool: "kbDocCreate" }, out.error);
        return toolResult({ tool: "kbDocCreate" }, `documentPath: ${out.documentPath}`);
      },
    };
    tools.push(editTool, createTool);
  }

  return { kind: "tools", tools };
}
