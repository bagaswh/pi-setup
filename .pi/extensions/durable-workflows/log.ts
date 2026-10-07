/**
 * log.ts — entry validation, atomic append, and crash-tolerant read for
 * durable-workflows (Task 2). The log is one JSON object per line in
 * `<thread>/log.jsonl` (see SPEC-durable-workflows.md, "Log format"); the
 * 0-based line number is the entry index used by inspect/fork. Appends are
 * a single fs.appendFileSync of a single line; reads tolerate a corrupt
 * or half-written FINAL line (crash mid-append) but treat a corrupt
 * middle line as a hard error naming its index. Reuses graph.ts for the
 * embedded graph and its hash; no Pi imports.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  hashGraph,
  validateGraph,
  type Graph,
} from "./graph.ts";

export type Launch = { kind: "subagent" | "shell"; ref: string };

export type ThreadMeta = {
  t: "thread_meta";
  v: 1;
  thread_id: string;
  title?: string;
  graph: Graph;
  /** sha256 of the canonical JSON of `graph` (see hashGraph). */
  graph_hash: string;
  ts: string;
};

export type StepStart = {
  t: "step_start";
  node: string;
  launch: Launch;
  ts: string;
};

export type StepResult = {
  t: "step_result";
  node: string;
  status: "ok" | "error";
  origin?: "run" | "rerun";
  output?: unknown;
  artifacts?: string[];
  summary?: string;
  ts: string;
};

export type Interrupt = {
  t: "interrupt";
  question: string;
  options?: string[];
  ts: string;
};

export type Resume = {
  t: "resume";
  answer: string;
  ts: string;
};

export type LogEntry = ThreadMeta | StepStart | StepResult | Interrupt | Resume;

export type ValidateEntryResult =
  | { ok: true; entry: LogEntry }
  | { ok: false; error: string };

export const MAX_ENTRY_BYTES = 64 * 1024;

export const THREAD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ENTRY_TYPES: readonly string[] = [
  "thread_meta",
  "step_start",
  "step_result",
  "interrupt",
  "resume",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Validate an unknown parsed value as a LogEntry; total, no throwing.
 *  Unknown extra fields are allowed (forward compatibility). */
export function validateEntry(obj: unknown): ValidateEntryResult {
  if (!isPlainObject(obj)) {
    return { ok: false, error: "entry must be a JSON object" };
  }
  const { t } = obj;
  if (typeof t !== "string" || !ENTRY_TYPES.includes(t)) {
    return {
      ok: false,
      error: `unknown entry type ${JSON.stringify(t)} (expected one of ${ENTRY_TYPES.join(", ")})`,
    };
  }
  if (!nonEmptyString(obj.ts)) {
    return { ok: false, error: `entry ${t} requires a non-empty ts string` };
  }

  switch (t) {
    case "thread_meta": {
      if (obj.v !== 1) {
        return { ok: false, error: "thread_meta requires v === 1" };
      }
      if (typeof obj.thread_id !== "string" || !THREAD_ID_RE.test(obj.thread_id)) {
        return {
          ok: false,
          error: `thread_meta.thread_id ${JSON.stringify(obj.thread_id)} must match ^[a-z0-9][a-z0-9-]{0,63}$`,
        };
      }
      if (obj.title !== undefined && typeof obj.title !== "string") {
        return { ok: false, error: "thread_meta.title must be a string when present" };
      }
      const graph = validateGraph(obj.graph);
      if (!graph.ok) {
        return { ok: false, error: `thread_meta.graph invalid: ${graph.error}` };
      }
      if (obj.graph_hash !== hashGraph(graph.graph)) {
        return {
          ok: false,
          error: "thread_meta.graph_hash does not match hashGraph(graph)",
        };
      }
      const entry: ThreadMeta = {
        t: "thread_meta",
        v: 1,
        thread_id: obj.thread_id,
        graph: graph.graph,
        graph_hash: obj.graph_hash,
        ts: obj.ts,
      };
      if (obj.title !== undefined) entry.title = obj.title;
      return { ok: true, entry };
    }

    case "step_start": {
      if (!nonEmptyString(obj.node)) {
        return { ok: false, error: "step_start requires a non-empty node string" };
      }
      if (!isPlainObject(obj.launch)) {
        return { ok: false, error: "step_start.launch must be an object" };
      }
      if (obj.launch.kind !== "subagent" && obj.launch.kind !== "shell") {
        return {
          ok: false,
          error: `step_start.launch.kind must be "subagent" or "shell"`,
        };
      }
      if (!nonEmptyString(obj.launch.ref)) {
        return { ok: false, error: "step_start.launch.ref must be a non-empty string" };
      }
      const entry: StepStart = {
        t: "step_start",
        node: obj.node,
        launch: { kind: obj.launch.kind, ref: obj.launch.ref },
        ts: obj.ts,
      };
      return { ok: true, entry };
    }

    case "step_result": {
      if (!nonEmptyString(obj.node)) {
        return { ok: false, error: "step_result requires a non-empty node string" };
      }
      if (obj.status !== "ok" && obj.status !== "error") {
        return { ok: false, error: `step_result.status must be "ok" or "error"` };
      }
      if (obj.origin !== undefined && obj.origin !== "run" && obj.origin !== "rerun") {
        return { ok: false, error: `step_result.origin must be "run" or "rerun" when present` };
      }
      if (obj.artifacts !== undefined && !stringArray(obj.artifacts)) {
        return { ok: false, error: "step_result.artifacts must be an array of strings when present" };
      }
      if (obj.summary !== undefined && typeof obj.summary !== "string") {
        return { ok: false, error: "step_result.summary must be a string when present" };
      }
      // output is unknown: anything JSON-serializable is allowed.
      const entry: StepResult = {
        t: "step_result",
        node: obj.node,
        status: obj.status,
        ts: obj.ts,
      };
      if (obj.origin !== undefined) entry.origin = obj.origin;
      if (obj.output !== undefined) entry.output = obj.output;
      if (obj.artifacts !== undefined) entry.artifacts = obj.artifacts;
      if (obj.summary !== undefined) entry.summary = obj.summary;
      return { ok: true, entry };
    }

    case "interrupt": {
      if (!nonEmptyString(obj.question)) {
        return { ok: false, error: "interrupt requires a non-empty question string" };
      }
      if (obj.options !== undefined && !stringArray(obj.options)) {
        return { ok: false, error: "interrupt.options must be an array of strings when present" };
      }
      const entry: Interrupt = { t: "interrupt", question: obj.question, ts: obj.ts };
      if (obj.options !== undefined) entry.options = obj.options;
      return { ok: true, entry };
    }

    case "resume": {
      if (!nonEmptyString(obj.answer)) {
        return { ok: false, error: "resume requires a non-empty answer string" };
      }
      const entry: Resume = { t: "resume", answer: obj.answer, ts: obj.ts };
      return { ok: true, entry };
    }
  }
}

export type AppendResult = { ok: true } | { ok: false; error: string };

/** Serialize as one canonical-style single line and append atomically
 *  (single appendFileSync). Refuses entries whose serialization exceeds
 *  MAX_ENTRY_BYTES. Creates `dir` (mkdir -p) when absent. */
export function appendEntry(dir: string, entry: LogEntry): AppendResult {
  const line = JSON.stringify(entry) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_ENTRY_BYTES) {
    return { ok: false, error: "entry exceeds 64 KiB cap" };
  }
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), line, "utf8");
  } catch (err) {
    return { ok: false, error: `append failed: ${(err as Error).message}` };
  }
  return { ok: true };
}

export type ReadLogResult =
  | { ok: true; entries: LogEntry[]; truncatedTail: boolean }
  | { ok: false; error: string; index?: number };

/** Read `<dir>/log.jsonl`. Entry index = 0-based line number. A parse or
 *  validation failure on the FINAL (last non-empty) line is tolerated as a
 *  crash-mid-append: stop there, return the prefix, truncatedTail=true. A
 *  parse/validation failure or an empty line at a NON-final index is a
 *  hard error naming the index. Trailing empty segments (the file ends
 *  with "\n") are normal and ignored. A missing file is an empty log. */
export function readLog(dir: string): ReadLogResult {
  const path = join(dir, "log.jsonl");
  if (!existsSync(path)) {
    return { ok: true, entries: [], truncatedTail: false };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `read failed: ${(err as Error).message}` };
  }
  if (raw === "") {
    return { ok: true, entries: [], truncatedTail: false };
  }

  const lines = raw.split("\n");
  // Index of the last non-empty line: trailing empty segments after the
  // final newline are normal; anything at or before it is real content.
  let last = lines.length - 1;
  while (last >= 0 && lines[last] === "") last--;

  const entries: LogEntry[] = [];
  for (let i = 0; i <= last; i++) {
    const line = lines[i];
    if (line === "") {
      return {
        ok: false,
        error: `empty line at index ${i} (log lines must be contiguous)`,
        index: i,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      if (i === last) {
        return { ok: true, entries, truncatedTail: true };
      }
      return {
        ok: false,
        error: `line ${i}: invalid JSON: ${(err as Error).message}`,
        index: i,
      };
    }
    const validated = validateEntry(parsed);
    if (!validated.ok) {
      if (i === last) {
        return { ok: true, entries, truncatedTail: true };
      }
      return {
        ok: false,
        error: `line ${i}: ${validated.error}`,
        index: i,
      };
    }
    entries.push(validated.entry);
  }
  return { ok: true, entries, truncatedTail: false };
}

/** Count of valid entries. Throws on a corrupt log (readLog hard error):
 *  callers that need tolerance should use readLog directly. */
export function entryCount(dir: string): number {
  const result = readLog(dir);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.entries.length;
}

/** Current time as ISO 8601, matching the log's `ts` field format. */
export function nowIso(): string {
  return new Date().toISOString();
}
