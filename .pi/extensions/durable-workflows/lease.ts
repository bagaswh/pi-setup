/**
 * lease.ts — cross-process single-writer lease for durable-workflows
 * (Task 4). Each thread directory is guarded by `<dir>/.lease` holding
 * `{pid, ts}`. Acquisition uses O_EXCL so two `pi` invocations cannot
 * both win; a lease is stolen when its pid is dead or it is older than
 * `LEASE_TTL_MS` (crash residue). The lease file is unparseable → treat
 * as expired. Leases are released at the end of every tool call; see
 * SPEC-durable-workflows.md "Concurrency & failure model".
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const LEASE_FILENAME = ".lease";
export const LEASE_TTL_MS = 60_000;

/** Minimal lease record persisted to disk. */
export type Lease = {
  dir: string;
  file: string;
  pid: number;
  /** ISO 8601 acquisition timestamp. */
  acquired: string;
};

export type AcquireResult =
  | { ok: true }
  | { ok: false; error: string; held?: { pid: number; age: string } };

type LeaseFile = { pid: number; ts: string };

function leaseFile(dir: string): string {
  return join(dir, LEASE_FILENAME);
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM: the process exists but is not ours — treat it as alive.
    return true;
  }
}

function ageString(fromIso: string): string {
  const then = Date.parse(fromIso);
  if (Number.isNaN(then)) return "unknown";
  const ms = Date.now() - then;
  if (ms < 0) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function isExpired(holder: LeaseFile | null, now: number): boolean {
  if (holder === null) return true; // unparseable content
  const then = Date.parse(holder.ts);
  if (Number.isNaN(then)) return true;
  return now - then > LEASE_TTL_MS;
}

/** Create the lease file O_EXCL and write `{pid, ts}` in one write. */
function writeLease(file: string): void {
  const record: LeaseFile = { pid: process.pid, ts: new Date().toISOString() };
  const fd = openSync(file, "wx");
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
}

/** Steal an expired/dead-holder lease: unlink it, then re-take it O_EXCL. */
function stealLease(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Raced with another stealer or released; the O_EXCL open decides.
  }
  writeLease(file);
}

function tryAcquire(dir: string): AcquireResult {
  mkdirSync(dir, { recursive: true });
  const file = leaseFile(dir);

  try {
    writeLease(file); // O_EXCL: fails with EEXIST when held
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      return { ok: false, error: `lease acquire failed: ${String(err)}` };
    }
  }

  // EEXIST: someone holds it. Read the holder to decide steal vs fail.
  let holder: LeaseFile | null = null;
  try {
    holder = JSON.parse(readFileSync(file, "utf8")) as LeaseFile;
    if (typeof holder?.pid !== "number" || typeof holder?.ts !== "string") {
      holder = null;
    }
  } catch {
    holder = null; // unparseable or unreadable → treated as expired
  }

  const now = Date.now();
  const dead = holder !== null && !isLive(holder.pid);
  if (isExpired(holder, now) || dead) {
    stealLease(file);
    return { ok: true };
  }

  return {
    ok: false,
    error: `thread is held by another writer (pid ${holder!.pid})`,
    held: { pid: holder!.pid, age: ageString(holder!.ts) },
  };
}

/** Options for `withLease`; defaults keep the retry budget small. */
export type LeaseOptions = { retries?: number; delayMs?: number };

/**
 * Acquire the lease for `dir` (the thread directory, not the store dir).
 * Retries `retries` times (default 3) with `delayMs` between attempts
 * (default 100ms), then fails with holder info when still contended.
 */
export function acquireLease(dir: string): AcquireResult {
  return tryAcquire(dir);
}

/** Release the lease for `dir`; never throws on ENOENT. */
export function releaseLease(dir: string): void {
  try {
    unlinkSync(leaseFile(dir));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

/**
 * Run `fn` while holding the lease: acquire (with retries), always
 * release — including on thrown errors — and propagate fn's result or
 * error. This is the form tool.ts wraps every action with.
 */
export async function withLease<T>(
  dir: string,
  fn: () => Promise<T>,
  options?: LeaseOptions,
): Promise<T> {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 100;

  let last: AcquireResult = { ok: false, error: "lease not attempted" };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    last = tryAcquire(dir);
    if (last.ok) break;
  }
  if (!last.ok) {
    throw new Error(
      last.held
        ? `${last.error}; held by pid ${last.held.pid} (age ${last.held.age})`
        : last.error,
    );
  }

  try {
    return await fn();
  } finally {
    releaseLease(dir);
  }
}
