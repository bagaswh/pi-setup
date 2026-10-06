import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildKnowledgeBaseTools,
  formatCollectionList,
  formatEditSuccess,
  formatReadMultipleResult,
  formatSearchHit,
  formatSearchHits,
  prepareKbDocEditArguments,
} from "./register.ts";
import type { StartupDecision } from "./config.ts";

function fakeAdapter(overrides?: {
  search?: () => Promise<{ ok: true; hits: Array<Record<string, unknown>> } | { ok: false; error: string }>;
  read?: (args: {
    collection: string;
    documentPath: string;
    start?: number;
    end?: number;
  }) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  edit?: () => Promise<{ ok: true; documentPath: string; line: number } | { ok: false; error: string }>;
  create?: () => Promise<{ ok: true; documentPath: string } | { ok: false; error: string }>;
  listCollections?: () => Promise<
    | { ok: true; collections: Array<{ name: string; path: string }> }
    | { ok: false; error: string }
  >;
  listDocs?: () => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  listTree?: () => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}) {
  return {
    async search() {
      if (overrides?.search) return overrides.search();
      return { ok: true as const, hits: [] };
    },
    async read(args: {
      collection: string;
      documentPath: string;
      start?: number;
      end?: number;
    }) {
      if (overrides?.read) return overrides.read(args);
      return { ok: true as const, text: "0|alpha" };
    },
    async edit() {
      if (overrides?.edit) return overrides.edit();
      return { ok: true as const, documentPath: "docs/a.md", line: 0 };
    },
    async create() {
      if (overrides?.create) return overrides.create();
      return { ok: true as const, documentPath: "docs/a.md" };
    },
    async listCollections() {
      if (overrides?.listCollections) return overrides.listCollections();
      return { ok: true as const, collections: [{ name: "runbooks", path: "/corpus/runbooks" }] };
    },
    async listDocs() {
      if (overrides?.listDocs) return overrides.listDocs();
      return { ok: true as const, text: "# kbDocList\n\n" };
    },
    async listTree() {
      if (overrides?.listTree) return overrides.listTree();
      return { ok: true as const, text: "# kbDocTree\n\n" };
    },
  };
}

function startup(writable: boolean): StartupDecision {
  return {
    kind: "ready",
    config: {
      backend: "qmd",
      writable,
      qmd: { collections: ["runbooks", "playbooks"] },
    },
    qmdCollections: [
      { name: "runbooks", path: "/corpus/runbooks" },
      { name: "playbooks", path: "/corpus/playbooks" },
    ],
  };
}

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? "";
}

test("writable false does not register kbDocEdit", () => {
  const plan = buildKnowledgeBaseTools(startup(false), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  assert.deepEqual(
    plan.tools.map((tool) => tool.name),
    ["kbSearch", "kbDocRead", "kbDocReadMultiple", "kbCollectionList", "kbDocList", "kbDocTree"],
  );
});

test("writable true includes kbDocEdit", () => {
  const plan = buildKnowledgeBaseTools(startup(true), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  assert.deepEqual(
    plan.tools.map((tool) => tool.name),
    [
      "kbSearch",
      "kbDocRead",
      "kbDocReadMultiple",
      "kbCollectionList",
      "kbDocList",
      "kbDocTree",
      "kbDocEdit",
      "kbDocCreate",
    ],
  );
});

test("search parameter mode enum is semantic keyword hybrid and collection enum matches allowlist", () => {
  const plan = buildKnowledgeBaseTools(startup(false), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const search = plan.tools.find((tool) => tool.name === "kbSearch");
  assert.ok(search);
  const schema = search.parameters as { properties: Record<string, { anyOf?: Array<{ const: string }> }> };
  const modes =
    schema.properties.mode.anyOf?.map((entry) => entry.const).sort() ?? [];
  const collections =
    schema.properties.collection.anyOf?.map((entry) => entry.const).sort() ?? [];
  assert.deepEqual(modes, ["hybrid", "keyword", "semantic"]);
  assert.deepEqual(collections, ["playbooks", "runbooks"]);
});

test("tool descriptions mention external corpus", () => {
  const plan = buildKnowledgeBaseTools(startup(true), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  for (const tool of plan.tools) {
    assert.match(tool.description, /outside the current workspace/i);
  }
});

test("tool descriptions mention 0-based indices for read list and tree", () => {
  const plan = buildKnowledgeBaseTools(startup(true), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const read = plan.tools.find((tool) => tool.name === "kbDocRead");
  const list = plan.tools.find((tool) => tool.name === "kbDocList");
  const tree = plan.tools.find((tool) => tool.name === "kbDocTree");
  const search = plan.tools.find((tool) => tool.name === "kbSearch");
  const edit = plan.tools.find((tool) => tool.name === "kbDocEdit");
  assert.ok(read && list && tree && search && edit);
  assert.match(read.description, /0-based inclusive file line indices/i);
  assert.match(list.description, /0-based offset/i);
  assert.match(tree.description, /0-based offset/i);
  assert.match(search.description, /0-based file line indices/i);
  assert.match(edit.description, /0-based line index/i);
});

test("search description lists allowlisted names and one-collection constraint", () => {
  const plan = buildKnowledgeBaseTools(startup(false), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const search = plan.tools.find((tool) => tool.name === "kbSearch");
  assert.ok(search);
  assert.match(search.description, /runbooks/);
  assert.match(search.description, /playbooks/);
  assert.match(search.description, /one allowlisted qmd collection per call/i);
});

test("kbCollectionList is registered with no parameters", () => {
  const plan = buildKnowledgeBaseTools(startup(false), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const collectionList = plan.tools.find((tool) => tool.name === "kbCollectionList");
  assert.ok(collectionList);
  const schema = collectionList.parameters as { properties?: Record<string, unknown> };
  assert.deepEqual(schema.properties ?? {}, {});
});

test("kbDocList is registered as one-directory listing with collection enum", () => {
  const plan = buildKnowledgeBaseTools(startup(false), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const list = plan.tools.find((tool) => tool.name === "kbDocList");
  assert.ok(list);
  assert.match(list.description, /outside the current workspace/i);
  assert.match(list.description, /runbooks/);
  assert.match(list.description, /playbooks/);
  assert.match(list.description, /exactly one allowlisted qmd collection per call/i);
  assert.match(list.description, /not recursive/i);
  assert.match(list.description, /one page/i);
  const schema = list.parameters as {
    properties: Record<string, { anyOf?: Array<{ const: string }> }>;
  };
  const collections =
    schema.properties.collection.anyOf?.map((entry) => entry.const).sort() ?? [];
  assert.deepEqual(collections, ["playbooks", "runbooks"]);
});

test("kbDocTree is registered as recursive listing with collection enum", () => {
  const plan = buildKnowledgeBaseTools(startup(false), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const tree = plan.tools.find((tool) => tool.name === "kbDocTree");
  assert.ok(tree);
  assert.match(tree.description, /outside the current workspace/i);
  assert.match(tree.description, /recursive/i);
  assert.match(tree.description, /one page/i);
  assert.match(tree.description, /exactly one allowlisted qmd collection per call/i);
});

test("kbDocList returns progress text directly, not a JSON envelope", async () => {
  const progress =
    "# kbDocList  collection runbooks  (printed entries 0 through 1 of 4, remaining 2)\n" +
    "# Call kbDocList with collection=runbooks start=2 to load the next page.\n\n" +
    "4.1 KB  Sep 26 18:07  AGENTS.md\na-system-overview/";
  const plan = buildKnowledgeBaseTools(startup(false), {
    qmdAdapter: fakeAdapter({
      listDocs: async () => ({ ok: true, text: progress }),
    }),
  });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const list = plan.tools.find((tool) => tool.name === "kbDocList");
  assert.ok(list);
  const result = await list.execute(
    "1",
    { collection: "runbooks", start: 0, limit: 2 },
    new AbortController().signal,
  );
  assert.equal(result.isError, undefined);
  assert.equal(toolText(result), progress);
  assert.throws(() => JSON.parse(toolText(result)));
});

test("kbDocTree returns progress text directly, not a JSON envelope", async () => {
  const progress =
    "# kbDocTree  collection runbooks  (printed entries 0 through 1 of 3, remaining 1)\n" +
    "# Call kbDocTree with collection=runbooks start=2 to load the next page.\n\n" +
    "4.1 KB  Sep 26 18:07  AGENTS.md\n1.3 KB  Sep 26 18:07  a-system-overview/examples/Payment API Platform.md";
  const plan = buildKnowledgeBaseTools(startup(false), {
    qmdAdapter: fakeAdapter({
      listTree: async () => ({ ok: true, text: progress }),
    }),
  });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const tree = plan.tools.find((tool) => tool.name === "kbDocTree");
  assert.ok(tree);
  const result = await tree.execute(
    "1",
    { collection: "runbooks", start: 0, limit: 2 },
    new AbortController().signal,
  );
  assert.equal(toolText(result), progress);
  assert.throws(() => JSON.parse(toolText(result)));
});

test("fatal startup is returned by pure function", () => {
  const plan = buildKnowledgeBaseTools(
    { kind: "fatal", message: "bad config" },
    { qmdAdapter: fakeAdapter() },
  );
  assert.deepEqual(plan, { kind: "fatal", message: "bad config" });
});

test("missing config returns no-tools without throw", () => {
  const plan = buildKnowledgeBaseTools(
    { kind: "no-config" },
    { qmdAdapter: fakeAdapter() },
  );
  assert.deepEqual(plan, { kind: "no-tools" });
});

test("kbDocRead returns progress text directly, not a JSON envelope", async () => {
  const progress =
    "# kbDocRead  collection runbooks  documentPath docs/a.md  (printed from line 44 to line 47 of 60, 44 lines before, remaining 12 lines)\n" +
    "# Call kbDocRead with collection=runbooks documentPath=docs/a.md start=48 end=59 to load the next window.\n\n" +
    "44|alpha\n45|beta";
  const plan = buildKnowledgeBaseTools(startup(false), {
    qmdAdapter: fakeAdapter({
      read: async () => ({ ok: true, text: progress }),
    }),
  });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const read = plan.tools.find((tool) => tool.name === "kbDocRead");
  assert.ok(read);
  const result = await read.execute(
    "1",
    { collection: "runbooks", documentPath: "docs/a.md", start: 44, end: 47 },
    new AbortController().signal,
  );
  assert.equal(result.isError, undefined);
  assert.equal(toolText(result), progress);
  assert.throws(() => JSON.parse(toolText(result)));
});

test("kbDocReadMultiple joins successes, keeps inline failures, and rejects an empty list", async () => {
  const plan = buildKnowledgeBaseTools(startup(false), {
    qmdAdapter: fakeAdapter({
      read: async (args) => {
        if (args.documentPath === "docs/missing.md") {
          return { ok: false, error: "document not found: docs/missing.md" };
        }
        return {
          ok: true,
          text: `# kbDocRead  collection ${args.collection}  documentPath ${args.documentPath}\n\n0|ok`,
        };
      },
    }),
  });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const tool = plan.tools.find((entry) => entry.name === "kbDocReadMultiple");
  assert.ok(tool);

  const empty = await tool.execute("1", { documents: [] }, new AbortController().signal);
  assert.equal(empty.isError, true);
  assert.match(toolText(empty), /documents must contain at least one entry/);

  const result = await tool.execute(
    "1",
    {
      documents: [
        { collection: "runbooks", documentPath: "docs/a.md" },
        { collection: "playbooks", documentPath: "docs/missing.md" },
      ],
    },
    new AbortController().signal,
  );
  assert.equal(result.isError, undefined);
  assert.equal(
    toolText(result),
    formatReadMultipleResult([
      {
        collection: "runbooks",
        documentPath: "docs/a.md",
        text: "# kbDocRead  collection runbooks  documentPath docs/a.md\n\n0|ok",
      },
      {
        collection: "playbooks",
        documentPath: "docs/missing.md",
        error: "document not found: docs/missing.md",
      },
    ]),
  );
  assert.equal(result.details.errors, 1);
  assert.throws(() => JSON.parse(toolText(result)));
});

test("kbSearch returns readable hit blocks, not a JSON array", async () => {
  const plan = buildKnowledgeBaseTools(startup(false), {
    qmdAdapter: fakeAdapter({
      search: async () => ({
        ok: true,
        hits: [
          {
            collection: "runbooks",
            documentPath: "docs/a.md",
            snippet: "deploy with dokku",
            line: 12,
            score: 0.91,
            context: "docs",
          },
        ],
      }),
    }),
  });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const search = plan.tools.find((tool) => tool.name === "kbSearch");
  assert.ok(search);
  const result = await search.execute(
    "1",
    { mode: "semantic", searchTerm: "dokku", collection: "runbooks" },
    new AbortController().signal,
  );
  const text = toolText(result);
  assert.equal(result.isError, undefined);
  assert.equal(
    text,
    [
      "collection: runbooks",
      "documentPath: docs/a.md",
      "line: 12",
      "score: 0.91",
      "context: docs",
      "snippet:",
      "deploy with dokku",
    ].join("\n"),
  );
  assert.throws(() => JSON.parse(text));
});

test("kbCollectionList returns name and path as text blocks", async () => {
  const plan = buildKnowledgeBaseTools(startup(false), {
    qmdAdapter: fakeAdapter({
      listCollections: async () => ({
        ok: true,
        collections: [
          { name: "runbooks", path: "/corpus/runbooks" },
          { name: "playbooks", path: "/corpus/playbooks" },
        ],
      }),
    }),
  });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const list = plan.tools.find((tool) => tool.name === "kbCollectionList");
  assert.ok(list);
  const result = await list.execute("1", {}, new AbortController().signal);
  assert.equal(
    toolText(result),
    "name: runbooks\npath: /corpus/runbooks\n\nname: playbooks\npath: /corpus/playbooks",
  );
});

test("kbDocEdit success returns documentPath and line as text", async () => {
  const plan = buildKnowledgeBaseTools(startup(true), {
    qmdAdapter: fakeAdapter({
      edit: async () => ({ ok: true, documentPath: "docs/a.md", line: 3 }),
    }),
  });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const edit = plan.tools.find((tool) => tool.name === "kbDocEdit");
  assert.ok(edit);
  const result = await edit.execute(
    "1",
    {
      collection: "runbooks",
      documentPath: "docs/a.md",
      edits: [{ oldText: "old", newText: "new" }],
    },
    new AbortController().signal,
  );
  assert.equal(toolText(result), "documentPath: docs/a.md\nline: 3");
});

test("kbDocCreate success returns documentPath as text", async () => {
  const plan = buildKnowledgeBaseTools(startup(true), {
    qmdAdapter: fakeAdapter({
      create: async () => ({ ok: true, documentPath: "docs/new.md" }),
    }),
  });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const create = plan.tools.find((tool) => tool.name === "kbDocCreate");
  assert.ok(create);
  const schema = create.parameters as { properties: Record<string, { type?: string }> };
  assert.equal(schema.properties.content.type, "string");
  assert.equal(schema.properties.documentPath.type, "string");
  const result = await create.execute(
    "1",
    { collection: "runbooks", documentPath: "docs/new.md", content: "hello\n" },
    new AbortController().signal,
  );
  assert.equal(toolText(result), "documentPath: docs/new.md");
  assert.equal(result.isError, undefined);
});

test("tool errors are readable text with isError", async () => {
  const plan = buildKnowledgeBaseTools(startup(false), {
    qmdAdapter: fakeAdapter({
      read: async () => ({ ok: false, error: "document not found: missing.md" }),
    }),
  });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const read = plan.tools.find((tool) => tool.name === "kbDocRead");
  assert.ok(read);
  const result = await read.execute(
    "1",
    { collection: "runbooks", documentPath: "missing.md" },
    new AbortController().signal,
  );
  assert.equal(result.isError, true);
  assert.equal(toolText(result), "document not found: missing.md");
  assert.throws(() => JSON.parse(toolText(result)));
});

test("formatSearchHit omits absent optional fields", () => {
  assert.equal(
    formatSearchHit({
      collection: "runbooks",
      documentPath: "a.md",
      snippet: "hello",
    }),
    "collection: runbooks\ndocumentPath: a.md\nsnippet:\nhello",
  );
  assert.equal(formatSearchHits([]), "No hits.");
});

test("kbDocEdit schema is an edits list and prepareArguments accepts Pi edit shapes", () => {
  const plan = buildKnowledgeBaseTools(startup(true), { qmdAdapter: fakeAdapter() });
  assert.equal(plan.kind, "tools");
  if (plan.kind !== "tools") return;
  const edit = plan.tools.find((tool) => tool.name === "kbDocEdit");
  assert.ok(edit);
  const schema = edit.parameters as {
    properties: Record<string, { type?: string; items?: { properties?: Record<string, { description?: string }> }; description?: string }>;
  };
  assert.equal(schema.properties.edits.type, "array");
  assert.match(schema.properties.edits.description ?? "", /original document/);
  assert.ok(schema.properties.edits.items?.properties?.oldText);
  assert.ok(schema.properties.edits.items?.properties?.newText);
  assert.equal("originalValue" in schema.properties, false);
  assert.match(edit.description, /as small as possible/i);

  assert.deepEqual(
    prepareKbDocEditArguments({
      collection: "runbooks",
      documentPath: "a.md",
      edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
    }).edits,
    [{ oldText: "a", newText: "b" }],
  );
  assert.deepEqual(prepareKbDocEditArguments({ edits: { oldText: "a", newText: "b" } }).edits, [
    { oldText: "a", newText: "b" },
  ]);
  assert.deepEqual(prepareKbDocEditArguments({ oldText: "a", newText: "b" }).edits, [
    { oldText: "a", newText: "b" },
  ]);
});

test("formatCollectionList and formatEditSuccess stay plain text", () => {
  assert.equal(formatCollectionList([]), "No collections.");
  assert.equal(formatEditSuccess({ documentPath: "x.md", line: 9 }), "documentPath: x.md\nline: 9");
});
