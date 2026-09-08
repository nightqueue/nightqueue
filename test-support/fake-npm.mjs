#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const args = process.argv.slice(2);

// Records the call in the argv log the test reads back.
function logCall() {
  const path = process.env.NIGHTSHIFT_FAKE_NPM_LOG;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(args)}\n`);
}

// Ends the process the way the real CLI ends on a bad call.
function fail(message, code = 1) {
  process.stderr.write(`fake npm: ${message}\n`);
  process.exit(code);
}

// Checkout this fake copies the package metadata from; without it the fake refuses to run.
function sourceRoot() {
  const dir = process.env.NIGHTSHIFT_FAKE_NPM_SOURCE;
  if (!dir) fail("NIGHTSHIFT_FAKE_NPM_SOURCE is not set; refusing to install anything", 2);
  return dir;
}

// Reads one JSON file, treating anything unreadable as empty.
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// Writes one JSON file, creating the directories it needs.
function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

// Value of one option of the call, or null when the option is absent.
function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

// The arguments of the call that are neither a flag nor the value of one, in the order they appear.
function operands(list, valued) {
  const kept = [];
  for (let index = 0; index < list.length; index += 1) {
    if (valued.includes(list[index])) {
      index += 1;
      continue;
    }
    if (list[index].startsWith("-")) continue;
    kept.push(list[index]);
  }
  return kept;
}

// The single package specifier of the call: the first argument that is not a flag nor the value of one.
function specifier(list) {
  return operands(list, ["--prefix", "--loglevel"])[0] ?? null;
}

// Version the specifier asks for: the one recorded in the tarball, the tag when it carries one, the version of the source otherwise.
function versionOf(spec) {
  if (spec.endsWith(".tgz")) return readJson(spec).version ?? "0.0.0";
  const at = spec.lastIndexOf("@");
  const tag = at > 0 ? spec.slice(at + 1) : "";
  if (tag && tag !== "latest") return tag;
  const dir = isAbsolute(spec) ? spec : sourceRoot();
  return readJson(join(dir, "package.json")).version ?? "0.0.0";
}

// Materializes the embedding library as a fixture that exports the two symbols the runtime reads.
function installEmbedding(prefix, version) {
  const dir = join(prefix, "node_modules", "@huggingface", "transformers");
  writeJson(join(dir, "package.json"), { name: "@huggingface/transformers", version, main: "index.mjs" });
  writeFileSync(
    join(dir, "index.mjs"),
    ["export const env = {};", "export async function pipeline() {", "  return async () => ({ data: [] });", "}", ""].join("\n"),
  );
}

// Materializes the package inside the prefix, with a bin that runs the CLI of the source checkout.
function installNightshift(prefix, version) {
  const source = sourceRoot();
  const dir = join(prefix, "node_modules", "nightshift");
  writeJson(join(dir, "package.json"), {
    name: "nightshift",
    version,
    bin: { nightshift: "./bin/nightshift.mjs" },
  });
  const entry = join(dir, "bin", "nightshift.mjs");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    [
      "#!/usr/bin/env node",
      `import { run } from ${JSON.stringify(join(source, "src", "cli", "index.mjs"))};`,
      "process.exitCode = await run(process.argv.slice(2));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeJson(join(dir, ".claude-plugin", "marketplace.json"), readJson(join(source, ".claude-plugin", "marketplace.json")));
}

// Emulates `npm install --prefix <dir> <spec>`, writing only inside the prefix.
function runInstall(rest) {
  const prefix = optionValue("--prefix");
  const spec = specifier(rest);
  if (!prefix || !spec) return fail(`unsupported install call \`${rest.join(" ")}\``);
  const version = versionOf(spec);
  if (spec.includes("@huggingface/transformers")) return installEmbedding(prefix, version);
  return installNightshift(prefix, version);
}

// Emulates `npm pack --json --pack-destination <dir> <target>`, writing the stand-in tarball the install call reads back.
function runPack(rest) {
  const destDir = optionValue("--pack-destination");
  const dir = operands(rest, ["--pack-destination"])[0] ?? null;
  if (!destDir || !dir) return fail(`unsupported pack call \`${rest.join(" ")}\``);
  const manifest = readJson(join(dir, "package.json"));
  const name = manifest.name ?? "package";
  const version = manifest.version ?? "0.0.0";
  const filename = `${name}-${version}.tgz`;
  writeJson(join(destDir, filename), { name, version, root: dir });
  process.stdout.write(`${JSON.stringify([{ id: `${name}@${version}`, name, version, filename }])}\n`);
}

// Emulates `npm audit --json`, which prints a valid report even when it exits 1.
function runAudit() {
  const total = Number.parseInt(process.env.NIGHTSHIFT_FAKE_NPM_AUDIT ?? "0", 10) || 0;
  const vulnerabilities = { info: 0, low: 0, moderate: total, high: 0, critical: 0, total };
  process.stdout.write(`${JSON.stringify({ metadata: { vulnerabilities } })}\n`);
  if (total > 0) process.exit(1);
}

// Applies the call, emulating only the subcommands the installation uses.
function main() {
  logCall();
  const exitCode = Number.parseInt(process.env.NIGHTSHIFT_FAKE_NPM_EXIT ?? "0", 10) || 0;
  if (exitCode) fail(`refusing to run (NIGHTSHIFT_FAKE_NPM_EXIT=${exitCode})`, exitCode);
  const [command, ...rest] = args;
  if (command === "--version" || command === "-v") return process.stdout.write("10.9.0\n");
  if (command === "install") return runInstall(rest);
  if (command === "pack") return runPack(rest);
  if (command === "audit") return runAudit();
  return fail(`unknown command \`${args.join(" ")}\``);
}

main();
