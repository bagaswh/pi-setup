import fs from "node:fs";
import path from "node:path";

export type Backend = "qmd";

export type QmdConfig = {
  collections: string[];
};

export type OpenVikingConfig = {
  baseUrl: string;
  root: string;
};

export type KnowledgeBaseConfig = {
  backend: Backend;
  writable: boolean;
  qmd: QmdConfig;
  openviking?: OpenVikingConfig;
};

export type StartupDecision =
  | { kind: "no-config" }
  | { kind: "fatal"; message: string }
  | { kind: "ready"; config: KnowledgeBaseConfig; qmdCollections: QmdCollectionRecord[] };

export type QmdCollectionRecord = {
  name: string;
  path: string;
};

export type QmdUpdateCommandLookup = (
  collection: string,
) => { ok: true; command: string } | { ok: false; error: string };

export type QmdCollectionListLookup = () =>
  | { ok: true; collections: QmdCollectionRecord[] }
  | { ok: false; error: string };

type LoaderDeps = {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  lookupQmdUpdateCommand?: QmdUpdateCommandLookup;
  lookupQmdCollections?: QmdCollectionListLookup;
};

const defaultDeps: Required<LoaderDeps> = {
  existsSync: fs.existsSync,
  readFileSync: (path, encoding) => fs.readFileSync(path, encoding),
  lookupQmdUpdateCommand: () => ({ ok: true, command: "" }),
  lookupQmdCollections: () => ({ ok: true, collections: [] }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  where: string,
): string | undefined {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      return `kb config fatal: unknown key ${JSON.stringify(key)} in ${where}`;
    }
  }
  return undefined;
}

function parseConfig(raw: unknown): { ok: true; config: KnowledgeBaseConfig } | { ok: false; message: string } {
  if (!isRecord(raw)) {
    return { ok: false, message: "kb config fatal: top-level JSON must be an object" };
  }

  const topKeyError = assertOnlyKeys(raw, ["backend", "writable", "qmd", "openviking"], "top-level");
  if (topKeyError) return { ok: false, message: topKeyError };

  if (raw.backend !== "qmd") {
    if (raw.backend === "openviking") {
      return { ok: false, message: "kb config fatal: backend openviking is not supported in this development" };
    }
    return { ok: false, message: "kb config fatal: backend must be \"qmd\"" };
  }

  if (!isRecord(raw.qmd)) {
    return { ok: false, message: "kb config fatal: qmd object is required for backend qmd" };
  }
  const qmdKeyError = assertOnlyKeys(raw.qmd, ["collections"], "qmd");
  if (qmdKeyError) return { ok: false, message: qmdKeyError };

  if (!Array.isArray(raw.qmd.collections) || raw.qmd.collections.length === 0) {
    return { ok: false, message: "kb config fatal: qmd.collections must be a non-empty string array" };
  }
  for (const [index, value] of raw.qmd.collections.entries()) {
    if (typeof value !== "string" || value.trim() === "") {
      return {
        ok: false,
        message: `kb config fatal: qmd.collections[${index}] must be a non-empty string`,
      };
    }
  }

  if (raw.openviking !== undefined) {
    if (!isRecord(raw.openviking)) {
      return { ok: false, message: "kb config fatal: openviking must be an object when present" };
    }
    const ovKeyError = assertOnlyKeys(raw.openviking, ["baseUrl", "root"], "openviking");
    if (ovKeyError) return { ok: false, message: ovKeyError };
    if (raw.openviking.baseUrl !== undefined && typeof raw.openviking.baseUrl !== "string") {
      return { ok: false, message: "kb config fatal: openviking.baseUrl must be a string when present" };
    }
    if (raw.openviking.root !== undefined && typeof raw.openviking.root !== "string") {
      return { ok: false, message: "kb config fatal: openviking.root must be a string when present" };
    }
  }

  if (raw.writable !== undefined && typeof raw.writable !== "boolean") {
    return { ok: false, message: "kb config fatal: writable must be a boolean when present" };
  }

  return {
    ok: true,
    config: {
      backend: "qmd",
      writable: raw.writable ?? false,
      qmd: {
        collections: raw.qmd.collections,
      },
      openviking: raw.openviking as OpenVikingConfig | undefined,
    },
  };
}

export function loadKnowledgeBaseConfig(
  configPath: string,
  deps: LoaderDeps = {},
): StartupDecision {
  const merged: Required<LoaderDeps> = { ...defaultDeps, ...deps };
  if (!merged.existsSync(configPath)) return { kind: "no-config" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(merged.readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "fatal", message: `kb config fatal: cannot parse JSON at ${configPath}: ${message}` };
  }

  const cfg = parseConfig(parsed);
  if (!cfg.ok) return { kind: "fatal", message: cfg.message };

  const listed = merged.lookupQmdCollections();
  if (!listed.ok) {
    return {
      kind: "fatal",
      message: `kb config fatal: could not read qmd collection list: ${listed.error}`,
    };
  }

  const listedByName = new Map(listed.collections.map((collection) => [collection.name, collection]));
  const allowlistedRecords: QmdCollectionRecord[] = [];
  for (const name of cfg.config.qmd.collections) {
    const record = listedByName.get(name);
    if (!record) {
      return { kind: "fatal", message: `kb config fatal: allowlisted qmd collection not found: ${name}` };
    }
    allowlistedRecords.push(record);
  }

  if (cfg.config.writable) {
    for (const collection of cfg.config.qmd.collections) {
      const lookup = merged.lookupQmdUpdateCommand(collection);
      if (!lookup.ok) {
        return {
          kind: "fatal",
          message: `kb config fatal: writable requires an empty qmd update command, but it could not be read: ${lookup.error}`,
        };
      }
      if (lookup.command.trim() !== "") {
        return { kind: "fatal", message: "kb config fatal: writable requires an empty qmd collection update command" };
      }
    }
  }

  return { kind: "ready", config: cfg.config, qmdCollections: allowlistedRecords };
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (Array.isArray(over) || !isRecord(base) || !isRecord(over)) return over;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) merged[key] = deepMerge(merged[key], value);
  return merged;
}

function resolveConfigPath(value: string, base: string): string {
  if (path.isAbsolute(value) || value.includes("://")) return value;
  return path.resolve(base, value);
}

function withOpenVikingRoot(raw: unknown, base: string): unknown {
  if (!isRecord(raw) || !isRecord(raw.openviking) || typeof raw.openviking.root !== "string") return raw;
  return { ...raw, openviking: { ...raw.openviking, root: resolveConfigPath(raw.openviking.root, base) } };
}

export function loadLayeredKnowledgeBaseConfig(
  paths: { globalPath: string; projectPath: string; globalBase: string; projectBase: string },
  deps: LoaderDeps = {},
): StartupDecision {
  const mergedDeps: Required<LoaderDeps> = { ...defaultDeps, ...deps };
  const read = (file: string, base: string): { ok: true; value: unknown } | StartupDecision | undefined => {
    if (!mergedDeps.existsSync(file)) return undefined;
    try {
      return { ok: true, value: withOpenVikingRoot(JSON.parse(mergedDeps.readFileSync(file, "utf8")), base) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "fatal", message: `kb config fatal: cannot parse JSON at ${file}: ${message}` };
    }
  };
  const globalFile = read(paths.globalPath, paths.globalBase);
  if (globalFile && "kind" in globalFile) return globalFile;
  const projectFile = read(paths.projectPath, paths.projectBase);
  if (projectFile && "kind" in projectFile) return projectFile;
  if (!globalFile && !projectFile) return { kind: "no-config" };
  const merged = globalFile?.ok && projectFile?.ok ? deepMerge(globalFile.value, projectFile.value) : (projectFile?.ok ? projectFile.value : globalFile?.value);
  const virtualPath = paths.projectPath;
  const encoded = JSON.stringify(merged);
  return loadKnowledgeBaseConfig(virtualPath, {
    ...deps,
    existsSync: (file) => file === virtualPath || mergedDeps.existsSync(file),
    readFileSync: (file, encoding) => (file === virtualPath ? encoded : mergedDeps.readFileSync(file, encoding)),
  });
}
