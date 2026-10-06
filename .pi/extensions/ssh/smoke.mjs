#!/usr/bin/env node
/**
 * Opt-in live SSH smoke. Does not run unless PI_AIDE_SSH_SMOKE=1.
 * Requires an explicit host. Does not discover hosts.
 *
 *   export PATH="$HOME/.local/share/fnm/node-versions/v26.8.1/installation/bin:$PATH"
 *   PI_AIDE_SSH_SMOKE=1 PI_AIDE_SSH=1 PI_AIDE_SSH_HOST=your-host \
 *     PI_AIDE_SSH_USER=ubuntu \
 *     node --experimental-strip-types ~/tools/pi-setup/.pi/extensions/ssh/smoke.mjs
 */
import os from "node:os";
import path from "node:path";

import { sshExecBuffered } from "./exec.ts";
import {
  loadSshJson,
  resolveSshConfigFile,
  resolveSshTarget,
} from "./lib.ts";

if (process.env.PI_AIDE_SSH_SMOKE !== "1") {
  console.error(
    "ssh smoke is opt-in. Set PI_AIDE_SSH_SMOKE=1 and an explicit host.",
  );
  process.exit(2);
}

const projectRoot = process.cwd();
const env = { ...process.env, PI_AIDE_SSH: process.env.PI_AIDE_SSH ?? "1" };
const target = resolveSshTarget(loadSshJson(resolveSshConfigFile(projectRoot, env)), env, {
  defaultLocalWorkspace: path.join(projectRoot, "workspace"),
  homeDir: os.homedir(),
});
if (!target.enabled) {
  console.error("ssh smoke: target is not enabled. Set PI_AIDE_SSH=1 and host.");
  process.exit(2);
}

const r = await sshExecBuffered(target, {
  argv: ["/bin/sh", "-lc", "uname -n; pwd; echo smoke_ok"],
  cwd: target.remoteWorkspace,
});
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
if (!r.ok) {
  console.error(`ssh smoke: remote exit ${r.exitCode}`);
  process.exit(r.exitCode || 1);
}
