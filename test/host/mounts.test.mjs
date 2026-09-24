import assert from "node:assert/strict";
import { test } from "node:test";
import { RISKY_FS_TYPES, isRiskyFsType, longestMountMatch, mountOfPath, parseMountEntries } from "../../src/host/mounts.mjs";

const DARWIN_MOUNT = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "devfs on /dev (devfs, local, nobrowse)",
  "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
  "//guest@nas._smb._tcp.local/share on /Volumes/My Disk (smbfs, nodev, nosuid, mounted by ci)",
  "map auto_home on /Users/foobar (autofs, automounted, nobrowse)",
].join("\n");

const LINUX_PROC_MOUNTS = [
  "/dev/sda1 / ext4 rw,relatime 0 0",
  "proc /proc proc rw,nosuid 0 0",
  "nas:/export /home/ci nfs4 rw,relatime 0 0",
  "sshfs#ci@nas:/srv /mnt/My\\040Share fuse.sshfs rw,nosuid 0 0",
].join("\n");

const LINUX_MOUNTINFO = [
  "25 0 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
  "30 25 0:25 / /home/ci rw,relatime shared:8 - nfs4 nas:/export rw",
].join("\n");

// The `mount` runner the doctor injects, in the shape `runCommand` answers with.
function fakeMount(stdout, { ok = true, missing = false } = {}) {
  return () => ({ ok, stdout, missing });
}

test("the risky filesystem list is the one the README names, matched case-insensitively and by prefix", () => {
  assert.deepEqual(RISKY_FS_TYPES, ["nfs", "nfs3", "nfs4", "smbfs", "cifs", "afpfs", "webdav", "9p"]);
  for (const type of RISKY_FS_TYPES) assert.equal(isRiskyFsType(type.toUpperCase()), true, `${type} must be risky`);
  for (const type of ["fuse", "fuse.sshfs", "macfuse", "osxfuse", "NFS4"]) assert.equal(isRiskyFsType(type), true, `${type} must be risky`);
  for (const type of ["apfs", "ext4", "hfs", "overlay", "tmpfs", "", null]) assert.equal(isRiskyFsType(type), false, `${type} must not be risky`);
});

test("a macOS mount table parses, keeps a mount point with spaces and never matches a sibling directory", () => {
  const entries = parseMountEntries(DARWIN_MOUNT, "darwin");
  assert.deepEqual(entries[0], { point: "/", type: "apfs" });
  assert.deepEqual(entries[3], { point: "/Volumes/My Disk", type: "smbfs" });
  assert.deepEqual(longestMountMatch(entries, "/Volumes/My Disk/homes/ci"), { point: "/Volumes/My Disk", type: "smbfs" });
  assert.deepEqual(longestMountMatch(entries, "/Users/foo/.nightqueue"), { point: "/", type: "apfs" }, "`/Users/foo` was matched against the mount at `/Users/foobar`");
});

test("a Linux mount table parses in both formats the kernel publishes, with the octal escape of a space undone", () => {
  const mounts = parseMountEntries(LINUX_PROC_MOUNTS, "linux");
  assert.deepEqual(longestMountMatch(mounts, "/root/.nightqueue"), { point: "/", type: "ext4" });
  assert.deepEqual(longestMountMatch(mounts, "/home/ci/.nightqueue"), { point: "/home/ci", type: "nfs4" });
  assert.deepEqual(longestMountMatch(mounts, "/mnt/My Share/home"), { point: "/mnt/My Share", type: "fuse.sshfs" });
  const info = parseMountEntries(LINUX_MOUNTINFO, "linux");
  assert.deepEqual(longestMountMatch(info, "/home/ci/.nightqueue"), { point: "/home/ci", type: "nfs4" });
});

test("the mount of a path is read from the source of the platform, and is an unknown whenever no source answers", () => {
  const darwin = mountOfPath("/Volumes/My Disk/home", { platform: "darwin", runMount: fakeMount(DARWIN_MOUNT) });
  assert.deepEqual(darwin, { point: "/Volumes/My Disk", type: "smbfs", source: "mount" });

  const linux = mountOfPath("/home/ci/.nightqueue", { platform: "linux", readFileImpl: (path) => (path === "/proc/mounts" ? LINUX_PROC_MOUNTS : "") });
  assert.deepEqual(linux, { point: "/home/ci", type: "nfs4", source: "/proc/mounts" });

  const fallback = mountOfPath("/home/ci/.nightqueue", {
    platform: "linux",
    readFileImpl: (path) => {
      if (path === "/proc/mounts") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return LINUX_MOUNTINFO;
    },
  });
  assert.deepEqual(fallback, { point: "/home/ci", type: "nfs4", source: "/proc/self/mountinfo" });

  assert.match(mountOfPath("/home", { platform: "darwin", runMount: fakeMount("", { ok: false, missing: true }) }).unknown, /`mount` is not on this host/);
  assert.match(mountOfPath("/home", { platform: "darwin", runMount: fakeMount("", { ok: false }) }).unknown, /`mount` did not answer/);
  assert.match(mountOfPath("/home", { platform: "sunos" }).unknown, /no mount table is known for sunos/);
  assert.match(mountOfPath("/home", { platform: "darwin", runMount: fakeMount("devfs on /dev (devfs, local)") }).unknown, /no entry of `mount` covers \/home/);
});
