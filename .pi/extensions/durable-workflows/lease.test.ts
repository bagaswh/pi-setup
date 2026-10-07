/**
 * lease.test.ts — acquire/steal/release and withLease semantics for
 * lease.ts (Task 4). Temp-dir fixtures; dead pid simulated with a child
 * process that has already exited.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  acquireLease,
  LEASE_FILENAME,
  LEASE_TTL_MS,
  releaseLease,
  withLease,
} from "./lease.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "dw-lease-test-"));
}

function leasePath(dir: string): string {
  return join(dir, LEASE_FILENAME);
}

/** A pid that cannot exist: a short-lived child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid;
  assert.equal(child.status, 0);
  assert.ok(Number.isInteger(pid) && pid > 0);
  return pid;
}

// ---------- happy path ----------

test("acquireLease on a fresh dir succeeds and writes JSON {pid, ts}", () => {
  const dir = tempDir();
  try {
    const res = acquireLease(dir);
    assert.deepEqual(res, { ok: true });
    assert.ok(existsSync(leasePath(dir)));
    const raw = JSON.parse(readFileSync(leasePath(dir), "utf8")) as {
      pid: number;
      ts: string;
    };
    assert.equal(raw.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(raw.ts)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- contention ----------

test("second acquire while held by the same live pid fails with held info", () => {
  const dir = tempDir();
  try {
    assert.ok(acquireLease(dir).ok);
    const second = acquireLease(dir);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.ok(second.held, "held info present");
      assert.equal(second.held.pid, process.pid);
      assert.ok(typeof second.held.age === "string");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after releaseLease, re-acquire succeeds", () => {
  const dir = tempDir();
  try {
    assert.ok(acquireLease(dir).ok);
    releaseLease(dir);
    assert.ok(!existsSync(leasePath(dir)));
    assert.ok(acquireLease(dir).ok);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- steal: dead pid ----------

test("lease held by a dead pid is stolen", () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      leasePath(dir),
      JSON.stringify({ pid: deadPid(), ts: new Date().toISOString() }),
    );
    const res = acquireLease(dir);
    assert.deepEqual(res, { ok: true });
    const raw = JSON.parse(readFileSync(leasePath(dir), "utf8")) as {
      pid: number;
    };
    assert.equal(raw.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- steal: TTL expiry ----------

test("lease older than LEASE_TTL_MS is stolen even with a live holder", () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      leasePath(dir),
      JSON.stringify({
        pid: process.pid, // our own pid is definitely live
        ts: new Date(Date.now() - 120_000).toISOString(), // 2 min > 60s TTL
      }),
    );
    assert.equal(LEASE_TTL_MS, 60_000);
    const res = acquireLease(dir);
    assert.deepEqual(res, { ok: true });
    const raw = JSON.parse(readFileSync(leasePath(dir), "utf8")) as { ts: string };
    assert.ok(Date.now() - Date.parse(raw.ts) < 10_000, "lease rewritten fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lease within TTL with a live pid is NOT stolen", () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      leasePath(dir),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    const res = acquireLease(dir);
    assert.equal(res.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- steal: unparseable ----------

test("unparseable lease file is treated as expired and stolen", () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(leasePath(dir), "<<<garbage not json>>>");
    const res = acquireLease(dir);
    assert.deepEqual(res, { ok: true });
    const raw = JSON.parse(readFileSync(leasePath(dir), "utf8")) as {
      pid: number;
    };
    assert.equal(raw.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- withLease ----------

test("withLease: fn runs under the lease and releases afterwards", async () => {
  const dir = tempDir();
  try {
    const value = await withLease(dir, async () => 42, { retries: 1, delayMs: 1 });
    assert.equal(value, 42);
    assert.ok(!existsSync(leasePath(dir)), "lease released after fn returns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLease: fn throwing releases the lease and propagates the error", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      withLease(dir, async () => {
        throw new Error("boom");
      }, { retries: 1, delayMs: 1 }),
      /boom/,
    );
    assert.ok(!existsSync(leasePath(dir)), "lease released after throw");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLease: contended lease fails after exhausting retries", async () => {
  const dir = tempDir();
  try {
    assert.ok(acquireLease(dir).ok); // manual hold by this same live pid
    await assert.rejects(
      withLease(dir, async () => "never", { retries: 1, delayMs: 1 }),
      /held by another writer/,
    );
    // The manual lease must still be present (withLease never released it).
    assert.ok(existsSync(leasePath(dir)));
  } finally {
    releaseLease(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLease: sequential acquisitions work (no leftover lease)", async () => {
  const dir = tempDir();
  try {
    for (let i = 0; i < 3; i++) {
      await withLease(dir, async () => i, { retries: 1, delayMs: 1 });
    }
    assert.ok(!existsSync(leasePath(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
