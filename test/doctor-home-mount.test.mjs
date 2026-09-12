import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { homeDir } from "../src/config/paths.mjs";
import { ensureHome } from "../src/config/store.mjs";
import { makeHostEnv } from "../test-support/host.mjs";

// Runs the diagnosis in process with an injected `mount`, the only host command the home-mount check ever asks for.
async function diagnose(env, mountImpl) {
  const out = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: () => {},
    spawnSyncImpl: (file, args, options) => (/mount$/.test(file) ? mountImpl(file, args, options) : { status: 1, error: { code: "ENOENT" } }),
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  await run(["doctor", "--json"], ctx);
  const checks = JSON.parse(out[0]).checks;
  const found = checks.find((entry) => entry.name === "home mount");
  assert.ok(found, `no \`home mount\` check in ${checks.map((entry) => entry.name).join(", ")}`);
  return found;
}

// A `mount` that answers with one line per entry, the way macOS prints it.
function fakeMount(lines) {
  return () => ({ status: 0, stdout: lines.join("\n"), stderr: "" });
}

// The injected `mount` only reaches the check on macOS; on Linux the mount table is the one the kernel publishes.
function skipUnlessDarwin(t) {
  if (process.platform === "darwin") return false;
  t.skip("the injected `mount` is the source of this check on macOS only");
  return true;
}

test("the home mount check prints one line for the real host, naming a filesystem or stating an unknown", async (t) => {
  const host = makeHostEnv(t, "doctor-home-mount-real");
  ensureHome(host.env);
  const line = await diagnose(host.env, () => ({ status: 1, error: { code: "ENOENT" } }));
  assert.notEqual(line.status, "fail", "a mount that cannot be named must never fail the diagnosis");
  assert.match(line.detail, /^(unknown: .+|\S+ at .+) \(only the mount in effect right now\)$/);
});

test("the home mount check names the filesystem and the mount point, and states that it only sees the mount in effect now", async (t) => {
  if (skipUnlessDarwin(t)) return;
  const host = makeHostEnv(t, "doctor-home-mount-ok");
  ensureHome(host.env);
  const line = await diagnose(host.env, fakeMount(["/dev/disk3s5 on / (apfs, local, journaled)"]));
  assert.equal(line.status, "ok");
  assert.match(line.detail, /^apfs at \/ \(only the mount in effect right now\)$/);
});

test("the home mount check warns on a network or fuse mount and says what has to change", async (t) => {
  if (skipUnlessDarwin(t)) return;
  const host = makeHostEnv(t, "doctor-home-mount-risky");
  ensureHome(host.env);
  const home = homeDir(host.env);
  for (const type of ["smbfs", "nfs", "fuse.sshfs", "macfuse"]) {
    const line = await diagnose(host.env, fakeMount([`/dev/disk3s5 on / (apfs, local)`, `nas:/export on ${home} (${type}, nodev)`]));
    assert.equal(line.status, "warn", `a home on ${type} was reported as ${line.status}`);
    assert.match(line.detail, new RegExp(`^${type.replace(".", "\\.")} at ${home} `));
    assert.match(line.hint, /NIGHTSHIFT_HOME must be on local disk/);
  }
});

test("the home mount check states an unknown, and never a pass, when no source of this host answers", async (t) => {
  if (skipUnlessDarwin(t)) return;
  const host = makeHostEnv(t, "doctor-home-mount-unknown");
  ensureHome(host.env);

  const missing = await diagnose(host.env, () => ({ status: 1, error: { code: "ENOENT" } }));
  assert.equal(missing.status, "ok");
  assert.match(missing.detail, /^unknown: `mount` is not on this host/);

  const timeout = await diagnose(host.env, () => ({ status: null, error: { code: "ETIMEDOUT" } }));
  assert.match(timeout.detail, /^unknown: `mount` did not answer/);

  const silent = await diagnose(host.env, fakeMount(["devfs on /dev (devfs, local)"]));
  assert.match(silent.detail, /^unknown: no entry of `mount` covers /);
});
