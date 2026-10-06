import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createCollectionInspector,
  createDefaultDiskWalker,
  createQmdAdapter,
  createSdkCollectionScanRefresh,
  MAX_WALK_ENTRIES,
  mergeIndexedWithDisk,
  parseQmdCollectionListNames,
  parseQmdCollectionShow,
  parseQmdLsLine,
  parseQmdLsStdout,
  resolveQmdIndexDbPath,
  type DiskWalk,
  type DiskWalkEntry,
} from "./qmd.ts";

type CallRecord = string[][];

function ok(stdout: string): { ok: true; stdout: string; stderr: string; exitCode: number } {
  return { ok: true, stdout, stderr: "", exitCode: 0 };
}

function makeAdapter(options: {
  runCli: (argv: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }>;
  inspectCollection?: (collection: string) => Promise<{ ok: true; rootDir: string; updateCommand: string } | { ok: false; error: string }>;
  refreshCollection?: () => Promise<void>;
  ensureRefreshReady?: () => { ok: true } | { ok: false; error: string };
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  mkdir?: (dirPath: string) => Promise<void>;
  walkCollection?: (rootDir: string) => Promise<DiskWalk>;
}) {
  return createQmdAdapter({
    allowlistedCollections: ["runbooks", "playbooks"],
    runCli: options.runCli,
    inspectCollection:
      options.inspectCollection ??
      (async () => ({ ok: true, rootDir: "/corpus", updateCommand: "" })),
    refreshCollection: options.refreshCollection ?? (async () => {}),
    ensureRefreshReady: options.ensureRefreshReady,
    readFile: options.readFile,
    writeFile: options.writeFile,
    mkdir: options.mkdir ?? (async () => {}),
    // Hermetic default: no on-disk entries unless a test supplies a walk.
    walkCollection: options.walkCollection ?? (async () => emptyWalk()),
  });
}

function emptyWalk(): DiskWalk {
  return { entries: [], truncated: false };
}

function walkOf(entries: DiskWalkEntry[], truncated = false): DiskWalk {
  return { entries, truncated };
}

/** Fixed instant, rendered through local time so assertions stay machine-independent. */
const WALK_MTIME_MS = new Date(2026, 8, 26, 18, 7).getTime();

function diskFile(documentPath: string, sizeBytes: number): DiskWalkEntry {
  return { kind: "file", documentPath, sizeBytes, mtimeMs: WALK_MTIME_MS };
}

function diskDir(documentPath: string): DiskWalkEntry {
  return { kind: "dir", documentPath };
}

test("qmd search mode enum behavior and command mapping", async () => {
  const calls: CallRecord = [];
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("[]");
    },
  });

  await adapter.search({ mode: "semantic", searchTerm: "alpha", collection: "runbooks" });
  await adapter.search({ mode: "keyword", searchTerm: "alpha", collection: "runbooks" });
  await adapter.search({ mode: "hybrid", searchTerm: "alpha", collection: "runbooks" });

  assert.equal(calls[0][1], "vsearch");
  assert.equal(calls[1][1], "search");
  assert.equal(calls[2][1], "query");
  for (const call of calls) {
    assert.deepEqual(call.slice(2, 7), ["-c", "runbooks", "--json", "-n", "10"]);
  }
});

test("qmd search rejects unknown collection, bad limit, and empty term with no CLI call", async () => {
  const calls: CallRecord = [];
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("[]");
    },
  });

  const unknownCollection = await adapter.search({
    mode: "semantic",
    searchTerm: "alpha",
    collection: "not-allowlisted",
  });
  const badLimit = await adapter.search({ mode: "semantic", searchTerm: "alpha", collection: "runbooks", limit: 0 });
  const tooHigh = await adapter.search({ mode: "semantic", searchTerm: "alpha", collection: "runbooks", limit: 21 });
  const emptyTerm = await adapter.search({ mode: "semantic", searchTerm: "   ", collection: "runbooks" });

  assert.equal(unknownCollection.ok, false);
  assert.equal(badLimit.ok, false);
  assert.equal(tooHigh.ok, false);
  assert.equal(emptyTerm.ok, false);
  assert.equal(calls.length, 0);
});

test("qmd search shapes hits per chunk, with relative path and snippet limit", async () => {
  const calls: CallRecord = [];
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok(
        JSON.stringify([
          {
            path: "/corpus/docs/a.md",
            line: 8,
            snippet: "x".repeat(2100),
            score: 0.71,
            context: "docs",
          },
          {
            uri: "qmd://runbooks/docs/a.md",
            line: 14,
            snippet: "second chunk",
          },
        ]),
      );
    },
  });

  const got = await adapter.search({ mode: "semantic", searchTerm: "alpha", collection: "runbooks", limit: 5 });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(2, 7), ["-c", "runbooks", "--json", "-n", "5"]);
  assert.equal(got.hits.length, 2);
  assert.equal(got.hits[0].documentPath, "docs/a.md");
  assert.equal(got.hits[1].documentPath, "docs/a.md");
  assert.equal(got.hits[0].collection, "runbooks");
  assert.equal(got.hits[1].collection, "runbooks");
  assert.equal(got.hits[0].snippet.length, 2000);
  assert.equal(got.hits[0].line, 7);
  assert.equal(got.hits[1].line, 13);
});

test("qmd search and read never call update or embed", async () => {
  const calls: CallRecord = [];
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("[]");
    },
    readFile: async () => "line one\nline two\n",
  });

  await adapter.search({ mode: "semantic", searchTerm: "alpha", collection: "runbooks" });
  await adapter.read({ collection: "runbooks", documentPath: "docs/a.md" });

  const flattened = calls.map((argv) => argv.join(" "));
  assert.equal(flattened.some((line) => line.includes("qmd update")), false);
  assert.equal(flattened.some((line) => line.includes("qmd embed")), false);
  assert.equal(flattened.some((line) => line.includes("qmd get")), false);
});

function readBodyLines(text: string): string[] {
  const sep = text.indexOf("\n\n");
  assert.ok(sep >= 0, "expected progress header then blank line then body");
  return text.slice(sep + 2).split("\n");
}

test("qmd read omitted bounds request 0-199 and format N|text", async () => {
  const calls: CallRecord = [];
  const lines = Array.from({ length: 220 }, (_v, index) => `line-${index}`).join("\n");
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("[]");
    },
    readFile: async () => lines,
  });

  const got = await adapter.read({ collection: "runbooks", documentPath: "docs/a.md" });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.match(
    got.text,
    /\(printed from line 0 to line 199 of 220, remaining 20 lines\)/,
  );
  assert.match(
    got.text,
    /Call kbDocRead with collection=runbooks documentPath=docs\/a\.md start=200 end=219 to load the next window/,
  );
  const out = readBodyLines(got.text);
  assert.equal(out.length, 200);
  assert.equal(out[0], "0|line-0");
  assert.equal(out[199], "199|line-199");
  assert.equal(calls.some((argv) => argv[1] === "get"), false);
});

test("qmd read honors inclusive start and end on source file lines", async () => {
  const source = Array.from({ length: 60 }, (_v, index) => `L${index}`).join("\n");
  const adapter = makeAdapter({
    runCli: async () => ok("[]"),
    readFile: async () => source,
  });

  const got = await adapter.read({
    collection: "runbooks",
    documentPath: "docs/a.md",
    start: 0,
    end: 19,
  });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.match(
    got.text,
    /\(printed from line 0 to line 19 of 60, remaining 40 lines\)/,
  );
  const out = readBodyLines(got.text);
  assert.equal(out.length, 20);
  assert.equal(out[0], "0|L0");
  assert.equal(out[19], "19|L19");

  const slice = await adapter.read({
    collection: "runbooks",
    documentPath: "docs/a.md",
    start: 44,
    end: 47,
  });
  assert.equal(slice.ok, true);
  if (!slice.ok) return;
  assert.match(
    slice.text,
    /\(printed from line 44 to line 47 of 60, 44 lines before, remaining 12 lines\)/,
  );
  const sliceOut = readBodyLines(slice.text);
  assert.equal(sliceOut.length, 4);
  assert.equal(sliceOut[0], "44|L44");
  assert.equal(sliceOut[3], "47|L47");
});

test("qmd read start past end errors with line count", async () => {
  const calls: CallRecord = [];
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("");
    },
    readFile: async () => "a\nb\nc\n",
  });

  const got = await adapter.read({ collection: "runbooks", documentPath: "docs/a.md", start: 9 });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.match(got.error, /3 lines/);
});

test("qmd edit exact single match writes, refreshes collection, and embeds", async () => {
  const calls: CallRecord = [];
  const scans: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const files = new Map<string, string>([
    ["/corpus/docs/a.md", "alpha\nbeta\ngamma"],
  ]);
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("");
    },
    refreshCollection: async () => {
      scans.push("runbooks");
    },
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    writeFile: async (filePath, content) => {
      writes.push({ path: filePath, content });
      files.set(filePath, content);
    },
  });

  const got = await adapter.edit({
    collection: "runbooks",
    documentPath: "docs/a.md",
    edits: [{ oldText: "beta", newText: "BETA" }],
  });

  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.line, 1);
  assert.equal(files.get("/corpus/docs/a.md"), "alpha\nBETA\ngamma");
  assert.equal(scans.length, 1);
  assert.deepEqual(calls, [["qmd", "embed", "-c", "runbooks"]]);
});

test("qmd create writes a missing file, makes the parent directory, refreshes, and embeds", async () => {
  const calls: CallRecord = [];
  const scans: string[] = [];
  const made: string[] = [];
  const files = new Map<string, string>();
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("");
    },
    refreshCollection: async () => {
      scans.push("runbooks");
    },
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, content);
    },
    mkdir: async (dirPath) => {
      made.push(dirPath);
    },
  });

  const got = await adapter.create({
    collection: "runbooks",
    documentPath: "docs/new/page.md",
    content: "hello\n",
  });

  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.documentPath, "docs/new/page.md");
  assert.equal(files.get("/corpus/docs/new/page.md"), "hello\n");
  assert.deepEqual(made, ["/corpus/docs/new"]);
  assert.equal(scans.length, 1);
  assert.deepEqual(calls, [["qmd", "embed", "-c", "runbooks"]]);
});

test("qmd create leaves an existing file unchanged and skips a blocked write", async () => {
  const files = new Map<string, string>([["/corpus/docs/a.md", "already"]]);
  let refreshed = false;
  const adapter = makeAdapter({
    runCli: async () => ok(""),
    refreshCollection: async () => {
      refreshed = true;
    },
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    writeFile: async () => {
      throw new Error("should not write");
    },
  });

  const exists = await adapter.create({
    collection: "runbooks",
    documentPath: "docs/a.md",
    content: "new",
  });
  const outside = await adapter.create({
    collection: "runbooks",
    documentPath: "../secret.md",
    content: "new",
  });

  assert.equal(exists.ok, false);
  if (!exists.ok) assert.match(exists.error, /already exists/);
  assert.equal(outside.ok, false);
  assert.equal(files.get("/corpus/docs/a.md"), "already");
  assert.equal(refreshed, false);
});

test("qmd create skips write when refresh is not ready or the update command is set", async () => {
  const files = new Map<string, string>();
  const notReady = makeAdapter({
    runCli: async () => ok(""),
    ensureRefreshReady: () => ({ ok: false, error: "qmd CLI not found on PATH" }),
    refreshCollection: async () => {
      throw new Error("should not refresh");
    },
    readFile: async () => {
      throw new Error("missing");
    },
    writeFile: async () => {
      throw new Error("should not write");
    },
  });
  const blocked = await notReady.create({
    collection: "runbooks",
    documentPath: "docs/a.md",
    content: "hello",
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.match(blocked.error, /qmd CLI not found on PATH/);

  let inspectCalls = 0;
  const hooked = makeAdapter({
    runCli: async () => ok(""),
    inspectCollection: async () => {
      inspectCalls += 1;
      if (inspectCalls === 1) return { ok: true, rootDir: "/corpus", updateCommand: "" };
      return { ok: true, rootDir: "/corpus", updateCommand: "git pull origin main" };
    },
    refreshCollection: async () => {
      throw new Error("should not refresh");
    },
    readFile: async () => {
      throw new Error("missing");
    },
    writeFile: async () => {
      throw new Error("should not write");
    },
  });
  const refused = await hooked.create({
    collection: "runbooks",
    documentPath: "docs/a.md",
    content: "hello",
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /update command is set/);
  assert.equal(files.size, 0);
});

test("qmd edit skips write when @tobilu/qmd package cannot be resolved", async () => {
  const files = new Map<string, string>([
    ["/corpus/docs/a.md", "alpha\nbeta\ngamma"],
  ]);
  let refreshed = false;
  const adapter = makeAdapter({
    runCli: async () => ok(""),
    ensureRefreshReady: () => ({
      ok: false,
      error: "qmd CLI not found on PATH",
    }),
    refreshCollection: async () => {
      refreshed = true;
    },
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    writeFile: async () => {
      throw new Error("should not write");
    },
  });

  const got = await adapter.edit({
    collection: "runbooks",
    documentPath: "docs/a.md",
    edits: [{ oldText: "beta", newText: "BETA" }],
  });

  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.match(got.error, /qmd CLI not found on PATH/);
  assert.equal(files.get("/corpus/docs/a.md"), "alpha\nbeta\ngamma");
  assert.equal(refreshed, false);
});

test("createSdkCollectionScanRefresh spawns with resolved package cwd and INDEX_PATH", async () => {
  const spawns: Array<{ command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
  const refresh = createSdkCollectionScanRefresh({
    resolvePackage: () => ({
      ok: true,
      packageRoot: "/opt/node_modules/@tobilu/qmd",
      moduleResolveCwd: "/opt",
    }),
    resolveIndexPath: () => "/tmp/qmd-index.sqlite",
    workingDirectory: "/repo",
    spawnChild: (command, args, options) => {
      spawns.push({ command, args, options });
      const proc = {
        stderr: {
          on(_event: string, _cb: (...cbArgs: unknown[]) => void) {
            return proc.stderr;
          },
        },
        on(event: string, cb: (...cbArgs: unknown[]) => void) {
          if (event === "close") {
            setImmediate(() => cb(0));
          }
          return proc;
        },
      };
      return proc as unknown as ReturnType<typeof import("node:child_process").spawn>;
    },
  });

  await refresh("runbooks");

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.equal(spawns[0].options.cwd, "/opt");
  assert.equal(spawns[0].options.env?.INDEX_PATH, "/tmp/qmd-index.sqlite");
  assert.equal(spawns[0].args[0], "--input-type=module");
  assert.equal(spawns[0].args[1], "-e");
  assert.match(spawns[0].args[2], /import \{ createStore \} from '@tobilu\/qmd'/);
  assert.match(spawns[0].args[2], /store\.update\(\{ collections: \[process\.argv\[1\]\] \}\)/);
  assert.equal(spawns[0].args[3], "runbooks");
});

test("createSdkCollectionScanRefresh rejects when package resolution fails", async () => {
  const refresh = createSdkCollectionScanRefresh({
    resolvePackage: () => ({ ok: false, error: "could not find @tobilu/qmd package root" }),
    spawnChild: () => {
      throw new Error("should not spawn");
    },
  });
  await assert.rejects(() => refresh("runbooks"), /could not find @tobilu\/qmd package root/);
});

test("resolveQmdIndexDbPath prefers INDEX_PATH then project-local .qmd", () => {
  const previous = process.env.INDEX_PATH;
  process.env.INDEX_PATH = "/explicit/index.sqlite";
  try {
    assert.equal(resolveQmdIndexDbPath("/any"), "/explicit/index.sqlite");
  } finally {
    if (previous === undefined) delete process.env.INDEX_PATH;
    else process.env.INDEX_PATH = previous;
  }
});

test("qmd edit leaves file unchanged on zero, many, or empty oldText", async () => {
  const files = new Map<string, string>([
    ["/corpus/docs/a.md", "beta\nalpha\nbeta"],
  ]);
  const adapter = makeAdapter({
    runCli: async () => ok(""),
    refreshCollection: async () => {
      throw new Error("should not refresh");
    },
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    writeFile: async () => {
      throw new Error("should not write");
    },
  });

  const many = await adapter.edit({
    collection: "runbooks",
    documentPath: "docs/a.md",
    edits: [{ oldText: "beta", newText: "BETA" }],
  });
  const none = await adapter.edit({
    collection: "runbooks",
    documentPath: "docs/a.md",
    edits: [{ oldText: "delta", newText: "DELTA" }],
  });
  const empty = await adapter.edit({
    collection: "runbooks",
    documentPath: "docs/a.md",
    edits: [{ oldText: "", newText: "X" }],
  });

  assert.equal(many.ok, false);
  assert.equal(none.ok, false);
  assert.equal(empty.ok, false);
  assert.equal(files.get("/corpus/docs/a.md"), "beta\nalpha\nbeta");
});

test("qmd edit skips write when collection update command is set", async () => {
  const files = new Map<string, string>([
    ["/corpus/docs/a.md", "alpha\nbeta\ngamma"],
  ]);
  let inspectCalls = 0;
  const adapter = makeAdapter({
    runCli: async () => ok(""),
    inspectCollection: async () => {
      inspectCalls += 1;
      if (inspectCalls === 1) return { ok: true, rootDir: "/corpus", updateCommand: "" };
      return { ok: true, rootDir: "/corpus", updateCommand: "git pull origin main" };
    },
    refreshCollection: async () => {
      throw new Error("should not refresh");
    },
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    writeFile: async () => {
      throw new Error("should not write");
    },
  });

  const got = await adapter.edit({
    collection: "runbooks",
    documentPath: "docs/a.md",
    edits: [{ oldText: "beta", newText: "BETA" }],
  });
  assert.equal(got.ok, false);
  assert.equal(files.get("/corpus/docs/a.md"), "alpha\nbeta\ngamma");
});

test("qmd read and edit reject unknown collection before CLI call", async () => {
  const calls: CallRecord = [];
  const files = new Map<string, string>([
    ["/corpus/docs/a.md", "alpha\nbeta\ngamma"],
  ]);
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("");
    },
    refreshCollection: async () => {
      throw new Error("should not refresh");
    },
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    writeFile: async () => {
      throw new Error("should not write");
    },
  });

  const readResult = await adapter.read({ collection: "unknown", documentPath: "docs/a.md" });
  const editResult = await adapter.edit({
    collection: "unknown",
    documentPath: "docs/a.md",
    edits: [{ oldText: "beta", newText: "BETA" }],
  });
  const createResult = await adapter.create({
    collection: "unknown",
    documentPath: "docs/a.md",
    content: "hello",
  });

  assert.equal(readResult.ok, false);
  assert.equal(editResult.ok, false);
  assert.equal(createResult.ok, false);
  assert.equal(calls.length, 0);
  assert.equal(files.get("/corpus/docs/a.md"), "alpha\nbeta\ngamma");
});

test("qmd listCollections returns only allowlisted entries", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(""),
    inspectCollection: async (collection) => ({
      ok: true,
      rootDir: `/corpus/${collection}`,
      updateCommand: "",
    }),
  });
  const got = await adapter.listCollections();
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.deepEqual(got.collections, [
    { name: "runbooks", path: "/corpus/runbooks" },
    { name: "playbooks", path: "/corpus/playbooks" },
  ]);
});

function nestedLsStdout(): string {
  return [
    " 4.1 KB  Sep 26 18:07  qmd://runbooks/AGENTS.md",
    " 1.1 KB  Sep 26 18:07  qmd://runbooks/README.md",
    " 1.7 KB  Sep 26 18:07  qmd://runbooks/a-system-overview/certificate-management.md",
    " 1.3 KB  Sep 26 18:07  qmd://runbooks/a-system-overview/examples/Payment API Platform.md",
    "  353 B  Sep 26 18:07  qmd://runbooks/a-system-overview/infra-certificate-authority.md",
    "  792 B  Sep 26 18:07  qmd://runbooks/c-ci-cd/guide/README.md",
  ].join("\n");
}

test("qmd listDocs at root shows only immediate children and directories with trailing slash", async () => {
  const calls: CallRecord = [];
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok(nestedLsStdout());
    },
  });

  const got = await adapter.listDocs({ collection: "runbooks" });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.deepEqual(calls, [["qmd", "ls", "runbooks"]]);
  assert.match(got.text, /AGENTS\.md/);
  assert.match(got.text, /README\.md/);
  assert.match(got.text, /^a-system-overview\/$/m);
  assert.match(got.text, /^c-ci-cd\/$/m);
  assert.equal(got.text.includes("certificate-management.md"), false);
  assert.equal(got.text.includes("Payment API Platform.md"), false);
  assert.equal(got.text.includes("qmd://"), false);
  assert.match(got.text, /remaining 0/);
});

test("qmd listDocs in a subdirectory does not include deeper files", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
  });
  const got = await adapter.listDocs({ collection: "runbooks", path: "a-system-overview" });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.match(got.text, /a-system-overview\/certificate-management\.md/);
  assert.match(got.text, /^a-system-overview\/examples\/$/m);
  assert.match(got.text, /a-system-overview\/infra-certificate-authority\.md/);
  assert.equal(got.text.includes("Payment API Platform.md"), false);
  assert.equal(got.text.includes("AGENTS.md"), false);
});

test("qmd listTree includes nested files including paths with spaces", async () => {
  const calls: CallRecord = [];
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok(nestedLsStdout());
    },
  });
  const got = await adapter.listTree({ collection: "runbooks" });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.deepEqual(calls, [["qmd", "ls", "runbooks"]]);
  assert.match(got.text, /a-system-overview\/examples\/Payment API Platform\.md/);
  assert.match(got.text, /c-ci-cd\/guide\/README\.md/);
  assert.equal(got.text.includes("qmd://"), false);
  assert.equal(/^a-system-overview\/$/m.test(got.text), false);
});

test("qmd listDocs pagination next-call and start past end", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
  });
  const page = await adapter.listDocs({ collection: "runbooks", start: 0, limit: 2 });
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.match(page.text, /\(printed entries 0 through 1 of 4, remaining 2\)/);
  assert.match(page.text, /Call kbDocList with collection=runbooks start=2 to load the next page/);

  const omitted = await adapter.listDocs({ collection: "runbooks" });
  assert.equal(omitted.ok, true);
  if (!omitted.ok) return;
  assert.match(omitted.text, /\(printed entries 0 through 3 of 4, remaining 0\)/);

  const past = await adapter.listDocs({ collection: "runbooks", start: 9 });
  assert.equal(past.ok, false);
  if (past.ok) return;
  assert.match(past.error, /4 entries/);
});

test("qmd listTree pagination next-call names kbDocTree", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
  });
  const page = await adapter.listTree({ collection: "runbooks", start: 0, limit: 2 });
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.match(page.text, /\(printed entries 0 through 1 of 6, remaining 4\)/);
  assert.match(page.text, /Call kbDocTree with collection=runbooks start=2 to load the next page/);
});

test("qmd listDocs and listTree reject bad limit and .. path with no CLI call", async () => {
  const calls: CallRecord = [];
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("");
    },
  });

  for (const method of ["listDocs", "listTree"] as const) {
    const zero = await adapter[method]({ collection: "runbooks", limit: 0 });
    const tooHigh = await adapter[method]({ collection: "runbooks", limit: 101 });
    const parent = await adapter[method]({ collection: "runbooks", path: "../x" });
    assert.equal(zero.ok, false);
    assert.equal(tooHigh.ok, false);
    assert.equal(parent.ok, false);
  }
  assert.equal(calls.length, 0);
});

test("qmd listDocs and listTree reject unknown collection before CLI call", async () => {
  const calls: CallRecord = [];
  const adapter = makeAdapter({
    runCli: async (argv) => {
      calls.push(argv);
      return ok("");
    },
  });
  assert.equal((await adapter.listDocs({ collection: "unknown" })).ok, false);
  assert.equal((await adapter.listTree({ collection: "unknown" })).ok, false);
  assert.equal(calls.length, 0);
});

test("parseQmdLsLine strips qmd URI and keeps spaces in the path", () => {
  const entry = parseQmdLsLine(
    " 1.3 KB  Sep 26 18:07  qmd://runbooks/a-system-overview/examples/Payment API Platform.md",
    "runbooks",
  );
  assert.deepEqual(entry, {
    size: "1.3 KB",
    mtime: "Sep 26 18:07",
    documentPath: "a-system-overview/examples/Payment API Platform.md",
  });
  assert.equal(parseQmdLsStdout(nestedLsStdout(), "runbooks").length, 6);
});

// Captured from `qmd collection list` (no --json / --format json; both are ignored).
const QMD_COLLECTION_LIST_STDOUT = `Collections (2):

pi-memory (qmd://pi-memory/)
  Pattern:  **/*.md
  Files:    578
  Updated:  6m ago

runbooks (qmd://runbooks/)
  Pattern:  **/*.md
  Files:    72
  Updated:  12m ago

`;

// Captured from `qmd collection show runbooks`.
const QMD_COLLECTION_SHOW_STDOUT = `Collection: runbooks
  Path:     /home/user/pi-kit/qmd/collections/Runbooks
  Pattern:  **/*.md
  Include:  yes (default)
`;

const QMD_COLLECTION_SHOW_WITH_UPDATE = `Collection: runbooks
  Path:     /corpus/runbooks
  Pattern:  **/*.md
  Include:  yes (default)
  Update:   git pull origin main
`;

test("parseQmdCollectionListNames accepts real qmd collection list text", () => {
  const got = parseQmdCollectionListNames(QMD_COLLECTION_LIST_STDOUT);
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.deepEqual(got.names, ["pi-memory", "runbooks"]);
});

test("parseQmdCollectionListNames rejects the prior JSON-parse crash input as non-JSON text that is still readable", () => {
  // The startup bug was JSON.parse on this stdout ("Collection...").
  assert.throws(() => JSON.parse(QMD_COLLECTION_LIST_STDOUT));
  const got = parseQmdCollectionListNames(QMD_COLLECTION_LIST_STDOUT);
  assert.equal(got.ok, true);
});

test("parseQmdCollectionShow accepts real qmd collection show text", () => {
  const got = parseQmdCollectionShow(QMD_COLLECTION_SHOW_STDOUT);
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.path, "/home/user/pi-kit/qmd/collections/Runbooks");
  assert.equal(got.updateCommand, "");
});

test("parseQmdCollectionShow reads optional Update command", () => {
  const got = parseQmdCollectionShow(QMD_COLLECTION_SHOW_WITH_UPDATE);
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.path, "/corpus/runbooks");
  assert.equal(got.updateCommand, "git pull origin main");
});

test("createCollectionInspector uses collection show and returns path plus update command", async () => {
  const calls: CallRecord = [];
  const inspect = createCollectionInspector(async (argv) => {
    calls.push(argv);
    return ok(QMD_COLLECTION_SHOW_WITH_UPDATE);
  });
  const got = await inspect("runbooks");
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.deepEqual(calls, [["qmd", "collection", "show", "runbooks"]]);
  assert.equal(got.rootDir, "/corpus/runbooks");
  assert.equal(got.updateCommand, "git pull origin main");
});

test("mergeIndexedWithDisk keeps indexed paths, adds disk entries, and sorts both", () => {
  const merged = mergeIndexedWithDisk(
    [{ size: "1.1 KB", mtime: "Sep 26 18:07", documentPath: "README.md" }],
    walkOf([diskDir("b"), diskDir("a"), diskFile("b/x.yml", 10)]),
  );
  assert.deepEqual([...merged.indexedPaths], ["README.md"]);
  assert.deepEqual(
    merged.files.map((file) => file.documentPath),
    ["README.md", "b/x.yml"],
  );
  assert.deepEqual(merged.dirs, ["a", "b"]);
  assert.equal(merged.truncated, false);
});

test("qmd listings add on-disk files the index does not contain and mark them unindexed", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
    walkCollection: async () =>
      walkOf([
        diskDir("c-ci-cd"),
        diskDir("c-ci-cd/guide"),
        diskFile("c-ci-cd/guide/pipeline.yml", 2048),
      ]),
  });

  const tree = await adapter.listTree({ collection: "runbooks", start: 0, limit: 100 });
  assert.equal(tree.ok, true);
  if (!tree.ok) return;
  assert.match(tree.text, /printed entries 0 through 6 of 7/);
  assert.match(tree.text, /2\.0 KB\s+Sep 26 18:07\s+c-ci-cd\/guide\/pipeline\.yml\s+\[unindexed\]/);
  assert.match(tree.text, /792 B\s+Sep 26 18:07\s+c-ci-cd\/guide\/README\.md\n/);
  assert.equal(/c-ci-cd\/guide\/README\.md\s+\[unindexed\]/.test(tree.text), false);
});

test("qmd listTree returns on-disk files for a directory with no indexed file", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
    walkCollection: async () =>
      walkOf([
        diskDir("stack"),
        diskDir("stack/.deploy"),
        diskDir("stack/.deploy/docker"),
        diskFile("stack/.deploy/docker/Dockerfile", 512),
        diskFile("stack/.deploy/docker/fpm.conf", 300),
      ]),
  });

  const tree = await adapter.listTree({
    collection: "runbooks",
    path: "stack/.deploy/docker",
  });
  assert.equal(tree.ok, true);
  if (!tree.ok) return;
  assert.match(tree.text, /512 B\s+Sep 26 18:07\s+stack\/\.deploy\/docker\/Dockerfile\s+\[unindexed\]/);
  assert.match(tree.text, /300 B\s+Sep 26 18:07\s+stack\/\.deploy\/docker\/fpm\.conf\s+\[unindexed\]/);
});

test("qmd listDocs shows a directory that holds only unindexed files", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
    walkCollection: async () =>
      walkOf([
        diskDir("stack"),
        diskDir("stack/.deploy"),
        diskFile("stack/.deploy/Procfile.web", 40),
      ]),
  });

  const got = await adapter.listDocs({ collection: "runbooks", path: "stack" });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.match(got.text, /^stack\/\.deploy\/$/m);
  assert.equal(got.text.includes("Procfile.web"), false);
});

test("on-disk size and mtime win over the index for a file present in both", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
    walkCollection: async () => walkOf([diskFile("README.md", 1024)]),
  });

  const tree = await adapter.listTree({ collection: "runbooks" });
  assert.equal(tree.ok, true);
  if (!tree.ok) return;
  assert.match(tree.text, /1\.0 KB\s+Sep 26 18:07\s+README\.md/);
  assert.equal(tree.text.includes("1.1 KB"), false);
});

test("an unknown path errors as not found instead of as an empty listing", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
    walkCollection: async () => walkOf([diskFile("README.md", 1024)]),
  });

  for (const method of ["listDocs", "listTree"] as const) {
    const got = await adapter[method]({ collection: "runbooks", path: "does/not/exist" });
    const error = got.ok ? undefined : got.error;
    assert.equal(got.ok, false);
    assert.match(String(error), /path not found under collection runbooks: does\/not\/exist/);
  }
});

test("a failed disk walk degrades to the indexed listing", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
    walkCollection: async () => {
      throw new Error("EACCES: permission denied");
    },
  });

  const tree = await adapter.listTree({ collection: "runbooks" });
  assert.equal(tree.ok, true);
  if (!tree.ok) return;
  assert.match(tree.text, /printed entries 0 through 5 of 6/);
});

test("a truncated disk walk appends a note about the cap", async () => {
  const adapter = makeAdapter({
    runCli: async () => ok(nestedLsStdout()),
    walkCollection: async () => walkOf([diskFile("extra.yml", 10)], true),
  });

  const tree = await adapter.listTree({ collection: "runbooks" });
  assert.equal(tree.ok, true);
  if (!tree.ok) return;
  assert.match(tree.text, new RegExp(`stopped at ${MAX_WALK_ENTRIES} entries`));
});

test("createDefaultDiskWalker recurses, sizes files, and skips .git and symlinks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-walk-"));
  try {
    fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "objects", "blob"), "x");
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "a.yml"), "hello");
    fs.writeFileSync(path.join(root, "README.md"), "hi");
    fs.symlinkSync(path.join(root, "docs"), path.join(root, "docs-link"));
    fs.symlinkSync(path.join(root, "README.md"), path.join(root, "README.link"));

    const walk = await createDefaultDiskWalker()(root);

    assert.deepEqual(
      walk.entries.map((entry) => entry.documentPath),
      ["README.md", "docs", "docs/a.yml"],
    );
    assert.equal(walk.truncated, false);
    const ymlFile = walk.entries.find(
      (entry): entry is Extract<DiskWalkEntry, { kind: "file" }> =>
        entry.kind === "file" && entry.documentPath === "docs/a.yml",
    );
    assert.equal(ymlFile?.documentPath, "docs/a.yml");
    assert.equal(ymlFile?.sizeBytes, 5);
    assert.ok((ymlFile?.mtimeMs ?? 0) > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createDefaultDiskWalker returns an empty walk for an unreadable root", async () => {
  const walk = await createDefaultDiskWalker()("/nonexistent-collection-root");
  assert.deepEqual(walk, { entries: [], truncated: false });
});
