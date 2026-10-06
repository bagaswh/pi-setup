import assert from "node:assert/strict";
import { test } from "node:test";

import { loadKnowledgeBaseConfig, loadLayeredKnowledgeBaseConfig } from "./config.ts";

const configPath = "/repo/.pi/kb.json";

type VirtualFiles = Record<string, string>;

function loadWithVirtualFile(
  files: VirtualFiles,
  lookupQmdCollections: Parameters<typeof loadKnowledgeBaseConfig>[1]["lookupQmdCollections"] = () => ({
    ok: true,
    collections: [{ name: "runbooks", path: "/corpus/runbooks" }],
  }),
  lookupQmdUpdateCommand: Parameters<typeof loadKnowledgeBaseConfig>[1]["lookupQmdUpdateCommand"] = () => ({ ok: true, command: "" }),
) {
  return loadKnowledgeBaseConfig(configPath, {
    existsSync: (path) => path in files,
    readFileSync: (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`missing test file: ${path}`);
      return value;
    },
    lookupQmdCollections,
    lookupQmdUpdateCommand,
  });
}

test("missing .pi/kb.json means no-config and no throw", () => {
  const got = loadWithVirtualFile({});
  assert.deepEqual(got, { kind: "no-config" });
});

test("valid qmd config defaults writable to false", () => {
  const got = loadWithVirtualFile({
    [configPath]: JSON.stringify({
      backend: "qmd",
      qmd: { collections: ["runbooks"] },
    }),
  });
  assert.equal(got.kind, "ready");
  if (got.kind !== "ready") return;
  assert.equal(got.config.backend, "qmd");
  assert.deepEqual(got.config.qmd.collections, ["runbooks"]);
  assert.equal(got.config.writable, false);
  assert.deepEqual(got.qmdCollections, [{ name: "runbooks", path: "/corpus/runbooks" }]);
});

test("unknown key is fatal", () => {
  const got = loadWithVirtualFile({
    [configPath]: JSON.stringify({
      backend: "qmd",
      qmd: { collections: ["runbooks"] },
      typo: true,
    }),
  });
  assert.equal(got.kind, "fatal");
  if (got.kind !== "fatal") return;
  assert.match(got.message, /unknown key/i);
});

test("backend qmd without qmd.collections is fatal", () => {
  const got = loadWithVirtualFile({
    [configPath]: JSON.stringify({
      backend: "qmd",
      qmd: {},
    }),
  });
  assert.equal(got.kind, "fatal");
  if (got.kind !== "fatal") return;
  assert.match(got.message, /qmd\.collections/i);
});

test("backend qmd with empty qmd.collections is fatal", () => {
  const got = loadWithVirtualFile({
    [configPath]: JSON.stringify({
      backend: "qmd",
      qmd: { collections: [] },
    }),
  });
  assert.equal(got.kind, "fatal");
  if (got.kind !== "fatal") return;
  assert.match(got.message, /qmd\.collections/i);
});

test("allowlisted qmd collection missing from qmd collection list is fatal", () => {
  const got = loadWithVirtualFile(
    {
      [configPath]: JSON.stringify({
        backend: "qmd",
        qmd: { collections: ["runbooks", "playbooks"] },
      }),
    },
    () => ({
      ok: true,
      collections: [{ name: "runbooks", path: "/corpus/runbooks" }],
    }),
  );
  assert.equal(got.kind, "fatal");
  if (got.kind !== "fatal") return;
  assert.match(got.message, /allowlisted qmd collection not found/i);
});

test("backend openviking is fatal in this development", () => {
  const got = loadWithVirtualFile({
    [configPath]: JSON.stringify({
      backend: "openviking",
      openviking: {
        baseUrl: "http://127.0.0.1:1933",
        root: "viking://resources/runbooks",
      },
    }),
  });
  assert.equal(got.kind, "fatal");
  if (got.kind !== "fatal") return;
  assert.match(got.message, /openviking/i);
});

test("writable true with non-empty update command is fatal", () => {
  const got = loadWithVirtualFile(
    {
      [configPath]: JSON.stringify({
        backend: "qmd",
        writable: true,
        qmd: { collections: ["runbooks"] },
      }),
    },
    undefined,
    () => ({ ok: true, command: "git pull origin main" }),
  );
  assert.equal(got.kind, "fatal");
  if (got.kind !== "fatal") return;
  assert.match(got.message, /update command/i);
});

test("writable true when update command cannot be read is fatal", () => {
  const got = loadWithVirtualFile(
    {
      [configPath]: JSON.stringify({
        backend: "qmd",
        writable: true,
        qmd: { collections: ["runbooks"] },
      }),
    },
    undefined,
    () => ({ ok: false, error: "qmd collection list failed" }),
  );
  assert.equal(got.kind, "fatal");
  if (got.kind !== "fatal") return;
  assert.match(got.message, /could not be read/i);
});

test("writable true checks every allowlisted collection update command", () => {
  const got = loadWithVirtualFile(
    {
      [configPath]: JSON.stringify({
        backend: "qmd",
        writable: true,
        qmd: { collections: ["runbooks", "playbooks"] },
      }),
    },
    () => ({
      ok: true,
      collections: [
        { name: "runbooks", path: "/corpus/runbooks" },
        { name: "playbooks", path: "/corpus/playbooks" },
      ],
    }),
    (collection) =>
      collection === "playbooks" ? { ok: true, command: "git pull origin main" } : { ok: true, command: "" },
  );
  assert.equal(got.kind, "fatal");
  if (got.kind !== "fatal") return;
  assert.match(got.message, /update command/i);
});

test("project kb.json overrides the global file and resolves a relative root against the project", () => {
  const globalPath = "/home/agent/kb.json";
  const projectPath = "/repo/.pi/kb.json";
  const got = loadLayeredKnowledgeBaseConfig({
    globalPath,
    projectPath,
    globalBase: "/home/agent",
    projectBase: "/repo",
  }, {
    existsSync: (file) => file === globalPath || file === projectPath,
    readFileSync: (file) => file === globalPath
      ? JSON.stringify({ backend: "qmd", qmd: { collections: ["global-col"] }, openviking: { root: "notes" } })
      : JSON.stringify({ backend: "qmd", writable: true, qmd: { collections: ["runbooks"] }, openviking: { root: "local-notes" } }),
    lookupQmdCollections: () => ({ ok: true, collections: [{ name: "runbooks", path: "/corpus/runbooks" }, { name: "global-col", path: "/corpus/global" }] }),
    lookupQmdUpdateCommand: () => ({ ok: true, command: "" }),
  });
  assert.equal(got.kind === "ready" && got.config.writable === true && got.config.qmd.collections.join(",") === "runbooks" && got.config.openviking?.root === "/repo/local-notes", true);
});
