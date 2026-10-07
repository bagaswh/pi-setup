/**
 * store.test.ts — slug sanitize, store-root layering, thread paths, and
 * best-effort thread listing for store.ts (Task 4). Temp-dir fixtures;
 * no dependencies on other extension modules.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  listThreads,
  resolveStoreDir,
  sanitizeThreadId,
  threadDir,
} from "./store.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "dw-store-test-"));
}

// ---------- sanitizeThreadId: accept list ----------

test("sanitizeThreadId accepts normal slug ids", () => {
  for (const id of ["a", "0", "fix-loop-1", "research-review-fix", "x9-"]) {
    const res = sanitizeThreadId(id);
    assert.equal(res.ok, true, id);
    if (res.ok) assert.equal(res.id, id);
  }
});

test("sanitizeThreadId accepts the 64-char id boundary", () => {
  const id = "a" + "b".repeat(63); // 64 chars total
  assert.equal(id.length, 64);
  assert.equal(sanitizeThreadId(id).ok, true);
});

// ---------- sanitizeThreadId: reject list ----------

test("sanitizeThreadId rejects malformed ids", () => {
  const rejects = [
    "", // empty
    "a".repeat(65), // too long (65 chars)
    "A", // uppercase
    "a_b", // underscore (allowed for node ids, not thread ids)
    "a.b", // dot
    ".", // traversal
    "..", // traversal
    "-a", // leading dash
    "é", // unicode
  ];
  for (const id of rejects) {
    const res = sanitizeThreadId(id);
    assert.equal(res.ok, false, JSON.stringify(id));
    if (!res.ok) assert.equal(typeof res.error, "string");
  }
});

// ---------- resolveStoreDir layering ----------

test("resolveStoreDir: explicit non-empty storeRoot wins", () => {
  assert.equal(resolveStoreDir("/data/store", "/proj"), "/data/store");
});

test("resolveStoreDir: empty string storeRoot falls back to cwd/.pi", () => {
  assert.equal(resolveStoreDir("", "/proj"), join("/proj", ".pi"));
});

test("resolveStoreDir: null and undefined fall back to cwd/.pi", () => {
  assert.equal(resolveStoreDir(null, "/proj"), join("/proj", ".pi"));
  assert.equal(resolveStoreDir(undefined, "/proj"), join("/proj", ".pi"));
});

// ---------- threadDir ----------

test("threadDir builds <storeDir>/durable-workflows/<threadId>", () => {
  const dir = threadDir("/store", "fix-loop-1");
  assert.equal(dir, join("/store", "durable-workflows", "fix-loop-1"));
});

test("threadDir refuses traversal instead of escaping", () => {
  assert.throws(() => threadDir("/store", "../x"));
  assert.throws(() => threadDir("/store", ".."));
  assert.throws(() => threadDir("/store", "a/b"));
});

// ---------- listThreads ----------

test("listThreads: missing parent dir yields empty list", () => {
  const root = tempDir();
  try {
    assert.deepEqual(listThreads(root), { threads: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listThreads: two valid threads are listed sorted", () => {
  const root = tempDir();
  try {
    for (const id of ["beta", "alpha"]) {
      mkdirSync(join(root, "durable-workflows", id), { recursive: true });
      writeFileSync(join(root, "durable-workflows", id, "log.jsonl"), "");
    }
    const res = listThreads(root);
    assert.deepEqual(res.threads, ["alpha", "beta"]);
    assert.equal(res.warn, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listThreads: dir without log.jsonl is excluded silently", () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, "durable-workflows", "good"), { recursive: true });
    writeFileSync(join(root, "durable-workflows", "good", "log.jsonl"), "");
    mkdirSync(join(root, "durable-workflows", "empty"), { recursive: true });
    const res = listThreads(root);
    assert.deepEqual(res.threads, ["good"]);
    assert.equal(res.warn, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listThreads: corrupt log.jsonl thread is skipped and warned", () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, "durable-workflows", "good"), { recursive: true });
    writeFileSync(join(root, "durable-workflows", "good", "log.jsonl"), "{}\n");
    // A directory named like a thread whose log is unreadable: simulate by
    // making log.jsonl a directory (readFileSync then fails with EISDIR).
    mkdirSync(join(root, "durable-workflows", "bad-log"), { recursive: true });
    mkdirSync(join(root, "durable-workflows", "bad-log", "log.jsonl"));
    const res = listThreads(root);
    assert.deepEqual(res.threads, ["good"]);
    assert.ok(res.warn?.includes("bad-log"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
