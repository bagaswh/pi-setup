import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachControlPath,
  closeControlMasterSync,
  ensureControlMaster,
  bootstrapInFlight,
  ownerPidFromSocketName,
  resetBootstrapLocks,
  staleSocketAction,
  sweepOrphanMasters,
} from "./mux.ts";
import type { EnabledSshTarget } from "./lib.ts";

function sampleTarget(
  extra: Partial<EnabledSshTarget> = {},
): EnabledSshTarget {
  return {
    enabled: true,
    host: "gpu-box",
    user: "ubuntu",
    identityFile: "/keys/id",
    remoteWorkspace: "/workspace",
    localWorkspace: "/ws",
    strictHostKeyChecking: "accept-new",
    connectTimeout: 10,
    mux: true,
    ...extra,
  };
}

test("staleSocketAction reuses a live master and unlinks a dead socket", () => {
  assert.equal(
    staleSocketAction({ checkExitCode: 0, socketExists: true }),
    "reuse",
  );
  assert.equal(
    staleSocketAction({ checkExitCode: 255, socketExists: true }),
    "unlink",
  );
  assert.equal(
    staleSocketAction({ checkExitCode: 255, socketExists: false }),
    "none",
  );
});

test("attachControlPath is unique per host and skipped when mux is false", () => {
  const a = attachControlPath(sampleTarget(), {
    pid: 11,
    cacheDir: "/tmp/pi-kit-ssh",
  });
  const b = attachControlPath(sampleTarget({ host: "other" }), {
    pid: 11,
    cacheDir: "/tmp/pi-kit-ssh",
  });
  assert.ok(a.controlPath);
  assert.ok(b.controlPath);
  assert.notEqual(a.controlPath, b.controlPath);
  const off = attachControlPath(sampleTarget({ mux: false }), {
    pid: 11,
    cacheDir: "/tmp/pi-kit-ssh",
  });
  assert.equal(off.controlPath, undefined);
});

test("ensureControlMaster unlinks a stale socket, then bootstraps", async () => {
  resetBootstrapLocks();
  const unlinked: string[] = [];
  const exists = new Set(["/tmp/pi-kit-ssh/cm-dead-1"]);
  const target = sampleTarget({
    controlPath: "/tmp/pi-kit-ssh/cm-dead-1",
  });
  const calls: string[][] = [];
  const action = await ensureControlMaster(
    target,
    async (argv) => {
      calls.push(argv);
      if (argv.includes("-O")) {
        return { status: 255, stderr: "Control socket connect failed" };
      }
      return { status: 0, stderr: "" };
    },
    {
      exists: (p) => exists.has(p),
      unlink: (p) => {
        unlinked.push(p);
        exists.delete(p);
      },
      mkdirp: () => {},
    },
  );
  assert.equal(action, "unlink");
  assert.deepEqual(unlinked, ["/tmp/pi-kit-ssh/cm-dead-1"]);
  assert.equal(calls[0]?.includes("-O"), true);
  assert.equal(calls[0]?.includes("check"), true);
  // The stale socket is followed by a master bootstrap.
  assert.equal(calls[1]?.at(-1), "true");
});

test("ensureControlMaster reuses a live master without unlink", async () => {
  resetBootstrapLocks();
  const unlinked: string[] = [];
  const target = sampleTarget({
    controlPath: "/tmp/pi-kit-ssh/cm-live-1",
  });
  const action = await ensureControlMaster(
    target,
    async () => ({ status: 0, stderr: "" }),
    {
      exists: () => true,
      unlink: (p) => unlinked.push(p),
      mkdirp: () => {},
    },
  );
  assert.equal(action, "reuse");
  assert.deepEqual(unlinked, []);
});

test("ensureControlMaster starts the master with one bootstrap connection", async () => {
  resetBootstrapLocks();
  const target = sampleTarget({
    controlPath: "/tmp/pi-kit-ssh/cm-boot-1",
  });
  const calls: string[][] = [];
  const action = await ensureControlMaster(
    target,
    async (argv) => {
      calls.push(argv);
      if (argv.includes("-O")) {
        return { status: 255, stderr: "Control socket connect failed" };
      }
      return { status: 0, stderr: "" };
    },
    { exists: () => false, unlink: () => {}, mkdirp: () => {} },
  );
  // No stale socket existed, so the owner's action is "none".
  assert.equal(action, "none");
  // check, then bootstrap
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.includes("check"));
  assert.equal(calls[1]!.at(-1), "true");
});

test("concurrent ensureControlMaster callers share one bootstrap", async () => {
  resetBootstrapLocks();
  const target = sampleTarget({
    controlPath: "/tmp/pi-kit-ssh/cm-race-1",
  });
  let checkCalls = 0;
  let bootstrapCalls = 0;
  const spawn = async (argv: string[]) => {
    if (argv.includes("-O")) {
      checkCalls++;
      return { status: 255, stderr: "no master yet" };
    }
    bootstrapCalls++;
    await new Promise((r) => setTimeout(r, 10));
    return { status: 0, stderr: "" };
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      ensureControlMaster(target, spawn, {
        exists: () => false,
        unlink: () => {},
        mkdirp: () => {},
      }),
    ),
  );
  // With no pre-existing socket the owner's action is also "none"; the
  // point of this test is that exactly one check and one bootstrap ran.
  assert.deepEqual(results, Array.from({ length: 8 }, () => "none"));
  assert.equal(checkCalls, 1);
  assert.equal(bootstrapCalls, 1);
});

test("ensureControlMaster throws to every waiter when bootstrap fails", async () => {
  resetBootstrapLocks();
  const target = sampleTarget({
    controlPath: "/tmp/pi-kit-ssh/cm-fail-1",
  });
  const spawn = async (argv: string[]) => {
    if (argv.includes("-O")) return { status: 255, stderr: "no master" };
    return { status: 255, stderr: "Permission denied (publickey)." };
  };
  const attempts = Array.from({ length: 4 }, () =>
    ensureControlMaster(target, spawn, {
      exists: () => false,
      unlink: () => {},
      mkdirp: () => {},
    }),
  );
  const results = await Promise.allSettled(attempts);
  for (const r of results) {
    assert.equal(r.status, "rejected");
    if (r.status === "rejected") assert.match(r.reason.message, /Permission denied/);
  }
  // The failed bootstrap is not cached: a later call starts fresh.
  assert.equal(bootstrapInFlight("/tmp/pi-kit-ssh/cm-fail-1"), false);
});

test("closeControlMasterSync runs ssh -O exit then removes the socket", () => {
  const runs: string[][] = [];
  const exists = new Set(["/tmp/sock"]);
  closeControlMasterSync(
    sampleTarget({ controlPath: "/tmp/sock" }),
    {
      exists: (p) => exists.has(p),
      unlink: (p) => exists.delete(p),
      mkdirp: () => {},
    },
    (argv) => {
      runs.push(argv);
      return { status: 0, stderr: "" };
    },
  );
  assert.equal(runs[0]?.includes("-O"), true);
  assert.equal(runs[0]?.includes("exit"), true);
  assert.equal(exists.has("/tmp/sock"), false);
});

test("ownerPidFromSocketName parses cm-<hash>-<pid> and rejects junk", () => {
  assert.equal(
    ownerPidFromSocketName("cm-1bcfbe021623329e-123221"),
    123221,
  );
  assert.equal(ownerPidFromSocketName("/abs/path/cm-abc-42"), 42);
  assert.equal(ownerPidFromSocketName("cm-1bcfbe021623329e"), undefined);
  assert.equal(ownerPidFromSocketName("cm-1bcfbe021623329e-notapid"), undefined);
  assert.equal(ownerPidFromSocketName("other"), undefined);
});

test("sweepOrphanMasters exits and unlinks only sockets of dead owners", () => {
  resetBootstrapLocks();
  const dir = "/tmp/pi-kit-ssh-test-sweep";
  const livePid = process.pid; // this test process is alive
  // Find a pid that does not exist: probe from a high odd number.
  let orphanPid = 4000000;
  while (true) {
    try {
      process.kill(orphanPid, 0);
      orphanPid++;
    } catch {
      break;
    }
  }
  const exists = new Set([
    `${dir}/cm-1bcfbe021623329e-${orphanPid}`,
    `${dir}/cm-1bcfbe021623329e-${livePid}`,
    `${dir}/not-a-socket`,
  ]);
  const runCalls: string[][] = [];
  const unlinked: string[] = [];
  sweepOrphanMasters(
    {
      exists: (p) => exists.has(p),
      unlink: (p) => {
        unlinked.push(p);
        exists.delete(p);
      },
      mkdirp: () => {},
      readdir: () => [
        `cm-1bcfbe021623329e-${orphanPid}`,
        `cm-1bcfbe021623329e-${livePid}`,
        "not-a-socket",
      ],
    },
    {
      cacheDir: dir,
      run: (argv) => {
        runCalls.push(argv);
      },
    },
  );
  // Dead owner: ssh -O exit + unlink. Live owner and non-socket: untouched.
  assert.equal(runCalls.length, 1);
  assert.ok(runCalls[0]!.includes("exit"));
  assert.ok(runCalls[0]!.join(" ").includes(`cm-1bcfbe021623329e-${orphanPid}`));
  assert.deepEqual(unlinked, [`${dir}/cm-1bcfbe021623329e-${orphanPid}`]);
  assert.equal(exists.has(`${dir}/cm-1bcfbe021623329e-${livePid}`), true);
  assert.equal(exists.has(`${dir}/not-a-socket`), true);
});

test("sweepOrphanMasters tolerates a missing cache dir", () => {
  sweepOrphanMasters(
    {
      exists: () => false,
      unlink: () => {},
      mkdirp: () => {},
      readdir: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    },
    { cacheDir: "/tmp/pi-kit-ssh-nonexistent" },
  );
  // No throw is the assertion.
});
