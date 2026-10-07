/**
 * store.ts — thread-id slugs, store-root resolution, and thread paths for
 * durable-workflows (Task 4). Storage lives under
 * `<storeRoot ?? cwd/.pi>/durable-workflows/<threadId>/log.jsonl` (see
 * SPEC-durable-workflows.md "Storage"). Thread ids are filesystem-safe
 * slugs so path traversal can never escape the store directory. Listing
 * is best-effort: per-thread strict validation belongs to the log layer.
 *
 * Note: `THREAD_ID_RE` is duplicated in log.ts (which re-checks the
 * `thread_id` field on entries) by design — the two modules do not import
 * from each other.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Name of the log file whose presence marks a directory as a thread. */
const LOG_FILENAME = "log.jsonl";

export const THREAD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Subdirectory of the store dir holding one directory per thread. */
const WORKFLOWS_DIR = "durable-workflows";

export type SanitizeResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Validate a user-supplied thread id as a filesystem-safe slug. The regex
 * already excludes "." and ".."; the explicit refusal documents that
 * traversal is never acceptable even if the pattern loosens later.
 */
export function sanitizeThreadId(input: string): SanitizeResult {
  if (input === "." || input === "..") {
    return { ok: false, error: `thread id ${JSON.stringify(input)} is not allowed` };
  }
  if (!THREAD_ID_RE.test(input)) {
    return {
      ok: false,
      error: `thread id ${JSON.stringify(input)} must match ^[a-z0-9][a-z0-9-]{0,63}$`,
    };
  }
  return { ok: true, id: input };
}

/**
 * Layering: explicit non-empty `storeRoot` wins; empty string counts as
 * unset; otherwise fall back to `<cwd>/.pi`.
 */
export function resolveStoreDir(
  storeRoot: string | null | undefined,
  cwd: string,
): string {
  if (typeof storeRoot === "string" && storeRoot.length > 0) return storeRoot;
  return join(cwd, ".pi");
}

/**
 * Thread directory for a thread id, defensively re-checked so a caller
 * that bypasses `sanitizeThreadId` still cannot escape the store.
 */
export function threadDir(storeDir: string, threadId: string): string {
  const check = sanitizeThreadId(threadId);
  if (!check.ok) throw new Error(check.error);
  return join(storeDir, WORKFLOWS_DIR, check.id);
}

export type ListThreadsResult = { threads: string[]; warn?: string };

/**
 * List thread ids under `<storeDir>/durable-workflows` that contain a
 * readable `log.jsonl`. Missing parent dir → empty list. A thread whose
 * log is missing or unreadable is skipped and noted in `warn` rather than
 * failing the listing; strict per-thread validation happens later.
 */
export function listThreads(storeDir: string): ListThreadsResult {
  const root = join(storeDir, WORKFLOWS_DIR);
  if (!existsSync(root)) return { threads: [] };

  const warns: string[] = [];
  const threads: string[] = [];

  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      const logPath = join(dir, LOG_FILENAME);
      if (!existsSync(logPath)) continue; // not (yet) a thread dir
      // Probe readability; content validation is log.ts's job.
      readFileSync(logPath);
      if (THREAD_ID_RE.test(name)) threads.push(name);
    } catch {
      warns.push(name); // corrupt/unreadable log
    }
  }

  threads.sort();
  return warns.length > 0 ? { threads, warn: warns.join(", ") } : { threads };
}
