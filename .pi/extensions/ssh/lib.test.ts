import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  allowLocalToolFallback,
  buildMuxCtlArgv,
  buildRemoteScript,
  buildSshArgv,
  classifySshFailure,
  controlSocketPath,
  DEFAULT_IDENTITY_CANDIDATES,
  expandHome,
  formatSpawnError,
  formatTransportError,
  muxExecArgs,
  quoteShell,
  repoRootFromSshExtensionDir,
  shouldRegisterSsh,
  resolveIdentityFile,
  resolveSshConfigFile,
  resolveSshTarget,
  isRemoteSkillCatalogPath,
  remoteSkillCatalogRejectError,
  remoteToolPath,
  resolveToolPath,
  sanitizeRemoteEnv,
  sshAuthArgs,
  sshDestination,
  sshFailMarker,
  sshIntended,
  sshJsonPath,
  sshRefuseLocalError,
  sshRuntimeMarker,
  sshWasRequested,
  toRemotePath,
  type EnabledSshTarget,
} from "./lib.ts";

function sampleTarget(
  extra: Partial<EnabledSshTarget> = {},
): EnabledSshTarget {
  return {
    enabled: true,
    host: "box",
    user: "ubuntu",
    identityFile: "/home/me/.ssh/id_ed25519",
    remoteWorkspace: "/workspace",
    localWorkspace: "/repo/workspace",
    strictHostKeyChecking: "accept-new",
    connectTimeout: 10,
    mux: true,
    ...extra,
  };
}

test("quoteShell wraps single quotes for posix sh", () => {
  assert.equal(quoteShell("hello"), "'hello'");
  assert.equal(quoteShell("it's"), "'it'\\''s'");
});

test("expandHome resolves tilde paths against the given home", () => {
  assert.equal(expandHome("~", "/home/me"), "/home/me");
  assert.equal(
    expandHome("~/.ssh/id_ed25519", "/home/me"),
    path.join("/home/me", ".ssh", "id_ed25519"),
  );
  assert.equal(expandHome("/abs/key", "/home/me"), "/abs/key");
});

test("toRemotePath maps workspace-relative files onto the remote root", () => {
  assert.equal(
    toRemotePath("/repo/workspace", "/workspace", "/repo/workspace"),
    "/workspace",
  );
  assert.equal(
    toRemotePath("/repo/workspace", "/workspace", "/repo/workspace/src/a.ts"),
    "/workspace/src/a.ts",
  );
  assert.equal(
    toRemotePath("/repo/workspace", "/home/ubuntu/work", "notes.md"),
    "/home/ubuntu/work/notes.md",
  );
});

test("remoteToolPath maps local form and passes remote form through", () => {
  const localWs = "/repo/workspace";
  const remoteWs = "/workspace";
  // Local form: absolute inside the workspace, or workspace-relative.
  assert.equal(
    remoteToolPath(localWs, remoteWs, "/repo/workspace/src/a.ts"),
    "/workspace/src/a.ts",
  );
  assert.equal(remoteToolPath(localWs, remoteWs, "src/a.ts"), "/workspace/src/a.ts");
  // Remote form: the absolute paths the system prompt advertises.
  assert.equal(remoteToolPath(localWs, remoteWs, "/workspace/src/a.ts"), "/workspace/src/a.ts");
  assert.equal(remoteToolPath(localWs, remoteWs, "/etc/os-release"), "/etc/os-release");
  // Unsafe paths keep the escape error and name the path.
  assert.throws(
    () => remoteToolPath(localWs, remoteWs, "../../../etc/passwd"),
    /path escapes workspace/,
  );
  assert.throws(
    () => remoteToolPath(localWs, remoteWs, "/a/../b"),
    /path escapes workspace/,
  );
});

test("resolveToolPath joins a relative argument onto the last bash cwd", () => {
  assert.equal(
    resolveToolPath("notes.txt", "/workspace/docs/handoffs", "/workspace"),
    "/workspace/docs/handoffs/notes.txt",
  );
  // No bash yet in this session: the remote workspace root is the base.
  assert.equal(resolveToolPath("notes.txt", undefined, "/workspace"), "/workspace/notes.txt");
  // bash may cd outside the workspace; the file tools follow it, like bash.
  assert.equal(resolveToolPath("hosts", "/etc", "/workspace"), "/etc/hosts");
  // Traversal resolves like a shell, then the result is the remote path.
  assert.equal(
    resolveToolPath("../notes.txt", "/workspace/docs", "/workspace"),
    "/workspace/notes.txt",
  );
  // Absolute and ~ arguments are left for the ops layer / pi.
  assert.equal(resolveToolPath("/workspace/a.md", "/etc", "/workspace"), "/workspace/a.md");
  assert.equal(resolveToolPath("~/a.md", "/etc", "/workspace"), "~/a.md");
  // No cwd and a relative argument always resolve somewhere real.
  assert.equal(resolveToolPath("a/b.md", undefined, "/workspace"), "/workspace/a/b.md");
});

test("resolveToolPath + remoteToolPath agree on the remote path", () => {
  const localWs = "/repo/workspace";
  const remoteWs = "/workspace";
  const forwarded = resolveToolPath("notes.txt", "/workspace/docs/handoffs", remoteWs);
  assert.equal(remoteToolPath(localWs, remoteWs, forwarded), "/workspace/docs/handoffs/notes.txt");
  // A local absolute path still maps through the workspace.
  const localAbs = "/repo/workspace/src/a.ts";
  assert.equal(
    resolveToolPath(localAbs, "/workspace/docs", remoteWs),
    localAbs,
  );
  assert.equal(remoteToolPath(localWs, remoteWs, localAbs), "/workspace/src/a.ts");
});

test("toRemotePath does not turn ./workspace cwd into /workspace/workspace", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-ws-map-"));
  const localWs = path.join(repo, "workspace");
  fs.mkdirSync(localWs);
  const prev = process.cwd();
  try {
    process.chdir(repo);
    assert.equal(toRemotePath(localWs, "/workspace", "./workspace"), "/workspace");
    assert.equal(toRemotePath(localWs, "/workspace", "workspace"), "/workspace");
    assert.equal(toRemotePath(localWs, "/workspace", localWs), "/workspace");
    assert.equal(
      toRemotePath(localWs, "/workspace", path.join(localWs, "src")),
      "/workspace/src",
    );
  } finally {
    process.chdir(prev);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("toRemotePath rejects paths that leave the local workspace", () => {
  assert.throws(
    () => toRemotePath("/repo/workspace", "/workspace", "/etc/passwd"),
    /escapes workspace/,
  );
  assert.throws(
    () =>
      toRemotePath(
        "/repo/workspace",
        "/workspace",
        "/repo/workspace/../.pi/ssh.json",
      ),
    /escapes workspace/,
  );
});

test("resolveSshTarget stays disabled without enable flag or json enabled", () => {
  const t = resolveSshTarget(
    { host: "box" },
    {},
    { defaultLocalWorkspace: "/repo/workspace" },
  );
  assert.deepEqual(t, { enabled: false });
});

test("resolveSshTarget requires an explicit host when enabled", () => {
  assert.throws(
    () =>
      resolveSshTarget(
        { enabled: true },
        {},
        { defaultLocalWorkspace: "/repo/workspace" },
      ),
    /host is empty|No auto-discovery/,
  );
  assert.throws(
    () =>
      resolveSshTarget(
        {},
        { PI_AIDE_SSH: "1" },
        { defaultLocalWorkspace: "/repo/workspace" },
      ),
    /host is empty|No auto-discovery/,
  );
});

test("PI_AIDE_SSH=0 disables even when json enabled is true", () => {
  const t = resolveSshTarget(
    { enabled: true, host: "box", identityFile: "/keys/id" },
    { PI_AIDE_SSH: "0" },
    {
      defaultLocalWorkspace: "/repo/workspace",
      identityExists: () => true,
    },
  );
  assert.deepEqual(t, { enabled: false });
});

test("resolveSshTarget reads host user port identity and workspace mapping", () => {
  const t = resolveSshTarget(
    {
      enabled: true,
      host: "gpu-box",
      user: "ubuntu",
      port: 2222,
      identityFile: "~/.ssh/id_ed25519",
      remoteWorkspace: "~/workspace",
    },
    {},
    {
      defaultLocalWorkspace: "/repo/workspace",
      homeDir: "/home/me",
      identityExists: (file) => file === "/home/me/.ssh/id_ed25519",
    },
  );
  assert.equal(t.enabled, true);
  if (!t.enabled) return;
  assert.equal(t.host, "gpu-box");
  assert.equal(t.user, "ubuntu");
  assert.equal(t.port, 2222);
  assert.equal(t.identityFile, "/home/me/.ssh/id_ed25519");
  assert.equal(t.remoteWorkspace, "/home/ubuntu/workspace");
  assert.equal(t.localWorkspace, "/repo/workspace");
  assert.equal(t.strictHostKeyChecking, "accept-new");
  assert.equal(t.connectTimeout, 10);
  assert.equal(t.mux, true);
});

test("env host and identity override json", () => {
  const t = resolveSshTarget(
    { enabled: true, host: "json-box", identityFile: "/keys/json" },
    {
      PI_AIDE_SSH_HOST: "env-box",
      PI_AIDE_SSH_USER: "bagas",
      PI_AIDE_SSH_PORT: "2201",
      PI_AIDE_SSH_IDENTITY_FILE: "/keys/env",
    },
    {
      defaultLocalWorkspace: "/ws",
      identityExists: (file) => file === "/keys/env",
    },
  );
  assert.equal(t.enabled, true);
  if (!t.enabled) return;
  assert.equal(t.host, "env-box");
  assert.equal(t.user, "bagas");
  assert.equal(t.port, 2201);
  assert.equal(t.identityFile, "/keys/env");
});

test("resolveIdentityFile uses config path then default ~/.ssh keys", () => {
  assert.equal(
    resolveIdentityFile("~/.ssh/id_ed25519", {
      homeDir: "/home/me",
      identityExists: (f) => f === "/home/me/.ssh/id_ed25519",
    }),
    "/home/me/.ssh/id_ed25519",
  );
  assert.equal(
    resolveIdentityFile(undefined, {
      homeDir: "/home/me",
      identityExists: (f) => f === "/home/me/.ssh/id_rsa",
    }),
    "/home/me/.ssh/id_rsa",
  );
  assert.throws(
    () =>
      resolveIdentityFile(undefined, {
        homeDir: "/home/me",
        identityExists: () => false,
      }),
    /identityFile/,
  );
});

test("sshAuthArgs is key-only BatchMode with no password prompts", () => {
  const args = sshAuthArgs(sampleTarget({ port: 2222 }));
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("PasswordAuthentication=no"));
  assert.ok(args.includes("KbdInteractiveAuthentication=no"));
  assert.ok(args.includes("PreferredAuthentications=publickey"));
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.ok(args.includes("StrictHostKeyChecking=accept-new"));
  assert.ok(args.includes("ConnectTimeout=10"));
  assert.equal(args[args.indexOf("-p") + 1], "2222");
  assert.equal(args[args.indexOf("-i") + 1], "/home/me/.ssh/id_ed25519");
  assert.ok(!args.includes("PasswordAuthentication=yes"));
  assert.ok(!args.includes("StrictHostKeyChecking=ask"));
});

test("buildSshArgv quotes the remote script as one ssh argument", () => {
  const script = "cd -- '/workspace' && echo hi";
  const argv = buildSshArgv(
    sampleTarget({
      host: "gpu-box",
      identityFile: "/keys/id",
      localWorkspace: "/ws",
    }),
    script,
  );
  assert.equal(argv[0], "ssh");
  assert.equal(sshDestination({ host: "gpu-box", user: "ubuntu" }), "ubuntu@gpu-box");
  assert.ok(argv.includes("ubuntu@gpu-box"));
  const destIdx = argv.indexOf("ubuntu@gpu-box");
  const remote = argv.slice(destIdx + 1);
  assert.equal(remote.length, 1);
  assert.equal(remote[0], `bash -lc ${quoteShell(script)}`);
  assert.notEqual(argv.at(-2), "-lc");
});

test("ssh argv join of sh -lc SCRIPT must not become a bare set dump", () => {
  const script = buildRemoteScript({
    argv: ["/usr/bin/printf", "only\n"],
  });
  assert.match(script, /^set -eu\n/);
  const argv = buildSshArgv(
    sampleTarget({ host: "box", identityFile: "/keys/id" }),
    script,
  );
  const destIdx = argv.indexOf("ubuntu@box");
  const joined = argv.slice(destIdx + 1).join(" ");
  assert.doesNotMatch(joined, /^bash -lc set\b/);
  assert.doesNotMatch(joined, /^sh -lc set\b/);
  assert.equal(joined, `bash -lc ${quoteShell(script)}`);

  const leakEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LEAK_MARKER: "test-leak-secret-value",
  };
  // OpenSSH joins extra argv with spaces. `sh -c set -eu` is a bare `set`.
  const splitLeak = spawnSync("bash", ["-c", `sh -c ${script}`], {
    encoding: "utf8",
    env: leakEnv,
  });
  assert.match(splitLeak.stdout, /LEAK_MARKER=/);
  assert.match(splitLeak.stdout, /test-leak-secret-value/);

  const quoted = spawnSync("bash", ["-c", `sh -c ${quoteShell(script)}`], {
    encoding: "utf8",
    env: leakEnv,
  });
  assert.equal(quoted.status, 0, quoted.stderr);
  assert.equal(quoted.stdout, "only\n");
  assert.doesNotMatch(quoted.stdout, /LEAK_MARKER|test-leak-secret-value|OPTIND=/);
});

test("sanitizeRemoteEnv drops host identity and shell-state keys", () => {
  const env = sanitizeRemoteEnv({
    PATH: "/usr/bin",
    FOO: "keep-me",
    HOME: "/home/host",
    USER: "host",
    LOGNAME: "host",
    SHELL: "/bin/zsh",
    // The host PWD/OLDPWD leak made `cd -` jump to a host directory that
    // does not exist on the remote host (session 01a0ae58).
    PWD: "/home/alice/projects/demo-app",
    OLDPWD: "/home/alice",
    "bad-key": "x",
    EMPTY: undefined,
  });
  assert.deepEqual(env, { PATH: "/usr/bin", FOO: "keep-me" });
});

test("buildRemoteScript never exports host PWD or OLDPWD", () => {
  const script = buildRemoteScript({
    script: "cd -",
    cwd: "/workspace",
    env: {
      PATH: "/usr/bin",
      PWD: "/home/alice/projects/demo-app",
      OLDPWD: "/home/alice",
    },
  });
  assert.doesNotMatch(script, /export PWD=/);
  assert.doesNotMatch(script, /export OLDPWD=/);
  assert.doesNotMatch(script, /alice/);
  assert.match(script, /export PATH='\/usr\/bin'/);
});

test("buildRemoteScript cds, exports env, and execs a quoted argv", () => {
  const script = buildRemoteScript({
    argv: ["/bin/bash", "-lc", "echo it's fine"],
    cwd: "/workspace/src",
    env: { FOO: "a b", HOME: "/should-not-leak", "bad-key": "x" },
  });
  assert.match(script, /^set -eu\n/);
  assert.match(script, /cd -- '\/workspace\/src'/);
  assert.match(script, /export FOO='a b'/);
  assert.doesNotMatch(script, /HOME=/);
  assert.doesNotMatch(script, /bad-key/);
  assert.match(script, /exec '\/bin\/bash' '-lc' 'echo it'\\''s fine'/);
});

test("buildRemoteScript inlines bash wrap and skips cd when the dir is missing", () => {
  const script = buildRemoteScript({
    script: "pwd",
    cwd: "/workspace",
    env: { FOO: "a b", HOME: "/should-not-leak" },
  });
  assert.doesNotMatch(script, /^set -eu/);
  assert.match(
    script,
    /if \[ -d '\/workspace' \]; then cd -- '\/workspace'; fi/,
  );
  assert.match(script, /export FOO='a b'/);
  assert.doesNotMatch(script, /HOME=/);
  assert.doesNotMatch(script, /exec '\/bin\/bash'/);
  assert.ok(script.endsWith("\npwd") || script.endsWith("pwd"));
});

test("inline bash script does not abort when mapped cwd is missing", () => {
  const script = buildRemoteScript({
    script: "printf 'alive\\n'",
    cwd: "/no-such-ssh-cwd-dir-xyz",
  });
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LEAK_MARKER: "test-leak-secret-value",
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "alive\n");
  assert.doesNotMatch(r.stdout, /LEAK_MARKER|can't cd|No such file|OPTIND=/);
});

test("resolveSshTarget stores localWorkspace as an absolute path", () => {
  const t = resolveSshTarget(
    {
      enabled: true,
      host: "box",
      user: "aide",
      identityFile: "/keys/id",
      localWorkspace: "./workspace",
    },
    {},
    {
      defaultLocalWorkspace: "/repo/workspace",
      identityExists: () => true,
    },
  );
  assert.equal(t.enabled, true);
  if (!t.enabled) return;
  assert.equal(t.localWorkspace, path.resolve("./workspace"));
  assert.ok(path.isAbsolute(t.localWorkspace));
  assert.equal(t.remoteWorkspace, "/home/aide/workspace");
});

test("buildRemoteScript rejects cwd with ..", () => {
  assert.throws(
    () =>
      buildRemoteScript({
        argv: ["/bin/true"],
        cwd: "/workspace/../etc",
      }),
    /unsafe remote cwd/,
  );
});

test("classifySshFailure treats 255 and auth errors as transport", () => {
  assert.equal(classifySshFailure(255, ""), "transport");
  // Client-issued refusals are prefixed `ssh: ` by the ssh binary.
  assert.equal(
    classifySshFailure(255, "ssh: Permission denied (publickey)."),
    "transport",
  );
  assert.equal(classifySshFailure(1, "cat: missing\n"), "remote");
  assert.equal(classifySshFailure(0, ""), "remote");
});

test("default key scan order is ed25519, ed25519_sk, ecdsa, rsa", () => {
  assert.deepEqual([...DEFAULT_IDENTITY_CANDIDATES], [
    "~/.ssh/id_ed25519",
    "~/.ssh/id_ed25519_sk",
    "~/.ssh/id_ecdsa",
    "~/.ssh/id_rsa",
  ]);
  const tried: string[] = [];
  resolveIdentityFile(undefined, {
    homeDir: "/home/me",
    identityExists: (f) => {
      tried.push(f);
      return f.endsWith("id_ecdsa");
    },
  });
  assert.deepEqual(tried, [
    "/home/me/.ssh/id_ed25519",
    "/home/me/.ssh/id_ed25519_sk",
    "/home/me/.ssh/id_ecdsa",
  ]);
});

test("empty identityFile in json still scans default keys", () => {
  const t = resolveSshTarget(
    { enabled: true, host: "box", user: "aide", identityFile: "" },
    {},
    {
      defaultLocalWorkspace: "/ws",
      homeDir: "/home/me",
      identityExists: (f) => f === "/home/me/.ssh/id_ed25519_sk",
    },
  );
  assert.equal(t.enabled, true);
  if (!t.enabled) return;
  assert.equal(t.identityFile, "/home/me/.ssh/id_ed25519_sk");
});

test("strictHostKeyChecking=ask is rejected", () => {
  assert.throws(
    () =>
      resolveSshTarget(
        {
          enabled: true,
          host: "box",
          user: "aide",
          identityFile: "/k",
          strictHostKeyChecking: "ask",
        },
        {},
        { defaultLocalWorkspace: "/ws", identityExists: () => true },
      ),
    /not ask/,
  );
});

test("ControlMaster argv uses a unique socket per host user port pid", () => {
  const a = controlSocketPath({
    host: "gpu-box",
    user: "ubuntu",
    port: 22,
    pid: 9,
    cacheDir: "/tmp/pi-kit-ssh",
  });
  const b = controlSocketPath({
    host: "other",
    user: "ubuntu",
    port: 22,
    pid: 9,
    cacheDir: "/tmp/pi-kit-ssh",
  });
  const c = controlSocketPath({
    host: "gpu-box",
    user: "ubuntu",
    port: 22,
    pid: 10,
    cacheDir: "/tmp/pi-kit-ssh",
  });
  assert.match(a, /^\/tmp\/pi-kit-ssh\/cm-[0-9a-f]{16}-9$/);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  const mux = muxExecArgs(a);
  assert.ok(mux.includes("ControlMaster=auto"));
  // Bounded persist: an orphaned master (pi killed before its exit hook)
  // self-terminates after 10 idle minutes instead of leaking forever.
  assert.ok(mux.includes("ControlPersist=600"));
  assert.ok(mux.includes(`ControlPath=${a}`));
  const argv = buildSshArgv(
    sampleTarget({ host: "gpu-box", controlPath: a }),
    "true",
  );
  assert.ok(argv.includes("ControlMaster=auto"));
  assert.ok(argv.includes(`ControlPath=${a}`));
  const check = buildMuxCtlArgv(
    sampleTarget({ host: "gpu-box", controlPath: a }),
    "check",
  );
  assert.ok(check.includes("-O"));
  assert.ok(check.includes("check"));
  assert.ok(!check.includes("ControlMaster=auto"));
});

test("formatTransportError names auth fail without printing key material", () => {
  const msg = formatTransportError(
    sampleTarget(),
    255,
    "ssh: Permission denied (publickey).",
  );
  assert.match(msg, /publickey auth refused/);
  assert.match(msg, /identity \/home\/me\/.ssh\/id_ed25519/);
  assert.match(msg, /PerSourcePenalties/);
  assert.doesNotMatch(msg, /BEGIN OPENSSH/);
});

test("remote stderr containing 'Permission denied' is NOT an auth refusal", () => {
  // Real case: docker bind-mount write failure surfaced through ssh with
  // exit 1 — a remote failure, not a transport one.
  assert.equal(
    classifySshFailure(
      1,
      "Warning: your password will expire in 999993 days.\n" +
        "sh: can't create /m/b.txt: Permission denied",
    ),
    "remote",
  );
  // Client-issued refusal keeps the transport classification.
  assert.equal(
    classifySshFailure(255, "ssh: Permission denied (publickey)."),
    "transport",
  );
  // Exit 255 alone is transport regardless of stderr shape.
  assert.equal(
    classifySshFailure(255, "weird output"),
    "transport",
  );
  // The generic transport message still renders (with the remote detail).
  assert.match(
    formatTransportError(
      sampleTarget(),
      1,
      "sh: can't create /m/b.txt: Permission denied",
    ),
    /transport to .* failed/,
  );
});

test("formatSpawnError names a missing ssh binary", () => {
  assert.equal(
    formatSpawnError(Object.assign(new Error("spawn ssh"), { code: "ENOENT" })),
    "ssh: ssh binary not found on PATH",
  );
});

test("ssh extension dir is three levels below repo, not two (session 01a0abb0 bug)", () => {
  const extDir = "/repo/.pi/extensions/ssh";
  const twoUp = path.resolve(extDir, "..", "..");
  const twoUpJson = path.join(twoUp, ".pi", "ssh.json");
  assert.equal(twoUp, "/repo/.pi");
  assert.equal(twoUpJson, "/repo/.pi/.pi/ssh.json");
  assert.equal(repoRootFromSshExtensionDir(extDir), "/repo");
  assert.equal(sshJsonPath("/repo"), "/repo/.pi/ssh.json");
  assert.notEqual(twoUpJson, sshJsonPath(repoRootFromSshExtensionDir(extDir)));
  assert.equal(resolveSshConfigFile("/repo", {}), "/repo/.pi/ssh.json");
  assert.equal(
    resolveSshConfigFile("/repo", {
      PI_AIDE_SSH_CONFIG: "/repo/.pi/agents/sysadmin-internal-infra/ssh.json",
    }),
    "/repo/.pi/agents/sysadmin-internal-infra/ssh.json",
  );
  assert.equal(
    resolveSshConfigFile("/repo", {
      PI_AIDE_SSH_CONFIG: ".pi/agents/sysadmin-internal-infra/ssh.json",
    }),
    "/repo/.pi/agents/sysadmin-internal-infra/ssh.json",
  );
});

test("PI_AIDE_SSH=1 with missing json is intended SSH, not idle local tools", () => {
  const env = { PI_AIDE_SSH: "1" };
  assert.equal(sshWasRequested(env), true);
  assert.equal(sshIntended(env, {}), true);
  assert.equal(allowLocalToolFallback(env, {}), false);
  assert.throws(
    () =>
      resolveSshTarget({}, env, { defaultLocalWorkspace: "/repo/workspace" }),
    /host is empty|No auto-discovery/,
  );
  // Host alone (as when the launcher exports PI_AIDE_SSH_HOST but Kata
  // loaded an empty .pi/ssh.json instead of the persona file) still fails
  // ~/workspace expansion until user comes from the resolved SSH config.
  assert.throws(
    () =>
      resolveSshTarget(
        {},
        { PI_AIDE_SSH: "1", PI_AIDE_SSH_HOST: "100.123.159.28" },
        {
          defaultLocalWorkspace: "/repo/workspace",
          identityExists: () => true,
        },
      ),
    /needs user to expand ~/,
  );
  const fromPersona = resolveSshTarget(
    {
      user: "aide-80613",
      identityFile: "/keys/id",
      remoteWorkspace: "~/workspace",
    },
    { PI_AIDE_SSH: "1", PI_AIDE_SSH_HOST: "100.123.159.28" },
    {
      defaultLocalWorkspace: "/repo/workspace",
      identityExists: (file) => file === "/keys/id",
    },
  );
  assert.equal(fromPersona.enabled, true);
  if (!fromPersona.enabled) return;
  assert.equal(fromPersona.remoteWorkspace, "/home/aide-80613/workspace");
  assert.equal(fromPersona.user, "aide-80613");
});

test("plain pi without PI_AIDE_SSH stays idle and may use local tools", () => {
  assert.equal(sshWasRequested({}), false);
  assert.equal(sshIntended({}, { host: "box" }), false);
  assert.equal(allowLocalToolFallback({}, {}), true);
  assert.equal(allowLocalToolFallback({}, { enabled: true, host: "box" }), false);
});

test("sshRuntimeMarker is a hard line the model can quote", () => {
  const marker = sshRuntimeMarker(sampleTarget());
  assert.match(marker, /^\[ssh-runtime\] /);
  assert.match(marker, /ubuntu@box/);
  assert.match(marker, /\/workspace/);
  assert.match(marker, /Scripts from loaded skills are at ~\/\.pi\/skills\/<path>\/ on that host/);
  assert.match(marker, /skill_edit \/ skill_file_edit/);
  assert.match(marker, /write and edit refuse ~\/\.pi\/skills/);
  assert.doesNotMatch(marker, /Gondolin VM$/);
});

test("isRemoteSkillCatalogPath detects ~/.pi/skills and absolute home forms", () => {
  assert.equal(isRemoteSkillCatalogPath("~/.pi/skills"), true);
  assert.equal(isRemoteSkillCatalogPath("~/.pi/skills/clone-repo/SKILL.md"), true);
  assert.equal(isRemoteSkillCatalogPath("/home/ubuntu/.pi/skills/a/b"), true);
  assert.equal(isRemoteSkillCatalogPath("/home/ubuntu/.pi/skills"), true);
  assert.equal(isRemoteSkillCatalogPath("/workspace/src/a.ts"), false);
  assert.equal(isRemoteSkillCatalogPath("/home/ubuntu/.pi/skills-backup"), false);
  assert.equal(isRemoteSkillCatalogPath("/home/ubuntu/.agents/skills/x"), false);
  const err = remoteSkillCatalogRejectError("~/.pi/skills/x");
  assert.match(err.message, /refusing to modify/);
  assert.match(err.message, /skill_edit/);
});

test("sshFailMarker and sshRefuseLocalError name the refuse, not a local fallback", () => {
  const marker = sshFailMarker("ssh: enabled, but host is empty");
  assert.match(marker, /^\[ssh-runtime\] FAIL:/);
  assert.match(marker, /will not run on this machine/);
  const err = sshRefuseLocalError("ssh: enabled, but host is empty");
  assert.match(err.message, /refusing local tool execution/);
  assert.match(err.message, /No host-direct fallback/);
});

test("shouldRegisterSsh requires PI_AIDE_SSH=1 and yields to a project copy", () => {
  const project = "/proj/.pi/extensions/ssh/index.ts";
  const exists = (file: string) => file === project;
  assert.equal(shouldRegisterSsh("/global/index.ts", "/proj", {}, exists), false);
  assert.equal(
    shouldRegisterSsh("/global/index.ts", "/proj", { PI_AIDE_SSH: "0" }, exists),
    false,
  );
  assert.equal(
    shouldRegisterSsh("/global/index.ts", "/proj", { PI_AIDE_SSH: "1" }, exists),
    false,
  );
  assert.equal(shouldRegisterSsh(project, "/proj", { PI_AIDE_SSH: "1" }, exists), true);
  assert.equal(
    shouldRegisterSsh("/global/index.ts", "/other", { PI_AIDE_SSH: "1" }, () => false),
    true,
  );
  assert.equal(
    shouldRegisterSsh("/global/index.ts", "/other", {}, () => false),
    false,
  );
});

test("index.ts wraps fail-closed and does not fall back to host-direct tools", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "index.ts"), "utf8");
  assert.match(src, /shouldRegisterSsh/);
  assert.match(src, /existsSync\(configPath\)/);
  assert.doesNotMatch(src, /repoRootFromSshExtensionDir/);
  assert.match(src, /installRefuseLocalTools/);
  assert.match(src, /wrapBashWithSessionCwd/);
  assert.match(src, /pullRemoteSidecars/);
  assert.match(src, /script: wrapped/);
  // read/write/edit resolve the raw path argument against the last bash cwd
  // and name the absolute remote path on failure. write/edit also refuse
  // the remote ~/.pi/skills tree.
  assert.match(src, /resolveToolPath\(/);
  assert.match(src, /runWithPathContext\(/);
  assert.match(src, /runMutatingPathContext\(/);
  assert.match(src, /isRemoteSkillCatalogPath/);
  assert.match(src, /withAbsolutePath\(/);
  assert.match(src, /readPersistedCwd\(target\.localWorkspace, sessionId\)/);
  // ls/find/grep join the same remoting path (ops over sshExecBuffered).
  assert.match(src, /createSshLsOps/);
  assert.match(src, /createSshFindOps/);
  assert.match(src, /executeSshGrep/);
  assert.match(src, /createLsTool/);
  assert.match(src, /createFindTool/);
  assert.match(src, /createGrepTool/);
  assert.doesNotMatch(src, /argv: \["\/bin\/bash", "-lc", wrapped\]/);
  assert.doesNotMatch(src, /\[cwd:/);
  assert.doesNotMatch(src, /from ["']@earendil-works\/gondolin["']/);
  assert.doesNotMatch(src, /from ["']\.\/gondolin/);
  assert.doesNotMatch(src, /host-direct from the next tool call/);
  assert.doesNotMatch(src, /falling back to host-direct tools/);
  assert.doesNotMatch(src, /SSH: OFF \(host-direct\)/);
  assert.doesNotMatch(src, /path\.resolve\(here, "\.\.", "\.\."\)/);
});

test("path mapping does not copy files and sources have no copy helpers", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of [
    "lib.ts",
    "exec.ts",
    "mux.ts",
    "index.ts",
    "shell-state.ts",
    "ops.ts",
  ]) {
    const src = fs.readFileSync(path.join(here, name), "utf8");
    assert.doesNotMatch(src, /\brsync\b/);
    assert.doesNotMatch(src, /\bscp\b/);
    assert.doesNotMatch(src, /\bsftp\b/);
  }
});

