/**
 * On session start, copy the skills this process loaded (`--skill`) onto
 * the SSH host at `$HOME/.pi/skills/<name>/`. The whole skill directory
 * goes across, companion scripts included. The remote directory is replaced
 * each time so it matches this session's loaded set.
 *
 * Workspace files are not copied. Only these skill directories are.
 */

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { buildSshArgv, type EnabledSshTarget } from "./lib.ts";
import { ensureControlMaster } from "./mux.ts";

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SkillDir = {
  name: string;
  dir: string;
};

export interface Spawned {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "error", listener: (err: Error) => void): void;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export type SkillSyncSpawn = (
  command: string,
  args: string[],
  opts: { stdio: readonly ["ignore" | "pipe", "pipe", "pipe"] },
) => Spawned;

/**
 * Remote bash body. `$HOME` expands on the SSH host, not here.
 * Replaces `$HOME/.pi/skills` with the archive contents.
 */
export function remoteSkillSyncCommand(): string {
  return [
    "set -euo pipefail",
    'if [ -z "${HOME:-}" ]; then echo "ssh: remote HOME is empty" >&2; exit 1; fi',
    'dest="$HOME/.pi/skills"',
    'rm -rf -- "$dest"',
    'mkdir -p -- "$dest"',
    'tar -xzf - -C "$dest"',
  ].join("\n");
}

export function skillTarArgs(stage: string): string[] {
  return ["-C", stage, "-chzf", "-", "."];
}

/**
 * Skill directories pi loaded from `--skill`, the same flag Aide passes.
 * A directory with SKILL.md is one skill. A directory without one is a
 * catalog: each nested directory that has SKILL.md is a skill. A markdown
 * file argument uses its parent directory so companion files travel with it.
 */
export function skillDirsFromArgv(argv: string[], cwd: string): SkillDir[] {
  const raw: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skill" && i + 1 < argv.length) {
      raw.push(argv[++i]!);
    }
  }
  const byName = new Map<string, string>();
  const out: SkillDir[] = [];
  for (const spec of raw) {
    for (const dir of resolveSkillDirs(spec, cwd)) {
      const name = catalogRelativeSkill(dir);
      const segments = name.split("/");
      if (segments.some((segment) => !SAFE_SKILL_NAME.test(segment))) {
        throw new Error(
          `ssh: skill path ${JSON.stringify(name)} cannot be copied to ~/.pi/skills (${dir})`,
        );
      }
      const prev = byName.get(name);
      if (prev !== undefined && prev !== dir) {
        throw new Error(
          `ssh: two loaded skills are at ${JSON.stringify(name)}: ${prev} and ${dir}`,
        );
      }
      if (prev === dir) continue;
      byName.set(name, dir);
      out.push({ name, dir });
    }
  }
  return out;
}

function catalogRelativeSkill(dir: string): string {
  const abs = path.resolve(dir);
  const markers = [
    `${path.sep}.pi${path.sep}skills${path.sep}`,
    `${path.sep}.agents${path.sep}skills${path.sep}`,
  ];
  for (const marker of markers) {
    const at = abs.indexOf(marker);
    if (at === -1) continue;
    return abs.slice(at + marker.length).split(path.sep).join("/");
  }
  return path.basename(abs);
}

function resolveSkillDirs(spec: string, cwd: string): string[] {
  const abs = path.resolve(cwd, spec);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error(`ssh: skill path does not exist: ${abs}`);
  }
  if (st.isDirectory()) {
    if (fs.existsSync(path.join(abs, "SKILL.md"))) return [abs];
    return findSkillRoots(abs);
  }
  if (st.isFile() && abs.endsWith(".md")) return [path.dirname(abs)];
  throw new Error(`ssh: skill path is not a skill directory or markdown file: ${abs}`);
}

function findSkillRoots(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      if (fs.existsSync(path.join(child, "SKILL.md"))) found.push(child);
      else walk(child);
    }
  };
  walk(root);
  return found;
}

function waitClose(child: Spawned): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function collect(stream: Readable | null): { text: () => string } {
  const chunks: Buffer[] = [];
  stream?.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.from(chunk));
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * Stream a tar of the skill directories to `$HOME/.pi/skills` on the SSH host.
 * No-op when `skills` is empty — the remote directory is left alone.
 */
export async function syncSkillsToRemoteHome(
  target: EnabledSshTarget,
  skills: SkillDir[],
  spawn: SkillSyncSpawn = nodeSpawn as unknown as SkillSyncSpawn,
): Promise<void> {
  if (skills.length === 0) return;

  await ensureControlMaster(target, async (ctlArgv) => {
    const child = spawn(ctlArgv[0]!, ctlArgv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = collect(child.stderr);
    const code = await waitClose(child);
    return { status: code, stderr: stderr.text() };
  });

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-skills-"));
  try {
    for (const skill of skills) {
      const link = path.join(stage, skill.name);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(skill.dir, link);
    }
    const tar = spawn("tar", skillTarArgs(stage), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sshArgv = buildSshArgv(target, remoteSkillSyncCommand());
    const ssh = spawn(sshArgv[0]!, sshArgv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!tar.stdout || !ssh.stdin) {
      throw new Error("ssh: skill copy could not open the tar pipe");
    }
    const tarErr = collect(tar.stderr);
    const sshErr = collect(ssh.stderr);
    const tarDone = waitClose(tar);
    const sshDone = waitClose(ssh);
    tar.stdout.pipe(ssh.stdin);
    const tarCode = await tarDone;
    const sshCode = await sshDone;
    if (tarCode !== 0) {
      throw new Error(
        `ssh: tar of loaded skills failed (exit ${tarCode}): ${tarErr.text() || "no stderr"}`,
      );
    }
    if (sshCode !== 0) {
      throw new Error(
        `ssh: copy to ~/.pi/skills failed (exit ${sshCode}): ${sshErr.text() || "no stderr"}`,
      );
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
