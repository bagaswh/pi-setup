import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { spawn } from "node:child_process";

import type { EnabledSshTarget } from "./lib.ts";
import {
  remoteSkillSyncCommand,
  skillDirsFromArgv,
  skillTarArgs,
  syncSkillsToRemoteHome,
  type Spawned,
} from "./sync-skills.ts";

const target: EnabledSshTarget = {
  enabled: true,
  host: "gpu-box",
  user: "ubuntu",
  identityFile: "/keys/id_ed25519",
  remoteWorkspace: "/workspace",
  localWorkspace: "/repo/workspace",
  strictHostKeyChecking: "accept-new",
  connectTimeout: 10,
  mux: false,
};

function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: d\n---\n\nbody\n`,
  );
  fs.writeFileSync(path.join(dir, "scripts", "run.py"), "print(1)\n");
}

test("skillDirsFromArgv reads --skill directories and markdown parents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-skill-argv-"));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "catalog", "beta");
  writeSkill(alpha, "alpha");
  writeSkill(beta, "beta");
  try {
    const fromDir = skillDirsFromArgv(
      ["pi", "--skill", "alpha", "--skill", path.join(alpha, "SKILL.md")],
      root,
    );
    assert.deepEqual(fromDir, [{ name: "alpha", dir: alpha }]);

    const fromCatalog = skillDirsFromArgv(
      ["pi", "--skill", "catalog"],
      root,
    );
    assert.deepEqual(fromCatalog, [{ name: "beta", dir: beta }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skillDirsFromArgv keeps the catalog-relative path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-skill-rel-"));
  const skill = path.join(root, ".pi", "skills", "a", "b", "alpha");
  writeSkill(skill, "alpha");
  try {
    const dirs = skillDirsFromArgv(["pi", "--skill", skill], root);
    assert.deepEqual(dirs, [{ name: "a/b/alpha", dir: skill }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skillDirsFromArgv rejects a duplicated name and a missing path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-skill-argv-"));
  const a = path.join(root, "a", "same");
  const b = path.join(root, "b", "same");
  writeSkill(a, "same");
  writeSkill(b, "same");
  try {
    assert.throws(
      () => skillDirsFromArgv(["pi", "--skill", a, "--skill", b], root),
      /two loaded skills are at "same"/,
    );
    assert.throws(
      () => skillDirsFromArgv(["pi", "--skill", "missing"], root),
      /does not exist/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("remote skill sync replaces $HOME/.pi/skills from a tar on stdin", () => {
  const cmd = remoteSkillSyncCommand();
  assert.match(cmd, /dest="\$HOME\/\.pi\/skills"/);
  assert.match(cmd, /rm -rf -- "\$dest"/);
  assert.match(cmd, /tar -xzf - -C "\$dest"/);
  assert.match(cmd, /remote HOME is empty/);
});

test("tar of the stage follows symlinks into each skill directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-skill-tar-"));
  const skill = path.join(root, "real", "alpha");
  writeSkill(skill, "alpha");
  const stage = path.join(root, "stage");
  fs.mkdirSync(stage);
  fs.symlinkSync(skill, path.join(stage, "alpha"));
  try {
    const tar = spawn("tar", skillTarArgs(stage), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    tar.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    const code = await new Promise<number>((resolve, reject) => {
      tar.on("error", reject);
      tar.on("close", (c) => resolve(c ?? 1));
    });
    assert.equal(code, 0);
    const listed = spawn("tar", ["-tzf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const names: Buffer[] = [];
    listed.stdout?.on("data", (chunk: Buffer) => names.push(chunk));
    listed.stdin?.end(Buffer.concat(stdout));
    const listCode = await new Promise<number>((resolve, reject) => {
      listed.on("error", reject);
      listed.on("close", (c) => resolve(c ?? 1));
    });
    assert.equal(listCode, 0);
    const text = Buffer.concat(names).toString("utf8");
    assert.match(text, /alpha\/SKILL\.md/);
    assert.match(text, /alpha\/scripts\/run\.py/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("syncSkillsToRemoteHome pipes the tar into ssh and leaves an empty list alone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-skill-sync-"));
  const alpha = path.join(root, "alpha");
  writeSkill(alpha, "alpha");
  const calls: string[][] = [];
  let stdinBytes = Buffer.alloc(0);

  const spawn: (
    command: string,
    args: string[],
    opts: { stdio: readonly ["ignore" | "pipe", "pipe", "pipe"] },
  ) => Spawned = (command, args) => {
    calls.push([command, ...args]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const ee = new EventEmitter();
    if (command === "tar") {
      const stage = args[args.indexOf("-C") + 1]!;
      assert.deepEqual(fs.readdirSync(stage), ["alpha"]);
      assert.equal(fs.realpathSync(path.join(stage, "alpha")), alpha);
      queueMicrotask(() => {
        stdout.end(Buffer.from("tar-bytes"));
        stderr.end();
        ee.emit("close", 0, null);
      });
    } else {
      stdin.on("data", (chunk: Buffer) => {
        stdinBytes = Buffer.concat([stdinBytes, chunk]);
      });
      stderr.end();
      stdout.end();
      stdin.on("end", () => ee.emit("close", 0, null));
    }
    return Object.assign(ee, { stdin, stdout, stderr }) as Spawned;
  };

  try {
    await syncSkillsToRemoteHome(target, [], spawn);
    assert.equal(calls.length, 0);

    await syncSkillsToRemoteHome(
      target,
      [{ name: "alpha", dir: alpha }],
      spawn,
    );
    const ssh = calls.find((argv) => argv[0] === "ssh");
    assert.ok(ssh);
    assert.match(ssh!.at(-1) ?? "", /bash -lc /);
    assert.match(ssh!.at(-1) ?? "", /HOME\/\.pi\/skills/);
    assert.equal(stdinBytes.toString("utf8"), "tar-bytes");
    assert.ok(calls.some((argv) => argv[0] === "tar" && argv.includes("-chzf")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
