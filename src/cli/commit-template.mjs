import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runGit } from "../host/git.mjs";

// Files a repository declares its commit convention in, the most explicit first.
const CONVENTION_FILES = [
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.js",
  ".commitlintrc.yml",
  ".commitlintrc.yaml",
  ".husky",
  ".gitmessage",
  "CONTRIBUTING.md",
  "CONTRIBUTING",
];

// A Conventional Commits subject: `<type>(<scope>)!: <subject>`, the scope and the `!` optional.
export const CONVENTIONAL_SUBJECT_RE = /^[a-z]+(\([^)]*\))?!?: \S/;

// The template in effect when neither git's configuration nor the repository declares one (`references/commit-template.md`).
const NIGHTQUEUE_TEMPLATE = { source: "nightqueue", path: null, label: "nightqueue (fallback)" };

// A `Co-Authored-By:` trailer line, which a pipeline commit never carries.
const CO_AUTHORED_TRAILER = /^co-authored-by\s*:/i;

// A `Refs:` trailer line, reserved and never written by an agent.
const REFS_TRAILER = /^refs\s*:/i;

// The file of the repository that declares how a commit message is written, or null when no file does.
export function conventionFile(cwd) {
  const declared = CONVENTION_FILES.find((name) => existsSync(join(cwd, name)));
  if (declared) return declared;
  try {
    return "commitlint" in JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) ? "package.json (commitlint)" : null;
  } catch {
    return null;
  }
}

// The template git's own `commit.template` key names in the checkout, or null when it is unset or names no file.
function configuredTemplate(cwd, env) {
  const result = runGit({ args: ["config", "--get", "--path", "commit.template"], cwd, env });
  const value = result.ok ? result.stdout.trim() : "";
  if (!value) return null;
  const path = resolve(cwd, value);
  return existsSync(path) ? { source: "config", path, label: `git config commit.template (${path})` } : null;
}

// The template the repository's own convention declares, or null when it declares none.
function repositoryTemplate(cwd) {
  const declared = conventionFile(cwd);
  if (!declared) return null;
  return { source: "repo", path: declared === ".gitmessage" ? join(cwd, declared) : null, label: declared };
}

// The commit template in effect for the checkout: git's `commit.template`, then the repository's convention, then nightqueue's fallback.
export function findCommitTemplate(cwd, env) {
  return configuredTemplate(cwd, env) ?? repositoryTemplate(cwd) ?? NIGHTQUEUE_TEMPLATE;
}

// The problems of the subject line, the Conventional Commits shape required only under nightqueue's fallback.
function subjectProblems(subject, template) {
  if (subject === "") return ["line 1, the subject, is empty"];
  if (subject.startsWith("#")) return ["the subject starts with `#`, which git reads as a comment"];
  if (template.source !== "nightqueue" || CONVENTIONAL_SUBJECT_RE.test(subject)) return [];
  return [`the subject \`${subject}\` is not \`<type>(<scope>): <subject>\`, which nightqueue's template requires`];
}

// The problem of one line of the message when it is a trailer a pipeline commit never writes, or null.
function trailerProblem(line, index) {
  const text = line.trim();
  if (CO_AUTHORED_TRAILER.test(text)) return `line ${index + 1} is a \`Co-Authored-By:\` trailer, which a pipeline commit never carries`;
  if (REFS_TRAILER.test(text)) return `line ${index + 1} is a \`Refs:\` trailer, which is reserved and never written by an agent`;
  return null;
}

// Every violation of the commit message against the template in effect, each as one reason; an empty list means it may be committed.
export function commitMessageProblems(message, template) {
  const lines = String(message ?? "").replace(/\r\n?/g, "\n").split("\n");
  const problems = subjectProblems(lines[0].trim(), template);
  const hasBody = lines.slice(1).some((line) => line.trim() !== "");
  if (hasBody && lines[1].trim() !== "") problems.push("line 2 is not blank: one blank line separates the subject from the body");
  return [...problems, ...lines.map(trailerProblem).filter(Boolean)];
}
